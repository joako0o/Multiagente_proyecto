const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'src');
const distDir = path.join(rootDir, 'dist');

const copyDirs = ['web', 'scripts'];

for (const dir of copyDirs) {
  const srcPath = path.join(srcDir, dir);
  const distPath = path.join(distDir, dir);
  if (fs.existsSync(srcPath)) {
    fs.mkdirSync(distPath, { recursive: true });
    fs.cpSync(srcPath, distPath, { recursive: true, force: true });
    console.log(`[copy-assets] Copied ${srcPath} -> ${distPath}`);
  }
}
