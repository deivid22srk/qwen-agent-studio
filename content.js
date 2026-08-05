/**
 * content.js — Orquestra a extensão dentro da página do Qwen.
 *
 * Responsabilidades:
 *  1. Inicializar o injector (UI flutuante + painel).
 *  2. Interceptar envio de mensagens para injetar o system prompt do agente.
 *  3. Observar novas mensagens do assistente, detectar tool calls, executar,
 *     e injetar o resultado como nova mensagem de usuário.
 *  4. Manter o usuário informado via badge + painel de log.
 *
 * A interceptação é feita de duas formas complementares:
 *   A) Hook no fetch/XMLHttpRequest para capturar o stream da resposta do Qwen
 *      (assim detectamos tool calls em tempo real, antes do render final).
 *   B) MutationObserver no container de mensagens (fallback caso o stream
 *      mude de formato).
 */

(function () {
  'use strict';

  let SESSION_ID = 'sess-' + Date.now();
  let lastHandledSignature = new Set();
  let busy = false;

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

  // ---------- 1) Hook no fetch para capturar o streaming da resposta ----------
  function hookFetch() {
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
      const init = args[1] || {};
      const res = await origFetch.apply(this, args);

      // Captura prompts enviados (para usarmos como contexto)
      if (url && url.includes('/api/chat/completions') && init.method && init.method.toUpperCase() === 'POST') {
        try {
          const bodyStr = typeof init.body === 'string' ? init.body : '';
          if (bodyStr) {
            const body = JSON.parse(bodyStr);
            // Insere o system prompt do agente no início das mensagens, se ativo
            const cfgOn = await QwenStore.getConfig('agent_on', false);
            if (cfgOn) {
              const ctx = await getCtx();
              const sysPrompt = QwenParser.buildSystemPrompt(ctx);
              if (!body.messages || !body.messages.some((m) => m.role === 'system' && m.content && m.content.includes('TOOL CALL'))) {
                body.messages = body.messages || [];
                body.messages.unshift({ role: 'system', content: sysPrompt });
                // Re-serializa
                args[1] = { ...init, body: JSON.stringify(body) };
                return origFetch.apply(this, args);
              }
            }
          }
        } catch (e) {
          console.warn('[QwenAgent] falha ao inspecionar request:', e);
        }
      }
      return res;
    };
  }

  // ---------- 2) Observa mensagens do assistente (fallback robusto) ----------
  function observeMessages() {
    const observer = new MutationObserver(() => {
      if (busy) return;
      handleLatestAssistantMessage();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  async function handleLatestAssistantMessage() {
    // Tenta vários seletores possíveis para a última mensagem do assistente
    const candidates = [
      ...document.querySelectorAll('[class*="message"][class*="recieved"]'),
      ...document.querySelectorAll('[class*="message"][class*="assistant"]'),
      ...document.querySelectorAll('[class*="chat-message"][class*="assistant"]'),
      ...document.querySelectorAll('.markdown-body')
    ];

    // Pega o último elemento visível
    let lastMsg = null;
    for (let i = candidates.length - 1; i >= 0; i--) {
      const el = candidates[i];
      if (el && el.offsetParent !== null) {
        lastMsg = el;
        break;
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
    // Heurística simples: aguardar 600ms e checar se o tamanho mudou.
    const sizeBefore = text.length;
    busy = true;
    QwenInjector.setBusy(true);
    await sleep(700);
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

  // ---------- 3) Injeta uma nova mensagem de usuário no chat ----------
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
    await sleep(120);

    // Tenta o botão de envio
    const sendBtn = document.querySelector('.message-input-right-button-send') ||
                    document.querySelector('[class*="send"]');
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

  // ---------- 4) Listener para mensagens do popup/background ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'REFRESH_STATE') {
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
        // fallback: expõe pickFolder
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

  // ---------- 5) Boot ----------
  async function boot() {
    console.log('[QwenAgent] boot');
    await QwenInjector.init();
    hookFetch();
    observeMessages();
    // garante estado fresco a cada navigation SPA
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
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
