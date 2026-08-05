/**
 * popup.js — controla o popup da extensão.
 *
 * O popup NÃO pode acessar File System Access API (showDirectoryPicker)
 * porque é uma janela curta que fecha ao perder foco. Por isso, quando o
 * usuário clica em "Selecionar pasta", enviamos uma mensagem para o
 * content script na aba ativa do Qwen, que faz a seleção real.
 */

async function getActiveQwenTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0] && /qwen\.ai/.test(tabs[0].url || '')) return tabs[0];
  // procura qualquer aba do qwen
  const qtabs = await chrome.tabs.query({ url: ['https://chat.qwen.ai/*', 'https://*.qwen.ai/*'] });
  return qtabs[0] || null;
}

async function refreshUI() {
  // pega estado do content script (se houver aba do qwen)
  const tab = await getActiveQwenTab();
  let state = { agentOn: false, hasFolder: false, folderName: '' };
  if (tab) {
    try {
      state = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATE' });
    } catch (_) { /* aba não tem content script carregado */ }
  }
  // fallback: lê direto do storage
  if (!state) state = {};
  const agentOn = await chrome.storage.local.get('agent_on');
  state.agentOn = state.agentOn ?? !!agentOn.agent_on;
  const folder = await chrome.storage.local.get('last_folder');
  state.folderName = state.folderName || folder.last_folder || '';

  document.getElementById('qa-toggle-agent').checked = !!state.agentOn;
  document.getElementById('qa-folder-name').textContent =
    state.hasFolder || state.folderName ? ('📁 ' + (state.folderName || '')) : '— nenhuma —';
  document.getElementById('qa-clear').style.display =
    (state.hasFolder || state.folderName) ? 'block' : 'none';
}

document.addEventListener('DOMContentLoaded', refreshUI);

document.getElementById('qa-toggle-agent').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ agent_on: e.target.checked });
  // notifica abas do qwen
  const qtabs = await chrome.tabs.query({ url: ['https://chat.qwen.ai/*', 'https://*.qwen.ai/*'] });
  qtabs.forEach((t) => chrome.tabs.sendMessage(t.id, { type: 'REFRESH_STATE' }).catch(() => {}));
});

document.getElementById('qa-pick').addEventListener('click', async () => {
  let tab = await getActiveQwenTab();
  if (!tab) {
    // abre o Qwen e tenta de novo após carregar
    tab = await new Promise((resolve) => chrome.tabs.create({ url: 'https://chat.qwen.ai/' }, resolve));
    await new Promise((r) => setTimeout(r, 4000));
  }
  if (!tab) {
    alert('Não foi possível abrir o Qwen.');
    return;
  }
  // sinaliza o content script para abrir o seletor
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_FOLDER_PICKER' });
    window.close();
  } catch (e) {
    alert('Recarregue a aba do Qwen (F5) e tente novamente. Detalhe: ' + e.message);
  }
});

document.getElementById('qa-clear').addEventListener('click', async () => {
  if (!confirm('Desconectar a pasta?')) return;
  await chrome.storage.local.remove('last_folder');
  await chrome.storage.local.set({ agent_on: false });
  const qtabs = await chrome.tabs.query({ url: ['https://chat.qwen.ai/*', 'https://*.qwen.ai/*'] });
  qtabs.forEach((t) => chrome.tabs.sendMessage(t.id, { type: 'REFRESH_STATE' }).catch(() => {}));
  refreshUI();
});

document.getElementById('qa-open-qwen').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://chat.qwen.ai/' });
  window.close();
});

document.getElementById('qa-help').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://deivid22srk.github.io/qwen-agent-studio/#usage' });
});
