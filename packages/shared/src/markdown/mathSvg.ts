import type { ElContent, ElElement } from "./types.ts";

const SYMBOLS: Readonly<Record<string, string>> = {
  alpha: "\u03b1",
  beta: "\u03b2",
  gamma: "\u03b3",
  delta: "\u03b4",
  epsilon: "\u03f5",
  varepsilon: "\u03b5",
  zeta: "\u03b6",
  eta: "\u03b7",
  theta: "\u03b8",
  vartheta: "\u03d1",
  iota: "\u03b9",
  kappa: "\u03ba",
  lambda: "\u03bb",
  mu: "\u03bc",
  nu: "\u03bd",
  xi: "\u03be",
  pi: "\u03c0",
  varpi: "\u03d6",
  rho: "\u03c1",
  varrho: "\u03f1",
  sigma: "\u03c3",
  varsigma: "\u03c2",
  tau: "\u03c4",
  upsilon: "\u03c5",
  phi: "\u03d5",
  varphi: "\u03c6",
  chi: "\u03c7",
  psi: "\u03c8",
  omega: "\u03c9",
  Gamma: "\u0393",
  Delta: "\u0394",
  Theta: "\u0398",
  Lambda: "\u039b",
  Xi: "\u039e",
  Pi: "\u03a0",
  Sigma: "\u03a3",
  Upsilon: "\u03a5",
  Phi: "\u03a6",
  Psi: "\u03a8",
  Omega: "\u03a9",
  sum: "\u2211",
  prod: "\u220f",
  int: "\u222b",
  oint: "\u222e",
  infty: "\u221e",
  partial: "\u2202",
  nabla: "\u2207",
  pm: "\u00b1",
  mp: "\u2213",
  times: "\u00d7",
  cdot: "\u22c5",
  div: "\u00f7",
  ast: "\u2217",
  star: "\u22c6",
  circ: "\u2218",
  bullet: "\u2022",
  le: "\u2264",
  leq: "\u2264",
  ge: "\u2265",
  geq: "\u2265",
  ne: "\u2260",
  neq: "\u2260",
  approx: "\u2248",
  equiv: "\u2261",
  sim: "\u223c",
  simeq: "\u2243",
  cong: "\u2245",
  propto: "\u221d",
  ll: "\u226a",
  gg: "\u226b",
  in: "\u2208",
  notin: "\u2209",
  ni: "\u220b",
  subset: "\u2282",
  supset: "\u2283",
  subseteq: "\u2286",
  supseteq: "\u2287",
  cup: "\u222a",
  cap: "\u2229",
  emptyset: "\u2205",
  varnothing: "\u2205",
  forall: "\u2200",
  exists: "\u2203",
  neg: "\u00ac",
  land: "\u2227",
  lor: "\u2228",
  to: "\u2192",
  rightarrow: "\u2192",
  leftarrow: "\u2190",
  leftrightarrow: "\u2194",
  Rightarrow: "\u21d2",
  Leftarrow: "\u21d0",
  Leftrightarrow: "\u21d4",
  iff: "\u27fa",
  implies: "\u27f9",
  mapsto: "\u21a6",
  dots: "\u2026",
  ldots: "\u2026",
  cdots: "\u22ef",
  vdots: "\u22ee",
  ddots: "\u22f1",
  ell: "\u2113",
  hbar: "\u210f",
  Re: "\u211c",
  Im: "\u2111",
  aleph: "\u2135",
  wp: "\u2118",
  angle: "\u2220",
  perp: "\u22a5",
  parallel: "\u2225",
  mid: "\u2223",
  langle: "\u27e8",
  rangle: "\u27e9",
  lfloor: "\u230a",
  rfloor: "\u230b",
  lceil: "\u2308",
  rceil: "\u2309",
  "|": "\u2225",
  "{": "{",
  "}": "}",
  "$": "$",
  "%": "%",
  "&": "&",
  "#": "#",
  _: "_",
  " ": " ",
  ",": "\u2009",
  ";": "\u2005",
  ":": "\u2005",
  quad: "\u2001",
  qquad: "\u2001\u2001",
  "!": "",
};

const OPERATORS = new Set([
  "sin",
  "cos",
  "tan",
  "cot",
  "sec",
  "csc",
  "arcsin",
  "arccos",
  "arctan",
  "sinh",
  "cosh",
  "tanh",
  "log",
  "ln",
  "exp",
  "lim",
  "limsup",
  "liminf",
  "sup",
  "inf",
  "max",
  "min",
  "arg",
  "det",
  "dim",
  "gcd",
  "hom",
  "ker",
  "deg",
  "Pr",
  "mod",
]);

