// Authoritative game simulation. Pure JS, no DOM, no node APIs.
// Used by the server (authority) and by the client for solo play + local prediction.

export const TICK = 1 / 20;
export const ARENA = 30; // half-extent of the square arena
export const MAX_PLAYERS = 4;
export const MAX_ENEMIES = 80;

export const ENEMY_TYPES = {
  crawler: { hp: 26, speed: 5.2, dmg: 9, r: 0.62, xp: 3, coins: 1, color: 0xff5f6d },
  brute: { hp: 78, speed: 2.9, dmg: 18, r: 1.05, xp: 9, coins: 3, color: 0xff8a3d },
  boss: { hp: 900, speed: 2.3, dmg: 30, r: 2.2, xp: 90, coins: 40, color: 0xc46bff },
};

export const WEAPONS = {
  bow: { name: 'Longbow', dmg: 15, cd: 0.42, speed: 32, pierce: 1, mag: 12, reload: 1.0, spread: 0.02, count: 1, tint: 0x8ef5c8 },
  repeater: { name: 'Repeater', dmg: 7, cd: 0.14, speed: 40, pierce: 0, mag: 34, reload: 1.5, spread: 0.06, count: 1, tint: 0x7fd8ff },
  scatter: { name: 'Scatterbow', dmg: 8, cd: 0.62, speed: 27, pierce: 0, mag: 9, reload: 1.3, spread: 0.2, count: 3, tint: 0xffd166 },
};

export const UPGRADES = [
  { id: 'dmg', name: 'Keen Edge', desc: '+18% damage', max: 6 },
  { id: 'rate', name: 'Quick Draw', desc: '+14% fire rate', max: 6 },
  { id: 'multi', name: 'Split Shot', desc: '+1 arrow per shot', max: 2 },
  { id: 'pierce', name: 'Bodkin', desc: 'Arrows pierce +1', max: 3 },
  { id: 'speed', name: 'Fleet Foot', desc: '+9% move speed', max: 4 },
  { id: 'hp', name: 'Thick Hide', desc: '+22 max HP, heal 22', max: 5 },
  { id: 'magnet', name: 'Soul Pull', desc: '+1.6 pickup range', max: 3 },
  { id: 'squad', name: 'Rally', desc: '+1 squad spirit', max: 2 },
  { id: 'crit', name: 'Deadeye', desc: '+12% crit chance', max: 3 },
  { id: 'reload', name: 'Fast Hands', desc: '-22% reload time', max: 3 },
];

// Outpost store. Coins are earned in-run only; nothing here is sold for money.
export const SHOP = {
  heal: { name: 'Field Dressing', desc: 'Restore 45 HP now', cost: 30 },
  maxhp: { name: 'Reinforced Hide', desc: '+20 max HP', cost: 55 },
  squad: { name: 'Rally Horn', desc: '+1 squad spirit', cost: 70 },
  dmg: { name: 'Whetstone', desc: '+12% damage', cost: 85 },
  speed: { name: 'Scout Boots', desc: '+8% move speed', cost: 65 },
  reload: { name: 'Bandolier', desc: '-18% reload time', cost: 50 },
  'weapon:repeater': { name: 'Repeater', desc: 'Fast, low damage, big mag', cost: 110 },
  'weapon:scatter': { name: 'Scatterbow', desc: 'Three arrows, close range', cost: 110 },
};

const BASE = {
  hp: 100, speed: 8.4, squad: 2, pickup: 2.6, crit: 0.05,
  dmgMul: 1, rateMul: 1, reloadMul: 1,
};

function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dist2 = (ax, az, bx, bz) => (ax - bx) * (ax - bx) + (az - bz) * (az - bz);

export class World {
  constructor(seed = 1, opts = {}) {
    this.seed = seed >>> 0;
    this.solo = !!opts.solo;
    this.rng = makeRng(seed);
    this.time = 0;
    this.tick = 0;
    this.phase = 'playing';
    this.wave = 0;
    this.waveTimer = 3;
    this.breakTimer = 0;
    this.spawnQueue = [];
    this.spawnTimer = 0;
    this.players = new Map();
    this.enemies = [];
    this.bullets = [];
    this.orbs = [];
    this.pickups = [];
    this.events = [];
    this.nextId = 1;
    this.kills = 0;
    this.obstacles = this._genObstacles();
  }

