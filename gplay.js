// ---------- Constants ----------
// Public CORS proxies used as a fallback chain. GitHub Pages is static, so we
// cannot host our own proxy — these are best-effort and may be rate-limited or
// blocked outright by Google. If all fail, the user can paste HTML manually.
const CORS_PROXIES = [
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`,
  (url) => `https://cors.eu.org/${url}`,
  (url) => `https://thingproxy.freeboard.io/fetch/${url}`,
  (url) => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}&raw=true`,
];

// Extracts full googleusercontent image URLs from the album HTML.
// Sample tokens found in the payload:
//   https://lh3.googleusercontent.com/pw/AP1GczN...=w1920-h1080
//   https://lh3.googleusercontent.com/a-/AOh14G...
// We drop any trailing size spec (=w..., =s..., =-...) and reapply our own.
const IMG_URL_REGEX = /https:\/\/lh3\.googleusercontent\.com\/[A-Za-z0-9_\-]+(?:\/[A-Za-z0-9_\-]+)*/g;

const VALID_HOSTS = ['photos.app.goo.gl', 'photos.google.com'];
const RENDER_SIZE = 'w2000-h1400'; // Google resizes on demand; keep aspect ratio.

// ---------- DOM ----------
const setupDiv = document.getElementById('setupDiv');
const slideshow = document.getElementById('slideshow');
const albumUrlInput = document.getElementById('albumUrl');
const intervalInput = document.getElementById('intervalInput');
const autoplayInput = document.getElementById('autoplayInput');
const loopInput = document.getElementById('loopInput');
const loadBtn = document.getElementById('loadBtn');
const statusMsg = document.getElementById('statusMsg');

const stage = document.getElementById('stage');
const slideImg = document.getElementById('slideImg');
const prevBtn = document.getElementById('prevBtn');
const playBtn = document.getElementById('playBtn');
const nextBtn = document.getElementById('nextBtn');
const fsBtn = document.getElementById('fsBtn');
const backBtn = document.getElementById('backBtn');
const counterText = document.getElementById('counterText');

const manualDetails = document.getElementById('manualDetails');
const manualInput = document.getElementById('manualInput');
const manualBtn = document.getElementById('manualBtn');

// ---------- State ----------
const state = {
  urls: [],
  index: 0,
  playing: false,
  intervalMs: 4000,
  loop: true,
  timer: null,
};

// ---------- Status helpers ----------
function setStatus(kind, message) {
  statusMsg.className = kind;
  statusMsg.textContent = message;
  statusMsg.classList.remove('hidden');
}
function clearStatus() {
  statusMsg.classList.add('hidden');
  statusMsg.textContent = '';
}

// ---------- URL validation ----------
function validateAlbumUrl(raw) {
  let url;
  try {
    url = new URL(raw.trim());
  } catch (_) {
    return { ok: false, error: 'That does not look like a valid URL.' };
  }
  if (!VALID_HOSTS.includes(url.hostname)) {
    return {
      ok: false,
      error: 'Expected a photos.app.goo.gl or photos.google.com/share/... link.',
    };
  }
  return { ok: true, url: url.toString() };
}

// ---------- Fetch via CORS proxy chain ----------
async function fetchThroughProxy(albumUrl) {
  const errors = [];
  for (const buildProxyUrl of CORS_PROXIES) {
    const proxied = buildProxyUrl(albumUrl);
    try {
      const response = await fetch(proxied, { redirect: 'follow' });
      if (!response.ok) {
        errors.push(`${new URL(proxied).host}: HTTP ${response.status}`);
        continue;
      }
      const text = await response.text();
      if (text && text.length > 500) {
        return text;
      }
      errors.push(`${new URL(proxied).host}: empty response`);
    } catch (err) {
      errors.push(`${new URL(proxied).host}: ${err.message}`);
    }
  }
  throw new Error(`All CORS proxies failed. ${errors.join(' | ')}`);
}

// ---------- Parse image URLs from album HTML ----------
function extractImageUrls(html) {
  const matches = html.match(IMG_URL_REGEX) || [];

  // Preserve first-occurrence order (matches album order in the embedded data)
  // and strip any prior size spec so we can apply a consistent one.
  const seen = new Set();
  const ordered = [];
  for (const raw of matches) {
    const base = raw.split('=')[0];
    // Skip profile / avatar assets (path segment `a/` or `a-/`).
    if (/\/a[-/]/.test(base)) continue;
    if (seen.has(base)) continue;
    seen.add(base);
    ordered.push(`${base}=${RENDER_SIZE}`);
  }
  return ordered;
}

// Parses the manual textarea: either a list of image URLs (one per line) or
// raw HTML pasted from view-source. Falls through to the same extractor.
function extractFromManualInput(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const looksLikeUrlList = lines.every((l) => /^https?:\/\//i.test(l));

  if (looksLikeUrlList) {
    const seen = new Set();
    const ordered = [];
    for (const url of lines) {
      const base = url.split('=')[0];
      if (seen.has(base)) continue;
      seen.add(base);
      ordered.push(/lh3\.googleusercontent\.com/.test(base) ? `${base}=${RENDER_SIZE}` : base);
    }
    return ordered;
  }

  return extractImageUrls(trimmed);
}

// ---------- Slideshow control ----------
function showSlide(newIndex) {
  if (state.urls.length === 0) return;

  let i = newIndex;
  if (i < 0) i = state.loop ? state.urls.length - 1 : 0;
  if (i >= state.urls.length) {
    if (state.loop) {
      i = 0;
    } else {
      i = state.urls.length - 1;
      pause();
    }
  }
  state.index = i;
  slideImg.classList.add('loading');
  slideImg.src = state.urls[i];
  slideImg.onload = () => slideImg.classList.remove('loading');
  slideImg.onerror = () => slideImg.classList.remove('loading');

  // Preload the next image for smoother transitions.
  const nextIdx = (i + 1) % state.urls.length;
  if (state.urls[nextIdx]) {
    const preload = new Image();
    preload.src = state.urls[nextIdx];
  }

  counterText.textContent = `${i + 1} / ${state.urls.length}`;
}

function next() { showSlide(state.index + 1); restartTimerIfPlaying(); }
function prev() { showSlide(state.index - 1); restartTimerIfPlaying(); }

function play() {
  state.playing = true;
  playBtn.textContent = '❚❚';
  playBtn.title = 'Pause (Space)';
  restartTimerIfPlaying();
}
function pause() {
  state.playing = false;
  playBtn.textContent = '▶';
  playBtn.title = 'Play (Space)';
  clearInterval(state.timer);
  state.timer = null;
}
function togglePlay() { state.playing ? pause() : play(); }

function restartTimerIfPlaying() {
  clearInterval(state.timer);
  if (!state.playing) return;
  state.timer = setInterval(() => showSlide(state.index + 1), state.intervalMs);
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else if (stage.requestFullscreen) {
    stage.requestFullscreen();
  }
}

// ---------- Load flow ----------
function startSlideshowWith(urls) {
  state.urls = urls;
  state.index = 0;
  state.intervalMs = Math.max(1, parseInt(intervalInput.value, 10) || 4) * 1000;
  state.loop = loopInput.checked;

  setStatus('success', `Loaded ${urls.length} photo${urls.length === 1 ? '' : 's'}.`);
  setupDiv.classList.add('hidden');
  slideshow.classList.remove('hidden');

  showSlide(0);
  if (autoplayInput.checked) play(); else pause();
}

async function loadAlbum() {
  clearStatus();
  const validated = validateAlbumUrl(albumUrlInput.value);
  if (!validated.ok) {
    setStatus('error', validated.error);
    return;
  }

  loadBtn.disabled = true;
  loadBtn.textContent = '> Loading album...';
  setStatus('info', 'Fetching album through a public CORS proxy...');

  try {
    const html = await fetchThroughProxy(validated.url);
    const urls = extractImageUrls(html);

    if (urls.length === 0) {
      setStatus(
        'error',
        'No photos found. Make sure the album is shared publicly (anyone with the link can view). ' +
        'If it is public, the proxy may have returned a bot-check page — try the manual paste option below.',
      );
      manualDetails.open = true;
      return;
    }

    startSlideshowWith(urls);
  } catch (err) {
    console.error(err);
    setStatus(
      'error',
      'Auto-fetch failed — public CORS proxies are down or blocked by Google. ' +
      'Use the manual paste option below to continue. ' +
      `Details: ${err.message}`,
    );
    manualDetails.open = true;
  } finally {
    loadBtn.disabled = false;
    loadBtn.textContent = '> Load slideshow';
  }
}

function loadFromManual() {
  clearStatus();
  const urls = extractFromManualInput(manualInput.value);
  if (urls.length === 0) {
    setStatus(
      'error',
      'Nothing extracted. Paste the full view-source HTML of the album page, ' +
      'or one https://lh3.googleusercontent.com/... URL per line.',
    );
    return;
  }
  startSlideshowWith(urls);
}

function backToSetup() {
  pause();
  slideshow.classList.add('hidden');
  setupDiv.classList.remove('hidden');
  slideImg.removeAttribute('src');
  state.urls = [];
  state.index = 0;
  clearStatus();
}

// ---------- Event wiring ----------
loadBtn.addEventListener('click', loadAlbum);
manualBtn.addEventListener('click', loadFromManual);
albumUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadAlbum();
});
prevBtn.addEventListener('click', prev);
nextBtn.addEventListener('click', next);
playBtn.addEventListener('click', togglePlay);
fsBtn.addEventListener('click', toggleFullscreen);
backBtn.addEventListener('click', backToSetup);

document.addEventListener('keydown', (e) => {
  if (slideshow.classList.contains('hidden')) return;
  switch (e.key) {
    case 'ArrowRight': next(); break;
    case 'ArrowLeft':  prev(); break;
    case ' ':          e.preventDefault(); togglePlay(); break;
    case 'f':
    case 'F':          toggleFullscreen(); break;
    case 'Escape':     if (!document.fullscreenElement) backToSetup(); break;
  }
});

// Basic touch swipe navigation on the stage.
let touchStartX = null;
stage.addEventListener('touchstart', (e) => {
  touchStartX = e.changedTouches[0].screenX;
}, { passive: true });
stage.addEventListener('touchend', (e) => {
  if (touchStartX === null) return;
  const delta = e.changedTouches[0].screenX - touchStartX;
  touchStartX = null;
  if (Math.abs(delta) < 40) return;
  delta < 0 ? next() : prev();
}, { passive: true });
