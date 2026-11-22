// Zero-dependency Mermaid renderer: parsers, a layered (Sugiyama) layout and theme-aware SVG element trees.
// Colors are `--pele-*` custom properties with fallbacks, so a host theme (or react-native-svg's resolver) restyles them.
import { renderMathSvg } from "../markdown/mathSvg.ts";
import type { ElContent, ElElement } from "../markdown/types.ts";

export type DiagramType = "flowchart" | "sequence" | "state" | "class" | "er" | "pie" | "xychart";
export interface MermaidOptions {
  /** Text width in px; defaults to Helvetica-like metrics so layout needs no canvas. */
  readonly measureText?: (text: string, fontSize: number, bold: boolean) => number;
}
export interface MermaidRender<T> {
  readonly svg: T;
  readonly width: number;
  readonly height: number;
}

const HEADERS: [RegExp, DiagramType][] = [
  [/^(?:flowchart|graph)\b/, "flowchart"],
  [/^sequenceDiagram\b/, "sequence"],
  [/^stateDiagram(?:-v2)?\b/, "state"],
  [/^classDiagram(?:-v2)?\b/, "class"],
  [/^erDiagram\b/, "er"],
  [/^pie\b/, "pie"],
  [/^xychart(?:-beta)?\b/, "xychart"],
];

/** Lines without comments, directives and front matter. */
function sourceLines(source: string) {
  const text = source.replace(/^\s*---\n[\s\S]*?\n---\s*\n/, "").replace(/%%\{[\s\S]*?\}%%/g, "");
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*%%.*$/, "").trim())
    .filter(Boolean);
}

export function detectDiagramType(source: string): DiagramType | null {
  const first = sourceLines(source)[0] ?? "";
  return HEADERS.find(([pattern]) => pattern.test(first))?.[1] ?? null;
}

export function renderMermaidTree(source: string, options: MermaidOptions = {}): MermaidRender<ElElement> {
  const lines = sourceLines(source);
  const type = detectDiagramType(source);
  if (!type) throw new Error(`Unsupported diagram type: ${(lines[0] ?? "").split(/\s/)[0] || "empty"}`);
  const ctx = new Context(options);
  const body = { flowchart, sequence, state: stateDiagram, class: classDiagram, er: erDiagram, pie, xychart }[type](lines, ctx);
  return ctx.finish(body);
}

export function renderMermaid(source: string, options: MermaidOptions = {}): MermaidRender<string> {
  const { svg, width, height } = renderMermaidTree(source, options);
  return { svg: toSvg(svg), width, height };
}

const CASED = new Set(["viewBox", "preserveAspectRatio", "refX", "refY", "markerWidth", "markerHeight", "markerUnits"]);
const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Serializes the element tree; property names follow the markdown emitter's camelCase-to-attribute rule. */
export function toSvg(node: ElContent): string {
  if (node.type === "text") return escape(node.value);
  if (node.type !== "element") return "";
  let out = `<${node.tagName}`;
  for (const [key, value] of Object.entries(node.properties)) {
    if (value === null || value === undefined || value === false) continue;
    const name = key === "className" ? "class" : CASED.has(key) ? key : key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    out += ` ${name}="${escape(Array.isArray(value) ? value.join(" ") : String(value))}"`;
  }
  return `${out}>${node.children.map(toSvg).join("")}</${node.tagName}>`;
}

// ---------- Drawing primitives ----------

const v = (name: string, fallback: string) => `var(--pele-${name}, ${fallback})`;
const C = {
  bg: v("bg", "#ffffff"),
  fg: v("fg", "#333333"),
  muted: v("muted", "#666666"),
  line: v("line", "#555555"),
  surface: v("surface", "#f3f3f3"),
  alt: v("surface-alt", "#e8e8e8"),
  border: v("border", "#999999"),
  accent: v("accent", "#3b82f6"),
};
const SERIES = ["#4e79a7", "#f28e2b", "#59a14f", "#e15759", "#76b7b2", "#edc948", "#b07aa1", "#ff9da7"].map((fallback, i) =>
  v(`series-${i + 1}`, fallback),
);
const FONT = 14;
const LINE = FONT * 1.3;
const round = (n: number) => Math.round(n * 100) / 100;

function el(tagName: string, properties: Record<string, string | number | undefined>, children: ElContent[] = []): ElElement {
  const props: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(properties))
    if (value !== undefined) props[key] = typeof value === "number" ? round(value) : value;
  return { type: "element", tagName, properties: props, children };
}
const text = (value: string): ElContent => ({ type: "text", value });

let sequenceId = 0;

function defaultMeasure(value: string, size: number, bold: boolean) {
  let width = 0;
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    width +=
      code > 0x2e80
        ? 1
        : "iljI.,;:!|'`".includes(ch)
          ? 0.28
          : "ftr ()[]{}/\\-\"".includes(ch)
            ? 0.36
            : "mwMW@%".includes(ch)
              ? 0.86
              : ch >= "A" && ch <= "Z"
                ? 0.68
                : ch >= "0" && ch <= "9"
                  ? 0.56
                  : 0.53;
  }
  return width * size * (bold ? 1.06 : 1);
}

type Label = { lines: { parts: ({ text: string } | { math: ElElement; width: number; height: number })[]; width: number; height: number }[]; width: number; height: number };

class Context {
  readonly id = `m${(sequenceId++).toString(36)}`;
  private readonly defs = new Map<string, ElElement>();
  private readonly options: MermaidOptions;
  constructor(options: MermaidOptions) {
    this.options = options;
  }
  measure(value: string, size = FONT, bold = false) {
    return (this.options.measureText ?? defaultMeasure)(value, size, bold);
  }
  label(raw: string, size = FONT, bold = false): Label {
    const lines = cleanLabel(raw)
      .split("\n")
      .map((line) => {
        const parts: Label["lines"][number]["parts"] = [];
        let width = 0;
        let height = size * 1.3;
        for (const [index, piece] of line.split(/\$\$([\s\S]+?)\$\$/).entries()) {
          if (index % 2 === 0) {
            if (piece) parts.push({ text: piece });
            width += this.measure(piece, size, bold);
            continue;
          }
          const math = renderMathSvg(piece, false);
          const box = String(math.properties.viewBox).split(" ").map(Number);
          const scale = size / 16;
          const part = { math, width: (box[2] ?? 0) * scale, height: (box[3] ?? 0) * scale };
          parts.push(part);
          width += part.width;
          height = Math.max(height, part.height);
        }
        return { parts, width, height };
      });
    return { lines, width: Math.max(0, ...lines.map((l) => l.width)), height: lines.reduce((sum, l) => sum + l.height, 0) };
  }
  /** Centered at (x, y). */
  drawLabel(label: Label, x: number, y: number, options: { size?: number; bold?: boolean; color?: string; anchor?: "middle" | "start" } = {}) {
    const size = options.size ?? FONT;
    const out: ElContent[] = [];
    let top = y - label.height / 2;
    for (const line of label.lines) {
      let left = options.anchor === "start" ? x : x - line.width / 2;
      const baseline = top + line.height / 2 + size * 0.35;
      for (const part of line.parts) {
        if ("text" in part) {
          const width = this.measure(part.text, size, !!options.bold);
          out.push(
            el(
              "text",
              { x: left, y: baseline, style: `fill:${options.color ?? C.fg};font-size:${size}px;white-space:pre${options.bold ? ";font-weight:600" : ""}` },
              [text(part.text)],
            ),
          );
          left += width;
        } else {
          out.push({ ...part.math, properties: { ...part.math.properties, x: round(left), y: round(top + (line.height - part.height) / 2), width: round(part.width), height: round(part.height), style: `color:${options.color ?? C.fg};overflow:visible` } });
          left += part.width;
        }
      }
      top += line.height;
    }
    return el("g", {}, out);
  }
  marker(name: "arrow" | "open" | "circle" | "cross" | "triangle" | "diamond" | "filledDiamond" | "one" | "zeroOne" | "many" | "oneMany") {
    const id = `${this.id}-${name}`;
    if (!this.defs.has(name)) {
      const shapes: Record<typeof name, [string, boolean, number, number]> = {
        arrow: ["M0,0 L10,5 L0,10 z", true, 10, 5],
        open: ["M0,0 L10,5 L0,10", false, 10, 5],
        circle: ["M5,1 a4,4 0 1,0 0.01,0 z", true, 9, 5],
        cross: ["M1,1 L9,9 M9,1 L1,9", false, 7, 5],
        triangle: ["M0,0 L12,6 L0,12 z", false, 12, 6],
        diamond: ["M0,6 L8,0 L16,6 L8,12 z", false, 16, 6],
        filledDiamond: ["M0,6 L8,0 L16,6 L8,12 z", true, 16, 6],
        one: ["M4,0 L4,12 M8,0 L8,12", false, 16, 6],
        zeroOne: ["M4,0 L4,12 M14,6 a3,3 0 1,0 0.01,0", false, 18, 6],
        many: ["M16,0 L4,6 L16,12 M4,6 L18,6 M2,6 a3,3 0 1,0 0.01,0", false, 18, 6],
        oneMany: ["M16,0 L4,6 L16,12 M4,0 L4,12", false, 18, 6],
      };
      const [d, filled, refX, refY] = shapes[name];
      const [w, h] = refY === 6 ? [18, 12] : [10, 10];
      this.defs.set(
        name,
        el("marker", { id, viewBox: `0 0 ${w} ${h}`, refX, refY, markerWidth: w * 1.1, markerHeight: h * 1.1, markerUnits: "userSpaceOnUse", orient: "auto-start-reverse" }, [
          el("path", { d, style: `fill:${filled ? C.line : C.bg};stroke:${C.line};stroke-width:1.2` }),
        ]),
      );
    }
    return `url(#${id})`;
  }
  finish(body: { content: ElContent[]; width: number; height: number }): MermaidRender<ElElement> {
    const pad = 8;
    const width = Math.ceil(body.width + pad * 2);
    const height = Math.ceil(body.height + pad * 2);
    const svg = el(
      "svg",
      {
        xmlns: "http://www.w3.org/2000/svg",
        role: "img",
        width,
        height,
        viewBox: `0 0 ${width} ${height}`,
        style: `max-width:100%;height:auto;fill:${C.fg};font:${FONT}px sans-serif;font-family:${v("font", "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif")}`,
      },
      [...(this.defs.size ? [el("defs", {}, [...this.defs.values()])] : []), el("g", { transform: `translate(${pad},${pad})` }, body.content)],
    );
    return { svg, width, height };
  }
}