  _genObstacles() {
    const out = [];
    const r = this.rng;
    for (let i = 0; i < 52; i++) {
      const a = r() * Math.PI * 2;
      const rad = 12 + r() * (ARENA - 13);
      const x = Math.cos(a) * rad;
      const z = Math.sin(a) * rad;
      if (Math.abs(x) < 7 && Math.abs(z) < 7) continue; // keep spawn clear
      out.push({ x, z, r: 1.0 + r() * 1.9, kind: r() < 0.72 ? 'tree' : 'rock' });
    }
    return out;
  }

  // ---- players -------------------------------------------------------------
  addPlayer(id, name, loadout = {}) {
    const meta = loadout || {};
    const maxHp = BASE.hp + (meta.hp || 0);
    const w = WEAPONS[meta.weapon] ? meta.weapon : 'bow';
    const p = {
      id,
      name: (name || 'Ranger').slice(0, 14),
      x: 0, z: 0, ix: 0, iz: 0,
      hp: maxHp, maxHp,
      speed: BASE.speed * (1 + (meta.speed || 0) / 100),
      dmgMul: BASE.dmgMul * (1 + (meta.dmg || 0) / 100),
      rateMul: BASE.rateMul,
      reloadMul: BASE.reloadMul,
      crit: BASE.crit + (meta.crit || 0) / 100,
      pickup: BASE.pickup,
      weapon: w,
      ammo: WEAPONS[w].mag,
      reloadT: 0,
      cd: 0,
      dashT: 0, dashCd: 0,
      hurtCd: 0,
      lvl: 1, xp: 0, xpNext: 10,
      coins: 0,
      kills: 0,
      dead: false, respawnT: 0,
      offers: null,
      stacks: {},
      squad: [],
      wantReload: false,
      spawn: { x: (this.players.size % 2) * 2.2 - 1.1, z: 0 },
    };
    p.x = p.spawn.x;
    p.z = p.spawn.z;
    const n = BASE.squad + (meta.squad || 0);
    for (let i = 0; i < n; i++) p.squad.push({ a: (i / n) * Math.PI * 2, cd: this.rng() * 0.6 });
    this.players.set(id, p);
    return p;
  }

  removePlayer(id) { this.players.delete(id); }

  setInput(id, input) {
    const p = this.players.get(id);
    if (!p || p.dead) return;
    let x = Number(input.x) || 0;
    let z = Number(input.z) || 0;
    const m = Math.hypot(x, z);
    if (m > 1) { x /= m; z /= m; }
    p.ix = x; p.iz = z;
    if (input.dash) this._dash(p);
    if (input.reload) p.wantReload = true;
  }

  _dash(p) {
    if (p.dashCd > 0 || p.dashT > 0) return;
    p.dashT = 0.18; p.dashCd = 2.4; p.hurtCd = Math.max(p.hurtCd, 0.22);
    this._ev({ kind: 'dash', id: p.id, x: p.x, z: p.z });
  }

  pick(id, upgradeId) {
    const p = this.players.get(id);
    if (!p || !p.offers || !p.offers.includes(upgradeId)) return false;
    const def = UPGRADES.find((u) => u.id === upgradeId);
    if (!def) return false;
    p.stacks[upgradeId] = (p.stacks[upgradeId] || 0) + 1;
    switch (upgradeId) {
      case 'dmg': p.dmgMul *= 1.18; break;
      case 'rate': p.rateMul *= 1.14; break;
      case 'multi': break; // read at fire time
      case 'pierce': break;
      case 'speed': p.speed *= 1.09; break;
      case 'hp': p.maxHp += 22; p.hp = Math.min(p.maxHp, p.hp + 22); break;
      case 'magnet': p.pickup += 1.6; break;
      case 'squad': p.squad.push({ a: this.rng() * 6.28, cd: 0.3 }); break;
      case 'crit': p.crit += 0.12; break;
      case 'reload': p.reloadMul *= 0.78; break;
    }
    p.offers = null;
    this._ev({ kind: 'upgrade', id: p.id, upgradeId });
    return true;
  }

  buy(id, itemId) {
    const p = this.players.get(id);
    const item = SHOP[itemId];
    if (!p || !item || p.dead || p.coins < item.cost) return false;
    if (itemId.startsWith('weapon:')) {
      const w = itemId.slice(7);
      if (!WEAPONS[w] || p.weapon === w) return false;
      p.weapon = w; p.ammo = WEAPONS[w].mag; p.reloadT = 0;
    } else if (itemId === 'heal') {
      if (p.hp >= p.maxHp) return false;
      p.hp = Math.min(p.maxHp, p.hp + 45);
    } else if (itemId === 'maxhp') { p.maxHp += 20; p.hp += 20; }
    else if (itemId === 'squad') { p.squad.push({ a: this.rng() * 6.28, cd: 0.3 }); }
    else if (itemId === 'dmg') p.dmgMul *= 1.12;
    else if (itemId === 'speed') p.speed *= 1.08;
    else if (itemId === 'reload') p.reloadMul *= 0.82;
    p.coins -= item.cost;
    this._ev({ kind: 'buy', id: p.id, itemId });
    return true;
  }

  _offer(p) {
    const pool = UPGRADES.filter((u) => (p.stacks[u.id] || 0) < u.max);
    const out = [];
    while (out.length < 3 && pool.length) {
      const i = Math.floor(this.rng() * pool.length);
      out.push(pool.splice(i, 1)[0].id);
    }
    p.offers = out.length ? out : null;
  }

  _grantXp(p, amount) {
    p.xp += amount;
    while (p.xp >= p.xpNext) {
      p.xp -= p.xpNext;
      p.lvl++;
      p.xpNext = Math.round(10 * Math.pow(p.lvl, 1.28));
      if (!p.offers) this._offer(p);
      this._ev({ kind: 'level', id: p.id, x: p.x, z: p.z });
    }
  }

  _hurt(p, dmg) {
    if (p.dead || p.hurtCd > 0) return;
    p.hp -= dmg;
    p.hurtCd = 0.45;
    this._ev({ kind: 'hurt', id: p.id, x: p.x, z: p.z, amount: dmg });
    if (p.hp <= 0) {
      p.hp = 0;
      p.dead = true;
      p.respawnT = 6;
      p.offers = null;
      p.ix = p.iz = 0;
      this._ev({ kind: 'death', id: p.id, x: p.x, z: p.z });
    }
  }

  _player(p, dt) {
    if (p.dead) {
      if (this.solo) return;
      p.respawnT -= dt;
      if (p.respawnT <= 0 && this.players.size > 1) {
        p.dead = false;
        p.hp = Math.round(p.maxHp * 0.6);
        p.x = p.spawn.x; p.z = p.spawn.z;
        p.ammo = WEAPONS[p.weapon].mag; p.reloadT = 0;
        this._ev({ kind: 'respawn', id: p.id, x: p.x, z: p.z });
      }
      return;
    }
    p.hurtCd = Math.max(0, p.hurtCd - dt);
    p.dashCd = Math.max(0, p.dashCd - dt);
    const dashing = p.dashT > 0;
    if (dashing) p.dashT -= dt;
    const sp = p.speed * (dashing ? 3.1 : 1);
    p.x += p.ix * sp * dt;
    p.z += p.iz * sp * dt;
    const lim = ARENA - 1.2;
    p.x = Math.max(-lim, Math.min(lim, p.x));
    p.z = Math.max(-lim, Math.min(lim, p.z));
    for (const o of this.obstacles) {
      const rr = o.r + 0.55;
      const d = Math.hypot(p.x - o.x, p.z - o.z);
      if (d < rr && d > 1e-4) {
        p.x = o.x + ((p.x - o.x) / d) * rr;
        p.z = o.z + ((p.z - o.z) / d) * rr;
      }
    }
    // squad soldiers hold a V formation behind the hero, facing the fight
    if (Math.abs(p.ix) + Math.abs(p.iz) > 0.1) {
      const m = Math.hypot(p.ix, p.iz);
      p.fx = p.ix / m; p.fz = p.iz / m;
    }
    const fx = p.fx ?? 0, fz = p.fz ?? 1;
    const px = -fz, pz = fx;
    for (let i = 0; i < p.squad.length; i++) {
      const s = p.squad[i];
      const row = Math.floor(i / 2) + 1;
      const side = i % 2 === 0 ? -1 : 1;
      const lat = side * (0.95 + row * 0.55);
      const back = 1.75 + row * 0.95;
      const tx = p.x - fx * back + px * lat;
      const tz = p.z - fz * back + pz * lat;
      const k = Math.min(1, dt * 7);
      s.x = (s.x ?? tx) + (tx - (s.x ?? tx)) * k;
      s.z = (s.z ?? tz) + (tz - (s.z ?? tz)) * k;
      s.aim = Math.atan2(fx, fz);
      s.cd = Math.max(0, s.cd - dt);
    }
    // weapon
    const W = WEAPONS[p.weapon];
    if (p.wantReload && p.reloadT <= 0 && p.ammo < W.mag) { p.wantReload = false; p.reloadT = W.reload * p.reloadMul; }
    if (p.reloadT > 0) {
      p.reloadT -= dt;
      if (p.reloadT <= 0) { p.ammo = W.mag; this._ev({ kind: 'reload', id: p.id }); }
    }
    p.cd = Math.max(0, p.cd - dt);
    if (p.cd <= 0 && p.reloadT <= 0) {
      const target = this._nearestEnemy(p.x, p.z, 20);
      if (target) {
        this._fire(p, target, 1);
        p.cd = W.cd / p.rateMul;
        p.ammo--;
        if (p.ammo <= 0) p.reloadT = W.reload * p.reloadMul;
      }
    }
    // squad auto-fire
    for (const s of p.squad) {
      if (s.cd > 0) continue;
      const t = this._nearestEnemy(s.x, s.z, 16);
      if (t) {
        s.aim = Math.atan2(t.z - s.z, t.x - s.x);
        this._fire(p, t, 0.5, s.x, s.z);
        this._ev({ kind: 'squadshoot', id: p.id, x: s.x, z: s.z });
        s.cd = 1.05 / p.rateMul;
      }
    }
  }

  _nearestEnemy(x, z, range) {
    let best = null, bd = range * range;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const d = dist2(x, z, e.x, e.z);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  _fire(p, target, scale, ox = p.x, oz = p.z) {
    const W = WEAPONS[p.weapon];
    const base = Math.atan2(target.z - oz, target.x - ox);
    const count = W.count + (p.stacks.multi || 0);
    const pierce = W.pierce + (p.stacks.pierce || 0);
    for (let i = 0; i < count; i++) {
      const off = (i - (count - 1) / 2) * W.spread;
      const a = base + off + (this.rng() - 0.5) * 0.02;
      const crit = this.rng() < p.crit;
      this.bullets.push({
        id: this.nextId++, owner: p.id,
        x: ox, z: oz,
        vx: Math.cos(a) * W.speed, vz: Math.sin(a) * W.speed,
        dmg: W.dmg * p.dmgMul * scale * (crit ? 2 : 1),
        pierce, life: 1.1, hits: [], tint: W.tint,
      });
    }
    this._ev({ kind: 'shoot', id: p.id, weapon: p.weapon, x: ox, z: oz });
  }

  // ---- bullets -------------------------------------------------------------
  _bullets(dt) {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.x += b.vx * dt; b.z += b.vz * dt;
      b.life -= dt;
      let gone = b.life <= 0 || Math.abs(b.x) > ARENA + 2 || Math.abs(b.z) > ARENA + 2;
      if (!gone) {
        for (const o of this.obstacles) {
          if (o.kind === 'rock' && dist2(b.x, b.z, o.x, o.z) < o.r * o.r) { gone = true; break; }
        }
      }
      if (!gone) {
        for (const e of this.enemies) {
          if (e.dead || b.hits.includes(e.id)) continue;
          const rr = e.r + 0.28;
          if (dist2(b.x, b.z, e.x, e.z) < rr * rr) {
            this._damageEnemy(e, b.dmg, b.owner);
            b.hits.push(e.id);
            if (b.pierce <= 0) { gone = true; break; }
            b.pierce--;
          }
        }
      }
      if (gone) this.bullets.splice(i, 1);
    }
  }

  _damageEnemy(e, dmg, ownerId) {
    e.hp -= dmg;
    e.flash = 0.12;
    this._ev({ kind: 'hit', x: e.x, z: e.z, amount: Math.round(dmg) });
    if (e.hp > 0) return;
    e.dead = true;
    this.kills++;
    const def = ENEMY_TYPES[e.type];
    const p = this.players.get(ownerId);
    if (p && !p.dead) {
      p.kills++;
      p.coins += def.coins;
      this._grantXp(p, def.xp);
      this._ev({ kind: 'coin', id: p.id, amount: def.coins });
    }
    this.orbs.push({ id: this.nextId++, x: e.x, z: e.z, val: def.xp, vx: 0, vz: 0 });
    if (e.type === 'boss') {
      for (let i = 0; i < 6; i++) this.pickups.push({ id: this.nextId++, x: e.x + (this.rng() - 0.5) * 4, z: e.z + (this.rng() - 0.5) * 4, kind: 'coin', amount: 12 });
      this._ev({ kind: 'bossdown', x: e.x, z: e.z });
    }
    this._ev({ kind: 'kill', x: e.x, z: e.z, type: e.type });
  }

  // ---- enemies -------------------------------------------------------------
  _spawnEnemy(type) {
    if (this.enemies.length >= MAX_ENEMIES) { this.spawnQueue.unshift(type); return; }
    const a = this.rng() * Math.PI * 2;
    const rad = Math.min(ARENA - 2, 15 + this.rng() * 8);
    const def = ENEMY_TYPES[type];
    const scale = 1 + (this.wave - 1) * 0.2;
    this.enemies.push({
      id: this.nextId++, type,
      x: Math.cos(a) * rad, z: Math.sin(a) * rad,
      hp: def.hp * scale, maxHp: def.hp * scale,
      speed: def.speed * (1 + (this.wave - 1) * 0.02),
      dmg: def.dmg * (1 + (this.wave - 1) * 0.06),
      r: def.r, atkCd: 0, flash: 0, dead: false,
    });
  }

  _enemies(dt) {
    const alive = [...this.players.values()].filter((p) => !p.dead);
    for (const e of this.enemies) {
      e.flash = Math.max(0, e.flash - dt);
      e.atkCd = Math.max(0, e.atkCd - dt);
      if (!alive.length) continue;
      let t = alive[0], bd = Infinity;
      for (const p of alive) {
        const d = dist2(e.x, e.z, p.x, p.z);
        if (d < bd) { bd = d; t = p; }
      }
      const dx = t.x - e.x, dz = t.z - e.z;
      const d = Math.hypot(dx, dz) || 1;
      if (d > e.r + 0.55) {
        e.x += (dx / d) * e.speed * dt;
        e.z += (dz / d) * e.speed * dt;
        for (const o of this.obstacles) {
          const rr = o.r + e.r * 0.6;
          const dd = Math.hypot(e.x - o.x, e.z - o.z);
          if (dd < rr && dd > 1e-4) {
            e.x = o.x + ((e.x - o.x) / dd) * rr;
            e.z = o.z + ((e.z - o.z) / dd) * rr;
          }
        }
      }
      if (e.atkCd <= 0 && d < e.r + 0.9) {
        e.atkCd = 0.85;
        this._hurt(t, e.dmg);
      }
    }
    if (this.enemies.some((e) => e.dead)) this.enemies = this.enemies.filter((e) => !e.dead);
  }

  // ---- pickups -------------------------------------------------------------
  _orbs(dt) {
    const players = [...this.players.values()].filter((p) => !p.dead);
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const o = this.orbs[i];
      let taken = false;
      for (const p of players) {
        const d = Math.hypot(o.x - p.x, o.z - p.z);
        if (d < p.pickup + 0.4) {
          this._grantXp(p, o.val);
          this._ev({ kind: 'orb', id: p.id, x: o.x, z: o.z });
          taken = true;
          break;
        }
        if (d < 9) {
          const s = 12 * dt;
          o.x += ((p.x - o.x) / d) * s;
          o.z += ((p.z - o.z) / d) * s;
        }
      }
      if (taken) this.orbs.splice(i, 1);
    }
  }

  _pickups(dt) {
    const players = [...this.players.values()].filter((p) => !p.dead);
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const k = this.pickups[i];
      for (const p of players) {
        if (dist2(k.x, k.z, p.x, p.z) < 1.9) {
          if (k.kind === 'coin') {
            p.coins += k.amount;
            this._ev({ kind: 'coin', id: p.id, amount: k.amount });
          } else if (k.kind === 'heal') {
            p.hp = Math.min(p.maxHp, p.hp + 35);
            this._ev({ kind: 'heal', id: p.id, x: p.x, z: p.z });
          } else if (k.kind === 'weapon') {
            p.weapon = k.weapon;
            p.ammo = WEAPONS[k.weapon].mag;
            p.reloadT = 0;
            this._ev({ kind: 'weapon', id: p.id, weapon: k.weapon });
          }
          this.pickups.splice(i, 1);
          break;
        }
      }
    }
  }

  _dropPickups() {
    const kinds = ['coin', 'heal', 'weapon', 'coin'];
    for (let i = 0; i < 3; i++) {
      const a = this.rng() * Math.PI * 2, r = 8 + this.rng() * 26;
      const kind = kinds[Math.floor(this.rng() * kinds.length)];
      const wkeys = Object.keys(WEAPONS);
      this.pickups.push({
        id: this.nextId++,
        x: Math.cos(a) * r, z: Math.sin(a) * r,
        kind, amount: 8 + this.wave * 2,
        weapon: wkeys[Math.floor(this.rng() * wkeys.length)],
      });
    }
  }

  _startWave() {
    this.wave++;
    const boss = this.wave % 4 === 0;
    const n = Math.min(46, 5 + this.wave * 3);
    const q = [];
    if (boss) q.push('boss');
    for (let i = 0; i < n; i++) q.push(this.wave > 2 && this.rng() < 0.28 ? 'brute' : 'crawler');
    this.spawnQueue = q;
    this.spawnTimer = 0;
    this._ev({ kind: 'wave', wave: this.wave, boss });
  }

  _waves(dt) {
    if (this.wave === 0) {
      this.waveTimer -= dt;
      if (this.waveTimer <= 0) this._startWave();
      return;
    }
    if (this.breakTimer > 0) {
      this.breakTimer -= dt;
      if (this.breakTimer <= 0) this._startWave();
      return;
    }
    if (this.spawnQueue.length) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this._spawnEnemy(this.spawnQueue.shift());
        this.spawnTimer = Math.max(0.07, 0.4 - this.wave * 0.02);
      }
    } else if (this.enemies.length === 0) {
      this.breakTimer = 5;
      this._dropPickups();
      this._ev({ kind: 'clear', wave: this.wave });
    }
  }

  // ---- loop / io -----------------------------------------------------------
  step(dt = TICK) {
    if (this.phase !== 'playing') return;
    this.tick++;
    this.time += dt;
    this._waves(dt);
    for (const p of this.players.values()) this._player(p, dt);
    this._bullets(dt);
    this._enemies(dt);
    this._orbs(dt);
    this._pickups(dt);
    if (this.players.size && [...this.players.values()].every((p) => p.dead)) {
      if (this.solo || this.players.size === 1) this.phase = 'over';
    }
  }

  _ev(e) {
    if (this.events.length > 300) this.events.shift();
    this.events.push(e);
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  snapshot() {
    return {
      t: 'snap',
      tick: this.tick,
      time: +this.time.toFixed(2),
      phase: this.phase,
      wave: this.wave,
      break: +Math.max(0, this.breakTimer).toFixed(1),
      kills: this.kills,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, x: +p.x.toFixed(2), z: +p.z.toFixed(2), sp: +p.speed.toFixed(2),
        hp: Math.round(p.hp), maxHp: Math.round(p.maxHp),
        lvl: p.lvl, xp: p.xp, xpNext: p.xpNext,
        weapon: p.weapon, ammo: p.ammo, mag: WEAPONS[p.weapon].mag,
        reloading: p.reloadT > 0, dead: p.dead, respawnT: +Math.max(0, p.respawnT).toFixed(1),
        coins: p.coins, kills: p.kills, offers: p.offers,
        squad: p.squad.map((s) => [+(s.x ?? p.x).toFixed(2), +(s.z ?? p.z).toFixed(2), +(s.aim ?? Math.atan2(p.fz ?? 1, p.fx ?? 0)).toFixed(2)]),
      })),
      enemies: this.enemies.map((e) => [e.id, e.type, +e.x.toFixed(2), +e.z.toFixed(2), Math.round(e.hp), e.flash > 0 ? 1 : 0]),
      bullets: this.bullets.map((b) => [+b.x.toFixed(2), +b.z.toFixed(2), b.tint]),
      orbs: this.orbs.map((o) => [+o.x.toFixed(2), +o.z.toFixed(2)]),
      pickups: this.pickups.map((k) => [+k.x.toFixed(2), +k.z.toFixed(2), k.kind, k.weapon || '']),
    };
  }
}
