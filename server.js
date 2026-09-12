/* JoFi Music backend, ported from server.py (ytmusicapi + yt-dlp) to pure
 * Node.js so it can run inside the embedded Pocket Server runtime (nodejs-mobile)
 * without Python. API surface and wire format match the original, and static
 * hosting of app/dist is kept identical (gzip + SPA fallback + LAN printing).
 *
 * Pure-JS providers: youtubei.js (charts, search, lyrics, audio URLs) with
 * @distube/ytdl-core as a fallback extractor for audio streams. Both run
 * entirely in-process; no child processes, no native modules.
 *
 * Usage (inside Pocket Server): start command `node server.js`; the app injects
 * PORT/HOST and runs `npm install` in-session before requiring this entry.
 */
'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const PORT = Number(process.env.PORT || 9335);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = process.cwd();
const APP_DIST = path.join(ROOT, 'app', 'dist');
const LOG_DIR = path.join(ROOT, '.pocket', 'logs');
const CACHE_FILE = path.join(LOG_DIR, 'cache.json');

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const TTL = {
  charts: 6 * 3600,
  search: 3600,
  url: 2 * 3600,
  lyrics: 7 * 86400,
  lyrics_timed: 7 * 86400
};

globalThis.fetch ||
  (function shim() {
    try {
      const undici = require('undici');
      globalThis.fetch = undici.fetch;
    } catch (e) {
      log('fetch shim unavailable: ' + (e && e.message));
    }
  })();

let Innertube = null;
let ytdl = null;
let _music = null;
let _patchReady = null;

function patchYoutubeiClients() {
  if (_patchReady) return _patchReady;
  _patchReady = (async function () {
    try {
      const cwdReq = require('module').createRequire(process.cwd() + path.sep);
      const main = cwdReq.resolve('youtubei.js');
      let dir = path.dirname(main);
      for (let i = 0; i < 6; i++) {
        const cand = path.join(dir, 'dist', 'src', 'utils', 'Constants.js');
        if (fs.existsSync(cand)) {
          const Constants = await import(pathToFileURL(cand).href);
          if (Constants.CLIENTS) {
            if (Constants.CLIENTS.ANDROID) {
              Constants.CLIENTS.ANDROID.VERSION = '21.26.364';
              Constants.CLIENTS.ANDROID.SDK_VERSION = 30;
              Constants.CLIENTS.ANDROID.USER_AGENT =
                'com.google.android.youtube/21.26.364 (Linux; U; Android 11) gzip';
            }
          }
          break;
        }
        dir = path.dirname(dir);
      }
    } catch (e) {
      log('patch youtubei constants fallo (no critico): ' + String(e && e.message || e));
    }
  })();
  return _patchReady;
}

function loadDeps() {
  try {
    const ys = require('youtubei.js');
    Innertube = ys.Innertube || ys.default || ys.Youtube || ys;
  } catch (e) {
    throw new Error('youtubei.js no cargable: ' + (e && e.message));
  }
  try {
    ytdl = require('@distube/ytdl-core');
  } catch (e) {
    log('@distube/ytdl-core no cargable (fallback de audio desactivado): ' + (e && e.message));
  }
}

function log(msg) {
  console.log('[' + new Date().toLocaleTimeString() + '] ' + msg);
}

function nowSec() {
  return Date.now() / 1000;
}

let _mem = {};
let _cacheDirty = false;

function cacheLoad() {
  try {
    _mem = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) {
    _mem = {};
  }
}

function cacheFlush() {
  if (!_cacheDirty) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(_mem));
    _cacheDirty = false;
  } catch (e) {
    log('cache flush error: ' + (e && e.message));
  }
}

function cacheGet(kind, key) {
  const hit = _mem[kind + ':' + key];
  if (hit && hit[0] > nowSec()) return hit[1];
  return null;
}

function cacheSet(kind, key, value) {
  _mem[kind + ':' + key] = [nowSec() + (TTL[kind] || 3600), value];
  _cacheDirty = true;
}

function cacheDel(kind, key) {
  delete _mem[kind + ':' + key];
  _cacheDirty = true;
}

function cached(kind, key, fn) {
  const hit = cacheGet(kind, key);
  if (hit !== null && hit !== undefined) return hit;
  const val = fn();
  if (val && typeof val.then === 'function') {
    return val.then(function (res) {
      cacheSet(kind, key, res);
      return res;
    });
  }
  cacheSet(kind, key, val);
  return val;
}

let _cookieStr = null;