const BIG_OPS = new Set(["\u2211", "\u220f", "\u222b", "\u222e"]);
const TEXT_CMDS = new Set(["text", "textrm", "textup", "mbox"]);
const STYLE_CMDS: Readonly<Record<string, { italic?: boolean; bold?: boolean; mono?: boolean }>> = {
  mathrm: { italic: false },
  operatorname: { italic: false },
  mathbf: { italic: false, bold: true },
  boldsymbol: { bold: true },
  mathit: { italic: true },
  mathsf: { italic: false },
  mathtt: { italic: false, mono: true },
  mathbb: { italic: false, bold: true },
  mathcal: { italic: true },
};

const BINARY_OPS = new Set([
  "+",
  "-",
  "=",
  "<",
  ">",
  "\u00b1",
  "\u2213",
  "\u00d7",
  "\u22c5",
  "\u00f7",
  "\u2264",
  "\u2265",
  "\u2260",
  "\u2248",
  "\u2261",
  "\u223c",
  "\u2208",
  "\u2209",
  "\u2282",
  "\u2283",
  "\u2286",
  "\u2287",
  "\u222a",
  "\u2229",
  "\u2192",
  "\u2190",
  "\u2194",
  "\u21d2",
  "\u21d0",
  "\u21d4",
  "\u21a6",
  "\u2212",
]);

const BASE_FONT = 16;
const ASCENT = 12;
const DESCENT = 4;

interface Box {
  readonly width: number;
  readonly ascent: number;
  readonly descent: number;
  readonly render: (x: number, y: number, out: ElContent[]) => void;
}

function charWidth(ch: string, size: number, bold: boolean): number {
  const factor = bold ? 1.05 : 1;
  if (ch === " " || ch === "\u2009") return size * 0.28;
  if (ch === "\u2005") return size * 0.35;
  if (ch === "\u2001") return size * 1.0;
  if ("il1.,:;!|'".includes(ch)) return size * 0.34 * factor;
  if ("fjrt()[]/\\-".includes(ch)) return size * 0.42 * factor;
  if ("mwMW\u2211\u220f\u221e".includes(ch)) return size * 0.82 * factor;
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 0x3000) return size * 1.0;
  return size * 0.58 * factor;
}

function measureString(text: string, size: number, bold: boolean): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch, size, bold);
  return w;
}

function textBox(
  value: string,
  size: number,
  opts?: { italic?: boolean; bold?: boolean; mono?: boolean; preserveSpace?: boolean },
): Box {
  const italic = opts?.italic ?? false;
  const bold = opts?.bold ?? false;
  const width = measureString(value, size, bold);
  const scale = size / BASE_FONT;
  const ascent = ASCENT * scale;
  const descent = DESCENT * scale;
  return {
    width,
    ascent,
    descent,
    render(x, y, out) {
      if (!value) return;
      const properties: Record<string, unknown> = {
        x: round(x),
        y: round(y),
        fill: "currentColor",
        fontSize: round(size),
        fontFamily: opts?.mono
          ? "ui-monospace, monospace"
          : opts?.preserveSpace
            ? "system-ui, -apple-system, sans-serif"
            : "KaTeX_Main, 'Times New Roman', Times, serif",
      };
      if (italic) properties.fontStyle = "italic";
      if (bold) properties.fontWeight = "700";
      if (opts?.preserveSpace) properties.style = "white-space:pre";
      out.push({
        type: "element",
        tagName: "text",
        properties,
        children: [{ type: "text", value }],
      });
    },
  };
}

function rowBox(boxes: Box[], gap = 0): Box {
  if (boxes.length === 0) return { width: 0, ascent: ASCENT * 0.6, descent: DESCENT * 0.6, render: () => {} };
  if (boxes.length === 1) return boxes[0]!;
  let width = 0;
  let ascent = 0;
  let descent = 0;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]!;
    if (i > 0) width += gap;
    width += b.width;
    if (b.ascent > ascent) ascent = b.ascent;
    if (b.descent > descent) descent = b.descent;
  }
  return {
    width,
    ascent,
    descent,
    render(x, y, out) {
      let cx = x;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i]!;
        if (i > 0) cx += gap;
        b.render(cx, y, out);
        cx += b.width;
      }
    },
  };
}

