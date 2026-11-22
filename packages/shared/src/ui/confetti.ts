// One-shot confetti burst on a temporary full-window canvas (canvas-confetti's particle model).

export interface ConfettiOptions {
  readonly particleCount?: number;
  /** Degrees; 90 fires straight up. */
  readonly angle?: number;
  readonly spread?: number;
  readonly startVelocity?: number;
  readonly decay?: number;
  readonly gravity?: number;
  /** Lifetime in 60 Hz frames. */
  readonly ticks?: number;
  /** Viewport fractions. */
  readonly origin?: { readonly x: number; readonly y: number };
  readonly colors?: readonly string[];
  readonly zIndex?: number;
  readonly disableForReducedMotion?: boolean;
}

const COLORS = ["#26ccff", "#a25afd", "#ff5e7e", "#88ff5a", "#fcff42", "#ffa62d", "#ff36ff"];
const FRAME_MS = 1000 / 60;

/** Resolves once every particle has faded and the canvas is gone. */
export function confetti(options: ConfettiOptions = {}): Promise<void> {
  const { particleCount = 50, angle = 90, spread = 45, startVelocity = 45, decay = 0.9, gravity = 1, ticks = 200 } = options;
  if (options.disableForReducedMotion && matchMedia("(prefers-reduced-motion: reduce)").matches) return Promise.resolve();
  const canvas = document.createElement("canvas");
  canvas.style.cssText = `position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:${options.zIndex ?? 100}`;
  document.body.append(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    return Promise.resolve();
  }
  const dpr = devicePixelRatio || 1;
  const width = innerWidth;
  const height = innerHeight;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);

  const colors = options.colors ?? COLORS;
  const rad = Math.PI / 180;
  const particles = Array.from({ length: particleCount }, (_, i) => ({
    x: (options.origin?.x ?? 0.5) * width,
    y: (options.origin?.y ?? 0.5) * height,
    angle: -angle * rad + spread * rad * (0.5 - Math.random()),
    velocity: startVelocity * (0.5 + Math.random()),
    wobble: Math.random() * 10,
    wobbleSpeed: Math.min(0.11, Math.random() * 0.1 + 0.05),
    tilt: (Math.random() * 0.5 + 0.25) * Math.PI,
    color: colors[i % colors.length]!,
  }));

  return new Promise((resolve) => {
    let start: number | undefined;
    let last = 0;
    const frame = (now: number) => {
      start ??= now;
      const tick = (now - start) / FRAME_MS;
      const step = Math.min(4, tick - last);
      last = tick;
      ctx.clearRect(0, 0, width, height);
      if (tick >= ticks) {
        canvas.remove();
        resolve();
        return;
      }
      ctx.globalAlpha = 1 - tick / ticks;
      for (const p of particles) {
        p.x += Math.cos(p.angle) * p.velocity * step;
        p.y += (Math.sin(p.angle) * p.velocity + gravity * 3) * step;
        p.velocity *= decay ** step;
        p.wobble += p.wobbleSpeed * step;
        p.tilt += 0.1 * step;
        const r = Math.random() + 2;
        const wx = p.x + 10 * Math.cos(p.wobble);
        const wy = p.y + 10 * Math.sin(p.wobble);
        const [tx, ty] = [r * Math.cos(p.tilt), r * Math.sin(p.tilt)];
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(wx, p.y + ty);
        ctx.lineTo(wx + tx, wy + ty);
        ctx.lineTo(p.x + tx, wy);
        ctx.fill();
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}
