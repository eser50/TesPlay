import crypto from 'node:crypto';
import { readdirSync, readFileSync, createWriteStream, statSync, renameSync } from 'node:fs';
import path from 'node:path';

export function parseCookies(header = '') {
  const result = Object.create(null);
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    try { result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim()); }
    catch { /* Invalid cookies are unauthenticated, not server errors. */ }
  }
  return result;
}

export function createLoginTransactions({ now = Date.now, ttl = 600000, maximum = 1000 } = {}) {
  const entries = new Map();
  const prune = () => { for (const [key, entry] of entries) if (entry.expires <= now()) entries.delete(key); };
  return {
    issue(pinId, browserState) {
      prune();
      if (entries.size >= maximum) throw new Error('Too many pending sign-ins');
      entries.set(String(pinId), { browserState, expires: now() + ttl, busy: false });
    },
    async run(pinId, browserState, operation) {
      prune();
      const key = String(pinId);
      const entry = entries.get(key);
      if (!browserState || entry?.browserState !== browserState || entry.busy) throw new Error('Sign-in session expired or invalid');
      entry.busy = true;
      try {
        return await operation(entry, () => entries.delete(key));
      } finally { entry.busy = false; }
    },
  };
}

export function rateLimit({ maximum, windowMs = 60000, now = Date.now, maxKeys = 10000 }) {
  const buckets = new Map();
  return (req, res, next) => {
    const time = now();
    for (const [key, entry] of buckets) if (entry.until <= time) buckets.delete(key);
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    let entry = buckets.get(key);
    if (!entry) {
      if (buckets.size >= maxKeys) return res.status(429).json({ error: 'Too many requests' });
      entry = { count: 0, until: time + windowMs }; buckets.set(key, entry);
    }
    if (++entry.count > maximum) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((entry.until - time) / 1000))));
      return res.status(429).json({ error: 'Too many requests; try again shortly' });
    }
    next();
  };
}

// Append-only request log for spotting break-in attempts (repeated 401s/403s,
// scans for nonexistent paths, etc). Deliberately logs method/path/status/UA
// only -- never query strings, cookies or auth headers, so an
// accidentally-shared log can't leak a session or a Plex token.
const ACCESS_LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOGGED_PAGES = new Set(['/', '/login', '/browse', '/canvas2', '/canvas', '/detail', '/admin', '/link']);
// Background posts a player sends every few seconds while it plays.
const HEARTBEAT_POSTS = /^\/(api\/)?(playback\/(usage|canvas-health)|(plex\/|library\/)?progress)$/;

// In production the log answers who came and what failed, not every thumbnail,
// heartbeat and media segment: errors, page loads, playback starts and
// everything a viewer did on purpose. Outside production everything is kept.
export function worthLogging({ method, path, status }) {
  if (status >= 400) return true;
  if (method === 'GET' || method === 'HEAD') return LOGGED_PAGES.has(path) || path === '/api/start';
  return !HEARTBEAT_POSTS.test(path);
}

// A stream's session ID is only a path segment, but there is no reason to keep it.
const maskSession = path => path.replace(/\/session\/[^/]+\//, '/session/-/');

// The file never grows past about twice maxBytes: when it is full it becomes
// access.1.log (replacing the one before) and a new one starts.
export function accessLog(logPath, { production = process.env.NODE_ENV === 'production', maxBytes = ACCESS_LOG_MAX_BYTES } = {}) {
  const rotatedPath = logPath.replace(/\.log$/, '.1.log');
  let size = 0;
  try { size = statSync(logPath).size; } catch { /* a new file */ }
  const open = () => {
    const next = createWriteStream(logPath, { flags: 'a' });
    next.on('error', (err) => console.error('Access log write failed:', err.message));
    return next;
  };
  let stream = open();
  function rotate() {
    stream.end();
    try { renameSync(logPath, rotatedPath); } catch (err) { if (err.code !== 'ENOENT') console.error('Access log rotation failed:', err.message); }
    stream = open();
    size = 0;
  }
  const middleware = (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      // The full path (a router sees only its own part of it).
      const urlPath = maskSession((req.originalUrl || req.url || '').split('?')[0]);
      if (production && !worthLogging({ method: req.method, path: urlPath, status: res.statusCode })) return;
      const ua = (req.get('user-agent') || '-').replace(/[\r\n]/g, ' ');
      // Only the quality tier name from the query string -- never the full
      // query, which can carry item keys and other request details.
      const quality = urlPath === '/api/start' ? (req.query?.quality || 'high') : '-';
      const line = `${new Date().toISOString()} ${req.ip} ${req.method} ${urlPath} ${res.statusCode} ${Date.now() - start}ms quality=${quality} "${ua}"\n`;
      if (size >= maxBytes) rotate();
      stream.write(line);
      size += Buffer.byteLength(line);
    });
    next();
  };
  middleware.close = () => new Promise(resolve => stream.end(resolve));
  return middleware;
}

function scriptHashes(html) {
  const hashes = [];
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (match[1].trim()) hashes.push(`'sha256-${crypto.createHash('sha256').update(match[1]).digest('base64')}'`);
  }
  return hashes;
}

// Only the authenticated viewer's selected HTTPS server is eligible.
export function directPlexOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && !url.search && !url.hash && url.pathname === '/' ? url.origin : '';
  } catch { return ''; }
}

