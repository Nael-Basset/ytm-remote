// Régénère les copies à partir des sources uniques :
//   - extension/          -> extension_firefox/  (manifest adapté : background.scripts + gecko)
//   - index.html          -> extension/remote/ et extension_firefox/remote/
//   - peerjs.min.js       -> extension/remote/ et extension_firefox/remote/
// Usage : node tools/sync-builds.js
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'extension');
const FIREFOX = path.join(ROOT, 'extension_firefox');

function copyDir(from, to, skip) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.includes(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst, []);
    else fs.copyFileSync(src, dst);
  }
}

// 1. Pages de télécommande embarquées
for (const dir of [SRC, FIREFOX]) {
  fs.mkdirSync(path.join(dir, 'remote'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(dir, 'remote', 'index.html'));
  fs.copyFileSync(path.join(ROOT, 'peerjs.min.js'), path.join(dir, 'remote', 'peerjs.min.js'));
}

// 2. Build Firefox : même code, manifest adapté
copyDir(SRC, FIREFOX, ['manifest.json']);
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
manifest.background = { scripts: ['background.js'] };
manifest.browser_specific_settings = {
  gecko: { id: 'youtube-music-player@nael.com', strict_min_version: '128.0' }
};
fs.writeFileSync(path.join(FIREFOX, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log('Copies régénérées : extension_firefox/, */remote/');
