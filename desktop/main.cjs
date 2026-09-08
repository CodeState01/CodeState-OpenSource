const { app, BrowserWindow, session, shell, dialog, desktopCapturer } = require('electron');
const { appendFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { autoUpdater } = require('electron-updater');

let window;
const diagnosticLog = join(tmpdir(), 'orbit-studio-error.log');
try { appendFileSync(diagnosticLog, `${new Date().toISOString()} desktop process started\n`); } catch {}
const defaultPublicServer = 'https://codestate-community.onrender.com';

async function start() {
  try { appendFileSync(diagnosticLog, `${new Date().toISOString()} Electron ready\n`); } catch {}
  const appRoot = app.getAppPath();
  const serverArg = process.argv.find(value => value.startsWith('--server='))?.slice(9) || process.env.CODESTATE_SERVER_URL || process.env.ORBIT_SERVER_URL || defaultPublicServer;
  const remote = new URL(serverArg);
  if (remote.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(remote.hostname)) throw new Error('O servidor remoto precisa usar HTTPS.');
  const target = remote.href.replace(/\/$/, '');
  const allowedOrigin = new URL(target).origin;

  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(['media', 'display-capture'].includes(permission)));
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => ['media', 'display-capture'].includes(permission));
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
      callback({ video: sources.find(source => source.id.startsWith('screen:')) || sources[0] });
    } catch { callback({}); }
  }, { useSystemPicker: true });
  window = new BrowserWindow({
    width: 1480, height: 900, minWidth: 820, minHeight: 600,
    title: 'CodeState', backgroundColor: '#090909', show: false,
    icon: join(appRoot, 'desktop', 'icon.ico'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith('https://')) shell.openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { try { if (new URL(url).origin !== allowedOrigin) event.preventDefault(); } catch { event.preventDefault(); } });
  window.once('ready-to-show', () => window.show());
  await window.loadURL(target);
  configureUpdates();
}

function configureUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', () => {
    const answer = dialog.showMessageBoxSync(window, { type:'info', title:'Atualização pronta', message:'Uma nova versão do CodeState foi baixada.', detail:'Reinicie agora para aplicar a atualização.', buttons:['Reiniciar agora','Depois'], defaultId:0, cancelId:1 });
    if (answer === 0) autoUpdater.quitAndInstall(false, true);
  });
  autoUpdater.on('error', error => { try { appendFileSync(diagnosticLog, `${new Date().toISOString()} updater: ${error.message}\n`); } catch {} });
  setTimeout(() => autoUpdater.checkForUpdatesAndNotify().catch(()=>{}), 12000);
  setInterval(() => autoUpdater.checkForUpdatesAndNotify().catch(()=>{}), 4 * 60 * 60 * 1000);
}

app.on('ready', () => start().catch(error => {
  const details = `${new Date().toISOString()}\n${error?.stack || error}\n\n`;
  try { appendFileSync(diagnosticLog, details); } catch {}
  dialog.showErrorBox('CodeState não iniciou', `Detalhes salvos em orbit-studio-error.log.\n\n${error?.message || error}`);
  app.quit();
}));
app.on('window-all-closed', () => app.quit());
