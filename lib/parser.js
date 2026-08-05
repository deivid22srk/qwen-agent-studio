/**
 * lib/parser.js — Detecta e extrai chamadas de ferramenta das respostas do
 * Qwen, em qualquer um destes formatos que o modelo é instruído a usar:
 *
 *   <tool_call>{"name":"read_file","arguments":{"path":"src/index.js"}}</tool_call>
 *   <tool_call>{"name":"read_file","args":{"path":"src/index.js"}}</tool_call>
 *   ```tool_call
 *   {"name":"read_file","arguments":{"path":"src/index.js"}}
 *   ```
 *
 * Também aceita formato XML estilo Anthropic:
 *   <function-call>{"name":"read_file", ...}</function-call>
 *
 * E formato OpenAI JSON:
 *   {"tool_calls":[{"id":"...","function":{"name":"...","arguments":"..."}}]}
 */

(function (global) {
  'use strict';

  const PATTERNS = [
    // <tool_call>{...}</tool_call>
    /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g,
    // <function-call>{...}</function-call>
    /<function-call>\s*([\s\S]*?)\s*<\/function-call>/g,
    // ```tool_call\n{...}\n```
    /```tool_call\s*\n([\s\S]*?)\n```/g,
    // ```json\n{"tool_calls":[...]}\n```
    /```json\s*\n(\{[\s\S]*?"tool_calls"[\s\S]*?\})\n```/g
  ];

  /**
   * Extrai todas as tool calls de um texto.
   * @param {string} text
   * @returns {Array<{raw: string, name: string, args: object, start: number, end: number}>}
   */
  function extractToolCalls(text) {
    const calls = [];
    for (const pattern of PATTERNS) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(text)) !== null) {
        const raw = m[0];
        const inner = m[1].trim();
        try {
          const parsed = JSON.parse(inner);
          // normaliza args/arguments
          const args = parsed.arguments || parsed.args || parsed.parameters || {};
          // pode ser {tool_calls: [...]} ou {name: ...}
          if (Array.isArray(parsed.tool_calls)) {
            for (const tc of parsed.tool_calls) {
              const fn = tc.function || tc;
              const fnArgs = typeof fn.arguments === 'string' ? safeJsonParse(fn.arguments) : (fn.arguments || fn.args || {});
              calls.push({
                raw,
                name: fn.name,
                args: fnArgs || {},
                start: m.index,
                end: m.index + raw.length
              });
            }
          } else if (parsed.name) {
            calls.push({
              raw,
              name: parsed.name,
              args,
              start: m.index,
              end: m.index + raw.length
            });
          }
        } catch (e) {
          // JSON inválido: ignora silenciosamente, modelo pode corrigir
          console.warn('[QwenAgent] tool_call JSON inválido:', inner, e.message);
        }
      }
    }
    // ordena por posição
    calls.sort((a, b) => a.start - b.start);
    return calls;
  }

  function safeJsonParse(s) {
    try { return JSON.parse(s); } catch (_) { return null; }
  }

  /**
   * Remove as tool calls do texto (para não poluir o que o usuário vê).
   */
  function stripToolCalls(text) {
    let out = text;
    for (const pattern of PATTERNS) {
      out = out.replace(pattern, '');
    }
    return out.replace(/\n{3,}/g, '\n\n').trim();
  }

  /**
   * Constrói o prompt-sistema que ensina o modelo a usar tool calls.
   * Versão concisa (~800 chars) para não estourar o contexto do modelo.
   * @param {object} ctx { projectRoot, hasFolder }
   */
  function buildSystemPrompt(ctx) {
    const catalog = QwenTools.catalog();
    // Lista compacta: apenas nome — descrição (uma linha por ferramenta)
    const toolsList = catalog.map((t) => `- ${t.name}: ${t.description.split('.')[0]}`).join('\n');

    const folderLine = ctx.hasFolder
      ? `Pasta do projeto: "${ctx.projectRoot}". Caminhos são relativos a ela.`
      : 'Nenhuma pasta selecionada ainda. Peça ao usuário para selecionar uma no painel do Qwen Agent.';

    return `Você é um agente de programação com acesso a TOOL CALL (chamadas de ferramenta). ${folderLine}

Ferramentas: ${toolsList}

Para invocar, emita exatamente:
<tool_call>{"name":"nome","arguments":{...}}</tool_call>

Regras:
- Uma chamada por turno, depois pare e aguarde o resultado.
- Nunca finja ter lido/escrito arquivos sem invocar a ferramenta.
- Use caminhos relativos (ex: "src/index.js").
- Para terminar, emita: <tool_call>{"name":"finish","arguments":{}}</tool_call>`;
  }

  /**
   * Formata o resultado de uma tool call para injetar como nova mensagem.
   */
  function formatToolResult(call, result) {
    const MAX = 4000;
    let r = typeof result === 'string' ? result : JSON.stringify(result);
    if (r.length > MAX) r = r.slice(0, MAX) + '\n\n...[truncado, ' + (r.length - MAX) + ' chars omitidos]';
    return `[Resultado da ferramenta "${call.name}"]\n${r}\n\n[Continue. Se a tarefa estiver completa, emita a chamada de finish.]`;
  }

  global.QwenParser = {
    extractToolCalls,
    stripToolCalls,
    buildSystemPrompt,
    formatToolResult
  };
})(window);