function fracBox(num: Box, den: Box, size: number): Box {
  const pad = size * 0.14;
  const ruleH = Math.max(0.8, size * 0.06);
  const axisY = size * 0.3;
  const innerW = Math.max(num.width, den.width);
  const width = innerW + pad * 2;
  const gap = size * 0.16;
  const ascent = axisY + ruleH / 2 + gap + num.descent + num.ascent;
  const descent = Math.max(DESCENT * (size / BASE_FONT), gap + ruleH / 2 - axisY + den.ascent + den.descent);
  return {
    width,
    ascent,
    descent,
    render(x, y, out) {
      const ruleY = y - axisY;
      num.render(x + (width - num.width) / 2, ruleY - ruleH / 2 - gap - num.descent, out);
      out.push({
        type: "element",
        tagName: "rect",
        properties: {
          x: round(x + pad * 0.5),
          y: round(ruleY - ruleH / 2),
          width: round(width - pad),
          height: round(ruleH),
          fill: "currentColor",
        },
        children: [],
      });
      den.render(x + (width - den.width) / 2, ruleY + ruleH / 2 + gap + den.ascent, out);
    },
  };
}

function sqrtBox(body: Box, index: Box | null, size: number): Box {
  const hookW = size * 0.55;
  const padTop = size * 0.16;
  const padRight = size * 0.12;
  const stroke = Math.max(0.8, size * 0.06);
  const idxW = index ? Math.max(0, index.width - hookW * 0.45) : 0;
  const width = idxW + hookW + body.width + padRight;
  const ascent = body.ascent + padTop + stroke;
  const descent = body.descent;
  return {
    width,
    ascent,
    descent,
    render(x, y, out) {
      const rx = x + idxW;
      const topY = y - body.ascent - padTop;
      const botY = y + body.descent * 0.6;
      const midY = (topY + botY) * 0.52;
      if (index) {
        index.render(x, midY - index.descent - 1, out);
      }
      const d = `M ${round(rx)} ${round(midY)} L ${round(rx + hookW * 0.28)} ${round(midY)} L ${round(rx + hookW * 0.56)} ${round(botY)} L ${round(rx + hookW)} ${round(topY)} L ${round(rx + hookW + body.width + padRight)} ${round(topY)}`;
      out.push({
        type: "element",
        tagName: "path",
        properties: {
          d,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: round(stroke),
        },
        children: [],
      });
      body.render(rx + hookW, y, out);
    },
  };
}

function scriptBox(base: Box, sup: Box | null, sub: Box | null, size: number): Box {
  const supShift = Math.max(base.ascent * 0.55, size * 0.42);
  const subShift = Math.max(base.descent + size * 0.22, size * 0.28);
  const scriptW = Math.max(sup?.width ?? 0, sub?.width ?? 0);
  const gap = size * 0.05;
  const ascent = Math.max(base.ascent, sup ? supShift + sup.ascent : 0);
  const descent = Math.max(base.descent, sub ? subShift + sub.descent : 0);
  return {
    width: base.width + (scriptW > 0 ? gap + scriptW : 0),
    ascent,
    descent,
    render(x, y, out) {
      base.render(x, y, out);
      const sx = x + base.width + gap;
      if (sup) sup.render(sx, y - supShift, out);
      if (sub) sub.render(sx, y + subShift, out);
    },
  };
}

function stackLinesBox(rows: Box[][], size: number): Box {
  const colWidths: number[] = [];
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      colWidths[c] = Math.max(colWidths[c] ?? 0, row[c]!.width);
    }
  }
  const colGap = size * 0.6;
  const rowGap = size * 0.35;
  const totalW = colWidths.reduce((sum, w, i) => sum + w + (i > 0 ? colGap : 0), 0);
  const rowMetrics = rows.map((row) => {
    let a = ASCENT * (size / BASE_FONT);
    let d = DESCENT * (size / BASE_FONT);
    for (const cell of row) {
      if (cell.ascent > a) a = cell.ascent;
      if (cell.descent > d) d = cell.descent;
    }
    return { a, d };
  });
  const totalH = rowMetrics.reduce((sum, m, i) => sum + m.a + m.d + (i > 0 ? rowGap : 0), 0);
  const half = totalH / 2;
  const axis = size * 0.25;
  return {
    width: totalW,
    ascent: half + axis,
    descent: Math.max(0, half - axis),
    render(x, y, out) {
      let cy = y - (half + axis);
      for (let r = 0; r < rows.length; r++) {
        const m = rowMetrics[r]!;
        if (r > 0) cy += rowGap;
        const baseline = cy + m.a;
        let cx = x;
        const row = rows[r]!;
        for (let c = 0; c < row.length; c++) {
          if (c > 0) cx += colGap;
          row[c]!.render(cx, baseline, out);
          cx += colWidths[c]!;
        }
        cy += m.a + m.d;
      }
    },
  };
}

