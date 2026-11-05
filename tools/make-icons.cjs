// Makes the app's icons from build/logo.svg (run after changing the logo: npx electron tools/make-icons.cjs).
//   public/icon.svg, icon-black.svg   the logo on its tile, cropped, without the embedded metadata (favicon and the marks in the app)
//   public/icon.png, icon-black.png   512 px: the window and taskbar icon, chosen by the taskbar's theme (electron/main.js)
//   build/icon.png                    1024 px: electron-builder makes the Windows .ico and the macOS .icns from it
// White tile with a black logo for dark surfaces, the opposite for light ones; each tile's gradient is 10% of lightness from the top.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
// the drawing fills only the middle of its 2048 canvas; a square of this size around it leaves the tile's margin
const [X, Y, SIZE] = [286, 285, 1480];
const RADIUS = SIZE * 0.225;

const src = fs.readFileSync(path.join(root, 'build', 'logo.svg'), 'utf8');
const shape = src.match(/<path[^>]*\/>/)?.[0];
if (!shape) throw new Error('no path in the logo');
const tile = (top, bottom, logo) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${X} ${Y} ${SIZE} ${SIZE}">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs>
<rect x="${X}" y="${Y}" width="${SIZE}" height="${SIZE}" rx="${RADIUS}" fill="url(#g)"/>
${shape.replace(' transform="translate(0,0)"', '').replace(/fill="[^"]*"/, `fill="${logo}"`)}
</svg>
`;
const white = tile('#ffffff', '#e6e6e6', '#000000');
const black = tile('#1a1a1a', '#000000', '#ffffff');
fs.writeFileSync(path.join(root, 'public', 'icon.svg'), white);
fs.writeFileSync(path.join(root, 'public', 'icon-black.svg'), black);

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<!doctype html><body>');
  for (const [file, size, svg] of [['public/icon.png', 512, white], ['public/icon-black.png', 512, black], ['build/icon.png', 1024, white]]) {
    const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
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
