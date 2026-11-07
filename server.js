#!/usr/bin/env node
// MD Görüntüleyici - yerel sunucu
// Yalnızca 127.0.0.1'e bağlanır, dosyaları sadece OKUR, dışarıya hiçbir şey göndermez.
// Bağımlılık yok: yalnızca Node.js yerleşik modülleri.
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const PREFERRED_PORT = 47821;
const APP_DIR = __dirname;
const STATE_FILE = path.join(os.tmpdir(), 'md-viewer-instance.json');
const MAX_MD_BYTES = 20 * 1024 * 1024;
const MAX_ASSET_BYTES = 50 * 1024 * 1024;

const MD_EXT = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdx', '.txt']);
const IMG_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.avif': 'image/avif'
};

// Sunulan statik dosyalar: açık beyaz liste (dizin gezinme yok).
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml']
};

// vendor/ (ve vendor/fonts/) altındaki kütüphane dosyaları açılışta taranıp beyaz listeye eklenir.
// Yalnızca bu uzantılar sunulur; .map, lisanslar ve alt dizinlerdeki diğer her şey sunulmaz.
const VENDOR_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2'
};
for (const dir of ['vendor', 'vendor/fonts']) {
  let names = [];
  try { names = fs.readdirSync(path.join(APP_DIR, dir), { withFileTypes: true }); } catch { /* yok say */ }
  for (const d of names) {
    if (!d.isFile() || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(d.name)) continue;
    const type = VENDOR_TYPES[path.extname(d.name).toLowerCase()];
    if (type) STATIC['/' + dir + '/' + d.name] = [dir + '/' + d.name, type];
  }
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: http: https:", // uzak görseller istemcide varsayılan olarak engellenir
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');

// ---------- komut satırı ----------
const argv = process.argv.slice(2);
const noBrowser = argv.includes('--no-browser');
const fileArgs = argv.filter(a => a !== '--no-browser').map(a => path.resolve(a.replace(/^"|"$/g, '')));

function buildUrl(port, token, files) {
  let hash = 't=' + token;
  for (const f of files) hash += '&f=' + encodeURIComponent(f);
  return `http://${HOST}:${port}/#${hash}`;
}

function openBrowser(url) {
  if (noBrowser) return;
  try {
    // rundll32 kullanılır: cmd'nin "&" karakterini yorumlamasından kaçınmak için.
    const child = process.platform === 'win32'
      ? spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => console.log('Tarayıcı açılamadı. Elle açın: ' + url));
    child.unref();
  } catch (e) {
    console.log('Tarayıcı açılamadı. Elle açın: ' + url);
  }
}

function pingExisting() {
  return new Promise(resolve => {
    let st;
    try { st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return resolve(null); }
    if (!st || !st.port || !st.token) return resolve(null);
    const req = http.get({ host: HOST, port: st.port, path: '/api/ping?t=' + st.token, timeout: 800 }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body).app === 'md-viewer' ? st : null); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// ---------- yardımcılar ----------
function send(res, status, type, body, extra) {
  res.writeHead(status, Object.assign({
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': CSP
  }, extra || {}));
  res.end(body);
}
function json(res, status, obj) { send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj)); }

function resolveTarget(q) {
  // path=<mutlak yol>  veya  base=<belge yolu>&rel=<göreli yol>
  const p = q.get('path');
  if (p) return path.resolve(p);
  const base = q.get('base'), rel = q.get('rel');
  if (base && rel) {
    let r = rel;
    try { r = decodeURIComponent(rel); } catch { /* olduğu gibi kullan */ }
    r = r.split('#')[0].split('?')[0];
    return path.resolve(path.dirname(path.resolve(base)), r);
  }
  return null;
}

async function statFile(p, maxBytes) {
  const st = await fsp.stat(p);
  if (!st.isFile()) throw Object.assign(new Error('Dosya değil'), { code: 'NOTFILE' });
  if (st.size > maxBytes) throw Object.assign(new Error('Dosya çok büyük'), { code: 'TOOBIG' });
  return st;
}

function errMsg(e) {
  switch (e && e.code) {
    case 'ENOENT': return 'Dosya bulunamadı';
    case 'EACCES': case 'EPERM': return 'Dosyaya erişim izni yok';
    case 'NOTFILE': return 'Bu bir dosya değil';
    case 'TOOBIG': return 'Dosya çok büyük';
    case 'EXT': return 'Desteklenmeyen dosya türü';
    default: return 'Dosya okunamadı';
  }
}

