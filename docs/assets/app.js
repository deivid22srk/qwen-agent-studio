/* assets/app.js — pequenas interações da landing page */

(function () {
  'use strict';

  // Detecta se o usuário está em Chrome/Chromium para ajustar a mensagem
  function detectBrowser() {
    const ua = navigator.userAgent;
    if (/Edg\//.test(ua)) return { name: 'Edge', ok: true };
    if (/OPR\//.test(ua) || /Opera/.test(ua)) return { name: 'Opera', ok: true };
    if (/Brave/.test(ua)) return { name: 'Brave', ok: true };
    if (/Chrome\//.test(ua) && !/Edg|OPR|Opera/.test(ua)) return { name: 'Chrome', ok: true };
    if (/Firefox\//.test(ua)) return { name: 'Firefox', ok: false };
    if (/Safari\//.test(ua)) return { name: 'Safari', ok: false };
    return { name: 'unknown', ok: false };
  }

  const browser = detectBrowser();
  const hint = document.getElementById('install-hint');
  const installBtn = document.getElementById('install-btn');

  if (!browser.ok && hint) {
    hint.innerHTML =
      `⚠️ Detectamos <strong>${browser.name}</strong>. Esta extensão funciona apenas em navegadores ` +
      `baseados em Chromium (Chrome, Edge, Brave, Opera, Arc). ` +
      `No ${browser.name} ela não será carregada.`;
    if (installBtn) {
      installBtn.classList.add('btn-disabled');
      installBtn.style.opacity = '0.6';
      installBtn.style.pointerEvents = 'none';
    }
  } else if (browser.ok && hint) {
    hint.innerHTML =
      `Detectamos <strong>${browser.name}</strong> ✓ — Após baixar: extraia → abra ` +
      `<code>chrome://extensions</code> (ou <code>edge://extensions</code> etc.) → ative ` +
      `<strong>Modo desenvolvedor</strong> → <strong>Carregar sem compactação</strong> → selecione a pasta.`;
  }

  // Smooth scroll para #usage
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href').slice(1);
      const el = document.getElementById(id);
      if (el) {
        e.preventDefault();
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
})();
