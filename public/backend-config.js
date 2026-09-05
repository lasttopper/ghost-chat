/* Ghost Chat — backend location.
 *
 * '' (default) = same origin: the frontend is served by the Ghost Chat
 * server itself (standalone, Render, Railway, Termux, Vercel).
 *
 * Set this to your backend URL when the frontend is hosted separately —
 * e.g. frontend on GitHub Pages, backend on Render:
 *   window.GHOST_BACKEND = 'https://ghost-chat.onrender.com';
 * The Pages workflow (.github/workflows/pages.yml) fills this in
 * automatically from the repo variable BACKEND_URL.
 */
window.GHOST_BACKEND = '';
