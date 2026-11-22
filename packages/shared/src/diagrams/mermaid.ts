// Zero-dependency Mermaid renderer: parsers, a layered (Sugiyama) layout and theme-aware SVG element trees.
// Colors are `--pele-*` custom properties with fallbacks, so a host theme (or react-native-svg's resolver) restyles them.
import { renderMathSvg } from "../markdown/mathSvg.ts";
import type { ElContent, ElElement } from "../markdown/types.ts";

export type DiagramType =
  | "flowchart"
  | "sequence"
  | "state"
  | "class"
  | "er"
  | "pie"
  | "xychart"
  | "gantt";
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
  [/^gantt\b/, "gantt"],
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

export function renderMermaidTree(
  source: string,
  options: MermaidOptions = {},
): MermaidRender<ElElement> {
  const lines = sourceLines(source);
  const type = detectDiagramType(source);
  if (!type)
    throw new Error(`Unsupported diagram type: ${(lines[0] ?? "").split(/\s/)[0] || "empty"}`);
  const ctx = new Context(options);
  const body = {
    flowchart,
    sequence,
    state: stateDiagram,
    class: classDiagram,
    er: erDiagram,
    pie,
    xychart,
    gantt,
  }[type](lines, ctx);
  return ctx.finish(body);
}

export function renderMermaid(source: string, options: MermaidOptions = {}): MermaidRender<string> {
  const { svg, width, height } = renderMermaidTree(source, options);
  return { svg: toSvg(svg), width, height };
}

const CASED = new Set([
  "viewBox",
  "preserveAspectRatio",
  "refX",
  "refY",
  "markerWidth",
  "markerHeight",
  "markerUnits",
]);
const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Serializes the element tree; property names follow the markdown emitter's camelCase-to-attribute rule. */
export function toSvg(node: ElContent): string {
  if (node.type === "text") return escape(node.value);
  if (node.type !== "element") return "";
  let out = `<${node.tagName}`;
  for (const [key, value] of Object.entries(node.properties)) {
    if (value === null || value === undefined || value === false) continue;
    const name =
      key === "className"
        ? "class"
        : CASED.has(key)
          ? key
          : key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    out += ` ${name}="${escape(Array.isArray(value) ? value.join(" ") : String(value))}"`;
  }
  return `${out}>${node.children.map(toSvg).join("")}</${node.tagName}>`;
}

// ---------- Drawing primitives ----------

// The root declares short aliases (`--_fg`) for the host's `--pele-*` tokens; `.pele` hosts set those per theme.
const THEME = {
  bg: ["bg", "#ffffff"],
  fg: ["fg", "#1f1f1f"],
  muted: ["muted", "#6e6e6e"],
  line: ["line", "#6e6e6e"],
  surface: ["surface", "#f5f5f5"],
  alt: ["surface-alt", "#ebebeb"],
  border: ["border", "#b4b4b4"],
  accent: ["accent", "#5b7bd5"],
  critical: ["critical", "#e45756"],
} as const;
const C = Object.fromEntries(Object.keys(THEME).map((key) => [key, `var(--_${key})`])) as Record<
  keyof typeof THEME,
  string
>;
const v = (name: string, fallback: string) => `var(--pele-${name}, ${fallback})`;
const SERIES = [
  "#4e79a7",
  "#f28e2b",
  "#59a14f",
  "#e15759",
  "#76b7b2",
  "#edc948",
  "#b07aa1",
  "#ff9da7",
].map((fallback, i) => v(`series-${i + 1}`, fallback));
const FONT = 14;
const LINE = FONT * 1.3;
const round = (n: number) => Math.round(n * 100) / 100;

function el(
  tagName: string,
  properties: Record<string, string | number | undefined>,
  children: ElContent[] = [],
): ElElement {
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
          : 'ftr ()[]{}/\\-"'.includes(ch)
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

type Label = {
  lines: {
    parts: ({ text: string } | { math: ElElement; width: number; height: number })[];
    width: number;
    height: number;
  }[];
  width: number;
  height: number;
};

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
    return {
      lines,
      width: Math.max(0, ...lines.map((l) => l.width)),
      height: lines.reduce((sum, l) => sum + l.height, 0),
    };
  }
  /** Centered at (x, y). */
  drawLabel(
    label: Label,
    x: number,
    y: number,
    options: {
      size?: number;
      bold?: boolean;
      color?: string | undefined;
      anchor?: "middle" | "start";
    } = {},
  ) {
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
              {
                x: left,
                y: baseline,
                style: `fill:${options.color ?? C.fg};font-size:${size}px;white-space:pre${options.bold ? ";font-weight:600" : ""}`,
              },
              [text(part.text)],
            ),
          );
          left += width;
        } else {
          out.push({
            ...part.math,
            properties: {
              ...part.math.properties,
              x: round(left),
              y: round(top + (line.height - part.height) / 2),
              width: round(part.width),
              height: round(part.height),
              style: `color:${options.color ?? C.fg};overflow:visible`,
            },
          });
          left += part.width;
        }
      }
      top += line.height;
    }
    return el("g", {}, out);
  }
  marker(name: MarkerName) {
    const id = `${this.id}-${name}`;
    if (!this.defs.has(name)) {
      // [path, fill, viewBox width, height, refX]; every marker's axis sits at half its height.
      const shapes: Record<MarkerName, [string, string, number, number, number]> = {
        arrow: ["M0,0 L9,3.5 L0,7 z", C.line, 9, 7, 9],
        open: ["M1,1 L9,5 L1,9", "none", 10, 10, 9],
        circle: ["M4,1 a3,3 0 1,0 0.01,0 z", C.bg, 8, 8, 7],
        cross: ["M1,1 L7,7 M7,1 L1,7", "none", 8, 8, 4],
        triangle: ["M0,1 L13,7 L0,13 z", C.bg, 13, 14, 13],
        diamond: ["M0,6 L8,1 L16,6 L8,11 z", C.bg, 16, 12, 16],
        filledDiamond: ["M0,6 L8,1 L16,6 L8,11 z", C.line, 16, 12, 16],
        one: ["M14,0 V12 M18,0 V12", "none", 24, 12, 24],
        zeroOne: ["M18,0 V12 M12,6 a3,3 0 1,0 -6,0 a3,3 0 1,0 6,0", C.bg, 24, 12, 24],
        many: [
          "M24,0 L12,6 L24,12 M12,6 H24 M10,6 a3,3 0 1,0 -6,0 a3,3 0 1,0 6,0",
          C.bg,
          24,
          12,
          24,
        ],
        oneMany: ["M24,0 L12,6 L24,12 M12,6 H24 M9,0 V12", C.bg, 24, 12, 24],
      };
      const [d, fill, w, h, refX] = shapes[name];
      this.defs.set(
        name,
        el(
          "marker",
          {
            id,
            viewBox: `0 0 ${w} ${h}`,
            refX,
            refY: h / 2,
            markerWidth: w,
            markerHeight: h,
            markerUnits: "userSpaceOnUse",
            orient: "auto-start-reverse",
          },
          [
            el("path", {
              d,
              style: `fill:${fill};stroke:${fill === C.line ? "none" : C.line};stroke-width:1.2;stroke-linecap:round;stroke-linejoin:round`,
            }),
          ],
        ),
      );
    }
    return `url(#${id})`;
  }
  finish(body: { content: ElContent[]; width: number; height: number }): MermaidRender<ElElement> {
    const pad = 8;
    const width = Math.ceil(body.width + pad * 2);
    const height = Math.ceil(body.height + pad * 2);
    const theme = Object.entries(THEME)
      .map(([key, [name, fallback]]) => `--_${key}:${v(name, fallback)}`)
      .join(";");
    const svg = el(
      "svg",
      {
        xmlns: "http://www.w3.org/2000/svg",
        className: "pele",
        role: "img",
        width,
        height,
        viewBox: `0 0 ${width} ${height}`,
        style: `max-width:100%;height:auto;${theme};fill:${C.fg};font:${FONT}px sans-serif;font-family:${v("font", "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif")}`,
      },
      [
        ...(this.defs.size ? [el("defs", {}, [...this.defs.values()])] : []),
        el("g", { transform: `translate(${pad},${pad})` }, body.content),
      ],
    );
    return { svg, width, height };
  }
}
type MarkerName =
  | "arrow"
  | "open"
  | "circle"
  | "cross"
  | "triangle"
  | "diamond"
  | "filledDiamond"
  | "one"
  | "zeroOne"
  | "many"
  | "oneMany";

/** A box over a canvas-colored underlay, so translucent theme fills still hide lines beneath. */
function card(
  x: number,
  y: number,
  width: number,
  height: number,
  rx: number,
  fill: string = C.surface,
  stroke: string = C.border,
): ElElement[] {
  return [
    el("rect", { x, y, width, height, rx, style: `fill:${C.bg}` }),
    el("rect", { x, y, width, height, rx, style: `fill:${fill};stroke:${stroke};stroke-width:1` }),
  ];
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
    .replace(
      /#(\w+);/g,
      (match, name: string) =>
        ENTITIES[name] ?? (/^\d+$/.test(name) ? String.fromCodePoint(Number(name)) : match),
    );
}
const ENTITIES: Record<string, string> = {
  quot: '"',
  amp: "&",
  lt: "<",
  gt: ">",
  nbsp: " ",
  apos: "'",
};

