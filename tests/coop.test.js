// Two headless clients prove the coop server: same room, shared enemies, both move.
// Run: node tests/coop.test.js   (server must be listening on PORT, default 8787)
import WebSocket from 'ws';

const URL = process.env.WS || 'ws://127.0.0.1:8787/ws';
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const state = { ws, name, snaps: [], welcome: null, id: null, events: [] };
    clients.push(state);
    ws.on('open', () => resolve(state));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'welcome') { state.welcome = m; state.id = m.you; }
      else if (m.t === 'snap') { state.snaps.push(m); state.events.push(...(m.ev || [])); }
      else if (m.t === 'error') { state.error = m.msg; }
    });
  });
}

const clients = [];
const fail = (msg) => {
  console.error(`FAIL ${msg}`);
  for (const c of clients) { try { c.ws.terminate(); } catch {} }
  process.exit(1);
};
// hard bound so a stalled server can never hang the check
setTimeout(() => fail('timeout: coop proof exceeded 45s'), 45000).unref();

const host = await connect('Host');
host.ws.send(JSON.stringify({ t: 'create', name: 'Host' }));
await sleep(400);
if (!host.welcome) fail('host got no welcome');
const code = host.welcome.code;
log(`ok   room created ${code}`);

const guest = await connect('Guest');
guest.ws.send(JSON.stringify({ t: 'join', code, name: 'Guest' }));
await sleep(400);
if (!guest.welcome) fail(`guest join failed: ${guest.error || 'no welcome'}`);
if (guest.welcome.code !== code) fail('guest landed in a different room');
log(`ok   guest joined same room (${guest.id})`);

// walk host right, guest left
const t0 = Date.now();
const tick = setInterval(() => {
  host.ws.send(JSON.stringify({ t: 'input', x: 1, z: 0 }));
  guest.ws.send(JSON.stringify({ t: 'input', x: -1, z: 0 }));
}, 50);

await sleep(6500);
clearInterval(tick);

const last = host.snaps.at(-1);
if (!last) fail('no snapshots received');
const players = last.players;
if (players.length !== 2) fail(`expected 2 players, got ${players.length}`);
log(`ok   shared snapshot has ${players.length} players`);

const h = players.find((p) => p.id === host.id);
const g = players.find((p) => p.id === guest.id);
if (!h || !g) fail('missing player in snapshot');
if (!(h.x > 0.5)) fail(`host did not move right (x=${h.x})`);
if (!(g.x < -0.5)) fail(`guest did not move left (x=${g.x})`);
log(`ok   independent movement: host x=${h.x}, guest x=${g.x}`);

const enemiesSeen = Math.max(...host.snaps.map((s) => s.enemies.length));
if (enemiesSeen < 3) fail(`shared enemies not spawning (max ${enemiesSeen})`);
log(`ok   shared enemies spawned (peak ${enemiesSeen})`);

const guestSawEnemies = Math.max(...guest.snaps.map((s) => s.enemies.length));
if (guestSawEnemies < 3) fail('guest does not see the horde');
log(`ok   guest sees same horde (peak ${guestSawEnemies})`);

// hostile input: absurd vector must be clamped
host.ws.send(JSON.stringify({ t: 'input', x: 9999, z: 9999 }));
await sleep(300);
const after = host.snaps.at(-1).players.find((p) => p.id === host.id);
if (Math.abs(after.x) > 44 || Math.abs(after.z) > 44) fail('client escaped the arena');
log('ok   out-of-range input clamped server-side');

// invalid pick/buy must be rejected without killing the authoritative room:
// the room has to keep ticking, so snapshot count must keep growing.
const before = host.snaps.length;
host.ws.send(JSON.stringify({ t: 'pick', id: 'not-real' }));
host.ws.send(JSON.stringify({ t: 'buy', id: 'heal' }));
host.ws.send(JSON.stringify({ t: 'buy', id: 'weapon:railgun' }));
host.ws.send(JSON.stringify({ t: 'pick', id: null }));
host.ws.send(JSON.stringify({ t: 'input', x: 'NaN', z: {} }));
await sleep(1200);
const grew = host.snaps.length - before;
if (grew < 8) fail(`room stopped ticking after bad messages (${grew} new snapshots)`);
const still = host.snaps.at(-1);
if (!still.players.some((p) => p.id === host.id)) fail('host vanished from room');
const hp = still.players.find((p) => p.id === host.id).hp;
if (hp <= 0) fail('invalid messages damaged the player');
log(`ok   invalid pick/buy ignored, room still ticking (${grew} new snapshots)`);

log(`\ncoop proof passed in ${Date.now() - t0}ms`);
host.ws.close(); guest.ws.close();
for (const c of clients) { try { c.ws.terminate(); } catch {} }
process.exit(0);
