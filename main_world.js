/**
 * main_world.js — Injetado no MAIN WORLD (mundo da página) da SPA do Qwen.
 *
 * Em Manifest V3, content scripts rodam em "isolated world" e:
 *   (a) NÃO conseguem hookar window.fetch da página
 *   (b) NÃO têm acesso a window.showDirectoryPicker em algumas versões do Chrome
 *
 * Este script roda no MAIN WORLD (mundo da página) e resolve os dois problemas:
 *   1. Hooka window.fetch para injetar o system prompt do agente
 *   2. Anexa handler de clique (capture phase) no botão #qa-pick do painel,
 *      chamando showDirectoryPicker diretamente no contexto da página (com gesto
 *      do usuário preservado).
 *
 * Comunicação com content.js (isolated): window.postMessage bidirecional.
 */

(function () {
  'use strict';

  const TAG = '[QwenAgent:main]';
  const PENDING = new Map(); // id → {resolve, reject}

  // ---------- Listener para respostas do content script (isolated) ----------
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.source !== 'qwen-agent-isolated') return;
    const { id, type, payload } = e.data;
    if (type === 'agent-state-response' && PENDING.has(id)) {
      PENDING.get(id).resolve(payload);
      PENDING.delete(id);
    }
  });

  function askIsolated(type, payload, timeoutMs = 800) {
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
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  function sendToIsolated(type, payload) {
    window.postMessage({
      source: 'qwen-agent-main',
      type, payload
    }, '*');
  }

  // =====================================================================
  // PARTE 1: Hook do window.fetch
  // =====================================================================
  // Estratégia:
  //  - Só intercepta POSTs para endpoints de CHAT (não todo /api/*)
  //  - Lê o body, parseia JSON, mescla system prompt com system message
  //    existente (em vez de adicionar novo)
  //  - Se a resposta for erro (4xx/5xx), RETRY com body original (sem
  //    modificação) para não quebrar a conversa do usuário
  //  - Re-instala periodicamente para sobreviver a wrappers do Qwen SPA

  function makeHookedFetch(downstreamFetch) {
    return async function (...args) {
      let url = '';
      let init = null;
      let requestObj = null;
      let originalArgs = args; // para fallback

      // Caso A: fetch(url, init)
      if (typeof args[0] === 'string') {
        url = args[0];
        init = args[1] || {};
      }
      // Caso B: fetch(Request)
      else if (args[0] instanceof Request) {
        requestObj = args[0];
        url = requestObj.url;
        init = {
          method: requestObj.method,
          headers: requestObj.headers,
          body: requestObj.body,
          mode: requestObj.mode,
          credentials: requestObj.credentials,
          cache: requestObj.cache,
          redirect: requestObj.redirect,
          referrer: requestObj.referrer,
          integrity: requestObj.integrity
        };
      }
      // Caso C: fetch(urlObj, init)
      else if (args[0] && typeof args[0] === 'object' && args[0].url) {
        url = args[0].url;
        init = args[1] || {};
      } else {
        return downstreamFetch.apply(this, args);
      }

      const method = (init.method || 'GET').toUpperCase();

      // Só intercepta POSTs para endpoints de chat/completion específicos do Qwen.
      // O Qwen usa /api/v2/chat/completions (versão 2 da API).
      // NÃO usar /api/ genérico — quebra auth, chats list, users/status, etc.
      const isChatEndpoint = method === 'POST' && (
        /\/api\/v\d+\/chat\/completions?/i.test(url) ||
        /\/api\/chat\/completions?/i.test(url) ||
        /\/api\/v\d+\/completions?/i.test(url) ||
        /\/api\/completions?/i.test(url) ||
        /\/api\/v\d+\/chat(s)?\/new/i.test(url) ||
        /\/api\/chat(s)?\/new/i.test(url) ||
        /\/api\/v\d+\/chat\/message/i.test(url) ||
        /\/api\/chat\/message/i.test(url)
      );

      if (!isChatEndpoint) {
        // Não é endpoint de chat — repassa sem modificar
        return downstreamFetch.apply(this, args);
      }

      console.log(TAG, 'POST chat →', url, '| body type:', typeof init.body);

      // Tenta injetar system prompt
      let modified = false;
      let modifiedArgs = null;

      try {
        const state = await askIsolated('get-agent-state');
        if (state && state.agentOn && state.systemPrompt) {
          // Lê o body em texto
          let bodyText = null;
          if (typeof init.body === 'string') {
            bodyText = init.body;
          } else if (init.body instanceof Blob) {
            bodyText = await init.body.text();
          } else if (init.body instanceof ArrayBuffer) {
            bodyText = new TextDecoder().decode(init.body);
          } else if (requestObj) {
            try { bodyText = await requestObj.clone().text(); } catch (_) { bodyText = null; }
          } else if (init.body && typeof init.body === 'object') {
            try { bodyText = String(init.body); } catch (_) { bodyText = null; }
          }

          if (bodyText) {
            let body;
            try { body = JSON.parse(bodyText); } catch (_) { body = null; }

            if (body && Array.isArray(body.messages)) {
              // Verifica se já temos nosso system prompt
              const hasAgentSys = body.messages.some((m) =>
                m.role === 'system' && typeof m.content === 'string' &&
                m.content.includes('TOOL CALL')
              );

              if (!hasAgentSys) {
                // Mescla com system message existente (em vez de adicionar novo)
                const existingSysIdx = body.messages.findIndex((m) => m.role === 'system');
                if (existingSysIdx >= 0) {
                  // Mescla: prepend nosso prompt ao system existente
                  const existing = body.messages[existingSysIdx];
                  existing.content = state.systemPrompt + '\n\n' + (existing.content || '');
                  console.log(TAG, '✅ system prompt mesclado em message[' + existingSysIdx + ']',
                              '| prompt chars:', state.systemPrompt.length);
                } else {
                  // Não há system message — adiciona no início
                  body.messages.unshift({ role: 'system', content: state.systemPrompt });
                  console.log(TAG, '✅ system prompt adicionado no início',
                              '| prompt chars:', state.systemPrompt.length);
                }

                const newBodyStr = JSON.stringify(body);
                // Constrói novos args: sempre (url, init) form (não Request)
                const newInit = { ...init, body: newBodyStr };
                // Copia headers se era Request
                if (requestObj && requestObj.headers) {
                  try {
                    const headersObj = {};
                    requestObj.headers.forEach((value, key) => {
                      headersObj[key] = value;
                    });
                    newInit.headers = headersObj;
                  } catch (_) { /* mantém init.headers */ }
                }
                modifiedArgs = [url, newInit];
                modified = true;
                console.log(TAG, '✅ system prompt injetado em', url,
                            '| mensagens:', body.messages.length,
                            '| prompt chars:', state.systemPrompt.length);
              } else {
                console.log(TAG, 'system prompt já presente, pulando');
              }
            } else if (body) {
              console.log(TAG, '⚠️ body sem array messages. keys:', Object.keys(body).slice(0, 10));
              // NÃO modifica — repassa original
            }
          } else {
            console.log(TAG, '⚠️ não foi possível ler body. type:', typeof init.body);
            // NÃO modifica — repassa original
          }
        } else if (state && !state.agentOn) {
          // agente desligado, não modifica
        } else if (!state) {
          console.warn(TAG, 'content script não respondeu a get-agent-state — repassando sem modificar');
        }
      } catch (e) {
        console.warn(TAG, 'falha ao injetar system prompt:', e, '— repassando sem modificar');
      }

      // Se não modificou, repassa args originais
      if (!modified) {
        return downstreamFetch.apply(this, originalArgs);
      }

      // Faz a chamada com o body modificado
      try {
        const response = await downstreamFetch.apply(this, modifiedArgs);

        // Se a resposta for erro (4xx/5xx), RETRY com body original
        if (response && response.status >= 400) {
          console.warn(TAG, '⚠️ API retornou erro', response.status,
                       '— retrying com body original (sem system prompt)');
          // Tenta ler o corpo do erro para debug
          try {
            const errClone = response.clone();
            const errText = await errClone.text();
            console.warn(TAG, 'erro body (primeiros 500 chars):', errText.slice(0, 500));
          } catch (_) {}

          // Retry com args originais
          const retryResponse = await downstreamFetch.apply(this, originalArgs);
          console.log(TAG, 'retry status:', retryResponse.status);
          return retryResponse;
        }

        console.log(TAG, '✅ resposta OK', response.status);
        return response;
      } catch (e) {
        console.error(TAG, 'fetch modificado falhou:', e.message,
                      '— retrying com body original');
        // Retry com args originais
        return downstreamFetch.apply(this, originalArgs);
      }
    };
  }

  // Instala o hook UMA VEZ, tornando window.fetch non-writable para que o
  // Qwen SPA não consiga sobrescrever. Se o Qwen SPA tentar `window.fetch = x`,
  // o assignment falha silenciosamente em non-strict mode (que é o caso do SPA).
  // Isso evita cadeias de hooks.
  let installCount = 0;
  function installHook() {
    const currentFetch = window.fetch;
    if (currentFetch && currentFetch.__qwenAgentHook) return; // já é nosso
    const hooked = makeHookedFetch(currentFetch);
    hooked.__qwenAgentHook = true;
    hooked.__qwenAgentNext = currentFetch;
    try {
      Object.defineProperty(window, 'fetch', {
        configurable: false,
        enumerable: true,
        writable: false,
        value: hooked
      });
    } catch (e) {
      // Se já foi definido como non-writable por uma instalação anterior
      // (improvável), usa assignment normal
      window.fetch = hooked;
    }
    installCount++;
    console.log(TAG, `fetch hook instalado (#${installCount}, non-writable)`);
  }

  installHook();

  // Re-verifica a cada 2s por 20s (caso a primeira instalação falhe por algum
  // motivo — ex: script injetado antes do window.fetch existir).
  // Após 20s, para de re-verificar (non-writable garante que sobrevive).
  let rehookInterval = setInterval(() => {
    if (window.fetch && window.fetch.__qwenAgentHook) {
      clearInterval(rehookInterval);
      return;
    }
    installHook();
  }, 2000);
  setTimeout(() => clearInterval(rehookInterval), 20000);

  // =====================================================================
  // PARTE 2: Folder picker via capture-phase click handler
  // =====================================================================

  function setupFolderPickerButton() {
    const btn = document.getElementById('qa-pick');
    if (!btn) return false;
    if (btn.__qwenAgentMainBound) return true;
    btn.__qwenAgentMainBound = true;

    btn.addEventListener('click', async (e) => {
      e.stopImmediatePropagation();
      e.preventDefault();

      console.log(TAG, 'botão #qa-pick clicado — chamando showDirectoryPicker...');

      if (typeof window.showDirectoryPicker !== 'function') {
        console.error(TAG, 'showDirectoryPicker não disponível neste navegador');
        sendToIsolated('folder-pick-error', {
          error: 'Seu navegador não suporta a File System Access API. Use Chrome 102+ ou Edge 102+.'
        });
        return;
      }

      try {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        console.log(TAG, 'pasta selecionada:', handle.name);

        let perm;
        try {
          perm = await handle.requestPermission({ mode: 'readwrite' });
        } catch (_) {
          perm = await handle.queryPermission({ mode: 'readwrite' });
        }
        if (perm !== 'granted') {
          sendToIsolated('folder-pick-error', {
            error: 'Permissão de leitura/escrita negada para a pasta.'
          });
          return;
        }

        sendToIsolated('folder-picked', { handle, name: handle.name });
      } catch (err) {
        console.warn(TAG, 'erro no showDirectoryPicker:', err);
        if (err.name === 'AbortError') {
          return;
        }
        sendToIsolated('folder-pick-error', {
          error: err.message || String(err),
          errorName: err.name
        });
      }
    }, true);

    console.log(TAG, 'handler de clique anexado ao botão #qa-pick');
    return true;
  }

  const pickerObserver = new MutationObserver(() => {
    setupFolderPickerButton();
  });
  pickerObserver.observe(document.documentElement, {
    childList: true, subtree: true
  });
  setupFolderPickerButton();

  // =====================================================================
  // PARTE 3: Botão de teste do agente (debug)
  // =====================================================================
  function setupTestButton() {
    const btn = document.getElementById('qa-test-agent');
    if (!btn || btn.__qwenAgentMainBound) return;
    btn.__qwenAgentMainBound = true;
    btn.addEventListener('click', async (e) => {
      e.stopImmediatePropagation();
      e.preventDefault();
      const state = await askIsolated('get-agent-state');
      console.log(TAG, 'estado atual do agente:', state);
      sendToIsolated('show-test-result', { state });
    }, true);
  }
  const testObs = new MutationObserver(() => setupTestButton());
  testObs.observe(document.documentElement, { childList: true, subtree: true });
  setupTestButton();

})();
