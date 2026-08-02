import { useLayoutEffect, useRef } from "react";
import gsap from "gsap";

/** Semantic node kinds → colors echoing the design tokens. */
const C = {
  flow: "#4ee6c3",
  decision: "#a98cff",
  gate: "#f5b04a",
};

type NodeKind = "flow" | "gate" | "decision";

type GNode = {
  id: string;
  label: string;
  title: string;
  kind: NodeKind;
  x: number;
  y: number;
};

type GEdge = {
  from: string;
  to: string;
  path: string; // svg path (no leading M, appended to "M0 0")
  width: number;
};

const NODES: GNode[] = [
  { id: "research",  label: "AGENT",    title: "Research",  kind: "flow",     x: 40, y: 122 },
  { id: "implement", label: "AGENT",    title: "Implement", kind: "flow",     x: 232, y: 40 },
  { id: "review",    label: "DECISION", title: "Review",    kind: "decision", x: 232, y: 204 },
  { id: "gate",      label: "GATE",     title: "Gate",      kind: "gate",     x: 424, y: 122 },
  { id: "deploy",    label: "AGENT",    title: "Deploy",    kind: "flow",     x: 588, y: 122 },
];

const EDGES: GEdge[] = [
  { from: "research", to: "implement", path: "M118 114 C 150 92, 190 66, 228 56", width: 2 },
  { from: "research", to: "review",    path: "M112 164 C 140 196, 180 214, 220 210", width: 2 },
  { from: "implement", to: "review",   path: "M236 66 C 252 100, 250 168, 244 192", width: 2 },
  { from: "review", to: "gate",        path: "M288 192 C 330 166, 384 138, 414 132", width: 2.4 },
  { from: "implement", to: "gate",     path: "M272 62 C 320 78, 380 108, 412 122", width: 2 },
  { from: "gate", to: "deploy",        path: "M468 122 L 560 122", width: 2.6 },
];

const nodeColor = (k: NodeKind) =>
  k === "flow" ? C.flow : k === "gate" ? C.gate : C.decision;

export default function HeroGraph() {
  const root = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ctx = gsap.context(() => {
      if (prefersReduced) {
        gsap.set([".hg-node", ".hg-edge--line"], {
          autoAlpha: 1,
          strokeDashoffset: 0,
          opacity: 1,
        });
        return;
      }
      const edges = gsap.utils.toArray<SVGPathElement>(".hg-edge--line");
      const nodes = gsap.utils.toArray<SVGGElement>(".hg-node");
      gsap.set(nodes, { opacity: 0, scale: 0.6, transformOrigin: "50% 50%" });

      const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
      edges.forEach((e, i) => {
        const len = e.getTotalLength();
        tl.fromTo(
          e,
          { strokeDasharray: len, strokeDashoffset: len },
          { strokeDashoffset: 0, duration: 0.6, ease: "power2.inOut" },
          i * 0.16
        );
      });
      tl.to(
        nodes,
        { opacity: 1, scale: 1, stagger: 0.09, duration: 0.5 },
        "-=0.1"
      );
      tl.fromTo(
        ".hg-node__label",
        { opacity: 0, y: 4 },
        { opacity: 1, y: 0, stagger: 0.09, duration: 0.4 },
        "-=0.2"
      );
    }, root);
    return () => ctx.revert();
  }, []);

  const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));

  return (
    <div className="hero-graph" ref={root} aria-hidden="true">
      <span className="hg-bracket hg-bracket--tl" />
      <span className="hg-bracket hg-bracket--br" />
      <div className="hg-hud mono">runs.active ▸ live · worktree.spire-7f2</div>

      <svg viewBox="0 0 660 260" className="hg-svg">
        <defs>
          <linearGradient id="hgGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#4ee6c3" />
            <stop offset="0.6" stopColor="#38bdf8" />
            <stop offset="1" stopColor="#a98cff" />
          </linearGradient>
          <filter id="hgNodeGlow" x="-200%" y="-200%" width="500%" height="500%">
            <feGaussianBlur stdDeviation="5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {EDGES.map((e) => {
          const fromN = byId[e.from];
          return (
            <g className="hg-edge" key={`${e.from}-${e.to}`}>
              <path
                className="hg-edge--underlay"
                d={`M0 0 ${e.path}`}
                stroke={nodeColor(fromN.kind)}
                strokeOpacity="0.12"
                strokeWidth={e.width + 6}
                fill="none"
              />
              <path
                className="hg-edge--line hg-edge--animate"
                d={`M0 0 ${e.path}`}
                stroke="url(#hgGrad)"
                strokeWidth={e.width}
                fill="none"
                strokeLinecap="round"
              />
            </g>
          );
        })}

        {NODES.map((n) => {
          const col = nodeColor(n.kind);
          return (
            <g className="hg-node" key={n.id} transform={`translate(${n.x} ${n.y})`}>
              <circle cx="0" cy="0" r="13" fill={col} opacity="0.12" />
              <circle cx="0" cy="0" r="9" fill="#0a0f12" stroke={col} strokeWidth="1.5" filter="url(#hgNodeGlow)" />
              <g className="hg-node__label">
                <text className="node-title" x="20" y="3" fontSize="14" fontWeight="650" fill="#e7ecef">
                  {n.title}
                </text>
                <text className="node-kind" x="20" y="18" fontSize="8" letterSpacing="2" fill="#58666f">
                  {n.label}
                </text>
              </g>
            </g>
          );
        })}
      </svg>
    </div>
  );
}