function buildPolicy(hashes, origin = '') {
  const external = origin ? ` ${origin}` : '';
  return `default-src 'self'; script-src 'self' ${hashes.join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' http: https: data:; media-src 'self' blob:${external}; connect-src 'self'${external}; worker-src 'self' blob:; frame-src https://www.youtube-nocookie.com${process.env.YOUTUBE_EMBED_HOST === 'www.youtube.com' ? ' https://www.youtube.com' : ''}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
}

export function securityHeaders(publicDir, { mediaOriginForRequest = () => '' } = {}) {
  // Page routes are served extensionless (/browse -> browse.html) via
  // express.static's `extensions` option, so this is the full set of
  // basenames that could actually be an inline-script-bearing page.
  const pageNames = new Set(
    readdirSync(publicDir).filter(name => name.endsWith('.html')).map(name => name.slice(0, -'.html'.length))
  );
  // Every other request (API calls, proxied segments, JS/CSS/image
  // assets) never carries an inline script, so it gets this fixed,
  // hash-free policy computed once -- no per-request file I/O for the
  // dozens of such requests one page load triggers.
  const basePolicy = buildPolicy([]);

  return (req, res, next) => {
    let policy = basePolicy;
    const name = path.basename(req.path, '.html');
    if (pageNames.has(name)) {
      // Re-read and re-hash this one page fresh on every request, so an
      // edit to its inline script takes effect on the next reload with no
      // server restart. Safe to redo every time: full-page navigations
      // are rare next to the asset/API requests above, which skip this
      // entirely, and a read failure just falls back to the hash-free
      // baseline (blocking any inline script on that response, not the
      // whole page).
      try {
        const origin = name === 'canvas2' ? directPlexOrigin(mediaOriginForRequest(req)) : '';
        policy = buildPolicy(scriptHashes(readFileSync(path.join(publicDir, `${name}.html`), 'utf8')), origin);
        if (name === 'canvas2') res.set('Cache-Control', 'private, no-store');
      } catch { /* keep basePolicy */ }
    }
    res.set({ 'Content-Security-Policy': policy, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
    if (req.path.startsWith('/api/') || req.path.startsWith('/proxy/')) res.set('Cache-Control', 'no-store');
    next();
  };
}

// extraMutatingPaths is a live Set, not a snapshot -- a route registered
// after this middleware (e.g. by a plugin) can still add to it.
export function sameOriginRequests(origin, extraMutatingPaths = new Set()) {
  return (req, res, next) => {
    // Express routes are case-insensitive and allow a trailing slash by default.
    // Match those semantics, including paths added by a plugin after startup.
    const canonical = path => path.toLowerCase().replace(/\/+$/, '') || '/';
    const statefulPath = [...extraMutatingPaths].some(path => canonical(path) === canonical(req.path));
    const mutates = !['GET', 'HEAD', 'OPTIONS'].includes(req.method) || statefulPath;
    if (!mutates) return next();
    const expected = origin || `${req.protocol}://${req.get('host')}`;
    if ((req.get('origin') && req.get('origin') !== expected)
      || ['cross-site', 'same-site'].includes(req.get('sec-fetch-site'))
      || (statefulPath && req.get('sec-fetch-mode') === 'navigate')) return res.status(403).json({ error: 'Cross-origin request denied' });
    next();
  };
}

export function avatarUrl(value, initial = false) {
  const url = new URL(value);
  const allowed = url.hostname === 'plex.tv' || (!initial && ['secure.gravatar.com', 'www.gravatar.com', 'gravatar.com', 'i0.wp.com', 'i1.wp.com', 'i2.wp.com'].includes(url.hostname));
  if (!allowed || url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password
    || (initial && !/^\/users\/[^/]+\/avatar\/?$/.test(url.pathname))) throw new Error('Invalid avatar URL');
  return url;
}

export async function fetchAvatar(value, fetcher = fetch) {
  let url = avatarUrl(value, true);
  const signal = AbortSignal.timeout(8000);
  for (let hop = 0; hop < 5; hop++) {
    const response = await fetcher(url, { redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('Invalid avatar redirect');
      url = avatarUrl(new URL(location, url));
      continue;
    }
    const type = response.headers.get('content-type')?.split(';')[0].trim();
    if (!response.ok || !response.body || !['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(type)) throw new Error('Invalid avatar response');
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 2 * 1024 * 1024) throw new Error('Avatar too large');
      chunks.push(chunk);
    }
    return { type, body: Buffer.concat(chunks) };
  }
  throw new Error('Too many avatar redirects');
}

export function mediaProxyPath(path, sessionId) {
  if (typeof path !== 'string' || /[%\\?#]/.test(path) || path.split('/').some(part => part === '.' || part === '..')) return false;
  return !!sessionId && path.startsWith(`video/:/transcode/universal/session/${sessionId}/`)
    && /^[\w/.:\-$]+$/.test(path);
}

export function safeError(error) {
  const message = error?.message;
  return ['Incorrect PIN', 'Not authenticated', 'Sign-in session expired or invalid', 'Too many pending sign-ins', 'Playback capacity reached', 'Playback time limit reached', 'Too many active streams for this account',
    'That server is not available to this account', 'That server is not reachable right now', 'None of your Plex servers are reachable right now'].includes(message)
    ? message : 'Request failed; please try again';
}