function loadCookie() {
  if (_cookieStr !== null) return _cookieStr;
  const tries = [
    path.join(ROOT, '.pocket', 'cookies.txt'),
    path.join(ROOT, 'cookies.txt'),
    path.join(ROOT, '.pocket', 'config.json')
  ];
  for (const f of tries) {
    try {
      const raw = fs.readFileSync(f, 'utf8');
      if (!raw) continue;
      if (f.endsWith('config.json')) {
        const j = JSON.parse(raw);
        if (j && j.cookie) {
          _cookieStr = String(j.cookie).trim();
          log('cookies: leidas de ' + f);
          return _cookieStr;
        }
        continue;
      }
      const parts = [];
      for (const line of raw.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const c = t.split('\t');
        if (c.length >= 7 && (c[3] === 'TRUE' || c[3] === 'true')) {
          parts.push(encodeURIComponent(c[5]) + '=' + encodeURIComponent(c[6]));
        }
      }
      if (parts.length) {
        _cookieStr = parts.join('; ');
        log('cookies: leidas de ' + f + ' (' + parts.length + ' pares)');
        return _cookieStr;
      }
    } catch (e) {
      // ignorar
    }
  }
  _cookieStr = '';
  return _cookieStr;
}

async function music() {
  if (_music) return _music;
  await patchYoutubeiClients();
  if (!Innertube) loadDeps();
  const cookie = loadCookie();
  _music = await Innertube.create({
    generate_session_locally: true,
    ...(cookie ? { cookie: cookie } : {})
  });
  log('YouTube Music session ready' + (cookie ? ' (con cookies)' : ''));
  return _music;
}

function durSec(d) {
  if (Array.isArray(d)) {
    d = d.map(function (t) { return (t && typeof t.text === 'string') ? t.text : String(t || ''); }).join(' ');
  }
  if (d == null) return 0;
  if (typeof d === 'number') return Math.max(0, Math.floor(d));
  if (typeof d === 'object' && typeof d.seconds === 'number') return Math.max(0, Math.floor(d.seconds));
  const m = /^(\d+):(\d+)/.exec(String(d || ''));
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return 0;
}

function titleOf(item) {
  const t = item.title != null ? item.title : item.name;
  if (typeof t === 'string') return t;
  if (t && typeof t.text === 'string') return t.text;
  return 'Sin titulo';
}

function thumbUrlOf(item) {
  let thumbs = item.thumbnails;
  if (!Array.isArray(thumbs) && item.thumbnail && Array.isArray(item.thumbnail.contents)) {
    thumbs = item.thumbnail.contents;
  }
  let url = '';
  let bestW = 0;
  (Array.isArray(thumbs) ? thumbs : []).forEach(function (t) {
    if (t && t.url && (t.width || 0) >= bestW) {
      bestW = t.width || 0;
      url = t.url;
    }
  });
  return url;
}

function metaOf(item) {
  const artists = ((item.artists || item.authors) || [])
    .map(function (a) { return a && a.name; })
    .filter(Boolean);
  let album = '';
  if (item.album) album = typeof item.album === 'string' ? item.album : (item.album.name || '');
  let duration = durSec(item.duration);
  if (!duration && Array.isArray(item.flex_columns)) {
    for (const fc of item.flex_columns) {
      const t = fc && fc.title && (typeof fc.title === 'string' ? fc.title : fc.title.text);
      if (typeof t !== 'string') continue;
      const m = /^(\d+):(\d{2})(:\d{2})?$/.exec(t.trim());
      if (m) {
        duration = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
        break;
      }
    }
  }
  return {
    videoId: item.id || item.videoId || '',
    title: titleOf(item),
    artist: artists.join(', ') || 'Desconocido',
    album: album,
    thumb: thumbUrlOf(item),
    duration: duration
  };
}

function collectSongs(items, out) {
  if (!Array.isArray(items)) return out;
  for (const it of items) {
    if (!it) continue;
    if (it.type === 'MusicResponsiveListItem' && it.id) {
      if (out.indexOf(it) < 0) out.push(it);
    } else if (it.type === 'MusicTwoRowItem' && it.id &&
      it.duration && Number(it.duration.seconds) > 0) {
      out.push(it);
    }
    if (Array.isArray(it.contents)) collectSongs(it.contents, out);
    if (Array.isArray(it.items)) collectSongs(it.items, out);
  }
  return out;
}

