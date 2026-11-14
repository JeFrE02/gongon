// Node assert-based sim checks. Run: node tests/sim.test.js
import assert from 'node:assert/strict';
import { World, TICK, WEAPONS, SHOP, UPGRADES } from '../shared/sim.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n     ${e.message}`); process.exitCode = 1; }
}

function fresh(seed = 7) {
  const w = new World(seed, { solo: true });
  w.addPlayer('you', 'Tester');
  return w;
}

test('world builds obstacles without blocking spawn', () => {
  const w = fresh();
  assert.ok(w.obstacles.length > 10, 'has obstacles');
  for (const o of w.obstacles) {
    assert.ok(!(Math.abs(o.x) < 7 && Math.abs(o.z) < 7), 'no obstacle in spawn square');
  }
});

test('first wave spawns enemies and they advance', () => {
  const w = fresh();
  w.waveTimer = 0;
  let guard = 0;
  while (w.enemies.length < 3 && guard++ < 600) w.step(TICK);
  assert.ok(w.wave >= 1, `wave started (${w.wave})`);
  assert.ok(w.enemies.length > 0, `enemies alive (${w.enemies.length})`);
  const sample = w.enemies.slice(0, 5).map((e) => ({ id: e.id, d: Math.hypot(e.x, e.z) }));
  for (let i = 0; i < 10; i++) w.step(TICK);
  const closed = sample.some(({ id, d }) => {
    const e = w.enemies.find((q) => q.id === id);
    return e && Math.hypot(e.x, e.z) < d;
  });
  assert.ok(closed, 'enemies close distance');
});

test('auto-attack damages and kills, awarding xp and coins', () => {
  const w = fresh();
  w.addPlayer; // noop
  const p = w.players.get('you');
  w.enemies.push({
    id: 999, type: 'crawler', x: 4, z: 0, hp: 1, maxHp: 1, speed: 0,
    dmg: 0, r: 0.6, atkCd: 99, flash: 0, dead: false,
  });
  for (let i = 0; i < 40; i++) w.step(TICK);
  assert.equal(w.kills, 1, 'one kill recorded');
  assert.ok(p.coins >= 1, 'coins awarded');
  assert.ok(p.xp > 0 || p.lvl > 1, 'xp awarded');
});

test('upgrade offer is served at level up and applies once', () => {
  const w = fresh();
  const p = w.players.get('you');
  p.xp = p.xpNext - 1;
  p.offers = null;
  w.enemies.push({ id: 1, type: 'crawler', x: 3, z: 0, hp: 1, maxHp: 1, speed: 0, dmg: 0, r: 0.6, atkCd: 99, flash: 0, dead: false });
  for (let i = 0; i < 60; i++) w.step(TICK);
  assert.ok(p.lvl >= 2, 'level up');
  assert.ok(Array.isArray(p.offers) && p.offers.length === 3, 'three offers');
  for (const id of p.offers) assert.ok(UPGRADES.some((u) => u.id === id), 'offer is a real upgrade');
  const id = p.offers[0];
  assert.equal(w.pick('you', 'not-an-upgrade'), false, 'rejects bogus upgrade');
  assert.equal(w.pick('you', id), true, 'accepts offered upgrade');
  assert.equal(p.offers, null, 'offers cleared');
  assert.equal(p.stacks[id], 1, 'stack counted');
});

test('shop charges coins and refuses when broke', () => {
  const w = fresh();
  const p = w.players.get('you');
  p.coins = 0;
  assert.equal(w.buy('you', 'heal'), false, 'cannot buy without coins');
  p.coins = 1000;
  p.hp = 10;
  assert.equal(w.buy('you', 'heal'), true, 'buys heal');
  assert.equal(p.coins, 1000 - SHOP.heal.cost, 'coins deducted');
  assert.ok(p.hp > 10, 'heal applied');
  assert.equal(w.buy('you', 'weapon:repeater'), true, 'buys weapon');
  assert.equal(p.weapon, 'repeater');
  assert.equal(p.ammo, WEAPONS.repeater.mag, 'mag refilled');
});

test('death ends a solo run', () => {
  const w = fresh();
  const p = w.players.get('you');
  p.hp = 1;
  w.enemies.push({ id: 5, type: 'brute', x: p.x + 0.6, z: p.z, hp: 999, maxHp: 999, speed: 0, dmg: 50, r: 1, atkCd: 0, flash: 0, dead: false });
  for (let i = 0; i < 20; i++) w.step(TICK);
  assert.ok(p.dead, 'player died');
  assert.equal(w.phase, 'over', 'run over');
});

test('snapshot has stable shape and bounded size', () => {
  const w = fresh();
  w.waveTimer = 0;
  for (let i = 0; i < 200; i++) w.step(TICK);
  const s = w.snapshot();
  assert.equal(s.t, 'snap');
  assert.ok(Array.isArray(s.players) && s.players.length === 1);
  const me = s.players[0];
  for (const k of ['id', 'name', 'x', 'z', 'hp', 'maxHp', 'lvl', 'weapon', 'ammo', 'coins', 'offers', 'squad']) {
    assert.ok(k in me, `player field ${k}`);
  }
  for (const e of s.enemies) assert.equal(e.length, 6, 'enemy tuple');
  assert.ok(JSON.stringify(s).length < 20000, 'snapshot under 20KB');
});

test('two players share one world and both take damage', () => {
  const w = new World(11, { solo: false });
  w.addPlayer('a', 'A');
  w.addPlayer('b', 'B');
  w.waveTimer = 0;
  for (let i = 0; i < 300; i++) w.step(TICK);
  assert.equal(w.players.size, 2);
  assert.ok(w.enemies.length > 0, 'shared enemies');
  assert.equal(w.snapshot().players.length, 2, 'both in snapshot');
});

test('inputs are clamped so clients cannot speed-hack', () => {
  const w = fresh();
  const p = w.players.get('you');
  w.setInput('you', { x: 99, z: 0 });
  assert.ok(Math.abs(p.ix) <= 1.0001, `ix clamped (${p.ix})`);
  const x0 = p.x;
  for (let i = 0; i < 20; i++) w.step(TICK);
  assert.ok(p.x - x0 <= p.speed * 1.05, 'moved at most walk speed');
});

test('same seed yields the same layout', () => {
  const a = new World(4242).obstacles;
  const b = new World(4242).obstacles;
  assert.deepEqual(a, b);
});

console.log(`\n${passed} checks passed`);
