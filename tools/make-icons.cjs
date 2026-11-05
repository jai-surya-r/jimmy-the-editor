// Makes the app's icons from build/logo.svg (run after changing the logo: npx electron tools/make-icons.cjs).
//   public/icon.svg, icon-black.svg   the logo (favicon and the marks in the app; the same on light and dark surfaces)
//   public/icon.png, icon-black.png   512 px: the window and taskbar icon (electron/main.js picks by the taskbar's theme)
//   build/icon.png                    1024 px: electron-builder makes the Windows .ico and the macOS .icns from it
// The logo is a whole icon, rounded tile included, so it is used as it is (its <title> left out: it would show as a
// tooltip on the marks).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'build', 'logo.svg'), 'utf8');
if (!/<svg[\s>]/.test(src)) throw new Error('build/logo.svg is not an SVG');
const svg = `${src.replace(/<title>[\s\S]*?<\/title>\s*/, '').trim()}\n`;
fs.writeFileSync(path.join(root, 'public', 'icon.svg'), svg);
fs.writeFileSync(path.join(root, 'public', 'icon-black.svg'), svg);

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<!doctype html><body>');
  const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  for (const [file, size] of [['public/icon.png', 512], ['public/icon-black.png', 512], ['build/icon.png', 1024]]) {
    const png = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image(); img.src = ${JSON.stringify(url)}; await img.decode();
      const c = document.createElement('canvas'); c.width = c.height = ${size};
      c.getContext('2d').drawImage(img, 0, 0, ${size}, ${size});
      return c.toDataURL('image/png').split(',')[1];
    })()`);
    fs.writeFileSync(path.join(root, file), Buffer.from(png, 'base64'));
    console.log(file, size);
  }
  app.quit();
}).catch((e) => { console.error(e); process.exit(1); });
