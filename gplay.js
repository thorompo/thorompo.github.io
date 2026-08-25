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

// Only album photos are served under /pw/ (Photos Web). Avatars and other
// account assets use /a/, /a-/, /ogw/, etc. — a positive filter on /pw/ is
// far more reliable than trying to blacklist every avatar shape.
const IMG_URL_REGEX = /https:\/\/lh3\.googleusercontent\.com\/pw\/[A-Za-z0-9_\-]+/g;

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
const bookmarkletEl = document.getElementById('bookmarklet');

const recBtn = document.getElementById('recBtn');
const recIndicator = document.getElementById('recIndicator');
const recProgress = document.getElementById('recProgress');

// ---------- State ----------
const state = {
  urls: [],
  index: 0,
  playing: false,
  intervalMs: 4000,
  loop: true,
  timer: null,
  recording: false,
  recStopRequested: false,
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
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

// ---------- Bookmarklet ----------
// Runs on the Google Photos album page (where CORS doesn't apply because it
// runs in that origin) and hands the extracted URLs to GPlay via URL hash.
function buildBookmarkletHref() {
  const target = location.origin + location.pathname;
  const body =
    "(function(){" +
      "var re=/https:\\/\\/lh3\\.googleusercontent\\.com\\/pw\\/[A-Za-z0-9_\\-]+/g;" +
      "var m=document.documentElement.outerHTML.match(re)||[];" +
      "var s=new Set(),u=[];" +
      "m.forEach(function(x){var b=x.split('=')[0];if(s.has(b))return;s.add(b);u.push(b);});" +
      "if(!u.length){alert('GPlay: no photos found. Scroll the whole album first, then click again.');return;}" +
      "window.open(" + JSON.stringify(target) + "+'#urls='+encodeURIComponent(u.join(String.fromCharCode(10))),'_blank');" +
    "})();";
  return 'javascript:' + body;
}

function loadFromHash() {
  const m = /[#&]urls=([^&]+)/.exec(location.hash);
  if (!m) return false;
  let decoded;
  try { decoded = decodeURIComponent(m[1]); } catch (_) { return false; }
  const urls = extractFromManualInput(decoded);
  if (!urls.length) return false;
  setStatus('success', `Received ${urls.length} photo${urls.length === 1 ? '' : 's'} from the bookmarklet.`);
  startSlideshowWith(urls);
  return true;
}

// ---------- Recording ----------
// Fixed 4K UHD landscape output. Smaller images are upscaled with high-quality
// smoothing; portrait images are letterboxed. Keeps the video compatible with
// standard 4K players (YouTube, TV, VLC) regardless of source aspect ratio.
const REC_WIDTH = 3840;
const REC_HEIGHT = 2160;
const REC_HQ_SIZE = 'w3840-h3840';
const REC_FPS = 30;
const REC_FADE_MS = 500;
// Bits per pixel per frame — ~0.15 gives visually near-lossless VP9 quality.
const REC_BPP = 0.15;
const REC_MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

function toHqUrl(url) {
  const base = url.split('=')[0];
  return `${base}=${REC_HQ_SIZE}`;
}

function loadCorsImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${url}`));
    img.src = url;
  });
}

function drawContain(ctx, img, w, h) {
  const scale = Math.min(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function fadeFrame(ctx, from, to, w, h, ms) {
  return new Promise((resolve) => {
    const start = performance.now();
    function step(now) {
      const t = Math.min(1, (now - start) / ms);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      if (from) { ctx.globalAlpha = 1 - t; drawContain(ctx, from, w, h); }
      if (to)   { ctx.globalAlpha = t;     drawContain(ctx, to, w, h); }
      ctx.globalAlpha = 1;
      if (t < 1 && !state.recStopRequested) requestAnimationFrame(step);
      else resolve();
    }
    requestAnimationFrame(step);
  });
}

function holdFrames(ms) {
  return new Promise((resolve) => {
    const start = performance.now();
    function step(now) {
      if (state.recStopRequested || now - start >= ms) resolve();
      else requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });
}

function setRecUI(active) {
  state.recording = active;
  recIndicator.classList.toggle('hidden', !active);
  recBtn.textContent = active ? '⏹ STOP' : '🎥 REC';
  prevBtn.disabled = active;
  nextBtn.disabled = active;
  playBtn.disabled = active;
  backBtn.disabled = active;
}

function updateRecProgress(i, n) {
  recProgress.textContent = `${i} / ${n}`;
}

async function recordSlideshow() {
  if (state.recording) {
    state.recStopRequested = true;
    return;
  }
  if (state.urls.length === 0) return;

  if (typeof MediaRecorder === 'undefined' ||
      typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
    setStatus('error', 'Recording is not supported in this browser. Try Chrome, Edge or Firefox.');
    return;
  }
  const mimeType = REC_MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
  if (!mimeType) {
    setStatus('error', 'No supported WebM codec found in this browser.');
    return;
  }

  const wasPlaying = state.playing;
  pause();
  state.recStopRequested = false;
  setRecUI(true);
  clearStatus();
  setStatus('info', 'Preparing 4K recording...');

  // Probe the first image at HQ so a failure fails fast, before we start recording.
  let firstImg;
  try {
    firstImg = await loadCorsImage(toHqUrl(state.urls[0]));
  } catch (err) {
    setRecUI(false);
    setStatus('error', `Could not load the first photo in HQ: ${err.message}`);
    if (wasPlaying) play();
    return;
  }

  const canvas = document.createElement('canvas');
  canvas.width = REC_WIDTH;
  canvas.height = REC_HEIGHT;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, REC_WIDTH, REC_HEIGHT);

  const stream = canvas.captureStream(REC_FPS);
  const bitrate = Math.round(REC_WIDTH * REC_HEIGHT * REC_FPS * REC_BPP);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  const stopped = new Promise((r) => { recorder.onstop = r; });

  const holdMs = Math.max(500, state.intervalMs - REC_FADE_MS);
  const total = state.urls.length;
  const failures = [];

  clearStatus();
  recorder.start();

  try {
    updateRecProgress(1, total);
    let currentImg = firstImg;
    // Preload the next image while the current one is on screen.
    let nextPromise = total > 1 ? loadCorsImage(toHqUrl(state.urls[1])).catch(() => null) : null;

    await fadeFrame(ctx, null, currentImg, REC_WIDTH, REC_HEIGHT, REC_FADE_MS);
    await holdFrames(holdMs);

    for (let i = 1; i < total && !state.recStopRequested; i++) {
      updateRecProgress(i + 1, total);
      const nextImg = await nextPromise;
      nextPromise = i + 1 < total
        ? loadCorsImage(toHqUrl(state.urls[i + 1])).catch(() => null)
        : null;
      if (!nextImg) { failures.push(state.urls[i]); continue; }
      await fadeFrame(ctx, currentImg, nextImg, REC_WIDTH, REC_HEIGHT, REC_FADE_MS);
      currentImg = nextImg;
      if (!state.recStopRequested) await holdFrames(holdMs);
    }

    await fadeFrame(ctx, currentImg, null, REC_WIDTH, REC_HEIGHT, REC_FADE_MS);
  } catch (err) {
    console.error(err);
    setStatus('error', `Recording failed: ${err.message}`);
  } finally {
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    setRecUI(false);
  }

  if (chunks.length === 0) {
    setStatus('error', 'Recording produced no data. This can happen if the images blocked CORS.');
    if (wasPlaying) play();
    return;
  }

  const blob = new Blob(chunks, { type: mimeType });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const filename = `gplay-slideshow-4k-${stamp}.webm`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);

  const sizeMb = (blob.size / (1024 * 1024)).toFixed(1);
  const mbps = (bitrate / 1_000_000).toFixed(1);
  const stoppedEarly = state.recStopRequested ? ' (stopped early)' : '';
  const skipped = failures.length ? ` — ${failures.length} image(s) skipped` : '';
  setStatus('success',
    `Video ready: ${filename} · ${REC_WIDTH}×${REC_HEIGHT} @ ${mbps} Mbps · ${sizeMb} MB${stoppedEarly}${skipped}`);

  if (wasPlaying && !state.recStopRequested) play();
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
recBtn.addEventListener('click', recordSlideshow);
backBtn.addEventListener('click', backToSetup);

document.addEventListener('keydown', (e) => {
  if (slideshow.classList.contains('hidden')) return;
  switch (e.key) {
    case 'ArrowRight': if (!state.recording) next(); break;
    case 'ArrowLeft':  if (!state.recording) prev(); break;
    case ' ':          if (!state.recording) { e.preventDefault(); togglePlay(); } break;
    case 'f':
    case 'F':          toggleFullscreen(); break;
    case 'Escape':     if (!document.fullscreenElement && !state.recording) backToSetup(); break;
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

// ---------- Init ----------
bookmarkletEl.href = buildBookmarkletHref();
bookmarkletEl.addEventListener('click', (e) => {
  // Clicking the button on this page does nothing useful — it only works when
  // triggered from the album page after being dragged to the bookmarks bar.
  e.preventDefault();
  setStatus('info', 'Drag this button to your bookmarks bar, then click it while viewing a public Google Photos album.');
});

loadFromHash();
window.addEventListener('hashchange', loadFromHash);
