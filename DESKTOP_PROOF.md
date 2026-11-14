# Desktop proof — GonGon (Electron)

Everything below was run on this machine. Commands and outputs are copied from the terminal
session; anything not run is in "Not verified".

## Environment

```
macOS 27.0.0 (darwin 27.0.0), arm64 (Apple Silicon)
node v26.7.0, npm 11.19.0
electron 45.3.2, electron-builder 26.18.0   (added as devDependencies, installed once)
Rosetta 2: NOT installed  →  /usr/bin/arch -x86_64 /usr/bin/true
                              arch: posix_spawnp: /usr/bin/true: Bad CPU type in executable
```

`npm install --save-dev electron@^45.3.2 electron-builder@^26.18.0` → `added 283 packages in 39s`.
Electron's own postinstall (binary download) had to be run explicitly once
(`node node_modules/electron/install.js`) because npm 11's install-script policy skipped it.

## 1. Client bundle

```
npx vite build
✓ 6 modules transformed.
dist/index.html                   4.40 kB │ gzip:   1.44 kB
dist/assets/index-*.css          10.07 kB │ gzip:   2.84 kB
dist/assets/index-*.js          533.73 kB │ gzip: 138.80 kB
✓ built in 673ms
```

`vite.config.js` sets `base: './'`, so every emitted URL is relative — the bundle loads from
the `app://` scheme, from a file tree, or from a server root. The final build (after the
character/i18n work landed) additionally emits `dist/assets/survivor-*.glb`,
`dist/assets/zombie-*.glb` and `dist/CREDITS.md`.

## 2. Desktop shell checks — `npm run desktop:test`

Runs the real `desktop/bundle.js` handler inside Electron against the shipped bundle
(`index-BU4hoqji.js`); every check passed in ~18s:

```
npx electron desktop/test-desktop.mjs     # same thing as npm run desktop:test
```

(The quoted output is from the direct form: piping `npm run` output can outlive Electron's
stdio pipes, so `npm run desktop:test | tail` can appear to hang even after the checks pass.)

```
ok   isLocalUrl accepts app://gongon/index.html
ok   isLocalUrl accepts a nested bundle asset
ok   isLocalUrl rejects remote https
ok   isLocalUrl rejects another app:// host
ok   isLocalUrl rejects file://
ok   isLocalUrl rejects non-URL input
ok   dist/index.html exists (run npm run build first)
ok   bundled page loaded from app:// — app://gongon/index.html
ok   three.js canvas present after load
ok   webgl2 context available
ok   localStorage works on app:// origin — true
ok   gongonDesktop bridge exposed
ok   no Node globals leaked to the renderer
ok   built bundle references a relative asset — app://gongon/assets/index-BU4hoqji.js
ok   real asset served 200 with js mime — 200 text/javascript; charset=utf-8
ok   missing asset returns 404 (not index.html) — 404
ok   CSP header served with the document — default-src 'self'; script-src 'self'; ... connect-src 'self' blob: ws: wss: ...
ok   bundled model assets served (2 glb) — 200 model/gltf-binary | 200 model/gltf-binary
ok   remote navigation blocked
ok   popup denied, remote url handed to the OS browser — https://example.com/
ok   local navigation allowed
ok   control load over http with the same CSP shows no security warning — none
ok   no other renderer errors

desktop shell checks passed
```

Two findings this test produced, both fixed:

- `connect-src` needed `blob:`: `GLTFLoader` fetches loaded model textures from `blob:` URLs,
  so the original policy blocked them (`Refused to connect because it violates the
  document's Content Security Policy`).
- `new URL(appUrl).origin` is `"null"` for custom schemes, so the navigation guard now
  compares scheme + host (`isLocalUrl`); a naive `origin !== ORIGIN` check would have
  blocked the app's own pages.

The last two checks are a control: the same bundle and the same CSP header served over
loopback `http` produce no Electron security warning, which is how we know the app://
warning is an artifact of `protocol.handle` responses being invisible to Electron's
webRequest-based check — the served header itself is asserted separately.

## 3. macOS packaging

```
npx electron-builder --mac dmg zip        # npm run desktop:mac
  • packaging       platform=darwin arch=arm64 electron=45.3.2 appOutDir=proof/desktop/mac-arm64
  • skipped macOS code signing  reason=identity explicitly is set to null
  • building        target=macOS zip arch=arm64 file=proof/desktop/GonGon-0.1.0-arm64-mac.zip
  • building        target=DMG arch=arm64 file=proof/desktop/GonGon-0.1.0-arm64.dmg
EXIT=0
```

