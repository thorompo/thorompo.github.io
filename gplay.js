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
const transitionSelect = document.getElementById('transitionSelect');
const autoplayInput = document.getElementById('autoplayInput');
const loopInput = document.getElementById('loopInput');
const recQualitySelect = document.getElementById('recQualitySelect');
const loadBtn = document.getElementById('loadBtn');
const statusMsg = document.getElementById('statusMsg');

const stage = document.getElementById('stage');
const slideImgA = document.getElementById('slideImgA');
const slideImgB = document.getElementById('slideImgB');
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
const transitionLive = document.getElementById('transitionLive');
const speedSlider = document.getElementById('speedSlider');
const speedLabel = document.getElementById('speedLabel');
const intervalSlider = document.getElementById('intervalSlider');
const intervalSliderLabel = document.getElementById('intervalSliderLabel');

// ---------- State ----------
const state = {
  urls: [],
  index: 0,
  playing: false,
  intervalMs: 4000,
  loop: true,
  transition: 'fade',
  animMs: 1200,
  timer: null,
  frontLayer: null,
  transitioning: false,
  recording: false,
  recStopRequested: false,
};

// ---------- Live transition config ----------
// Slider maps: 0 = Slow, 1 = Med, 2 = Fast (higher value = higher speed).
const SPEED_MS = [2200, 1200, 500];
const SPEED_LABELS = ['Slow', 'Med', 'Fast'];
const LIVE_TRANSITIONS = {
  fade:          { in: 'gp-fade-in',         out: 'gp-fade-out' },
  'slide-left':  { in: 'gp-slide-in-right',  out: 'gp-slide-out-left' },
  'slide-right': { in: 'gp-slide-in-left',   out: 'gp-slide-out-right' },
  'slide-up':    { in: 'gp-slide-in-bottom', out: 'gp-slide-out-top' },
  'slide-down':  { in: 'gp-slide-in-top',    out: 'gp-slide-out-bottom' },
  zoom:          { in: 'gp-zoom-in',         out: 'gp-zoom-out' },
  wipe:          { in: 'gp-wipe-in',         out: null },
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
// Google Photos embeds URLs inside JSON payloads where slashes are escaped
// as `\/` (and occasionally as `\u002F`). The view-source paste therefore
// contains escaped slashes that the raw regex would miss — normalize them.
function normalizeEscapedSlashes(text) {
  return text.replace(/\\\//g, '/').replace(/\\u002[Ff]/g, '/');
}

function extractImageUrls(html) {
  const matches = normalizeEscapedSlashes(html).match(IMG_URL_REGEX) || [];

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
function loadImageInto(imgEl, src) {
  return new Promise((resolve) => {
    imgEl.onload = () => resolve(true);
    imgEl.onerror = () => resolve(false);
    imgEl.src = src;
  });
}

async function showSlide(newIndex) {
  if (state.urls.length === 0) return;
  if (state.transitioning) return;

  let i = newIndex;
  if (i < 0) i = state.loop ? state.urls.length - 1 : 0;
  if (i >= state.urls.length) {
    if (state.loop) i = 0;
    else { i = state.urls.length - 1; pause(); }
  }
  state.index = i;
  counterText.textContent = `${i + 1} / ${state.urls.length}`;

  // Preload the next image for smoother later transitions.
  const nextIdx = (i + 1) % state.urls.length;
  if (state.urls[nextIdx]) new Image().src = state.urls[nextIdx];

  const front = state.frontLayer || slideImgA;
  const back = front === slideImgA ? slideImgB : slideImgA;
  const kind = resolveTransition(state.transition);

  state.transitioning = true;
  await loadImageInto(back, state.urls[i]);

  if (kind === 'cut') {
    back.style.animation = 'none';
    back.style.opacity = 1;
    front.style.animation = 'none';
    front.style.opacity = 0;
    state.frontLayer = back;
    state.transitioning = false;
    return;
  }

  const kf = LIVE_TRANSITIONS[kind] || LIVE_TRANSITIONS.fade;
  const hasOutgoing = !!front.getAttribute('src');
  const animMs = state.animMs;

  back.style.animation = 'none';
  front.style.animation = 'none';
  void back.offsetHeight; // force reflow so the next animation starts clean
  back.style.opacity = 1;
  back.style.animation = `${kf.in} ${animMs}ms ease forwards`;
  if (kf.out && hasOutgoing) {
    front.style.animation = `${kf.out} ${animMs}ms ease forwards`;
  }

  await new Promise((resolve) => setTimeout(resolve, animMs));

  front.style.animation = 'none';
  front.style.opacity = 0;
  back.style.animation = 'none';
  back.style.opacity = 1;
  state.frontLayer = back;
  state.transitioning = false;
}

function next() { showSlide(state.index + 1).then(scheduleNext); }
function prev() { showSlide(state.index - 1).then(scheduleNext); }

function play() {
  state.playing = true;
  playBtn.textContent = '❚❚';
  playBtn.title = 'Pause (Space)';
  scheduleNext();
}
function pause() {
  state.playing = false;
  playBtn.textContent = '▶';
  playBtn.title = 'Play (Space)';
  clearTimeout(state.timer);
  state.timer = null;
}
function togglePlay() { state.playing ? pause() : play(); }

function scheduleNext() {
  clearTimeout(state.timer);
  state.timer = null;
  if (!state.playing) return;
  const wait = Math.max(0, state.intervalMs - state.animMs);
  state.timer = setTimeout(async () => {
    await showSlide(state.index + 1);
    scheduleNext();
  }, wait);
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
  applyIntervalSec(intervalInput.value);
  state.loop = loopInput.checked;
  applyTransition(transitionSelect.value || 'fade');

  setStatus('success', `Loaded ${urls.length} photo${urls.length === 1 ? '' : 's'}.`);
  setupDiv.classList.add('hidden');
  slideshow.classList.remove('hidden');

  showSlide(0);
  if (autoplayInput.checked) play(); else pause();
}

function applyTransition(kind) {
  state.transition = kind;
  if (transitionSelect.value !== kind) transitionSelect.value = kind;
  if (transitionLive.value  !== kind) transitionLive.value  = kind;
}

function applySpeed(index) {
  const parsed = parseInt(index, 10);
  const raw = Number.isNaN(parsed) ? 1 : parsed;
  const i = Math.max(0, Math.min(SPEED_MS.length - 1, raw));
  state.animMs = SPEED_MS[i];
  speedLabel.textContent = SPEED_LABELS[i];
  if (String(speedSlider.value) !== String(i)) speedSlider.value = i;
}

function applyIntervalSec(seconds) {
  const parsed = parseInt(seconds, 10);
  const raw = Number.isNaN(parsed) ? 4 : parsed;
  const s = Math.max(1, Math.min(60, raw));
  state.intervalMs = s * 1000;
  intervalSliderLabel.textContent = `${s}s`;
  if (String(intervalSlider.value) !== String(s) && s <= 15) intervalSlider.value = s;
  if (String(intervalInput.value)  !== String(s)) intervalInput.value = s;
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
  for (const layer of [slideImgA, slideImgB]) {
    layer.removeAttribute('src');
    layer.style.animation = 'none';
    layer.style.opacity = 0;
  }
  state.frontLayer = null;
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
// Recording quality presets: canvas dimensions + HQ source size hint sent to
// Google Photos (`=wW-hH`). The HQ hint is chosen a bit larger than the canvas
// so we downsample rather than upscale on the encoder canvas.
const REC_QUALITIES = {
  720:  { w: 1280, h: 720,  hqSize: 'w1920-h1920', label: '720p'  },
  1080: { w: 1920, h: 1080, hqSize: 'w2560-h2560', label: '1080p' },
  1440: { w: 2560, h: 1440, hqSize: 'w3200-h3200', label: '1440p' },
  2160: { w: 3840, h: 2160, hqSize: 'w3840-h3840', label: '4K'    },
  4320: { w: 7680, h: 4320, hqSize: 'w7680-h7680', label: '8K'    },
};
const REC_FPS = 30;
// Bits per pixel per frame — ~0.15 gives visually near-lossless VP9 quality.
const REC_BPP = 0.15;
const REC_MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

function currentRecQuality() {
  const q = parseInt(recQualitySelect.value, 10);
  return REC_QUALITIES[q] || REC_QUALITIES[2160];
}

function toHqUrl(url, hqSize) {
  const base = url.split('=')[0];
  return `${base}=${hqSize}`;
}

// Probes every image at native resolution (=s0) to find the largest width and
// height across the album (independent axes). Used by the "Original" preset.
async function probeAlbumMaxDims() {
  let maxW = 0, maxH = 0;
  const total = state.urls.length;
  for (let i = 0; i < total; i++) {
    if (state.recStopRequested) break;
    setStatus('info', `Probing image sizes ${i + 1} / ${total}...`);
    try {
      const img = await loadCorsImage(toHqUrl(state.urls[i], 's0'));
      if (img.naturalWidth > maxW)  maxW = img.naturalWidth;
      if (img.naturalHeight > maxH) maxH = img.naturalHeight;
    } catch (_) { /* skip failures */ }
  }
  return { w: maxW, h: maxH };
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
  // Contain fit: preserve aspect ratio, letterbox with black bars if needed.
  const scale = Math.min(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

// ---------- Transition renderers (canvas) ----------
// Each receives (ctx, from, to, w, h, t) with t in [0,1]. `from`/`to` may be
// null for the intro / outro fades (fade-in from black, fade-out to black).
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function renderFade(ctx, from, to, w, h, t) {
  if (from) { ctx.globalAlpha = 1 - t; drawContain(ctx, from, w, h); }
  if (to)   { ctx.globalAlpha = t;     drawContain(ctx, to,   w, h); }
  ctx.globalAlpha = 1;
}

function makeSlideRenderer(dx, dy) {
  return function (ctx, from, to, w, h, t) {
    const e = easeInOutCubic(t);
    ctx.save();
    if (from) {
      ctx.translate(w * dx * e, h * dy * e);
      drawContain(ctx, from, w, h);
      ctx.translate(-w * dx * e, -h * dy * e);
    }
    if (to) {
      ctx.translate(-w * dx * (1 - e), -h * dy * (1 - e));
      drawContain(ctx, to, w, h);
    }
    ctx.restore();
  };
}

function renderZoom(ctx, from, to, w, h, t) {
  const e = easeInOutCubic(t);
  if (from) {
    ctx.globalAlpha = 1 - e;
    const s = 1 + 0.15 * e;
    ctx.save(); ctx.translate(w / 2, h / 2); ctx.scale(s, s); ctx.translate(-w / 2, -h / 2);
    drawContain(ctx, from, w, h);
    ctx.restore();
  }
  if (to) {
    ctx.globalAlpha = e;
    const s = 0.85 + 0.15 * e;
    ctx.save(); ctx.translate(w / 2, h / 2); ctx.scale(s, s); ctx.translate(-w / 2, -h / 2);
    drawContain(ctx, to, w, h);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function renderWipe(ctx, from, to, w, h, t) {
  const e = easeInOutCubic(t);
  if (from) drawContain(ctx, from, w, h);
  if (to) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w * e, h);
    ctx.clip();
    drawContain(ctx, to, w, h);
    ctx.restore();
  }
}

const TRANSITIONS = {
  fade:          renderFade,
  'slide-left':  makeSlideRenderer(-1,  0),
  'slide-right': makeSlideRenderer( 1,  0),
  'slide-up':    makeSlideRenderer( 0, -1),
  'slide-down':  makeSlideRenderer( 0,  1),
  zoom:          renderZoom,
  wipe:          renderWipe,
};
const RANDOM_POOL = ['fade', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'zoom', 'wipe'];

function resolveTransition(kind) {
  if (kind === 'random') return RANDOM_POOL[Math.floor(Math.random() * RANDOM_POOL.length)];
  if (kind === 'cut')    return 'cut';
  return TRANSITIONS[kind] ? kind : 'fade';
}

function transitionFrame(kind, ctx, from, to, w, h, ms) {
  return new Promise((resolve) => {
    const effective = resolveTransition(kind);
    if (effective === 'cut') {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      if (to) drawContain(ctx, to, w, h);
      resolve();
      return;
    }
    const render = TRANSITIONS[effective] || renderFade;
    const start = performance.now();
    function step(now) {
      const t = Math.min(1, (now - start) / ms);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      render(ctx, from, to, w, h, t);
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

  let RW, RH, hqSize, label;
  if (recQualitySelect.value === 'original') {
    setStatus('info', 'Probing album for native resolution — this loads every photo at =s0 and may take a while...');
    hqSize = 's0';
    const dims = await probeAlbumMaxDims();
    if (state.recStopRequested) {
      setRecUI(false);
      setStatus('info', 'Probing cancelled.');
      if (wasPlaying) play();
      return;
    }
    if (!dims.w || !dims.h) {
      setRecUI(false);
      setStatus('error', 'Could not determine album native resolution (CORS or load failure).');
      if (wasPlaying) play();
      return;
    }
    RW = Math.max(2, Math.round(dims.w / 2) * 2);
    RH = Math.max(2, Math.round(dims.h / 2) * 2);
    label = `original-${RW}x${RH}`;
    setStatus('info', `Native resolution: ${RW}×${RH}. Preparing recording...`);
  } else {
    const quality = currentRecQuality();
    RW = quality.w;
    RH = quality.h;
    hqSize = quality.hqSize;
    label = quality.label;
    setStatus('info', `Preparing ${quality.label} recording...`);
  }

  // Probe the first image at HQ so a failure fails fast, before we start recording.
  let firstImg;
  try {
    firstImg = await loadCorsImage(toHqUrl(state.urls[0], hqSize));
  } catch (err) {
    setRecUI(false);
    setStatus('error', `Could not load the first photo in HQ: ${err.message}`);
    if (wasPlaying) play();
    return;
  }

  const canvas = document.createElement('canvas');
  canvas.width = RW;
  canvas.height = RH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, RW, RH);

  const stream = canvas.captureStream(REC_FPS);
  const bitrate = Math.round(RW * RH * REC_FPS * REC_BPP);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  const stopped = new Promise((r) => { recorder.onstop = r; });

  // Snapshot the anim duration once so mid-recording slider changes don't skew
  // the intro/outro pacing.
  const fadeMs = state.animMs;
  const holdMs = Math.max(500, state.intervalMs - fadeMs);
  const total = state.urls.length;
  const failures = [];

  clearStatus();
  recorder.start();

  try {
    updateRecProgress(1, total);
    let currentImg = firstImg;
    // Preload the next image while the current one is on screen.
    let nextPromise = total > 1 ? loadCorsImage(toHqUrl(state.urls[1], hqSize)).catch(() => null) : null;

    // Intro / outro always fade to keep them cinematic regardless of style.
    await transitionFrame('fade', ctx, null, currentImg, RW, RH, fadeMs);
    await holdFrames(holdMs);

    for (let i = 1; i < total && !state.recStopRequested; i++) {
      updateRecProgress(i + 1, total);
      const nextImg = await nextPromise;
      nextPromise = i + 1 < total
        ? loadCorsImage(toHqUrl(state.urls[i + 1], hqSize)).catch(() => null)
        : null;
      if (!nextImg) { failures.push(state.urls[i]); continue; }
      await transitionFrame(state.transition, ctx, currentImg, nextImg, RW, RH, fadeMs);
      currentImg = nextImg;
      if (!state.recStopRequested) await holdFrames(holdMs);
    }

    await transitionFrame('fade', ctx, currentImg, null, RW, RH, fadeMs);
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
  const filename = `gplay-slideshow-${label.toLowerCase()}-${stamp}.webm`;
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
    `Video ready: ${filename} · ${RW}×${RH} @ ${mbps} Mbps · ${sizeMb} MB${stoppedEarly}${skipped}`);

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

transitionSelect.addEventListener('change', (e) => applyTransition(e.target.value));
transitionLive.addEventListener('change',   (e) => applyTransition(e.target.value));
speedSlider.addEventListener('input',        (e) => applySpeed(e.target.value));
intervalSlider.addEventListener('input',     (e) => applyIntervalSec(e.target.value));
intervalInput.addEventListener('input',      (e) => applyIntervalSec(e.target.value));

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

applySpeed(speedSlider.value);
applyIntervalSec(intervalInput.value);

loadFromHash();
window.addEventListener('hashchange', loadFromHash);

// ==========================================================================
// YouTube Music mini-player
// Uses YouTube's IFrame Player API to play any public playlist. The iframe
// shares the user's youtube.com cookies, so a signed-in Premium account plays
// without ads. YouTube Music playlist share URLs use the same `list=` ID as
// standard YouTube playlists, so paste either form.
// ==========================================================================
(function initMusicPlayer() {
  const LS_PLAYLIST = 'gplay.music.playlist';
  const LS_VOLUME   = 'gplay.music.volume';
  const LS_OPEN     = 'gplay.music.open';

  const musicPlayer     = document.getElementById('musicPlayer');
  const musicToggle     = document.getElementById('musicToggle');
  const musicClose      = document.getElementById('musicClose');
  const playlistInput   = document.getElementById('playlistInput');
  const loadPlaylistBtn = document.getElementById('loadPlaylistBtn');
  const prevTrackBtn    = document.getElementById('prevTrackBtn');
  const playPauseBtn    = document.getElementById('playPauseBtn');
  const nextTrackBtn    = document.getElementById('nextTrackBtn');
  const volumeSlider    = document.getElementById('volumeSlider');
  const trackInfo       = document.getElementById('trackInfo');

  let ytPlayer = null;
  let ytApiPromise = null;
  let titlePollTimer = null;

  function loadYtApi() {
    if (ytApiPromise) return ytApiPromise;
    ytApiPromise = new Promise((resolve) => {
      window.onYouTubeIframeAPIReady = () => resolve(window.YT);
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
    });
    return ytApiPromise;
  }

  function extractPlaylistId(raw) {
    const s = (raw || '').trim();
    if (!s) return null;
    if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return s;
    try {
      const u = new URL(s);
      return u.searchParams.get('list');
    } catch (_) {
      return null;
    }
  }

  function setTrackInfo(text) {
    trackInfo.textContent = text;
  }

  function updatePlayPauseIcon() {
    if (!ytPlayer || !ytPlayer.getPlayerState) return;
    const s = ytPlayer.getPlayerState();
    playPauseBtn.textContent = s === 1 ? '❚❚' : '▶';
  }

  function pollTitle() {
    if (!ytPlayer || !ytPlayer.getVideoData) return;
    try {
      const data = ytPlayer.getVideoData();
      if (data && data.title) setTrackInfo(data.title);
    } catch (_) { /* ignore */ }
  }

  async function ensurePlayer() {
    if (ytPlayer) return ytPlayer;
    await loadYtApi();
    return new Promise((resolve) => {
      ytPlayer = new YT.Player('ytPlayer', {
        width: '1', height: '1',
        playerVars: { autoplay: 0, controls: 0, modestbranding: 1, rel: 0 },
        events: {
          onReady: () => {
            const vol = parseInt(localStorage.getItem(LS_VOLUME) || '60', 10);
            volumeSlider.value = vol;
            ytPlayer.setVolume(vol);
            resolve(ytPlayer);
          },
          onStateChange: () => {
            updatePlayPauseIcon();
            pollTitle();
          },
        },
      });
    });
  }

  async function loadPlaylist(listId) {
    if (!listId) return;
    await ensurePlayer();
    ytPlayer.loadPlaylist({ list: listId, listType: 'playlist', index: 0 });
    localStorage.setItem(LS_PLAYLIST, listId);
    setTrackInfo('Loading playlist...');
    clearInterval(titlePollTimer);
    titlePollTimer = setInterval(pollTitle, 2000);
  }

  function openPanel() {
    musicPlayer.classList.remove('collapsed');
    localStorage.setItem(LS_OPEN, '1');
  }
  function closePanel() {
    musicPlayer.classList.add('collapsed');
    localStorage.setItem(LS_OPEN, '0');
  }

  musicToggle.addEventListener('click', openPanel);
  musicClose.addEventListener('click', closePanel);

  loadPlaylistBtn.addEventListener('click', () => {
    const id = extractPlaylistId(playlistInput.value);
    if (!id) {
      setTrackInfo('Invalid playlist URL or ID.');
      return;
    }
    loadPlaylist(id);
  });
  playlistInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadPlaylistBtn.click();
  });

  playPauseBtn.addEventListener('click', async () => {
    await ensurePlayer();
    const s = ytPlayer.getPlayerState && ytPlayer.getPlayerState();
    if (s === 1) ytPlayer.pauseVideo(); else ytPlayer.playVideo();
  });
  prevTrackBtn.addEventListener('click', () => ytPlayer && ytPlayer.previousVideo && ytPlayer.previousVideo());
  nextTrackBtn.addEventListener('click', () => ytPlayer && ytPlayer.nextVideo && ytPlayer.nextVideo());

  volumeSlider.addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    if (ytPlayer && ytPlayer.setVolume) ytPlayer.setVolume(v);
    localStorage.setItem(LS_VOLUME, String(v));
  });

  // Restore previous session
  const savedPlaylist = localStorage.getItem(LS_PLAYLIST);
  if (savedPlaylist) playlistInput.value = savedPlaylist;
  const savedVol = localStorage.getItem(LS_VOLUME);
  if (savedVol) volumeSlider.value = savedVol;
  if (localStorage.getItem(LS_OPEN) === '1') openPanel();
})();