function cleanLabel(raw: string) {
  let value = raw.trim();
  if (/^".*"$/s.test(value)) value = value.slice(1, -1);
  if (/^`.*`$/s.test(value)) value = value.slice(1, -1);
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\\n/g, "\n")
    .replace(/<\/?(?:b|i|em|strong|u|small|code|span|sub|sup)\b[^>]*>/gi, "")
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, "$1$2")
    .replace(/#(\w+);/g, (match, name: string) => ENTITIES[name] ?? (/^\d+$/.test(name) ? String.fromCodePoint(Number(name)) : match));
}
const ENTITIES: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", nbsp: " ", apos: "'" };

const SAFE_STYLE_VALUE = /^(?:[#\w\s.%-]|(?:rgba?|hsla?)\([\d\s,.%]+\))+$/;
function customStyle(declarations: string) {
  const allowed: Record<string, string> = { fill: "fill", stroke: "stroke", color: "color", "stroke-width": "stroke-width", "stroke-dasharray": "stroke-dasharray" };
  const out: Record<string, string> = {};
  for (const part of declarations.split(/[,;](?![^(]*\))/)) {
    const [name, value] = part.split(":").map((s) => s.trim());
    if (name && value && allowed[name] && SAFE_STYLE_VALUE.test(value)) out[allowed[name]] = value;
  }
  return out;
}

// ---------- Layered layout ----------

type Direction = "TB" | "BT" | "LR" | "RL";
type LayoutNode = { id: string; width: number; height: number; cluster?: string | undefined };
type LayoutEdge = { from: string; to: string; minlen?: number; label?: { width: number; height: number } | undefined };
type Placed = { x: number; y: number; width: number; height: number };
type Layout = { nodes: Map<string, Placed>; edges: { points: { x: number; y: number }[]; reversed: boolean; label: { x: number; y: number } | undefined }[]; width: number; height: number };

function layered(nodes: LayoutNode[], edges: LayoutEdge[], direction: Direction, options: { nodeGap?: number; rankGap?: number; clusterOf?: (id: string) => string[] } = {}): Layout {
  const horizontal = direction === "LR" || direction === "RL";
  const nodeGap = options.nodeGap ?? 30;
  const rankGap = options.rankGap ?? 50;
  const ids = nodes.map((n) => n.id);
  const size = new Map(nodes.map((n) => [n.id, horizontal ? { along: n.height, across: n.width } : { along: n.width, across: n.height }]));
  // 1. Break cycles with a DFS: back edges point upward.
  const out = new Map(ids.map((id) => [id, [] as number[]]));
  edges.forEach((e, i) => out.get(e.from)?.push(i));
  const state = new Map<string, 1 | 2>();
  const reversed = new Set<number>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const i of out.get(id) ?? []) {
      const to = edges[i]!.to;
      if (state.get(to) === 1) reversed.add(i);
      else if (!state.has(to)) visit(to);
    }
    state.set(id, 2);
  };
  for (const id of ids) if (!state.has(id)) visit(id);
  const dag = edges.map((e, i) => (reversed.has(i) ? { ...e, from: e.to, to: e.from } : e)).filter((e) => e.from !== e.to);
  // 2. Longest-path ranks, then pull each source down next to its first successor.
  const rank = new Map(ids.map((id) => [id, 0]));
  const indegree = new Map(ids.map((id) => [id, 0]));
  for (const e of dag) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  const queue = ids.filter((id) => !indegree.get(id));
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of dag)
      if (e.from === id) {
        rank.set(e.to, Math.max(rank.get(e.to)!, rank.get(id)! + (e.minlen ?? 1)));
        indegree.set(e.to, indegree.get(e.to)! - 1);
        if (!indegree.get(e.to)) queue.push(e.to);
      }
  }
  for (const id of order.slice().reverse()) {
    const successors = dag.filter((e) => e.from === id);
    if (successors.length && !dag.some((e) => e.to === id))
      rank.set(id, Math.min(...successors.map((e) => rank.get(e.to)! - (e.minlen ?? 1))));
  }
  // 3. Dummy nodes for long edges.
  const chains: string[][] = [];
  const layerOf = new Map<string, number>(rank);
  const labelDummy = new Map<number, string>();
  dag.forEach((e, i) => {
    const chain = [e.from];
    const middle = Math.floor((rank.get(e.from)! + rank.get(e.to)!) / 2);
    for (let r = rank.get(e.from)! + 1; r < rank.get(e.to)!; r++) {
      const dummy = `\0${i}:${r}`;
      layerOf.set(dummy, r);
      // A long edge carries its label on its middle dummy, which reserves the label's room.
      const label = r === middle ? e.label : undefined;
      if (label) labelDummy.set(i, dummy);
      size.set(dummy, label ? (horizontal ? { along: label.height, across: label.width } : { along: label.width, across: label.height }) : { along: 4, across: 0 });
      chain.push(dummy);
    }
    chain.push(e.to);
    chains.push(chain);
  });
  const maxRank = Math.max(0, ...layerOf.values());
  const layers: string[][] = Array.from({ length: maxRank + 1 }, () => []);
  const seen = new Set<string>();
  const place = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    layers[layerOf.get(id)!]!.push(id);
  };
  for (const id of order) {
    place(id);
    chains.filter((c) => c[0] === id).forEach((c) => c.forEach(place));
  }
  for (const id of layerOf.keys()) place(id);
  const up = new Map<string, string[]>();
  const down = new Map<string, string[]>();
  for (const chain of chains)
    for (let i = 0; i + 1 < chain.length; i++) {
      (down.get(chain[i]!) ?? down.set(chain[i]!, []).get(chain[i]!)!).push(chain[i + 1]!);
      (up.get(chain[i + 1]!) ?? up.set(chain[i + 1]!, []).get(chain[i + 1]!)!).push(chain[i]!);
    }
  // 4. Barycentric ordering sweeps; clusters stay contiguous by sorting on their mean position first.
  const clusterOf = (id: string) => (id.startsWith("\0") ? "" : (options.clusterOf?.(id)[0] ?? ""));
  const position = new Map<string, number>();
  const index = () => layers.forEach((layer) => layer.forEach((id, i) => position.set(id, i)));
  index();
  for (let sweep = 0; sweep < 8; sweep++) {
    const downward = sweep % 2 === 0;
    const sequence = downward ? layers.slice(1) : layers.slice(0, -1).reverse();
    for (const layer of sequence) {
      const bary = new Map(
        layer.map((id) => {
          const neighbors = (downward ? up : down).get(id) ?? [];
          return [id, neighbors.length ? neighbors.reduce((s, n) => s + position.get(n)!, 0) / neighbors.length : position.get(id)!];
        }),
      );
      const clusterMean = new Map<string, number>();
      for (const id of layer) {
        const key = clusterOf(id);
        if (!key) continue;
        const members = layer.filter((other) => clusterOf(other) === key);
        clusterMean.set(key, members.reduce((s, m) => s + bary.get(m)!, 0) / members.length);
      }
      layer.sort((a, b) => {
        const ka = clusterMean.get(clusterOf(a)) ?? bary.get(a)!;
        const kb = clusterMean.get(clusterOf(b)) ?? bary.get(b)!;
        return ka - kb || bary.get(a)! - bary.get(b)!;
      });
      layer.forEach((id, i) => position.set(id, i));
    }
  }
  // 5. Coordinates across each layer: pull toward neighbors, then resolve overlaps in order.
  const x = new Map<string, number>();
  const gapBetween = (a: string, b: string) => {
    const da = a.startsWith("\0") && !size.get(a)!.across;
    const db = b.startsWith("\0") && !size.get(b)!.across;
    const extra = clusterOf(a) !== clusterOf(b) ? 24 : 0;
    return (size.get(a)!.along + size.get(b)!.along) / 2 + (da && db ? 8 : da || db ? nodeGap / 2 : nodeGap) + extra;
  };
  for (const layer of layers) {
    let cursor = 0;
    layer.forEach((id, i) => {
      if (i) cursor += gapBetween(layer[i - 1]!, id);
      x.set(id, cursor);
    });
  }
  const settle = (layer: string[], desired: Map<string, number>) => {
    const left = layer.map((id) => desired.get(id)!);
    for (let i = 1; i < layer.length; i++) left[i] = Math.max(left[i]!, left[i - 1]! + gapBetween(layer[i - 1]!, layer[i]!));
    const right = layer.map((id) => desired.get(id)!);
    for (let i = layer.length - 2; i >= 0; i--) right[i] = Math.min(right[i]!, right[i + 1]! - gapBetween(layer[i]!, layer[i + 1]!));
    layer.forEach((id, i) => x.set(id, (left[i]! + right[i]!) / 2));
    for (let i = 1; i < layer.length; i++) x.set(layer[i]!, Math.max(x.get(layer[i]!)!, x.get(layer[i - 1]!)! + gapBetween(layer[i - 1]!, layer[i]!)));
  };
  for (let pass = 0; pass < 12; pass++) {
    const downward = pass % 2 === 0;
    for (const layer of downward ? layers : layers.slice().reverse()) {
      const desired = new Map(
        layer.map((id) => {
          const neighbors = [...((downward ? up : down).get(id) ?? []), ...(pass > 6 ? ((downward ? down : up).get(id) ?? []) : [])];
          const weight = id.startsWith("\0") ? 4 : 1;
          return [id, neighbors.length ? (x.get(id)! + weight * neighbors.reduce((s, n) => s + x.get(n)!, 0) / neighbors.length) / (1 + weight) : x.get(id)!];
        }),
      );
      settle(layer, desired);
    }
  }
  // 6. Ranks: room for the tallest node and the labels of edges crossing each gap.
  const gapLabel = new Array<number>(maxRank + 1).fill(0);
  dag.forEach((e, i) => {
    if (!e.label || labelDummy.has(i)) return;
    const mid = Math.floor((rank.get(e.from)! + rank.get(e.to)!) / 2);
    gapLabel[mid] = Math.max(gapLabel[mid]!, (horizontal ? e.label.width : e.label.height) + 12);
  });
  const rankSize = layers.map((layer) => Math.max(0, ...layer.map((id) => size.get(id)!.across)));
  const y: number[] = [];
  let cursor = 0;
  rankSize.forEach((s, r) => {
    y[r] = cursor + s / 2;
    cursor += s + Math.max(rankGap, gapLabel[r]! + 16);
  });
  const across = [...x.entries()];
  const left = Math.min(...across.map(([id, value]) => value - size.get(id)!.along / 2));
  const right = Math.max(...across.map(([id, value]) => value + size.get(id)!.along / 2));
  const extentAlong = right - left;
  const extentAcross = cursor - Math.max(rankGap, gapLabel[maxRank]! + 16);
  const map = (along: number, acrossValue: number) => {
    const a = along - left;
    const r = direction === "BT" || direction === "RL" ? extentAcross - acrossValue : acrossValue;
    return horizontal ? { x: r, y: a } : { x: a, y: r };
  };
  const placed = new Map<string, Placed>();
  for (const n of nodes) {
    const point = map(x.get(n.id)!, y[layerOf.get(n.id)!]!);
    placed.set(n.id, { ...point, width: n.width, height: n.height });
  }
  const routed = edges.map((e, i) => {
    if (e.from === e.to) {
      const p = placed.get(e.from)!;
      const r = Math.min(p.width, p.height) / 3;
      return { points: [{ x: p.x + p.width / 2, y: p.y - r / 2 }, { x: p.x + p.width / 2 + r * 2, y: p.y - r }, { x: p.x + p.width / 2 + r * 2, y: p.y + r }, { x: p.x + p.width / 2, y: p.y + r / 2 }], reversed: false, label: { x: p.x + p.width / 2 + r * 2, y: p.y } };
    }
    const dagIndex = dag.findIndex((d) => (reversed.has(i) ? d.from === e.to && d.to === e.from : d.from === e.from && d.to === e.to));
    const chain = chains[dagIndex] ?? [e.from, e.to];
    let points = chain.map((id) => map(x.get(id)!, y[layerOf.get(id)!]!));
    if (reversed.has(i)) points = points.reverse();
    const dummy = labelDummy.get(dagIndex);
    return { points, reversed: reversed.has(i), label: dummy ? map(x.get(dummy)!, y[layerOf.get(dummy)!]!) : undefined };
  });
  return { nodes: placed, edges: routed, width: horizontal ? extentAcross : extentAlong, height: horizontal ? extentAlong : extentAcross };
}