Final artifacts, built from the frozen dist below (`npm run desktop:proof`):

```
-rw-r--r--  121461128  20:20  proof/desktop/GonGon-0.1.0-arm64.dmg
-rw-r--r--  117955152  20:20  proof/desktop/GonGon-0.1.0-arm64-mac.zip
-rw-r--r--  154073848  20:22  proof/desktop/GonGon-0.1.0-win.zip
```

sha256:

```
0966cb1a0f54a35e9d4aaf6263d83028af739d2d6fbac7be1f7a57014f0ad411  proof/desktop/GonGon-0.1.0-arm64.dmg
78f005ecc278d1a7ac4eee69c70d8ee7710658ceb5b24a3dbc5757ee4402b162  proof/desktop/GonGon-0.1.0-arm64-mac.zip
bd2daf3a833a06620f44cf2504833940ee743109cc9745f5001a72858d2fd315  proof/desktop/GonGon-0.1.0-win.zip
```

Client fingerprint — the frozen client these artifacts were built from (declared final by the
client owner at 20:16, unchanged during packaging):

```
6b96fb156a1c21beedd56209273ad8d87359b642514e27db2c3a7aa9237f2c1f  dist/index.html
a369749bfc88751b7fc0c3ce0277d2a1a03655d6f879578b7a97a6e66cfad975  dist/assets/index-BU4hoqji.js
8df8a98f513dd2236789992f575dbab9552a724e6dd9ce9d2e061690eccfa439  dist/assets/survivor-C4A8BYNp.glb
02d990c2e442855a7a524a75b51982dc07aec3ee44a48243d61988e125e75a60  dist/assets/zombie-DBEpypWD.glb
```

The packaged `app.asar` was asserted to carry exactly those files before launch, then the
packaged app was launched and driven. Because that check compares file *names*, the embedded
bytes were compared too — both packages' JS extracted from the asar and hashed against dist:

```
mac /dist/assets/index-BU4hoqji.js 642463B a369749bfc88751b7fc0c3ce0277d2a1a03655d6f879578b7a97a6e66cfad975 MATCH dist
win /dist/assets/index-BU4hoqji.js 642463B a369749bfc88751b7fc0c3ce0277d2a1a03655d6f879578b7a97a6e66cfad975 MATCH dist
dist/assets/index-BU4hoqji.js       642463B a369749bfc88751b7fc0c3ce0277d2a1a03655d6f879578b7a97a6e66cfad975 MATCH expected
```

(checked with `@electron/asar`'s `extractFile` on `proof/desktop/mac-arm64/GonGon.app/Contents/Resources/app.asar`
and `proof/desktop/win-unpacked/resources/app.asar` — no rebuild involved.)

```
ASAR {"js":"index-BU4hoqji.js","css":"index-Hw2T7WlX.css","glbs":["survivor-C4A8BYNp.glb","zombie-DBEpypWD.glb"]}
```

```
/desktop
/desktop/bundle.js
/desktop/main.js
/desktop/preload.cjs
/dist
/dist/CREDITS.md
/dist/assets
/dist/assets/index-BU4hoqji.js
/dist/assets/index-Hw2T7WlX.css
/dist/assets/survivor-C4A8BYNp.glb
/dist/assets/zombie-DBEpypWD.glb
/dist/index.html
/package.json
```

Icons are generated locally, no binary assets checked in as originals:
`python3 desktop/build/make-icons.py` → `desktop/build/icon.png` (1024), `icon.ico`
(16…256), `icon.icns` (16…1024, via `iconutil`). The mark is an off-white G whose bar and
stem, plus a cone hat perched on its head, are drawn in the game's squad-marker red
(`#E0503C`) on the night-blue tile — original to this project, not borrowed from any
reference game. electron-builder reports no "default Electron icon is used" line with them
configured, and the rendered PNG was inspected at 1024 and at 16/32 px.

## 4. Packaged app launch + gameplay proof