async function getCharts() {
  function fn() {
    return music().then(function (yt) {
      return yt.music.getExplore().then(function (ex) {
        const secs = ex.sections || ex.contents || [];
        let songs = collectSongs(secs, []);
        if (songs.length < 10) {
          return yt.music.getHomeFeed().then(function (hf) {
            const hsecs = hf.sections || hf.contents || [];
            songs = collectSongs(hsecs, []);
            return buildCharts(songs);
          });
        }
        return buildCharts(songs);
      });
    });
  }
  return cached('charts', 'charts:us', fn);
}

function buildCharts(songs) {
  const top = songs.slice(0, 40).map(metaOf);
  if (top.length < 5) {
    return { cc: 'us', title: 'Sin top disponible', songs: [] };
  }
  return { cc: 'us', title: 'Canciones del momento', songs: top };
}

async function searchMusic(q) {
  function fn() {
    return music().then(function (yt) {
      return yt.music.search(q, { filter: 'songs' }).then(function (res) {
        const all = collectSongs(res.contents, []);
        const songs = all.filter(function (it) { return it.item_type === 'song' || !it.item_type; });
        const out = (songs.length >= 3 ? songs : all).slice(0, 40).map(metaOf);
        return out;
      });
    });
  }
  return cached('search', 'search:' + q.toLowerCase(), fn);
}

async function streamUrl(videoId, refresh) {
  function fn() {
    const errors = [];
    return streamFromYoutubei(videoId).catch(function (e) {
      errors.push('youtubei: ' + String(e.message || e));
      if (!ytdl) throw new Error(errors.join(' | '));
      return streamFromYtdl(videoId).catch(function (e2) {
        errors.push('ytdl-core: ' + String(e2.message || e2));
        throw new Error(errors.join(' | '));
      });
    });
  }
  if (refresh) cacheDel('url', 'url:' + videoId);
  return cached('url', 'url:' + videoId, fn);
}

let _audioSession = null;

async function audioSession(clientKey) {
  if (clientKey === 'WEB') return music();
  await patchYoutubeiClients();
  if (!_audioSession) {
    if (!Innertube) loadDeps();
    const cookie = loadCookie();
    _audioSession = await Innertube.create({
      generate_session_locally: true,
      ...(cookie ? { cookie: cookie } : {})
    });
  }
  return _audioSession;
}

function pickAudioUrl(info) {
  const sd = info.streaming_data || {};
  const list = Array.isArray(sd.adaptive_formats) ? sd.adaptive_formats : [];
  const audios = list.filter(function (f) {
    return f && /audio/.test(String(f.mime_type || '')) && f.url;
  });
  audios.sort(function (a, b) {
    const aMp4 = /\/mp4|mpeg/.test(String(a.mime_type || '')) ? 1 : 0;
    const bMp4 = /\/mp4|mpeg/.test(String(b.mime_type || '')) ? 1 : 0;
    return (bMp4 - aMp4) || ((b.bitrate || 0) - (a.bitrate || 0));
  });
  return audios.length ? audios[0].url : '';
}

async function streamFromYoutubei(videoId) {
  const orders = ['IOS', 'WEB', 'ANDROID', 'ANDROID_MUSIC', 'MUSIC', 'TV', 'TV_EMBEDDED', 'TV_SIMPLY'];
  let lastErr = '';
  for (const key of orders) {
    try {
      const yt = await audioSession(key);
      const info = await yt.getBasicInfo(videoId, { client: key });
      const url = pickAudioUrl(info);
      if (url) return url;
      lastErr += key + ': sin url firmada | ';
    } catch (e) {
      lastErr += key + ': ' + String(e && e.message || e).slice(0, 100) + ' | ';
    }
  }
  throw new Error('youtubei sin url de audio (' + lastErr.replace(/ \| $/, '') +
    ')' + (loadCookie() ? '' : ' [sugerencia: exporta cookies.txt de tu navegador a .pocket/cookies.txt]'));
}

async function streamFromYtdl(videoId) {
  const cookie = loadCookie();
  const info = await ytdl.getInfo(videoId, {
    playerClients: ['ANDROID_MUSIC', 'ANDROID', 'IOS', 'WEB'],
    ...(cookie ? { requestOptions: { headers: { Cookie: cookie } } } : {})
  });
  const f = ytdl.chooseFormat(info.formats, { filter: 'audioonly', quality: 'highest' });
  if (!f || !f.url) throw new Error('ytdl-core sin formato de audio');
  return f.url;
}

