import { useEffect, useRef, useState } from "react";

/**
 * FeatureExplorer — a scroll-pinned discovery stage.
 *
 * A tall section (one viewport per feature) with a sticky stage. Scrolling
 * steps through the features: a left rail of graph nodes lights up, a
 * sonar ping radiates from the stage center, and a detail panel
 * crossfades. This replaces the static card grid with a guided,
 * scroll-driven tour of what Spire does.
 */

export type ExplorerFeature = {
  glyph: string;
  color: "flow" | "gate" | "decision";
  title: string;
  body: string;
  tag: string;
};

type Props = { features: ExplorerFeature[] };

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export default function FeatureExplorer({ features }: Props) {
  const n = features.length;
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [ping, setPing] = useState(0); // increments to retrigger sonar
  const activeRef = useRef(0);
  const pingRef = useRef(0);

  // ---- scroll-driven stepping ----
  useEffect(() => {
    const prefersReduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    let raf = 0;

    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = root.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const total = rect.height - window.innerHeight;
        if (total <= 0) return;
        const progress = Math.min(1, Math.max(0, -rect.top / total));
        let idx = Math.round(progress * (n - 1));
        if (prefersReduced) {
          // on reduced motion, only step when clearly crossing midpoints
          idx = Math.floor(progress * n + 0.5);
        }
        idx = Math.min(n - 1, Math.max(0, idx));
        if (idx !== activeRef.current) {
          activeRef.current = idx;
          pingRef.current += 1;
          setActive(idx);
          setPing(pingRef.current);
        }
      });
    };

    onScroll();
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener("scroll", onScroll);
      removeEventListener("resize", onScroll);
    };
  }, [n]);

  // ---- soft crossfade driver for the detail panel ----
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (active === shown) return;
    const t = setTimeout(() => setShown(active), 120);
    return () => clearTimeout(t);
  }, [active, shown]);

  const f = features[shown];

  return (
    <div className="explorer" ref={root} style={{ height: `${n * 92}vh` }}>
      <div className="explorer-stage" ref={stage}>
        {/* ---- left rail: graph nodes ---- */}
        <div className="explorer-rail mono" aria-hidden="true">
          <div className="rail-line">
            {features.map((feat, i) => (
              <span
                key={i}
                className={`rail-node ${i <= active ? "rail-node--on" : ""}`}
                style={{ "--c": `var(--${feat.color})` } as React.CSSProperties}
              >
                <i />
              </span>
            ))}
          </div>
          <div className="rail-labels">
            {features.map((feat, i) => (
              <span
                key={i}
                className={`rail-label ${i === active ? "rail-label--active" : ""}`}
              >
                {String(i + 1).padStart(2, "0")}
              </span>
            ))}
          </div>
        </div>

        {/* ---- center: sonar stage ---- */}
        <div className="explorer-core" aria-hidden="true">
          <span className={`core-ping ${ping > 0 ? "core-ping--go" : ""}`} key={ping} />
          <span className="core-ping core-ping--b" key={`b-${ping}`} />
          <span
            className="core-glyph"
            style={{ color: `var(--${f.color})`, "--cg": `var(--${f.color}-soft)` } as React.CSSProperties}
          >
            {f.glyph}
          </span>
          <span className="core-tag mono">node.{String(shown + 1).padStart(2, "0")}</span>
        </div>

        {/* ---- right: detail panel ---- */}
        <div className="explorer-detail">
          <div key={shown} className="detail-card" style={{ "--c": `var(--${f.color})`, "--cg": `var(--${f.color}-soft)` } as React.CSSProperties}>
            <span className="detail-tag mono">{f.tag}</span>
            <h3 className="detail-title">{f.title}</h3>
            <p className="detail-body">{f.body}</p>
          </div>

          <div className="explorer-progress mono" aria-hidden="true">
            <span className="p-cur">{String(active + 1).padStart(2, "0")}</span>
            <span className="p-bar"><i style={{ width: `${((active + 1) / n) * 100}%` }} /></span>
            <span className="p-total">{String(n).padStart(2, "0")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
