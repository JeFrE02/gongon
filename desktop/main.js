// Electron shell for GonGon.
// Serves the prebuilt client bundle (dist/) from a custom, privileged app:// scheme:
// no localhost listener, no terminal, works with no network at all.
import { app, BrowserWindow, protocol, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORIGIN, PRIVILEGED_SCHEMES, applyNavigationGuards, registerAppProtocol } from './bundle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');

app.setName('GonGon');
protocol.registerSchemesAsPrivileged(PRIVILEGED_SCHEMES);

function createWindow() {
  const win = new BrowserWindow({
    title: 'GonGon',
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0b1220',
    show: false,
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
      devTools: !app.isPackaged,
    },
  });

  // The window is always named by the app, not by page content.
  win.on('page-title-updated', (event) => event.preventDefault());
  win.once('ready-to-show', () => win.show());

  if (process.env.GONGON_LOG) {
    win.webContents.on('console-message', (event) => {
      console.log(`[console] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => console.log(`[fail-load] ${code} ${desc} ${url}`));
    win.webContents.once('did-finish-load', () => console.log('[renderer] loaded', win.webContents.getURL()));
  }

  // No untrusted navigation, no new windows: this is a local game, not a browser.
  applyNavigationGuards(win, { openExternal: (url) => shell.openExternal(url) });

  const shot = process.argv.find((a) => a.startsWith('--screenshot='));
  if (shot) {
    const target = path.resolve(process.cwd(), shot.slice('--screenshot='.length));
    const delay = Number((process.argv.find((a) => a.startsWith('--screenshot-delay=')) || '').split('=')[1]) || 9000;
    setTimeout(async () => {
      const image = await win.webContents.capturePage();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, image.toPNG());
      console.log(`[proof] screenshot ${target}`);
      app.quit();
    }, delay);
  }

  win.loadURL(`${ORIGIN}/index.html`);
  return win;
}

if (!app.requestSingleInstanceLock()) app.quit();

app.on('second-instance', () => {
  const [win] = BrowserWindow.getAllWindows();
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(() => {
  app.setAppUserModelId('com.gongon.game');
  // The game needs no camera/mic/geolocation/notifications; refuse everything.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  registerAppProtocol(protocol, DIST);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
