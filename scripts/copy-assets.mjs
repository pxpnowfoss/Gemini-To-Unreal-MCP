import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist/renderer/renderer');
mkdirSync(out, { recursive: true });
for (const f of ['index.html', 'styles.css']) {
  cpSync(resolve(root, 'src/renderer', f), resolve(out, f));
}
console.log('assets copied ->', out);