function round(n: number): string {
  return String(Math.round(n * 100) / 100);
}

class TexParser {
  private pos = 0;
  private readonly src: string;
  private readonly len: number;

  constructor(src: string) {
    this.src = src;
    this.len = src.length;
  }

  parseSequence(size: number, stopAt?: string): Box {
    const rows: Box[][] = [];
    let currentRow: Box[] = [];
    let items: Box[] = [];

    const flushCell = () => {
      currentRow.push(rowBox(items));
      items = [];
    };

    while (this.pos < this.len) {
      this.skipSpaces();
      if (this.pos >= this.len) break;
      const ch = this.src[this.pos]!;
      if (stopAt && ch === stopAt) {
        this.pos++;
        break;
      }
      if (ch === "\\" && this.src.startsWith("\\end{", this.pos)) {
        break;
      }
      if (ch === "\\" && this.src[this.pos + 1] === "\\") {
        this.pos += 2;
        flushCell();
        rows.push(currentRow);
        currentRow = [];
        continue;
      }
      if (ch === "&") {
        this.pos++;
        flushCell();
        continue;
      }
      if (ch === "\\" && this.src.startsWith("\\right", this.pos) && stopAt === "\\right") {
        break;
      }
      const atom = this.parseAtomWithScripts(size);
      if (atom) items.push(atom);
    }

    if (rows.length > 0 || currentRow.length > 0) {
      flushCell();
      rows.push(currentRow);
      return stackLinesBox(rows, size);
    }
    return rowBox(items);
  }

  private skipSpaces() {
    while (this.pos < this.len) {
      const c = this.src.charCodeAt(this.pos);
      if (c === 32 || c === 9 || c === 10 || c === 13) this.pos++;
      else break;
    }
  }