const SAFE_STYLE_VALUE = /^(?:[#\w\s.%-]|(?:rgba?|hsla?)\([\d\s,.%]+\))+$/;
function customStyle(declarations: string) {
  const allowed: Record<string, string> = {
    fill: "fill",
    stroke: "stroke",
    color: "color",
    "stroke-width": "stroke-width",
    "stroke-dasharray": "stroke-dasharray",
  };
  const out: Record<string, string> = {};
  for (const part of declarations.split(/[,;](?![^(]*\))/)) {
    const [name, value] = part.split(":").map((s) => s.trim());
    if (name && value && allowed[name] && SAFE_STYLE_VALUE.test(value)) out[allowed[name]] = value;
  }
  return out;
}

// ---------- Layered layout ----------

type Direction = "TB" | "BT" | "LR" | "RL";
type Point = { x: number; y: number };
type Placed = Point & { width: number; height: number };
type LayoutEdge = {
  from: string;
  to: string;
  minlen?: number;
  label?: { width: number; height: number } | undefined;
};
/** An edge in rank order: it leaves its upper end across rank-axis coordinate `exit`, passes `via`, and enters its lower end across `entry`. */
type Routed = {
  reversed: boolean;
  exit: number;
  entry: number;
  via: Point[];
  label: Point | undefined;
};
type Port = { id: string; side: 1 | -1; hint?: number };
type Layout = {
  nodes: Map<string, Placed>;
  edges: (Routed | null)[];
  ports: Routed[];
  width: number;
  height: number;
};

/** DFS from the sources; an edge back to an open node is reversed. Ranking ignores sizes, so callers may run this ahead of layout. */
function breakCycles(ids: string[], edges: { from: string; to: string }[]) {
  const out = new Map(ids.map((id) => [id, [] as number[]]));
  edges.forEach((e, i) => out.get(e.from)?.push(i));
  const targets = new Set(edges.filter((e) => e.from !== e.to).map((e) => e.to));
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
  for (const id of [...ids.filter((id) => !targets.has(id)), ...ids]) if (!state.has(id)) visit(id);
  return reversed;
}

/**
 * Sugiyama layout. A port is an edge between a member and this graph's boundary (side 1: past the last rank,
 * -1: before the first); it reserves a lane like any long edge, then ends on the boundary, ordered by `hint`.
 */
function layered(
  nodes: { id: string; width: number; height: number }[],
  edges: LayoutEdge[],
  direction: Direction,
  ports: Port[] = [],
  nodeGap = 30,
  rankGap = 50,
): Layout {
  if (!nodes.length)
    return { nodes: new Map(), edges: edges.map(() => null), ports: [], width: 0, height: 0 };
  const horizontal = direction === "LR" || direction === "RL";
  const ids = nodes.map((n) => n.id);
  const size = new Map(
    nodes.map((n) => [
      n.id,
      horizontal ? { along: n.height, across: n.width } : { along: n.width, across: n.height },
    ]),
  );
  const listMap = () => new Map(ids.map((id) => [id, [] as number[]]));
  const reversed = breakCycles(ids, edges);
  const dag = edges.map((e, i) =>
    e.from === e.to
      ? null
      : {
          ...(reversed.has(i) ? { from: e.to, to: e.from } : { from: e.from, to: e.to }),
          minlen: e.minlen ?? 1,
          label: e.label,
        },
  );
  // 2. Longest-path ranks, then each source moves down next to its nearest successor.
  const rank = new Map(ids.map((id) => [id, 0]));
  const succ = listMap();
  const indegree = new Map(ids.map((id) => [id, 0]));
  dag.forEach((e, i) => {
    if (!e) return;
    succ.get(e.from)!.push(i);
    indegree.set(e.to, indegree.get(e.to)! + 1);
  });
  const sources = new Set(ids.filter((id) => !indegree.get(id)));
  const order = [...sources];
  for (let k = 0; k < order.length; k++)
    for (const i of succ.get(order[k]!)!) {
      const e = dag[i]!;
      rank.set(e.to, Math.max(rank.get(e.to)!, rank.get(e.from)! + e.minlen));
      indegree.set(e.to, indegree.get(e.to)! - 1);
      if (!indegree.get(e.to)) order.push(e.to);
    }
  for (const id of sources) {
    const next = succ.get(id)!.map((i) => rank.get(dag[i]!.to)! - dag[i]!.minlen);
    if (next.length) rank.set(id, Math.min(...next));
  }
  const [hasIn, hasOut] = [ports.some((p) => p.side < 0), ports.some((p) => p.side > 0)];
  if (hasIn) for (const id of ids) rank.set(id, rank.get(id)! + 1);
  const last = Math.max(...rank.values()) + 1;
  // 3. Long edges become chains of dummies; the middle one carries, and reserves room for, the label.
  const layerOf = new Map(rank);
  const labelDummy = new Map<number, string>();
  const chains = dag.map((e, i) => {
    if (!e) return [];
    const [r0, r1] = [rank.get(e.from)!, rank.get(e.to)!];
    const chain = [e.from];
    for (let r = r0 + 1; r < r1; r++) {
      const dummy = `\0${i}:${r}`;
      const label = r === Math.floor((r0 + r1) / 2) ? e.label : undefined;
      if (label) labelDummy.set(i, dummy);
      layerOf.set(dummy, r);
      size.set(
        dummy,
        label
          ? horizontal
            ? { along: label.height, across: label.width }
            : { along: label.width, across: label.height }
          : { along: 0, across: 0 },
      );
      chain.push(dummy);
    }
    chain.push(e.to);
    return chain;
  });
  const portChains = ports.map((p, k) => {
    const r = rank.get(p.id)!;
    const boundary = `\0b${k}`;
    layerOf.set(boundary, p.side > 0 ? last : 0);
    const chain = [p.side > 0 ? p.id : boundary];
    for (let q = (p.side > 0 ? r : 0) + 1; q < (p.side > 0 ? last : r); q++) {
      layerOf.set(`\0p${k}:${q}`, q);
      chain.push(`\0p${k}:${q}`);
    }
    chain.push(p.side > 0 ? boundary : p.id);
    return chain;
  });
  for (const id of layerOf.keys()) if (!size.has(id)) size.set(id, { along: 0, across: 0 });
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
    succ.get(id)!.forEach((i) => chains[i]!.forEach(place));
  }
  for (const id of layerOf.keys()) place(id);
  const up = new Map<string, string[]>();
  const down = new Map<string, string[]>();
  const link = (map: Map<string, string[]>, a: string, b: string) =>
    (map.get(a) ?? map.set(a, []).get(a)!).push(b);
  for (const chain of [...chains, ...portChains])
    for (let i = 0; i + 1 < chain.length; i++) {
      link(down, chain[i]!, chain[i + 1]!);
      link(up, chain[i + 1]!, chain[i]!);
    }
  // 4. Barycenter sweeps, keeping the ordering with the fewest crossings. Boundary ranks stay in hint order.
  const fixed = new Set([...(hasIn ? [layers[0]!] : []), ...(hasOut ? [layers[maxRank]!] : [])]);
  for (const layer of fixed)
    layer.sort(
      (a, b) => (ports[Number(a.slice(2))]!.hint ?? 0) - (ports[Number(b.slice(2))]!.hint ?? 0),
    );
  const position = new Map<string, number>();
  const index = () => layers.forEach((layer) => layer.forEach((id, i) => position.set(id, i)));
  const crossings = () => {
    let count = 0;
    for (const layer of layers) {
      const pairs = layer.flatMap((id) =>
        (down.get(id) ?? []).map((n) => [position.get(id)!, position.get(n)!] as const),
      );
      for (let i = 0; i < pairs.length; i++)
        for (let j = i + 1; j < pairs.length; j++)
          if ((pairs[i]![0] - pairs[j]![0]) * (pairs[i]![1] - pairs[j]![1]) < 0) count++;
    }
    return count;
  };
  index();
  let best = layers.map((layer) => layer.slice());
  let fewest = crossings();
  for (let sweep = 0; sweep < 24 && fewest; sweep++) {
    const downward = sweep % 2 === 0;
    for (const layer of downward ? layers.slice(1) : layers.slice(0, -1).reverse()) {
      if (fixed.has(layer)) continue;
      const bary = new Map(
        layer.map((id) => {
          const neighbors = (downward ? up : down).get(id) ?? [];
          return [
            id,
            neighbors.length
              ? neighbors.reduce((s, n) => s + position.get(n)!, 0) / neighbors.length
              : position.get(id)!,
          ];
        }),
      );
      layer.sort((a, b) => bary.get(a)! - bary.get(b)!);
      layer.forEach((id, i) => position.set(id, i));
    }
    const count = crossings();
    if (count < fewest) [fewest, best] = [count, layers.map((layer) => layer.slice())];
  }
  best.forEach((layer, r) => (layers[r] = layer));
  index();
  // 5. Coordinates across each layer: pull toward neighbors, then resolve overlaps in order.
  const x = new Map<string, number>();
  const isPoint = (id: string) => id.startsWith("\0") && !size.get(id)!.across;
  const gapBetween = (a: string, b: string) =>
    (size.get(a)!.along + size.get(b)!.along) / 2 +
    (isPoint(a) && isPoint(b) ? 10 : isPoint(a) || isPoint(b) ? nodeGap / 2 : nodeGap);
  for (const layer of layers) {
    let cursor = 0;
    layer.forEach((id, i) => {
      if (i) cursor += gapBetween(layer[i - 1]!, id);
      x.set(id, cursor);
    });
  }
  const settle = (layer: string[], desired: Map<string, number>) => {
    const left = layer.map((id) => desired.get(id)!);
    for (let i = 1; i < layer.length; i++)
      left[i] = Math.max(left[i]!, left[i - 1]! + gapBetween(layer[i - 1]!, layer[i]!));
    const right = layer.map((id) => desired.get(id)!);
    for (let i = layer.length - 2; i >= 0; i--)
      right[i] = Math.min(right[i]!, right[i + 1]! - gapBetween(layer[i]!, layer[i + 1]!));
    layer.forEach((id, i) => x.set(id, (left[i]! + right[i]!) / 2));
    for (let i = 1; i < layer.length; i++)
      x.set(
        layer[i]!,
        Math.max(x.get(layer[i]!)!, x.get(layer[i - 1]!)! + gapBetween(layer[i - 1]!, layer[i]!)),
      );
  };
  for (let pass = 0; pass < 12; pass++) {
    const downward = pass % 2 === 0;
    for (const layer of downward ? layers : layers.slice().reverse()) {
      const desired = new Map(
        layer.map((id) => {
          const neighbors = [
            ...((downward ? up : down).get(id) ?? []),
            ...(pass > 6 ? ((downward ? down : up).get(id) ?? []) : []),
          ];
          const weight = id.startsWith("\0") ? 4 : 1;
          return [
            id,
            neighbors.length
              ? (x.get(id)! +
                  (weight * neighbors.reduce((s, n) => s + x.get(n)!, 0)) / neighbors.length) /
                (1 + weight)
              : x.get(id)!,
          ];
        }),
      );
      settle(layer, desired);
    }
  }
  // 6. Ranks: room for the deepest member and the labels of edges crossing each gap.
  const gapLabel = new Array<number>(maxRank + 1).fill(0);
  dag.forEach((e, i) => {
    if (!e?.label || labelDummy.has(i)) return;
    const mid = Math.floor((rank.get(e.from)! + rank.get(e.to)!) / 2);
    gapLabel[mid] = Math.max(gapLabel[mid]!, (horizontal ? e.label.width : e.label.height) + 16);
  });
  const rankSize = layers.map((layer) => Math.max(0, ...layer.map((id) => size.get(id)!.across)));
  // The boundary ranks of ports take no room: they sit on the first and last real ranks' outer edges.
  const y: number[] = [];
  let [cursor, gap] = [0, 0];
  rankSize.forEach((s, r) => {
    const boundary = (r === 0 && hasIn) || (r === maxRank && hasOut);
    if (boundary) cursor -= gap;
    y[r] = cursor + s / 2;
    gap = boundary ? 0 : Math.max(rankGap, gapLabel[r]! + 20);
    cursor += s + gap;
  });
  const across = [...x.entries()];
  const left = Math.min(...across.map(([id, value]) => value - size.get(id)!.along / 2));
  const right = Math.max(...across.map(([id, value]) => value + size.get(id)!.along / 2));
  const extentAcross = cursor - gap;
  const map = (along: number, acrossValue: number) => {
    const a = along - left;
    const r = direction === "BT" || direction === "RL" ? extentAcross - acrossValue : acrossValue;
    return horizontal ? { x: r, y: a } : { x: a, y: r };
  };
  const axis = (value: number) => (horizontal ? map(left, value).x : map(left, value).y);
  const edge = (r: number, side: 1 | -1) => y[r]! + (side * rankSize[r]!) / 2;
  const placed = new Map<string, Placed>();
  for (const n of nodes)
    placed.set(n.id, {
      ...map(x.get(n.id)!, y[layerOf.get(n.id)!]!),
      width: n.width,
      height: n.height,
    });
  const route = (chain: string[], label?: string): Routed => ({
    reversed: false,
    exit: axis(edge(layerOf.get(chain[0]!)!, 1)),
    entry: axis(edge(layerOf.get(chain.at(-1)!)!, -1)),
    via: chain
      .slice(1, -1)
      .flatMap((id) => [
        map(x.get(id)!, edge(layerOf.get(id)!, -1)),
        map(x.get(id)!, edge(layerOf.get(id)!, 1)),
      ]),
    label: label === undefined ? undefined : map(x.get(label)!, y[layerOf.get(label)!]!),
  });
  return {
    nodes: placed,
    edges: dag.map(
      (e, i) => e && { ...route(chains[i]!, labelDummy.get(i)), reversed: reversed.has(i) },
    ),
    ports: portChains.map((chain) => route(chain)),
    width: horizontal ? extentAcross : right - left,
    height: horizontal ? right - left : extentAcross,
  };
}

/** Straight runs through ranks; a cubic bend wherever the path changes lanes between them. */
function spline(points: Point[], horizontal: boolean) {
  let d = `M${round(points[0]!.x)},${round(points[0]!.y)}`;
  for (let i = 1; i < points.length; i++) {
    const [p, q] = [points[i - 1]!, points[i]!];
    if (
      Math.abs(horizontal ? q.y - p.y : q.x - p.x) < 0.5 ||
      Math.abs(horizontal ? q.x - p.x : q.y - p.y) < 0.5
    )
      d += ` L${round(q.x)},${round(q.y)}`;
    else if (horizontal)
      d += ` C${round((p.x + q.x) / 2)},${round(p.y)} ${round((p.x + q.x) / 2)},${round(q.y)} ${round(q.x)},${round(q.y)}`;
    else
      d += ` C${round(p.x)},${round((p.y + q.y) / 2)} ${round(q.x)},${round((p.y + q.y) / 2)} ${round(q.x)},${round(q.y)}`;
  }
  return d;
}

// ---------- Graph diagrams: shared scene ----------

type GraphNode = {
  id: string;
  label: Label;
  shape: string;
  width: number;
  height: number;
  style?: Record<string, string>;
  cluster?: string | undefined;
  draw?: (p: Placed) => ElContent[];
};
type GraphEdge = {
  from: string;
  to: string;
  label?: Label | undefined;
  stroke: "solid" | "dotted" | "thick" | "invisible";
  start?: string | undefined;
  end?: string | undefined;
  minlen?: number;
  startLabel?: string;
  endLabel?: string;
};
type Cluster = {
  id: string;
  label: Label;
  parent?: string | undefined;
  direction?: Direction | undefined;
};

const CLUSTER_FONT = FONT - 1;
const CLUSTER_PAD = 14;
const ROUND_SHAPES = new Set(["circle", "doublecircle", "start", "end"]);
const CROWS_FEET = new Set(["one", "zeroOne", "many", "oneMany"]);

/** Compound layout: each cluster is laid out on its own, then placed as one box in its parent, so members stay together. */
function drawGraph(
  ctx: Context,
  nodes: GraphNode[],
  edges: GraphEdge[],
  clusters: Cluster[],
  direction: Direction,
) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const clusterById = new Map(clusters.map((c) => [c.id, c]));
  const ancestors = (id: string) => {
    const out: string[] = [];
    for (
      let c = clusterById.has(id) ? clusterById.get(id)!.parent : byId.get(id)?.cluster;
      c && clusterById.has(c) && !out.includes(c);
      c = clusterById.get(c)!.parent
    )
      out.unshift(c);
    return out;
  };
  const members = new Map<string, string[]>();
  const add = <T>(map: Map<string, T[]>, key: string, value: T) =>
    (map.get(key) ?? map.set(key, []).get(key)!).push(value);
  // Members keep source order (a cluster ranks by its first node), which seeds cycle breaking.
  const first = new Map<string, number>();
  nodes.forEach((n, i) =>
    [n.id, ...ancestors(n.id)].forEach((id) => first.has(id) || first.set(id, i)),
  );
  const ids = [...byId.keys(), ...clusterById.keys()];
  for (const id of ids.sort((a, b) => (first.get(a) ?? Infinity) - (first.get(b) ?? Infinity)))
    add(members, ancestors(id).at(-1) ?? "", id);
  // Each edge is laid out in its endpoints' innermost common cluster, between the members that contain them.
  const levelEdges = new Map<string, LayoutEdge[]>();
  const slots = edges.map((e) => {
    const a = [...ancestors(e.from), e.from];
    const b = [...ancestors(e.to), e.to];
    let k = 0;
    while (k < a.length && k < b.length && a[k] === b[k]) k++;
    if (k === a.length || k === b.length) return undefined;
    const level = a[k - 1] ?? "";
    const ends =
      (e.startLabel || e.endLabel ? 28 : 0) +
      ([e.start, e.end].some((m) => m && CROWS_FEET.has(m)) ? 36 : 0);
    const label =
      e.label || ends
        ? { width: (e.label?.width ?? 0) + 10 + ends, height: (e.label?.height ?? 0) + 4 + ends }
        : undefined;
    add(levelEdges, level, { from: a[k]!, to: b[k]!, minlen: e.minlen ?? 1, label });
    return { level, slot: levelEdges.get(level)!.length - 1 };
  });
  // Ranking ignores sizes, so cycles break top-down first: then each edge knows which end is upstream, and every
  // cluster it crosses gets a port edge that reserves its lane to the cluster boundary.
  const cycles = new Map(
    [...levelEdges].map(([level, list]) => [level, breakCycles(members.get(level) ?? [], list)]),
  );
  const reversed = slots.map((slot) => !!slot && cycles.get(slot.level)!.has(slot.slot));
  const ports = new Map<string, Port[]>();
  const legs = edges.map((e, i) => {
    const slot = slots[i];
    if (!slot) return [];
    return (
      [
        [reversed[i] ? e.to : e.from, 1],
        [reversed[i] ? e.from : e.to, -1],
      ] as const
    ).map(([real, side]) => {
      const chain = [...ancestors(real), real];
      const inner: { cluster: string; slot: number; side: 1 | -1 }[] = [];
      for (let k = chain.indexOf(slot.level) + 1; k < chain.length - 1; k++) {
        add(ports, chain[k]!, { id: chain[k + 1]!, side });
        inner.unshift({ cluster: chain[k]!, slot: ports.get(chain[k]!)!.length - 1, side });
      }
      return inner;
    });
  });
  const titleHeight = (c: Cluster) => (c.label.height ? c.label.height + 8 : 0);
  const levels = new Map<string, { layout: Layout; horizontal: boolean }>();
  const solve = (level: string, inherited: Direction): { width: number; height: number } => {
    const cluster = clusterById.get(level);
    // As in Mermaid, a cluster linked to the outside follows its parent's direction.
    const dir = (!ports.has(level) && cluster?.direction) || inherited;
    const items = (members.get(level) ?? []).map((id) => ({
      id,
      ...(clusterById.has(id)
        ? solve(id, dir)
        : { width: byId.get(id)!.width, height: byId.get(id)!.height }),
    }));
    const layout = layered(items, levelEdges.get(level) ?? [], dir, ports.get(level));
    levels.set(level, { layout, horizontal: dir === "LR" || dir === "RL" });
    return cluster
      ? {
          width: Math.max(layout.width, cluster.label.width) + CLUSTER_PAD * 2,
          height: layout.height + CLUSTER_PAD * 2 + titleHeight(cluster),
        }
      : layout;
  };
  const placed = new Map<string, Placed>();
  const origin = new Map<string, Point>();
  const place = (level: string, ox: number, oy: number) => {
    origin.set(level, { x: ox, y: oy });
    for (const [id, p] of levels.get(level)!.layout.nodes) {
      const q = { x: ox + p.x, y: oy + p.y, width: p.width, height: p.height };
      placed.set(id, q);
      const cluster = clusterById.get(id);
      if (cluster)
        place(
          id,
          q.x - levels.get(id)!.layout.width / 2,
          q.y - q.height / 2 + CLUSTER_PAD + titleHeight(cluster),
        );
    }
  };
  const shift = (level: string) => (p: Point) => ({
    x: p.x + origin.get(level)!.x,
    y: p.y + origin.get(level)!.y,
  });
  // An end runs outward through legs: straight to a rank boundary (`near`), then along its reserved lane (`via`).
  type Leg = { near: number; via: Point[] };
  type End = { id: string; legs: Leg[]; sort: number; offset: number; horizontal: boolean };
  const route = (edge: GraphEdge, i: number) => {
    const slot = slots[i];
    const r = slot && levels.get(slot.level)!.layout.edges[slot.slot];
    if (!slot || !r) return undefined;
    const { horizontal } = levels.get(slot.level)!;
    const along = (level: string) => (horizontal ? origin.get(level)!.x : origin.get(level)!.y);
    const cross = (p: Point) => (horizontal ? p.y : p.x);
    const via = r.via.map(shift(slot.level));
    const [upper, lower] = r.reversed ? [edge.to, edge.from] : [edge.from, edge.to];
    const ends = legs[i]!.map((inner, k) => {
      const outward: Leg[] = inner.map(({ cluster, slot: index, side }) => {
        const port = levels.get(cluster)!.layout.ports[index]!;
        const lane = port.via.map(shift(cluster));
        return side > 0
          ? { near: port.exit + along(cluster), via: lane }
          : { near: port.entry + along(cluster), via: lane.reverse() };
      });
      outward.push({ near: (k ? r.entry : r.exit) + along(slot.level), via: [] });
      return { id: k ? lower : upper, legs: outward, sort: 0, offset: 0, horizontal };
    }) as [End, End];
    const far = (k: 0 | 1) =>
      ends[k].legs.find((leg) => leg.via.length)?.via[0] ??
      (k ? via.at(-1) : via[0]) ??
      placed.get(ends[1 - k]!.id)!;
    [ends[0].sort, ends[1].sort] = [cross(far(0)), cross(far(1))];
    // The next pass orders each crossed cluster's boundary lanes by where their edges head.
    legs[i]!.forEach((inner, k) =>
      inner.forEach(
        ({ cluster, slot: index }) =>
          (ports.get(cluster)![index]!.hint = cross(
            (k ? via.at(-1) : via[0]) ?? placed.get(ends[1 - k]!.id)!,
          )),
      ),
    );
    return {
      horizontal,
      reversed: r.reversed,
      via,
      ends,
      label: r.label && shift(slot.level)(r.label),
    };
  };
  const pass = () => {
    const size = solve("", direction);
    place("", 0, 0);
    return size;
  };
  pass();
  edges.forEach(route);
  const root = pass();
  const routes = edges.map(route);
  const sides = new Map<string, End[]>();
  for (const route of routes)
    for (const end of route?.ends ?? []) {
      const p = placed.get(end.id)!;
      add(
        sides,
        `${end.id}:${end.horizontal}:${end.legs[0]!.near >= (end.horizontal ? p.x : p.y)}`,
        end,
      );
    }
  for (const list of sides.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.sort - b.sort);
    const p = placed.get(list[0]!.id)!;
    const span =
      (list[0]!.horizontal ? p.height : p.width) *
      (ROUND_SHAPES.has(byId.get(list[0]!.id)?.shape ?? "") ? 0.4 : 0.6);
    const step = Math.min(16, span / (list.length - 1));
    list.forEach((end, k) => (end.offset = (k - (list.length - 1) / 2) * step));
  }
  const trace = (end: End): Point[] => {
    const p = placed.get(end.id)!;
    const shape = byId.get(end.id)?.shape ?? "rect";
    const h = end.horizontal;
    const [half, crossHalf, center] = h
      ? [p.width / 2, p.height / 2, p.x]
      : [p.height / 2, p.width / 2, p.y];
    const o = end.offset;
    const depth =
      shape === "diamond"
        ? half * (1 - Math.abs(o) / crossHalf)
        : ROUND_SHAPES.has(shape)
          ? Math.sqrt(Math.max(0, half * half - o * o))
          : half;
    const sign = end.legs[0]!.near >= center ? 1 : -1;
    const points = [
      h ? { x: p.x + sign * depth, y: p.y + o } : { x: p.x + o, y: p.y + sign * depth },
    ];
    for (const leg of end.legs)
      points.push(
        h ? { x: leg.near, y: points.at(-1)!.y } : { x: points.at(-1)!.x, y: leg.near },
        ...leg.via,
      );
    return points;
  };
  const content: ElContent[] = [];
  let [minX, minY, maxX, maxY] = [0, 0, root.width, root.height];
  const extend = (x0: number, y0: number, x1: number, y1: number) =>
    ([minX, minY, maxX, maxY] = [
      Math.min(minX, x0),
      Math.min(minY, y0),
      Math.max(maxX, x1),
      Math.max(maxY, y1),
    ]);
  for (const cluster of clusters
    .slice()
    .sort((a, b) => ancestors(a.id).length - ancestors(b.id).length)) {
    const p = placed.get(cluster.id);
    if (!p) continue;
    const [x0, y0] = [p.x - p.width / 2, p.y - p.height / 2];
    content.push(
      el("rect", {
        x: x0,
        y: y0,
        width: p.width,
        height: p.height,
        rx: 8,
        style: `fill:${C.alt};fill-opacity:0.5;stroke:${C.border};stroke-width:1`,
      }),
      ctx.drawLabel(cluster.label, x0 + CLUSTER_PAD - 2, y0 + 8 + cluster.label.height / 2, {
        anchor: "start",
        color: C.muted,
        size: CLUSTER_FONT,
        bold: true,
      }),
    );
  }
  // A short edge's label rides a straight run beside the end it alone labels; the bend takes the rest of the gap.
  const labeled = new Map<string, number>();
  routes.forEach(
    (route, i) =>
      route &&
      edges[i]!.label &&
      !route.via.length &&
      route.ends.forEach((end, k) =>
        labeled.set(`${k}:${end.id}`, (labeled.get(`${k}:${end.id}`) ?? 0) + 1),
      ),
  );
  const labels: ElContent[] = [];
  edges.forEach((edge, i) => {
    let points: Point[];
    let mid: Point;
    let horizontal = false;
    const route = routes[i];
    if (route) {
      horizontal = route.horizontal;
      const [upper, lower] = [trace(route.ends[0]), trace(route.ends[1])];
      const [exit, entry] = [upper.at(-1)!, lower.at(-1)!];
      const rank = (p: Point) => (horizontal ? p.x : p.y);
      const at = (cross: Point, value: number) =>
        horizontal ? { x: value, y: cross.y } : { x: cross.x, y: value };
      const span = rank(entry) - rank(exit);
      const len = edge.label ? (horizontal ? edge.label.width : edge.label.height) + 10 : 0;
      const room = Math.abs(span) - len - 8;
      const side =
        !edge.label || route.via.length || room < 16
          ? -1
          : labeled.get(`1:${route.ends[1].id}`) === 1
            ? 1
            : labeled.get(`0:${route.ends[0].id}`) === 1
              ? 0
              : -1;
      const bend =
        side === 1
          ? [at(entry, rank(exit) + Math.sign(span) * room)]
          : side === 0
            ? [at(exit, rank(exit) + Math.sign(span) * len)]
            : [];
      points = [...upper, ...bend, ...route.via, ...lower.reverse()].filter(
        (p, k, all) => !k || Math.hypot(p.x - all[k - 1]!.x, p.y - all[k - 1]!.y) > 0.5,
      );
      if (route.reversed) points.reverse();
      mid =
        route.label ??
        (side === 1
          ? at(entry, rank(entry) - Math.sign(span) * (len / 2 + 8))
          : side === 0
            ? at(exit, rank(exit) + (Math.sign(span) * len) / 2)
            : { x: (exit.x + entry.x) / 2, y: (exit.y + entry.y) / 2 });
    } else {
      // A self-loop leaves and re-enters the node's side that faces across the ranks.
      const p = placed.get(edge.from);
      if (!p || edge.from !== edge.to) return;
      horizontal = levels.get(ancestors(edge.from).at(-1) ?? "")!.horizontal;
      const reach = 26 + (edge.label ? (horizontal ? edge.label.height : edge.label.width) + 8 : 0);
      if (horizontal) {
        const top = p.y - p.height / 2;
        points = [
          { x: p.x - 8, y: top },
          { x: p.x + 8, y: top },
        ];
        content.push(
          el("path", {
            d: `M${round(p.x - 8)},${round(top)} C${round(p.x - 20)},${round(top - 30)} ${round(p.x + 20)},${round(top - 30)} ${round(p.x + 8)},${round(top)}`,
            style: `fill:none;stroke:${C.line};stroke-width:1.25`,
            "marker-end": edge.end ? ctx.marker(edge.end as MarkerName) : undefined,
          }),
        );
        mid = { x: p.x, y: top - 30 - (edge.label?.height ?? 0) / 2 };
        extend(p.x - 24, top - reach - 8, p.x + 24, top);
      } else {
        const side = p.x + p.width / 2;
        points = [
          { x: side, y: p.y - 8 },
          { x: side, y: p.y + 8 },
        ];
        content.push(
          el("path", {
            d: `M${round(side)},${round(p.y - 8)} C${round(side + 30)},${round(p.y - 20)} ${round(side + 30)},${round(p.y + 20)} ${round(side)},${round(p.y + 8)}`,
            style: `fill:none;stroke:${C.line};stroke-width:1.25`,
            "marker-end": edge.end ? ctx.marker(edge.end as MarkerName) : undefined,
          }),
        );
        mid = { x: side + 30 + (edge.label?.width ?? 0) / 2, y: p.y };
        extend(side, p.y - 24, side + reach + 8, p.y + 24);
      }
    }
    if (edge.stroke === "invisible") return;
    if (route) {
      const dash = edge.stroke === "dotted" ? ";stroke-dasharray:3 4" : "";
      content.push(
        el("path", {
          d: spline(points, horizontal),
          style: `fill:none;stroke:${C.line};stroke-width:${edge.stroke === "thick" ? 2.5 : 1.25}${dash}`,
          "marker-start": edge.start ? ctx.marker(edge.start as MarkerName) : undefined,
          "marker-end": edge.end ? ctx.marker(edge.end as MarkerName) : undefined,
        }),
      );
    }
    if (edge.label) {
      const [w, h] = [edge.label.width + 10, edge.label.height + 4];
      labels.push(
        el("rect", {
          x: mid.x - w / 2,
          y: mid.y - h / 2,
          width: w,
          height: h,
          rx: 4,
          style: `fill:${C.bg}`,
        }),
        ctx.drawLabel(edge.label, mid.x, mid.y, { size: FONT - 1 }),
      );
      extend(mid.x - w / 2, mid.y - h / 2, mid.x + w / 2, mid.y + h / 2);
    }
    for (const [value, end, next] of [
      [edge.startLabel, points[0], points[1]],
      [edge.endLabel, points.at(-1), points.at(-2)],
    ] as const) {
      if (!value || !end || !next) continue;
      const length = Math.hypot(next.x - end.x, next.y - end.y) || 1;
      const [ux, uy] = [(next.x - end.x) / length, (next.y - end.y) / length];
      labels.push(
        ctx.drawLabel(
          ctx.label(value, FONT - 2),
          end.x + ux * 18 - uy * 10,
          end.y + uy * 18 + ux * 10,
          { size: FONT - 2, color: C.muted },
        ),
      );
    }
  });
  content.push(...labels);
  for (const node of nodes) {
    const p = placed.get(node.id);
    if (p) content.push(...(node.draw ? node.draw(p) : drawShape(ctx, node, p)));
  }
  return {
    content: [el("g", { transform: `translate(${round(-minX)},${round(-minY)})` }, content)],
    width: maxX - minX,
    height: maxY - minY,
  };
}

