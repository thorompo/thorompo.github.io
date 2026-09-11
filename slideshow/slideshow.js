(() => {
  'use strict';

  const HEIC_EXT = /\.(heic|heif)$/i;
  const VIDEO_EXT = /\.(mp4|m4v|mov|webm|3gp|mkv|avi|ogv)$/i;
  const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif)$/i;

  const state = {
    slides: [], // { id, name, type, url, revoke }
  };

  // ---------- IndexedDB persistence ----------
  const DB_NAME = 'slideshow-maker';
  const DB_VERSION = 1;
  const STORE_SLIDES = 'slides';
  const STORE_SETTINGS = 'settings';
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB not supported')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_SLIDES)) {
          const store = db.createObjectStore(STORE_SLIDES, { keyPath: 'id', autoIncrement: true });
          store.createIndex('order', 'order', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
          db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function txPromise(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function dbAddSlide(record) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SLIDES, 'readwrite');
      const req = tx.objectStore(STORE_SLIDES).add(record);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbGetAllSlides() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SLIDES, 'readonly');
      const req = tx.objectStore(STORE_SLIDES).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbDeleteSlide(id) {
    const db = await openDB();
    const tx = db.transaction(STORE_SLIDES, 'readwrite');
    tx.objectStore(STORE_SLIDES).delete(id);
    return txPromise(tx);
  }

  async function dbClearSlides() {
    const db = await openDB();
    const tx = db.transaction(STORE_SLIDES, 'readwrite');
    tx.objectStore(STORE_SLIDES).clear();
    return txPromise(tx);
  }

  async function dbUpdateOrder(idsInOrder) {
    const db = await openDB();
    const tx = db.transaction(STORE_SLIDES, 'readwrite');
    const store = tx.objectStore(STORE_SLIDES);
    idsInOrder.forEach((id, i) => {
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const rec = getReq.result;
        if (rec) { rec.order = i; store.put(rec); }
      };
    });
    return txPromise(tx);
  }

  async function dbSetSetting(key, value) {
    const db = await openDB();
    const tx = db.transaction(STORE_SETTINGS, 'readwrite');
    tx.objectStore(STORE_SETTINGS).put({ key, value });
    return txPromise(tx);
  }

  async function dbGetAllSettings() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SETTINGS, 'readonly');
      const req = tx.objectStore(STORE_SETTINGS).getAll();
      req.onsuccess = () => {
        const out = {};
        (req.result || []).forEach(r => { out[r.key] = r.value; });
        resolve(out);
      };
      req.onerror = () => reject(req.error);
    });
  }

  const els = {
    fileInput: document.getElementById('fileInput'),
    configInput: document.getElementById('configInput'),
    showInput: document.getElementById('showInput'),
    menuBtn: document.getElementById('menuBtn'),
    menuPanel: document.getElementById('menuPanel'),
    addBtn: document.getElementById('addBtn'),
    clearBtn: document.getElementById('clearBtn'),
    exportBtn: document.getElementById('exportBtn'),
    importBtn: document.getElementById('importBtn'),
    saveShowBtn: document.getElementById('saveShowBtn'),
    loadShowBtn: document.getElementById('loadShowBtn'),
    exportVideo1080Btn: document.getElementById('exportVideo1080Btn'),
    exportVideo4KBtn: document.getElementById('exportVideo4KBtn'),
    exportOverlay: document.getElementById('exportOverlay'),
    exportStatusText: document.getElementById('exportStatusText'),
    exportProgressBar: document.getElementById('exportProgressBar'),
    cancelExportBtn: document.getElementById('cancelExportBtn'),
    playBtn: document.getElementById('playBtn'),
    transitionSelect: document.getElementById('transitionSelect'),
    totalDuration: document.getElementById('totalDuration'),
    videoDuration: document.getElementById('videoDuration'),
    loopCheckbox: document.getElementById('loopCheckbox'),
    perSlideInfo: document.getElementById('perSlideInfo'),
    grid: document.getElementById('grid'),
    emptyState: document.getElementById('emptyState'),
    statusBar: document.getElementById('statusBar'),
    player: document.getElementById('player'),
    stage: document.getElementById('stage'),
    layerA: document.getElementById('layerA'),
    layerB: document.getElementById('layerB'),
    prevBtn: document.getElementById('prevBtn'),
    nextBtn: document.getElementById('nextBtn'),
    pauseBtn: document.getElementById('pauseBtn'),
    closePlayer: document.getElementById('closePlayer'),
    playerCounter: document.getElementById('playerCounter'),
  };

  let sortable = null;

  // ---------- Status ----------
  function setStatus(msg, isError = false) {
    els.statusBar.textContent = msg || '';
    els.statusBar.style.color = isError ? '#f87171' : '#94a3b8';
  }

  // Auto-default the Video length input to `total / N` until the user
  // manually sets it. After that, changing Video length nudges Total.
  let userSetVideoLength = false;
  let lastKnownVideoLength = 0;

  function formatDur(v) {
    const n = Math.round(v * 100) / 100;
    return String(n);
  }

  function syncDefaultVideoLength() {
    if (userSetVideoLength) return;
    const total = parseInt(els.totalDuration.value, 10) || 0;
    const n = state.slides.length;
    if (n === 0 || total <= 0) { lastKnownVideoLength = parseFloat(els.videoDuration.value) || 0; return; }
    const videoCount = state.slides.filter(s => s.type === 'video').length;
    const auto = videoCount === 0 ? 0 : total / n;
    els.videoDuration.value = formatDur(auto);
    lastKnownVideoLength = auto;
  }

  function computeSlideDurations() {
    const total = Math.max(1, parseInt(els.totalDuration.value, 10) || 0);
    const videoDur = Math.max(0, parseFloat(els.videoDuration.value) || 0);
    const slides = state.slides;
    if (slides.length === 0) return [];
    const videoCount = slides.filter(s => s.type === 'video').length;
    const imageCount = slides.length - videoCount;

    if (videoDur > 0 && videoCount > 0) {
      const videoTotal = videoCount * videoDur;
      const remainingForImages = Math.max(0, total - videoTotal);
      const imgDur = imageCount > 0 ? remainingForImages / imageCount : 0;
      return slides.map(s => (s.type === 'video' ? videoDur : imgDur) * 1000);
    }
    const per = (total / slides.length) * 1000;
    return slides.map(() => per);
  }

  function updatePerSlideInfo() {
    syncDefaultVideoLength();
    const total = Math.max(1, parseInt(els.totalDuration.value, 10) || 0);
    const videoDur = Math.max(0, parseFloat(els.videoDuration.value) || 0);
    const n = state.slides.length;
    const videoCount = state.slides.filter(s => s.type === 'video').length;
    const imageCount = n - videoCount;
    if (n === 0) {
      els.perSlideInfo.textContent = '';
    } else if (videoDur > 0 && videoCount > 0) {
      const remaining = Math.max(0, total - videoCount * videoDur);
      const imgPer = imageCount > 0 ? remaining / imageCount : 0;
      if (imageCount > 0) {
        els.perSlideInfo.textContent =
          `≈ ${imgPer.toFixed(2)}s / image · ${videoDur.toFixed(2)}s / video (${imageCount} img, ${videoCount} vid)`;
      } else {
        els.perSlideInfo.textContent = `≈ ${videoDur.toFixed(2)}s / video (${videoCount})`;
      }
    } else {
      const per = (total / n).toFixed(2);
      els.perSlideInfo.textContent = `= ${per}s per slide (${n})`;
    }
    els.playBtn.disabled = n === 0;
  }

  // ---------- File loading ----------
  function detectType(file) {
    if (file.type && file.type.startsWith('video/')) return 'video';
    if (file.type && file.type.startsWith('image/')) return 'image';
    if (VIDEO_EXT.test(file.name)) return 'video';
    if (IMAGE_EXT.test(file.name)) return 'image';
    return null;
  }

  async function fileToBlobRecord(file) {
    const type = detectType(file);
    if (!type) throw new Error(`Unsupported file: ${file.name}`);

    let blob = file;
    // HEIC/HEIF conversion for browsers that can't render them
    if (type === 'image' && (HEIC_EXT.test(file.name) || file.type === 'image/heic' || file.type === 'image/heif')) {
      if (typeof window.heic2any === 'function') {
        try {
          const converted = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
          blob = Array.isArray(converted) ? converted[0] : converted;
        } catch (e) {
          console.warn('HEIC conversion failed for', file.name, e);
          // fallthrough — Safari can render HEIC natively
        }
      }
    }

    return { name: file.name, type, blob };
  }

  function slideFromRecord(rec) {
    const url = URL.createObjectURL(rec.blob);
    return {
      id: rec.id,
      name: rec.name,
      type: rec.type,
      url,
      revoke: () => URL.revokeObjectURL(url),
    };
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    setStatus(`Loading ${files.length} file(s)…`);
    let ok = 0, fail = 0;
    const errors = [];
    let nextOrder = state.slides.length;

    for (const f of files) {
      try {
        const rec = await fileToBlobRecord(f);
        rec.order = nextOrder++;
        try {
          const id = await dbAddSlide(rec);
          rec.id = id;
        } catch (dbErr) {
          console.warn('IndexedDB add failed, keeping in-memory only:', dbErr);
          rec.id = -Date.now() - Math.floor(Math.random() * 1000);
        }
        state.slides.push(slideFromRecord(rec));
        ok++;
      } catch (e) {
        fail++;
        errors.push(f.name);
        console.error(e);
      }
    }

    renderGrid();
    updatePerSlideInfo();
    if (fail === 0) {
      setStatus(`Loaded ${ok} file(s). Saved to browser storage.`);
    } else {
      setStatus(`Loaded ${ok}, skipped ${fail}: ${errors.join(', ')}`, true);
    }
  }

  // ---------- Grid render ----------
  function renderGrid() {
    els.grid.innerHTML = '';
    if (state.slides.length === 0) {
      els.grid.classList.add('hidden');
      els.emptyState.classList.remove('hidden');
      return;
    }
    els.emptyState.classList.add('hidden');
    els.grid.classList.remove('hidden');

    state.slides.forEach((slide, idx) => {
      const li = document.createElement('li');
      li.className = 'tile';
      li.dataset.id = String(slide.id);

      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = slide.type;

      const idxEl = document.createElement('span');
      idxEl.className = 'idx';
      idxEl.textContent = String(idx + 1);

      const name = document.createElement('div');
      name.className = 'name';
      name.title = slide.name;
      name.textContent = slide.name;

      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-btn';
      removeBtn.type = 'button';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        removeSlide(slide.id);
      });

      if (slide.type === 'image') {
        const img = document.createElement('img');
        img.src = slide.url;
        img.alt = slide.name;
        img.loading = 'lazy';
        li.appendChild(img);
      } else {
        const video = document.createElement('video');
        video.src = slide.url;
        video.muted = true;
        video.playsInline = true;
        video.preload = 'metadata';
        li.appendChild(video);
      }

      li.append(badge, idxEl, name, removeBtn);
      els.grid.appendChild(li);
    });

    ensureSortable();
  }

  function ensureSortable() {
    if (sortable) sortable.destroy();
    if (typeof window.Sortable !== 'function') {
      // Sortable script might still be loading; retry shortly
      setTimeout(ensureSortable, 100);
      return;
    }
    sortable = window.Sortable.create(els.grid, {
      animation: 150,
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      onEnd: () => {
        const ids = Array.from(els.grid.children).map(el => Number(el.dataset.id));
        const byId = new Map(state.slides.map(s => [s.id, s]));
        state.slides = ids.map(id => byId.get(id)).filter(Boolean);
        Array.from(els.grid.children).forEach((el, i) => {
          const idx = el.querySelector('.idx');
          if (idx) idx.textContent = String(i + 1);
        });
        dbUpdateOrder(ids).catch(err => console.warn('Persist order failed:', err));
      },
    });
  }

  function removeSlide(id) {
    const i = state.slides.findIndex(s => s.id === id);
    if (i === -1) return;
    try { state.slides[i].revoke && state.slides[i].revoke(); } catch (e) { /* noop */ }
    state.slides.splice(i, 1);
    renderGrid();
    updatePerSlideInfo();
    dbDeleteSlide(id).catch(err => console.warn('Persist delete failed:', err));
    const remainingIds = state.slides.map(s => s.id);
    if (remainingIds.length) {
      dbUpdateOrder(remainingIds).catch(err => console.warn('Persist order failed:', err));
    }
  }

  function clearAll() {
    if (state.slides.length === 0) return;
    if (!confirm('Remove all loaded media?')) return;
    state.slides.forEach(s => { try { s.revoke && s.revoke(); } catch (e) { /* noop */ } });
    state.slides = [];
    renderGrid();
    updatePerSlideInfo();
    dbClearSlides().catch(err => console.warn('Persist clear failed:', err));
    setStatus('Cleared.');
  }

  // ---------- Export / Import ----------
  function exportOrder() {
    if (state.slides.length === 0) {
      setStatus('Nothing to export.', true);
      return;
    }
    const config = {
      version: 1,
      generatedAt: new Date().toISOString(),
      transition: els.transitionSelect.value,
      totalDurationSeconds: parseInt(els.totalDuration.value, 10) || 30,
      videoDurationSeconds: Math.max(0, parseFloat(els.videoDuration.value) || 0),
      files: state.slides.map(s => s.name),
    };
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.download = `slideshow-order-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(`Exported ${config.files.length} entries.`);
  }

  async function importConfigFile(file) {
    if (!file) return;
    let config;
    try {
      const text = await file.text();
      config = JSON.parse(text);
    } catch (e) {
      setStatus(`Invalid config file: ${e.message}`, true);
      return;
    }
    if (!config || !Array.isArray(config.files)) {
      setStatus('Config missing "files" array.', true);
      return;
    }

    if (typeof config.transition === 'string') {
      const opt = Array.from(els.transitionSelect.options).find(o => o.value === config.transition);
      if (opt) els.transitionSelect.value = config.transition;
    }
    if (typeof config.totalDurationSeconds === 'number' && config.totalDurationSeconds > 0) {
      els.totalDuration.value = String(config.totalDurationSeconds);
    }
    if (typeof config.videoDurationSeconds === 'number' && config.videoDurationSeconds >= 0) {
      els.videoDuration.value = String(config.videoDurationSeconds);
      lastKnownVideoLength = config.videoDurationSeconds;
      userSetVideoLength = true;
    }

    // Match by filename against currently loaded slides
    const byName = new Map();
    state.slides.forEach(s => {
      if (!byName.has(s.name)) byName.set(s.name, []);
      byName.get(s.name).push(s);
    });

    const reordered = [];
    const missing = [];
    for (const name of config.files) {
      const bucket = byName.get(name);
      if (bucket && bucket.length > 0) {
        reordered.push(bucket.shift());
      } else {
        missing.push(name);
      }
    }

    // Append any currently loaded slides that were not referenced in the config,
    // preserving their existing relative order.
    const usedIds = new Set(reordered.map(s => s.id));
    const leftovers = state.slides.filter(s => !usedIds.has(s.id));

    state.slides = [...reordered, ...leftovers];
    renderGrid();
    updatePerSlideInfo();
    dbUpdateOrder(state.slides.map(s => s.id)).catch(err => console.warn('Persist order failed:', err));
    dbSetSetting('transition', els.transitionSelect.value).catch(() => {});
    dbSetSetting('totalDuration', parseInt(els.totalDuration.value, 10) || 30).catch(() => {});
    dbSetSetting('videoDuration', Math.max(0, parseFloat(els.videoDuration.value) || 0)).catch(() => {});

    if (missing.length > 0) {
      const list = missing.join(', ');
      setStatus(`Reordered ${reordered.length}. Missing (${missing.length}): ${list}`, true);
      alert(
        `Import finished with ${reordered.length} match(es).\n\n` +
        `Missing file(s) (${missing.length}) — they will be skipped:\n` +
        missing.map(n => ' • ' + n).join('\n')
      );
    } else {
      setStatus(`Reordered ${reordered.length} slide(s) from config.`);
    }
  }

  // ---------- Save / Load whole slideshow (media + settings, as .zip) ----------
  async function saveSlideshow() {
    if (state.slides.length === 0) {
      setStatus('Nothing to save.', true);
      return;
    }
    if (typeof window.JSZip !== 'function') {
      setStatus('Zip library is still loading, try again in a moment.', true);
      return;
    }
    els.saveShowBtn.disabled = true;
    setStatus(`Packing ${state.slides.length} item(s) into a .zip…`);
    try {
      const records = await dbGetAllSlides();
      records.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

      const zip = new window.JSZip();
      const mediaFolder = zip.folder('media');
      const pad = Math.max(3, String(records.length).length);
      const manifestFiles = [];

      for (let i = 0; i < records.length; i++) {
        const r = records[i];
        if (!(r.blob instanceof Blob)) continue;
        const seq = String(i + 1).padStart(pad, '0');
        const safeName = r.name.replace(/[\/\\?%*:|"<>]/g, '_');
        const storedAs = `${seq}-${safeName}`;
        mediaFolder.file(storedAs, r.blob);
        manifestFiles.push({
          name: r.name,
          type: r.type,
          mime: r.blob.type || '',
          storedAs,
        });
      }

      const manifest = {
        version: 1,
        generatedAt: new Date().toISOString(),
        settings: {
          transition: els.transitionSelect.value,
          totalDuration: parseInt(els.totalDuration.value, 10) || 30,
          videoDuration: Math.max(0, parseFloat(els.videoDuration.value) || 0),
          loop: !!els.loopCheckbox.checked,
        },
        files: manifestFiles,
      };
      zip.file('manifest.json', JSON.stringify(manifest, null, 2));

      // STORE: media is already compressed, skip deflate to save time.
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.download = `slideshow-${stamp}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);

      const mb = (blob.size / (1024 * 1024)).toFixed(1);
      setStatus(`Saved ${manifestFiles.length} item(s) (${mb} MB).`);
    } catch (e) {
      console.error(e);
      setStatus(`Save failed: ${e.message}`, true);
    } finally {
      els.saveShowBtn.disabled = false;
    }
  }

  async function loadSlideshowFromFile(file) {
    if (!file) return;
    if (typeof window.JSZip !== 'function') {
      setStatus('Zip library is still loading, try again in a moment.', true);
      return;
    }
    if (state.slides.length > 0 &&
        !confirm('This will replace all currently loaded media and settings. Continue?')) {
      return;
    }

    els.loadShowBtn.disabled = true;
    setStatus('Reading slideshow file…');
    try {
      const zip = await window.JSZip.loadAsync(file);
      const manifestFile = zip.file('manifest.json');
      if (!manifestFile) {
        setStatus('Invalid file: manifest.json is missing.', true);
        return;
      }
      const manifest = JSON.parse(await manifestFile.async('string'));
      const files = Array.isArray(manifest.files) ? manifest.files : [];

      // Wipe current state + DB
      state.slides.forEach(s => { try { s.revoke && s.revoke(); } catch (e) { /* noop */ } });
      state.slides = [];
      try { await dbClearSlides(); } catch (e) { console.warn('Clear DB failed:', e); }

      let order = 0;
      let restored = 0;
      const missing = [];
      for (const f of files) {
        const zf = zip.file('media/' + f.storedAs);
        if (!zf) { missing.push(f.name || f.storedAs); continue; }
        const rawBlob = await zf.async('blob');
        const typed = f.mime ? new Blob([rawBlob], { type: f.mime }) : rawBlob;
        const rec = { name: f.name, type: f.type, blob: typed, order: order++ };
        try {
          const id = await dbAddSlide(rec);
          rec.id = id;
        } catch (dbErr) {
          console.warn('DB add failed while loading, keeping in-memory:', dbErr);
          rec.id = -Date.now() - Math.floor(Math.random() * 1000);
        }
        state.slides.push(slideFromRecord(rec));
        restored++;
      }

      const s = manifest.settings || {};
      if (s.transition && Array.from(els.transitionSelect.options).some(o => o.value === s.transition)) {
        els.transitionSelect.value = s.transition;
        dbSetSetting('transition', s.transition).catch(() => {});
      }
      if (typeof s.totalDuration === 'number' && s.totalDuration > 0) {
        els.totalDuration.value = String(s.totalDuration);
        dbSetSetting('totalDuration', s.totalDuration).catch(() => {});
      }
      if (typeof s.videoDuration === 'number' && s.videoDuration >= 0) {
        els.videoDuration.value = String(s.videoDuration);
        lastKnownVideoLength = s.videoDuration;
        userSetVideoLength = true;
        dbSetSetting('videoDuration', s.videoDuration).catch(() => {});
      }
      if (typeof s.loop === 'boolean') {
        els.loopCheckbox.checked = s.loop;
        dbSetSetting('loop', s.loop).catch(() => {});
      }

      renderGrid();
      updatePerSlideInfo();

      if (missing.length > 0) {
        setStatus(`Loaded ${restored}. Missing in zip: ${missing.join(', ')}`, true);
      } else {
        setStatus(`Loaded ${restored} item(s) from slideshow file.`);
      }
    } catch (e) {
      console.error(e);
      setStatus(`Load failed: ${e.message}`, true);
    } finally {
      els.loadShowBtn.disabled = false;
    }
  }

  // ---------- Video export ----------
  let exportInProgress = false;
  let exportCancelled = false;

  function pickVideoMime() {
    if (!('MediaRecorder' in window)) return null;
    // Prefer MP4/H.264 for the widest downstream compatibility (Photos,
    // iMovie, WhatsApp, etc.). Modern Chrome/Safari support recording it;
    // Firefox falls back to WebM automatically.
    const list = [
      'video/mp4;codecs=avc1.42E01F',
      'video/mp4;codecs=avc1',
      'video/mp4;codecs=h264',
      'video/mp4',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    return list.find(m => window.MediaRecorder.isTypeSupported(m)) || null;
  }

  function loadImageEl(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image load failed'));
      img.src = url;
    });
  }

  function loadVideoEl(url) {
    return new Promise((resolve, reject) => {
      const v = document.createElement('video');
      v.src = url;
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.crossOrigin = 'anonymous';
      // Bail out if metadata never arrives (bad codec, corrupted file) so the
      // whole export doesn't stall on a single dud entry.
      const timer = setTimeout(() => resolve(v), 5000);
      const done = () => { clearTimeout(timer); resolve(v); };
      v.addEventListener('loadeddata', done, { once: true });
      v.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Video load failed')); }, { once: true });
    });
  }

  function drawContain(ctx, el, srcW, srcH, W, H, alpha) {
    if (!srcW || !srcH) return;
    // "contain" fit: preserve aspect, upscale small sources, downscale large
    // ones, so that one side always touches the target edge.
    const scale = Math.min(W / srcW, H / srcH);
    const w = srcW * scale;
    const h = srcH * scale;
    const x = (W - w) / 2;
    const y = (H - h) / 2;
    if (alpha !== 1) ctx.globalAlpha = alpha;
    ctx.drawImage(el, x, y, w, h);
    if (alpha !== 1) ctx.globalAlpha = 1;
  }

  function drawPrep(ctx, prep, W, H, alpha) {
    drawContain(ctx, prep.el, prep.w, prep.h, W, H, alpha);
  }

  function renderTransitionFrame(ctx, name, cur, nxt, W, H, t) {
    switch (name) {
      case 'none':
        drawPrep(ctx, t < 1 ? cur : nxt, W, H, 1);
        return;
      case 'fade':
      case 'crossfade':
        drawPrep(ctx, cur, W, H, 1 - t);
        drawPrep(ctx, nxt, W, H, t);
        return;
      case 'slide-left':
        ctx.save(); ctx.translate(-t * W, 0); drawPrep(ctx, cur, W, H, 1); ctx.restore();
        ctx.save(); ctx.translate((1 - t) * W, 0); drawPrep(ctx, nxt, W, H, 1); ctx.restore();
        return;
      case 'slide-up':
        ctx.save(); ctx.translate(0, -t * H); drawPrep(ctx, cur, W, H, 1); ctx.restore();
        ctx.save(); ctx.translate(0, (1 - t) * H); drawPrep(ctx, nxt, W, H, 1); ctx.restore();
        return;
      case 'zoom': {
        const s1 = 1 + t * 0.15;
        const s2 = 0.85 + t * 0.15;
        ctx.save();
        ctx.translate(W / 2, H / 2); ctx.scale(s1, s1); ctx.translate(-W / 2, -H / 2);
        drawPrep(ctx, cur, W, H, 1 - t);
        ctx.restore();
        ctx.save();
        ctx.translate(W / 2, H / 2); ctx.scale(s2, s2); ctx.translate(-W / 2, -H / 2);
        drawPrep(ctx, nxt, W, H, t);
        ctx.restore();
        return;
      }
      default:
        drawPrep(ctx, cur, W, H, 1 - t);
        drawPrep(ctx, nxt, W, H, t);
    }
  }

  function showExportOverlay(show) {
    if (show) els.exportOverlay.classList.remove('hidden');
    else els.exportOverlay.classList.add('hidden');
  }

  function updateExportUI(text, pct) {
    els.exportStatusText.textContent = text;
    els.exportProgressBar.style.width = `${Math.min(100, Math.max(0, pct * 100)).toFixed(1)}%`;
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  async function exportVideo(width, height) {
    if (exportInProgress) return;
    if (state.slides.length === 0) { setStatus('Nothing to export.', true); return; }
    const mime = pickVideoMime();
    if (!mime) { setStatus('MediaRecorder is not supported in this browser.', true); return; }

    exportInProgress = true;
    exportCancelled = false;
    showExportOverlay(true);
    updateExportUI('Preparing media…', 0);

    const prepared = [];
    try {
      for (let i = 0; i < state.slides.length; i++) {
        if (exportCancelled) throw new Error('cancelled');
        const s = state.slides[i];
        const pct = ((i + 1) / state.slides.length) * 0.08;
        updateExportUI(`Preparing media (${i + 1}/${state.slides.length})…`, pct);
        if (s.type === 'image') {
          const img = await loadImageEl(s.url);
          prepared.push({ kind: 'image', el: img, w: img.naturalWidth, h: img.naturalHeight });
        } else {
          const v = await loadVideoEl(s.url);
          prepared.push({ kind: 'video', el: v, w: v.videoWidth || 1, h: v.videoHeight || 1 });
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);

      // Draw first frame before starting recorder so the stream has a keyframe.
      drawPrep(ctx, prepared[0], width, height, 1);
      // Use setTimeout instead of requestAnimationFrame so rendering keeps
      // going even if the tab loses focus / is throttled.
      await new Promise(r => setTimeout(r, 30));

      const fps = 30;
      const stream = canvas.captureStream(fps);
      // High-quality bitrates so slideshows keep source detail: aim well above
      // typical streaming presets. Actual encoder may clamp lower on some GPUs.
      const bitrate = height >= 2160
        ? 80_000_000
        : (height >= 1080 ? 25_000_000 : 10_000_000);
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

      const perSlideDurations = computeSlideDurations();
      const totalMs = perSlideDurations.reduce((a, b) => a + b, 0) || 1000;
      const cumulative = [0];
      for (let i = 0; i < perSlideDurations.length - 1; i++) {
        cumulative.push(cumulative[i] + perSlideDurations[i]);
      }
      const minSlide = Math.min(...perSlideDurations);
      const transitionName = els.transitionSelect.value;
      const transitionMs = transitionName === 'none' ? 0 : Math.min(600, Math.max(150, minSlide * 0.2));

      const slideAtTime = (t) => {
        let idx = 0;
        while (idx < perSlideDurations.length - 1 && t >= cumulative[idx + 1]) idx++;
        return { idx, inSlide: t - cumulative[idx], dur: perSlideDurations[idx] };
      };

      // Start first video slide (if any) — fire-and-forget so a hanging
      // play() promise (e.g. HEVC MOV in Chromium) doesn't stall the loop.
      let playingIdx = -1;
      const startSlideVideo = (i) => {
        if (i < 0 || i >= prepared.length) return;
        if (prepared[i].kind !== 'video') return;
        if (playingIdx === i) return;
        try {
          prepared[i].el.currentTime = 0;
          const p = prepared[i].el.play();
          if (p && typeof p.catch === 'function') p.catch(() => { /* autoplay/codec fallback */ });
          playingIdx = i;
        } catch (e) { /* noop */ }
      };
      const pauseSlideVideo = (i) => {
        if (i < 0 || i >= prepared.length) return;
        if (prepared[i].kind !== 'video') return;
        try { prepared[i].el.pause(); } catch (e) { /* noop */ }
      };
      startSlideVideo(0);

      recorder.start();
      const startTime = performance.now();
      let currentIdx = 0;
      let lastTick = -1;

      await new Promise((resolve) => {
        const frameIntervalMs = 1000 / fps;
        const frame = () => {
          if (exportCancelled) { resolve(); return; }
          const now = performance.now();
          const elapsed = now - startTime;
          if (elapsed >= totalMs) { resolve(); return; }

          const { idx: rawIdx, inSlide, dur: slideDur } = slideAtTime(elapsed);
          const transStart = slideDur - transitionMs;
          const isTransitioning = transitionMs > 0 && rawIdx < prepared.length - 1 && inSlide >= transStart;

          if (rawIdx !== currentIdx) {
            pauseSlideVideo(currentIdx);
            currentIdx = rawIdx;
            startSlideVideo(currentIdx);
          }
          if (isTransitioning) startSlideVideo(rawIdx + 1);

          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, width, height);

          if (isTransitioning) {
            const t = (inSlide - transStart) / transitionMs;
            renderTransitionFrame(ctx, transitionName, prepared[rawIdx], prepared[rawIdx + 1], width, height, t);
          } else {
            drawPrep(ctx, prepared[rawIdx], width, height, 1);
          }

          const tick = Math.floor(elapsed / 250);
          if (tick !== lastTick) {
            lastTick = tick;
            const secs = (elapsed / 1000);
            const total = (totalMs / 1000);
            const remaining = Math.max(0, total - secs);
            const phaseProgress = 0.10 + (elapsed / totalMs) * 0.82;
            updateExportUI(
              `Rendering slide ${rawIdx + 1}/${prepared.length} · ${secs.toFixed(1)}s / ${total.toFixed(1)}s (≈ ${remaining.toFixed(1)}s left)`,
              phaseProgress
            );
          }

          setTimeout(frame, frameIntervalMs);
        };
        setTimeout(frame, 0);
      });

      prepared.forEach((p, i) => pauseSlideVideo(i));

      updateExportUI('Finalizing…', 0.95);
      const stopped = new Promise(r => { recorder.onstop = r; });
      try { recorder.stop(); } catch (e) { /* noop */ }
      await stopped;

      if (exportCancelled) throw new Error('cancelled');

      const outMime = chunks[0] && chunks[0].type ? chunks[0].type : mime;
      const blob = new Blob(chunks, { type: outMime });
      const ext = outMime.includes('mp4') ? 'mp4' : 'webm';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      triggerDownload(blob, `slideshow-${width}x${height}-${stamp}.${ext}`);

      const mb = (blob.size / (1024 * 1024)).toFixed(1);
      setStatus(`Exported ${width}×${height} video (${mb} MB).`);
    } catch (e) {
      if (e && e.message === 'cancelled') {
        setStatus('Video export cancelled.');
      } else {
        console.error(e);
        setStatus(`Video export failed: ${e.message || e}`, true);
      }
    } finally {
      // Release videos
      prepared.forEach(p => { if (p.kind === 'video') { try { p.el.pause(); p.el.src = ''; p.el.load && p.el.load(); } catch (err) { /* noop */ } } });
      showExportOverlay(false);
      exportInProgress = false;
    }
  }

  // ---------- Player ----------
  const player = {
    idx: 0,
    timerId: null,
    paused: false,
    loop: false,
    perSlideMsList: [],
    transitionMs: 500,
    activeLayer: 'A',
    currentVideo: null,

    open() {
      if (state.slides.length === 0) return;
      this.perSlideMsList = computeSlideDurations().map(ms => Math.max(300, ms));
      const minSlide = Math.min(...this.perSlideMsList);
      this.transitionMs = Math.min(600, Math.max(150, minSlide * 0.2));
      this.loop = !!els.loopCheckbox.checked;
      this.idx = 0;
      this.paused = false;
      this.activeLayer = 'A';

      els.player.classList.remove('hidden');
      this.applyTransitionClass();
      document.addEventListener('keydown', this.onKey);

      // Fullscreen best-effort
      if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => { /* ignored */ });
      }

      // Reset layers
      els.layerA.className = 'slide-layer';
      els.layerB.className = 'slide-layer';
      els.layerA.innerHTML = '';
      els.layerB.innerHTML = '';

      this.showFirst();
    },

    close() {
      els.player.classList.add('hidden');
      this.clearTimer();
      this.stopCurrentVideo();
      els.layerA.innerHTML = '';
      els.layerB.innerHTML = '';
      document.removeEventListener('keydown', this.onKey);
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => { /* ignored */ });
      }
    },

    applyTransitionClass() {
      const t = els.transitionSelect.value;
      const cls = {
        fade: 't-fade',
        crossfade: 't-cross',
        'slide-left': 't-slide-l',
        'slide-up': 't-slide-u',
        zoom: 't-zoom',
        none: 't-none',
      }[t] || 't-fade';
      els.stage.className = '';
      els.stage.classList.add(cls);
    },

    clearTimer() {
      if (this.timerId) { clearTimeout(this.timerId); this.timerId = null; }
    },

    stopCurrentVideo() {
      if (this.currentVideo) {
        try { this.currentVideo.pause(); } catch (e) { /* noop */ }
        this.currentVideo = null;
      }
    },

    buildSlideElement(slide) {
      if (slide.type === 'image') {
        const img = document.createElement('img');
        img.src = slide.url;
        img.alt = slide.name;
        return img;
      }
      const video = document.createElement('video');
      video.src = slide.url;
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      video.controls = false;
      return video;
    },

    updateCounter() {
      els.playerCounter.textContent = `${this.idx + 1} / ${state.slides.length}`;
    },

    showFirst() {
      const slide = state.slides[0];
      const layer = els.layerA;
      layer.innerHTML = '';
      const node = this.buildSlideElement(slide);
      layer.appendChild(node);
      layer.className = 'slide-layer active';
      els.layerB.className = 'slide-layer';
      this.activeLayer = 'A';
      this.updateCounter();
      if (node.tagName === 'VIDEO') {
        this.currentVideo = node;
        node.play().catch(() => { /* autoplay blocked, ignored */ });
      }
      this.scheduleNext();
    },

    scheduleNext() {
      this.clearTimer();
      if (this.paused) return;
      const dur = this.perSlideMsList[this.idx] || 3000;
      this.timerId = setTimeout(() => this.advance(), dur);
    },

    advance() {
      if (state.slides.length === 0) return;
      const isLast = this.idx === state.slides.length - 1;
      if (isLast && !this.loop) { this.close(); return; }
      const nextIdx = (this.idx + 1) % state.slides.length;
      this.transitionTo(nextIdx);
    },

    next() {
      if (state.slides.length === 0) return;
      const isLast = this.idx === state.slides.length - 1;
      if (isLast && !this.loop) return;
      const nextIdx = (this.idx + 1) % state.slides.length;
      this.transitionTo(nextIdx);
    },

    prev() {
      if (state.slides.length === 0) return;
      const isFirst = this.idx === 0;
      if (isFirst && !this.loop) return;
      const nextIdx = (this.idx - 1 + state.slides.length) % state.slides.length;
      this.transitionTo(nextIdx);
    },

    transitionTo(nextIdx) {
      this.stopCurrentVideo();
      this.clearTimer();

      const slide = state.slides[nextIdx];
      const outLayer = this.activeLayer === 'A' ? els.layerA : els.layerB;
      const inLayer  = this.activeLayer === 'A' ? els.layerB : els.layerA;

      inLayer.innerHTML = '';
      const node = this.buildSlideElement(slide);
      inLayer.appendChild(node);

      // Prepare enter state, then flip to active on next frame
      inLayer.className = 'slide-layer enter behind';
      // Force reflow so the transition applies
      // eslint-disable-next-line no-unused-expressions
      void inLayer.offsetWidth;

      outLayer.classList.remove('active');
      outLayer.classList.add('exit');
      inLayer.classList.remove('enter', 'behind');
      inLayer.classList.add('active');

      this.activeLayer = this.activeLayer === 'A' ? 'B' : 'A';
      this.idx = nextIdx;
      this.updateCounter();

      if (node.tagName === 'VIDEO') {
        this.currentVideo = node;
        node.play().catch(() => { /* ignored */ });
      }

      this.scheduleNext();
    },

    togglePause() {
      this.paused = !this.paused;
      if (this.paused) {
        this.clearTimer();
        if (this.currentVideo) { try { this.currentVideo.pause(); } catch (e) { /* noop */ } }
      } else {
        if (this.currentVideo) { this.currentVideo.play().catch(() => { /* ignored */ }); }
        this.scheduleNext();
      }
    },

    onKey: (e) => {
      if (e.key === 'Escape') { player.close(); }
      else if (e.key === 'ArrowRight') { player.next(); }
      else if (e.key === 'ArrowLeft') { player.prev(); }
      else if (e.key === ' ') { e.preventDefault(); player.togglePause(); }
    },
  };

  // ---------- Wire events ----------
  function closeMenu() {
    els.menuPanel.classList.add('hidden');
    els.menuBtn.setAttribute('aria-expanded', 'false');
    els.menuPanel.setAttribute('aria-hidden', 'true');
  }
  function toggleMenu() {
    const isOpen = !els.menuPanel.classList.contains('hidden');
    if (isOpen) { closeMenu(); return; }
    els.menuPanel.classList.remove('hidden');
    els.menuBtn.setAttribute('aria-expanded', 'true');
    els.menuPanel.setAttribute('aria-hidden', 'false');
  }
  els.menuBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
  els.menuPanel.addEventListener('click', (e) => {
    if (e.target.closest('.menu-item')) closeMenu();
  });
  document.addEventListener('click', (e) => {
    if (els.menuPanel.classList.contains('hidden')) return;
    if (e.target.closest('#menuPanel') || e.target.closest('#menuBtn')) return;
    closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.menuPanel.classList.contains('hidden')) closeMenu();
  });

  els.addBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', async (e) => {
    await handleFiles(e.target.files);
    e.target.value = '';
  });

  els.clearBtn.addEventListener('click', clearAll);
  els.exportBtn.addEventListener('click', exportOrder);
  els.importBtn.addEventListener('click', () => els.configInput.click());
  els.configInput.addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    await importConfigFile(f);
    e.target.value = '';
  });

  els.totalDuration.addEventListener('input', () => {
    updatePerSlideInfo();
    const v = parseInt(els.totalDuration.value, 10);
    if (v > 0) dbSetSetting('totalDuration', v).catch(() => {});
  });
  els.videoDuration.addEventListener('input', () => {
    const newVal = Math.max(0, parseFloat(els.videoDuration.value) || 0);
    const oldVal = lastKnownVideoLength;
    const videoCount = state.slides.filter(s => s.type === 'video').length;
    userSetVideoLength = true;
    if (videoCount > 0) {
      const oldTotal = parseInt(els.totalDuration.value, 10) || 0;
      const delta = newVal - oldVal;
      const newTotal = Math.max(1, Math.round(oldTotal + delta * videoCount));
      if (newTotal !== oldTotal) {
        els.totalDuration.value = String(newTotal);
        dbSetSetting('totalDuration', newTotal).catch(() => {});
      }
    }
    lastKnownVideoLength = newVal;
    updatePerSlideInfo();
    dbSetSetting('videoDuration', newVal).catch(() => {});
  });
  els.transitionSelect.addEventListener('change', () => {
    dbSetSetting('transition', els.transitionSelect.value).catch(() => {});
  });
  els.loopCheckbox.addEventListener('change', () => {
    player.loop = !!els.loopCheckbox.checked;
    dbSetSetting('loop', els.loopCheckbox.checked).catch(() => {});
  });

  els.saveShowBtn.addEventListener('click', saveSlideshow);
  els.loadShowBtn.addEventListener('click', () => els.showInput.click());
  els.showInput.addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    await loadSlideshowFromFile(f);
    e.target.value = '';
  });

  els.exportVideo1080Btn.addEventListener('click', () => exportVideo(1920, 1080));
  els.exportVideo4KBtn.addEventListener('click', () => exportVideo(3840, 2160));
  els.cancelExportBtn.addEventListener('click', () => { exportCancelled = true; });

  els.playBtn.addEventListener('click', () => player.open());
  els.closePlayer.addEventListener('click', () => player.close());
  els.nextBtn.addEventListener('click', () => player.next());
  els.prevBtn.addEventListener('click', () => player.prev());
  els.pauseBtn.addEventListener('click', () => player.togglePause());

  // Auto-hide the player HUD while in fullscreen; reveal briefly on activity.
  let hudHideTimer = null;
  function scheduleHudHide() {
    clearTimeout(hudHideTimer);
    if (document.fullscreenElement) {
      hudHideTimer = setTimeout(() => els.player.classList.add('hud-hidden'), 2500);
    }
  }
  function revealHud() {
    els.player.classList.remove('hud-hidden');
    scheduleHudHide();
  }
  els.player.addEventListener('mousemove', revealHud);
  els.player.addEventListener('touchstart', revealHud, { passive: true });
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) {
      els.player.classList.add('hud-hidden');
      scheduleHudHide();
    } else {
      clearTimeout(hudHideTimer);
      els.player.classList.remove('hud-hidden');
    }
  });

  // Drag-and-drop files onto the page
  ['dragenter', 'dragover'].forEach(evt => {
    document.addEventListener(evt, (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
        e.preventDefault();
      }
    });
  });
  document.addEventListener('drop', async (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    await handleFiles(e.dataTransfer.files);
  });

  // Init
  async function restoreFromDB() {
    try {
      const [records, settings] = await Promise.all([dbGetAllSlides(), dbGetAllSettings()]);
      records.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      state.slides = records
        .filter(r => r && r.blob instanceof Blob)
        .map(r => slideFromRecord(r));

      if (settings.transition && Array.from(els.transitionSelect.options).some(o => o.value === settings.transition)) {
        els.transitionSelect.value = settings.transition;
      }
      if (typeof settings.totalDuration === 'number' && settings.totalDuration > 0) {
        els.totalDuration.value = String(settings.totalDuration);
      }
      if (typeof settings.videoDuration === 'number' && settings.videoDuration >= 0) {
        els.videoDuration.value = String(settings.videoDuration);
        lastKnownVideoLength = settings.videoDuration;
        userSetVideoLength = true;
      }
      if (typeof settings.loop === 'boolean') {
        els.loopCheckbox.checked = settings.loop;
      }

      renderGrid();
      updatePerSlideInfo();
      if (state.slides.length > 0) {
        setStatus(`Restored ${state.slides.length} item(s) from browser storage.`);
      }
    } catch (err) {
      console.warn('IndexedDB restore failed:', err);
      renderGrid();
      updatePerSlideInfo();
    }
  }

  restoreFromDB();
})();
