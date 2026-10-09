/**
 * Serves the built renderer with a stubbed `window.api`, so the chat UI can be
 * inspected in a browser without Electron, an API key or a running editor.
 *
 * It exists because a CSS bug that squashed every tool card to a 1px sliver was
 * invisible in screenshots but obvious once the DOM could be measured.
 *
 *   npm run ui:harness     then open http://127.0.0.1:8777/
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, cpSync, mkdirSync } from 'node:fs';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, '.uiharness');
const built = join(root, 'dist/renderer/renderer');

if (!existsSync(built)) {
  console.error('Run `npm run build` first.');
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
for (const f of ['app.js', 'styles.css']) cpSync(join(built, f), join(dir, f));

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

createServer((req, res) => {
  const name = (req.url === '/' ? '/index.html' : req.url).split('?')[0];
  const file = join(dir, name);
  if (!file.startsWith(dir) || !existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'text/plain' });
  res.end(readFileSync(file));
}).listen(8777, '127.0.0.1', () => {
  console.log('UI harness on http://127.0.0.1:8777/  (Ctrl+C to stop)');
});