// ---------- sunucu ----------
function createServer(token, getPort) {
  return http.createServer(async (req, res) => {
    try {
      // DNS rebinding koruması: Host başlığı yalnızca yerel olabilir.
      const port = getPort();
      const host = (req.headers.host || '').toLowerCase();
      if (host !== `${HOST}:${port}` && host !== `localhost:${port}`) {
        return send(res, 403, 'text/plain; charset=utf-8', 'Yasak');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(res, 405, 'text/plain; charset=utf-8', 'Yalnızca okuma');
      }
      const url = new URL(req.url, `http://${HOST}:${port}`);
      const pn = url.pathname;

      if (STATIC[pn]) {
        const [file, type] = STATIC[pn];
        const data = await fsp.readFile(path.join(APP_DIR, file));
        return send(res, 200, type, data);
      }

      if (pn.startsWith('/api/')) {
        if (url.searchParams.get('t') !== token) return json(res, 403, { error: 'Geçersiz oturum anahtarı' });

        if (pn === '/api/ping') return json(res, 200, { app: 'md-viewer' });

        const target = resolveTarget(url.searchParams);
        if (!target) return json(res, 400, { error: 'Yol belirtilmedi' });
        const ext = path.extname(target).toLowerCase();

        if (pn === '/api/file' || pn === '/api/stat') {
          try {
            if (!MD_EXT.has(ext)) throw Object.assign(new Error(), { code: 'EXT' });
            const st = await statFile(target, MAX_MD_BYTES);
            if (pn === '/api/stat') return json(res, 200, { path: target, mtime: st.mtimeMs, size: st.size });
            const buf = await fsp.readFile(target); // salt okuma
            let text = buf.toString('utf8');
            if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
            return json(res, 200, { path: target, name: path.basename(target), mtime: st.mtimeMs, content: text });
          } catch (e) {
            return json(res, 404, { error: errMsg(e), path: target });
          }
        }

        if (pn === '/api/asset') {
          const type = IMG_TYPES[ext];
          if (!type) return send(res, 415, 'text/plain; charset=utf-8', 'Desteklenmeyen görsel türü');
          try {
            await statFile(target, MAX_ASSET_BYTES);
            const data = await fsp.readFile(target);
            // SVG içindeki betiklerin çalışmasını engelle.
            return send(res, 200, type, data, { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
          } catch (e) {
            return send(res, 404, 'text/plain; charset=utf-8', errMsg(e));
          }
        }
        return json(res, 404, { error: 'Bilinmeyen istek' });
      }
      send(res, 404, 'text/plain; charset=utf-8', 'Bulunamadı');
    } catch (e) {
      send(res, 500, 'text/plain; charset=utf-8', 'Sunucu hatası');
    }
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onErr = e => { server.removeListener('listening', onOk); reject(e); };
    const onOk = () => { server.removeListener('error', onErr); resolve(server.address().port); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, HOST);
  });
}

async function main() {
  // Zaten çalışan bir örnek varsa, ona yeni bir tarayıcı sekmesi aç ve çık.
  const existing = await pingExisting();
  if (existing) {
    const url = buildUrl(existing.port, existing.token, fileArgs);
    console.log('Çalışan görüntüleyici bulundu, yeni sekme açılıyor...');
    openBrowser(url);
    return;
  }

  const token = crypto.randomBytes(24).toString('hex');
  let port = 0;
  const server = createServer(token, () => port);
  try {
    port = await listen(server, PREFERRED_PORT);
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    port = await listen(server, 0);
  }

  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 }); } catch { /* yok say */ }
  const cleanup = () => {
    try {
      const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (st.pid === process.pid) fs.unlinkSync(STATE_FILE);
    } catch { /* yok say */ }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGHUP', () => process.exit(0));

  const url = buildUrl(port, token, fileArgs);
  console.log('MD Görüntüleyici çalışıyor: http://' + HOST + ':' + port + '/');
  console.log('Yalnızca bu bilgisayardan erişilebilir. Kapatmak için bu pencereyi kapatın (veya Ctrl+C).');
  if (noBrowser) console.log('URL: ' + url);
  openBrowser(url);
}

main().catch(e => { console.error('Başlatılamadı:', e.message); process.exit(1); });
