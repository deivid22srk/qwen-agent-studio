/**
 * background.js — service worker (Manifest V3).
 *
 * Funções:
 *  - Abrir a página de boas-vindas na primeira instalação.
 *  - Encaminhar mensagens simples entre popup ↔ content script.
 *  - Reabrir a aba do Qwen quando o usuário clica no ícone da extensão.
 */

const WELCOME_URL = 'https://deivid22srk.github.io/qwen-agent-studio/';
const QWEN_URL = 'https://chat.qwen.ai/';

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: WELCOME_URL });
  }
});

chrome.action.onClicked.addListener(async () => {
  // Procura uma aba do Qwen já aberta; se não houver, abre
  const tabs = await chrome.tabs.query({ url: ['https://chat.qwen.ai/*', 'https://*.qwen.ai/*'] });
  if (tabs.length) {
    chrome.tabs.update(tabs[0].id, { active: true });
    chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    chrome.tabs.create({ url: QWEN_URL });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'OPEN_QWEN') {
    chrome.tabs.create({ url: QWEN_URL }, (t) => sendResponse({ tabId: t.id }));
    return true;
  }
  if (msg.type === 'REFRESH_QWEN_TABS') {
    chrome.tabs.query({ url: ['https://chat.qwen.ai/*', 'https://*.qwen.ai/*'] }, (tabs) => {
      tabs.forEach((t) => chrome.tabs.sendMessage(t.id, { type: 'REFRESH_STATE' }).catch(() => {}));
      sendResponse({ count: tabs.length });
    });
    return true;
  }
});