async function getLyrics(videoId) {
  function fn() {
    return music().then(function (yt) {
      return yt.music.getLyrics(videoId).then(function (ly) {
        if (!ly) return null;
        const text = ly.content || ly.lyrics || ly.fullText || '';
        return String(text).trim() || null;
      });
    }).catch(function (e) {
      log('lyrics error: ' + String(e.message || e));
      return null;
    });
  }
  const v = await cached('lyrics', 'lyrics:' + videoId, fn);
  return v || null;
}

const LRC_RE = /\[(\d+):(\d+)(?:([.:,])(\d{1,3}))?\]/g;

function parseLrc(text) {
  const raw = String(text || '').split('\n');
  const lines = [];
  for (const line of raw) {
    const markers = [];
    let m;
    LRC_RE.lastIndex = 0;
    while ((m = LRC_RE.exec(line)) !== null) {
      const mins = parseInt(m[1], 10);
      const secs = parseInt(m[2], 10);
      const frac = m[4];
      const ms = frac ? parseInt(frac, 10) * Math.floor(1000 / Math.pow(10, frac.length)) : 0;
      markers.push(mins * 60000 + secs * 1000 + ms);
    }
    if (!markers.length) continue;
    const payload = line.replace(LRC_RE, '').trim();
    for (const ms of markers) {
      if (payload) lines.push([ms, payload]);
    }
  }
  lines.sort(function (a, b) { return a[0] - b[0]; });
  return lines.map(function (x, i) {
    const end = i + 1 < lines.length ? lines[i + 1][0] : x[0] + 8000;
    return { startTimeMs: x[0], endTimeMs: end, text: x[1] };
  });
}

async function getTimedLyrics(artist, title) {
  if (!title) return null;
  const cleanArtist = String(artist || '').replace(/\s*[\[(].*$/, '').trim();
  const cleanTitle = String(title || '').replace(/\s*[\[(].*$/, '').trim();
  const q = (cleanArtist + ' ' + cleanTitle).trim();

  function fn() {
    return fetchJson('https://lrclib.net/api/search?q=' + encodeURIComponent(q), {
      headers: { 'User-Agent': 'JoFiMusic/2.0' },
      timeout: 15000
    }).then(function (items) {
      if (!Array.isArray(items)) return null;
      for (const it of items) {
        if (it.instrumental || !it.syncedLyrics) continue;
        const ln = parseLrc(it.syncedLyrics);
        if (ln.length) return { source: 'lrclib', lines: ln, plain: it.plainLyrics || '' };
      }
      return null;
    }).catch(function (e) {
      log('lrclib error: ' + String(e.message || e));
      return null;
    });
  }
  return cached('lyrics_timed', 'lrc:' + q.toLowerCase(), fn);
}

function writeErrorFile(entry) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'error.log'), JSON.stringify(entry) + '\n');
  } catch (e) { /* noop */ }
}

function fetchJson(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, (opts && opts.timeout) || 20000);
  return fetch(url, { headers: (opts && opts.headers) || {}, signal: controller.signal })
    .then(function (r) { return r.json(); })
    .finally(function () { clearTimeout(timer); });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm'
};
const COMPRESSIBLE = ['.html', '.css', '.js', '.json', '.svg', '.webmanifest', '.txt'];

function sendJson(res, data, status) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendStatic(res, req, fname) {
  let ctype = MIME[path.extname(fname).toLowerCase()] || 'application/octet-stream';
  let data = fs.readFileSync(fname);
  let enc = null;
  const ext = path.extname(fname).toLowerCase();
  if (COMPRESSIBLE.indexOf(ext) >= 0 && data.length >= 512) {
    const accept = (req.headers['accept-encoding'] || '');
    if (accept.indexOf('gzip') >= 0) {
      enc = 'gzip';
      data = zlib.gzipSync(data, { level: 6 });
    }
  }
  const headers = {
    'Content-Type': ctype,
    'Content-Length': data.length,
    'Cache-Control': 'no-cache'
  };
  if (enc) {
    headers['Content-Encoding'] = enc;
    headers['Vary'] = 'Accept-Encoding';
  }
  res.writeHead(200, headers);
  res.end(data);
}

