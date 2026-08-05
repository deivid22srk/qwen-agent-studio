/**
 * content.js — Orquestra a extensão dentro da página do Qwen (ISOLATED WORLD).
 *
 * Responsabilidades:
 *  1. Inicializar o injector (UI flutuante + painel).
 *  2. Injetar main_world.js na página (MAIN WORLD) para hookar o fetch.
 *  3. Responder a mensagens do main_world com estado do agente + system prompt.
 *  4. Observar novas mensagens do assistente, detectar tool calls, executar,
 *     e injetar o resultado como nova mensagem de usuário.
 *  5. Manter o usuário informado via badge + painel de log.
 *
 * Arquitetura de comunicação:
 *   - main_world.js (MAIN) → window.postMessage → content.js (ISOLATED)
 *   - content.js responde com window.postMessage de volta
 *   Isto é necessário porque content scripts em MV3 rodam em isolated world
 *   e não conseguem hookar window.fetch da página diretamente.
 */

(function () {
  'use strict';

  let SESSION_ID = 'sess-' + Date.now();
  let lastHandledSignature = new Set();
  let busy = false;
  let cachedSystemPrompt = null; // cache: invalidado quando agent_on muda
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

  // ---------- 1) Injeta main_world.js no MAIN WORLD da página ----------
  function injectMainWorldScript() {
    if (document.getElementById('qwen-agent-main-world-script')) return;
    // Tenta via <script src> (web_accessible_resources)
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
    const { id, type, payload } = event.data;

    if (type === 'get-agent-state') {
      try {
        const agentOn = await QwenStore.getConfig('agent_on', false);
        let systemPrompt = null;
        if (agentOn) {
          // só rebuilda se mudou
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
          id, type: 'agent-state-response',
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
          id, type: 'agent-state-response',
          payload: { agentOn: false, systemPrompt: null, error: e.message }
        }, '*');
      }
    }
  }
  window.addEventListener('message', handleMainWorldMessage);

  // ---------- 3) Observa mensagens do assistente (fallback robusto) ----------
  function observeMessages() {
    const observer = new MutationObserver(() => {
      if (busy) return;
      handleLatestAssistantMessage();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  async function handleLatestAssistantMessage() {
    // Tenta vários seletores possíveis para a última mensagem do assistente.
    // Ordem: do mais específico para o mais genérico.
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
        // pega o último visível
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

    // signature para não processar a mesma msg 2x
    const sig = text.slice(0, 80) + '|' + text.length;
    if (lastHandledSignature.has(sig)) return;

    const calls = QwenParser.extractToolCalls(text);
    if (!calls.length) return;

    // só processa se a mensagem parece "estável" (não está mais crescendo).
    const sizeBefore = text.length;
    busy = true;
    QwenInjector.setBusy(true);
    await sleep(900);
    const textAfter = (lastMsg.innerText || '').trim();
    if (Math.abs(textAfter.length - sizeBefore) > 50) {
      // ainda mudando — tenta de novo depois
      busy = false;
      QwenInjector.setBusy(false);
      return;
    }

    lastHandledSignature.add(sig);

    // Por segurança, processa apenas a primeira chamada neste turno
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

    // injeta o resultado como nova mensagem de usuário
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

    // Foca e define o valor usando o setter nativo (React controla o valor)
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    ).set;
    nativeInputValueSetter.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    // Aguarda o React processar e dispara Enter
    await sleep(150);

    // Tenta o botão de envio
    const sendBtn = document.querySelector('.message-input-right-button-send') ||
                    document.querySelector('[class*="send"]:not([disabled])');
    if (sendBtn) {
      sendBtn.click();
    } else {
      // fallback: Enter
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
      // invalida cache do system prompt
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
      // O popup chama isto — ainda há ativação transitória do gesto do clique.
      // Garante que o painel está aberto e dispara o seletor.
      const p = document.querySelector('.qa-panel');
      if (p) p.classList.add('open');
      // chama a função interna do injector
      if (globalThis.QwenInjector && QwenInjector._pickFolder) {
        QwenInjector._pickFolder().then(() => sendResponse({ ok: true }))
          .catch((e) => sendResponse({ ok: false, error: e.message }));
      } else {
        // fallback: pickFolder inline
        const pick = async () => {
          try {
            const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
            const ok = await QwenFS.verifyPermission(handle, 'readwrite');
            if (!ok) return { ok: false, error: 'permission denied' };
            await QwenStore.putHandle(handle);
            await QwenStore.setConfig('agent_on', true);
            await QwenStore.setConfig('last_folder', handle.name);
            await QwenInjector.refreshState();
            QwenInjector.showBadge(`✅ Pasta conectada: ${handle.name}`);
            return { ok: true };
          } catch (e) {
            return { ok: false, error: e.message };
          }
        };
        pick().then(sendResponse);
      }
      return true;
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
    // garante estado fresco a cada navigation SPA
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

  // start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
