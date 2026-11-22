import { useEffect, useRef } from "react";

// Four small animated vignettes of how a step hands off: the same drawings alinery.ai shows under
// Composable Swarm Dynamics, kept equal to the site's by hand.
// ponytail: hand-rolled timelines in [0,1); each tile owns its geometry. No library.

const SVG = "http://www.w3.org/2000/svg";
type Pt = [number, number];
type Attrs = Record<string, string | number>;
type Tile = { period: number; draw: (t: number) => void };

const HAND =
  "M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15";

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs, parent: SVGElement): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  parent.appendChild(node);
  return node;
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
const ease = (t: number) => t * t * (3 - 2 * t);
const rad = (d: number) => (d * Math.PI) / 180;
// A shallow arc of a big circle below the tile, so every tile reads as a piece of the hero ring.
const arc = (cx: number, cy: number, R: number) => ({
  pt: (a: number, off = 0): Pt => [cx + (R + off) * Math.cos(a), cy + (R + off) * Math.sin(a)],
  path: (a1: number, a2: number, off = 0) => {
    const [x1, y1] = [cx + (R + off) * Math.cos(a1), cy + (R + off) * Math.sin(a1)],
      [x2, y2] = [cx + (R + off) * Math.cos(a2), cy + (R + off) * Math.sin(a2)];
    return `M${x1},${y1} A${R + off},${R + off} 0 0 1 ${x2},${y2}`;
  },
});
const node = (svg: SVGElement, [x, y]: Pt, cls = "") => el("circle", { cx: x, cy: y, r: 10, class: `nd ${cls}` }, svg);
const label = (svg: SVGElement, x: number, y: number, text: string, cls = "nl", anchor = "middle") => {
  const t = el("text", { x, y, class: cls, "text-anchor": anchor }, svg);
  t.textContent = text;
  return t;
};
const hand = (svg: SVGElement, [x, y]: Pt) => {
  const g = el("g", { transform: `translate(${x - 8},${y - 8})` }, svg);
  el("circle", { cx: 8, cy: 8, r: 8, class: "hand" }, g);
  el(
    "path",
    { d: HAND, transform: "translate(3.2,3.2) scale(.4)", fill: "none", stroke: "var(--warning)", "stroke-width": "2.2", "stroke-linecap": "round", "stroke-linejoin": "round" },
    g,
  );
  return g;
};
const dots = (svg: SVGElement, count: number, r = 3.2) => Array.from({ length: count }, () => el("circle", { r, class: "dot" }, svg));
const put = (d: SVGCircleElement, [x, y]: Pt, cls = "dot") => {
  d.setAttribute("cx", x.toFixed(1));
  d.setAttribute("cy", y.toFixed(1));
  d.setAttribute("class", cls);
  d.style.display = "";
};
const hide = (d: SVGCircleElement) => {
  d.style.display = "none";
};
const orbit = (c: Pt, k: number, t: number, r = 12): Pt => [c[0] + Math.cos(k * 2.4 + t * 6) * r, c[1] + Math.sin(k * 2.4 + t * 6) * r];
const status = (t: SVGTextElement, text: string, hi = false) => {
  t.textContent = text;
  t.setAttribute("class", hi ? "st hi" : "st");
};

