// Bundled-client serving for the Electron shell, kept separate from window wiring so
// desktop/test-desktop.mjs can exercise the real thing instead of a copy.
import fs from 'node:fs';
import path from 'node:path';

export const SCHEME = 'app';
export const ORIGIN = `${SCHEME}://gongon`;

// Standard + secure so relative URLs, fetch(), WebGL and localStorage behave like https.
export const PRIVILEGED_SCHEMES = [
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.ktx2': 'image/ktx2', '.hdr': 'image/vnd.radiance', '.exr': 'image/aces',
  '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
};

// connect-src allows ws/wss so a configured remote coop server is reachable, and blob:
// because GLTFLoader turns loaded model textures into blob: URLs.
// everything else is same-origin bundle content.
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "media-src 'self' data: blob:", "font-src 'self' data:",
  "connect-src 'self' blob: ws: wss:", "worker-src 'self' blob:",
  "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');

const headers = (type) => ({ 'content-type': type, 'cache-control': 'no-cache', 'content-security-policy': CSP });

// Custom-scheme URLs report origin "null", so compare scheme and host explicitly.
export function isLocalUrl(url) {
  try {
    const { protocol: scheme, host } = new URL(url);
    return scheme === `${SCHEME}:` && host === 'gongon';
  } catch { return false; }
}

/** No untrusted navigation, no new windows: this is a local game, not a browser. */
export function applyNavigationGuards(win, { openExternal } = {}) {
  const { webContents } = win;
  webContents.setWindowOpenHandler(({ url }) => {
    if (openExternal && /^https?:/.test(url)) openExternal(url);
    return { action: 'deny' };
  });
  webContents.on('will-navigate', (event, url) => {
    if (!isLocalUrl(url)) event.preventDefault();
  });
}

const missingBundle = () => new Response(
  '<!doctype html><meta charset="utf-8"><title>GonGon</title>'
  + '<body style="font:16px/1.5 system-ui;background:#0b1220;color:#e8dfd0;padding:3rem">'
  + '<h1>Client bundle missing</h1><p>The packaged app has no <code>dist/</code> yet.</p>'
  + '<p>From the project root run <code>npm run build</code>, then launch again.</p>',
  { status: 503, headers: headers('text/html; charset=utf-8') },
);

/** Serve `distDir` over app://gongon. Call after app is ready. */
export function registerAppProtocol(fetchHandler, distDir) {
  const index = path.join(distDir, 'index.html');
  return fetchHandler.handle(SCHEME, async (request) => {
    let pathname = '/';
    try { pathname = decodeURIComponent(new URL(request.url).pathname); } catch { return new Response('Bad request', { status: 400 }); }
    if (pathname === '' || pathname === '/') pathname = '/index.html';
    const file = path.join(distDir, path.normalize(pathname));
    if (!file.startsWith(distDir + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      const data = await fs.promises.readFile(file);
      return new Response(data, { headers: headers(MIME[path.extname(file).toLowerCase()] || 'application/octet-stream') });
    } catch {
      if (!fs.existsSync(index)) return missingBundle();
      // A missing file is a real 404: turning it into index.html would hide broken asset paths.
      return new Response('Not found', { status: 404, headers: headers('text/plain; charset=utf-8') });
    }
  });
}
