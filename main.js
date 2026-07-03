'use strict';
/**
 * main.js — app bootstrap + render loop + UI wiring
 * Uses FilterEngine.switchFilter() for animated crossfade transitions.
 * Keyboard arrow keys cycle through filters.
 */

/* ── DOM refs ── */
const video       = document.getElementById('videoInput');
const canvas      = document.getElementById('canvasOutput');
const filterName  = document.getElementById('filter-name');
const filterIcon  = document.getElementById('filter-icon-hud');
const fpsBadge    = document.getElementById('fps-badge');
const loadEl      = document.getElementById('loading');
const loadMsg     = document.getElementById('load-msg');
const camError    = document.getElementById('cam-error');
const slider      = document.getElementById('intensitySlider');
const intensityVal= document.getElementById('intensity-val');
const filterBtns  = Array.from(document.querySelectorAll('.fb'));

/* ── App state ── */
let camera = null;
let engine = null;
let fps    = null;
let rafId  = null;
let lastTs = 0;

/* ── Boot ── */
document.addEventListener('DOMContentLoaded', startApp);

async function startApp() {
  try {
    loadMsg.textContent = 'Starting camera…';
    camera = new CameraManager(video);
    await camera.start();

    canvas.width  = camera.width  || 1280;
    canvas.height = camera.height || 720;

    loadMsg.textContent = 'Compiling shaders…';
    engine = new FilterEngine(canvas);
    fps    = new FPSCounter(fpsBadge);

    /* Set initial intensity from slider */
    engine.intensity = slider.value / 100;
    slider.style.setProperty('--fill', `${slider.value}%`);

    loadEl.style.display = 'none';
    rafId = requestAnimationFrame(loop);
  } catch (err) {
    loadEl.style.display = 'none';
    camError.classList.remove('hidden');
    console.error('[LiveFilters]', err);
  }
}

/* ── Render loop with delta time ── */
function loop(ts) {
  rafId = requestAnimationFrame(loop);
  if (!camera || !camera.isReady) return;
  const dt = Math.min((ts - lastTs) / 1000, 0.1); /* cap dt at 100ms */
  lastTs = ts;
  engine.render(video, dt);
  fps.tick();
}

/* ── Filter switching with crossfade ── */
function setFilter(name) {
  engine.switchFilter(name);

  filterBtns.forEach(b => b.classList.remove('active'));
  const btn = filterBtns.find(b => b.dataset.filter === name);
  if (btn) btn.classList.add('active');

  /* Update HUD badge */
  filterName.classList.remove('filter-name-anim');
  void filterName.offsetWidth; /* force reflow */
  filterName.classList.add('filter-name-anim');
  filterName.textContent = btn ? btn.textContent.trim() : name;
  filterIcon.textContent = btn ? btn.dataset.icon : '🎥';
}

filterBtns.forEach(btn => {
  btn.addEventListener('click', () => setFilter(btn.dataset.filter));
});

/* ── Keyboard arrow keys ← → to cycle filters ── */
const filterNames = filterBtns.map(b => b.dataset.filter);
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const cur = filterNames.indexOf(engine ? engine.currentFilter : 'normal');
  if (e.key === 'ArrowRight') setFilter(filterNames[(cur + 1) % filterNames.length]);
  if (e.key === 'ArrowLeft')  setFilter(filterNames[(cur - 1 + filterNames.length) % filterNames.length]);
});

/* ── Intensity slider ── */
slider.addEventListener('input', (e) => {
  const v = Number(e.target.value);
  intensityVal.textContent = `${v}%`;
  slider.style.setProperty('--fill', `${v}%`);
  if (engine) engine.intensity = v / 100;
});

/* ── Screenshot: S key ── */
document.addEventListener('keydown', (e) => {
  if (e.key === 's' || e.key === 'S') {
    const a = document.createElement('a');
    a.download = `livefilter-${engine.currentFilter}-${Date.now()}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
  }
});

/* ── Cleanup ── */
window.addEventListener('beforeunload', () => {
  cancelAnimationFrame(rafId);
  if (camera) camera.stop();
});
