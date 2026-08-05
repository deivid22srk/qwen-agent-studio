/**
 * lib/tools.js — Definições e implementações das ferramentas que o agente
 * Qwen pode invocar.
 *
 * Cada ferramenta segue o padrão OpenAI/Anthropic-style:
 *   { name, description, parameters (JSON Schema), run(args, ctx) }
 *
 * O parser detecta chamadas no formato:
 *   <tool_call>{"name":"read_file","arguments":{"path":"src/index.js"}}</tool_call>
 * ...e devolve o resultado como nova mensagem de usuário.
 */

(function (global) {
  'use strict';

  const TOOLS = [
    {
      name: 'list_files',
      description: 'Lista o conteúdo de um diretório dentro da pasta de projetos. Use "." para a raiz.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Caminho relativo. Default: "."' }
        }
      },
      async run({ path = '.' }, ctx) {
        const entries = await QwenFS.listDir(ctx.root, path);
        return entries.map((e) =>
          (e.kind === 'directory' ? '📁 ' : '📄 ') + e.name
        ).join('\n') || '(diretório vazio)';
      }
    },

    {
      name: 'tree',
      description: 'Mostra a árvore de diretórios a partir de um caminho. Útil para entender a estrutura do projeto.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Caminho inicial. Default: "."' },
          depth: { type: 'number', description: 'Profundidade máxima. Default: 4' }
        }
      },
      async run({ path = '.', depth = 4 }, ctx) {
        const entries = await QwenFS.tree(ctx.root, path, depth);
        if (!entries.length) return '(vazio)';
        return entries.map((e) =>
          '  '.repeat(e.depth) + (e.kind === 'directory' ? '📁 ' : '📄 ') + e.name
        ).join('\n');
      }
    },

    {
      name: 'read_file',
      description: 'Lê o conteúdo de um arquivo de texto. Sempre prefira este para inspecionar código.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Caminho relativo do arquivo' }
        },
        required: ['path']
      },
      async run({ path }, ctx) {
        try {
          const content = await QwenFS.readFile(ctx.root, path);
          const lines = content.split('\n').length;
          if (content.length > 60000) {
            return `[Arquivo truncado: ${content.length} chars, ${lines} linhas]\n\n` +
                   content.slice(0, 60000) +
                   '\n\n...[TRUNCADO]...';
          }
          return content;
        } catch (e) {
          throw new Error('Não foi possível ler ' + path + ': ' + e.message);
        }
      }
    },

    {
      name: 'write_file',
      description: 'Cria ou sobrescreve um arquivo com o conteúdo fornecido. Cria diretórios pais automaticamente.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Caminho relativo do arquivo' },
          content: { type: 'string', description: 'Conteúdo completo a escrever' }
        },
        required: ['path', 'content']
      },
      async run({ path, content }, ctx) {
        const r = await QwenFS.writeFile(ctx.root, path, content);
        return `✅ Arquivo gravado: ${r.path} (${r.bytes} bytes)`;
      }
    },

    {
      name: 'edit_file',
      description: 'Edita um arquivo substituindo um trecho exato por outro. Falha se old_text não for único.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_text: { type: 'string', description: 'Trecho exato a ser substituído' },
          new_text: { type: 'string', description: 'Novo conteúdo' }
        },
        required: ['path', 'old_text', 'new_text']
      },
      async run({ path, old_text, new_text }, ctx) {
        const original = await QwenFS.readFile(ctx.root, path);
        const count = original.split(old_text).length - 1;
        if (count === 0) {
          throw new Error(`old_text não encontrado em ${path}`);
        }
        if (count > 1) {
          throw new Error(`old_text aparece ${count} vezes em ${path}. Torne o trecho mais específico.`);
        }
        const updated = original.replace(old_text, new_text);
        await QwenFS.writeFile(ctx.root, path, updated);
        return `✅ Editado: ${path}`;
      }
    },

    {
      name: 'append_file',
      description: 'Adiciona conteúdo ao final de um arquivo existente (cria se não existir).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content']
      },
      async run({ path, content }, ctx) {
        await QwenFS.appendFile(ctx.root, path, content);
        return `✅ Anexado a ${path} (${content.length} bytes)`;
      }
    },

    {
      name: 'delete_file',
      description: 'Apaga um arquivo.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      },
      async run({ path }, ctx) {
        await QwenFS.deleteFile(ctx.root, path);
        return `✅ Apagado: ${path}`;
      }
    },

    {
      name: 'create_directory',
      description: 'Cria um diretório (recursivo).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      },
      async run({ path }, ctx) {
        await QwenFS.createDir(ctx.root, path);
        return `✅ Diretório criado: ${path}`;
      }
    },

    {
      name: 'search_files',
      description: 'Busca arquivos por nome (glob: * e ?). Retorna lista de caminhos.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'ex: "*.js" ou "test_*.py"' },
          path: { type: 'string', description: 'Diretório base. Default: "."' }
        },
        required: ['pattern']
      },
      async run({ pattern, path = '.' }, ctx) {
        const results = await QwenFS.findByName(ctx.root, pattern, path);
        return results.length ? results.join('\n') : '(nenhum arquivo encontrado)';
      }
    },

    {
      name: 'grep',
      description: 'Busca por conteúdo em arquivos (grep recursivo).',
      parameters: {
        type: 'object',
        properties: {
          needle: { type: 'string' },
          path: { type: 'string', description: 'Default: "."' },
          ignore_case: { type: 'boolean', description: 'Default: true' }
        },
        required: ['needle']
      },
      async run({ needle, path = '.', ignore_case = true }, ctx) {
        const results = await QwenFS.grep(ctx.root, needle, path, { ignoreCase: ignore_case });
        if (!results.length) return '(nenhuma ocorrência)';
        return results.map((r) => `${r.path}:${r.line}: ${r.content.trim()}`).join('\n');
      }
    },

    {
      name: 'run_command',
      description: 'Executa um comando shell. ATENÇÃO: por segurança, este comando roda em sandbox limitado via Node helper se disponível, ou simula resultado. Não disponível em todas as plataformas.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Comando a executar' },
          cwd: { type: 'string', description: 'Diretório. Default: raiz do projeto' }
        },
        required: ['command']
      },
      async run({ command, cwd = '.' }, ctx) {
        // Em ambiente de extensão de navegador não podemos rodar shell diretamente.
        // Esta ferramenta é suportada apenas quando o "Qwen Studio Helper" nativo
        // estiver instalado (companheiro opcional). Caso contrário, retornamos
        // uma mensagem informativa para que o modelo peça uma alternativa.
        const helper = await QwenStore.getConfig('helper_endpoint', null);
        if (!helper) {
          return '⚠️ run_command requer o Qwen Studio Helper (companion app) opcional.\n' +
                 'Disponível em: https://github.com/deivid22srk/qwen-agent-studio#helper\n' +
                 'Sem o helper, use as outras ferramentas de arquivo para realizar a tarefa manualmente.';
        }
        try {
          const r = await fetch(helper + '/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command, cwd })
          });
          const out = await r.json();
          return `[exit ${out.exitCode}]\nSTDOUT:\n${out.stdout || ''}\nSTDERR:\n${out.stderr || ''}`;
        } catch (e) {
          throw new Error('Helper não respondeu: ' + e.message);
        }
      }
    },

    {
      name: 'list_running_tools',
      description: 'Lista as ferramentas disponíveis no ambiente. Útil quando o modelo precisa recordar.',
      parameters: { type: 'object', properties: {} },
      async run(_args, _ctx) {
        return TOOLS.map((t) => `- ${t.name}: ${t.description}`).join('\n');
      }
    },

    {
      name: 'finish',
      description: 'Sinaliza que a tarefa foi concluída. Não precisa de argumentos.',
      parameters: { type: 'object', properties: {} },
      async run() {
        return '__FINISH__';
      }
    }
  ];

  /**
   * Catálogo para enviar ao LLM (apenas name + description + schema).
   */
  function catalog() {
    return TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }));
  }

  /**
   * Executa uma chamada de ferramenta.
   * @param {string} name
   * @param {object} args
   * @param {{root: FileSystemDirectoryHandle, session: string}} ctx
   */
  async function execute(name, args, ctx) {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) throw new Error('Ferramenta desconhecida: ' + name);
    const started = Date.now();
    let status = 'ok';
    let result;
    try {
      result = await tool.run(args || {}, ctx);
      if (result === '__FINISH__') status = 'finish';
    } catch (e) {
      status = 'error';
      result = '❌ ' + e.message;
    }
    const entry = {
      tool: name,
      args,
      result: typeof result === 'string' ? result : JSON.stringify(result),
      status,
      ms: Date.now() - started,
      session: ctx.session
    };
    await QwenStore.appendLog(entry);
    return { ...entry, result };
  }

  global.QwenTools = { TOOLS, catalog, execute };
})(window);
