// YouTube tab for a signed-in session: search and trending through the YouTube
// Data API v3, playback through YouTube's own embedded player (the video never
// passes through this server). Enabled only when YOUTUBE_API_KEY is set.
//
//   FREESTUFFCRAZY_PLUGIN_MODULES=/app/plugins/youtube-plugin.js
//   YOUTUBE_API_KEY=...   (restrict the key to YouTube Data API v3)
//   YOUTUBE_REGION=US     (optional, ISO country code for Trending)
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const API = 'https://www.googleapis.com/youtube/v3';
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CACHE_MS = 5 * 60 * 1000; // protects the 10,000 units/day quota (search costs 100)
const CACHE_MAX = 200;
const FRONTEND = fileURLToPath(new URL('./youtube-tab.js', import.meta.url));

export const toItem = (id, snippet = {}, details = {}) => ({
  id,
  title: String(snippet.title || '').slice(0, 200),
  channel: String(snippet.channelTitle || '').slice(0, 100),
  published: snippet.publishedAt || null,
  thumbnail: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
  duration: details.duration || null,
});

export function createYoutubePlugin({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const key = env.YOUTUBE_API_KEY?.trim();
  if (!key) return { enabled: false };
  const region = /^[A-Za-z]{2}$/.test(env.YOUTUBE_REGION || '') ? env.YOUTUBE_REGION.toUpperCase() : 'US';
  // youtube-nocookie ignores your YouTube login; www.youtube.com lets the embed
  // use it (so Premium can apply). security.js allows the same two hosts only.
  const embedHost = env.YOUTUBE_EMBED_HOST === 'www.youtube.com' ? 'www.youtube.com' : 'www.youtube-nocookie.com';
  const cache = new Map();

  async function call(path, params) {
    const url = new URL(`${API}/${path}`);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    const cacheKey = url.toString();
    const hit = cache.get(cacheKey);
    if (hit && hit.until > now()) return hit.value;
    // The key travels in a header, never in the URL, so it cannot reach logs.
    const response = await fetchImpl(url, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw Object.assign(new Error(`YouTube API ${response.status}`), { status: response.status });
    const value = await response.json();
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, { value, until: now() + CACHE_MS });
    return value;
  }

  async function search(q) {
    const found = await call('search', { part: 'snippet', type: 'video', maxResults: '24', safeSearch: 'moderate', q });
    return (found.items || []).filter(item => VIDEO_ID.test(item.id?.videoId || '')).map(item => toItem(item.id.videoId, item.snippet));
  }

  async function trending() {
    const found = await call('videos', { part: 'snippet,contentDetails', chart: 'mostPopular', maxResults: '24', regionCode: region });
    return (found.items || []).filter(item => VIDEO_ID.test(item.id || '')).map(item => toItem(item.id, item.snippet, item.contentDetails));
  }

  return {
    enabled: true,
    embedHost,
    search, trending,
    registerRoutes(app, context) {
      const limit = context.rateLimit({ maximum: 60, windowMs: 60000 });
      const respond = work => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { res.json({ items: await work(req), embedHost }); }
        catch (error) { res.status(error.status === 403 ? 429 : 502).json({ error: error.status === 403 ? 'YouTube quota exhausted or key rejected' : 'YouTube is unavailable' }); }
      };
      app.get('/api/youtube/search', limit, (req, res) => {
        const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
        if (!q) return res.status(400).json({ error: 'q required' });
        return respond(() => search(q))(req, res);
      });
      app.get('/api/youtube/trending', limit, respond(() => trending()));
      app.get('/plugins/youtube-tab.js', async (_req, res) => {
        res.type('application/javascript').set('Cache-Control', 'no-cache').send(await readFile(FRONTEND, 'utf8'));
      });
    },
    getFrontendAssets() { return { scripts: ['/plugins/youtube-tab.js'] }; },
  };
}

// An inert plugin (no routes, no assets) when no key is configured, so the
// module can stay in FREESTUFFCRAZY_PLUGIN_MODULES harmlessly.
export default createYoutubePlugin();
