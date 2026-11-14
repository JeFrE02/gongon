# GonGon

Top-down survivor squad game. One hero, a squad of soldiers, endless waves, upgrades, an
outpost store paid with coins earned in the run, and real WebSocket co-op rooms.

Two ways to play the same client: in a browser (three.js/WebGL + an authoritative Node
server), or as a packaged desktop app where solo play runs fully offline from the bundled
assets and co-op points at a server you name. macOS artifacts are built and launch-verified
here; the Windows build exists but has not been run on Windows yet (see `DESKTOP_PROOF.md`).

## Run it (browser)

```bash
npm install
npm run build          # client bundle into dist/
npm start              # http://localhost:8787  (serves dist/ + /ws)
```

Development with hot reload (client on 5173, game server on 8787, `/ws` proxied):

```bash
npm run server         # terminal 1
npm run dev            # terminal 2 → http://localhost:5173
```

Open `http://localhost:8787` (or the dev URL) in a browser. `Play solo` needs no server
connection logic beyond the page itself; `Host coop` / `Join` use the WebSocket server.

## Desktop app (Electron)

Solo play needs no server, no terminal and no network: the app serves its own bundled
`dist/` from a privileged `app://gongon` scheme (no localhost listener) and loads the GLB
characters from the packaged `app.asar`.

```bash
npm install
npm run desktop        # build dist/, then launch the app from source
npm run desktop:test   # shell checks: offline bundle, 404s, CSP, nav guards, preload
npm run desktop:proof  # package + launch + drive the packaged app, print artifact hashes
npm run desktop:mac    # → proof/desktop/GonGon-1.0.0-arm64.dmg + GonGon-1.0.0-arm64-mac.zip
npm run desktop:win    # → GonGon-Setup-1.0.0-x64.exe + GonGon-Portable-1.0.0-x64.exe
npm run desktop:win:zip  # → proof/desktop/GonGon-1.0.0-win.zip (works without Rosetta 2)
npm run desktop:icons  # regenerate desktop/build/icon.png + icon.icns + icon.ico (stdlib-only):
                       # off-white G + red cone-hat marker on a night-blue tile
```

Artifacts (gitignored build output):

```
proof/desktop/GonGon-1.0.0-arm64.dmg         macOS installer (unsigned, Apple Silicon)
proof/desktop/GonGon-1.0.0-arm64-mac.zip     zipped GonGon.app
proof/desktop/GonGon-1.0.0-win.zip           Windows x64 build (unzip → GonGon.exe)
proof/desktop/mac-arm64/GonGon.app           unpacked macOS app used for the launch proof
```

Intel Macs: `npx electron-builder --mac dmg zip --x64`.

Windows `.exe` installers are built by `npm run desktop:win`. On Apple Silicon that needs
Rosetta 2 (`softwareupdate --install-rosetta`), because electron-builder's bundled
`makensis` is an x86_64 binary; without it use `npm run desktop:win:zip`, or run
`.github/workflows/desktop.yml` (macOS + Windows runners) and download the artifacts.
Neither the NSIS installers nor the Windows zip have been launched on Windows — see
`DESKTOP_PROOF.md`.

**Signing:** no code-signing or notarization credentials exist for this project, so every
artifact is unsigned. macOS shows "unidentified developer" (right-click → Open, or
`xattr -dr com.apple.quarantine GonGon.app`); Windows SmartScreen warns before running the
installer. `mac.identity: null` and the missing certificate are intentional in
`electron-builder.yml`, not an oversight.

### Shell security

`desktop/main.js` + `desktop/bundle.js` create one `BrowserWindow` with
`nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, a CSP header
(`default-src 'self'`, `connect-src 'self' blob: ws: wss:`), all permission requests
denied, remote navigation blocked (custom-scheme origins are compared by scheme + host,
not by `origin`, which is `"null"` for `app://`), and popups handed to the OS browser
instead of opening a window. The preload exposes exactly one frozen value:
`window.gongonDesktop = { isDesktop, platform, version }` — no IPC, no Node globals.

Missing files are real 404s, so a bad asset path fails loudly instead of silently
returning `index.html`.

## Play

| Action | Desktop | Touch |
|---|---|---|
| Move (4 directions) | WASD / arrows | on-screen pad, bottom-left |
| Dash | Space | `»` button |
| Reload | R | `⟳` button |
| Store | B | `◆` button |
| Pause | Esc | `❚❚` top-right |
| Audio | — | `♪` top-right |

Attacks are automatic; you steer, dash, pick upgrades and spend coins.