function branch(svg: SVGElement): Tile {
  const A = arc(300, 480, 400),
    a1 = rad(-120),
    a2 = rad(-90),
    a3 = rad(-60),
    PA = A.pt(a1),
    PB = A.pt(a2),
    PC = A.pt(a3),
    N = 9;
  for (const o of [-6, 0, 6]) {
    el("path", { d: `M${PA[0]},${PA[1]} Q${A.pt((a1 + a2) / 2, o * 1.5).join(",")} ${A.pt(a2, o).join(",")}`, class: "seg" }, svg);
    el("path", { d: `M${A.pt(a2, o).join(",")} Q${A.pt((a2 + a3) / 2, o * 1.5).join(",")} ${PC.join(",")}`, class: "seg" }, svg);
  }
  const nA = node(svg, PA);
  el("circle", { cx: PB[0] + 6, cy: PB[1] - 6, r: 10, class: "nd", opacity: 0.4 }, svg);
  el("circle", { cx: PB[0] + 3, cy: PB[1] - 3, r: 10, class: "nd", opacity: 0.7 }, svg);
  const nB = node(svg, PB),
    nC = node(svg, PC);
  label(svg, PA[0], PA[1] + 26, "Find sources");
  label(svg, PB[0], PB[1] + 30, "Read one source");
  label(svg, PC[0], PC[1] + 26, "Synthesize");
  label(svg, PA[0], PA[1] + 40, "source-request-*.md", "st");
  label(svg, PB[0], PB[1] + 44, "each", "st");
  label(svg, PC[0], PC[1] + 40, "complete", "st");
  const st = label(svg, 300, 18, "", "st hi");
  const ds = dots(svg, N);
  return {
    period: 7000,
    draw: (t) => {
      nA.setAttribute("class", `nd${t < 0.16 ? " on" : " done"}`);
      nB.setAttribute("class", `nd${t > 0.2 && t < 0.78 ? " on" : t >= 0.78 ? " done" : ""}`);
      nC.setAttribute("class", `nd${t > 0.9 ? " on" : ""}`);
      let arrived = 0;
      ds.forEach((d, k) => {
        const off = ((k % 3) - 1) * 6,
          lag = (k / N) * 0.12,
          w = 0.6 + ((k * 7) % 5) / 10; // each reader takes its own time
        if (t < 0.12) {
          if (k === 0) put(d, orbit(PA, 0, t), "dot work");
          else hide(d);
          return;
        }
        if (t < 0.16) {
          put(d, PA);
          return;
        }
        const p1 = seg(t, 0.16 + lag, 0.36 + lag);
        if (p1 < 1) {
          put(d, A.pt(lerp(a1, a2, ease(p1)), off * Math.sin(Math.PI * p1) * 1.5));
          return;
        }
        const done = 0.36 + lag + 0.3 * w;
        if (t < done) {
          put(d, orbit([PB[0] + off * 0.6, PB[1] - off * 0.4], k, t, 7 + (k % 2) * 4), "dot work");
          return;
        }
        const p2 = seg(t, done, done + 0.16);
        if (p2 < 1) {
          put(d, A.pt(lerp(a2, a3, ease(p2)), off * Math.sin(Math.PI * p2) * 1.5));
          return;
        }
        arrived++;
        if (t < 0.9) put(d, orbit(PC, k, 0, 8), "dot wait");
        else if (k === 0) put(d, orbit(PC, 0, t), "dot work");
        else hide(d);
      });
      status(
        st,
        t < 0.16 ? "1 agent finds 9 sources" : t < 0.9 ? `${N} readers · ${arrived} of ${N} assessments in · synthesis waits` : "collection complete · 1 agent synthesizes",
        true,
      );
    },
  };
}

function human(svg: SVGElement): Tile {
  const A = arc(150, 430, 350),
    a1 = rad(-112),
    a2 = rad(-90),
    a3 = rad(-68),
    PA = A.pt(a1),
    PB = A.pt(a2),
    PC = A.pt(a3),
    PH = A.pt((a2 + a3) / 2 - 0.02);
  el("path", { d: A.path(a1, a3), class: "seg" }, svg);
  const nA = node(svg, PA),
    nB = node(svg, PB, "cp"),
    nC = node(svg, PC);
  const hg = hand(svg, PH);
  const tap = el("circle", { cx: PH[0], cy: PH[1], r: 8, class: "tap", opacity: 0 }, svg);
  label(svg, PA[0] - 10, PA[1] + 26, "Plan", "nl", "start");
  label(svg, PB[0], PB[1] + 26, "Decide");
  label(svg, PC[0] + 10, PC[1] + 26, "Build", "nl", "end");
  const st = label(svg, 150, 18, "", "st");
  const [d] = dots(svg, 1, 4);
  return {
    period: 5200,
    draw: (t) => {
      nA.setAttribute("class", `nd${t < 0.2 ? " on" : " done"}`);
      nB.setAttribute("class", `nd cp${t > 0.2 && t < 0.78 ? " on" : ""}`);
      nC.setAttribute("class", `nd${t > 0.9 ? " on" : ""}`);
      hg.setAttribute("opacity", t > 0.42 && t < 0.78 ? "1" : ".55");
      if (t < 0.2) {
        put(d, A.pt(lerp(a1, a2, ease(seg(t, 0, 0.2)))));
        status(st, "handing off");
        tap.setAttribute("opacity", "0");
      } else if (t < 0.42) {
        put(d, orbit(PB, 0, t), "dot work");
        status(st, "working on decide.md");
      } else if (t < 0.74) {
        put(d, [PB[0], PB[1] - 16 + Math.sin(t * 40) * 1.5], "dot wait");
        status(st, "decide.md ready · waiting for you", true);
        tap.setAttribute("opacity", "0");
      } else if (t < 0.8) {
        const p = seg(t, 0.74, 0.8);
        tap.setAttribute("r", String(8 + p * 16));
        tap.setAttribute("opacity", String(1 - p));
        put(d, [PB[0], PB[1] - 16], "dot wait");
        status(st, "you: looks good, continue", true);
      } else {
        put(d, A.pt(lerp(a2, a3, ease(seg(t, 0.8, 1)))));
        status(st, "moving on to Build");
        tap.setAttribute("opacity", "0");
      }
    },
  };
}

