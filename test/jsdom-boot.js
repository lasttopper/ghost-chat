/* Headless boot test: loads the DEPLOYED page (scripts included) in jsdom
 * and reports any runtime error + whether a visible screen rendered. */
'use strict';
const { JSDOM } = require('jsdom');

const URL = process.argv[2] || 'https://lasttopper.github.io/ghost-chat/';

(async () => {
  const html = await (await fetch(URL)).text();
  const virtualConsole = new (require('jsdom').VirtualConsole)();
  virtualConsole.on('jsdomError', (e) => console.log('JSDOM ERROR:', e.message, (e.detail && e.detail.message) || ''));
  virtualConsole.on('error', (...a) => console.log('CONSOLE.ERROR:', ...a.map(String)));
  const dom = new JSDOM(html, {
    url: URL,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
  });
  dom.window.addEventListener('error', (e) => console.log('WINDOW UNCAUGHT:', e.message));

  await new Promise((r) => setTimeout(r, 8000));

  const d = dom.window.document;
  const vis = (id) => {
    const el = d.getElementById(id);
    return el && !el.classList.contains('hidden') ? 'VISIBLE' : 'hidden';
  };
  console.log('--- after 8s ---');
  console.log('login:', vis('login'), '| username-setup:', vis('username-setup'), '| app:', vis('app'));
  console.log('title:', d.title);
  const loginCard = d.querySelector('.login-card');
  if (loginCard) console.log('login card h1:', (loginCard.querySelector('h1') || {}).textContent);
  process.exit(0);
})().catch((e) => { console.error('HARNESS ERROR:', e.message); process.exit(1); });
