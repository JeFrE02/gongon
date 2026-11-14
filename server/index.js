// Authoritative coop server: static client hosting + WebSocket rooms.
// Run: node server/index.js   (PORT=8787)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { World, TICK, MAX_PLAYERS } from '../shared/sim.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: [...rooms.values()].reduce((n, r) => n + r.clients.size, 0) }));
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(DIST, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const index = path.join(DIST, 'index.html');
    if (fs.existsSync(index)) {
      res.writeHead(200, { 'content-type': MIME['.html'] });
      return res.end(fs.readFileSync(index));
    }
    res.writeHead(503, { 'content-type': 'text/plain' });
    return res.end('Client not built. Run: npm run build');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new Map(); // code -> { world, clients:Set<ws>, seed, createdAt }
let nextSeed = 1;

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return 'R' + Date.now().toString(36).slice(-3).toUpperCase();
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const c of room.clients) if (c.readyState === 1) c.send(data);
}

wss.on('connection', (ws) => {
  ws.playerId = null;
  ws.room = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString().slice(0, 4000)); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'create' || m.t === 'join') {
      if (ws.room) return;
      let code = m.t === 'create' ? makeCode() : String(m.code || '').toUpperCase().slice(0, 4);
      if (m.t === 'join' && !rooms.has(code)) return send(ws, { t: 'error', msg: 'Room not found' });
      let room = rooms.get(code);
      if (!room) {
        room = { world: new World(nextSeed++, { solo: false }), clients: new Set(), seed: nextSeed, emptyAt: 0 };
        rooms.set(code, room);
      }
      if (room.clients.size >= MAX_PLAYERS) return send(ws, { t: 'error', msg: 'Room is full (4)' });
      const id = 'p' + Math.random().toString(36).slice(2, 8);
      const p = room.world.addPlayer(id, m.name, m.loadout);
      ws.playerId = id;
      ws.room = room;
      room.clients.add(ws);
      room.emptyAt = 0;
      send(ws, {
        t: 'welcome', code, you: id, seed: room.world.seed,
        players: [...room.world.players.values()].map((q) => ({ id: q.id, name: q.name })),
      });
      broadcast(room, { t: 'join', id, name: p.name, code });
      console.log(`[room ${code}] +${p.name} (${room.clients.size})`);
      return;
    }

    const room = ws.room;
    if (!room) return;
    if (m.t === 'input') room.world.setInput(ws.playerId, m);
    else if (m.t === 'pick') room.world.pick(ws.playerId, String(m.id || ''));
    else if (m.t === 'buy') room.world.buy(ws.playerId, String(m.id || ''));
    else if (m.t === 'ping') send(ws, { t: 'pong', ts: m.ts });
    else if (m.t === 'leave') ws.close();
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    room.clients.delete(ws);
    room.world.removePlayer(ws.playerId);
    broadcast(room, { t: 'leave', id: ws.playerId });
    console.log(`[room] -${ws.playerId} (${room.clients.size})`);
    if (room.clients.size === 0) room.emptyAt = Date.now();
  });
});

// fixed-step authority for every room
let acc = 0;
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.2, (now - last) / 1000);
  last = now;
  acc += dt;
  let steps = 0;
  while (acc >= TICK && steps < 5) {
    acc -= TICK;
    steps++;
    for (const [code, room] of rooms) {
      if (!room.clients.size) continue;
      room.world.step(TICK);
      room.pending = true;
      if (room.world.phase === 'over') {
        broadcast(room, { t: 'over', wave: room.world.wave, kills: room.world.kills });
        rooms.delete(code);
        for (const c of room.clients) { c.room = null; c.close(); }
      }
    }
  }
  for (const [code, room] of rooms) {
    if (room.pending && room.clients.size) {
      room.pending = false;
      const snap = room.world.snapshot();
      const evs = room.world.drainEvents();
      broadcast(room, evs.length ? { ...snap, ev: evs } : snap);
    }
    if (!room.clients.size && room.emptyAt && now - room.emptyAt > 60000) {
      rooms.delete(code);
      console.log(`[room ${code}] expired`);
    }
  }
}, 1000 / 30);

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);

server.listen(PORT, HOST, () => {
  console.log(`gongon server http://localhost:${PORT}  (LAN: http://<your-ip>:${PORT})`);
});
