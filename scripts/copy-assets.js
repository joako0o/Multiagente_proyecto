/**
 * Copia a `dist/` los archivos que `tsc` no procesa:
 *  - `src/web`     → `dist/web`      (panel: HTML, CSS, JS)
 *  - `src/scripts` → `dist/scripts`  (bridge Python)
 *
 * Las librerías del panel (marked, DOMPurify, highlight.js) no se copian:
 * el servidor las sirve desde `node_modules` bajo `/vendor`.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

const directories = [
  ['src/web', 'dist/web'],
  ['src/scripts', 'dist/scripts']
];

for (const [from, to] of directories) {
  const src = path.join(root, from);
  if (!fs.existsSync(src)) continue;
  fs.mkdirSync(path.join(root, to), { recursive: true });
  fs.cpSync(src, path.join(root, to), { recursive: true, force: true });
  console.log(`[copy-assets] ${from} → ${to}`);
}
