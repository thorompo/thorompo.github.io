// Power Mode — particle burst + screen shake + combo on every keystroke.
// Standalone module: exposes window.PowerMode.trigger(element, correct).
(function () {
  const COMBO_TIMEOUT_MS = 10000;
  const PARTICLES_CORRECT = 14;
  const PARTICLES_WRONG = 8;
  const SHAKE_DECAY = 0.88;
  const SHAKE_MAX = 10;

  const CORRECT_COLORS = ['#38bdf8', '#7dd3fc', '#5eead4', '#fbbf24', '#c9d1d9'];
  const WRONG_COLORS = ['#f87171', '#fca5a5', '#ef4444'];

  let canvas, ctx;
  let particles = [];
  let combo = 0;
  let lastKeyTime = 0;
  let shakeIntensity = 0;
  let comboBadge;
  let shakeTarget = null;

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
      @media (max-width: 640px) {
        #powerModeCombo { right: 0.75rem; }
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

    shakeTarget = document.getElementById('typingArea') || document.body;

    resize();
    window.addEventListener('resize', resize);
    requestAnimationFrame(loop);
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

    if (combo > 0 && performance.now() - lastKeyTime > COMBO_TIMEOUT_MS) {
      combo = 0;
      updateBadge();
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
    if (!element || !canvas) return;
    const rect = element.getBoundingClientRect();
    spawnAt(rect, correct);
    if (correct) {
      combo++;
    } else {
      combo = Math.max(0, combo - 2);
    }
    lastKeyTime = performance.now();
    shakeIntensity = Math.min(2 + combo * 0.18, SHAKE_MAX);
    updateBadge();
  }

  window.PowerMode = { trigger };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
