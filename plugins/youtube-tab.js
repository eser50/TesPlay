import { registerTab } from '/tab-registry.js';

const root = () => document.getElementById('pluginTabRoot');
const el = (tag, props = {}, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; };

function card(item, play) {
  const button = el('button', { className: 'yt-card', type: 'button', title: item.title, onclick: () => play(item) },
    el('img', { alt: '', loading: 'lazy', src: item.thumbnail }),
    el('span', { className: 'yt-title', textContent: item.title }),
    el('span', { className: 'yt-channel', textContent: item.channel }));
  return button;
}

async function load(url) {
  const response = await fetch(url, { credentials: 'same-origin' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'YouTube request failed');
  return body;
}

function show({ items, embedHost }) {
  const host = root();
  host.replaceChildren();
  const style = el('style', { textContent: '.yt-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;padding:16px}.yt-card{background:none;border:0;color:inherit;text-align:left;cursor:pointer}.yt-card img{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:8px}.yt-title{display:block;margin-top:6px;font-weight:600}.yt-channel{display:block;opacity:.7;font-size:.9em}.yt-player{position:fixed;inset:0;z-index:50;background:#000;display:flex;flex-direction:column}.yt-player iframe{flex:1;border:0}.yt-bar{display:flex;justify-content:space-between;align-items:center}.yt-open{color:#fff;padding:12px;font-size:1.1em}.yt-close{padding:12px;font-size:1.1em}.yt-msg{padding:24px}' });
  const grid = el('div', { className: 'yt-grid' });
  const play = item => {
    const frame = el('iframe', { allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen', allowFullscreen: true, referrerPolicy: 'strict-origin-when-cross-origin', title: item.title });
    frame.src = `https://${embedHost}/embed/${encodeURIComponent(item.id)}?autoplay=1&rel=0&playsinline=1`;
    const bar = el('div', { className: 'yt-bar' }, el('button', { className: 'yt-close', type: 'button', textContent: '← Back', onclick: () => overlay.remove() }), el('a', { className: 'yt-open', href: `https://www.youtube.com/watch?v=${encodeURIComponent(item.id)}`, target: '_blank', rel: 'noopener noreferrer', textContent: 'Open in YouTube' }));
    const overlay = el('div', { className: 'yt-player' }, bar, frame);
    document.body.append(overlay);
  };
  for (const item of items) grid.append(card(item, play));
  host.append(style, items.length ? grid : el('p', { className: 'yt-msg', textContent: 'No videos found.' }));
}

const fail = error => { root().replaceChildren(el('p', { className: 'yt-msg', textContent: error.message })); };

registerTab({
  id: 'youtube',
  label: 'YouTube',
  onOpen: () => load('/api/youtube/trending').then(show, fail),
  onClose: () => { root().replaceChildren(); document.querySelector('.yt-player')?.remove(); },
  onSearch: query => load(`/api/youtube/search?q=${encodeURIComponent(query)}`).then(show, fail),
});
