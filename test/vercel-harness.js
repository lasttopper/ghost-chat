/* Local harness that exercises the REAL Vercel function (api/ws.js) the way
 * Vercel's Node runtime would: plain HTTP requests go to the handler, and
 * socket upgrades are routed to it too. Used by test/vercel-e2e.js. */
'use strict';

const http = require('http');
const handler = require('../api/ws.js');

const PORT = process.env.PORT || 3211;

const server = http.createServer((req, res) => { handler(req, res); });
server.on('upgrade', (req, socket, head) => {
  // Node provides (req, socket, head); req.socket === socket. The Vercel
  // runtime calls the handler with the upgrade request as well.
  handler(req, null);
});
server.listen(PORT, '0.0.0.0', () => console.log('vercel harness on ' + PORT));