function drawShape(ctx: Context, node: GraphNode, p: Placed): ElContent[] {
  const { x, y, width: w, height: h } = p;
  const [l, t, r, b] = [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
  const s = node.style ?? {};
  const style = `fill:${s.fill ?? C.surface};stroke:${s.stroke ?? C.border};stroke-width:${s["stroke-width"] ?? "1"}${s["stroke-dasharray"] ? `;stroke-dasharray:${s["stroke-dasharray"]}` : ""}`;
  const poly = (points: number[][]) =>
    el("polygon", {
      points: points.map(([px, py]) => `${round(px!)},${round(py!)}`).join(" "),
      style,
    });
  const k = (h * 0.3) | 0;
  const shapes: Record<string, () => ElElement[]> = {
    rect: () => [el("rect", { x: l, y: t, width: w, height: h, rx: 5, style })],
    round: () => [el("rect", { x: l, y: t, width: w, height: h, rx: 12, style })],
    stadium: () => [el("rect", { x: l, y: t, width: w, height: h, rx: h / 2, style })],
    subroutine: () => [
      el("rect", { x: l, y: t, width: w, height: h, rx: 3, style }),
      el("path", {
        d: `M${l + 8},${t} V${b} M${r - 8},${t} V${b}`,
        style: `fill:none;stroke:${s.stroke ?? C.border}`,
      }),
    ],
    cylinder: () => {
      const ry = Math.min(8, h / 6);
      return [
        el("path", {
          d: `M${l},${t + ry} A${w / 2},${ry} 0 0,1 ${r},${t + ry} V${b - ry} A${w / 2},${ry} 0 0,1 ${l},${b - ry} Z M${l},${t + ry} A${w / 2},${ry} 0 0,0 ${r},${t + ry}`,
          style,
        }),
      ];
    },
    circle: () => [el("circle", { cx: x, cy: y, r: w / 2, style })],
    doublecircle: () => [
      el("circle", { cx: x, cy: y, r: w / 2, style }),
      el("circle", { cx: x, cy: y, r: w / 2 - 4, style }),
    ],
    asymmetric: () => [
      poly([
        [l, t],
        [r, t],
        [r, b],
        [l, b],
        [l + k, y],
      ]),
    ],
    diamond: () => [
      poly([
        [x, t],
        [r, y],
        [x, b],
        [l, y],
      ]),
    ],
    hexagon: () => [
      poly([
        [l + k, t],
        [r - k, t],
        [r, y],
        [r - k, b],
        [l + k, b],
        [l, y],
      ]),
    ],
    parallelogram: () => [
      poly([
        [l + k, t],
        [r, t],
        [r - k, b],
        [l, b],
      ]),
    ],
    parallelogramAlt: () => [
      poly([
        [l, t],
        [r - k, t],
        [r, b],
        [l + k, b],
      ]),
    ],
    trapezoid: () => [
      poly([
        [l + k, t],
        [r - k, t],
        [r, b],
        [l, b],
      ]),
    ],
    trapezoidAlt: () => [
      poly([
        [l, t],
        [r, t],
        [r - k, b],
        [l + k, b],
      ]),
    ],
  };
  const drawn = (shapes[node.shape] ?? shapes.rect!)();
  const underlay = drawn.map((shape) => ({
    ...shape,
    properties: { ...shape.properties, style: `fill:${C.bg};stroke:none` },
  }));
  return [
    ...underlay,
    ...drawn,
    ctx.drawLabel(node.label, x, y, { color: s.color ?? contrastText(s.fill) }),
  ];
}

/** Dark or light text for a custom hex fill, so a pastel `classDef` stays readable in either theme. */
function contrastText(fill: string | undefined) {
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(fill ?? "")?.[1];
  if (!hex) return undefined;
  const [r, g, b] = (hex.length === 3 ? [...hex].map((c) => c + c) : hex.match(/../g)!).map(
    (c) => parseInt(c, 16) / 255,
  );
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.55 ? "#1f1f1f" : "#f5f5f5";
}

function sizeFor(shape: string, label: Label) {
  const [w, h] = [label.width + 32, label.height + 20];
  if (shape === "circle" || shape === "doublecircle") {
    const d = Math.hypot(label.width, label.height) + 16 + (shape === "doublecircle" ? 8 : 0);
    return { width: d, height: d };
  }
  if (shape === "diamond")
    return {
      width: Math.max(label.width + label.height * 2 + 20, 56),
      height: Math.max(label.height * 2 + 24, 44),
    };
  if (shape === "hexagon" || shape.startsWith("parallelogram") || shape.startsWith("trapezoid"))
    return { width: w + h * 0.6, height: h };
  return { width: Math.max(w, 48), height: h };
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
const NEW_SHAPES: Record<string, string> = {
  rect: "rect",
  rounded: "round",
  stadium: "stadium",
  subproc: "subroutine",
  cyl: "cylinder",
  circle: "circle",
  "dbl-circ": "doublecircle",
  diam: "diamond",
  diamond: "diamond",
  hex: "hexagon",
  lean_r: "parallelogram",
  "lean-r": "parallelogram",
  lean_l: "parallelogramAlt",
  "lean-l": "parallelogramAlt",
  trap_b: "trapezoid",
  "trap-b": "trapezoid",
  trap_t: "trapezoidAlt",
  "trap-t": "trapezoidAlt",
};
const ID = /^[\p{L}\p{N}_](?:[\p{L}\p{N}_.]|-(?![-.>=ox]))*/u;
const ARROW = /^\s*([<ox])?(-{2,}|={2,}|-\.+-|~{3,})([>ox])?(?:\|([^|]*)\|)?\s*/;
const LABELED = /^\s*([<ox])?(--|==|-\.)\s+(.+?)\s+(-{2,}|={2,}|\.+-)([>ox])?(?=[\s\w"])\s*/u;
const END_MARKERS: Record<string, string> = { ">": "arrow", "<": "arrow", o: "circle", x: "cross" };

function flowchart(lines: string[], ctx: Context) {
  const direction = (/^(?:flowchart|graph)\s+(TB|TD|BT|LR|RL)/
    .exec(lines[0]!)?.[1]
    ?.replace("TD", "TB") ?? "TB") as Direction;
  const nodes = new Map<
    string,
    { label: string; shape: string; cluster?: string | undefined; classes: string[] }
  >();
  const edges: {
    from: string;
    to: string;
    label?: string | undefined;
    stroke: GraphEdge["stroke"];
    start?: string | undefined;
    end?: string | undefined;
    minlen: number;
  }[] = [];
  const clusters: {
    id: string;
    label: string;
    parent?: string | undefined;
    direction?: Direction;
  }[] = [];
  const classDefs = new Map<string, Record<string, string>>();
  const styles = new Map<string, Record<string, string>>();
  const stack: string[] = [];
  const touch = (id: string) => {
    if (!nodes.has(id))
      nodes.set(id, { label: id, shape: "rect", cluster: stack.at(-1), classes: [] });
    const node = nodes.get(id)!;
    // A node referenced inside a subgraph moves into it, as Mermaid does.
    if (stack.length && !stack.includes(node.cluster ?? "\0")) node.cluster = stack.at(-1);
    return node;
  };
  const statements = lines
    .flatMap((line) => line.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/))
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(1);
  for (const statement of statements) {
    let m: RegExpExecArray | null;
    if ((m = /^subgraph\s+(.*)$/.exec(statement))) {
      const spec = m[1]!.trim();
      const titled = /^([^\s[]+)\s*\[(.*)\]$/.exec(spec);
      const id = titled
        ? titled[1]!
        : /^"/.test(spec)
          ? `cluster${clusters.length}`
          : spec.split(/\s+/)[0]!;
      const label = titled ? titled[2]! : spec;
      clusters.push({ id, label, parent: stack.at(-1) });
      stack.push(id);
      continue;
    }
    if (statement === "end") {
      stack.pop();
      continue;
    }
    if ((m = /^direction\s+(TB|TD|BT|LR|RL)$/.exec(statement))) {
      const cluster = clusters.find((c) => c.id === stack.at(-1));
      if (cluster) cluster.direction = m[1]!.replace("TD", "TB") as Direction;
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
            const candidates = SHAPES.filter(([open]) => open === shape[0])
              .map(([, close]) => [body.indexOf(close), close] as const)
              .filter(([i]) => i >= 0);
            const best = candidates.sort((a, b) => a[0] - b[0])[0];
            end = best ? best[0] : -1;
            label = body.slice(0, Math.max(0, end));
          }
          if (end < 0) throw new Error(`Unclosed node shape for "${id}"`);
          const close = SHAPES.find(
            ([open, closer]) => open === shape[0] && body.startsWith(closer, end),
          )!;
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
      const stroke: GraphEdge["stroke"] = body.includes("~")
        ? "invisible"
        : body.includes(".")
          ? "dotted"
          : body.includes("=")
            ? "thick"
            : "solid";
      const startMark = match[1];
      const endMark = labeled ? labeled[5] : arrow![3];
      const label = labeled ? labeled[3] : arrow![4];
      // `-.->` spans one rank and each extra dot adds one; dashes and `=` count past the first.
      const minlen = Math.max(
        1,
        labeled
          ? body.length - 3
          : body.includes(".")
            ? body.replace(/[^.]/g, "").length
            : body.length - 1,
      );
      const to = group();
      for (const a of from)
        for (const b of to)
          edges.push({
            from: a,
            to: b,
            label,
            stroke,
            start: startMark ? END_MARKERS[startMark] : undefined,
            end: endMark ? END_MARKERS[endMark] : undefined,
            minlen,
          });
      from = to;
    }
  }
  // An edge may name a subgraph, which then stands for its box rather than a node.
  const graphNodes: GraphNode[] = [...nodes]
    .filter(([id]) => !clusters.some((c) => c.id === id))
    .map(([id, node]) => {
      const label = ctx.label(node.label);
      const style = Object.assign(
        {},
        ...node.classes.map((c) => classDefs.get(c) ?? {}),
        styles.get(id) ?? {},
      ) as Record<string, string>;
      return {
        id,
        label,
        shape: node.shape,
        style,
        cluster: node.cluster,
        ...sizeFor(node.shape, label),
      };
    });
  return drawGraph(
    ctx,
    graphNodes,
    edges.map((e) => ({ ...e, label: e.label ? ctx.label(e.label, FONT - 1) : undefined })),
    clusters.map((c) => ({ ...c, label: ctx.label(c.label, CLUSTER_FONT, true) })),
    direction,
  );
}

function closerFor(after: string, shape: [string, string, string]) {
  const trimmed = after.trimStart();
  return (
    SHAPES.find(([open, close]) => open === shape[0] && trimmed.startsWith(close))?.[1] ?? shape[1]
  );
}

// ---------- stateDiagram ----------

function stateDiagram(lines: string[], ctx: Context) {
  let direction: Direction = "TB";
  const states = new Map<
    string,
    { label: string; descriptions: string[]; kind: string; cluster?: string | undefined }
  >();
  const edges: GraphEdge[] = [];
  const clusters: Cluster[] = [];
  const stack: string[] = [];
  const resolve = (raw: string, role: "from" | "to") => {
    if (raw !== "[*]") return touch(raw);
    const scope = stack.at(-1) ?? "root";
    const id = `${scope}:${role === "from" ? "start" : "end"}`;
    if (!states.has(id))
      states.set(id, {
        label: "",
        descriptions: [],
        kind: role === "from" ? "start" : "end",
        cluster: stack.at(-1),
      });
    return id;
  };
  const touch = (id: string) => {
    if (!states.has(id))
      states.set(id, { label: id, descriptions: [], kind: "state", cluster: stack.at(-1) });
    return id;
  };
  for (const line of lines.slice(1)) {
    let m: RegExpExecArray | null;
    if ((m = /^direction\s+(TB|TD|BT|LR|RL)/.exec(line))) {
      const cluster = clusters.find((c) => c.id === stack.at(-1));
      if (cluster) cluster.direction = m[1]!.replace("TD", "TB") as Direction;
      else direction = m[1]!.replace("TD", "TB") as Direction;
    } else if ((m = /^state\s+"([^"]+)"\s+as\s+(\S+)(?:\s*\{)?$/.exec(line))) {
      touch(m[2]!);
      states.get(m[2]!)!.label = m[1]!;
      if (line.endsWith("{")) {
        clusters.push({
          id: m[2]!,
          label: ctx.label(m[1]!, CLUSTER_FONT, true),
          parent: stack.at(-1),
        });
        stack.push(m[2]!);
      }
    } else if ((m = /^state\s+(\S+)\s+<<(fork|join|choice)>>/.exec(line))) {
      touch(m[1]!);
      states.get(m[1]!)!.kind = m[2]!;
    } else if ((m = /^state\s+(\S+)\s*\{$/.exec(line))) {
      clusters.push({
        id: m[1]!,
        label: ctx.label(m[1]!, CLUSTER_FONT, true),
        parent: stack.at(-1),
      });
      stack.push(m[1]!);
    } else if (line === "}") stack.pop();
    else if ((m = /^(\S+)\s*(-->)\s*(\S+?)(?:\s*:\s*(.*))?$/.exec(line))) {
      const from = resolve(m[1]!, "from");
      const to = resolve(m[3]!, "to");
      edges.push({
        from,
        to,
        label: m[4] ? ctx.label(m[4], FONT - 1) : undefined,
        stroke: "solid",
        end: "arrow",
      });
    } else if ((m = /^state\s+(\S+)$/.exec(line))) touch(m[1]!);
    else if ((m = /^(\S+)\s*:\s*(.+)$/.exec(line))) {
      const id = touch(m[1]!);
      const state = states.get(id)!;
      if (state.label === id && !state.descriptions.length) state.label = m[2]!;
      else state.descriptions.push(m[2]!);
    } else if (
      /^(note|end note|--|classDef|class|hide|scale)\b/.test(line) ||
      /^note\b/i.test(line)
    )
      continue;
  }
  // Composite states with members are clusters, which edges may target directly.
  const composite = new Set(
    clusters.filter((c) => [...states.values()].some((s) => s.cluster === c.id)).map((c) => c.id),
  );
  const nodes: GraphNode[] = [...states]
    .filter(([id]) => !composite.has(id))
    .map(([id, s]) => {
      if (s.kind === "start")
        return {
          id,
          label: ctx.label(""),
          shape: "start",
          width: 18,
          height: 18,
          cluster: s.cluster,
          draw: (p: Placed) => [el("circle", { cx: p.x, cy: p.y, r: 9, style: `fill:${C.fg}` })],
        };
      if (s.kind === "end")
        return {
          id,
          label: ctx.label(""),
          shape: "end",
          width: 20,
          height: 20,
          cluster: s.cluster,
          draw: (p: Placed) => [
            el("circle", {
              cx: p.x,
              cy: p.y,
              r: 10,
              style: `fill:${C.bg};stroke:${C.fg};stroke-width:1.5`,
            }),
            el("circle", { cx: p.x, cy: p.y, r: 5.5, style: `fill:${C.fg}` }),
          ],
        };
      if (s.kind === "fork" || s.kind === "join") {
        const horizontal = direction === "LR" || direction === "RL";
        return {
          id,
          label: ctx.label(""),
          shape: "rect",
          width: horizontal ? 8 : 70,
          height: horizontal ? 70 : 8,
          cluster: s.cluster,
          draw: (p: Placed) => [
            el("rect", {
              x: p.x - p.width / 2,
              y: p.y - p.height / 2,
              width: p.width,
              height: p.height,
              rx: 2,
              style: `fill:${C.fg}`,
            }),
          ],
        };
      }
      if (s.kind === "choice")
        return {
          id,
          label: ctx.label(""),
          shape: "diamond",
          width: 26,
          height: 26,
          cluster: s.cluster,
        };
      const title = ctx.label(s.label);
      const description = s.descriptions.length
        ? ctx.label(s.descriptions.join("\n"), FONT - 1)
        : null;
      const width = Math.max(title.width, description?.width ?? 0) + 32;
      const height = title.height + 20 + (description ? description.height + 10 : 0);
      return {
        id,
        label: title,
        shape: "round",
        width: Math.max(width, 50),
        height,
        cluster: s.cluster,
        draw: (p: Placed) => {
          const top = p.y - p.height / 2;
          const out: ElContent[] = card(p.x - p.width / 2, top, p.width, p.height, 10);
          out.push(ctx.drawLabel(title, p.x, top + 10 + title.height / 2));
          if (description) {
            out.push(
              el("path", {
                d: `M${p.x - p.width / 2},${top + title.height + 15} H${p.x + p.width / 2}`,
                style: `stroke:${C.border}`,
              }),
            );
            out.push(
              ctx.drawLabel(description, p.x, top + title.height + 20 + description.height / 2, {
                size: FONT - 1,
                color: C.muted,
              }),
            );
          }
          return out;
        },
      };
    });
  const known = new Set([...nodes.map((n) => n.id), ...composite]);
  return drawGraph(
    ctx,
    nodes,
    edges.filter((e) => known.has(e.from) && known.has(e.to)),
    clusters.filter((c) => composite.has(c.id)),
    direction,
  );
}

// ---------- classDiagram ----------

const CLASS_RELATION =
  /^(\S+?)\s*(?:"([^"]*)"\s*)?(<\|--|<\|\.\.|\*--|o--|<--|<\.\.|--\|>|\.\.\|>|--\*|--o|-->|\.\.>|--|\.\.)\s*(?:"([^"]*)"\s*)?(\S+?)(?:\s*:\s*(.*))?$/;
function classDiagram(lines: string[], ctx: Context) {
  let direction: Direction = "TB";
  const classes = new Map<
    string,
    { label: string; annotation?: string; attributes: string[]; methods: string[] }
  >();
  const relations: GraphEdge[] = [];
  const touch = (raw: string) => {
    const id = raw.replace(/~.*~$/, "");
    if (!classes.has(id))
      classes.set(id, { label: raw.replace(/~([^~]*)~/g, "<$1>"), attributes: [], methods: [] });
    return classes.get(id)!;
  };
  const member = (target: ReturnType<typeof touch>, raw: string) => {
    const value = raw.trim();
    if (!value) return;
    if (/^<<.*>>$/.test(value)) target.annotation = value;
    else
      (value.includes("(") ? target.methods : target.attributes).push(
        value.replace(/~([^~]*)~/g, "<$1>"),
      );
  };
  let open: ReturnType<typeof touch> | null = null;
  for (const line of lines.slice(1)) {
    let m: RegExpExecArray | null;
    if (open) {
      if (line === "}") open = null;
      else member(open, line);
      continue;
    }
    if ((m = /^direction\s+(TB|TD|BT|LR|RL)/.exec(line)))
      direction = m[1]!.replace("TD", "TB") as Direction;
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
        "<|--": ["triangle", undefined],
        "<|..": ["triangle", undefined],
        "*--": ["filledDiamond", undefined],
        "o--": ["diamond", undefined],
        "<--": ["open", undefined],
        "<..": ["open", undefined],
        "--|>": [undefined, "triangle"],
        "..|>": [undefined, "triangle"],
        "--*": [undefined, "filledDiamond"],
        "--o": [undefined, "diamond"],
        "-->": [undefined, "open"],
        "..>": [undefined, "open"],
        "--": [undefined, undefined],
        "..": [undefined, undefined],
      };
      const [start, end] = markers[op!]!;
      relations.push({
        from: left!.replace(/~.*~$/, ""),
        to: right!.replace(/~.*~$/, ""),
        stroke: op!.includes(".") ? "dotted" : "solid",
        start,
        end,
        label: label ? ctx.label(label, FONT - 1) : undefined,
        ...(leftCard ? { startLabel: leftCard } : {}),
        ...(rightCard ? { endLabel: rightCard } : {}),
      });
    } else if ((m = /^(\S+)\s*:\s*(.+)$/.exec(line))) member(touch(m[1]!), m[2]!);
  }
  const nodes: GraphNode[] = [...classes].map(([id, c]) => {
    const title = ctx.label(c.label, FONT, true);
    const annotation = c.annotation ? ctx.label(c.annotation, FONT - 2) : null;
    const attributes = c.attributes.map((a) => ctx.label(a, FONT - 1));
    const methods = c.methods.map((a) => ctx.label(a, FONT - 1));
    const width =
      Math.max(
        title.width,
        annotation?.width ?? 0,
        ...attributes.map((a) => a.width),
        ...methods.map((a) => a.width),
      ) + 24;
    const header = title.height + (annotation ? annotation.height : 0) + 12;
    const section = (items: Label[]) =>
      items.length ? items.reduce((s, l) => s + l.height, 0) + 8 : 10;
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
        const out: ElContent[] = card(l, y, p.width, p.height, 5);
        if (annotation) {
          out.push(
            ctx.drawLabel(annotation, p.x, y + 6 + annotation.height / 2, {
              size: FONT - 2,
              color: C.muted,
            }),
          );
          y += annotation.height;
        }
        out.push(ctx.drawLabel(title, p.x, y + 6 + title.height / 2, { bold: true }));
        y += title.height + 12;
        for (const items of [attributes, methods]) {
          out.push(el("path", { d: `M${l},${y} H${l + p.width}`, style: `stroke:${C.border}` }));
          let top = y + 4;
          for (const item of items) {
            out.push(
              ctx.drawLabel(item, l + 10, top + item.height / 2, {
                anchor: "start",
                size: FONT - 1,
              }),
            );
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

const ER_RELATION =
  /^(\S+?)\s*([|}][|o]|[|o][|{])(--|\.\.)([|o][|{]|[|}][|o])\s*(\S+?)\s*:\s*(.+)$/;
const ER_MARKERS: Record<string, string> = {
  "||": "one",
  "|o": "zeroOne",
  "o|": "zeroOne",
  "}o": "many",
  "o{": "many",
  "}|": "oneMany",
  "|{": "oneMany",
};
function erDiagram(lines: string[], ctx: Context) {
  let direction: Direction = "TB";
  const entities = new Map<string, { label: string; attributes: string[][] }>();
  const relations: GraphEdge[] = [];
  const touch = (raw: string) => {
    const alias = /^([\w-]+)\[(.+)\]$/.exec(raw);
    const id = alias ? alias[1]! : raw;
    if (!entities.has(id))
      entities.set(id, { label: alias ? cleanLabel(alias[2]!) : id, attributes: [] });
    return entities.get(id)!;
  };
  let open: ReturnType<typeof touch> | null = null;
  for (const line of lines.slice(1)) {
    let m: RegExpExecArray | null;
    if (open) {
      if (line === "}") open = null;
      else if (
        (m = /^(\S+)\s+(\S+)(?:\s+((?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*))?(?:\s+"([^"]*)")?$/.exec(
          line,
        ))
      )
        open.attributes.push([m[1]!, m[2]!, m[3] ?? "", m[4] ?? ""]);
      continue;
    }
    if ((m = /^direction\s+(TB|TD|BT|LR|RL)/.exec(line)))
      direction = m[1]!.replace("TD", "TB") as Direction;
    else if ((m = /^(\S+?)\s*\{$/.exec(line))) open = touch(m[1]!);
    else if ((m = ER_RELATION.exec(line))) {
      const [, left, leftCard, line_, rightCard, right, label] = m;
      touch(left!);
      touch(right!);
      relations.push({
        from: left!.replace(/\[.*\]$/, ""),
        to: right!.replace(/\[.*\]$/, ""),
        stroke: line_ === ".." ? "dotted" : "solid",
        start: ER_MARKERS[leftCard!],
        end: ER_MARKERS[rightCard!],
        label: ctx.label(label!.replace(/^"|"$/g, ""), FONT - 1),
      });
    } else if ((m = /^(\S+)$/.exec(line))) touch(m[1]!);
  }
  const nodes: GraphNode[] = [...entities].map(([id, e]) => {
    const title = ctx.label(e.label, FONT, true);
    const columns = [0, 1, 2, 3].map((c) =>
      Math.max(0, ...e.attributes.map((a) => (a[c] ? ctx.measure(a[c]!, FONT - 1) + 16 : 0))),
    );
    const row = LINE + 8;
    const width = Math.max(title.width + 32, columns.reduce((s, c) => s + c, 0) + 12, 90);
    const height = title.height + 16 + e.attributes.length * row;
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
          ...card(l, t, p.width, p.height, 5),
          el("path", {
            d: `M${l + 0.5},${t + title.height + 16} V${t + 5} a4.5,4.5 0 0,1 4.5,-4.5 H${l + p.width - 5} a4.5,4.5 0 0,1 4.5,4.5 V${t + title.height + 16} Z`,
            style: `fill:${C.alt};stroke:none`,
          }),
          ...(e.attributes.length
            ? [
                el("path", {
                  d: `M${l},${t + title.height + 16} H${l + p.width}`,
                  style: `stroke:${C.border}`,
                }),
              ]
            : []),
          ctx.drawLabel(title, p.x, e.attributes.length ? t + 8 + title.height / 2 : p.y, {
            bold: true,
          }),
        ];
        e.attributes.forEach((attribute, r) => {
          const y = t + title.height + 16 + r * row;
          if (r % 2)
            out.push(
              el("rect", {
                x: l + 1,
                y,
                width: p.width - 2,
                height: row,
                style: `fill:${C.alt};fill-opacity:0.5`,
              }),
            );
          let x = l + 10;
          attribute.forEach((cell, c) => {
            if (cell)
              out.push(
                el(
                  "text",
                  {
                    x,
                    y: y + row / 2 + (FONT - 1) * 0.35,
                    style: `fill:${c === 0 || c === 3 ? C.muted : C.fg};font-size:${FONT - 1}px`,
                  },
                  [text(cell)],
                ),
              );
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
  | {
      kind: "message";
      from: string;
      to: string;
      text: string;
      dashed: boolean;
      head: "arrow" | "open" | "cross" | "none";
      both: boolean;
      activate?: boolean;
      deactivate?: boolean;
    }
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
  // `box` groups participants rather than messages, so its `end` closes nothing drawn.
  const open: string[] = [];
  const touch = (id: string) => {
    if (!actors.has(id)) actors.set(id, { label: id, actor: false });
    return id;
  };
  for (const line of lines.slice(1)) {
    let m: RegExpExecArray | null;
    if ((m = /^(?:create\s+)?(participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/.exec(line))) {
      actors.set(m[2]!, { label: m[3] ?? m[2]!, actor: m[1] === "actor" });
    } else if (line === "autonumber" || line.startsWith("autonumber ")) autonumber = true;
    else if ((m = /^title\s*:?\s*(.+)$/.exec(line))) title = m[1]!;
    else if ((m = /^(activate|deactivate)\s+(.+)$/.exec(line)))
      events.push({ kind: "activate", actor: touch(m[2]!), on: m[1] === "activate" });
    else if ((m = /^note\s+(left of|right of|over)\s+([^:]+):\s*(.*)$/i.exec(line))) {
      events.push({
        kind: "note",
        at: m[2]!.split(",").map((a) => touch(a.trim())),
        side: m[1]!.split(" ")[0]!.toLowerCase() as "left",
        text: m[3]!,
      });
    } else if ((m = /^(loop|alt|opt|par|critical|break|rect|box)\b\s*(.*)$/.exec(line))) {
      open.push(m[1]!);
      if (m[1] !== "box")
        events.push({ kind: "block", type: m[1]!, text: m[1] === "rect" ? "" : m[2]! });
    } else if ((m = /^(else|and|option)\b\s*(.*)$/.exec(line)))
      events.push({ kind: "divider", text: m[2]! });
    else if (line === "end") {
      if (open.pop() !== "box") events.push({ kind: "end" });
    } else if (
      (m = /^([^-+<>]+?)\s*(<<)?(-{1,2})(>>|>|x|\)|)\s*([+-]?)\s*([^:]+?)\s*:\s*(.*)$/.exec(line))
    ) {
      const [, from, both, dashes, head, mark, to, message] = m;
      events.push({
        kind: "message",
        from: touch(from!.trim()),
        to: touch(to!.trim()),
        text: message!,
        dashed: dashes === "--",
        // `->` and `-->` are bare lines; `-)` is the open async head.
        head: head === ">>" ? "arrow" : head === "x" ? "cross" : head === ")" ? "open" : "none",
        both: !!both,
        ...(mark === "+" ? { activate: true } : mark === "-" ? { deactivate: true } : {}),
      });
    } else if (/^(destroy|links?|properties|details)\b/.test(line)) continue;
    else throw new Error(`Unexpected "${line.slice(0, 30)}" in sequence diagram`);
  }
  const ids = [...actors.keys()];
  const labels = new Map(ids.map((id) => [id, ctx.label(actors.get(id)!.label)]));
  const boxWidth = (id: string) => Math.max(labels.get(id)!.width + 32, 76);
  // Spacing between neighbors grows to fit the widest message between them.
  const gaps = ids.slice(1).map((id, i) => (boxWidth(ids[i]!) + boxWidth(id)) / 2 + 32);
  const order = new Map(ids.map((id, i) => [id, i]));
  for (const event of events) {
    if (event.kind !== "message") continue;
    const a = order.get(event.from)!;
    const b = order.get(event.to)!;
    const width = ctx.label((autonumber ? "00. " : "") + event.text, FONT - 1).width + 32;
    if (a === b) {
      if (a < gaps.length) gaps[a] = Math.max(gaps[a]!, width + 40);
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
  let width = cursor + boxWidth(ids.at(-1) ?? "") / 2;
  let left = 0;
  const content: ElContent[] = [];
  const titleLabel = title ? ctx.label(title, FONT + 2, true) : null;
  let y = titleLabel ? titleLabel.height + 14 : 0;
  if (titleLabel)
    content.push(
      ctx.drawLabel(titleLabel, width / 2, titleLabel.height / 2, { size: FONT + 2, bold: true }),
    );
  const headerHeight = Math.max(0, ...[...labels.values()].map((l) => l.height)) + 22;
  const top = y;
  y += headerHeight + 18;
  const lifelines: ElContent[] = [];
  const foreground: ElContent[] = [];
  const blocks: {
    type: string;
    text: string;
    start: number;
    dividers: { y: number; text: string }[];
    x0: number;
    x1: number;
  }[] = [];
  const frames: ElContent[] = [];
  const activations = new Map<string, number[]>();
  const activationBoxes: ElContent[] = [];
  const setActive = (actor: string, on: boolean, at: number) => {
    const stack = activations.get(actor) ?? [];
    if (on) stack.push(at);
    else {
      const start = stack.pop();
      if (start !== undefined)
        activationBoxes.push(
          ...card(
            x.get(actor)! - 5 + stack.length * 4,
            start,
            10,
            Math.max(8, at - start),
            2,
            C.alt,
          ),
        );
    }
    activations.set(actor, stack);
  };
  // Frames wrap what they contain, so each tracks the horizontal extent of its content.
  const involve = (x0: number, x1: number) => {
    blocks.forEach((b) => ([b.x0, b.x1] = [Math.min(b.x0, x0), Math.max(b.x1, x1)]));
    [left, width] = [Math.min(left, x0), Math.max(width, x1)];
  };
  let number = 0;
  for (const event of events) {
    if (event.kind === "message") {
      const label = ctx.label((autonumber ? `${++number}. ` : "") + event.text, FONT - 1);
      const x1 = x.get(event.from)!;
      const x2 = x.get(event.to)!;
      const style = `fill:none;stroke:${C.line};stroke-width:1.25${event.dashed ? ";stroke-dasharray:5 4" : ""}`;
      const marker = event.head === "none" ? undefined : ctx.marker(event.head);
      const start = event.both ? ctx.marker("arrow") : undefined;
      if (x1 === x2) {
        y += 4;
        foreground.push(
          el("path", {
            d: `M${x1},${y} H${x1 + 24} Q${x1 + 34},${y} ${x1 + 34},${y + 10} V${y + 14} Q${x1 + 34},${y + 24} ${x1 + 24},${y + 24} H${x1 + 2}`,
            style,
            "marker-end": marker,
            "marker-start": start,
          }),
          ctx.drawLabel(label, x1 + 42, y + 12, { size: FONT - 1, anchor: "start" }),
        );
        involve(x1, x1 + 42 + label.width);
        y += Math.max(24, label.height) + 18;
      } else {
        foreground.push(
          ctx.drawLabel(label, (x1 + x2) / 2, y + label.height / 2, { size: FONT - 1 }),
        );
        y += label.height + 5;
        foreground.push(
          el("path", {
            d: `M${x1 + (start ? Math.sign(x2 - x1) * 2 : 0)},${y} H${x2 - Math.sign(x2 - x1) * 2}`,
            style,
            "marker-end": marker,
            "marker-start": start,
          }),
        );
        involve(
          Math.min(x1, x2, (x1 + x2 - label.width) / 2),
          Math.max(x1, x2, (x1 + x2 + label.width) / 2),
        );
        y += 20;
      }
      if (event.activate) setActive(event.to, true, y - 20);
      if (event.deactivate) setActive(event.from, false, y - 20);
    } else if (event.kind === "activate") setActive(event.actor, event.on, y - 14);
    else if (event.kind === "note") {
      const label = ctx.label(event.text, FONT - 1);
      const xs = event.at.map((a) => x.get(a)!);
      const w = Math.max(
        label.width + 24,
        event.side === "over" && xs.length > 1 ? Math.max(...xs) - Math.min(...xs) + 48 : 0,
      );
      const cx =
        event.side === "over"
          ? (Math.min(...xs) + Math.max(...xs)) / 2
          : event.side === "left"
            ? xs[0]! - 16 - w / 2
            : xs[0]! + 16 + w / 2;
      const h = label.height + 14;
      foreground.push(
        ...card(cx - w / 2, y, w, h, 4, C.alt),
        ctx.drawLabel(label, cx, y + h / 2, { size: FONT - 1 }),
      );
      involve(cx - w / 2, cx + w / 2);
      y += h + 14;
    } else if (event.kind === "block") {
      blocks.push({
        type: event.type,
        text: event.text,
        start: y,
        dividers: [],
        x0: Infinity,
        x1: -Infinity,
      });
      y += event.type === "rect" ? 12 : 32;
    } else if (event.kind === "divider") {
      const block = blocks.at(-1);
      if (block) block.dividers.push({ y: y - 4, text: event.text });
      y += 26;
    } else if (event.kind === "end") {
      const block = blocks.pop();
      if (!block) continue;
      const tag = block.type === "rect" ? "" : block.type;
      const tagWidth = tag ? ctx.measure(tag, FONT - 2, true) + 16 : 0;
      const condition = (text: string) => (text ? `[${cleanLabel(text)}]` : "");
      const textWidth = Math.max(
        tagWidth + ctx.measure(condition(block.text), FONT - 1) + 16,
        ...block.dividers.map((d) => ctx.measure(condition(d.text), FONT - 1) + 16),
      );
      const [l0, r0] = Number.isFinite(block.x0) ? [block.x0 - 20, block.x1 + 20] : [0, width];
      const [l, r] = [l0, Math.max(r0, l0 + textWidth)];
      involve(l - 8, r + 8);
      y += 4;
      if (block.type === "rect")
        frames.push(
          el("rect", {
            x: l,
            y: block.start,
            width: r - l,
            height: y - block.start,
            rx: 4,
            style: `fill:${C.accent};fill-opacity:0.08`,
          }),
        );
      else {
        frames.push(
          el("rect", {
            x: l,
            y: block.start,
            width: r - l,
            height: y - block.start,
            rx: 4,
            style: `fill:none;stroke:${C.border}`,
          }),
          el("path", {
            d: `M${l + 4},${block.start} H${l + tagWidth} V${block.start + 14} L${l + tagWidth - 6},${block.start + 20} H${l} V${block.start + 4} Q${l},${block.start} ${l + 4},${block.start} Z`,
            style: `fill:${C.bg}`,
          }),
          el("path", {
            d: `M${l + 4},${block.start} H${l + tagWidth} V${block.start + 14} L${l + tagWidth - 6},${block.start + 20} H${l} V${block.start + 4} Q${l},${block.start} ${l + 4},${block.start} Z`,
            style: `fill:${C.alt};stroke:${C.border}`,
          }),
          el(
            "text",
            {
              x: l + 7,
              y: block.start + 14,
              style: `fill:${C.fg};font-size:${FONT - 2}px;font-weight:600`,
            },
            [text(tag)],
          ),
        );
        if (block.text)
          frames.push(
            el(
              "text",
              {
                x: l + tagWidth + 8,
                y: block.start + 15,
                style: `fill:${C.fg};font-size:${FONT - 1}px;white-space:pre`,
              },
              [text(condition(block.text))],
            ),
          );
        for (const divider of block.dividers) {
          frames.push(
            el("path", {
              d: `M${l},${divider.y} H${r}`,
              style: `stroke:${C.border};stroke-dasharray:4 4`,
            }),
          );
          if (divider.text)
            frames.push(
              el(
                "text",
                {
                  x: l + 8,
                  y: divider.y + 17,
                  style: `fill:${C.fg};font-size:${FONT - 1}px;white-space:pre`,
                },
                [text(condition(divider.text))],
              ),
            );
        }
      }
      y += 12;
    }
  }
  for (const [actor, stack] of activations) while (stack.length) setActive(actor, false, y);
  const bottom = y + 6;
  const head = (id: string, at: number) => {
    const cx = x.get(id)!;
    const label = labels.get(id)!;
    if (actors.get(id)!.actor) {
      return [
        el("path", {
          d: `M${cx},${at + 10} m-6,0 a6,6 0 1,0 12,0 a6,6 0 1,0 -12,0 M${cx},${at + 16} V${at + 28} M${cx - 10},${at + 20} H${cx + 10} M${cx},${at + 28} L${cx - 8},${at + 38} M${cx},${at + 28} L${cx + 8},${at + 38}`,
          style: `fill:none;stroke:${C.fg};stroke-width:1.4`,
        }),
        ctx.drawLabel(label, cx, at + 38 + label.height / 2 + 2),
      ];
    }
    const w = boxWidth(id);
    return [
      ...card(cx - w / 2, at, w, headerHeight, 5),
      ctx.drawLabel(label, cx, at + headerHeight / 2),
    ];
  };
  for (const id of ids) {
    lifelines.push(
      el("path", {
        d: `M${x.get(id)},${top + headerHeight} V${bottom}`,
        style: `stroke:${C.border};stroke-dasharray:4 4`,
      }),
    );
    content.push(...head(id, top), ...head(id, bottom));
  }
  const actorExtra = [...actors.values()].some((a) => a.actor) ? 30 : 0;
  return {
    content: [
      el("g", { transform: `translate(${round(-left)},0)` }, [
        ...frames,
        ...lifelines,
        ...activationBoxes,
        ...foreground,
        ...content,
      ]),
    ],
    width: width - left,
    height: bottom + headerHeight + actorExtra,
  };
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
    } else if (line !== "showData")
      throw new Error(`Unexpected "${line.slice(0, 30)}" in pie chart`);
  }
  const total = slices.reduce((s, x) => s + x.value, 0);
  const radius = 120;
  const titleLabel = title ? ctx.label(title, FONT + 2, true) : null;
  const top = titleLabel ? titleLabel.height + 16 : 0;
  const cx = radius;
  const cy = top + radius;
  const content: ElContent[] = [];
  if (titleLabel)
    content.push(
      ctx.drawLabel(titleLabel, radius, titleLabel.height / 2, { size: FONT + 2, bold: true }),
    );
  let angle = -Math.PI / 2;
  slices.forEach((slice, i) => {
    const sweep = total ? (slice.value / total) * Math.PI * 2 : 0;
    const color = SERIES[i % SERIES.length]!;
    if (sweep >= Math.PI * 2 - 1e-9)
      content.push(
        el("circle", { cx, cy, r: radius, style: `fill:${color};stroke:${C.bg};stroke-width:2` }),
      );
    else if (sweep > 0) {
      const [x1, y1, x2, y2] = [
        cx + radius * Math.cos(angle),
        cy + radius * Math.sin(angle),
        cx + radius * Math.cos(angle + sweep),
        cy + radius * Math.sin(angle + sweep),
      ];
      content.push(
        el("path", {
          d: `M${round(cx)},${round(cy)} L${round(x1)},${round(y1)} A${radius},${radius} 0 ${sweep > Math.PI ? 1 : 0},1 ${round(x2)},${round(y2)} Z`,
          style: `fill:${color};stroke:${C.bg};stroke-width:2`,
        }),
      );
    }
    if (sweep > 0.25) {
      const mid = angle + sweep / 2;
      content.push(
        el(
          "text",
          {
            x: cx + radius * 0.65 * Math.cos(mid),
            y: cy + radius * 0.65 * Math.sin(mid) + 4,
            "text-anchor": "middle",
            style: `fill:#ffffff;font-size:${FONT - 1}px;font-weight:600`,
          },
          [text(`${Math.round((slice.value / total) * 100)}%`)],
        ),
      );
    }
    angle += sweep;
  });
  const legendX = radius * 2 + 30;
  let legendWidth = 0;
  slices.forEach((slice, i) => {
    const y = top + radius - (slices.length * 22) / 2 + i * 22;
    const label = showData ? `${slice.label} [${slice.value}]` : slice.label;
    legendWidth = Math.max(legendWidth, ctx.measure(label) + 24);
    content.push(
      el("rect", {
        x: legendX,
        y,
        width: 14,
        height: 14,
        rx: 2,
        style: `fill:${SERIES[i % SERIES.length]}`,
      }),
      el("text", { x: legendX + 22, y: y + 12, style: `fill:${C.fg}` }, [text(label)]),
    );
  });
  return {
    content,
    width: Math.max(legendX + legendWidth, titleLabel?.width ?? 0),
    height: Math.max(cy + radius, top + (slices.length * 22) / 2 + radius),
  };
}

// ---------- xychart-beta ----------

function niceTicks(min: number, max: number, count = 5) {
  const span = max - min || Math.abs(max) || 1;
  const step0 = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * magnitude).find((s) => s >= step0)!;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let t = start; t <= max + step * 0.5 && ticks.length < 50; t += step)
    ticks.push(Math.round(t / step) * step);
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
    else if (
      (m = /^x-axis\s*(?:("[^"]*"|\w+)\s*)?(?:\[(.*)\]|([\d.-]+)\s*-->\s*([\d.-]+))?$/.exec(line))
    ) {
      if (m[1]) xTitle = cleanLabel(m[1]);
      if (m[2] !== undefined) categories = list(m[2]);
      if (m[3] !== undefined) xRange = [Number(m[3]), Number(m[4])];
    } else if (
      (m = /^y-axis\s*(?:("[^"]*"|\w+)\s*)?(?:([\d.-]+)\s*-->\s*([\d.-]+))?$/.exec(line))
    ) {
      if (m[1]) yTitle = cleanLabel(m[1]);
      if (m[2] !== undefined) yRange = [Number(m[2]), Number(m[3])];
    } else if ((m = /^(bar|line)\s*(?:"[^"]*"\s*)?\[(.*)\]$/.exec(line))) {
      const values = m[2]!.split(",").map((s) => Number(s.trim()));
      if (values.some((n) => !Number.isFinite(n))) throw new Error(`Invalid ${m[1]} values`);
      series.push({ kind: m[1] as "bar" | "line", values });
    } else throw new Error(`Unexpected "${line.slice(0, 30)}" in xychart`);
  }
  const count = Math.max(categories?.length ?? 0, ...series.map((s) => s.values.length));
  const labelsX =
    categories ??
    Array.from({ length: count }, (_, i) =>
      xRange
        ? String(round(xRange[0] + ((xRange[1] - xRange[0]) * i) / Math.max(1, count - 1)))
        : String(i + 1),
    );
  const all = series.flatMap((s) => s.values);
  const nice = niceTicks(yRange?.[0] ?? Math.min(0, ...all), yRange?.[1] ?? Math.max(...all, 1));
  const [min, max] = yRange ?? [nice.min, nice.max];
  const ticks = nice.ticks.filter((t) => t >= min && t <= max);
  const plotWidth = Math.max(420, count * 56);
  const plotHeight = 260;
  const left = Math.max(...ticks.map((t) => ctx.measure(String(t), FONT - 2))) + (yTitle ? 30 : 12);
  const titleLabel = title ? ctx.label(title, FONT + 2, true) : null;
  const top = titleLabel ? titleLabel.height + 16 : 6;
  const scaleY = (value: number) =>
    top + plotHeight - ((value - min) / (max - min || 1)) * plotHeight;
  const band = plotWidth / Math.max(1, count);
  const content: ElContent[] = [];
  if (titleLabel)
    content.push(
      ctx.drawLabel(titleLabel, left + plotWidth / 2, titleLabel.height / 2, {
        size: FONT + 2,
        bold: true,
      }),
    );
  for (const tick of ticks) {
    const y = scaleY(tick);
    content.push(
      el("path", {
        d: `M${left},${y} H${left + plotWidth}`,
        style: `stroke:${C.border};stroke-opacity:0.5`,
      }),
      el(
        "text",
        {
          x: left - 6,
          y: y + 4,
          "text-anchor": "end",
          style: `fill:${C.muted};font-size:${FONT - 2}px`,
        },
        [text(String(tick))],
      ),
    );
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
        content.push(
          el("rect", {
            x: left + i * band + band * 0.15 + slot * width,
            y: Math.min(y, scaleY(value)),
            width,
            height: Math.abs(base - scaleY(value)),
            style: `fill:${color}`,
          }),
        );
      });
    } else {
      const points = s.values.map(
        (value, i) => `${round(left + i * band + band / 2)},${round(scaleY(value))}`,
      );
      content.push(
        el("polyline", {
          points: points.join(" "),
          style: `fill:none;stroke:${color};stroke-width:2.25;stroke-linejoin:round;stroke-linecap:round`,
        }),
      );
      for (const point of points) {
        const [cx, cy] = point.split(",");
        content.push(
          el("circle", {
            cx: Number(cx),
            cy: Number(cy),
            r: 3.5,
            style: `fill:${color};stroke:${C.bg};stroke-width:1.5`,
          }),
        );
      }
    }
  });
  content.push(
    el("path", {
      d: `M${left},${top} V${top + plotHeight} H${left + plotWidth}`,
      style: `fill:none;stroke:${C.line}`,
    }),
  );
  const rotate = labelsX.some((l) => ctx.measure(l, FONT - 2) > band - 4);
  labelsX.forEach((label, i) => {
    const x = left + i * band + band / 2;
    const y = top + plotHeight + 16;
    content.push(
      el(
        "text",
        {
          x,
          y,
          "text-anchor": rotate ? "end" : "middle",
          transform: rotate ? `rotate(-35 ${round(x)} ${round(y)})` : undefined,
          style: `fill:${C.muted};font-size:${FONT - 2}px`,
        },
        [text(label)],
      ),
    );
  });
  const labelDepth = rotate
    ? Math.max(...labelsX.map((l) => ctx.measure(l, FONT - 2))) * 0.6 + 16
    : 22;
  let height = top + plotHeight + labelDepth;
  if (xTitle) {
    content.push(
      el(
        "text",
        {
          x: left + plotWidth / 2,
          y: height + 12,
          "text-anchor": "middle",
          style: `fill:${C.fg};font-size:${FONT - 1}px`,
        },
        [text(xTitle)],
      ),
    );
    height += 20;
  }
  if (yTitle)
    content.push(
      el(
        "text",
        {
          x: 12,
          y: top + plotHeight / 2,
          "text-anchor": "middle",
          transform: `rotate(-90 12 ${round(top + plotHeight / 2)})`,
          style: `fill:${C.fg};font-size:${FONT - 1}px`,
        },
        [text(yTitle)],
      ),
    );
  return { content, width: left + plotWidth + 8, height };
}

// ---------- gantt ----------

const HOUR = 36e5;
const DAY = 24 * HOUR;
const DURATION: Record<string, number> = {
  ms: 1,
  s: 1e3,
  m: 6e4,
  h: HOUR,
  d: DAY,
  w: 7 * DAY,
  M: 30 * DAY,
  y: 365 * DAY,
};
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
/** UTC calendar fields of an epoch time (Hinnant's days-to-civil). */
function civil(t: number) {
  const z = Math.floor(t / DAY) + 719468;
  const doe = z - Math.floor(z / 146097) * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const month = mp < 10 ? mp + 2 : mp - 10;
  const time = t - Math.floor(t / DAY) * DAY;
  return {
    year: Math.floor(z / 146097) * 400 + yoe + (month < 2 ? 1 : 0),
    month,
    day: doy - Math.floor((153 * mp + 2) / 5) + 1,
    hour: Math.floor(time / HOUR),
    minute: Math.floor((time % HOUR) / 6e4),
  };
}

function gantt(lines: string[], ctx: Context) {
  let title = "";
  let format = "YYYY-MM-DD";
  let section = "";
  type Task = { section: string; label: string; start: number; end: number; tags: string[] };
  const tasks: Task[] = [];
  const byId = new Map<string, Task>();
  const parseDate = (raw: string) => {
    const tokens: string[] = [];
    const pattern = format
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/YYYY|YY|MM|M|DD|D|HH|H|mm|ss/g, (token) => (tokens.push(token), "(\\d+)"));
    const m = new RegExp(`^${pattern}$`).exec(raw);
    if (m) {
      const part = (...keys: string[]) => {
        const i = tokens.findIndex((token) => keys.includes(token));
        return i < 0 ? undefined : Number(m[i + 1]);
      };
      const year = part("YYYY", "YY") ?? 1970;
      return Date.UTC(
        year < 100 ? year + 2000 : year,
        (part("MM", "M") ?? 1) - 1,
        part("DD", "D") ?? 1,
        part("HH", "H") ?? 0,
        part("mm") ?? 0,
        part("ss") ?? 0,
      );
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
    throw new Error(`Invalid date "${raw}" in gantt chart`);
  };
  const ends = (ids: string, key: "start" | "end", fallback: number) =>
    ids.split(/\s+/).map((id) => byId.get(id)?.[key] ?? fallback);
  for (const line of lines.slice(1)) {
    let m: RegExpExecArray | null;
    if ((m = /^title\s+(.+)$/.exec(line))) title = cleanLabel(m[1]!);
    else if ((m = /^dateFormat\s+(.+)$/.exec(line))) format = m[1]!.trim();
    else if ((m = /^section\s+(.+)$/.exec(line))) section = cleanLabel(m[1]!);
    else if (
      /^(axisFormat|tickInterval|excludes|includes|todayMarker|weekday|weekend|inclusiveEndDates|topAxis|displayMode|click|accTitle|accDescr)\b/.test(
        line,
      )
    )
      continue;
    else if ((m = /^([^:]+?)\s*:\s*(.+)$/.exec(line))) {
      const parts = m[2]!
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      const tags: string[] = [];
      while (parts.length > 1 && /^(done|active|crit|milestone)$/.test(parts[0]!))
        tags.push(parts.shift()!);
      const id = parts.length >= 3 ? parts.shift() : undefined;
      const previous = tasks.at(-1)?.end ?? 0;
      const startRaw = parts.length >= 2 ? parts[0]! : "";
      const endRaw = parts.at(-1)!;
      const after = /^after\s+(.+)$/.exec(startRaw);
      const start = !startRaw
        ? previous
        : after
          ? Math.max(...ends(after[1]!, "end", previous))
          : parseDate(startRaw);
      const duration = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w|M|y)$/.exec(endRaw);
      const until = /^until\s+(.+)$/.exec(endRaw);
      const end = duration
        ? start + Number(duration[1]) * DURATION[duration[2]!]!
        : until
          ? Math.min(...ends(until[1]!, "start", start))
          : parseDate(endRaw);
      const task = { section, label: cleanLabel(m[1]!), start, end: Math.max(start, end), tags };
      tasks.push(task);
      if (id) byId.set(id, task);
    } else throw new Error(`Unexpected "${line.slice(0, 30)}" in gantt chart`);
  }
  if (!tasks.length) throw new Error("Gantt chart has no tasks");
  const t0 = Math.min(...tasks.map((t) => t.start));
  const t1 = Math.max(t0 + HOUR, ...tasks.map((t) => t.end));
  const step =
    [
      HOUR,
      3 * HOUR,
      6 * HOUR,
      12 * HOUR,
      DAY,
      2 * DAY,
      7 * DAY,
      14 * DAY,
      30 * DAY,
      91 * DAY,
      182 * DAY,
    ].find((s) => (t1 - t0) / s <= 8) ?? 365 * DAY;
  const ticks: number[] = [];
  if (step >= 30 * DAY) {
    const months = Math.round(step / (30 * DAY));
    for (
      let i = 0, t = Date.UTC(civil(t0).year, civil(t0).month);
      t <= t1 && i < 50;
      t = Date.UTC(civil(t).year, civil(t).month + months), i++
    )
      if (t >= t0) ticks.push(t);
  } else
    for (let t = Math.ceil(t0 / step) * step; t <= t1 && ticks.length < 50; t += step)
      ticks.push(t);
  const tickLabel = (t: number, i: number) => {
    const d = civil(t);
    if (step < DAY)
      return `${String(d.hour).padStart(2, "0")}:${String(d.minute).padStart(2, "0")}`;
    if (step >= 365 * DAY) return String(d.year);
    if (step >= 30 * DAY) return !i || !d.month ? `${MONTHS[d.month]} ${d.year}` : MONTHS[d.month]!;
    return `${MONTHS[d.month]} ${d.day}`;
  };
  const sections = [...new Set(tasks.map((t) => t.section))];
  const labelWidth =
    Math.max(
      ...tasks.map((t) => ctx.measure(t.label, FONT - 1)),
      ...sections.map((s) => ctx.measure(s, FONT - 1, true)),
    ) + 24;
  const plotWidth = Math.max(420, ticks.length * 72);
  const scale = (t: number) => labelWidth + ((t - t0) / (t1 - t0)) * plotWidth;
  const titleLabel = title ? ctx.label(title, FONT + 2, true) : null;
  const top = (titleLabel ? titleLabel.height + 14 : 0) + 24;
  const row = 28;
  const content: ElContent[] = [];
  if (titleLabel)
    content.push(
      ctx.drawLabel(titleLabel, (labelWidth + plotWidth) / 2, titleLabel.height / 2, {
        size: FONT + 2,
        bold: true,
      }),
    );
  const rows: ElContent[] = [];
  let y = top;
  sections.forEach((name, index) => {
    const members = tasks.filter((t) => t.section === name);
    const height = (members.length + (name ? 1 : 0)) * row;
    if (index % 2)
      rows.push(
        el("rect", {
          x: 0,
          y,
          width: labelWidth + plotWidth,
          height,
          style: `fill:${C.alt};fill-opacity:0.6`,
        }),
      );
    if (name) {
      rows.push(
        el(
          "text",
          {
            x: 0,
            y: y + row / 2 + 4.5,
            style: `fill:${C.muted};font-size:${FONT - 1}px;font-weight:600`,
          },
          [text(name)],
        ),
      );
      y += row;
    }
    const color = SERIES[index % SERIES.length]!;
    for (const task of members) {
      const [x0, x1, cy] = [scale(task.start), scale(task.end), y + row / 2];
      const fill = task.tags.includes("crit") ? C.critical : color;
      const [opacity, stroke] = task.tags.includes("done")
        ? [0.3, 1]
        : task.tags.includes("active")
          ? [0.55, 1.5]
          : [0.9, 0];
      const active = stroke ? `;stroke:${fill};stroke-width:${stroke}` : "";
      rows.push(
        el(
          "text",
          { x: name ? 10 : 0, y: cy + 4.5, style: `fill:${C.fg};font-size:${FONT - 1}px` },
          [text(task.label)],
        ),
      );
      rows.push(
        task.tags.includes("milestone")
          ? el("path", {
              d: `M${round(x0)},${round(cy - 8)} l8,8 l-8,8 l-8,-8 z`,
              style: `fill:${fill};fill-opacity:${opacity}${active}`,
            })
          : el("rect", {
              x: x0,
              y: cy - 9,
              width: Math.max(3, x1 - x0),
              height: 18,
              rx: 4,
              style: `fill:${fill};fill-opacity:${opacity}${active}`,
            }),
      );
      y += row;
    }
  });
  ticks.forEach((t, i) => {
    const x = scale(t);
    content.push(
      el("path", {
        d: `M${round(x)},${top - 4} V${y}`,
        style: `stroke:${C.border};stroke-opacity:0.6`,
      }),
      el(
        "text",
        {
          x,
          y: top - 10,
          "text-anchor": "middle",
          style: `fill:${C.muted};font-size:${FONT - 2}px`,
        },
        [text(tickLabel(t, i))],
      ),
    );
  });
  content.push(...rows);
  return { content, width: labelWidth + plotWidth + 24, height: y + 4 };
}
