/**
 * main_world.js — Injetado no MAIN WORLD (mundo da página) da SPA do Qwen.
 *
 * Em Manifest V3, content scripts rodam em um "isolated world" e não podem
 * hookar o `window.fetch` da página. Para interceptar as chamadas que o Qwen
 * SPA faz, precisamos injetar este script diretamente no mundo da página.
 *
 * Fazemos isso via <script src="..."> apontando para o arquivo exposto em
 * web_accessible_resources. O content.js (isolated) dispara essa injeção.
 *
 * Comunicação: window.postMessage entre este (MAIN) e o content.js (ISOLATED).
 */

(function () {
  'use strict';

  const TAG = '[QwenAgent:main]';
  const PENDING = new Map(); // id → {resolve, reject}

  // Espera resposta do content script (isolated world)
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.source !== 'qwen-agent-isolated') return;
    const { id, type, payload } = e.data;
    if (type === 'agent-state-response' && PENDING.has(id)) {
      PENDING.get(id).resolve(payload);
      PENDING.delete(id);
    }
  });

  function askIsolated(type, payload, timeoutMs = 1500) {
    return new Promise((resolve) => {
      const id = 'r' + Math.random().toString(36).slice(2, 10);
      PENDING.set(id, { resolve });
      window.postMessage({
        source: 'qwen-agent-main',
        id, type, payload
      }, '*');
      setTimeout(() => {
        if (PENDING.has(id)) {
          PENDING.delete(id);
          resolve(null); // timeout
        }
      }, timeoutMs);
    });
  }

  // ---------- Hook no fetch ----------
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    let url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
    const init = args[1] || (args[0] && typeof args[0] === 'object' ? args[0] : {});

    // Detecta POST para endpoints de chat/completion do Qwen
    const isChatEndpoint = url && (
      /\/api\/chat(s)?\/[^/]+\/completions?/.test(url) ||
      /\/api\/chat\/completions?/.test(url) ||
      /\/api\/completions?/.test(url) ||
      /\/api\/chat/i.test(url)
    );

    if (isChatEndpoint && init.method && init.method.toUpperCase() === 'POST' && init.body) {
      try {
        // Pergunta ao isolated world: agente ativo? qual o system prompt?
        const state = await askIsolated('get-agent-state');
        if (state && state.agentOn && state.systemPrompt) {
          let body;
          try {
            body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
          } catch (_) { body = null; }

          if (body && Array.isArray(body.messages)) {
            // evita duplicar o system prompt
            const hasAgentSys = body.messages.some((m) =>
              m.role === 'system' && typeof m.content === 'string' && m.content.includes('TOOL CALL')
            );
            if (!hasAgentSys) {
              body.messages.unshift({ role: 'system', content: state.systemPrompt });
              const newBody = JSON.stringify(body);
              args[1] = { ...init, body: newBody };
              console.log(TAG, 'system prompt injetado em', url);
            }
          }
        }
      } catch (e) {
        console.warn(TAG, 'falha ao injetar system prompt:', e);
      }
    }

    return origFetch.apply(this, args);
  };

  console.log(TAG, 'fetch hook instalado');
})();
