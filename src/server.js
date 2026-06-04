/**
 * Minimal static file server for the DFU web uploader.
 *
 * Web Serial API requires a secure context (localhost or HTTPS),
 * so we need a server — opening index.html directly won't work.
 *
 * Usage:
 *   node server.js
 *   # then open http://localhost:3000
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
};

const server = http.createServer((req, res) => {
  // Map / → /www/index.html; everything else relative to project root
  let p = req.url === '/' ? '/www/index.html' : req.url;
  // Strip query string
  p = p.split('?')[0];
  const filePath = path.join(__dirname, p);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found: ' + p);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n  🧪 nRF52 DFU Uploader`);
  console.log(`  Open → http://localhost:${PORT}\n`);
});
