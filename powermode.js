// Power Mode — particle burst + screen shake + combo on every keystroke.
// Standalone module: exposes window.PowerMode.trigger(element, correct).
(function () {
  const PARTICLES_CORRECT = 14;
  const PARTICLES_WRONG = 8;
  const SHAKE_DECAY = 0.88;
  const SHAKE_MAX = 10;

  const CORRECT_COLORS = ['#38bdf8', '#7dd3fc', '#5eead4', '#fbbf24', '#c9d1d9'];
  const WRONG_COLORS = ['#f87171', '#fca5a5', '#ef4444'];
  const STORAGE_KEY = 'powerMode.enabled';

  let canvas, ctx;
  let particles = [];
  let combo = 0;
  let maxCombo = 0;
  let shakeIntensity = 0;
  let comboBadge;
  let shakeTarget = null;
  let toggleBtn;
  let enabled = loadEnabled();

  function loadEnabled() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return v === null ? true : v === 'true';
    } catch (_) {
      return true;
    }
  }

  function saveEnabled(v) {
    try { localStorage.setItem(STORAGE_KEY, String(v)); } catch (_) {}
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #powerModeCanvas {
        position: fixed; inset: 0; width: 100%; height: 100%;
        pointer-events: none; z-index: 9999;
      }
      #powerModeCombo {
        position: fixed; top: 50%; right: 2rem;
        transform: translateY(-50%);
        font-family: 'JetBrains Mono', monospace;
        font-weight: bold; color: #38bdf8;
        text-shadow: 0 0 20px rgba(56, 189, 248, 0.8),
                     0 0 40px rgba(56, 189, 248, 0.4);
        pointer-events: none; z-index: 9998;
        opacity: 0;
        transition: opacity 0.3s ease, font-size 0.15s ease;
        display: flex; flex-direction: column; align-items: flex-end;
        line-height: 1;
      }
      #powerModeCombo.visible { opacity: 1; }
      #powerModeCombo .combo-num { font-size: 1em; }
      #powerModeCombo .combo-label {
        font-size: 0.28em; color: #6b7280; letter-spacing: 0.25em;
        margin-top: 0.4em;
      }
      #powerModeToggle {
        position: absolute; top: 1rem; right: 1rem;
        width: 38px; height: 38px;
        display: inline-flex; align-items: center; justify-content: center;
        font-family: 'JetBrains Mono', monospace;
        font-size: 1.1rem; line-height: 1;
        padding: 0;
        border-radius: 8px;
        border: 1px solid #374151;
        background: rgba(13, 17, 23, 0.85);
        color: #6b7280;
        cursor: pointer;
        user-select: none;
        transition: color 0.2s, border-color 0.2s, box-shadow 0.2s, transform 0.1s;
      }
      #powerModeToggle:hover { transform: translateY(-1px); }
      #powerModeToggle.on {
        color: #38bdf8;
        border-color: #38bdf8;
        box-shadow: 0 0 12px rgba(56, 189, 248, 0.35);
      }
      @media (max-width: 640px) {
        #powerModeCombo { right: 0.75rem; }
        #powerModeToggle { width: 32px; height: 32px; font-size: 0.95rem; }
      }
    `;
    document.head.appendChild(style);
  }

  function init() {
    injectStyles();

    canvas = document.createElement('canvas');
    canvas.id = 'powerModeCanvas';
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');

    comboBadge = document.createElement('div');
    comboBadge.id = 'powerModeCombo';
    document.body.appendChild(comboBadge);

    toggleBtn = document.createElement('button');
    toggleBtn.id = 'powerModeToggle';
    toggleBtn.type = 'button';
    // Prevent the button from stealing focus from the typing input.
    toggleBtn.addEventListener('mousedown', (e) => e.preventDefault());
    toggleBtn.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    toggleBtn.addEventListener('click', () => setEnabled(!enabled));
    document.body.appendChild(toggleBtn);
    renderToggle();

    shakeTarget = document.getElementById('typingArea') || document.body;

    resize();
    window.addEventListener('resize', resize);
    requestAnimationFrame(loop);
  }

  function renderToggle() {
    if (!toggleBtn) return;
    toggleBtn.textContent = '⚡';
    toggleBtn.title = enabled ? 'Power Mode: ON (click to disable)' : 'Power Mode: OFF (click to enable)';
    toggleBtn.classList.toggle('on', enabled);
    toggleBtn.setAttribute('aria-pressed', String(enabled));
    toggleBtn.setAttribute('aria-label', 'Toggle Power Mode');
  }

  function setEnabled(v) {
    enabled = !!v;
    saveEnabled(enabled);
    renderToggle();
    if (!enabled) {
      particles.length = 0;
      combo = 0;
      shakeIntensity = 0;
      if (shakeTarget) shakeTarget.style.transform = '';
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      updateBadge();
    }
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function spawnAt(rect, correct) {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const count = correct ? PARTICLES_CORRECT : PARTICLES_WRONG;
    const palette = correct ? CORRECT_COLORS : WRONG_COLORS;
    const boost = Math.min(combo * 0.08, 2.5);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = (1 + Math.random() * 4) * (1 + boost * 0.3);
      particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1.2,
        life: 1,
        size: 2 + Math.random() * 3,
        color: palette[Math.floor(Math.random() * palette.length)],
      });
    }
  }

  function loop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (shakeIntensity > 0.05 && shakeTarget) {
      const dx = (Math.random() - 0.5) * shakeIntensity;
      const dy = (Math.random() - 0.5) * shakeIntensity;
      shakeTarget.style.transform = `translate(${dx}px, ${dy}px)`;
      shakeIntensity *= SHAKE_DECAY;
    } else if (shakeIntensity > 0 && shakeTarget) {
      shakeIntensity = 0;
      shakeTarget.style.transform = '';
    }

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.vy += 0.14;
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 0.022;
      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = Math.max(p.life, 0);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(loop);
  }

  function updateBadge() {
    if (combo < 3) {
      comboBadge.classList.remove('visible');
      return;
    }
    comboBadge.classList.add('visible');
    comboBadge.innerHTML =
      `<span class="combo-num">${combo}</span>` +
      `<span class="combo-label">COMBO</span>`;
    const size = Math.min(2 + combo * 0.04, 5);
    comboBadge.style.fontSize = size + 'rem';
  }

  function trigger(element, correct) {
    if (!enabled || !element || !canvas) return;
    const rect = element.getBoundingClientRect();
    spawnAt(rect, correct);
    if (correct) {
      combo++;
      if (combo > maxCombo) maxCombo = combo;
    } else {
      combo = 0;
    }
    shakeIntensity = Math.min(2 + combo * 0.18, SHAKE_MAX);
    updateBadge();
  }

  function resetStats() {
    combo = 0;
    maxCombo = 0;
    updateBadge();
  }

  window.PowerMode = {
    trigger,
    setEnabled,
    isEnabled: () => enabled,
    getMaxCombo: () => maxCombo,
    resetStats,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
