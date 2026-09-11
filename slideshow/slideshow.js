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
    playBtn: document.getElementById('playBtn'),
    transitionSelect: document.getElementById('transitionSelect'),
    totalDuration: document.getElementById('totalDuration'),
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

  function updatePerSlideInfo() {
    const total = Math.max(1, parseInt(els.totalDuration.value, 10) || 0);
    const n = state.slides.length;
    if (n === 0) {
      els.perSlideInfo.textContent = '';
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

  // ---------- Player ----------
  const player = {
    idx: 0,
    timerId: null,
    paused: false,
    loop: false,
    perSlideMs: 3000,
    activeLayer: 'A',
    currentVideo: null,

    open() {
      if (state.slides.length === 0) return;
      const total = Math.max(1, parseInt(els.totalDuration.value, 10) || 0);
      this.perSlideMs = Math.max(500, (total / state.slides.length) * 1000);
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
      this.timerId = setTimeout(() => this.advance(), this.perSlideMs);
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

  els.playBtn.addEventListener('click', () => player.open());
  els.closePlayer.addEventListener('click', () => player.close());
  els.nextBtn.addEventListener('click', () => player.next());
  els.prevBtn.addEventListener('click', () => player.prev());
  els.pauseBtn.addEventListener('click', () => player.togglePause());

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
