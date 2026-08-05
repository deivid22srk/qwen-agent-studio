/**
 * lib/injector.js — Injeta elementos na interface existente do Qwen Studio.
 *
 * Princípio: NÃO criar interface paralela. Tudo é adicionado dentro do
 * próprio chat.qwen.ai:
 *
 *  1. Botão flutuante "Agent" no canto inferior direito (status on/off)
 *  2. Painel lateral colapsável à direita com: árvore de arquivos,
 *     histórico de tool calls, e botão "selecionar pasta"
 *  3. Badge no header da conversa quando agente está ativo
 *  4. Substitui o textarea padrão por um que injeta o system prompt
 *     quando o agente está ligado
 */

(function (global) {
  'use strict';

  const SIDEBAR_WIDTH = 360;
  let panel = null;
  let toggleBtn = null;
  let state = {
    agentOn: false,
    hasFolder: false,
    folderName: '',
    busy: false
  };

  async function refreshState() {
    const handle = await QwenStore.getHandle();
    const agentOn = await QwenStore.getConfig('agent_on', false);
    state.hasFolder = !!handle;
    state.folderName = handle ? handle.name : '';
    state.agentOn = !!agentOn;
    render();
  }

  function ensureStyles() {
    if (document.getElementById('qwen-agent-inject-style')) return;
    const s = document.createElement('style');
    s.id = 'qwen-agent-inject-style';
    s.textContent = `
      .qa-toggle-btn {
        position: fixed; right: 24px; bottom: 96px; z-index: 99999;
        width: 56px; height: 56px; border-radius: 50%;
        background: linear-gradient(135deg,#6d5bff 0%,#4628e0 100%);
        color: #fff; border: none; cursor: pointer; font-size: 24px;
        box-shadow: 0 6px 24px rgba(70,40,224,.45);
        display: flex; align-items: center; justify-content: center;
        transition: transform .2s, box-shadow .2s;
      }
      .qa-toggle-btn:hover { transform: translateY(-2px) scale(1.05); box-shadow: 0 8px 32px rgba(70,40,224,.6); }
      .qa-toggle-btn.off { background: linear-gradient(135deg,#3a3a3a 0%,#1f1f1f 100%); box-shadow: 0 4px 12px rgba(0,0,0,.45); }
      .qa-toggle-btn.busy::after {
        content:''; position:absolute; inset:-4px; border-radius:50%;
        border:3px solid transparent; border-top-color:#6d5bff;
        animation: qa-spin 1s linear infinite;
      }
      @keyframes qa-spin { to { transform: rotate(360deg); } }

      .qa-panel {
        position: fixed; top:0; right:0; bottom:0; width:${SIDEBAR_WIDTH}px;
        background: #1a1a1a; color: #eaeaea; z-index: 99998;
        transform: translateX(100%); transition: transform .25s ease;
        display: flex; flex-direction: column;
        border-left: 1px solid #2a2a2a; box-shadow: -8px 0 32px rgba(0,0,0,.4);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      }
      .qa-panel.open { transform: translateX(0); }
      .qa-panel-header {
        padding: 14px 18px; background:#222; border-bottom:1px solid #333;
        display:flex; align-items:center; justify-content:space-between;
        font-weight:600; font-size:14px;
      }
      .qa-panel-header .qa-folder {
        color:#8b8b8b; font-size:12px; font-weight:400; max-width:200px;
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
      }
      .qa-panel-tabs {
        display:flex; border-bottom:1px solid #2a2a2a; background:#1f1f1f;
      }
      .qa-panel-tabs button {
        flex:1; background:transparent; border:none; color:#8b8b8b;
        padding:10px 8px; cursor:pointer; font-size:13px; border-bottom:2px solid transparent;
      }
      .qa-panel-tabs button.active { color:#fff; border-bottom-color:#6d5bff; }
      .qa-panel-body { flex:1; overflow-y:auto; padding:12px; }
      .qa-panel-body::-webkit-scrollbar { width:8px; }
      .qa-panel-body::-webkit-scrollbar-thumb { background:#333; border-radius:4px; }
      .qa-panel-footer {
        padding:12px; border-top:1px solid #2a2a2a; background:#1f1f1f;
        display:flex; gap:8px; flex-direction:column;
      }
      .qa-btn {
        background:#2a2a2a; color:#fff; border:1px solid #3a3a3a;
        padding:8px 12px; border-radius:6px; cursor:pointer; font-size:13px;
        transition: background .15s;
      }
      .qa-btn:hover { background:#333; }
      .qa-btn.primary { background:#4628e0; border-color:#4628e0; }
      .qa-btn.primary:hover { background:#5836ff; }
      .qa-btn.danger { background:#5a1d1d; border-color:#7a2424; }

      .qa-switch {
        display:flex; align-items:center; gap:8px; padding:10px 12px;
        background:#222; border-radius:8px; margin-bottom:8px;
      }
      .qa-switch-label { flex:1; font-size:13px; }
      .qa-switch-toggle {
        width:42px; height:24px; background:#3a3a3a; border-radius:12px;
        position:relative; cursor:pointer; transition:background .15s;
      }
      .qa-switch-toggle.on { background:#4628e0; }
      .qa-switch-toggle::after {
        content:''; position:absolute; top:2px; left:2px;
        width:20px; height:20px; border-radius:50%; background:#fff;
        transition: transform .15s;
      }
      .qa-switch-toggle.on::after { transform: translateX(18px); }

      .qa-tree-node {
        padding:4px 6px; font-size:12px; cursor:default; white-space:nowrap;
        display:flex; align-items:center; gap:4px; border-radius:4px;
      }
      .qa-tree-node:hover { background:#262626; }
      .qa-tree-node.dir { color:#8ab4ff; }
      .qa-tree-node.file { color:#d4d4d4; }
      .qa-tree-icon { width:14px; display:inline-block; }

      .qa-log-entry {
        background:#222; padding:8px 10px; border-radius:6px; margin-bottom:8px;
        font-family: "SF Mono", Menlo, monospace; font-size:11px; line-height:1.5;
        border-left: 3px solid #4628e0;
      }
      .qa-log-entry.error { border-left-color:#ff5252; }
      .qa-log-entry.finish { border-left-color:#52c41a; }
      .qa-log-entry .qa-log-head {
        display:flex; justify-content:space-between; color:#8b8b8b;
        margin-bottom:4px; font-size:10px;
      }
      .qa-log-entry .qa-log-args, .qa-log-entry .qa-log-result {
        background:#1a1a1a; padding:6px; border-radius:4px; margin-top:4px;
        white-space:pre-wrap; word-break:break-all; max-height:120px; overflow-y:auto;
      }

      .qa-badge {
        position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
        background:#4628e0; color:#fff; padding:6px 14px; border-radius:18px;
        z-index:99997; font-size:12px; font-weight:600; box-shadow:0 4px 12px rgba(70,40,224,.4);
        animation: qa-fadein .3s;
      }
      @keyframes qa-fadein { from { opacity:0; transform: translate(-50%, -10px); } to { opacity:1; transform: translate(-50%,0); } }

      .qa-status-line {
        font-size:11px; color:#8b8b8b; padding:6px 10px; background:#1a1a1a;
        border-radius:6px; margin-bottom:8px;
      }
      .qa-empty { color:#666; font-size:12px; text-align:center; padding:24px 8px; }
    `;
    document.head.appendChild(s);
  }

  function ensureToggleButton() {
    if (toggleBtn && document.body.contains(toggleBtn)) return;
    ensureStyles();
    toggleBtn = document.createElement('button');
    toggleBtn.className = 'qa-toggle-btn off';
    toggleBtn.title = 'Qwen Agent Studio';
    toggleBtn.innerHTML = '<span>🤖</span>';
    toggleBtn.addEventListener('click', () => {
      const p = ensurePanel();
      p.classList.toggle('open');
      refreshState();
    });
    document.body.appendChild(toggleBtn);
  }

  function ensurePanel() {
    if (panel && document.body.contains(panel)) return panel;
    ensureStyles();
    panel = document.createElement('div');
    panel.className = 'qa-panel';
    panel.innerHTML = `
      <div class="qa-panel-header">
        <div>
          <div>Qwen Agent Studio</div>
          <div class="qa-folder" id="qa-folder-name">— sem pasta —</div>
        </div>
        <button class="qa-btn" id="qa-close" style="padding:4px 10px">×</button>
      </div>
      <div class="qa-panel-tabs">
        <button data-tab="status" class="active">Status</button>
        <button data-tab="files">Arquivos</button>
        <button data-tab="log">Tool Log</button>
      </div>
      <div class="qa-panel-body" id="qa-body"></div>
      <div class="qa-panel-footer">
        <button class="qa-btn primary" id="qa-pick">📁 Selecionar pasta de projetos</button>
        <button class="qa-btn danger" id="qa-clear" style="display:none">🔌 Desconectar pasta</button>
      </div>
    `;
    document.body.appendChild(panel);

    panel.querySelector('#qa-close').addEventListener('click', () => panel.classList.remove('open'));
    panel.querySelectorAll('.qa-panel-tabs button').forEach((b) => {
      b.addEventListener('click', () => {
        panel.querySelectorAll('.qa-panel-tabs button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        renderBody(b.dataset.tab);
      });
    });
    // ⚠️ NÃO adicionamos handler de clique para #qa-pick aqui.
    // O main_world.js (MAIN WORLD) anexa um handler em capture phase que
    // chama window.showDirectoryPicker no contexto da página (onde a API existe
    // e o gesto do usuário é preservado). O resultado é enviado de volta via
    // postMessage para o content.js, que persiste o handle no IndexedDB.
    //
    // Se main_world.js não estiver carregado por algum motivo, o botão
    // simplesmente não fará nada (silently fails). Para detectar isso,
    // adicionamos um handler "fallback" que detecta se main_world não respondeu.
    panel.querySelector('#qa-pick').addEventListener('click', (e) => {
      // Este handler roda DEPOIS do handler de capture phase do main_world
      // (que chama e.stopImmediatePropagation). Se chegou aqui, significa
      // que o main_world NÃO interceptou — provavelmente não carregou.
      // Avisamos o usuário.
      console.warn('[QwenAgent] #qa-pick clicado mas main_world não interceptou. main_world.js carregou?');
      // Verifica se o script tag existe
      const script = document.getElementById('qwen-agent-main-world-script');
      if (!script) {
        alert('Erro: main_world.js não foi carregado. Recarregue a página (F5) e tente novamente.');
      } else if (typeof window.showDirectoryPicker === 'function') {
        // Tentativa direta — pode funcionar em alguns Chromes
        pickFolderFallback();
      } else {
        alert('Seu navegador não expõe window.showDirectoryPicker no content script.\n' +
              'Recarregue a página (F5) para garantir que main_world.js carregue.');
      }
    });
    panel.querySelector('#qa-clear').addEventListener('click', clearFolder);

    return panel;
  }

  // Fallback: tentar chamar showDirectoryPicker diretamente do content script.
  // Funciona em algumas versões do Chrome; falha em outras com "is not a function".
  async function pickFolderFallback() {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      const ok = await QwenFS.verifyPermission(handle, 'readwrite');
      if (!ok) {
        alert('Permissão negada para a pasta.');
        return;
      }
      await QwenStore.putHandle(handle);
      await QwenStore.setConfig('agent_on', true);
      await QwenStore.setConfig('last_folder', handle.name);
      await refreshState();
      renderBody('files');
      showBadge(`✅ Pasta conectada: ${handle.name}`);
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error(e);
        alert('Erro ao selecionar pasta: ' + e.message);
      }
    }
  }

  // pickFolder original — mantido para compat, mas não é mais o caminho principal.
  // O fluxo real agora é: user clica #qa-pick → main_world capture handler →
  // showDirectoryPicker → postMessage → content.js persiste.
  async function pickFolder() {
    return pickFolderFallback();
  }

  async function clearFolder() {
    if (!confirm('Desconectar a pasta de projetos? As tool calls de arquivos ficarão desativadas.')) return;
    await QwenStore.clearHandle();
    await QwenStore.setConfig('agent_on', false);
    await refreshState();
  }

  async function toggleAgent() {
    const next = !state.agentOn;
    await QwenStore.setConfig('agent_on', next);
    state.agentOn = next;
    render();
    if (next) {
      showBadge('🤖 Agente ATIVADO');
    } else {
      showBadge('🤖 Agente desativado');
    }
  }

  function showBadge(text, ms = 2200) {
    const old = document.querySelector('.qa-badge');
    if (old) old.remove();
    const b = document.createElement('div');
    b.className = 'qa-badge';
    b.textContent = text;
    document.body.appendChild(b);
    setTimeout(() => b.remove(), ms);
  }

  function render() {
    ensureToggleButton();
    if (!panel) return;
    // toggle btn
    toggleBtn.classList.toggle('off', !state.agentOn);
    toggleBtn.classList.toggle('busy', state.busy);
    // folder name
    const fld = panel.querySelector('#qa-folder-name');
    if (fld) fld.textContent = state.hasFolder ? `📁 ${state.folderName}` : '— sem pasta —';
    const clr = panel.querySelector('#qa-clear');
    if (clr) clr.style.display = state.hasFolder ? 'block' : 'none';
    // active tab
    const active = panel.querySelector('.qa-panel-tabs button.active');
    renderBody(active ? active.dataset.tab : 'status');
  }

  async function renderBody(tab) {
    if (!panel) return;
    const body = panel.querySelector('#qa-body');
    if (!body) return;
    if (tab === 'status') {
      body.innerHTML = `
        <div class="qa-switch">
          <div class="qa-switch-label">
            <div>Modo Agente</div>
            <div style="color:#8b8b8b; font-size:11px">Injeta tool-call system prompt no Qwen</div>
          </div>
          <div class="qa-switch-toggle ${state.agentOn ? 'on' : ''}" id="qa-agent-toggle"></div>
        </div>
        <div class="qa-status-line">
          ${state.hasFolder
            ? `✅ Pasta conectada: <b>${state.folderName}</b>`
            : '⚠️ Nenhuma pasta selecionada. Clique em "Selecionar pasta" abaixo.'}
        </div>
        <div class="qa-status-line">
          ${state.agentOn
            ? '🟢 Agente ativo — o modelo pode invocar ferramentas.'
            : '⚪ Agente inativo — o Qwen funciona normalmente.'}
        </div>
        <div class="qa-status-line" id="qa-main-world-status" style="font-size:11px">
          Verificando main_world…
        </div>
        <div style="margin-top:14px; font-size:12px; color:#8b8b8b; line-height:1.6">
          <p><b>Como usar:</b></p>
          <p>1. Clique em <b>Selecionar pasta</b> abaixo e escolha a pasta do seu projeto.</p>
          <p>2. Ligue o <b>Modo Agente</b> acima.</p>
          <p>3. No chat do Qwen, peça tarefas como: "liste os arquivos", "leia src/index.js", "crie um arquivo hello.py".</p>
          <p>4. O agente executará as ações e continuará a conversa com base nos resultados.</p>
        </div>
        <button class="qa-btn" id="qa-test-agent" style="margin-top:10px;width:100%">🧪 Testar estado do agente</button>
      `;
      body.querySelector('#qa-agent-toggle').addEventListener('click', toggleAgent);
      // Verifica se main_world.js está carregado
      const mwStatus = body.querySelector('#qa-main-world-status');
      const script = document.getElementById('qwen-agent-main-world-script');
      if (script) {
        // Tenta pingar o main_world
        try {
          const pingId = 'p' + Math.random().toString(36).slice(2, 8);
          const pingPromise = new Promise((resolve) => {
            const handler = (e) => {
              if (e.source !== window) return;
              if (e.data && e.data.source === 'qwen-agent-main' && e.data.id === pingId) {
                window.removeEventListener('message', handler);
                resolve(true);
              }
            };
            window.addEventListener('message', handler);
            window.postMessage({
              source: 'qwen-agent-isolated',
              id: pingId, type: 'get-agent-state', payload: {}
            }, '*');
            setTimeout(() => {
              window.removeEventListener('message', handler);
              resolve(false);
            }, 1500);
          });
          const alive = await pingPromise;
          mwStatus.innerHTML = alive
            ? '✅ main_world.js carregado e respondendo'
            : '⚠️ main_world.js carregado mas não respondeu (recarregue a página)';
        } catch (_) {
          mwStatus.innerHTML = '⚠️ Não foi possível verificar main_world.js';
        }
      } else {
        mwStatus.innerHTML = '❌ main_world.js NÃO carregado — recarregue a página (F5)';
      }
    } else if (tab === 'files') {
      body.innerHTML = '<div class="qa-empty">Carregando…</div>';
      try {
        const handle = await QwenStore.getHandle();
        if (!handle) {
          body.innerHTML = '<div class="qa-empty">Nenhuma pasta selecionada.<br>Clique em "Selecionar pasta" abaixo.</div>';
          return;
        }
        const ok = await QwenFS.verifyPermission(handle, 'readwrite');
        if (!ok) {
          body.innerHTML = '<div class="qa-empty">Permissão negada. Clique novamente em "Selecionar pasta" para reautorizar.</div>';
          return;
        }
        const t = await QwenFS.tree(handle, '.', 4);
        if (!t.length) {
          body.innerHTML = '<div class="qa-empty">Pasta vazia.</div>';
          return;
        }
        body.innerHTML = t.map((e) => {
          const indent = '  '.repeat(e.depth);
          const icon = e.kind === 'directory' ? '📁' : '📄';
          const cls = e.kind === 'directory' ? 'dir' : 'file';
          return `<div class="qa-tree-node ${cls}">${indent}<span class="qa-tree-icon">${icon}</span>${e.name}</div>`;
        }).join('');
      } catch (e) {
        body.innerHTML = `<div class="qa-empty">Erro: ${e.message}</div>`;
      }
    } else if (tab === 'log') {
      body.innerHTML = '<div class="qa-empty">Carregando…</div>';
      try {
        const log = await QwenStore.getRecentLog(50);
        if (!log.length) {
          body.innerHTML = '<div class="qa-empty">Nenhuma tool call executada ainda.</div>';
          return;
        }
        body.innerHTML = log.reverse().map((e) => `
          <div class="qa-log-entry ${e.status}">
            <div class="qa-log-head">
              <span>${e.tool}</span>
              <span>${new Date(e.ts).toLocaleTimeString()} · ${e.ms}ms</span>
            </div>
            <div class="qa-log-args">▶ ${JSON.stringify(e.args)}</div>
            <div class="qa-log-result">${escapeHtml((e.result || '').slice(0, 600))}</div>
          </div>
        `).join('');
      } catch (e) {
        body.innerHTML = `<div class="qa-empty">Erro: ${e.message}</div>`;
      }
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Seta o estado "busy" quando uma tool call está em execução.
   */
  function setBusy(v) {
    state.busy = !!v;
    render();
  }

  /**
   * Observa mudanças no DOM para reinjetar elementos se o Qwen fizer re-render.
   */
  function startObserver() {
    const obs = new MutationObserver(() => {
      ensureToggleButton();
    });
    obs.observe(document.body, { childList: true, subtree: false });
  }

  /**
   * Inicializa o injector.
   */
  async function init() {
    // espera o body
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', init, { once: true });
      return;
    }
    ensureStyles();
    ensureToggleButton();
    ensurePanel();
    await refreshState();
    startObserver();
  }

  global.QwenInjector = {
    init,
    refreshState,
    render,
    renderBody,
    showBadge,
    setBusy,
    state,
    _pickFolder: pickFolder
  };
})(window);