The app that was driven is the packaged bundle:
`proof/desktop/mac-arm64/GonGon.app/Contents/MacOS/GonGon` (launched directly with
`GONGON_LOG=1`; no terminal, no server, no browser needed at runtime). It was driven over
CDP (`--remote-debugging-port=9333`) so each step below is an observation from inside the
real app, and every screenshot is `Page.captureScreenshot` output of that same process. The
whole sequence is reproduced by `npm run desktop:proof` (`desktop/final-pack.mjs`: package,
assert the asar carries the frozen dist, launch, drive, shoot, print hashes); it needs the
co-op server on 127.0.0.1:8899.

```
ok   packaged asar carries exactly the frozen dist bundle
ok   packaged app loaded app://gongon/index.html
ok   language on launch = en | menu label: Play solo
ok   screenshot 01-menu-on-launch.png
ok   switched en -> ru: Один
ok   screenshot 02-menu-ru.png
ok   blank coop url error: "Coop unavailable: Desktop build bundles no server — enter a coop server URL (ws://… or wss://…)"
ok   screenshot 03-coop-desktop-no-url.png
ok   unreachable coop url error: "Coop unavailable: cannot reach ws://127.0.0.1:9/ws"
ok   screenshot 04-coop-unreachable.png
ok   host room LESF | health: {"ok":true,"rooms":1,"players":1} | persisted: "127.0.0.1:8899"
ok   screenshot 05-coop-host-room.png
ok   second client joined LESF | snapshot players: ["Ranger","GuestClient"] | health: {"ok":true,"rooms":1,"players":2}
ok   app joined node-hosted room XWMC | in-app hint: "Room XWMC · coop"
ok   screenshot 06-coop-join-room.png
ok   screenshot 07-combat-early.png
ok   screenshot 07-combat-late.png
ok   offline solo HUD after 12 steps: {"wave":"2","slain":"8","coins":"8","ammo":"11","squad":1}
ok   store offline: true | items: 8
ok   screenshot 08-solo-shop.png
ok   after restart: language = en | coop field: "127.0.0.1:8899"
ok   screenshot 09-restart-persisted-settings.png
```

Screenshots — every file in `proof/desktop/shots/` after this run (each is a
`Page.captureScreenshot` of the packaged app; the directory is emptied at the start of a run so
nothing stale survives):

```
proof/desktop/shots/01-menu-on-launch.png
proof/desktop/shots/02-menu-ru.png
proof/desktop/shots/03-coop-desktop-no-url.png
proof/desktop/shots/04-coop-unreachable.png
proof/desktop/shots/05-coop-host-room.png
proof/desktop/shots/06-coop-join-room.png
proof/desktop/shots/07-combat-early.png
proof/desktop/shots/07-combat-late.png
proof/desktop/shots/08-solo-shop.png
proof/desktop/shots/09-restart-persisted-settings.png
```

What this run demonstrated, in order:

1. The app boots straight into the game from `app://gongon/index.html` — the menu, HUD and
   models load out of `app.asar` with no local HTTP server and no terminal.
2. Both languages work: this launch came up as `auto language = en` (the persisted choice from
   an earlier run) and switching to RU relabelled the menu live to `Один`
   (`01-menu-on-launch.png` → `02-menu-ru.png`). On the very first launch of the app the system
   locale (ru) was picked automatically instead.
3. Co-op server configuration is reachable from the main menu and honest: with an empty
   field the desktop build refuses (it has no bundled server) and says so; an unreachable
   URL reports the exact address it tried; a bare `127.0.0.1:8899` is normalized, persisted
   in `localStorage` and used to create a real room (`host room LESF`, server `/health`
   `rooms:1, players:1`). A second client (plain Node WebSocket) then joined that room: the
   shared snapshot listed `["Ranger","GuestClient"]` and `/health` reported `players: 2`. The
   reverse path was exercised too: a Node client created room `XWMC` and the app joined it by
   code (in-app hint `Room XWMC · coop`). So the desktop app takes part in genuine two-client
   sessions on whatever server it is pointed at — no stub, no faked local hosting.
4. Offline solo is a real run, not a mock: the HUD advanced while the squad fought
   (`wave 2`, 8 slain, 8 coins, ammo 11/12) and the store opened with 8 purchasable items —
   all served from `app.asar`. **Visual limitation, stated plainly:** the desktop frames
   (`07-combat-early.png`, `07-combat-late.png`) show the hero and its followers in red cone
   hats, but no enemy is distinguishable in them, so this proof does not claim a desktop
   enemy render. The small green cones in those frames are tree canopies (`ConeGeometry`,
   `0x3d6353` in `src/main.js`), not enemies. Enemy visuals are covered by the client owner's
   real-browser capture of this same frozen build:
   `cook/stills/r03/enemy-hat-verified.webp` (two hunched zombies + three humans, all hatted),
   `cook/stills/r03/combat-hero-zombies.webp`, `cook/stills/r03/combat-wave.webp`.
