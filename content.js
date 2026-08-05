/**
 * content.js — Orquestra a extensão dentro da página do Qwen (ISOLATED WORLD).
 *
 * Responsabilidades:
 *  1. Inicializar o injector (UI flutuante + painel).
 *  2. Injetar main_world.js na página (MAIN WORLD) para hookar o fetch e
 *     chamar showDirectoryPicker a partir do contexto da página.
 *  3. Responder a mensagens do main_world com estado do agente + system prompt.
 *  4. Receber o FileSystemDirectoryHandle do main_world e persistir no IndexedDB.
 *  5. Observar novas mensagens do assistente, detectar tool calls, executar,
 *     e injetar o resultado como nova mensagem de usuário.
 */

(function () {
  'use strict';

  let SESSION_ID = 'sess-' + Date.now();
  let lastHandledSignature = new Set();
  let busy = false;
  let cachedSystemPrompt = null;
  let cachedAgentOn = null;

  async function getCtx() {
    const h = await QwenStore.getHandle();
    const ok = h ? await QwenFS.verifyPermission(h, 'readwrite') : false;
    return {
      root: ok ? h : null,
      hasFolder: ok,
      projectRoot: h ? h.name : '',
      session: SESSION_ID
    };
  }

  // ---------- 1) Injeta main_world.js no MAIN WORLD ----------
  function injectMainWorldScript() {
    if (document.getElementById('qwen-agent-main-world-script')) return;
    try {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('main_world.js');
      s.id = 'qwen-agent-main-world-script';
      s.async = false;
      s.onload = () => console.log('[QwenAgent] main_world.js injetado');
      s.onerror = () => console.warn('[QwenAgent] falha ao injetar main_world.js');
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      console.warn('[QwenAgent] injectMainWorldScript falhou:', e);
    }
  }

  // ---------- 2) Listener de mensagens do main_world ----------
  async function handleMainWorldMessage(event) {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'qwen-agent-main') return;
    const { type, payload } = event.data;

    // Estado do agente (consultado pelo hook do fetch antes de cada POST)
    if (type === 'get-agent-state') {
      try {
        const agentOn = await QwenStore.getConfig('agent_on', false);
        let systemPrompt = null;
        if (agentOn) {
          if (cachedAgentOn !== agentOn || !cachedSystemPrompt) {
            const ctx = await getCtx();
            cachedSystemPrompt = QwenParser.buildSystemPrompt(ctx);
            cachedAgentOn = agentOn;
          }
          systemPrompt = cachedSystemPrompt;
        }
        const folder = await QwenStore.getHandle();
        window.postMessage({
          source: 'qwen-agent-isolated',
          id: event.data.id,
          type: 'agent-state-response',
          payload: {
            agentOn,
            systemPrompt,
            hasFolder: !!folder,
            folderName: folder ? folder.name : null
          }
        }, '*');
      } catch (e) {
        window.postMessage({
          source: 'qwen-agent-isolated',
          id: event.data.id,
          type: 'agent-state-response',
          payload: { agentOn: false, systemPrompt: null, error: e.message }
        }, '*');
      }
      return;
    }

    // Pasta selecionada via main_world (showDirectoryPicker)
    if (type === 'folder-picked' && payload && payload.handle) {
      console.log('[QwenAgent] pasta recebida do main_world:', payload.name);
      try {
        // Re-verifica permissão no contexto do content script
        const ok = await QwenFS.verifyPermission(payload.handle, 'readwrite');
        if (!ok) {
          QwenInjector.showBadge('❌ Permissão negada');
          alert('Permissão negada para a pasta. Tente novamente.');
          return;
        }
        await QwenStore.putHandle(payload.handle);
        await QwenStore.setConfig('agent_on', true);
        await QwenStore.setConfig('last_folder', payload.handle.name);
        // invalida cache do system prompt
        cachedAgentOn = null;
        cachedSystemPrompt = null;
        await QwenInjector.refreshState();
        QwenInjector.showBadge(`✅ Pasta conectada: ${payload.handle.name}`);
        // troca para a aba Arquivos do painel
        QwenInjector.renderBody('files');
      } catch (e) {
        console.error('[QwenAgent] erro ao salvar handle:', e);
        alert('Erro ao salvar pasta: ' + e.message);
      }
      return;
    }

    // Erro ao selecionar pasta
    if (type === 'folder-pick-error' && payload && payload.error) {
      console.error('[QwenAgent] folder-pick-error:', payload);
      // só alerta se não for AbortError (usuário cancelou)
      if (payload.errorName !== 'AbortError' && !/abort/i.test(payload.error)) {
        alert('Erro ao selecionar pasta:\n\n' + payload.error);
        QwenInjector.showBadge('❌ ' + payload.error.slice(0, 60));
      }
      return;
    }

    // Teste do agente (debug)
    if (type === 'show-test-result' && payload && payload.state) {
      const s = payload.state;
      alert(
        'Estado do Agente:\n' +
        '  agentOn: ' + s.agentOn + '\n' +
        '  hasFolder: ' + s.hasFolder + '\n' +
        '  folderName: ' + (s.folderName || '(none)') + '\n' +
        '  systemPrompt chars: ' + (s.systemPrompt ? s.systemPrompt.length : 0)
      );
    }
  }
  window.addEventListener('message', handleMainWorldMessage);

  // ---------- 3) Observa mensagens do assistente para detectar tool calls ----------
  function observeMessages() {
    const observer = new MutationObserver(() => {
      if (busy) return;
      handleLatestAssistantMessage();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  async function handleLatestAssistantMessage() {
    const selectors = [
      '[class*="message"][class*="recieved"]',
      '[class*="message"][class*="received"]',
      '[class*="message"][class*="assistant"]',
      '[class*="chat-message"][class*="assistant"]',
      '.markdown-body',
      '[class*="MessageItem"][class*="assistant"]'
    ];
    let lastMsg = null;
    for (const sel of selectors) {
      const list = document.querySelectorAll(sel);
      if (list.length) {
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].offsetParent !== null || list[i].offsetHeight > 0) {
            lastMsg = list[i];
            break;
          }
        }
        if (lastMsg) break;
      }
    }
    if (!lastMsg) return;

    const text = (lastMsg.innerText || lastMsg.textContent || '').trim();
    if (!text) return;

    const sig = text.slice(0, 80) + '|' + text.length;
    if (lastHandledSignature.has(sig)) return;

    const calls = QwenParser.extractToolCalls(text);
    if (!calls.length) return;

    const sizeBefore = text.length;
    busy = true;
    QwenInjector.setBusy(true);
    await sleep(900);
    const textAfter = (lastMsg.innerText || '').trim();
    if (Math.abs(textAfter.length - sizeBefore) > 50) {
      busy = false;
      QwenInjector.setBusy(false);
      return;
    }

    lastHandledSignature.add(sig);

    const call = calls[0];
    QwenInjector.showBadge(`⚙️ ${call.name}…`, 1500);

    const ctx = await getCtx();
    let result;
    try {
      if (!ctx.hasFolder && !['list_running_tools', 'finish'].includes(call.name)) {
        result = '⚠️ Nenhuma pasta de projetos selecionada. Peça ao usuário para selecionar uma pasta no painel do Qwen Agent Studio (canto inferior direito).';
      } else {
        const r = await QwenTools.execute(call.name, call.args, ctx);
        result = r.result;
        if (call.name === 'finish') {
          QwenInjector.showBadge('✅ Tarefa concluída', 2200);
          busy = false;
          QwenInjector.setBusy(false);
          return;
        }
      }
    } catch (e) {
      result = '❌ Erro: ' + e.message;
    }

    const formatted = QwenParser.formatToolResult(call, result);
    await injectUserMessage(formatted);

    busy = false;
    QwenInjector.setBusy(false);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ---------- 4) Injeta uma nova mensagem de usuário no chat ----------
  async function injectUserMessage(text) {
    const textarea = document.querySelector('textarea.message-input-textarea') ||
                     document.querySelector('textarea[placeholder*="help"]') ||
                     document.querySelector('textarea');
    if (!textarea) {
      console.warn('[QwenAgent] textarea não encontrado');
      return;
    }

    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    ).set;
    nativeInputValueSetter.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    await sleep(150);

    const sendBtn = document.querySelector('.message-input-right-button-send') ||
                    document.querySelector('[class*="send"]:not([disabled])');
    if (sendBtn) {
      sendBtn.click();
    } else {
      const ev = new KeyboardEvent('keydown', {
        bubbles: true, cancelable: true,
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13
      });
      textarea.dispatchEvent(ev);
    }
  }

  // ---------- 5) Listener para mensagens do popup/background ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'REFRESH_STATE') {
      cachedAgentOn = null;
      cachedSystemPrompt = null;
      QwenInjector.refreshState().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.type === 'INJECT_PROMPT') {
      injectUserMessage(msg.text).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.type === 'OPEN_FOLDER_PICKER') {
      // O popup pediu para abrir o seletor de pasta. Como o gesto do usuário
      // foi consumido no popup, não podemos chamar showDirectoryPicker aqui.
      // Apenas abrimos o painel e instruímos o usuário a clicar no botão.
      const p = document.querySelector('.qa-panel');
      if (p) {
        p.classList.add('open');
        // Destaca o botão por 2s
        const btn = p.querySelector('#qa-pick');
        if (btn) {
          btn.style.outline = '3px solid #6d5bff';
          btn.style.outlineOffset = '2px';
          setTimeout(() => {
            btn.style.outline = '';
            btn.style.outlineOffset = '';
          }, 3000);
        }
      }
      sendResponse({ ok: true, instruction: 'Clique no botão "Selecionar pasta" no painel à direita.' });
      return false;
    }
    if (msg.type === 'GET_STATE') {
      sendResponse({
        agentOn: QwenInjector.state.agentOn,
        hasFolder: QwenInjector.state.hasFolder,
        folderName: QwenInjector.state.folderName
      });
      return false;
    }
  });

  // ---------- 6) Boot ----------
  async function boot() {
    console.log('[QwenAgent] boot (isolated world)');
    await QwenInjector.init();
    injectMainWorldScript();
    observeMessages();
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        cachedAgentOn = null;
        cachedSystemPrompt = null;
        QwenInjector.refreshState();
      }
    }, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