/** Moves an endpoint from a node's center to its outline along the segment toward `toward`. */
function clip(node: Placed & { shape?: string }, toward: { x: number; y: number }) {
  const dx = toward.x - node.x;
  const dy = toward.y - node.y;
  if (!dx && !dy) return { x: node.x, y: node.y };
  const hw = node.width / 2;
  const hh = node.height / 2;
  let t: number;
  if (node.shape === "circle" || node.shape === "doublecircle" || node.shape === "start" || node.shape === "end") t = Math.min(hw, hh) / Math.hypot(dx, dy);
  else if (node.shape === "diamond" || node.shape === "choice") t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return { x: node.x + dx * Math.min(1, t), y: node.y + dy * Math.min(1, t) };
}

function curve(points: { x: number; y: number }[]) {
  if (points.length < 2) return "";
  let d = `M${round(points[0]!.x)},${round(points[0]!.y)}`;
  if (points.length === 2) return `${d} L${round(points[1]!.x)},${round(points[1]!.y)}`;
  for (let i = 0; i + 1 < points.length; i++) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(points.length - 1, i + 2)]!;
    d += ` C${round(p1.x + (p2.x - p0.x) / 6)},${round(p1.y + (p2.y - p0.y) / 6)} ${round(p2.x - (p3.x - p1.x) / 6)},${round(p2.y - (p3.y - p1.y) / 6)} ${round(p2.x)},${round(p2.y)}`;
  }
  return d;
}

function midpoint(points: { x: number; y: number }[]) {
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y));
  let half = lengths.reduce((s, l) => s + l, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    if (half <= lengths[i]! || i === lengths.length - 1) {
      const t = lengths[i] ? Math.min(1, half / lengths[i]!) : 0;
      return { x: points[i]!.x + (points[i + 1]!.x - points[i]!.x) * t, y: points[i]!.y + (points[i + 1]!.y - points[i]!.y) * t };
    }
    half -= lengths[i]!;
  }
  return points[0]!;
}

// ---------- Graph diagrams: shared scene ----------

type GraphNode = { id: string; label: Label; shape: string; width: number; height: number; style?: Record<string, string>; cluster?: string | undefined; draw?: (p: Placed) => ElContent[] };
type GraphEdge = { from: string; to: string; label?: Label | undefined; stroke: "solid" | "dotted" | "thick" | "invisible"; start?: string | undefined; end?: string | undefined; minlen?: number; startLabel?: string; endLabel?: string };
type Cluster = { id: string; label: Label; parent?: string | undefined };

function drawGraph(ctx: Context, nodes: GraphNode[], edges: GraphEdge[], clusters: Cluster[], direction: Direction) {
  const parentOf = new Map(clusters.map((c) => [c.id, c.parent]));
  const chain = (cluster: string | undefined) => {
    const out: string[] = [];
    for (let c = cluster; c; c = parentOf.get(c)) out.unshift(c);
    return out;
  };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const layout = layered(
    nodes.map((n) => ({ id: n.id, width: n.width, height: n.height, cluster: n.cluster })),
    edges.map((e) => {
      const ends = e.startLabel || e.endLabel ? 28 : 0;
      const label = e.label || ends ? { width: (e.label?.width ?? 0) + 8 + ends, height: (e.label?.height ?? 0) + 4 + ends } : undefined;
      return { from: e.from, to: e.to, minlen: e.minlen ?? 1, label };
    }),
    direction,
    { clusterOf: (id) => chain(byId.get(id)?.cluster) },
  );
  const content: ElContent[] = [];
  // Clusters, outermost first, padded around their members.
  const boxes = new Map<string, { x0: number; y0: number; x1: number; y1: number }>();
  const depth = (id: string) => chain(id).length;
  for (const cluster of clusters.slice().sort((a, b) => depth(b.id) - depth(a.id))) {
    let box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const n of nodes) {
      if (!chain(n.cluster).includes(cluster.id)) continue;
      const p = layout.nodes.get(n.id)!;
      box = { x0: Math.min(box.x0, p.x - p.width / 2), y0: Math.min(box.y0, p.y - p.height / 2), x1: Math.max(box.x1, p.x + p.width / 2), y1: Math.max(box.y1, p.y + p.height / 2) };
    }
    for (const child of clusters)
      if (child.parent === cluster.id && boxes.has(child.id)) {
        const b = boxes.get(child.id)!;
        box = { x0: Math.min(box.x0, b.x0), y0: Math.min(box.y0, b.y0), x1: Math.max(box.x1, b.x1), y1: Math.max(box.y1, b.y1) };
      }
    if (!Number.isFinite(box.x0)) continue;
    const titleHeight = cluster.label.height ? cluster.label.height + 6 : 0;
    box = { x0: box.x0 - 12, y0: box.y0 - 12 - titleHeight, x1: Math.max(box.x1 + 12, box.x0 - 12 + cluster.label.width + 16), y1: box.y1 + 12 };
    boxes.set(cluster.id, box);
  }
  let minX = 0;
  let minY = 0;
  let maxX = layout.width;
  let maxY = layout.height;
  for (const b of boxes.values()) {
    minX = Math.min(minX, b.x0);
    minY = Math.min(minY, b.y0);
    maxX = Math.max(maxX, b.x1);
    maxY = Math.max(maxY, b.y1);
  }
  for (const cluster of clusters.slice().sort((a, b) => depth(a.id) - depth(b.id))) {
    const b = boxes.get(cluster.id);
    if (!b) continue;
    content.push(
      el("rect", { x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0, rx: 6, style: `fill:${depth(cluster.id) % 2 ? C.alt : C.surface};fill-opacity:0.5;stroke:${C.border};stroke-width:1` }),
      ctx.drawLabel(cluster.label, b.x0 + 8, b.y0 + 6 + cluster.label.height / 2, { anchor: "start", color: C.muted }),
    );
  }
  const labels: ElContent[] = [];
  edges.forEach((edge, i) => {
    if (edge.stroke === "invisible") return;
    const from = byId.get(edge.from)!;
    const to = byId.get(edge.to)!;
    const points = layout.edges[i]!.points.slice();
    const a = { ...layout.nodes.get(from.id)!, shape: from.shape };
    const b = { ...layout.nodes.get(to.id)!, shape: to.shape };
    if (edge.from !== edge.to) {
      points[0] = clip(a, points[1] ?? b);
      points[points.length - 1] = clip(b, points[points.length - 2] ?? a);
    }
    const dash = edge.stroke === "dotted" ? ";stroke-dasharray:4 3" : "";
    content.push(
      el("path", {
        d: curve(points),
        style: `fill:none;stroke:${C.line};stroke-width:${edge.stroke === "thick" ? 3 : 1.4}${dash}`,
        "marker-start": edge.start ? ctx.marker(edge.start as "arrow") : undefined,
        "marker-end": edge.end ? ctx.marker(edge.end as "arrow") : undefined,
      }),
    );
    const mid = layout.edges[i]!.label ?? midpoint(points);
    if (edge.label) {
      labels.push(
        el("rect", { x: mid.x - edge.label.width / 2 - 4, y: mid.y - edge.label.height / 2 - 2, width: edge.label.width + 8, height: edge.label.height + 4, rx: 3, style: `fill:${C.bg};fill-opacity:0.9` }),
        ctx.drawLabel(edge.label, mid.x, mid.y, { color: C.fg, size: FONT - 1 }),
      );
    }
    for (const [value, end, next] of [[edge.startLabel, points[0]!, points[1]!], [edge.endLabel, points.at(-1)!, points.at(-2)!]] as const) {
      if (!value || !next) continue;
      const length = Math.hypot(next.x - end.x, next.y - end.y) || 1;
      const ux = (next.x - end.x) / length;
      const uy = (next.y - end.y) / length;
      labels.push(ctx.drawLabel(ctx.label(value, FONT - 2), end.x + ux * 16 - uy * 10, end.y + uy * 16 + ux * 10, { size: FONT - 2, color: C.muted }));
    }
  });
  content.push(...labels);
  for (const node of nodes) {
    const p = layout.nodes.get(node.id)!;
    content.push(...(node.draw ? node.draw(p) : drawShape(ctx, node, p)));
  }
  return { content: [el("g", { transform: `translate(${-minX},${-minY})` }, content)], width: maxX - minX, height: maxY - minY };
}

