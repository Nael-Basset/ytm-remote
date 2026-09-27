// i18n.js - Multi-browser localization helper

globalThis.browser = globalThis.browser || globalThis.chrome;
var browser = globalThis.browser;

document.addEventListener('DOMContentLoaded', () => {
  const setters = [
    ['data-i18n', (el, msg) => { el.textContent = msg; }],
    ['data-i18n-title', (el, msg) => { el.setAttribute('title', msg); }],
    ['data-i18n-aria', (el, msg) => { el.setAttribute('aria-label', msg); }]
  ];
  for (const [attr, setter] of setters) {
    document.querySelectorAll(`[${attr}]`).forEach((el) => {
      const key = el.getAttribute(attr);
      const msg = browser.i18n.getMessage(key);
      if (msg) setter(el, msg);
    });
  }
});