function parallel(svg: SVGElement): Tile {
  const PA: Pt = [40, 90],
    B1: Pt = [150, 50],
    B2: Pt = [150, 130],
    PC: Pt = [260, 90];
  const q = (a: Pt, b: Pt, lift: number) => `M${a[0]},${a[1]} Q${(a[0] + b[0]) / 2},${(a[1] + b[1]) / 2 + lift} ${b[0]},${b[1]}`;
  const qp = (a: Pt, b: Pt, lift: number, t: number): Pt => [
    lerp(lerp(a[0], (a[0] + b[0]) / 2, t), lerp((a[0] + b[0]) / 2, b[0], t), t),
    lerp(lerp(a[1], (a[1] + b[1]) / 2 + lift, t), lerp((a[1] + b[1]) / 2 + lift, b[1], t), t),
  ];
  for (const d of [q(PA, B1, -10), q(PA, B2, 10), q(B1, PC, -10), q(B2, PC, 10)]) el("path", { d, class: "seg" }, svg);
  const nA = node(svg, PA),
    n1 = node(svg, B1),
    n2 = node(svg, B2),
    nC = node(svg, PC);
  label(svg, PA[0], PA[1] + 26, "Clarify");
  label(svg, B1[0], B1[1] - 18, "Audit code");
  label(svg, B2[0], B2[1] + 26, "Audit docs");
  label(svg, PC[0], PC[1] + 26, "Decide");
  const st = label(svg, 150, 14, "", "st");
  const [d1, d2] = dots(svg, 2, 4);
  const e1 = 0.62,
    e2 = 0.76; // the code audit finishes first; the join waits for docs
  return {
    period: 5600,
    draw: (t) => {
      nA.setAttribute("class", `nd${t < 0.1 ? " on" : " done"}`);
      n1.setAttribute("class", `nd${t > 0.3 && t < e1 ? " on" : t >= e1 ? " done" : ""}`);
      n2.setAttribute("class", `nd${t > 0.3 && t < e2 ? " on" : t >= e2 ? " done" : ""}`);
      nC.setAttribute("class", `nd${t > 0.9 ? " on" : ""}`);
      if (t < 0.1) {
        put(d1, orbit(PA, 0, t), "dot work");
        hide(d2);
        status(st, "clarify.md published");
        return;
      }
      const run = (d: SVGCircleElement, B: Pt, lift: number, end: number, k: number) => {
        if (t < 0.3) put(d, qp(PA, B, lift, ease(seg(t, 0.1, 0.3))));
        else if (t < end) put(d, orbit(B, k, t, 9), "dot work");
        else if (t < end + 0.14) put(d, qp(B, PC, lift, ease(seg(t, end, end + 0.14))));
        else if (t < 0.9) put(d, [PC[0] + (k ? 9 : -9), PC[1] - 16], "dot wait");
        else if (k) hide(d);
        else put(d, orbit(PC, 0, t), "dot work");
      };
      run(d1, B1, -10, e1, 0);
      run(d2, B2, 10, e2, 1);
      status(
        st,
        t < 0.3
          ? "two steps start at once"
          : t < e1
            ? "both running"
            : t < e2
              ? "code audit done · waiting for docs audit"
              : t < 0.9
                ? "both in · join"
                : "Decide runs with both audits",
        t >= e1 && t < e2,
      );
    },
  };
}