function shapeStyle(node: GraphNode) {
  const s = node.style ?? {};
  return `fill:${s.fill ?? C.surface};stroke:${s.stroke ?? C.border};stroke-width:${s["stroke-width"] ?? "1.2"}${s["stroke-dasharray"] ? `;stroke-dasharray:${s["stroke-dasharray"]}` : ""}`;
}

function drawShape(ctx: Context, node: GraphNode, p: Placed): ElContent[] {
  const { x, y, width: w, height: h } = p;
  const [l, t, r, b] = [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
  const style = shapeStyle(node);
  const poly = (points: number[][]) => el("polygon", { points: points.map(([px, py]) => `${round(px!)},${round(py!)}`).join(" "), style });
  const s = (h * 0.3) | 0;
  const shapes: Record<string, () => ElContent[]> = {
    rect: () => [el("rect", { x: l, y: t, width: w, height: h, rx: 4, style })],
    round: () => [el("rect", { x: l, y: t, width: w, height: h, rx: 10, style })],
    stadium: () => [el("rect", { x: l, y: t, width: w, height: h, rx: h / 2, style })],
    subroutine: () => [el("rect", { x: l, y: t, width: w, height: h, rx: 2, style }), el("path", { d: `M${l + 8},${t} V${b} M${r - 8},${t} V${b}`, style: `fill:none;stroke:${C.border}` })],
    cylinder: () => {
      const ry = Math.min(10, h / 6);
      return [el("path", { d: `M${l},${t + ry} A${w / 2},${ry} 0 0,1 ${r},${t + ry} V${b - ry} A${w / 2},${ry} 0 0,1 ${l},${b - ry} Z M${l},${t + ry} A${w / 2},${ry} 0 0,0 ${r},${t + ry}`, style })];
    },
    circle: () => [el("circle", { cx: x, cy: y, r: w / 2, style })],
    doublecircle: () => [el("circle", { cx: x, cy: y, r: w / 2, style }), el("circle", { cx: x, cy: y, r: w / 2 - 4, style })],
    asymmetric: () => [poly([[l, t], [r, t], [r, b], [l, b], [l + s, y]])],
    diamond: () => [poly([[x, t], [r, y], [x, b], [l, y]])],
    hexagon: () => [poly([[l + s, t], [r - s, t], [r, y], [r - s, b], [l + s, b], [l, y]])],
    parallelogram: () => [poly([[l + s, t], [r, t], [r - s, b], [l, b]])],
    parallelogramAlt: () => [poly([[l, t], [r - s, t], [r, b], [l + s, b]])],
    trapezoid: () => [poly([[l + s, t], [r - s, t], [r, b], [l, b]])],
    trapezoidAlt: () => [poly([[l, t], [r, t], [r - s, b], [l + s, b]])],
  };
  return [...(shapes[node.shape] ?? shapes.rect!)(), ctx.drawLabel(node.label, x, y, { color: node.style?.color })];
}

function sizeFor(shape: string, label: Label) {
  const w = label.width + 30;
  const h = label.height + 18;
  if (shape === "circle" || shape === "doublecircle") {
    const d = Math.max(w, h) + (shape === "doublecircle" ? 8 : 0);
    return { width: d, height: d };
  }
  if (shape === "diamond") return { width: Math.max(w * 1.4, 50), height: Math.max(h * 1.6, 40) };
  if (shape === "hexagon" || shape.startsWith("parallelogram") || shape.startsWith("trapezoid")) return { width: w + h * 0.6, height: h };
  return { width: Math.max(w, 40), height: h };
}

// ---------- flowchart ----------

const SHAPES: [string, string, string][] = [
  ["(((", ")))", "doublecircle"],
  ["((", "))", "circle"],
  ["([", "])", "stadium"],
  ["[[", "]]", "subroutine"],
  ["[(", ")]", "cylinder"],
  ["{{", "}}", "hexagon"],
  ["[/", "/]", "parallelogram"],
  ["[\\", "\\]", "parallelogramAlt"],
  ["[/", "\\]", "trapezoid"],
  ["[\\", "/]", "trapezoidAlt"],
  ["(", ")", "round"],
  ["[", "]", "rect"],
  ["{", "}", "diamond"],
  [">", "]", "asymmetric"],
];
const NEW_SHAPES: Record<string, string> = { rect: "rect", rounded: "round", stadium: "stadium", subproc: "subroutine", cyl: "cylinder", circle: "circle", "dbl-circ": "doublecircle", diam: "diamond", diamond: "diamond", hex: "hexagon", lean_r: "parallelogram", "lean-r": "parallelogram", lean_l: "parallelogramAlt", "lean-l": "parallelogramAlt", trap_b: "trapezoid", "trap-b": "trapezoid", trap_t: "trapezoidAlt", "trap-t": "trapezoidAlt" };
const ID = /^[\p{L}\p{N}_](?:[\p{L}\p{N}_.]|-(?![-.>=ox]))*/u;
const ARROW = /^\s*([<ox])?(-{2,}|={2,}|-\.+-|~{3,})([>ox])?(?:\|([^|]*)\|)?\s*/;
const LABELED = /^\s*([<ox])?(--|==|-\.)\s+(.+?)\s+(-{2,}|={2,}|\.+-)([>ox])?(?=[\s\w"])\s*/u;
const END_MARKERS: Record<string, string> = { ">": "arrow", "<": "arrow", o: "circle", x: "cross" };

function flowchart(lines: string[], ctx: Context) {
  const direction = (/^(?:flowchart|graph)\s+(TB|TD|BT|LR|RL)/.exec(lines[0]!)?.[1]?.replace("TD", "TB") ?? "TB") as Direction;
  const nodes = new Map<string, { label: string; shape: string; cluster?: string | undefined; classes: string[] }>();
  const edges: { from: string; to: string; label?: string | undefined; stroke: GraphEdge["stroke"]; start?: string | undefined; end?: string | undefined; minlen: number }[] = [];
  const clusters: { id: string; label: string; parent?: string | undefined }[] = [];
  const classDefs = new Map<string, Record<string, string>>();
  const styles = new Map<string, Record<string, string>>();
  const stack: string[] = [];
  const touch = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { label: id, shape: "rect", cluster: stack.at(-1), classes: [] });
    const node = nodes.get(id)!;
    // A node referenced inside a subgraph moves into it, as Mermaid does.
    if (stack.length && !stack.includes(node.cluster ?? "\0")) node.cluster = stack.at(-1);
    return node;
  };
  const statements = lines.flatMap((line) => line.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/)).map((s) => s.trim()).filter(Boolean).slice(1);
  for (const statement of statements) {
    let m: RegExpExecArray | null;
    if ((m = /^subgraph\s+(.*)$/.exec(statement))) {
      const spec = m[1]!.trim();
      const titled = /^([^\s[]+)\s*\[(.*)\]$/.exec(spec);
      const id = titled ? titled[1]! : /^"/.test(spec) ? `cluster${clusters.length}` : spec.split(/\s+/)[0]!;
      const label = titled ? titled[2]! : spec;
      clusters.push({ id, label, parent: stack.at(-1) });
      stack.push(id);
      continue;
    }
    if (statement === "end") {
      stack.pop();
      continue;
    }
    if (/^(direction|click|linkStyle|accTitle|accDescr)\b/.test(statement)) continue;
    if ((m = /^classDef\s+([\w,]+)\s+(.+)$/.exec(statement))) {
      for (const name of m[1]!.split(",")) classDefs.set(name, customStyle(m[2]!));
      continue;
    }
    if ((m = /^class\s+([\w,\s]+?)\s+(\w+)$/.exec(statement))) {
      for (const id of m[1]!.split(",")) touch(id.trim()).classes.push(m[2]!);
      continue;
    }
    if ((m = /^style\s+(\S+)\s+(.+)$/.exec(statement))) {
      styles.set(m[1]!, customStyle(m[2]!));
      continue;
    }
    // A chain of node groups joined by edges.
    let rest = statement;
    const group = () => {
      const ids: string[] = [];
      do {
        rest = rest.replace(/^\s*&?\s*/, "");
        const id = ID.exec(rest)?.[0];
        if (!id) throw new Error(`Unexpected "${rest.slice(0, 20)}" in flowchart`);
        rest = rest.slice(id.length);
        const node = touch(id);
        const shape = SHAPES.find(([open]) => rest.startsWith(open));
        if ((m = /^@\{([^}]*)\}/.exec(rest))) {
          rest = rest.slice(m[0].length);
          const shapeName = /shape:\s*([\w-]+)/.exec(m[1]!)?.[1];
          const label = /label:\s*"([^"]*)"/.exec(m[1]!)?.[1];
          if (shapeName) node.shape = NEW_SHAPES[shapeName] ?? "rect";
          if (label !== undefined) node.label = label;
        } else if (shape) {
          const body = rest.slice(shape[0].length);
          let end: number;
          let label: string;
          if (body.trimStart().startsWith('"')) {
            const open = body.indexOf('"');
            const close = body.indexOf('"', open + 1);
            label = body.slice(open, close + 1);
            end = body.indexOf(closerFor(body.slice(close + 1), shape), close + 1);
          } else {
            const candidates = SHAPES.filter(([open]) => open === shape[0]).map(([, close]) => [body.indexOf(close), close] as const).filter(([i]) => i >= 0);
            const best = candidates.sort((a, b) => a[0] - b[0])[0];
            end = best ? best[0] : -1;
            label = body.slice(0, Math.max(0, end));
          }
          if (end < 0) throw new Error(`Unclosed node shape for "${id}"`);
          const close = SHAPES.find(([open, closer]) => open === shape[0] && body.startsWith(closer, end))!;
          node.shape = close[2];
          node.label = label;
          rest = body.slice(end + close[1].length);
        }
        if ((m = /^:::([\w-]+)/.exec(rest))) {
          node.classes.push(m[1]!);
          rest = rest.slice(m[0].length);
        }
        ids.push(id);
      } while (/^\s*&/.test(rest));
      return ids;
    };
    let from = group();
    while (rest.trim()) {
      const labeled = LABELED.exec(rest);
      const arrow = labeled ? null : ARROW.exec(rest);
      const match = labeled ?? arrow;
      if (!match) throw new Error(`Unexpected "${rest.trim().slice(0, 20)}" in flowchart`);
      rest = rest.slice(match[0].length);
      const body = labeled ? `${labeled[2]}${labeled[4]}` : arrow![2]!;
      const stroke: GraphEdge["stroke"] = body.includes("~") ? "invisible" : body.includes(".") ? "dotted" : body.includes("=") ? "thick" : "solid";
      const startMark = match[1];
      const endMark = labeled ? labeled[5] : arrow![3];
      const label = labeled ? labeled[3] : arrow![4];
      const minlen = Math.max(1, body.replace(/[^-=.]/g, "").length - (labeled ? 3 : 1));
      const to = group();
      for (const a of from)
        for (const b of to)
          edges.push({ from: a, to: b, label, stroke, start: startMark ? END_MARKERS[startMark] : undefined, end: endMark ? END_MARKERS[endMark] : undefined, minlen });
      from = to;
    }
  }
  const graphNodes: GraphNode[] = [...nodes].map(([id, node]) => {
    const label = ctx.label(node.label);
    const style = Object.assign({}, ...node.classes.map((c) => classDefs.get(c) ?? {}), styles.get(id) ?? {}) as Record<string, string>;
    return { id, label, shape: node.shape, style, cluster: node.cluster, ...sizeFor(node.shape, label) };
  });
  return drawGraph(
    ctx,
    graphNodes,
    edges.map((e) => ({ ...e, label: e.label ? ctx.label(e.label, FONT - 1) : undefined })),
    clusters.map((c) => ({ id: c.id, label: ctx.label(c.label), parent: c.parent })),
    direction,
  );
}

