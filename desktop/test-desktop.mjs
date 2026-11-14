// Desktop shell checks against the real protocol handler: npx electron desktop/test-desktop.mjs
// Covers offline bundle serving, missing-asset 404, CSP, preload surface and navigation guards.
import { app, BrowserWindow, protocol } from 'electron';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORIGIN, PRIVILEGED_SCHEMES, applyNavigationGuards, isLocalUrl, registerAppProtocol } from './bundle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');

let failed = 0;
const check = (name, cond, extra = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

protocol.registerSchemesAsPrivileged(PRIVILEGED_SCHEMES);

app.whenReady().then(async () => {
  check('isLocalUrl accepts app://gongon/index.html', isLocalUrl(`${ORIGIN}/index.html`));
  check('isLocalUrl accepts a nested bundle asset', isLocalUrl(`${ORIGIN}/assets/a.glb`));
  check('isLocalUrl rejects remote https', !isLocalUrl('https://example.com/'));
  check('isLocalUrl rejects another app:// host', !isLocalUrl('app://evil/index.html'));
  check('isLocalUrl rejects file://', !isLocalUrl('file:///etc/passwd'));
  check('isLocalUrl rejects non-URL input', !isLocalUrl('not a url'));

  check('dist/index.html exists (run npm run build first)', fs.existsSync(path.join(DIST, 'index.html')));

  registerAppProtocol(protocol, DIST);
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
    },
  });
  const openedExternally = [];
  applyNavigationGuards(win, { openExternal: (url) => openedExternally.push(url) });

  const level3 = (level) => (typeof level === 'string' ? (level === 'error' ? 3 : level === 'warning' ? 2 : 1) : level);
  const consoleMessages = [];
  win.webContents.on('console-message', (event, level, message) => {
    consoleMessages.push({ level: level3(event.level ?? level), message: event.message ?? message });
  });

  const js = (code) => win.webContents.executeJavaScript(code, true);
  await win.loadURL(`${ORIGIN}/index.html`);
  await wait(3000);

  const shellState = await js(`(() => {
    const script = document.querySelector('script[src]');
    const r = {};
    r.href = location.href;
    r.canvas = !!document.querySelector('canvas');
    r.webgl2 = (() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; } })();
    try { localStorage.setItem('gongon.probe', '1'); r.storage = localStorage.getItem('gongon.probe') === '1'; } catch (e) { r.storage = 'error ' + e.message; }
    r.bridge = window.gongonDesktop && window.gongonDesktop.isDesktop === true;
    r.nodeGlobals = ['require', 'process', 'ipcRenderer', 'Buffer', 'global'].filter((k) => k in window).join(',');
    r.assetUrl = script ? new URL(script.src, location.href).href : null;
    return r;
  })()`);

  check('bundled page loaded from app://', shellState.href.startsWith(`${ORIGIN}/index.html`), shellState.href);
  check('three.js canvas present after load', shellState.canvas);
  check('webgl2 context available', shellState.webgl2);
  check('localStorage works on app:// origin', shellState.storage === true, String(shellState.storage));
  check('gongonDesktop bridge exposed', shellState.bridge);
  check('no Node globals leaked to the renderer', shellState.nodeGlobals === '', shellState.nodeGlobals);
  check('built bundle references a relative asset', !!shellState.assetUrl, String(shellState.assetUrl));

  const asset = await js(`fetch(new URL(document.querySelector('script[src]').src, location.href).href)
    .then(r => r.status + ' ' + r.headers.get('content-type'))`);
  check('real asset served 200 with js mime', /^200 text\/javascript/.test(asset), asset);

  const missing = await js(`fetch('${ORIGIN}/assets/__does_not_exist__.glb').then(r => r.status)`);
  check('missing asset returns 404 (not index.html)', missing === 404, String(missing));

  const csp = await js(`fetch(location.href).then(r => r.headers.get('content-security-policy') || 'none')`);
  check('CSP header served with the document', /connect-src 'self' blob: ws: wss:/.test(csp), csp);

  if (fs.existsSync(path.join(DIST, 'assets'))) {
    const models = fs.readdirSync(path.join(DIST, 'assets')).filter((f) => f.endsWith('.glb'));
    if (models.length) {
      const served = await js(`Promise.all(${JSON.stringify(models)}.map(f => fetch('assets/' + f).then(r => r.status + ' ' + r.headers.get('content-type'))))`);
      check(`bundled model assets served (${models.length} glb)`, served.every((s) => s.startsWith('200 model/gltf-binary')), served.join(' | '));
    }
  }

  await js(`location.href = 'https://example.com/'`);
  await wait(1000);
  check('remote navigation blocked', (await js(`location.href`)).startsWith(ORIGIN));

  await js(`window.open('https://example.com/', '_blank')`);
  await wait(500);
  check('popup denied, remote url handed to the OS browser',
    openedExternally.length === 1 && BrowserWindow.getAllWindows().length === 1, openedExternally.join(','));

  await js(`location.href = '${ORIGIN}/index.html?nav=1'`);
  await wait(1500);
  check('local navigation allowed', (await js(`location.href`)).endsWith('/index.html?nav=1'));

  // Control: the same bundle + the same CSP header over loopback http. Electron's CSP security
  // warning reads response headers through webRequest, which never sees protocol.handle
  // responses, so this proves the policy itself is what keeps the http load warning-free.
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  const server = http.createServer((req, res) => {
    const rel = new URL(req.url, 'http://x').pathname;
    const file = path.join(DIST, rel === '/' ? 'index.html' : rel);
    try {
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-security-policy': csp });
      res.end(fs.readFileSync(file));
    } catch { res.writeHead(404); res.end('nope'); }
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const control = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  const controlMessages = [];
  control.webContents.on('console-message', (event, level, message) => {
    controlMessages.push({ level: level3(event.level ?? level), message: event.message ?? message });
  });
  await control.loadURL(`http://127.0.0.1:${port}/index.html`);
  await wait(2500);
  const controlCspWarnings = controlMessages.filter((m) => /security warning/i.test(m.message));
  check('control load over http with the same CSP shows no security warning', controlCspWarnings.length === 0,
    controlCspWarnings.map((m) => m.message.split('\n')[0]).join(' | ') || 'none');
  server.close();

  const ignore = (text) => /favicon|DevTools|blob:.*Content Security Policy|GLTFLoader|security warning/i.test(text);
  const realErrors = consoleMessages.filter((m) => m.level >= 2 && !ignore(m.message));
  check('no other renderer errors', realErrors.length === 0, realErrors.map((m) => m.message.split('\n')[0]).join(' | '));

  console.log(failed === 0 ? '\ndesktop shell checks passed' : `\n${failed} desktop shell check(s) FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
  app.quit();
});