function serveStatic(req, res, urlPath) {
  urlPath = urlPath || '/';
  if (urlPath === '/') urlPath = '/index.html';
  const base = APP_DIST;
  let candidate = path.normalize(path.join(base, urlPath.replace(/^\/+/, '')));
  let candidates = [candidate];
  if (!isFile(candidate) && isFile(path.join(base, 'index.html')) &&
    String(urlPath).split('/').pop().indexOf('.') < 0) {
    candidates.push(path.join(base, 'index.html'));
  }
  if (!fs.existsSync(base)) {
    candidates.unshift(path.normalize(path.join(ROOT, urlPath.replace(/^\/+/, ''))));
  }
  for (const f of candidates) {
    try {
      const resolved = fs.realpathSync(f);
      const guard = fs.existsSync(base) ? APP_DIST : ROOT;
      if (resolved.indexOf(path.resolve(guard)) !== 0 && resolved !== path.resolve(guard)) continue;
      if (fs.lstatSync(resolved).isFile()) {
        sendStatic(res, req, resolved);
        return;
      }
    } catch (e) { /* keep scanning */ }
  }
  sendJson(res, { ok: false, error: 'no encontrado' }, 404);
}

function isFile(p) {
  try { return fs.lstatSync(p).isFile(); } catch (e) { return false; }
}

function proxyAudio(req, res, url) {
  const range = req.headers.range || 'bytes=0-';
  const upReq = https.get(url, {
    headers: { 'User-Agent': MOBILE_UA, 'Range': range }
  }, function (up) {
    const headers = {
      'Accept-Ranges': 'bytes',
      'Content-Type': up.headers['content-type'] || 'audio/mp4',
      'Access-Control-Allow-Origin': '*'
    };
    if (up.headers['content-length']) headers['Content-Length'] = up.headers['content-length'];
    if (up.headers['content-range']) headers['Content-Range'] = up.headers['content-range'];
    res.writeHead(up.statusCode === 206 ? 206 : 200, headers);
    up.pipe(res);
  });
  upReq.on('error', function (e) {
    log('proxy error: ' + (e && e.message));
    if (!res.headersSent) {
      res.writeHead(502);
      res.end(String((e && e.message) || e));
    } else {
      res.destroy();
    }
  });
  req.on('close', function () { try { upReq.abort(); } catch (e) { /* noop */ } });
}

function proxyImage(req, res, url) {
  const upReq = https.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://music.youtube.com/',
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
    }
  }, function (up) {
    const ctype = up.headers['content-type'] || 'image/jpeg';
    if (String(ctype).toLowerCase().indexOf('image/') !== 0) {
      res.destroy();
      return;
    }
    const chunks = [];
    let total = 0;
    up.on('data', function (c) {
      total += c.length;
      if (total > 8 * 1024 * 1024) { up.destroy(); return; }
      chunks.push(c);
    });
    up.on('end', function () {
      const body = Buffer.concat(chunks);
      res.writeHead(200, {
        'Content-Type': ctype,
        'Content-Length': body.length,
        'Cache-Control': 'public, max-age=86400'
      });
      res.end(body);
    });
    up.on('error', function () { res.destroy(); });
  });
  upReq.on('error', function (e) {
    log('image proxy error: ' + (e && e.message));
    sendJson(res, { ok: false, error: 'no se pudo cargar la portada' }, 502);
  });
  req.on('close', function () { try { upReq.abort(); } catch (e) { /* noop */ } });
}

function parseQuery(url) {
  const out = {};
  const raw = String(url).split('?')[1];
  if (!raw) return out;
  raw.split('&').forEach(function (kv) {
    const i = kv.indexOf('=');
    const k = i < 0 ? kv : kv.slice(0, i);
    const v = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
    (out[k] = out[k] || []).push(v);
  });
  return out;
}

function first(q, key, fallback) {
  const v = q[key] || [];
  return (v[0] === undefined ? fallback : v[0]);
}

