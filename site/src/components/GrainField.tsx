import { useLayoutEffect, useRef } from "react";

/**
 * GrainField — fixed habitat layer behind all content.
 *
 * Renders a few large aurora blobs + a film-grain overlay. The blobs
 * are repelled away from the cursor (parallax), drift idly, and are
 * fully disabled under prefers-reduced-motion.
 */

type BlobDef = {
  x: number; // base position, % of viewport
  y: number;
  size: number; // vw
  color: string; // rgba
  repulse: number; // px per unit of normalized cursor offset
};

const BLOBS: BlobDef[] = [
  { x: 18, y: 22, size: 58, color: "rgba(67,226,190,0.16)", repulse: 46 },
  { x: 78, y: 30, size: 64, color: "rgba(63,118,255,0.15)", repulse: 60 },
  { x: 62, y: 78, size: 70, color: "rgba(157,133,255,0.15)", repulse: 72 },
  { x: 88, y: 82, size: 44, color: "rgba(67,226,190,0.09)", repulse: 40 },
];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export default function GrainField() {
  const root = useRef<HTMLDivElement>(null);
  const blobs = useRef<HTMLDivElement[]>([]);
  const grain = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const prefersReduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    // ---- idle positions (base + slow drift) ----
    const t0 = performance.now();
    const states = BLOBS.map((b) => ({
      b,
      curX: b.x,
      curY: b.y,
      targetX: b.x,
      targetY: b.y,
    }));

    if (prefersReduced) {
      // paint a static, gentle version
      states.forEach((s, i) => {
        const el = blobs.current[i];
        if (el)
          el.style.transform = `translate3d(${s.b.x}vw, ${s.b.y}vh, 0) translate(-50%, -50%)`;
      });
      return;
    }

    let mx = 0.5;
    let my = 0.5; // normalized cursor 0..1
    let raf = 0;
    let alive = true;

    const onPointer = (e: PointerEvent) => {
      mx = e.clientX / window.innerWidth;
      my = e.clientY / window.innerHeight;
    };

    // repulsion: blob moves AWAY from cursor, scaled by distance
    const tick = () => {
      if (!alive) return;
      const now = performance.now();
      const t = (now - t0) / 1000;

      states.forEach((s, i) => {
        const idleX = s.b.x + Math.sin(t * 0.22 + i * 2.1) * 1.6;
        const idleY = s.b.y + Math.cos(t * 0.18 + i * 1.7) * 1.4;

        const cx = (idleX / 100) * window.innerWidth;
        const cy = (idleY / 100) * window.innerHeight;
        const dx = (cx - mx * window.innerWidth) / window.innerWidth;
        const dy = (cy - my * window.innerHeight) / window.innerHeight;
        const dist = Math.hypot(dx, dy) || 0.0001;

        // stronger push when close, capped
        const push = Math.max(0, 1 - dist / 0.55);
        const offX = (dx / dist) * push * s.b.repulse * 1.6;
        const offY = (dy / dist) * push * s.b.repulse * 1.6;

        s.targetX = idleX + (offX / window.innerWidth) * 100;
        s.targetY = idleY + (offY / window.innerHeight) * 100;

        s.curX = lerp(s.curX, s.targetX, 0.045);
        s.curY = lerp(s.curY, s.targetY, 0.045);

        const el = blobs.current[i];
        if (el)
          el.style.transform = `translate3d(${s.curX}vw, ${s.curY}vh, 0) translate(-50%, -50%)`;
      });

      // grain slowly crawls for a living-film feel
      if (grain.current) {
        const gx = Math.sin(t * 0.05) * 30;
        const gy = Math.cos(t * 0.04) * 26;
        grain.current.style.transform = `translate3d(${gx}px, ${gy}px, 0)`;
      }

      raf = requestAnimationFrame(tick);
    };

    addEventListener("pointermove", onPointer, { passive: true });
    raf = requestAnimationFrame(tick);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      removeEventListener("pointermove", onPointer);
    };
  }, []);

  return (
    <div className="field" ref={root} aria-hidden="true">
      {BLOBS.map((b, i) => (
        <div
          key={i}
          ref={(el) => {
            if (el) blobs.current[i] = el;
          }}
          className="field__blob"
          style={{
            width: `${b.size}vw`,
            height: `${b.size}vw`,
            background: `radial-gradient(circle at 50% 50%, ${b.color}, transparent 68%)`,
            left: `${b.x}vw`,
            top: `${b.y}vh`,
            transform: "translate(-50%, -50%)",
          }}
        />
      ))}
      <div className="field__grain" ref={grain} />
      <div className="field__vig" />
    </div>
  );
}