function loop(svg: SVGElement): Tile {
  const A = arc(150, 445, 350),
    a1 = rad(-112),
    a2 = rad(-90),
    a3 = rad(-68),
    PA = A.pt(a1),
    PB = A.pt(a2),
    PC = A.pt(a3);
  el("path", { d: A.path(a1, a3), class: "seg" }, svg);
  const from: Pt = [PC[0], PC[1] - 10],
    ctrl: Pt = [150, PA[1] - 70],
    to: Pt = [PA[0], PA[1] - 10];
  el("path", { d: `M${from.join(",")} Q${ctrl.join(",")} ${to.join(",")}`, class: "seg back" }, svg);
  const bp = (t: number): Pt => [(1 - t) ** 2 * from[0] + 2 * (1 - t) * t * ctrl[0] + t * t * to[0], (1 - t) ** 2 * from[1] + 2 * (1 - t) * t * ctrl[1] + t * t * to[1]];
  const nA = node(svg, PA),
    nB = node(svg, PB),
    nC = node(svg, PC);
  label(svg, PA[0] - 10, PA[1] + 26, "Find source", "nl", "start");
  label(svg, PB[0], PB[1] + 26, "Read source");
  label(svg, PC[0] + 10, PC[1] + 26, "Assess next step", "nl", "end");
  const bl = label(svg, 150, PA[1] - 52, "ticket.md · another pass", "st");
  const st = label(svg, 150, 14, "", "st");
  const [d] = dots(svg, 1, 4);
  const PASSES = 3,
    PP = 0.3; // each pass is 30% of the loop; the rest is the closing report
  return {
    period: 7500,
    draw: (t) => {
      const pass = Math.min(PASSES - 1, Math.floor(t / PP)),
        u = (t - pass * PP) / PP,
        last = pass === PASSES - 1,
        looping = t < PASSES * PP;
      bl.setAttribute("opacity", !last && u > 0.72 ? "1" : ".35");
      nA.setAttribute("class", `nd${u < 0.22 && looping ? " on" : ""}`);
      nB.setAttribute("class", `nd${u >= 0.22 && u < 0.5 && looping ? " on" : ""}`);
      nC.setAttribute("class", `nd${u >= 0.5 && u < 0.72 && looping ? " on" : !looping ? " done" : ""}`);
      if (!looping) {
        const p = seg(t, PASSES * PP, 1);
        put(d, [PC[0] + 12 + p * 30, PC[1] - 10 - p * 10]);
        d.setAttribute("opacity", String(1 - p));
        status(st, "pass 3 · closing report · done", true);
        return;
      }
      d.setAttribute("opacity", "1");
      if (u < 0.22) put(d, orbit(PA, 0, t, 9), "dot work");
      else if (u < 0.32) put(d, A.pt(lerp(a1, a2, ease(seg(u, 0.22, 0.32)))));
      else if (u < 0.5) put(d, orbit(PB, 0, t, 9), "dot work");
      else if (u < 0.6) put(d, A.pt(lerp(a2, a3, ease(seg(u, 0.5, 0.6)))));
      else if (u < 0.72) put(d, orbit(PC, 0, t, 9), "dot work");
      else put(d, bp(ease(seg(u, 0.72, 1))));
      status(st, `pass ${pass + 1} of 3 · ${u < 0.72 ? "carrying earlier findings forward" : "fresh request → back to Find source"}`, u >= 0.72);
    },
  };
}

const BUILDERS = { branch, human, parallel, loop } as const;

/** Starts every svg[data-tile] inside the returned ref on one shared animation clock. Reduced motion gets one still frame. */
export function useTiles() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = root.current;
    if (!container) return;
    const svgs = [...container.querySelectorAll<SVGSVGElement>("svg[data-tile]")];
    const tiles = svgs.map((svg) => BUILDERS[svg.dataset.tile as keyof typeof BUILDERS](svg));
    const clear = () => {
      for (const svg of svgs) svg.replaceChildren();
    };
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      for (const tile of tiles) tile.draw(0.5);
      return clear;
    }
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const elapsed = Math.max(0, now - start); // the first rAF timestamp can predate start
      for (const tile of tiles) tile.draw((elapsed % tile.period) / tile.period);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      clear();
    };
  }, []);
  return root;
}