- Enemies spawn in waves from outside the clearing, a boss every 4th wave.
- Kills drop XP orbs (levels → choose 1 of 3 upgrades) and coins.
- The store sells heals, max HP, extra squad, damage, speed, reload, and two weapons.
  Coins are earned **in the run only**; there is no real-money purchase anywhere in this build.
- Co-op: up to 4 players share one world, one horde and one wave counter. Downed players
  respawn after 6s. Anyone can open the store; the world keeps running while the store is open.
- UI language follows the OS/browser locale (EN/RU) and can be switched in the menu.

## Co-op hosting (honest scope)

The server is a single Node process holding rooms in memory.

- **LAN / same machine**: run `npm start` and open `http://<your-lan-ip>:8787` from each device.
  Room codes are 4 characters; the host shares the code.
- **Internet**: put this process behind a host that terminates TLS and supports WebSockets
  (Fly.io, Render, Railway, a VPS with Caddy).
- **Server address**: in the browser the client defaults to the page's own origin
  (`ws(s)://location.host/ws`); the menu's **Coop server** field overrides it with any
  `ws://host:port/ws` or `wss://host/ws` (a bare `host:port` also works). The value is
  validated and persisted in `localStorage` (`gongon.coopUrl`); invalid or unreachable
  addresses produce an inline error naming the URL that was tried. In the desktop app the
  same-origin default does not exist, so the field is required for co-op — the app never
  pretends to host a server locally.
- **Not deployed by this build.** No public URL exists, no regions, no matchmaking, no
  persistence: restarting the server drops every room. One region means players far from it
  get high ping; the game tolerates that with 20Hz server ticks and interpolation, but it is
  not a worldwide service.
- No accounts, no cross-device saves, no leaderboards, no payments.

## Layout

```
shared/sim.js       authoritative simulation (no DOM, no Node APIs)
server/index.js     static hosting + WebSocket rooms, 20Hz fixed step
src/main.js         three.js client: rendering, input, HUD, menus, solo loop
src/i18n.js         EN/RU strings, locale detection
src/assets/models/  survivor + zombie GLB characters (credited in public/CREDITS.md)
src/style.css       HUD and menu styling
index.html          app shell
desktop/main.js     Electron entry: window, security, proof hooks
desktop/bundle.js   app:// serving of dist/ + navigation guards (shared with the test)
desktop/preload.cjs frozen window.gongonDesktop, nothing else
desktop/build/      icon generator + generated icon.png/.icns/.ico
desktop/test-desktop.mjs  shell checks (npm run desktop:test)
electron-builder.yml      packaging config for macOS + Windows
tests/sim.test.js   10 sim checks  (node tests/sim.test.js)
tests/coop.test.js  two-client server proof (needs the server running)
```

The client runs the same `shared/sim.js` for solo play and for local prediction of the own
player in co-op; the server's snapshots remain authoritative.

## Tests

```bash
node tests/sim.test.js                     # pure sim, no server
npm run desktop:test                       # Electron shell: app://, 404, CSP, nav guards
npm start & WS=ws://127.0.0.1:8787/ws node tests/coop.test.js
```

See `PROOF.md` for the web/sim/co-op verification log and `DESKTOP_PROOF.md` for the
desktop packaging, launch and co-op proof.

## Design rationale (Project Zomboid — not parity)

The multiplayer shape follows how Project Zomboid's dedicated servers actually work, minus
everything we do not have:

- PZ ships a **separate dedicated server** (Steam tool app 380870) for Windows/Linux and
  players join by **direct address** (game port 16261/UDP, direct-connection port 16262) —
  the host owns NAT/port forwarding. Our equivalent of "direct address" is the menu's
  explicit `ws://`/`wss://` server field plus a 4-character room code; we ship no Steam
  integration, no server browser and no UPnP/NAT traversal.
  <https://pzwiki.net/wiki/Dedicated_server>
- PZ also lets the host start multiplayer straight from the main menu, which is the role of
  our `Host coop` button; the game client and the server are separate processes in both.
  <https://pzwiki.net/wiki/Multiplayer_FAQ>
- PZ ships 64-bit builds for Windows, macOS (10.15+, Intel or Apple silicon) and
  SteamOS/Linux on Steam. We match the platforms, not the storefront or the toolchain:
  unsigned `.dmg`/`.zip` for macOS and NSIS/portable/zip for Windows, no Steam, no
  auto-updater.
  <https://store.steampowered.com/app/108600/Project_Zomboid/>
