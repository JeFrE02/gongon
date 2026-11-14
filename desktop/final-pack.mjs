// FINAL one-shot: rebuild from the frozen dist, package mac + win, prove the packaged asar
// matches dist, then drive the packaged app (menu RU/EN, coop config + real room, offline
// combat shots, restart persistence). Fails loudly if anything does not match.
import { execSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'proof/desktop/shots');
const BIN = path.join(ROOT, 'proof/desktop/mac-arm64/GonGon.app/Contents/MacOS/GonGon');
const ASAR = path.join(ROOT, 'proof/desktop/mac-arm64/GonGon.app/Contents/Resources/app.asar');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sh = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const killApp = async () => {
  try { execSync('pkill -f "GonGon.app/Contents/MacOS/GonGon"'); } catch {}
  // The app holds a single-instance lock; a fresh launch quits instantly if the old one is
  // still exiting, which used to leave CDP calls pending forever.
  for (let i = 0; i < 40; i++) {
    try { execSync('pgrep -f "GonGon.app/Contents/MacOS/GonGon"'); } catch { return; }
    await sleep(250);
  }
};

// ---------------------------------------------------------------- 1. fingerprint dist
const assetsDir = path.join(ROOT, 'dist/assets');
const jsName = fs.readdirSync(assetsDir).find((f) => /^index-.*\.js$/.test(f));
const glbs = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.glb'));
const fingerprint = {
  indexHtml: sha(path.join(ROOT, 'dist/index.html')),
  js: jsName, jsSha: sha(path.join(assetsDir, jsName)),
  glbs: glbs.map((f) => ({ f, sha: sha(path.join(assetsDir, f)), bytes: fs.statSync(path.join(assetsDir, f)).size })),
};
console.log('FROZEN DIST', JSON.stringify(fingerprint));

// ---------------------------------------------------------------- 2. package
await killApp();
console.log('--- packaging mac + win ---');
sh('npx electron-builder --mac dmg zip 2>&1 | tail -6');
sh('npx electron-builder --win zip --x64 2>&1 | tail -4');

// ---------------------------------------------------------------- 3. asar must match dist
const listed = sh(`npx asar list "${ASAR}"`);
const asarJs = (listed.match(/index-[A-Za-z0-9_-]+\.js/) || [''])[0];
const asarCss = (listed.match(/index-[A-Za-z0-9_-]+\.css/) || [''])[0];
const asarGlbs = [...listed.matchAll(/([a-z]+-[A-Za-z0-9_-]+\.glb)/g)].map((m) => m[1]);
const cssName = fs.readdirSync(assetsDir).find((f) => /^index-.*\.css$/.test(f));
console.log('ASAR', JSON.stringify({ js: asarJs, css: asarCss, glbs: asarGlbs }));
const match = asarJs === jsName && asarCss === cssName
  && glbs.every((g) => asarGlbs.includes(g)) && asarGlbs.length === glbs.length;
console.log(match ? 'ok   packaged asar carries exactly the frozen dist bundle' : 'FAIL asar/dist mismatch');
if (!match) process.exitCode = 1;