5. Settings persist across restarts: EN and `127.0.0.1:8899` were still set after relaunching
   the app (`09-restart-persisted-settings.png`).
6. The app logs (`/tmp/gongon-final-1.log`, `/tmp/gongon-final-2.log`, `GONGON_LOG=1`) contain no renderer errors.
7. Offline means offline: with the app running (4 Electron processes), the shell owned **zero**
   listening TCP sockets in the equivalent check —
   `lsof -nP -a -iTCP -sTCP:LISTEN -p <app pids>` → no output (`count=0`).
   There is no embedded HTTP server, no localhost port and nothing to configure; solo play
   only reads `app.asar` over `app://gongon`. (Note for anyone reproducing: lsof ORs its
   selectors, so `-a` is required or the check silently lists every socket on the machine.)

## 5. Windows

Local NSIS/portable build fails on this machine, and the reason is environmental, not
config:

```
npm run desktop:win
  • packaging       platform=win32 arch=x64 electron=45.3.2 appOutDir=proof/desktop/win-unpacked
  • building        target=nsis file=proof/desktop/GonGon-Setup-0.1.0-x64.exe
  ⨯ Cannot spawn ~/Library/Caches/electron-builder/nsis-3.0.4.1/.../mac/makensis:
      Error: spawn Unknown system error -86
EXIT=1
```

`-86` is `EBADARCH` — the bundled `makensis` is `Mach-O 64-bit executable x86_64` and Rosetta
2 is not installed, so no `.exe` (NSIS/portable both need makensis) can be produced here.
`GonGon-Setup-0.1.0-x64.exe` and `GonGon-Portable-0.1.0-x64.exe` therefore **do not exist as
files on this machine**; they are the names those targets produce on Windows or with Rosetta 2.

What *was* produced on this machine, with a real Electron win32-x64 runtime inside:

```
npx electron-builder --win zip --x64        # npm run desktop:win:zip
  • packaging       platform=win32 arch=x64 appOutDir=proof/desktop/win-unpacked
  • building        target=zip arch=x64 file=proof/desktop/GonGon-0.1.0-win.zip
EXIT=0
```

For actual installers, `.github/workflows/desktop.yml` builds on `macos-latest` (dmg + zip)
and `windows-latest` (NSIS + portable) and uploads the artifacts.

**Windows status: built, not tested.** The `.zip` contains a genuine Windows Electron app
(`win-unpacked/GonGon.exe`, x64), but no Windows machine was available, so GonGon has never
been executed on Windows: the installer/portable targets were not produced locally (Rosetta
2 missing), the zip was not launched, and SmartScreen behaviour is unknown. Do not claim a
delivered, tested Windows app — only the macOS app is launch-verified.

## 6. Signing

No code-signing or notarization credentials exist for this project. macOS artifacts are
unsigned (`mac.identity: null`, `notarize: false` → "skipped macOS code signing"), Windows
artifacts are unsigned ("no code signing certificate configured, signing is skipped").
Gatekeeper and SmartScreen will warn. Ad-hoc signing for local runs was not applied either.

## Not verified

- **No Windows execution.** See above.
- **No Intel macOS launch.** Only `arm64` was packaged and launched here; `--x64` packaging
  (and a universal build) was not run.
- **No installed-copy test of the shipped artifacts.** The shipped `.dmg`/`.zip` were verified as
  produced (sizes + sha256 above) and the app they package was launched from
  `proof/desktop/mac-arm64/GonGon.app`, but the shipped `.dmg` was not mounted for this build and
  nothing was dragged to /Applications; the `.zip` was not extracted.
- **No signed/notarized distribution**, no auto-update, no crash reporting.
- **No second physical machine for co-op.** The desktop co-op room was created against a
  server on this machine; two human players on two machines were not tested (the two-client
  server proof lives in `tests/coop.test.js`).
- **No icon appearance check** in Finder/Dock beyond the packaging log no longer falling back
  to the Electron default.
- **Co-op over the internet** (TLS/`wss://`) was not exercised; only `ws://` on loopback.
