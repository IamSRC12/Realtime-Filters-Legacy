/**
 * FPSCounter.js
 * Tracks real-time frames per second and updates a DOM element.
 */
class FPSCounter {
  constructor(el) {
    this.el        = el;
    this.frames    = 0;
    this.lastTime  = performance.now();
  }

  tick() {
    this.frames++;
    const now   = performance.now();
    const delta = now - this.lastTime;
    if (delta >= 500) {
      const fps = Math.round((this.frames * 1000) / delta);
      this.frames   = 0;
      this.lastTime = now;
      this.el.textContent = `${fps} fps`;
      const color = fps >= 25 ? '#10b981' : fps >= 15 ? '#f59e0b' : '#ef4444';
      this.el.style.color       = color;
      this.el.style.borderColor = `${color}40`;
      this.el.style.background  = `${color}15`;
    }
  }
}
