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

  function askIsolated(type, payload, timeoutMs = 2000) {
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
  // IMPORTANTE: o Qwen SPA também hooka window.fetch. Para garantir que
  // nosso hook rode DEPOIS do hook do Qwen (e veja o body final), usamos
  // Object.defineProperty com getter/setter. Assim, mesmo que o Qwen SPA
  // tente sobrescrever window.fetch depois, nosso hook permanece no controle.

  function makeHookedFetch(downstreamFetch) {
    // downstreamFetch = o fetch que está "abaixo" do nosso hook (pode ser o
    // nativo ou o wrapper do Qwen SPA). Chamamos downstreamFetch.apply(...)
    // para que o wrapper do SPA ainda execute (preservando o comportamento dele).
    return async function (...args) {
      let url = '';
      let init = null;
      let requestObj = null;

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
      const isApiPost = method === 'POST' && /\/api\//i.test(url);

      if (isApiPost) {
        console.log(TAG, 'POST →', url, '| body type:', typeof init.body,
                    '| hasRequest:', !!requestObj);
      }

      // Tenta injetar system prompt se for endpoint de chat
      if (isApiPost) {
        try {
          const state = await askIsolated('get-agent-state');
          if (state && state.agentOn && state.systemPrompt) {
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
                const hasAgentSys = body.messages.some((m) =>
                  m.role === 'system' && typeof m.content === 'string' &&
                  m.content.includes('TOOL CALL')
                );
                if (!hasAgentSys) {
                  body.messages.unshift({ role: 'system', content: state.systemPrompt });
                  const newBodyStr = JSON.stringify(body);
                  init = { ...init, body: newBodyStr };
                  requestObj = null;
                  console.log(TAG, '✅ system prompt injetado em', url,
                              '| mensagens:', body.messages.length,
                              '| prompt chars:', state.systemPrompt.length);
                } else {
                  console.log(TAG, 'system prompt já presente, pulando');
                }
              } else if (body) {
                console.log(TAG, '⚠️ body sem array messages. keys:', Object.keys(body).slice(0, 10));
              }
            } else {
              console.log(TAG, '⚠️ não foi possível ler body. type:', typeof init.body);
            }
          } else if (state && !state.agentOn) {
            // agente desligado, não injeta
          } else if (!state) {
            console.warn(TAG, 'content script não respondeu a get-agent-state');
          }
        } catch (e) {
          console.warn(TAG, 'falha ao injetar system prompt:', e);
        }
      }

      // Chama o fetch "abaixo" (nativo ou wrapper do Qwen SPA)
      if (requestObj) {
        return downstreamFetch.apply(this, [requestObj]);
      }
      if (typeof args[0] === 'string' || (args[0] && !(args[0] instanceof Request))) {
        return downstreamFetch.apply(this, [args[0], init]);
      }
      return downstreamFetch.apply(this, [args[0], init]);
    };
  }

  // Substitui window.fetch com nosso hook. Como o Qwen SPA também hooka fetch
  // (às vezes DEPOIS de nós, sobrescrevendo nosso hook), re-aplicamos
  // periodicamente para garantir que sejamos sempre o hook mais externo.
  // Não usamos writable:false porque isso pode quebrar o SPA.
  let installCount = 0;
  function installHook() {
    // Captura o fetch atual (pode ser o nativo, ou o wrapper do Qwen SPA)
    const currentFetch = window.fetch;
    // Se já é nosso hook, não faz nada
    if (currentFetch.__qwenAgentHook) return;
    // Marca nosso hook
    const hooked = makeHookedFetch(currentFetch);
    hooked.__qwenAgentHook = true;
    // Guarda referência ao "próximo" fetch para debug
    hooked.__qwenAgentNext = currentFetch;
    window.fetch = hooked;
    installCount++;
    console.log(TAG, `fetch hook instalado (#${installCount})`);
  }

  // Instala imediatamente
  installHook();

  // Re-instala a cada 500ms por 8 segundos (para capturar wrappers que o
  // Qwen SPA adicione depois). Após 8s, re-instala a cada 3s para sempre.
  let rehookInterval = setInterval(installHook, 500);
  setTimeout(() => {
    clearInterval(rehookInterval);
    setInterval(installHook, 3000);
    console.log(TAG, 're-hook switched to 3s interval');
  }, 8000);

  // =====================================================================
  // PARTE 2: Folder picker via capture-phase click handler
  // =====================================================================
  // Anexamos um handler de clique (fase de captura) ao botão #qa-pick do painel.
  // Como este script roda no MAIN WORLD, window.showDirectoryPicker está disponível.
  // Como é um handler direto de clique do usuário, o gesto é preservado.

  function setupFolderPickerButton() {
    const btn = document.getElementById('qa-pick');
    if (!btn) return false;
    if (btn.__qwenAgentMainBound) return true;
    btn.__qwenAgentMainBound = true;

    // Capture phase = roda ANTES do handler do content script
    btn.addEventListener('click', async (e) => {
      // Interrompe propagação para o handler do content script (quebrado) não rodar
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

        // Pede permissão explicitamente dentro do gesto do usuário
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

        // Envia handle de volta para o content script (structured clone)
        sendToIsolated('folder-picked', { handle, name: handle.name });
      } catch (err) {
        console.warn(TAG, 'erro no showDirectoryPicker:', err);
        if (err.name === 'AbortError') {
          // usuário cancelou — não mostra erro
          return;
        }
        sendToIsolated('folder-pick-error', {
          error: err.message || String(err),
          errorName: err.name
        });
      }
    }, true); // capture = true

    console.log(TAG, 'handler de clique anexado ao botão #qa-pick');
    return true;
  }

  // Observa até o botão aparecer (o painel é criado depois do boot)
  const pickerObserver = new MutationObserver(() => {
    if (setupFolderPickerButton()) {
      // não desconecta — o painel pode ser recriado
    }
  });
  pickerObserver.observe(document.documentElement, {
    childList: true, subtree: true
  });
  // tenta uma vez imediatamente
  setupFolderPickerButton();

  // =====================================================================
  // PARTE 3: Botão de teste do agente (opcional, para debug)
  // =====================================================================
  // Observa o botão #qa-test-agent se existir
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
