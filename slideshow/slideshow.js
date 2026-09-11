(() => {
  'use strict';

  const HEIC_EXT = /\.(heic|heif)$/i;
  const VIDEO_EXT = /\.(mp4|m4v|mov|webm|3gp|mkv|avi|ogv)$/i;
  const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif)$/i;

  const state = {
    slides: [], // { id, name, type, url, revoke, natW, natH }
    nextId: 1,
  };

  const els = {
    fileInput: document.getElementById('fileInput'),
    configInput: document.getElementById('configInput'),
    addBtn: document.getElementById('addBtn'),
    clearBtn: document.getElementById('clearBtn'),
    exportBtn: document.getElementById('exportBtn'),
    importBtn: document.getElementById('importBtn'),
    playBtn: document.getElementById('playBtn'),
    transitionSelect: document.getElementById('transitionSelect'),
    totalDuration: document.getElementById('totalDuration'),
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

  async function fileToSlide(file) {
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
          // fallthrough — browser may still render it (Safari)
        }
      }
    }

    const url = URL.createObjectURL(blob);
    return {
      id: state.nextId++,
      name: file.name,
      type,
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

    for (const f of files) {
      try {
        const slide = await fileToSlide(f);
        state.slides.push(slide);
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
      setStatus(`Loaded ${ok} file(s).`);
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
        // Re-render just the indices without full rebuild
        Array.from(els.grid.children).forEach((el, i) => {
          const idx = el.querySelector('.idx');
          if (idx) idx.textContent = String(i + 1);
        });
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
  }

  function clearAll() {
    if (state.slides.length === 0) return;
    if (!confirm('Remove all loaded media?')) return;
    state.slides.forEach(s => { try { s.revoke && s.revoke(); } catch (e) { /* noop */ } });
    state.slides = [];
    renderGrid();
    updatePerSlideInfo();
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

  // ---------- Player ----------
  const player = {
    idx: 0,
    timerId: null,
    paused: false,
    perSlideMs: 3000,
    activeLayer: 'A',
    currentVideo: null,

    open() {
      if (state.slides.length === 0) return;
      const total = Math.max(1, parseInt(els.totalDuration.value, 10) || 0);
      this.perSlideMs = Math.max(500, (total / state.slides.length) * 1000);
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
      this.timerId = setTimeout(() => this.next(), this.perSlideMs);
    },

    next() {
      if (state.slides.length === 0) return;
      const nextIdx = (this.idx + 1) % state.slides.length;
      this.transitionTo(nextIdx);
    },

    prev() {
      if (state.slides.length === 0) return;
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

  els.totalDuration.addEventListener('input', updatePerSlideInfo);
  els.transitionSelect.addEventListener('change', () => { /* used on Play */ });

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
  updatePerSlideInfo();
  renderGrid();
})();
