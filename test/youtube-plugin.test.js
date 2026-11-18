import test from 'node:test';
import assert from 'node:assert/strict';
import { createYoutubePlugin } from '../plugins/youtube-plugin.js';

const search = { items: [
  { id: { videoId: 'dQw4w9WgXcQ' }, snippet: { title: 'Song', channelTitle: 'Chan', thumbnails: { medium: { url: 'https://i.ytimg.com/vi/x/mq.jpg' } } } },
  { id: { videoId: 'bad id!' }, snippet: { title: 'Rejected' } },
  { id: { channelId: 'UC1' }, snippet: { title: 'Not a video' } },
] };

function setup(extra = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url: new URL(url), options }); return Response.json(extra.body || search, { status: extra.status || 200 }); };
  const plugin = createYoutubePlugin({ env: { YOUTUBE_API_KEY: 'secret-key', ...extra.env }, fetchImpl, now: () => extra.now?.() ?? 0 });
  return { plugin, calls };
}

test('is inert without an API key', () => {
  const plugin = createYoutubePlugin({ env: {} });
  assert.equal(plugin.enabled, false);
  assert.equal(plugin.registerRoutes, undefined);
});

test('search keeps only valid video ids and sends the key in a header', async () => {
  const { plugin, calls } = setup();
  const items = await plugin.search('cats');
  assert.deepEqual(items.map(item => item.id), ['dQw4w9WgXcQ']);
  assert.equal(calls[0].options.headers['x-goog-api-key'], 'secret-key');
  assert.ok(!calls[0].url.toString().includes('secret-key'));
  assert.equal(calls[0].url.searchParams.get('q'), 'cats');
});

test('results are cached for five minutes', async () => {
  let time = 0;
  const { plugin, calls } = setup({ now: () => time });
  await plugin.search('cats'); await plugin.search('cats');
  assert.equal(calls.length, 1);
  time = 5 * 60 * 1000 + 1;
  await plugin.search('cats');
  assert.equal(calls.length, 2);
});

test('trending uses the configured region, defaulting to US', async () => {
  const a = setup({ body: { items: [{ id: 'dQw4w9WgXcQ', snippet: { title: 'T' }, contentDetails: { duration: 'PT1M' } }] } });
  assert.equal((await a.plugin.trending())[0].duration, 'PT1M');
  assert.equal(a.calls[0].url.searchParams.get('regionCode'), 'US');
  const b = setup({ env: { YOUTUBE_REGION: 'gb' }, body: { items: [] } });
  await b.plugin.trending();
  assert.equal(b.calls[0].url.searchParams.get('regionCode'), 'GB');
});

test('routes validate input and hide upstream errors', async () => {
  const { plugin } = setup({ status: 403, body: { error: 'private detail' } });
  const routes = new Map();
  plugin.registerRoutes({ get: (path, ...handlers) => routes.set(path, handlers.at(-1)) }, { rateLimit: () => (_req, _res, next) => next() });
  const run = async (path, query = {}) => {
    const out = {}; const res = { set() { return res; }, status(code) { out.status = code; return res; }, json(body) { out.body = body; return res; } };
    await routes.get(path)({ query }, res); return out;
  };
  assert.equal((await run('/api/youtube/search')).status, 400);
  const quota = await run('/api/youtube/search', { q: 'cats' });
  assert.equal(quota.status, 429);
  assert.ok(!JSON.stringify(quota.body).includes('private detail'));
});