async function handleGet(req, res, pathname, query) {
  try {
    if (pathname === '/api/charts') {
      const data = await getCharts();
      sendJson(res, Object.assign({ ok: true }, data));
      return;
    }
    if (pathname === '/api/search') {
      const qs = first(query, 'q', '');
      if (!qs) {
        sendJson(res, { ok: false, error: 'sin query' }, 400);
        return;
      }
      const data = await searchMusic(qs);
      sendJson(res, { ok: true, songs: data });
      return;
    }
    if (pathname === '/api/song') {
      const vid = first(query, 'id', '');
      if (!vid) {
        sendJson(res, { ok: false, error: 'sin id' }, 400);
        return;
      }
      const refresh = first(query, 'refresh', '0') === '1';
      const url = await streamUrl(vid, refresh);
      sendJson(res, { ok: true, videoId: vid, url: url });
      return;
    }
    if (pathname === '/api/lyrics') {
      const vid = first(query, 'id', '');
      if (!vid) {
        sendJson(res, { ok: false, error: 'sin id' }, 400);
        return;
      }
      const text = await getLyrics(vid);
      if (text) sendJson(res, { ok: true, lyrics: text });
      else sendJson(res, { ok: false, error: 'sin letras' }, 404);
      return;
    }
    if (pathname === '/api/lyrics/timed') {
      const artist = first(query, 'artist', '');
      const title = first(query, 'title', '');
      if (!title) {
        sendJson(res, { ok: false, error: 'sin titulo' }, 400);
        return;
      }
      const data = await getTimedLyrics(artist, title);
      if (data && data.lines && data.lines.length) sendJson(res, Object.assign({ ok: true }, data));
      else sendJson(res, { ok: false, error: 'sin letras sincronizadas' }, 404);
      return;
    }
    if (pathname === '/api/audio') {
      const u = first(query, 'u', '');
      if (String(u).indexOf('https://') !== 0 || String(u).indexOf('googlevideo') < 0) {
        sendJson(res, { ok: false, error: 'url invalida' }, 400);
        return;
      }
      proxyAudio(req, res, u);
      return;
    }
    if (pathname === '/api/image') {
      const u = first(query, 'u', '');
      let parsed = null;
      try { parsed = new URL(u); } catch (e) { parsed = null; }
      const host = (parsed && parsed.hostname) || '';
      const allowed = ['googleusercontent.com', 'ggpht.com', 'ytimg.com']
        .some(function (d) { return host === d || host.endsWith('.' + d); });
      if (!parsed || parsed.protocol !== 'https:' || !allowed) {
        sendJson(res, { ok: false, error: 'imagen invalida' }, 400);
        return;
      }
      proxyImage(req, res, u);
      return;
    }
  } catch (e) {
    log('API error en ' + pathname + ': ' + (e && e.stack ? e.stack : String(e)));
    sendJson(res, { ok: false, error: String((e && e.message) || e) }, 502);
    return;
  }
  serveStatic(req, res, pathname);
}

function handlePost(req, res, pathname) {
  if (pathname !== '/api/log') {
    sendJson(res, { ok: false, error: 'no encontrado' }, 404);
    return;
  }
  let body = '';
  req.on('data', function (c) { body += c; });
  req.on('end', function () {
    let entry = {};
    try { entry = JSON.parse(body || '{}'); } catch (e) { /* noop */ }
    if (entry.level === 'error' || entry.level === 'warn') {
      writeErrorFile(entry);
      if (entry.level === 'error') {
        log('client log: ' + String(entry.msg || '').slice(0, 160));
      }
    }
    sendJson(res, { ok: true });
  });
}

function handler(req, res) {
  const parsedUrl = new URL(req.url, 'http://' + hostHeader(req));
  const pathname = parsedUrl.pathname;
  const query = parseQuery(req.url);
  if (req.method === 'POST') {
    handlePost(req, res, pathname);
    return;
  }
  handleGet(req, res, pathname, query).catch(function (e) {
    log('unhandled error: ' + String(e && e.stack ? e.stack : e));
    sendJson(res, { ok: false, error: 'error interno' }, 500);
  });
}

function hostHeader(req) {
  return req.headers.host || (HOST + ':' + PORT);
}

function lanIps() {
  const found = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach(function (name) {
    (nets[name] || []).forEach(function (n) {
      if (n.family === 'IPv4' && !n.internal) found.push(n.address);
    });
  });
  return found;
}

loadDeps();
cacheLoad();

const server = http.createServer(handler);
server.on('clientError', function (err, socket) {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e) { /* noop */ }
});

server.listen(PORT, HOST, function () {
  const line = Array(58).join('=');
  console.log(line);
  console.log('  JoFi Music v2 (Node port) - youtubei.js + ytdl-core');
  console.log('  Este telefono: http://localhost:' + PORT);
  lanIps().forEach(function (ip) {
    console.log('  Tu red:        http://' + ip + ':' + PORT + '   (misma red Wi-Fi)');
  });
  console.log(line);
  globalThis.__pocketShutdown = function () {
    try {
      cacheFlush();
    } catch (e) { /* noop */ }
    try {
      server.close();
      if (server.closeAllConnections) server.closeAllConnections();
    } catch (e) { /* noop */ }
  };
});
server.on('error', function (e) {
  log('server error: ' + (e && e.message));
  if (globalThis.__pocketShutdown) globalThis.__pocketShutdown();
});