function closerFor(after: string, shape: [string, string, string]) {
  const trimmed = after.trimStart();
  return SHAPES.find(([open, close]) => open === shape[0] && trimmed.startsWith(close))?.[1] ?? shape[1];
}

// ---------- stateDiagram ----------

function stateDiagram(lines: string[], ctx: Context) {
  let direction: Direction = "TB";
  const states = new Map<string, { label: string; descriptions: string[]; kind: string; cluster?: string | undefined }>();
  const edges: GraphEdge[] = [];
  const clusters: Cluster[] = [];
  const stack: string[] = [];
  const resolve = (raw: string, role: "from" | "to") => {
    if (raw !== "[*]") return touch(raw);
    const scope = stack.at(-1) ?? "root";
    const id = `${scope}:${role === "from" ? "start" : "end"}`;
    if (!states.has(id)) states.set(id, { label: "", descriptions: [], kind: role === "from" ? "start" : "end", cluster: stack.at(-1) });
    return id;
  };
  const touch = (id: string) => {
    if (!states.has(id)) states.set(id, { label: id, descriptions: [], kind: "state", cluster: stack.at(-1) });
    return id;
  };
  for (const line of lines.slice(1)) {
    let m: RegExpExecArray | null;
    if ((m = /^direction\s+(TB|TD|BT|LR|RL)/.exec(line))) {
      if (!stack.length) direction = m[1]!.replace("TD", "TB") as Direction;
    } else if ((m = /^state\s+"([^"]+)"\s+as\s+(\S+)(?:\s*\{)?$/.exec(line))) {
      touch(m[2]!);
      states.get(m[2]!)!.label = m[1]!;
      if (line.endsWith("{")) {
        clusters.push({ id: m[2]!, label: ctx.label(m[1]!), parent: stack.at(-1) });
        stack.push(m[2]!);
      }
    } else if ((m = /^state\s+(\S+)\s+<<(fork|join|choice)>>/.exec(line))) {
      touch(m[1]!);
      states.get(m[1]!)!.kind = m[2]!;
    } else if ((m = /^state\s+(\S+)\s*\{$/.exec(line))) {
      clusters.push({ id: m[1]!, label: ctx.label(m[1]!), parent: stack.at(-1) });
      stack.push(m[1]!);
    } else if (line === "}") stack.pop();
    else if ((m = /^(\S+)\s*(-->)\s*(\S+?)(?:\s*:\s*(.*))?$/.exec(line))) {
      const from = resolve(m[1]!, "from");
      const to = resolve(m[3]!, "to");
      edges.push({ from, to, label: m[4] ? ctx.label(m[4], FONT - 1) : undefined, stroke: "solid", end: "arrow" });
    } else if ((m = /^state\s+(\S+)$/.exec(line))) touch(m[1]!);
    else if ((m = /^(\S+)\s*:\s*(.+)$/.exec(line))) {
      const id = touch(m[1]!);
      const state = states.get(id)!;
      if (state.label === id && !state.descriptions.length) state.label = m[2]!;
      else state.descriptions.push(m[2]!);
    } else if (/^(note|end note|--|classDef|class|hide|scale)\b/.test(line) || /^note\b/i.test(line)) continue;
  }
  // Composite states are clusters, not nodes; edges into them land on their first member.
  const clusterIds = new Set(clusters.map((c) => c.id));
  const anchor = (id: string) => {
    if (!clusterIds.has(id)) return id;
    return [...states].find(([sid, s]) => s.cluster === id && !clusterIds.has(sid))?.[0] ?? id;
  };
  const nodes: GraphNode[] = [...states]
    .filter(([id]) => !clusterIds.has(id) || ![...states.values()].some((s) => s.cluster === id))
    .map(([id, s]) => {
      if (clusterIds.has(id)) clusterIds.delete(id);
      if (s.kind === "start") return { id, label: ctx.label(""), shape: "start", width: 16, height: 16, cluster: s.cluster, draw: (p: Placed) => [el("circle", { cx: p.x, cy: p.y, r: 8, style: `fill:${C.fg}` })] };
      if (s.kind === "end")
        return { id, label: ctx.label(""), shape: "end", width: 20, height: 20, cluster: s.cluster, draw: (p: Placed) => [el("circle", { cx: p.x, cy: p.y, r: 10, style: `fill:none;stroke:${C.fg};stroke-width:1.5` }), el("circle", { cx: p.x, cy: p.y, r: 6, style: `fill:${C.fg}` })] };
      if (s.kind === "fork" || s.kind === "join") {
        const horizontal = direction === "LR" || direction === "RL";
        return { id, label: ctx.label(""), shape: "rect", width: horizontal ? 8 : 70, height: horizontal ? 70 : 8, cluster: s.cluster, draw: (p: Placed) => [el("rect", { x: p.x - p.width / 2, y: p.y - p.height / 2, width: p.width, height: p.height, rx: 2, style: `fill:${C.fg}` })] };
      }
      if (s.kind === "choice") return { id, label: ctx.label(""), shape: "diamond", width: 26, height: 26, cluster: s.cluster };
      const title = ctx.label(s.label);
      const description = s.descriptions.length ? ctx.label(s.descriptions.join("\n"), FONT - 1) : null;
      const width = Math.max(title.width, description?.width ?? 0) + 30;
      const height = title.height + 16 + (description ? description.height + 10 : 0);
      return {
        id,
        label: title,
        shape: "round",
        width: Math.max(width, 50),
        height,
        cluster: s.cluster,
        draw: (p: Placed) => {
          const top = p.y - p.height / 2;
          const out: ElContent[] = [el("rect", { x: p.x - p.width / 2, y: top, width: p.width, height: p.height, rx: 10, style: `fill:${C.surface};stroke:${C.border};stroke-width:1.2` })];
          out.push(ctx.drawLabel(title, p.x, top + 8 + title.height / 2));
          if (description) {
            out.push(el("path", { d: `M${p.x - p.width / 2},${top + title.height + 13} H${p.x + p.width / 2}`, style: `stroke:${C.border}` }));
            out.push(ctx.drawLabel(description, p.x, top + title.height + 18 + description.height / 2, { size: FONT - 1, color: C.muted }));
          }
          return out;
        },
      };
    });
  const known = new Set(nodes.map((n) => n.id));
  return drawGraph(
    ctx,
    nodes,
    edges.map((e) => ({ ...e, from: anchor(e.from), to: anchor(e.to) })).filter((e) => known.has(e.from) && known.has(e.to)),
    clusters,
    direction,
  );
}

// ---------- classDiagram ----------

