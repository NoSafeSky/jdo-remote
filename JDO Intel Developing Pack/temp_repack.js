const asar = require('asar');
const fs = require('fs');
const path = require('path');

const tmp = 'dist/win-unpacked/resources/app_extracted5';
if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

asar.extractAll('dist/win-unpacked/resources/app.asar', tmp);

const htmlPath = path.join(tmp, 'renderer', 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
const marker = 'UI-MARKER-123';
html = html.replace(marker, '');

fs.writeFileSync(htmlPath, html);

asar
  .createPackage(tmp, 'dist/win-unpacked/resources/app.asar')
  .then(() => console.log('repacked with marker'))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });