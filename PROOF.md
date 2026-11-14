# Verification log — Nightfall Outpost

Everything below was run on this machine (macOS, Node v26.7.0). Anything not run is listed
under "Not verified".

## Build

```
npx vite build   →  ✓ built, dist/index.html + dist/assets/index-*.js (533 KB / 138 KB gzip) + .css
node --check     →  shared/sim.js, server/index.js parse clean
```

## Simulation tests — `node tests/sim.test.js`

```
10 checks passed
ok   world builds obstacles without blocking spawn
ok   first wave spawns enemies and they advance
ok   auto-attack damages and kills, awarding xp and coins
ok   upgrade offer is served at level up and applies once
ok   shop charges coins and refuses when broke
ok   death ends a solo run
ok   snapshot has stable shape and bounded size
ok   two players share one world and both take damage
ok   inputs are clamped so clients cannot speed-hack
ok   same seed yields the same layout
```

## Co-op server proof — `node tests/coop.test.js` (two real WebSocket clients)

```
ok   room created NKAT
ok   guest joined same room (pkgtzb6)
ok   shared snapshot has 2 players
ok   independent movement: host x=42.8, guest x=-42.8
ok   shared enemies spawned (peak 6)
ok   guest sees same horde (peak 6)
ok   out-of-range input clamped server-side
ok   invalid pick/buy ignored, room still ticking (24 new snapshots)

coop proof passed in 8013ms
```

The last check compares snapshot counts before/after hostile messages, so it proves the
authoritative loop kept running rather than merely reading a stale snapshot. The script has a
45s hard timeout and terminates its clients on failure, so it cannot hang.

Server health endpoint used during the run: `GET /health → {"ok":true,"rooms":0,"players":0}`.

## Browser smoke (headless Chromium, 1024x640 CSS viewport, served by `node server/index.js`)

- Menu renders, `Play solo` starts a run.
- HUD updates with live values during play (observed `wave 2`, `9 slain`, `9 coins`, ammo `0/12`
  with the reload bar active).
- Level-up overlay appears and a card click applies the upgrade and resumes play.
- Arrow-key and WASD movement moves the hero; the squad follows in a V formation and fires.
- No console errors at any point: `tab.errors() → { entries: [] }`.
- Screenshots (real files, WebP 1024x640): `cook/stills/r02/menu.webp`, `cook/stills/r02/combat.webp`.

## Not verified

- **No public deployment.** There is no internet URL, no TLS, no multi-region hosting. The
  game was only served from this machine on port 8899 (`http://127.0.0.1:8899`). LAN play
  works over the same port; internet play needs the operator to host it (see README).
- **No real-device mobile run.** Touch controls are rendered for coarse pointers and for
  viewports ≤700px wide, but they were only checked in a headless engine that reports a fine
  pointer. Physical iOS/Android behaviour (safe areas, audio unlock, backgrounding) is untested.
- **No frame-time measurement.** Draw calls are instanced and lights are capped, but no FPS
  number was measured at 1440x900 or on a phone.
- **No real-money store, accounts, or persistence.** The in-run store exists and is paid with
  coins earned in that run; there is no real-money purchase path anywhere in this build.
- **No cross-region latency test.** One process, one region, in-memory rooms.