const CLASS_RELATION = /^(\S+?)\s*(?:"([^"]*)"\s*)?(<\|--|<\|\.\.|\*--|o--|<--|<\.\.|--\|>|\.\.\|>|--\*|--o|-->|\.\.>|--|\.\.)\s*(?:"([^"]*)"\s*)?(\S+?)(?:\s*:\s*(.*))?$/;
function classDiagram(lines: string[], ctx: Context) {
  let direction: Direction = "TB";
  const classes = new Map<string, { label: string; annotation?: string; attributes: string[]; methods: string[] }>();
  const relations: GraphEdge[] = [];
  const touch = (raw: string) => {
    const id = raw.replace(/~.*~$/, "");
    if (!classes.has(id)) classes.set(id, { label: raw.replace(/~([^~]*)~/g, "<$1>"), attributes: [], methods: [] });
    return classes.get(id)!;
  };
  const member = (target: ReturnType<typeof touch>, raw: string) => {
    const value = raw.trim();
    if (!value) return;
    if (/^<<.*>>$/.test(value)) target.annotation = value;
    else (value.includes("(") ? target.methods : target.attributes).push(value.replace(/~([^~]*)~/g, "<$1>"));
  };
  let open: ReturnType<typeof touch> | null = null;
  for (const line of lines.slice(1)) {
    let m: RegExpExecArray | null;
    if (open) {
      if (line === "}") open = null;
      else member(open, line);
      continue;
    }
    if ((m = /^direction\s+(TB|TD|BT|LR|RL)/.exec(line))) direction = m[1]!.replace("TD", "TB") as Direction;
    else if ((m = /^class\s+([^\s{]+)(?:\s*\["([^"]*)"\])?\s*(\{)?\s*(?:(.*)\})?$/.exec(line))) {
      const target = touch(m[1]!);
      if (m[2]) target.label = m[2];
      if (m[4] !== undefined) m[4].split(/;|\n/).forEach((x) => member(target, x));
      else if (m[3]) open = target;
    } else if ((m = /^<<(.+)>>\s+(\S+)$/.exec(line))) touch(m[2]!).annotation = `<<${m[1]}>>`;
    else if ((m = CLASS_RELATION.exec(line))) {
      const [, left, leftCard, op, rightCard, right, label] = m;
      touch(left!);
      touch(right!);
      const markers: Record<string, [string | undefined, string | undefined]> = {
        "<|--": ["triangle", undefined], "<|..": ["triangle", undefined], "*--": ["filledDiamond", undefined], "o--": ["diamond", undefined],
        "<--": ["open", undefined], "<..": ["open", undefined], "--|>": [undefined, "triangle"], "..|>": [undefined, "triangle"],
        "--*": [undefined, "filledDiamond"], "--o": [undefined, "diamond"], "-->": [undefined, "open"], "..>": [undefined, "open"], "--": [undefined, undefined], "..": [undefined, undefined],
      };
      const [start, end] = markers[op!]!;
      relations.push({ from: left!.replace(/~.*~$/, ""), to: right!.replace(/~.*~$/, ""), stroke: op!.includes(".") ? "dotted" : "solid", start, end, label: label ? ctx.label(label, FONT - 1) : undefined, ...(leftCard ? { startLabel: leftCard } : {}), ...(rightCard ? { endLabel: rightCard } : {}) });
    } else if ((m = /^(\S+)\s*:\s*(.+)$/.exec(line))) member(touch(m[1]!), m[2]!);
  }
  const nodes: GraphNode[] = [...classes].map(([id, c]) => {
    const title = ctx.label(c.label, FONT, true);
    const annotation = c.annotation ? ctx.label(c.annotation, FONT - 2) : null;
    const attributes = c.attributes.map((a) => ctx.label(a, FONT - 1));
    const methods = c.methods.map((a) => ctx.label(a, FONT - 1));
    const width = Math.max(title.width, annotation?.width ?? 0, ...attributes.map((a) => a.width), ...methods.map((a) => a.width)) + 24;
    const header = title.height + (annotation ? annotation.height : 0) + 12;
    const section = (items: Label[]) => (items.length ? items.reduce((s, l) => s + l.height, 0) + 8 : 10);
    const height = header + section(attributes) + section(methods);
    return {
      id,
      label: title,
      shape: "rect",
      width: Math.max(width, 80),
      height,
      draw: (p: Placed) => {
        const l = p.x - p.width / 2;
        let y = p.y - p.height / 2;
        const out: ElContent[] = [el("rect", { x: l, y, width: p.width, height: p.height, rx: 3, style: `fill:${C.surface};stroke:${C.border};stroke-width:1.2` })];
        if (annotation) {
          out.push(ctx.drawLabel(annotation, p.x, y + 6 + annotation.height / 2, { size: FONT - 2, color: C.muted }));
          y += annotation.height;
        }
        out.push(ctx.drawLabel(title, p.x, y + 6 + title.height / 2, { bold: true }));
        y += title.height + 12;
        for (const items of [attributes, methods]) {
          out.push(el("path", { d: `M${l},${y} H${l + p.width}`, style: `stroke:${C.border}` }));
          let top = y + 4;
          for (const item of items) {
            out.push(ctx.drawLabel(item, l + 10, top + item.height / 2, { anchor: "start", size: FONT - 1 }));
            top += item.height;
          }
          y += section(items);
        }
        return out;
      },
    };
  });
  return drawGraph(ctx, nodes, relations, [], direction);
}

// ---------- erDiagram ----------

const ER_RELATION = /^(\S+?)\s*([|}][|o]|[|o][|{])(--|\.\.)([|o][|{]|[|}][|o])\s*(\S+?)\s*:\s*(.+)$/;
const ER_MARKERS: Record<string, string> = { "||": "one", "|o": "zeroOne", "o|": "zeroOne", "}o": "many", "o{": "many", "}|": "oneMany", "|{": "oneMany" };
function erDiagram(lines: string[], ctx: Context) {
  let direction: Direction = "TB";
  const entities = new Map<string, { label: string; attributes: string[][] }>();
  const relations: GraphEdge[] = [];
  const touch = (raw: string) => {
    const alias = /^([\w-]+)\[(.+)\]$/.exec(raw);
    const id = alias ? alias[1]! : raw;
    if (!entities.has(id)) entities.set(id, { label: alias ? cleanLabel(alias[2]!) : id, attributes: [] });
    return entities.get(id)!;
  };
  let open: ReturnType<typeof touch> | null = null;
  for (const line of lines.slice(1)) {
    let m: RegExpExecArray | null;
    if (open) {
      if (line === "}") open = null;
      else if ((m = /^(\S+)\s+(\S+)(?:\s+((?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*))?(?:\s+"([^"]*)")?$/.exec(line))) open.attributes.push([m[1]!, m[2]!, m[3] ?? "", m[4] ?? ""]);
      continue;
    }
    if ((m = /^direction\s+(TB|TD|BT|LR|RL)/.exec(line))) direction = m[1]!.replace("TD", "TB") as Direction;
    else if ((m = /^(\S+?)\s*\{$/.exec(line))) open = touch(m[1]!);
    else if ((m = ER_RELATION.exec(line))) {
      const [, left, leftCard, line_, rightCard, right, label] = m;
      touch(left!);
      touch(right!);
      relations.push({ from: left!.replace(/\[.*\]$/, ""), to: right!.replace(/\[.*\]$/, ""), stroke: line_ === ".." ? "dotted" : "solid", start: ER_MARKERS[leftCard!], end: ER_MARKERS[rightCard!], label: ctx.label(label!.replace(/^"|"$/g, ""), FONT - 1) });
    } else if ((m = /^(\S+)$/.exec(line))) touch(m[1]!);
  }
  const nodes: GraphNode[] = [...entities].map(([id, e]) => {
    const title = ctx.label(e.label, FONT, true);
    const columns = [0, 1, 2, 3].map((c) => Math.max(0, ...e.attributes.map((a) => (a[c] ? ctx.measure(a[c]!, FONT - 1) + 14 : 0))));
    const row = LINE;
    const width = Math.max(title.width + 24, columns.reduce((s, c) => s + c, 0) + 6, 80);
    const height = title.height + 12 + e.attributes.length * row;
    return {
      id,
      label: title,
      shape: "rect",
      width,
      height,
      draw: (p: Placed) => {
        const l = p.x - p.width / 2;
        const t = p.y - p.height / 2;
        const out: ElContent[] = [
          el("rect", { x: l, y: t, width: p.width, height: p.height, rx: 3, style: `fill:${C.surface};stroke:${C.border};stroke-width:1.2` }),
          el("rect", { x: l, y: t, width: p.width, height: title.height + 12, rx: 3, style: `fill:${C.alt};stroke:${C.border};stroke-width:1.2` }),
          ctx.drawLabel(title, p.x, t + 6 + title.height / 2, { bold: true }),
        ];
        e.attributes.forEach((attribute, r) => {
          const y = t + title.height + 12 + r * row;
          if (r % 2) out.push(el("rect", { x: l + 1, y, width: p.width - 2, height: row, style: `fill:${C.alt};fill-opacity:0.5` }));
          let x = l + 8;
          attribute.forEach((cell, c) => {
            if (cell) out.push(el("text", { x, y: y + row / 2 + (FONT - 1) * 0.35, style: `fill:${c === 0 || c === 3 ? C.muted : C.fg};font-size:${FONT - 1}px` }, [text(cell)]));
            x += columns[c]!;
          });
        });
        return out;
      },
    };
  });
  return drawGraph(ctx, nodes, relations, [], direction);
}

// ---------- sequenceDiagram ----------

type SequenceEvent =
  | { kind: "message"; from: string; to: string; text: string; dashed: boolean; head: "arrow" | "open" | "cross" | "async" | "none"; activate?: boolean; deactivate?: boolean }
  | { kind: "note"; at: string[]; side: "left" | "right" | "over"; text: string }
  | { kind: "block"; type: string; text: string }
  | { kind: "divider"; text: string }
  | { kind: "end" }
  | { kind: "activate"; actor: string; on: boolean };

function sequence(lines: string[], ctx: Context) {
  const actors = new Map<string, { label: string; actor: boolean }>();
  const events: SequenceEvent[] = [];
  let autonumber = false;
  let title = "";
  const touch = (id: string) => {
    if (!actors.has(id)) actors.set(id, { label: id, actor: false });
    return id;
  };
  for (const line of lines.slice(1)) {
    let m: RegExpExecArray | null;
    if ((m = /^(participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/.exec(line))) {
      actors.set(m[2]!, { label: m[3] ?? m[2]!, actor: m[1] === "actor" });
    } else if ((m = /^create\s+(participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/.exec(line))) {
      actors.set(m[2]!, { label: m[3] ?? m[2]!, actor: m[1] === "actor" });
    } else if (line === "autonumber" || line.startsWith("autonumber ")) autonumber = true;
    else if ((m = /^title\s*:?\s*(.+)$/.exec(line))) title = m[1]!;
    else if ((m = /^(activate|deactivate)\s+(.+)$/.exec(line))) events.push({ kind: "activate", actor: touch(m[2]!), on: m[1] === "activate" });
    else if ((m = /^note\s+(left of|right of|over)\s+([^:]+):\s*(.*)$/i.exec(line))) {
      events.push({ kind: "note", at: m[2]!.split(",").map((a) => touch(a.trim())), side: m[1]!.split(" ")[0]!.toLowerCase() as "left", text: m[3]! });
    } else if ((m = /^(loop|alt|opt|par|critical|break|rect|box)\b\s*(.*)$/.exec(line))) events.push({ kind: "block", type: m[1]!, text: m[1] === "rect" ? "" : m[2]! });
    else if ((m = /^(else|and|option)\b\s*(.*)$/.exec(line))) events.push({ kind: "divider", text: m[2]! });
    else if (line === "end") events.push({ kind: "end" });
    else if ((m = /^([^-+<>]+?)\s*(<<)?(-{1,2})(>>|>|x|\)|)\s*([+-]?)\s*([^:]+?)\s*:\s*(.*)$/.exec(line))) {
      const [, from, , dashes, head, mark, to, message] = m;
      events.push({
        kind: "message",
        from: touch(from!.trim()),
        to: touch(to!.trim()),
        text: message!,
        dashed: dashes === "--",
        head: head === ">>" ? "arrow" : head === ">" ? "open" : head === "x" ? "cross" : head === ")" ? "async" : "none",
        ...(mark === "+" ? { activate: true } : mark === "-" ? { deactivate: true } : {}),
      });
    } else if (/^(destroy|links?|properties|details)\b/.test(line)) continue;
    else throw new Error(`Unexpected "${line.slice(0, 30)}" in sequence diagram`);
  }
  const ids = [...actors.keys()];
  const labels = new Map(ids.map((id) => [id, ctx.label(actors.get(id)!.label)]));
  const boxWidth = (id: string) => Math.max(labels.get(id)!.width + 24, 70);
  // Spacing between neighbors grows to fit the widest message between them.
  const gaps = ids.slice(1).map((id, i) => (boxWidth(ids[i]!) + boxWidth(id)) / 2 + 30);
  const order = new Map(ids.map((id, i) => [id, i]));
  let number = 0;
  for (const event of events) {
    if (event.kind !== "message") continue;
    const a = order.get(event.from)!;
    const b = order.get(event.to)!;
    const width = ctx.label((autonumber ? "00 " : "") + event.text, FONT - 1).width + 30;
    if (a === b) {
      if (a < gaps.length) gaps[a] = Math.max(gaps[a]!, width + 30);
      continue;
    }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const span = gaps.slice(lo, hi).reduce((s, g) => s + g, 0);
    if (span < width) for (let i = lo; i < hi; i++) gaps[i]! += (width - span) / (hi - lo);
  }
  const x = new Map<string, number>();
  let cursor = boxWidth(ids[0] ?? "") / 2;
  ids.forEach((id, i) => {
    if (i) cursor += gaps[i - 1]!;
    x.set(id, cursor);
  });
  const width = cursor + boxWidth(ids.at(-1) ?? "") / 2;
  const content: ElContent[] = [];
  const titleLabel = title ? ctx.label(title, FONT + 2, true) : null;
  let y = titleLabel ? titleLabel.height + 12 : 0;
  if (titleLabel) content.push(ctx.drawLabel(titleLabel, width / 2, titleLabel.height / 2, { size: FONT + 2, bold: true }));
  const headerHeight = Math.max(0, ...[...labels.values()].map((l) => l.height)) + 18;
  const top = y;
  y += headerHeight + 16;
  const lifelines: ElContent[] = [];
  const foreground: ElContent[] = [];
  const blocks: { type: string; text: string; start: number; dividers: { y: number; text: string }[]; actors: Set<string> }[] = [];
  const frames: ElContent[] = [];
  const activations = new Map<string, number[]>();
  const activationBoxes: ElContent[] = [];
  const setActive = (actor: string, on: boolean, at: number) => {
    const stack = activations.get(actor) ?? [];
    if (on) stack.push(at);
    else {
      const start = stack.pop();
      if (start !== undefined) activationBoxes.push(el("rect", { x: x.get(actor)! - 5 + (stack.length * 4), y: start, width: 10, height: Math.max(8, at - start), style: `fill:${C.alt};stroke:${C.border}` }));
    }
    activations.set(actor, stack);
  };
  const involve = (...who: string[]) => blocks.forEach((b) => who.forEach((w) => b.actors.add(w)));
  for (const event of events) {
    if (event.kind === "message") {
      involve(event.from, event.to);
      const label = ctx.label((autonumber ? `${++number}. ` : "") + event.text, FONT - 1);
      const x1 = x.get(event.from)!;
      const x2 = x.get(event.to)!;
      const style = `fill:none;stroke:${C.line};stroke-width:1.3${event.dashed ? ";stroke-dasharray:5 3" : ""}`;
      const marker = event.head === "none" ? undefined : ctx.marker(event.head === "arrow" ? "arrow" : event.head === "cross" ? "cross" : "open");
      if (x1 === x2) {
        foreground.push(ctx.drawLabel(label, x1 + 14 + label.width / 2, y + label.height / 2, { size: FONT - 1, anchor: "middle" }));
        y += label.height + 6;
        foreground.push(el("path", { d: `M${x1},${y} H${x1 + 34} V${y + 22} H${x1 + 4}`, style, "marker-end": marker }));
        y += 34;
      } else {
        foreground.push(ctx.drawLabel(label, (x1 + x2) / 2, y + label.height / 2, { size: FONT - 1 }));
        y += label.height + 6;
        foreground.push(el("path", { d: `M${x1},${y} H${x2 - Math.sign(x2 - x1) * 2}`, style, "marker-end": marker }));
        y += 18;
      }
      if (event.activate) setActive(event.to, true, y - 18);
      if (event.deactivate) setActive(event.from, false, y - 18);
    } else if (event.kind === "activate") setActive(event.actor, event.on, y - 12);
    else if (event.kind === "note") {
      involve(...event.at);
      const label = ctx.label(event.text, FONT - 1);
      const xs = event.at.map((a) => x.get(a)!);
      const w = Math.max(label.width + 20, event.side === "over" && xs.length > 1 ? Math.max(...xs) - Math.min(...xs) + 40 : 0);
      const cx = event.side === "over" ? (Math.min(...xs) + Math.max(...xs)) / 2 : event.side === "left" ? xs[0]! - 14 - w / 2 : xs[0]! + 14 + w / 2;
      const h = label.height + 12;
      foreground.push(el("rect", { x: cx - w / 2, y, width: w, height: h, rx: 2, style: `fill:${C.alt};stroke:${C.border}` }), ctx.drawLabel(label, cx, y + h / 2, { size: FONT - 1 }));
      y += h + 12;
    } else if (event.kind === "block") {
      blocks.push({ type: event.type, text: event.text, start: y, dividers: [], actors: new Set() });
      y += event.text || event.type !== "rect" ? 28 : 10;
    } else if (event.kind === "divider") {
      const block = blocks.at(-1);
      if (block) block.dividers.push({ y, text: event.text });
      y += 26;
    } else if (event.kind === "end") {
      const block = blocks.pop();
      if (!block) continue;
      const xs = [...block.actors].map((a) => x.get(a)!);
      const depth = blocks.length;
      const l = (xs.length ? Math.min(...xs) : 0) - 40 + depth * 6;
      const r = (xs.length ? Math.max(...xs) : width) + 40 - depth * 6;
      y += 6;
      const tag = block.type === "rect" ? "" : block.type;
      if (block.type === "rect") frames.push(el("rect", { x: l, y: block.start, width: r - l, height: y - block.start, style: `fill:${C.accent};fill-opacity:0.08` }));
      else {
        const tagWidth = ctx.measure(tag, FONT - 2, true) + 16;
        frames.push(
          el("rect", { x: l, y: block.start, width: r - l, height: y - block.start, style: `fill:none;stroke:${C.border}` }),
          el("path", { d: `M${l},${block.start} H${l + tagWidth} V${block.start + 14} L${l + tagWidth - 6},${block.start + 20} H${l} Z`, style: `fill:${C.alt};stroke:${C.border}` }),
          el("text", { x: l + 6, y: block.start + 14, style: `fill:${C.fg};font-size:${FONT - 2}px;font-weight:600` }, [text(tag)]),
        );
        if (block.text) frames.push(el("text", { x: l + tagWidth + 8, y: block.start + 14, style: `fill:${C.muted};font-size:${FONT - 2}px` }, [text(`[${cleanLabel(block.text)}]`)]));
        for (const divider of block.dividers) {
          frames.push(el("path", { d: `M${l},${divider.y} H${r}`, style: `stroke:${C.border};stroke-dasharray:4 3` }));
          if (divider.text) frames.push(el("text", { x: l + 8, y: divider.y + 15, style: `fill:${C.muted};font-size:${FONT - 2}px` }, [text(`[${cleanLabel(divider.text)}]`)]));
        }
      }
      y += 8;
    }
  }
  for (const [actor, stack] of activations) while (stack.length) setActive(actor, false, y);
  const bottom = y + 10;
  const head = (id: string, at: number) => {
    const cx = x.get(id)!;
    const label = labels.get(id)!;
    if (actors.get(id)!.actor) {
      return [
        el("path", { d: `M${cx},${at + 10} m-6,0 a6,6 0 1,0 12,0 a6,6 0 1,0 -12,0 M${cx},${at + 16} V${at + 28} M${cx - 10},${at + 20} H${cx + 10} M${cx},${at + 28} L${cx - 8},${at + 38} M${cx},${at + 28} L${cx + 8},${at + 38}`, style: `fill:none;stroke:${C.fg};stroke-width:1.4` }),
        ctx.drawLabel(label, cx, at + 38 + label.height / 2 + 2),
      ];
    }
    const w = boxWidth(id);
    return [el("rect", { x: cx - w / 2, y: at, width: w, height: headerHeight, rx: 3, style: `fill:${C.surface};stroke:${C.border};stroke-width:1.2` }), ctx.drawLabel(label, cx, at + headerHeight / 2)];
  };
  for (const id of ids) {
    lifelines.push(el("path", { d: `M${x.get(id)},${top + headerHeight} V${bottom}`, style: `stroke:${C.border};stroke-dasharray:3 3` }));
    content.push(...head(id, top), ...head(id, bottom));
  }
  const actorExtra = [...actors.values()].some((a) => a.actor) ? 30 : 0;
  return { content: [...frames, ...lifelines, ...activationBoxes, ...foreground, ...content], width, height: bottom + headerHeight + actorExtra };
}

// ---------- pie ----------

function pie(lines: string[], ctx: Context) {
  let title = /^pie\b.*?\btitle\s+(.+)$/.exec(lines[0]!)?.[1] ?? "";
  const showData = /\bshowData\b/.test(lines[0]!);
  const slices: { label: string; value: number }[] = [];
  for (const line of lines.slice(1)) {
    let m: RegExpExecArray | null;
    if ((m = /^title\s+(.+)$/.exec(line))) title = m[1]!;
    else if ((m = /^"([^"]*)"\s*:\s*([\d.eE+-]+)$/.exec(line))) {
      const value = Number(m[2]);
      if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid pie value for "${m[1]}"`);
      slices.push({ label: m[1]!, value });
    } else if (line !== "showData") throw new Error(`Unexpected "${line.slice(0, 30)}" in pie chart`);
  }
  const total = slices.reduce((s, x) => s + x.value, 0);
  const radius = 120;
  const titleLabel = title ? ctx.label(title, FONT + 2, true) : null;
  const top = titleLabel ? titleLabel.height + 16 : 0;
  const cx = radius;
  const cy = top + radius;
  const content: ElContent[] = [];
  if (titleLabel) content.push(ctx.drawLabel(titleLabel, radius, titleLabel.height / 2, { size: FONT + 2, bold: true }));
  let angle = -Math.PI / 2;
  slices.forEach((slice, i) => {
    const sweep = total ? (slice.value / total) * Math.PI * 2 : 0;
    const color = SERIES[i % SERIES.length]!;
    if (sweep >= Math.PI * 2 - 1e-9) content.push(el("circle", { cx, cy, r: radius, style: `fill:${color};stroke:${C.bg};stroke-width:2` }));
    else if (sweep > 0) {
      const [x1, y1, x2, y2] = [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle), cx + radius * Math.cos(angle + sweep), cy + radius * Math.sin(angle + sweep)];
      content.push(el("path", { d: `M${round(cx)},${round(cy)} L${round(x1)},${round(y1)} A${radius},${radius} 0 ${sweep > Math.PI ? 1 : 0},1 ${round(x2)},${round(y2)} Z`, style: `fill:${color};stroke:${C.bg};stroke-width:2` }));
    }
    if (sweep > 0.25) {
      const mid = angle + sweep / 2;
      content.push(el("text", { x: cx + radius * 0.65 * Math.cos(mid), y: cy + radius * 0.65 * Math.sin(mid) + 4, "text-anchor": "middle", style: `fill:#ffffff;font-size:${FONT - 1}px;font-weight:600` }, [text(`${Math.round((slice.value / total) * 100)}%`)]));
    }
    angle += sweep;
  });
  const legendX = radius * 2 + 30;
  let legendWidth = 0;
  slices.forEach((slice, i) => {
    const y = top + radius - (slices.length * 22) / 2 + i * 22;
    const label = showData ? `${slice.label} [${slice.value}]` : slice.label;
    legendWidth = Math.max(legendWidth, ctx.measure(label) + 24);
    content.push(el("rect", { x: legendX, y, width: 14, height: 14, rx: 2, style: `fill:${SERIES[i % SERIES.length]}` }), el("text", { x: legendX + 22, y: y + 12, style: `fill:${C.fg}` }, [text(label)]));
  });
  return { content, width: Math.max(legendX + legendWidth, titleLabel?.width ?? 0), height: Math.max(cy + radius, top + (slices.length * 22) / 2 + radius) };
}

// ---------- xychart-beta ----------

function niceTicks(min: number, max: number, count = 5) {
  const span = max - min || Math.abs(max) || 1;
  const step0 = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * magnitude).find((s) => s >= step0)!;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let t = start; t <= max + step * 0.5 && ticks.length < 50; t += step) ticks.push(Math.round(t / step) * step);
  return { ticks, min: ticks[0]!, max: ticks.at(-1)! };
}

function xychart(lines: string[], ctx: Context) {
  let title = "";
  let categories: string[] | null = null;
  let xRange: [number, number] | null = null;
  let xTitle = "";
  let yTitle = "";
  let yRange: [number, number] | null = null;
  const series: { kind: "bar" | "line"; values: number[] }[] = [];
  const list = (raw: string) => raw.split(",").map((s) => cleanLabel(s.trim()));
  for (const line of lines.slice(1)) {
    let m: RegExpExecArray | null;
    if ((m = /^title\s+(.+)$/.exec(line))) title = cleanLabel(m[1]!);
    else if ((m = /^x-axis\s*(?:("[^"]*"|\w+)\s*)?(?:\[(.*)\]|([\d.-]+)\s*-->\s*([\d.-]+))?$/.exec(line))) {
      if (m[1]) xTitle = cleanLabel(m[1]);
      if (m[2] !== undefined) categories = list(m[2]);
      if (m[3] !== undefined) xRange = [Number(m[3]), Number(m[4])];
    } else if ((m = /^y-axis\s*(?:("[^"]*"|\w+)\s*)?(?:([\d.-]+)\s*-->\s*([\d.-]+))?$/.exec(line))) {
      if (m[1]) yTitle = cleanLabel(m[1]);
      if (m[2] !== undefined) yRange = [Number(m[2]), Number(m[3])];
    } else if ((m = /^(bar|line)\s*(?:"[^"]*"\s*)?\[(.*)\]$/.exec(line))) {
      const values = m[2]!.split(",").map((s) => Number(s.trim()));
      if (values.some((n) => !Number.isFinite(n))) throw new Error(`Invalid ${m[1]} values`);
      series.push({ kind: m[1] as "bar" | "line", values });
    } else throw new Error(`Unexpected "${line.slice(0, 30)}" in xychart`);
  }
  const count = Math.max(categories?.length ?? 0, ...series.map((s) => s.values.length));
  const labelsX = categories ?? Array.from({ length: count }, (_, i) => (xRange ? String(round(xRange[0] + ((xRange[1] - xRange[0]) * i) / Math.max(1, count - 1))) : String(i + 1)));
  const all = series.flatMap((s) => s.values);
  const nice = niceTicks(yRange?.[0] ?? Math.min(0, ...all), yRange?.[1] ?? Math.max(...all, 1));
  const [min, max] = yRange ?? [nice.min, nice.max];
  const ticks = nice.ticks.filter((t) => t >= min && t <= max);
  const plotWidth = Math.max(300, count * 48);
  const plotHeight = 260;
  const left = Math.max(...ticks.map((t) => ctx.measure(String(t), FONT - 2))) + (yTitle ? 30 : 12);
  const titleLabel = title ? ctx.label(title, FONT + 2, true) : null;
  const top = titleLabel ? titleLabel.height + 16 : 6;
  const scaleY = (value: number) => top + plotHeight - ((value - min) / (max - min || 1)) * plotHeight;
  const band = plotWidth / Math.max(1, count);
  const content: ElContent[] = [];
  if (titleLabel) content.push(ctx.drawLabel(titleLabel, left + plotWidth / 2, titleLabel.height / 2, { size: FONT + 2, bold: true }));
  for (const tick of ticks) {
    const y = scaleY(tick);
    content.push(el("path", { d: `M${left},${y} H${left + plotWidth}`, style: `stroke:${C.border};stroke-opacity:0.5` }), el("text", { x: left - 6, y: y + 4, "text-anchor": "end", style: `fill:${C.muted};font-size:${FONT - 2}px` }, [text(String(tick))]));
  }
  const bars = series.filter((s) => s.kind === "bar");
  series.forEach((s, index) => {
    const color = SERIES[index % SERIES.length]!;
    if (s.kind === "bar") {
      const slot = bars.indexOf(s);
      const width = (band * 0.7) / bars.length;
      s.values.forEach((value, i) => {
        const y = scaleY(Math.max(value, Math.max(min, 0)));
        const base = scaleY(Math.max(min, Math.min(0, max)));
        content.push(el("rect", { x: left + i * band + band * 0.15 + slot * width, y: Math.min(y, scaleY(value)), width, height: Math.abs(base - scaleY(value)), style: `fill:${color}` }));
      });
    } else {
      const points = s.values.map((value, i) => `${round(left + i * band + band / 2)},${round(scaleY(value))}`);
      content.push(el("polyline", { points: points.join(" "), style: `fill:none;stroke:${color};stroke-width:2.5;stroke-linejoin:round` }));
    }
  });
  content.push(el("path", { d: `M${left},${top} V${top + plotHeight} H${left + plotWidth}`, style: `fill:none;stroke:${C.line}` }));
  const rotate = labelsX.some((l) => ctx.measure(l, FONT - 2) > band - 4);
  labelsX.forEach((label, i) => {
    const x = left + i * band + band / 2;
    const y = top + plotHeight + 16;
    content.push(el("text", { x, y, "text-anchor": rotate ? "end" : "middle", transform: rotate ? `rotate(-35 ${round(x)} ${round(y)})` : undefined, style: `fill:${C.muted};font-size:${FONT - 2}px` }, [text(label)]));
  });
  const labelDepth = rotate ? Math.max(...labelsX.map((l) => ctx.measure(l, FONT - 2))) * 0.6 + 16 : 22;
  let height = top + plotHeight + labelDepth;
  if (xTitle) {
    content.push(el("text", { x: left + plotWidth / 2, y: height + 12, "text-anchor": "middle", style: `fill:${C.fg};font-size:${FONT - 1}px` }, [text(xTitle)]));
    height += 20;
  }
  if (yTitle) content.push(el("text", { x: 12, y: top + plotHeight / 2, "text-anchor": "middle", transform: `rotate(-90 12 ${round(top + plotHeight / 2)})`, style: `fill:${C.fg};font-size:${FONT - 1}px` }, [text(yTitle)]));
  return { content, width: left + plotWidth + 8, height };
}
