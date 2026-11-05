// electron-builder afterPack hook: signs the Mac app ad hoc (no certificate) before it goes into the dmg.
// Packing changes Electron's files, so without this the app has no valid signature at all, and on Apple Silicon
// macOS then calls a downloaded copy "damaged" and refuses to open it, with no "Open Anyway". Ad hoc signed, it is an
// app from an unidentified developer instead: right-click › Open (or System Settings › Privacy & Security ›
// Open Anyway) once, as for any unsigned app. A real Developer ID certificate would replace this.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad hoc signing  ${app}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