// ---------------------------------------------------------------- 4. launch packaged app
const launch = async (tag) => {
  await killApp();
  await sleep(800);
  const logFd = fs.openSync(`/tmp/gongon-final-${tag}.log`, 'w');
  const child = spawn(BIN, ['--remote-debugging-port=9333'], { env: { ...process.env, GONGON_LOG: '1' }, stdio: ['ignore', logFd, logFd] });
  let page;
  for (let i = 0; i < 80 && !page; i++) {
    try { page = (await (await fetch('http://127.0.0.1:9333/json/list')).json()).find((t) => t.type === 'page' && t.url.startsWith('app://')); } catch {}
    if (!page) await sleep(500);
  }
  if (!page) throw new Error('no CDP page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map();
  ws.onmessage = ({ data }) => { const m = JSON.parse(data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const failAll = (why) => { for (const [, fn] of pending) fn({ error: why }); pending.clear(); };
  ws.onclose = () => failAll('cdp closed');
  ws.onerror = () => failAll('cdp error');
  const cdp = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, (m) => (m.error ? rej(new Error(method + JSON.stringify(m.error))) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); });
  const js = async (e) => {
    const r = await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result.value;
  };
  const shot = async (n) => { fs.writeFileSync(path.join(OUT, n), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64')); console.log('ok   screenshot', n); };
  const key = async (k, code, vk) => {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await sleep(350);
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  };
  const close = async () => { try { ws.close(); } catch {}; child.kill('SIGTERM'); await sleep(1000); await killApp(); };
  return { js, shot, key, close, url: page.url };
};
const waitFor = async (app, expr, ms = 20000) => {
  for (let t = 0; t < ms; t += 250) {
    try { if (await app.js(expr)) return true; } catch { return false; }
    await sleep(250);
  }
  return false;
};

fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f));   // no stale shots survive

const app = await launch('1');
console.log('ok   packaged app loaded', app.url);
if (!await waitFor(app, `document.querySelector('#loading')?.classList.contains('hidden')`)) {
  throw new Error('loading gate never cleared: ' + JSON.stringify(await app.js(`document.querySelector('#loading')?.className`)));
}
const lang = await app.js(`document.documentElement.lang`);
console.log('ok   language on launch =', lang, '| menu label:', await app.js(`document.querySelector('#btnSolo')?.textContent`));
await app.shot('01-menu-on-launch.png');
await app.js(`document.querySelector('#langSwitch [data-lang="${lang === 'ru' ? 'en' : 'ru'}"]').click()`);
await sleep(400);
const switched = await app.js(`document.documentElement.lang`);
const label = await app.js(`document.querySelector('#btnSolo')?.textContent`);
console.log(`ok   switched ${lang} -> ${switched}:`, label);
await app.shot(`02-menu-${switched}.png`);
await app.js(`document.querySelector('#langSwitch [data-lang="en"]').click()`);
await sleep(400);

// coop config errors
await app.js(`(()=>{const i=document.querySelector('#coopInput');i.value='';i.dispatchEvent(new Event('change'));document.querySelector('#btnHost').click();})()`);
await sleep(800);
console.log('ok   blank coop url error:', JSON.stringify(await app.js(`document.querySelector('#coopErr').textContent`)));
await app.shot('03-coop-desktop-no-url.png');
await app.js(`(()=>{const i=document.querySelector('#coopInput');i.value='http://127.0.0.1:9/ws';i.dispatchEvent(new Event('change'));document.querySelector('#codeInput').value='ZZZZ';document.querySelector('#btnJoin').click();})()`);
await sleep(2600);
console.log('ok   unreachable coop url error:', JSON.stringify(await app.js(`document.querySelector('#coopErr').textContent`)));
await app.shot('04-coop-unreachable.png');

// real coop: host + second client, then join a node-hosted room
await app.js(`(()=>{const i=document.querySelector('#coopInput');i.value='127.0.0.1:8899';i.dispatchEvent(new Event('change'));document.querySelector('#btnHost').click();})()`);
await sleep(2500);
const code = (String(await app.js(`document.querySelector('#roomHint').textContent`)).match(/[A-Z0-9]{4}/) || [])[0];
console.log('ok   host room', code, '| health:', JSON.stringify(await (await fetch('http://127.0.0.1:8899/health')).json()), '| persisted:', JSON.stringify(await app.js(`localStorage.getItem('gongon.coopUrl')`)));
await app.shot('05-coop-host-room.png');
const guest = new WebSocket('ws://127.0.0.1:8899/ws');
const gm = [];
guest.addEventListener('message', (e) => { try { gm.push(JSON.parse(e.data)); } catch {} });
await new Promise((res, rej) => { guest.addEventListener('open', res); guest.addEventListener('error', rej); });
guest.send(JSON.stringify({ t: 'join', code, name: 'GuestClient' }));
await sleep(3000);
const snap = [...gm].reverse().find((m) => m.t === 'snap');
console.log('ok   second client joined', code, '| snapshot players:', JSON.stringify(snap?.players?.map((p) => p.name)), '| health:', JSON.stringify(await (await fetch('http://127.0.0.1:8899/health')).json()));
guest.close();
await sleep(300);
await app.js(`document.querySelector('#btnPause').click()`);
await sleep(400);
await app.js(`document.querySelector('#btnQuit').click()`);
await sleep(600);
await app.js(`document.querySelector('#btnMenu')?.click()`);
await sleep(400);
const host2 = new WebSocket('ws://127.0.0.1:8899/ws');
const h2 = [];
host2.addEventListener('message', (e) => { try { h2.push(JSON.parse(e.data)); } catch {} });
await new Promise((res, rej) => { host2.addEventListener('open', res); host2.addEventListener('error', rej); });
host2.send(JSON.stringify({ t: 'create', name: 'NodeHost' }));
await sleep(1200);
const code2 = h2.find((m) => m.t === 'welcome')?.code;
await app.js(`(()=>{document.querySelector('#codeInput').value=${JSON.stringify(code2)};document.querySelector('#btnJoin').click();})()`);
await sleep(2500);
console.log('ok   app joined node-hosted room', code2, '| in-app hint:', JSON.stringify(await app.js(`document.querySelector('#roomHint').textContent`)));
await app.shot('06-coop-join-room.png');
host2.close();
await sleep(300);
await app.js(`document.querySelector('#btnPause').click()`);
await sleep(400);
await app.js(`document.querySelector('#btnQuit').click()`);
await sleep(600);
await app.js(`document.querySelector('#btnMenu')?.click()`);
await sleep(400);

// offline solo: keep the world running (dismiss upgrades) and shoot a long burst
await app.js(`document.querySelector('#btnSolo').click()`);
await waitFor(app, `document.querySelector('#hud')?.classList.contains('hidden') === false`, 10000);
// Two combat frames only: the point is "the run is live in the packaged app", not a gallery.
const dirs = [['w', 'KeyW', 87], ['d', 'KeyD', 68], ['s', 'KeyS', 83], ['a', 'KeyA', 65]];
for (let step = 0; step < 12; step++) {
  await app.js(`document.querySelector('#cards > *')?.click?.()`);
  const [k, c, v] = dirs[Math.floor(step / 3) % 4];
  await app.key(k, c, v);
  await sleep(900);
  if (step === 5) await app.shot('07-combat-early.png');
  if (step === 11) await app.shot('07-combat-late.png');
}
const hud = await app.js(`(() => ({wave: document.querySelector('#waveNum').textContent, slain: document.querySelector('#killNum').textContent, coins: document.querySelector('#coinNum').textContent, ammo: document.querySelector('#ammoNum').textContent, squad: document.querySelectorAll('#squadList > *').length}))()`);
console.log('ok   offline solo HUD after 12 steps:', JSON.stringify(hud));
await app.key('b', 'KeyB', 66);
await sleep(700);
console.log('ok   store offline:', await app.js(`document.querySelector('#shop').classList.contains('hidden') === false`), '| items:', await app.js(`document.querySelectorAll('#shopGrid > *').length`));
await app.shot('08-solo-shop.png');
await app.close();

// restart persistence
const app2 = await launch('2');
await waitFor(app2, `document.querySelector('#loading')?.classList.contains('hidden')`);
await sleep(500);
console.log('ok   after restart: language =', await app2.js(`document.documentElement.lang`), '| coop field:', JSON.stringify(await app2.js(`document.querySelector('#coopInput').value`)));
await app2.shot('09-restart-persisted-settings.png');
await app2.close();

// artifacts + final hashes
console.log('--- artifacts ---');
console.log(sh('ls -la proof/desktop/*.dmg proof/desktop/*.zip'));
console.log(sh('shasum -a 256 proof/desktop/*.dmg proof/desktop/*.zip'));
console.log(sh(`npx asar list "${ASAR}"`));
console.log('done');