  private readBraceGroup(): string {
    this.skipSpaces();
    if (this.pos >= this.len) return "";
    if (this.src[this.pos] !== "{") {
      if (this.src[this.pos] === "\\") {
        const start = this.pos;
        this.pos++;
        if (this.pos < this.len && /[A-Za-z]/.test(this.src[this.pos]!)) {
          while (this.pos < this.len && /[A-Za-z]/.test(this.src[this.pos]!)) this.pos++;
        } else if (this.pos < this.len) {
          this.pos++;
        }
        return this.src.slice(start, this.pos);
      }
      return this.src[this.pos++] ?? "";
    }
    this.pos++;
    const start = this.pos;
    let depth = 1;
    while (this.pos < this.len && depth > 0) {
      const ch = this.src[this.pos]!;
      if (ch === "\\" && this.pos + 1 < this.len) {
        this.pos += 2;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
      this.pos++;
    }
    const content = this.src.slice(start, this.pos);
    if (this.pos < this.len && this.src[this.pos] === "}") this.pos++;
    return content;
  }

  private parseArg(size: number): Box {
    const raw = this.readBraceGroup();
    return new TexParser(raw).parseSequence(size);
  }

  private parseAtomWithScripts(size: number): Box | null {
    const base = this.parseAtom(size);
    if (!base) return null;
    let sup: Box | null = null;
    let sub: Box | null = null;
    const scriptSize = Math.max(9, size * 0.7);
    for (;;) {
      this.skipSpaces();
      const ch = this.src[this.pos];
      if (ch === "^" && !sup) {
        this.pos++;
        sup = this.parseArg(scriptSize);
      } else if (ch === "_" && !sub) {
        this.pos++;
        sub = this.parseArg(scriptSize);
      } else if (ch === "'") {
        let primes = "";
        while (this.pos < this.len && this.src[this.pos] === "'") {
          primes += "\u2032";
          this.pos++;
        }
        sup = sup ? rowBox([sup, textBox(primes, scriptSize)]) : textBox(primes, scriptSize);
      } else {
        break;
      }
    }
    return sup || sub ? scriptBox(base, sup, sub, size) : base;
  }

  private parseAtom(size: number): Box | null {
    this.skipSpaces();
    if (this.pos >= this.len) return null;
    const ch = this.src[this.pos]!;

    if (ch === "{") {
      const content = this.readBraceGroup();
      return new TexParser(content).parseSequence(size);
    }
    if (ch === "}") {
      this.pos++;
      return null;
    }

    if (ch === "\\") {
      this.pos++;
      if (this.pos >= this.len) return textBox("\\", size);
      const next = this.src[this.pos]!;
      let cmd: string;
      if (/[A-Za-z]/.test(next)) {
        const start = this.pos;
        while (this.pos < this.len && /[A-Za-z]/.test(this.src[this.pos]!)) this.pos++;
        cmd = this.src.slice(start, this.pos);
      } else {
        cmd = next;
        this.pos++;
      }

      if (cmd === "frac" || cmd === "dfrac" || cmd === "tfrac") {
        const childSize = cmd === "dfrac" ? size : Math.max(10, size * 0.82);
        const num = this.parseArg(childSize);
        const den = this.parseArg(childSize);
        return fracBox(num, den, size);
      }
      if (cmd === "sqrt") {
        this.skipSpaces();
        let idx: Box | null = null;
        if (this.src[this.pos] === "[") {
          this.pos++;
          const start = this.pos;
          while (this.pos < this.len && this.src[this.pos] !== "]") this.pos++;
          const rawIdx = this.src.slice(start, this.pos);
          if (this.src[this.pos] === "]") this.pos++;
          idx = new TexParser(rawIdx).parseSequence(Math.max(9, size * 0.65));
        }
        const body = this.parseArg(size);
        return sqrtBox(body, idx, size);
      }
      if (TEXT_CMDS.has(cmd)) {
        const raw = this.readBraceGroup();
        return textBox(raw, size, { italic: false, preserveSpace: true });
      }
      const style = STYLE_CMDS[cmd];
      if (style) {
        const raw = this.readBraceGroup();
        return textBox(raw, size, style);
      }
      if (cmd === "left") {
        const openDelim = this.readDelimiter();
        const inner = this.parseSequence(size, "\\right");
        let closeDelim = "";
        if (this.src.startsWith("\\right", this.pos)) {
          this.pos += 6;
          closeDelim = this.readDelimiter();
        }
        const parts: Box[] = [];
        if (openDelim) parts.push(textBox(openDelim, size));
        parts.push(inner);
        if (closeDelim) parts.push(textBox(closeDelim, size));
        return rowBox(parts);
      }
      if (cmd === "begin") {
        const env = this.readBraceGroup();
        const body = this.parseSequence(size);
        if (this.src.startsWith("\\end{", this.pos)) {
          this.pos += 4;
          this.readBraceGroup();
        }
        if (env === "pmatrix") return rowBox([textBox("(", size), body, textBox(")", size)]);
        if (env === "bmatrix") return rowBox([textBox("[", size), body, textBox("]", size)]);
        if (env === "cases") return rowBox([textBox("{", size * 1.2), body]);
        return body;
      }
      if (cmd === "hat" || cmd === "bar" || cmd === "tilde" || cmd === "vec" || cmd === "overline") {
        const arg = this.parseArg(size);
        const mark = cmd === "hat" ? "^" : cmd === "tilde" ? "~" : cmd === "vec" ? "\u2192" : "\u00af";
        return {
          width: arg.width,
          ascent: arg.ascent + size * 0.25,
          descent: arg.descent,
          render(x, y, out) {
            arg.render(x, y, out);
            const mb = textBox(mark, size * 0.75);
            mb.render(x + (arg.width - mb.width) / 2, y - arg.ascent + size * 0.1, out);
          },
        };
      }
      if (OPERATORS.has(cmd)) {
        return textBox(cmd, size, { italic: false });
      }
      const sym = SYMBOLS[cmd];
      if (sym !== undefined) {
        if (!sym) return { width: 0, ascent: 0, descent: 0, render: () => {} };
        const opSize = BIG_OPS.has(sym) ? size * 1.35 : size;
        const pad = BINARY_OPS.has(sym) ? size * 0.18 : 0;
        const b = textBox(sym, opSize);
        return pad > 0
          ? rowBox([
              { width: pad, ascent: 0, descent: 0, render: () => {} },
              b,
              { width: pad, ascent: 0, descent: 0, render: () => {} },
            ])
          : b;
      }
      return textBox(cmd, size, { italic: false });
    }

    this.pos++;
    if (ch === "-") {
      const b = textBox("\u2212", size);
      const pad = size * 0.14;
      return rowBox([
        { width: pad, ascent: 0, descent: 0, render: () => {} },
        b,
        { width: pad, ascent: 0, descent: 0, render: () => {} },
      ]);
    }
    if (BINARY_OPS.has(ch)) {
      const b = textBox(ch, size);
      const pad = size * 0.18;
      return rowBox([
        { width: pad, ascent: 0, descent: 0, render: () => {} },
        b,
        { width: pad, ascent: 0, descent: 0, render: () => {} },
      ]);
    }
    if (/[A-Za-z]/.test(ch)) {
      return textBox(ch, size, { italic: true });
    }
    if (/[0-9]/.test(ch)) {
      let num = ch;
      while (this.pos < this.len && /[0-9.]/.test(this.src[this.pos]!)) {
        num += this.src[this.pos++]!;
      }
      return textBox(num, size, { italic: false });
    }
    // Strip ASCII control characters from rendered glyphs while keeping aria-label verbatim.
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return { width: 0, ascent: 0, descent: 0, render: () => {} };
    return textBox(ch, size, { italic: false });
  }

  private readDelimiter(): string {
    this.skipSpaces();
    if (this.pos >= this.len) return "";
    const ch = this.src[this.pos]!;
    if (ch === ".") {
      this.pos++;
      return "";
    }
    if (ch === "\\") {
      this.pos++;
      if (this.pos >= this.len) return "";
      const next = this.src[this.pos]!;
      if (/[A-Za-z]/.test(next)) {
        const start = this.pos;
        while (this.pos < this.len && /[A-Za-z]/.test(this.src[this.pos]!)) this.pos++;
        const cmd = this.src.slice(start, this.pos);
        return SYMBOLS[cmd] ?? cmd;
      }
      this.pos++;
      return SYMBOLS[next] ?? next;
    }
    this.pos++;
    return ch;
  }
}

const MATH_SCROLL = [
  "max-w-full",
  "overflow-x-auto",
  "overflow-y-hidden",
  "px-0.5",
  "py-0.75",
  "in-[.chat-markdown-table-container]:max-w-none",
  "in-[.chat-markdown-table-container]:overflow-visible",
];

/** Renders TeX directly into a safe, self-contained `<svg>` element node. */
export function renderMathSvg(tex: string, display: boolean): ElElement {
  const cleanTex = tex.trim();
  const box = new TexParser(cleanTex).parseSequence(BASE_FONT);
  const padX = 2;
  const padY = 2;
  const width = Math.max(4, box.width + padX * 2);
  const height = Math.max(BASE_FONT, box.ascent + box.descent + padY * 2);
  const baselineY = padY + box.ascent;
  const children: ElContent[] = [];
  box.render(padX, baselineY, children);
  const emW = round(width / BASE_FONT);
  const emH = round(height / BASE_FONT);
  const verticalAlign = round(-(box.descent + padY) / BASE_FONT);
  return {
    type: "element",
    tagName: "svg",
    properties: {
      xmlns: "http://www.w3.org/2000/svg",
      role: "img",
      ariaLabel: cleanTex,
      width: `${emW}em`,
      height: `${emH}em`,
      viewBox: `0 0 ${round(width)} ${round(height)}`,
      style: display
        ? "display:block;margin:0 auto;overflow:visible"
        : `display:inline;vertical-align:${verticalAlign}em;overflow:visible`,
    },
    children,
  };
}

/** Wraps a rendered math SVG with the clipboard/layout metadata expected by ChatMarkdown. */
export function wrapMathSvg(svg: ElElement, tex: string, display: boolean): ElElement {
  const trimmed = tex.trim();
  return {
    type: "element",
    tagName: "span",
    properties: display
      ? {
          className: ["chat-markdown-math-display", "block", ...MATH_SCROLL],
          dataMarkdownMath: "display",
          dataMarkdownCopy: `\\[\n${trimmed}\n\\]\n\n`,
        }
      : {
          className: ["inline-block", "align-middle", ...MATH_SCROLL],
          dataMarkdownMath: "inline",
          dataMarkdownCopy: `\\(${trimmed}\\)`,
        },
    children: [svg],
  };
}
