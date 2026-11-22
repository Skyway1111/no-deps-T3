// Zero-dependency semantic OOXML engine: Word pages, Excel workbooks and PowerPoint slides as plain, cloneable data.
import { checkZipDirectory } from "@t3tools/client-runtime/zip/directory";
import { openZip, type NativeZipReader } from "@t3tools/client-runtime/zip/native-zip";
import {
  OFFICE_PREVIEW_MAX_BYTES,
  OFFICE_PREVIEW_MAX_COLUMNS,
  OFFICE_PREVIEW_MAX_ROWS,
} from "../officePreviewProtocol";
import { PreviewError } from "../previewFailure";

export type XmlNode = {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
};
const ENTITY: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const decodeEntities = (s: string) =>
  s.indexOf("&") < 0
    ? s
    : s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
        e[0] === "#"
          ? String.fromCodePoint(
              e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)),
            )
          : (ENTITY[e] ?? m),
      );

/** A non-validating parser: element names lose their namespace prefix, attributes keep theirs. */
function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  const attrPattern = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    const top = stack[stack.length - 1]!;
    if (lt < 0) {
      top.text += decodeEntities(xml.slice(i));
      break;
    }
    if (lt > i) top.text += decodeEntities(xml.slice(i, lt));
    if (xml.startsWith("<!--", lt)) i = (xml.indexOf("-->", lt) + 1 || xml.length) + 2;
    else if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt);
      top.text += xml.slice(lt + 9, end < 0 ? xml.length : end);
      i = end < 0 ? xml.length : end + 3;
    } else if (xml.startsWith("<?", lt)) i = (xml.indexOf("?>", lt) + 1 || xml.length) + 1;
    else if (xml.startsWith("<!", lt)) throw new PreviewError({ code: "office-xml-declarations" });
    else {
      const gt = xml.indexOf(">", lt);
      if (gt < 0) break;
      const tag = xml.slice(lt + 1, gt);
      i = gt + 1;
      if (tag[0] === "/") {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const selfClosing = tag.endsWith("/");
      const body = selfClosing ? tag.slice(0, -1) : tag;
      const space = body.search(/\s/);
      const qualified = space < 0 ? body : body.slice(0, space);
      const node: XmlNode = {
        name: qualified.slice(qualified.indexOf(":") + 1),
        attrs: {},
        children: [],
        text: "",
      };
      if (space >= 0)
        for (const m of body.slice(space).matchAll(attrPattern))
          node.attrs[m[1]!] = decodeEntities(m[2] ?? m[3] ?? "");
      top.children.push(node);
      if (!selfClosing) stack.push(node);
    }
  }
  return root;
}
const kid = (node: XmlNode | undefined, name: string) =>
  node?.children.find((c) => c.name === name);
const kids = (node: XmlNode | undefined, name: string) =>
  node?.children.filter((c) => c.name === name) ?? [];
function find(node: XmlNode | undefined, name: string): XmlNode | undefined {
  if (!node) return undefined;
  for (const child of node.children) {
    if (child.name === name) return child;
    const found = find(child, name);
    if (found) return found;
  }
  return undefined;
}
function findAll(node: XmlNode | undefined, name: string, out: XmlNode[] = []) {
  for (const child of node?.children ?? []) {
    if (child.name === name) out.push(child);
    else findAll(child, name, out);
  }
  return out;
}
const at = (node: XmlNode | undefined, name: string) =>
  node?.attrs[name] ?? node?.attrs[name.slice(name.indexOf(":") + 1)];
const numAt = (node: XmlNode | undefined, name: string, fallback = 0) => {
  const v = Number(at(node, name));
  return Number.isFinite(v) && at(node, name) !== undefined ? v : fallback;
};
const onOff = (node: XmlNode | undefined) =>
  node
    ? !["0", "false", "off", "none"].includes(at(node, "w:val") ?? at(node, "val") ?? "1")
    : undefined;
const textOf = (node: XmlNode): string => node.text + node.children.map(textOf).join("");

const MIB = 1024 * 1024;
export type OfficeKind = "docx" | "xlsx" | "pptx";

/** Parts are decoded in their declared encoding; Word writes UTF-16 and legacy code pages too. */
function decodeXml(bytes: Uint8Array) {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0))
    return new TextDecoder("utf-16le").decode(bytes);
  if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c))
    return new TextDecoder("utf-16be").decode(bytes);
  const declared = /^<\?xml\s[^?]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(
    new TextDecoder().decode(bytes.subarray(0, 256)),
  )?.[1];
  try {
    return new TextDecoder(declared).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/**
 * The file's ZIP, with every read charged to one expansion budget: a small archive must not inflate into an unbounded
 * allocation. Each part is read once; parsed parts are cached until `forget`.
 */
export class OfficePackage {
  readonly zip: NativeZipReader;
  private readonly cache = new Map<string, Promise<XmlNode | undefined>>();
  private readonly charged = new Set<string>();
  private readonly partLimit: number;
  private remaining: number;
  /** Set when a part was cut short to stay within its limit. */
  truncated = false;
  constructor(zip: NativeZipReader, partLimit: number, budget: number) {
    this.zip = zip;
    this.partLimit = partLimit;
    this.remaining = budget;
  }
  static open(bytes: ArrayBuffer | Uint8Array, kind: OfficeKind) {
    const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (buffer.byteLength > OFFICE_PREVIEW_MAX_BYTES)
      throw new PreviewError({ code: "document-too-large" });
    let zip: NativeZipReader;
    try {
      checkZipDirectory(buffer.buffer as ArrayBuffer);
      zip = openZip(buffer, { maxEntries: 2048 });
    } catch (cause) {
      throw /entry limit/.test(String(cause))
        ? new PreviewError({ code: "office-too-many-entries" })
        : new PreviewError({ code: "office-invalid" });
    }
    return kind === "xlsx"
      ? new OfficePackage(
          zip,
          64 * MIB,
          Math.min(128 * MIB, Math.max(buffer.byteLength * 200, 8 * MIB)),
        )
      : new OfficePackage(zip, 8 * MIB, 50 * MIB);
  }
  has(path: string) {
    return !!this.zip.getEntry(path);
  }
  /** Reads a part's bytes against the budget; with `prefix`, a part over its limit keeps its start and marks the package truncated. */
  async read(path: string, prefix = false): Promise<Uint8Array | undefined> {
    const entry = this.zip.getEntry(path);
    if (!entry) return undefined;
    const limit = Math.min(this.partLimit, this.remaining);
    const chunks: Uint8Array[] = [];
    let length = 0;
    const full = Symbol("limit");
    try {
      await this.zip.streamEntry(entry, {
        onChunk: (chunk) => {
          if (length + chunk.length > limit) {
            if (!prefix || limit < this.partLimit)
              throw new PreviewError({ code: "office-too-large-expanded" });
            chunks.push(chunk.subarray(0, limit - length));
            length = limit;
            throw full;
          }
          chunks.push(chunk);
          length += chunk.length;
        },
      });
    } catch (cause) {
      if (cause !== full) throw cause;
      this.truncated = true;
    }
    if (!this.charged.has(path)) {
      this.charged.add(path);
      this.remaining -= length;
    }
    if (chunks.length === 1) return chunks[0]!;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
  async text(path: string) {
    const bytes = await this.read(path);
    return bytes ? decodeXml(bytes) : "";
  }
  xml(path: string, prefix = false) {
    let part = this.cache.get(path);
    if (!part) {
      part = this.read(path, prefix).then((bytes) =>
        bytes ? parseXml(decodeXml(bytes)) : undefined,
      );
      this.cache.set(path, part);
    }
    return part;
  }
  /** Drops a parsed part that its reader has extracted everything from. */
  forget(path: string | undefined) {
    if (path) this.cache.delete(path);
  }
  bytes(path: string) {
    return this.read(path);
  }
  private readonly relsCache = new Map<
    string,
    Promise<Map<string, { target: string; type: string; external: boolean }>>
  >();
  /** A part's relationships by id, with targets resolved to package paths (or kept as external URLs). */
  rels(path: string) {
    let rels = this.relsCache.get(path);
    if (!rels) this.relsCache.set(path, (rels = this.readRels(path)));
    return rels;
  }
  private async readRels(path: string) {
    const slash = path.lastIndexOf("/");
    const xml = await this.xml(`${path.slice(0, slash + 1)}_rels/${path.slice(slash + 1)}.rels`);
    const out = new Map<string, { target: string; type: string; external: boolean }>();
    for (const rel of kids(kid(xml, "Relationships"), "Relationship")) {
      const external = at(rel, "TargetMode") === "External";
      const target = at(rel, "Target") ?? "";
      out.set(at(rel, "Id") ?? "", {
        target: external ? target : resolvePath(path.slice(0, slash + 1), target),
        type: (at(rel, "Type") ?? "").split("/").pop() ?? "",
        external,
      });
    }
    return out;
  }
}
function resolvePath(base: string, target: string) {
  const parts = (target.startsWith("/") ? target.slice(1) : base + target).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part !== ".") out.push(part);
  }
  return out.join("/");
}
const mimeOf = (path: string) =>
  ({
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    bmp: "image/bmp",
    webp: "image/webp",
    svg: "image/svg+xml",
    tif: "image/tiff",
    tiff: "image/tiff",
  })[path.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";

export type Paint =
  | {
      readonly t: "text";
      x: number;
      y: number;
      text: string;
      font: string;
      size: number;
      color: string;
      underline?: boolean | undefined;
      strike?: boolean | undefined;
      link?: string | undefined;
      width: number;
    }
  | {
      readonly t: "rect";
      x: number;
      y: number;
      w: number;
      h: number;
      fill?: string | undefined;
      stroke?: string | undefined;
      lineWidth?: number;
      shape?: string | undefined;
      rotation?: number;
    }
  | {
      readonly t: "line";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      color: string;
      width: number;
    }
  | {
      readonly t: "image";
      x: number;
      y: number;
      w: number;
      h: number;
      image: number;
      crop?: [number, number, number, number];
    };
export type OfficeFrame = {
  width: number;
  height: number;
  background?: string | undefined;
  items: Paint[];
  hidden?: boolean;
  notes?: string;
};
export type OfficeImage = { mime: string; bytes: Uint8Array };
export type Measure = (text: string, font: string) => number;

/** Character-count metrics for environments without a canvas. */
const approximateMeasure: Measure = (text, font) => {
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16);
  let w = 0;
  for (const ch of text)
    w +=
      ch === " "
        ? 0.28
        : /[iljtf.,;:!|']/.test(ch)
          ? 0.3
          : /[A-Z]/.test(ch)
            ? 0.65
            : /[mw]/.test(ch)
              ? 0.8
              : ch.codePointAt(0)! > 0x2e80
                ? 1
                : 0.52;
  return w * size * (/\b(700|bold)\b/.test(font) ? 1.06 : 1);
};

const fontCss = (family: string, px: number, bold?: boolean, italic?: boolean) => {
  const fallback = /mono|courier|consol/i.test(family)
    ? "monospace"
    : /times|georgia|garamond|cambria|serif|roman/i.test(family) && !/sans/i.test(family)
      ? "serif"
      : "sans-serif";
  const alias = /calibri/i.test(family)
    ? `"Carlito", `
    : /cambria/i.test(family)
      ? `"Caladea", `
      : "";
  return `${italic ? "italic " : ""}${bold ? 700 : 400} ${Math.max(1, Math.round(px * 100) / 100)}px "${family.replace(/"/g, "")}", ${alias}${fallback}`;
};

type Run = {
  text: string;
  font: string;
  size: number;
  color: string;
  underline?: boolean | undefined;
  strike?: boolean | undefined;
  link?: string | undefined;
  image?: {
    index: number;
    w: number;
    h: number;
    crop?: [number, number, number, number] | undefined;
  };
  breakAfter?: "line" | "page";
  tab?: boolean;
  highlight?: string | undefined;
  baseline?: number;
};
type Line = {
  items: { x: number; text: string; run: Run; width: number }[];
  width: number;
  ascent: number;
  height: number;
  spaces: number;
  last: boolean;
  pageBreak?: boolean;
};

/** Shares one bounded width cache across a whole layout, so repeated words are measured once. */
function memoMeasure(measure: Measure): Measure {
  const cache = new Map<string, number>();
  return (text, font) => {
    const key = `${font}\u0000${text}`;
    let w = cache.get(key);
    if (w === undefined) {
      if (cache.size > 100_000) cache.clear();
      cache.set(key, (w = measure(text, font)));
    }
    return w;
  };
}

/** Greedy line breaking over measured word tokens: each token is measured once, so a paragraph is O(n). */
function breakLines(
  runs: Run[],
  width: number,
  measureToken: Measure,
  firstIndent = 0,
  lineSpacing = 1.15,
  tabStop = 48,
): Line[] {
  const lines: Line[] = [];
  let line: Line = { items: [], width: 0, ascent: 0, height: 0, spaces: 0, last: false };
  let limit = width - firstIndent;
  let x = firstIndent;
  const push = (last: boolean) => {
    if (!line.height) {
      const size = runs[0]?.size ?? 16;
      line.height = size * lineSpacing * 1.2;
      line.ascent = size * 0.95;
    }
    line.last = last;
    while (line.items.length && !line.items.at(-1)!.text.trim() && !line.items.at(-1)!.run.image) {
      const removed = line.items.pop()!;
      line.width -= removed.width;
      line.spaces -= removed.text.length;
    }
    lines.push(line);
    line = { items: [], width: 0, ascent: 0, height: 0, spaces: 0, last: false };
    x = 0;
    limit = width;
  };
  const place = (text: string, run: Run, w: number) => {
    line.items.push({ x, text, run, width: w });
    x += w;
    line.width = x;
    const h = run.image ? run.image.h : run.size * lineSpacing * 1.2;
    line.height = Math.max(line.height, h);
    line.ascent = Math.max(line.ascent, run.image ? run.image.h : run.size * 0.95);
    if (!text.trim() && !run.image) line.spaces += text.length;
  };
  for (const run of runs) {
    if (run.image) {
      if (x > 0 && x + run.image.w > limit) push(false);
      const fit = Math.min(1, width / run.image.w);
      place(
        "",
        fit < 1
          ? { ...run, image: { ...run.image, w: run.image.w * fit, h: run.image.h * fit } }
          : run,
        run.image.w * fit,
      );
    } else if (run.tab) {
      // Within a hanging indent the first tab reaches the indent itself.
      place(" ", run, x < 0 ? -x : Math.max(8, tabStop - (x % tabStop)));
    } else {
      for (const token of run.text.split(/(\s+)/)) {
        if (!token) continue;
        const space = !token.trim();
        let w = measureToken(token, run.font);
        if (!space && x + w > limit + 0.01 && x > 0) push(false);
        if (space && x === 0 && lines.length) continue;
        if (!space && w > limit + 0.01) {
          // A word longer than the line breaks between characters.
          let chunk = "";
          for (const ch of token) {
            const cw = measureToken(chunk + ch, run.font);
            if (cw > limit - x && chunk) {
              place(chunk, run, measureToken(chunk, run.font));
              push(false);
              chunk = ch;
            } else chunk += ch;
          }
          w = measureToken(chunk, run.font);
          place(chunk, run, w);
          continue;
        }
        place(token, run, w);
      }
    }
    if (run.breakAfter) {
      line.pageBreak = run.breakAfter === "page";
      push(false);
    }
  }
  if (line.items.length || !lines.length) push(true);
  else lines.at(-1)!.last = true;
  return lines;
}

type Edge = { color: string; width: number } | null;
type ParaStyle = {
  align?: string;
  left?: number;
  right?: number;
  first?: number;
  before?: number;
  after?: number;
  line?: number;
  lineRule?: string;
  heading?: number;
  numId?: string;
  level?: number;
  shading?: string;
  pageBreakBefore?: boolean;
  keepNext?: boolean;
  contextual?: boolean;
  borderTop?: Edge;
  borderBottom?: Edge;
};
type RunStyle = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  size?: number;
  color?: string;
  font?: string;
  highlight?: string;
  caps?: boolean;
  vertAlign?: string;
};
type Styled = { p: ParaStyle; r: RunStyle };
const TWIP = 96 / 1440;
const EMU = 1 / 9525;
const PT = 96 / 72;
const HIGHLIGHT: Record<string, string> = {
  yellow: "#ffff00",
  green: "#00ff00",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  blue: "#0000ff",
  red: "#ff0000",
  darkBlue: "#000080",
  darkCyan: "#008080",
  darkGreen: "#008000",
  darkMagenta: "#800080",
  darkRed: "#800000",
  darkYellow: "#808000",
  darkGray: "#808080",
  lightGray: "#c0c0c0",
  black: "#000000",
};
// Symbol and Wingdings bullets live in the private use area; these are their Unicode look-alikes.
const BULLET: Record<string, string> = {
  "": "•",
  "": "▪",
  "": "◆",
  "": "➢",
  "": "➔",
  "": "❖",
  "": "✓",
  "": "■",
  "": "❑",
  "": "◆",
  o: "◦",
  "§": "▪",
  "·": "•",
  "": "•",
};
const bulletText = (text: string) => BULLET[text] ?? (/[-]/.test(text) ? "•" : text);

function borderOf(node: XmlNode | undefined): Edge | undefined {
  if (!node) return undefined;
  const val = at(node, "w:val") ?? "single";
  if (val === "nil" || val === "none") return null;
  const color = at(node, "w:color");
  return {
    color: !color || color === "auto" ? "#000000" : `#${color}`,
    width: Math.max(0.75, (numAt(node, "w:sz", 4) / 8) * PT) * (/double|Gap/.test(val) ? 2 : 1),
  };
}
function readPPr(pPr: XmlNode | undefined): ParaStyle {
  if (!pPr) return {};
  const out: ParaStyle = {};
  const ind = kid(pPr, "ind");
  const spacing = kid(pPr, "spacing");
  const jc = at(kid(pPr, "jc"), "w:val");
  if (jc)
    out.align =
      jc === "both" || jc === "distribute"
        ? "justify"
        : jc === "end"
          ? "right"
          : jc === "start"
            ? "left"
            : jc;
  const twips = (node: XmlNode | undefined, ...names: string[]) =>
    names.map((n) => at(node, n)).find((v) => v !== undefined);
  if (ind) {
    const left = twips(ind, "w:left", "w:start");
    const right = twips(ind, "w:right", "w:end");
    if (left !== undefined) out.left = Number(left) * TWIP;
    if (right !== undefined) out.right = Number(right) * TWIP;
    if (at(ind, "w:firstLine") !== undefined) out.first = numAt(ind, "w:firstLine") * TWIP;
    if (at(ind, "w:hanging") !== undefined) out.first = -numAt(ind, "w:hanging") * TWIP;
  }
  if (spacing) {
    if (at(spacing, "w:before") !== undefined) out.before = numAt(spacing, "w:before") * TWIP;
    if (at(spacing, "w:after") !== undefined) out.after = numAt(spacing, "w:after") * TWIP;
    if (at(spacing, "w:beforeAutospacing") === "1") out.before = 14 * PT;
    if (at(spacing, "w:afterAutospacing") === "1") out.after = 14 * PT;
    if (at(spacing, "w:line") !== undefined) {
      out.line = numAt(spacing, "w:line");
      out.lineRule = at(spacing, "w:lineRule") ?? "auto";
    }
  }
  const numPr = kid(pPr, "numPr");
  const numId = at(kid(numPr, "numId"), "w:val");
  if (numId !== undefined) out.numId = numId;
  if (kid(numPr, "ilvl")) out.level = numAt(kid(numPr, "ilvl"), "w:val");
  const outline = kid(pPr, "outlineLvl");
  if (outline) out.heading = numAt(outline, "w:val") + 1;
  const shd = at(kid(pPr, "shd"), "w:fill");
  if (shd && shd !== "auto") out.shading = `#${shd}`;
  for (const [key, name] of [
    ["pageBreakBefore", "pageBreakBefore"],
    ["keepNext", "keepNext"],
    ["contextual", "contextualSpacing"],
  ] as const) {
    const flag = onOff(kid(pPr, name));
    if (flag !== undefined) out[key] = flag;
  }
  const bdr = kid(pPr, "pBdr");
  const top = borderOf(kid(bdr, "top"));
  const bottom = borderOf(kid(bdr, "bottom"));
  if (top !== undefined) out.borderTop = top;
  if (bottom !== undefined) out.borderBottom = bottom;
  return out;
}
function readRPr(rPr: XmlNode | undefined): RunStyle {
  if (!rPr) return {};
  const out: RunStyle = {};
  for (const [key, name] of [
    ["bold", "b"],
    ["italic", "i"],
    ["strike", "strike"],
    ["caps", "caps"],
  ] as const) {
    const flag = onOff(kid(rPr, name));
    if (flag !== undefined) out[key] = flag;
  }
  const u = at(kid(rPr, "u"), "w:val");
  if (u) out.underline = u !== "none";
  const size = at(kid(rPr, "sz"), "w:val");
  if (size) out.size = (Number(size) / 2) * PT;
  const color = at(kid(rPr, "color"), "w:val");
  if (color && color !== "auto") out.color = `#${color}`;
  const fonts = kid(rPr, "rFonts");
  const theme = at(fonts, "w:asciiTheme") ?? at(fonts, "w:hAnsiTheme");
  // Theme fonts resolve against the document theme at use: "+major" or "+minor".
  const font = theme
    ? theme.startsWith("major")
      ? "+major"
      : "+minor"
    : (at(fonts, "w:ascii") ?? at(fonts, "w:hAnsi") ?? at(fonts, "w:cs"));
  if (font) out.font = font;
  const highlight = at(kid(rPr, "highlight"), "w:val");
  if (highlight && HIGHLIGHT[highlight]) out.highlight = HIGHLIGHT[highlight];
  const shd = at(kid(rPr, "shd"), "w:fill");
  if (shd && shd !== "auto" && !out.highlight) out.highlight = `#${shd}`;
  const vert = at(kid(rPr, "vertAlign"), "w:val");
  if (vert) out.vertAlign = vert;
  return out;
}

type ListLevel = {
  format: string;
  text: string;
  start: number;
  suffix: string;
  p: ParaStyle;
  r: RunStyle;
};
type DocContext = {
  pkg: OfficePackage;
  styles: Map<
    string,
    Styled & { basedOn: string | undefined; type: string; name: string; node: XmlNode }
  >;
  defaults: Styled;
  defaultTableStyle: string | undefined;
  numbering: Map<string, { levels: (ListLevel | undefined)[]; key: string }>;
  counters: Map<string, number[]>;
  rels: Map<string, { target: string; type: string; external: boolean }>;
  images: OfficeImage[];
  imageIndex: Map<string, number>;
  theme: { major: string; minor: string };
  measure: Measure;
  page: { number: number; count: number };
  recordBookmarks: boolean;
};

function styleChain<T>(ctx: DocContext, id: string | undefined, pick: (s: Styled) => T): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (
    let s = id ? ctx.styles.get(id) : undefined;
    s && !seen.has(s.name);
    s = s.basedOn ? ctx.styles.get(s.basedOn) : undefined
  ) {
    seen.add(s.name);
    out.unshift(pick(s));
  }
  return out;
}

function formatCounter(value: number, format: string) {
  const roman = (n: number) => {
    let out = "";
    for (const [v, s] of [
      [1000, "m"],
      [900, "cm"],
      [500, "d"],
      [400, "cd"],
      [100, "c"],
      [90, "xc"],
      [50, "l"],
      [40, "xl"],
      [10, "x"],
      [9, "ix"],
      [5, "v"],
      [4, "iv"],
      [1, "i"],
    ] as const)
      while (n >= v) {
        out += s;
        n -= v;
      }
    return out;
  };
  const letter = (n: number) =>
    String.fromCharCode(97 + ((n - 1) % 26)).repeat(Math.floor((n - 1) / 26) + 1);
  switch (format) {
    case "lowerLetter":
      return letter(value);
    case "upperLetter":
      return letter(value).toUpperCase();
    case "lowerRoman":
      return roman(value);
    case "upperRoman":
      return roman(value).toUpperCase();
    case "decimalZero":
      return String(value).padStart(2, "0");
    case "none":
      return "";
    default:
      return String(value);
  }
}

const parseLevel = (lvl: XmlNode): ListLevel => ({
  format: at(kid(lvl, "numFmt"), "w:val") ?? "decimal",
  text: at(kid(lvl, "lvlText"), "w:val") ?? "",
  start: numAt(kid(lvl, "start"), "w:val", 1),
  suffix: at(kid(lvl, "suff"), "w:val") ?? "tab",
  p: readPPr(kid(lvl, "pPr")),
  r: readRPr(kid(lvl, "rPr")),
});

/** A preferred width: dxa twips, or pct in fiftieths of a percent ("5000" or "100%") of `of`. */
function widthOf(node: XmlNode | undefined, of: number) {
  const type = at(node, "w:type") ?? "dxa";
  const raw = at(node, "w:w");
  if (!node || raw === undefined || type === "auto" || type === "nil") return undefined;
  const value =
    type === "pct" || raw.endsWith("%")
      ? (raw.endsWith("%") ? parseFloat(raw) / 100 : Number(raw) / 5000) * of
      : Number(raw) * TWIP;
  return value > 0 && Number.isFinite(value) ? value : undefined;
}
// Shading: a color, null when explicitly clear, undefined when unspecified.
function shadingOf(node: XmlNode | undefined) {
  const shd = kid(node, "shd");
  if (!shd) return undefined;
  const fill = at(shd, "w:fill");
  const color = at(shd, "w:color");
  if (at(shd, "w:val") === "solid" && color && color !== "auto") return `#${color}`;
  return fill && fill !== "auto" ? `#${fill}` : null;
}

type Sides = "top" | "left" | "bottom" | "right";
type TableCell = {
  tc: XmlNode;
  col: number;
  span: number;
  merge: "restart" | "continue" | undefined;
  below: boolean;
  style: Styled;
  fill: string | undefined;
  edges: Record<Sides, Edge | undefined>;
  pad: Record<Sides, number>;
  valign: string;
  min: number;
  max: number;
  pref: XmlNode | undefined;
};
type TableRow = {
  cells: TableCell[];
  header: boolean;
  height: number;
  rule: string;
  cantSplit: boolean;
};
type TableInfo = {
  rows: TableRow[];
  columns: number;
  grid: number[];
  min: number[];
  max: number[];
  fixed: boolean;
  tblW: XmlNode | undefined;
  indent: number;
  jc: string | undefined;
};
type Laid = { x: number; w: number; items: Paint[]; height: number };
const extent = (item: Paint): [number, number] =>
  item.t === "text"
    ? [item.y - item.size * 0.95, item.y + item.size * 0.3]
    : item.t === "line"
      ? [Math.min(item.y1, item.y2), Math.max(item.y1, item.y2)]
      : [item.y, item.y + item.h];

export type WordDocumentModel = {
  pages: OfficeFrame[];
  images: OfficeImage[];
  bookmarks: Record<string, { page: number; y: number }>;
  /** The body was cut short: past 8 MiB of XML or 1,000 pages. */
  truncated: boolean;
};

const MAX_WORD_PAGES = 1000;
/** Stops layout once the page limit is reached; the pages so far are kept. */
const PAGE_LIMIT = Symbol("page limit");

export async function layoutDocx(
  bytes: ArrayBuffer | Uint8Array,
  measure: Measure = approximateMeasure,
): Promise<WordDocumentModel> {
  const pkg = OfficePackage.open(bytes, "docx");
  const rootRels = await pkg.rels("");
  const mainPath =
    [...rootRels.values()].find((r) => r.type === "officeDocument")?.target ?? "word/document.xml";
  if (!pkg.has(mainPath)) throw new PreviewError({ code: "office-not-open-xml" });
  const document = await pkg.xml(mainPath, true);
  const body = find(document, "body");
  if (!body) throw new PreviewError({ code: "word-no-body" });
  const rels = await pkg.rels(mainPath);
  const partOf = (type: string) => [...rels.values()].find((r) => r.type === type)?.target;
  const ctx: DocContext = {
    pkg,
    styles: new Map(),
    defaults: { p: {}, r: {} },
    defaultTableStyle: undefined,
    numbering: new Map(),
    counters: new Map(),
    rels,
    images: [],
    imageIndex: new Map(),
    theme: { major: "Calibri Light", minor: "Calibri" },
    measure: memoMeasure(measure),
    page: { number: 1, count: 1 },
    recordBookmarks: true,
  };
  const theme = partOf("theme") ? await pkg.xml(partOf("theme")!) : undefined;
  ctx.theme = {
    major: at(find(find(theme, "majorFont"), "latin"), "typeface") ?? "Calibri Light",
    minor: at(find(find(theme, "minorFont"), "latin"), "typeface") ?? "Calibri",
  };
  const family = (font: string | undefined) =>
    font === "+major" ? ctx.theme.major : !font || font === "+minor" ? ctx.theme.minor : font;
  const settings = partOf("settings") ? await pkg.xml(partOf("settings")!) : undefined;
  const evenOdd = onOff(find(settings, "evenAndOddHeaders")) ?? false;
  const tabStop = numAt(find(settings, "defaultTabStop"), "w:val", 720) * TWIP || 48;
  const styles = partOf("styles") ? await pkg.xml(partOf("styles")!) : undefined;
  const docDefaults = find(styles, "docDefaults");
  ctx.defaults = { p: readPPr(find(docDefaults, "pPr")), r: readRPr(find(docDefaults, "rPr")) };
  for (const style of kids(kid(styles, "styles"), "style")) {
    const id = at(style, "w:styleId") ?? "";
    const name = at(kid(style, "name"), "w:val") ?? id;
    const type = at(style, "w:type") ?? "";
    const p = readPPr(kid(style, "pPr"));
    const heading = /^heading (\d)$/i.exec(name) ?? /^Heading(\d)$/.exec(id);
    if (heading) p.heading = Number(heading[1]);
    if (/^title$/i.test(name)) p.heading = 0;
    if (type === "table" && at(style, "w:default") === "1") ctx.defaultTableStyle = id;
    ctx.styles.set(id, {
      p,
      r: readRPr(kid(style, "rPr")),
      basedOn: at(kid(style, "basedOn"), "w:val"),
      type,
      name,
      node: style,
    });
  }
  // Documents that use built-in styles without defining them get Word's own defaults.
  const builtin = (id: string, p: ParaStyle, r: RunStyle) => {
    if (!ctx.styles.has(id))
      ctx.styles.set(id, {
        p,
        r,
        basedOn: "Normal",
        type: "paragraph",
        name: id,
        node: { name: "style", attrs: {}, children: [], text: "" },
      });
  };
  [16, 13, 12, 11, 11, 11].forEach((pt, i) =>
    builtin(
      `Heading${i + 1}`,
      { heading: i + 1, before: (i ? 2 : 12) * PT, after: 0, keepNext: true },
      { size: pt * PT, color: i > 1 ? "#1F3763" : "#2F5496", font: "+major", italic: i === 3 },
    ),
  );
  builtin("Title", { heading: 0, after: 0 }, { size: 28 * PT, font: "+major" });
  builtin("ListParagraph", { left: 48, contextual: true }, {});
  const numbering = partOf("numbering") ? await pkg.xml(partOf("numbering")!) : undefined;
  const abstracts = new Map<string, XmlNode>();
  for (const abstract of kids(kid(numbering, "numbering"), "abstractNum"))
    abstracts.set(at(abstract, "w:abstractNumId") ?? "", abstract);
  for (const num of kids(kid(numbering, "numbering"), "num")) {
    const abstractId = at(kid(num, "abstractNumId"), "w:val") ?? "";
    const levels: (ListLevel | undefined)[] = [];
    for (const lvl of kids(abstracts.get(abstractId), "lvl"))
      levels[numAt(lvl, "w:ilvl")] = parseLevel(lvl);
    let own = false;
    for (const override of kids(num, "lvlOverride")) {
      const level = numAt(override, "w:ilvl");
      if (kid(override, "lvl")) levels[level] = parseLevel(kid(override, "lvl")!);
      const start = kid(override, "startOverride");
      if (start && levels[level])
        levels[level] = { ...levels[level], start: numAt(start, "w:val", 1) };
      own ||= !!start;
    }
    // Lists sharing an abstract definition continue one another unless a num restarts its own count.
    ctx.numbering.set(at(num, "w:numId") ?? "", {
      levels,
      key: own ? `num:${at(num, "w:numId")}` : `abstract:${abstractId}`,
    });
  }

  // Sections: each paragraph-level sectPr closes a section, the body's closes the last.
  type Geometry = {
    width: number;
    height: number;
    top: number;
    bottom: number;
    left: number;
    right: number;
    header: number;
    footer: number;
  };
  const sectPrs = [
    ...body.children.flatMap((c) =>
      c.name === "p" && kid(kid(c, "pPr"), "sectPr") ? [kid(kid(c, "pPr"), "sectPr")!] : [],
    ),
    kid(body, "sectPr"),
  ];
  const sections = sectPrs.map((sect) => {
    const pgSz = kid(sect, "pgSz");
    const pgMar = kid(sect, "pgMar");
    const geometry: Geometry = {
      width: numAt(pgSz, "w:w", 12240) * TWIP,
      height: numAt(pgSz, "w:h", 15840) * TWIP,
      top: Math.abs(numAt(pgMar, "w:top", 1440)) * TWIP,
      bottom: Math.abs(numAt(pgMar, "w:bottom", 1440)) * TWIP,
      left: numAt(pgMar, "w:left", 1440) * TWIP,
      right: numAt(pgMar, "w:right", 1440) * TWIP,
      header: numAt(pgMar, "w:header", 720) * TWIP,
      footer: numAt(pgMar, "w:footer", 720) * TWIP,
    };
    const refs = (name: string) =>
      Object.fromEntries(
        kids(sect, name).map((ref) => [
          at(ref, "w:type") ?? "default",
          rels.get(at(ref, "r:id") ?? "")?.target,
        ]),
      );
    return {
      geometry,
      header: refs("headerReference"),
      footer: refs("footerReference"),
      titlePg: onOff(kid(sect, "titlePg")) ?? false,
      type: at(kid(sect, "type"), "w:val") ?? "nextPage",
    };
  });
  // Headers and footers a section leaves out carry over from the section before.
  sections.forEach((s, i) => {
    if (i)
      for (const key of ["header", "footer"] as const)
        s[key] = { ...sections[i - 1]![key], ...s[key] };
  });
  let section = 0;
  let page = sections[0]!.geometry;
  const pageBottom = () => page.height - page.bottom;
  const pages: OfficeFrame[] = [];
  const pageSection: number[] = [];
  const bookmarks: WordDocumentModel["bookmarks"] = {};
  let frame: OfficeFrame = { width: page.width, height: page.height, items: [] };
  const newPage = () => {
    if (pages.length >= MAX_WORD_PAGES) throw PAGE_LIMIT;
    frame = { width: page.width, height: page.height, items: [] };
    pages.push(frame);
    pageSection.push(section);
    ctx.page.number = pages.length;
  };
  newPage();

  // Blocks render into a target that may be a page (paginating) or a table cell (measured, then placed).
  type Target = {
    items: Paint[];
    y: number;
    paginate: boolean;
    style?: Styled | undefined;
    prev?: { style: string; after: number; contextual: boolean } | undefined;
  };
  const breakPage = (target: Target) => {
    newPage();
    target.y = page.top;
    target.items = frame.items;
    target.prev = undefined;
  };
  const imageFor = async (rid: string) => {
    const rel = ctx.rels.get(rid);
    if (!rel || rel.external) return -1;
    if (ctx.imageIndex.has(rel.target)) return ctx.imageIndex.get(rel.target)!;
    const data = await pkg.bytes(rel.target);
    const index = data ? ctx.images.push({ mime: mimeOf(rel.target), bytes: data }) - 1 : -1;
    ctx.imageIndex.set(rel.target, index);
    return index;
  };
  const runBase = (r: RunStyle, link: string | undefined): Run => {
    const px = (r.size ?? 14.67) * (r.vertAlign && r.vertAlign !== "baseline" ? 0.65 : 1);
    return {
      text: "",
      font: fontCss(family(r.font), px, r.bold, r.italic),
      size: px,
      color: r.color ?? (link ? "#0563c1" : "#000000"),
      underline: r.underline ?? !!link,
      strike: r.strike,
      link,
      highlight: r.highlight,
      baseline:
        r.vertAlign === "superscript" ? -px * 0.5 : r.vertAlign === "subscript" ? px * 0.25 : 0,
    };
  };
  const fieldValue = (instr: string) => {
    const name = /^\s*(\w+)/.exec(instr)?.[1]?.toUpperCase();
    return name === "PAGE"
      ? String(ctx.page.number)
      : name === "NUMPAGES" || name === "SECTIONPAGES"
        ? String(ctx.page.count)
        : undefined;
  };
  const runsOf = async (
    p: XmlNode,
    paragraphRun: RunStyle,
  ): Promise<{ runs: Run[]; bookmarks: string[] }> => {
    const runs: Run[] = [];
    const names: string[] = [];
    // Complex fields: instruction runs are hidden; PAGE-like results are recomputed, HYPERLINK results link.
    const fields: {
      instr: string;
      result: boolean;
      replaced: boolean;
      link?: string | undefined;
    }[] = [];
    const visit = async (node: XmlNode, link: string | undefined) => {
      for (const child of node.children) {
        if (child.name === "r") {
          const rPr = kid(child, "rPr");
          const r: RunStyle = Object.assign(
            {},
            paragraphRun,
            ...styleChain(ctx, at(kid(rPr, "rStyle"), "w:val"), (s) => s.r),
            readRPr(rPr),
          );
          const base = runBase(r, link);
          for (const part of child.children) {
            const field = fields.at(-1);
            if (part.name === "fldChar") {
              const type = at(part, "w:fldCharType");
              if (type === "begin") fields.push({ instr: "", result: false, replaced: false });
              else if (type === "separate" && field) {
                field.result = true;
                const value = fieldValue(field.instr);
                if (value !== undefined) {
                  runs.push({ ...base, text: value });
                  field.replaced = true;
                }
                const target = /^\s*HYPERLINK\s+(\\l\s+)?"([^"]+)"/i.exec(field.instr);
                if (target) field.link = target[1] ? `#${target[2]}` : target[2];
              } else if (type === "end") {
                const done = fields.pop();
                const value = done && !done.result ? fieldValue(done.instr) : undefined;
                if (value !== undefined) runs.push({ ...base, text: value });
              }
              continue;
            }
            if (part.name === "instrText") {
              if (field && !field.result) field.instr += part.text;
              continue;
            }
            if (fields.some((f) => !f.result || f.replaced)) continue;
            const fieldLink = link ? undefined : fields.findLast((f) => f.link)?.link;
            const styled = fieldLink ? runBase(r, fieldLink) : base;
            if (part.name === "t")
              runs.push({ ...styled, text: r.caps ? part.text.toUpperCase() : part.text });
            else if (part.name === "tab" || part.name === "ptab")
              runs.push({ ...styled, text: " ", tab: true });
            else if (part.name === "br" || part.name === "cr")
              runs.push({
                ...styled,
                text: "",
                breakAfter: at(part, "w:type") === "page" ? "page" : "line",
              });
            else if (part.name === "noBreakHyphen") runs.push({ ...styled, text: "‑" });
            else if (part.name === "sym")
              runs.push({
                ...styled,
                text: bulletText(
                  String.fromCharCode(parseInt(at(part, "w:char") ?? "20", 16) & 0xffff),
                ),
              });
            else if (
              part.name === "drawing" ||
              part.name === "AlternateContent" ||
              part.name === "pict" ||
              part.name === "object"
            ) {
              const blip = find(part, "blip");
              const extentNode = find(part, "extent");
              const vml = find(part, "imagedata");
              const rid = at(blip, "r:embed") ?? at(vml, "r:id");
              let size = extentNode
                ? { w: numAt(extentNode, "cx") * EMU, h: numAt(extentNode, "cy") * EMU }
                : undefined;
              if (!size && vml) {
                const css = at(find(part, "shape"), "style") ?? "";
                const length = (name: string) => {
                  const m = new RegExp(`${name}:([\\d.]+)(pt|in|px)`).exec(css);
                  return m ? Number(m[1]) * (m[2] === "pt" ? PT : m[2] === "in" ? 96 : 1) : 0;
                };
                size = { w: length("width"), h: length("height") };
              }
              if (rid && size && size.w > 0 && size.h > 0) {
                const index = await imageFor(rid);
                const crop = kid(find(part, "blipFill"), "srcRect");
                if (index >= 0)
                  runs.push({
                    ...styled,
                    text: "",
                    image: { index, w: size.w, h: size.h, ...(crop ? { crop: cropOf(crop) } : {}) },
                  });
              }
              for (const textbox of findAll(part, "txbxContent").slice(0, 1))
                for (const inner of kids(textbox, "p")) await visit(inner, link);
            }
          }
        } else if (child.name === "hyperlink") {
          const rel = ctx.rels.get(at(child, "r:id") ?? "");
          await visit(
            child,
            rel?.external ? rel.target : at(child, "w:anchor") ? `#${at(child, "w:anchor")}` : link,
          );
        } else if (child.name === "fldSimple") {
          const value = fieldValue(at(child, "w:instr") ?? "");
          if (value === undefined) await visit(child, link);
          else
            runs.push({
              ...runBase(Object.assign({}, paragraphRun, readRPr(find(child, "rPr"))), link),
              text: value,
            });
        } else if (child.name === "bookmarkStart") names.push(at(child, "w:name") ?? "");
        else if (
          ["ins", "smartTag", "sdt", "sdtContent", "customXml", "moveTo", "dir", "bdo"].includes(
            child.name,
          )
        )
          await visit(child, link);
      }
    };
    await visit(p, undefined);
    return { runs, bookmarks: names };
  };

  // Precedence: defaults < table style < paragraph style < numbering < direct; a table style outranks Normal.
  const paraProps = (p: XmlNode, table: Styled | undefined) => {
    const pPr = kid(p, "pPr");
    const styleId = at(kid(pPr, "pStyle"), "w:val") ?? "Normal";
    const own = readPPr(pPr);
    const normal = styleId === "Normal" || !ctx.styles.has(styleId);
    const layer = <T>(pick: (s: Styled) => T) =>
      [
        ctx.defaults,
        ...(table && !normal ? [table] : []),
        ...styleChain(ctx, styleId, (s) => s),
        ...(table && normal ? [table] : []),
      ].map(pick);
    const merged: ParaStyle = Object.assign({}, ...layer((s) => s.p));
    const numId = own.numId ?? merged.numId;
    const level = own.level ?? merged.level ?? 0;
    const list = numId && numId !== "0" ? ctx.numbering.get(numId) : undefined;
    const lvl = list?.levels[level];
    if (lvl) Object.assign(merged, lvl.p);
    Object.assign(merged, own);
    const run: RunStyle = Object.assign({}, ...layer((s) => s.r));
    return {
      styleId,
      merged,
      list,
      lvl,
      level,
      run,
      mark: { ...run, ...readRPr(kid(pPr, "rPr")) },
    };
  };

  const paragraph = async (p: XmlNode, target: Target, width: number, offsetX: number) => {
    const { styleId, merged, list, lvl, level, run, mark } = paraProps(p, target.style);
    const marker: Run[] = [];
    if (lvl && list) {
      const counters = ctx.counters.get(list.key) ?? [];
      for (let i = 0; i < level; i++) counters[i] ??= list.levels[i]?.start ?? 1;
      counters[level] = counters[level] === undefined ? lvl.start : counters[level] + 1;
      counters.length = level + 1;
      ctx.counters.set(list.key, counters);
      const text =
        lvl.format === "bullet"
          ? bulletText(lvl.text)
          : lvl.text.replace(/%(\d)/g, (_, n: string) =>
              formatCounter(
                counters[Number(n) - 1] ?? 1,
                list.levels[Number(n) - 1]?.format ?? "decimal",
              ),
            );
      const r: RunStyle = { ...mark, ...lvl.r, underline: lvl.r.underline ?? false };
      const px = r.size ?? 14.67;
      const base: Run = {
        text,
        font: fontCss(
          r.font && !/symbol|wingdings/i.test(r.font) ? family(r.font) : ctx.theme.minor,
          px,
          r.bold,
          r.italic,
        ),
        size: px,
        color: r.color ?? "#000000",
      };
      if (text)
        marker.push(
          base,
          ...(lvl.suffix === "tab"
            ? [{ ...base, text: " ", tab: true }]
            : lvl.suffix === "space"
              ? [{ ...base, text: " " }]
              : []),
        );
    }
    const { runs, bookmarks: names } = await runsOf(p, run);
    const left = merged.left ?? 0;
    const right = merged.right ?? 0;
    const first = merged.first ?? 0;
    // Without a styles part Word falls back to its Normal template (1.08 lines, 8pt after); with one, to zero.
    const spacing =
      merged.lineRule === "auto" || !merged.lineRule
        ? (merged.line ?? (styles ? 240 : 259)) / 240
        : 1;
    let before = merged.before ?? 0;
    const after = merged.after ?? (styles ? 0 : merged.heading !== undefined ? 4 : 10.67);
    if (target.prev?.style === styleId) {
      if (target.prev.contextual) target.y -= target.prev.after;
      if (merged.contextual) before = 0;
    }
    if (target.paginate && merged.pageBreakBefore && target.y > page.top) breakPage(target);
    if (!(target.paginate && target.y === page.top)) target.y += before;
    const all = [...marker, ...runs];
    const markSize = mark.size ?? 14.67;
    const lines = breakLines(
      all.length
        ? all
        : [{ text: "", font: fontCss(family(mark.font), markSize), size: markSize, color: "#000" }],
      width - left - right,
      ctx.measure,
      first,
      spacing,
      tabStop,
    );
    const fixed =
      merged.lineRule === "exact" || merged.lineRule === "atLeast" ? (merged.line ?? 0) * TWIP : 0;
    const heightOf = (line: Line) =>
      merged.lineRule === "exact" ? fixed : Math.max(line.height, fixed);
    if (target.paginate && merged.keepNext && target.y > page.top) {
      const total = lines.reduce((h, line) => h + heightOf(line), 0) + after + heightOf(lines[0]!);
      if (target.y + total > pageBottom()) breakPage(target);
    }
    if (ctx.recordBookmarks)
      for (const name of names) bookmarks[name] = { page: pages.length - 1, y: target.y };
    const rule = (edge: Edge | undefined, y: number) => {
      if (edge)
        target.items.push({
          t: "line",
          x1: offsetX + left,
          y1: y,
          x2: offsetX + width - right,
          y2: y,
          color: edge.color,
          width: edge.width,
        });
    };
    rule(merged.borderTop, target.y);
    for (const line of lines) {
      const height = heightOf(line);
      if (target.paginate && target.y + height > pageBottom() && target.y > page.top)
        breakPage(target);
      const slack = width - left - right - line.width - (line === lines[0] ? first : 0);
      const align = merged.align ?? "left";
      const shift = align === "center" ? slack / 2 : align === "right" ? slack : 0;
      const stretch = align === "justify" && !line.last && line.spaces ? slack / line.spaces : 0;
      if (merged.shading)
        target.items.push({
          t: "rect",
          x: offsetX + left,
          y: target.y,
          w: width - left - right,
          h: height,
          fill: merged.shading,
        });
      let extra = 0;
      const baseline = target.y + line.ascent + (height - line.height) / 2;
      for (const item of line.items) {
        const x = offsetX + left + shift + item.x + extra;
        if (!item.text.trim() && !item.run.image) extra += stretch * item.text.length;
        const image = item.run.image;
        if (image) {
          target.items.push({
            t: "image",
            x,
            y: baseline - image.h,
            w: image.w,
            h: image.h,
            image: image.index,
            ...(image.crop ? { crop: image.crop } : {}),
          });
          continue;
        }
        if (item.run.highlight)
          target.items.push({
            t: "rect",
            x,
            y: baseline - item.run.size * 0.95,
            w: item.width,
            h: item.run.size * 1.2,
            fill: item.run.highlight,
          });
        if (item.text.trim() || item.run.underline)
          target.items.push({
            t: "text",
            x,
            y: baseline + (item.run.baseline ?? 0),
            text: item.text,
            font: item.run.font,
            size: item.run.size,
            color: item.run.color,
            underline: item.run.underline,
            strike: item.run.strike,
            link: item.run.link,
            width: item.width,
          });
      }
      target.y += height;
      if (line.pageBreak && target.paginate) breakPage(target);
    }
    rule(merged.borderBottom, target.y + 1);
    target.y += after;
    target.prev = { style: styleId, after, contextual: !!merged.contextual };
  };

  // Content widths for autofit: the widest unbreakable word (min) and the unwrapped line (max).
  const paragraphWidths = async (p: XmlNode, table: Styled | undefined) => {
    const { merged, lvl, run } = paraProps(p, table);
    const { runs } = await runsOf(p, run);
    let min = 0;
    let max = 0;
    let line = 0;
    for (const r of runs) {
      if (r.image) {
        min = Math.max(min, r.image.w);
        line += r.image.w;
      } else if (r.tab) line += tabStop;
      else
        for (const token of r.text.split(/(\s+)/)) {
          if (!token) continue;
          const w = ctx.measure(token, r.font);
          line += w;
          if (token.trim()) min = Math.max(min, w);
        }
      if (r.breakAfter) {
        max = Math.max(max, line);
        line = 0;
      }
    }
    const indent = (merged.left ?? 0) + (merged.right ?? 0);
    const first = lvl ? 0 : Math.max(0, merged.first ?? 0);
    return { min: min + indent, max: Math.max(max, line) + indent + first };
  };
  const contentWidths = async (
    container: XmlNode,
    table: Styled | undefined,
  ): Promise<{ min: number; max: number }> => {
    let min = 0;
    let max = 0;
    for (const child of container.children) {
      const m =
        child.name === "p"
          ? await paragraphWidths(child, table)
          : child.name === "tbl"
            ? await nestedWidths(child)
            : child.name === "sdt" || child.name === "customXml"
              ? await contentWidths(kid(child, "sdtContent") ?? child, table)
              : undefined;
      if (!m) continue;
      min = Math.max(min, m.min);
      max = Math.max(max, m.max);
    }
    return { min, max };
  };
  const nestedWidths = async (tbl: XmlNode) => {
    const info = await analyze(tbl);
    const fixed = widthOf(info.tblW, 0);
    if (fixed) return { min: fixed, max: fixed };
    return {
      min: info.min.reduce((s, v) => s + v, 0),
      max: info.max.reduce((s, v, i) => s + Math.max(v, info.grid[i] ?? 0), 0),
    };
  };

  // Table styles: base properties plus conditional formats (header row, banding, first column...).
  const tableStyles = new Map<
    string,
    { styled: Styled; pr: XmlNode[]; tcPr: XmlNode[]; cond: Map<string, XmlNode> }
  >();
  const tableStyle = (id: string | undefined) => {
    const key = id ?? "";
    let cached = tableStyles.get(key);
    if (cached) return cached;
    const chain: XmlNode[] = [];
    const seen = new Set<string>();
    for (
      let cur = id;
      cur && !seen.has(cur) && ctx.styles.has(cur);
      cur = ctx.styles.get(cur)!.basedOn
    ) {
      seen.add(cur);
      chain.push(ctx.styles.get(cur)!.node);
    }
    if (!chain.length && id && /grid/i.test(id)) {
      const edge = (side: string) => `<w:${side} w:val="single" w:sz="4" w:color="auto"/>`;
      chain.push(
        kid(
          parseXml(
            `<w:style><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(edge).join("")}</w:tblBorders></w:tblPr></w:style>`,
          ),
          "style",
        )!,
      );
    }
    const cond = new Map<string, XmlNode>();
    for (const node of [...chain].reverse())
      for (const c of kids(node, "tblStylePr")) cond.set(at(c, "w:type") ?? "", c);
    const ordered = [...chain].reverse();
    cached = {
      styled: {
        p: Object.assign({}, ...ordered.map((n) => readPPr(kid(n, "pPr")))),
        r: Object.assign({}, ...ordered.map((n) => readRPr(kid(n, "rPr")))),
      },
      pr: chain.flatMap((n) => (kid(n, "tblPr") ? [kid(n, "tblPr")!] : [])),
      tcPr: chain.flatMap((n) => (kid(n, "tcPr") ? [kid(n, "tcPr")!] : [])),
      cond,
    };
    tableStyles.set(key, cached);
    return cached;
  };
  const rowsOf = (node: XmlNode, name: string): XmlNode[] =>
    node.children.flatMap((c) =>
      c.name === name
        ? [c]
        : c.name === "sdt"
          ? rowsOf(kid(c, "sdtContent") ?? c, name)
          : c.name === "customXml"
            ? rowsOf(c, name)
            : [],
    );
  const analyzed = new WeakMap<XmlNode, Promise<TableInfo>>();
  const analyze = (tbl: XmlNode) => {
    let info = analyzed.get(tbl);
    if (!info) analyzed.set(tbl, (info = analyzeTable(tbl)));
    return info;
  };
  const analyzeTable = async (tbl: XmlNode): Promise<TableInfo> => {
    const tblPr = kid(tbl, "tblPr");
    const style = tableStyle(at(kid(tblPr, "tblStyle"), "w:val") ?? ctx.defaultTableStyle);
    const prs = [tblPr, ...style.pr];
    const prop = (name: string) => prs.map((n) => kid(n, name)).find(Boolean);
    const lookNode = kid(tblPr, "tblLook");
    const lookBits = parseInt(at(lookNode, "w:val") ?? "04A0", 16);
    const flag = (name: string, bit: number) =>
      at(lookNode, `w:${name}`) !== undefined
        ? at(lookNode, `w:${name}`) === "1" || at(lookNode, `w:${name}`) === "true"
        : (lookBits & bit) !== 0;
    const look = {
      firstRow: flag("firstRow", 0x20),
      lastRow: flag("lastRow", 0x40),
      firstCol: flag("firstColumn", 0x80),
      lastCol: flag("lastColumn", 0x100),
      hBand: !flag("noHBand", 0x200),
      vBand: !flag("noVBand", 0x400),
    };
    const rowBand = Math.max(1, numAt(prop("tblStyleRowBandSize"), "w:val", 1));
    const colBand = Math.max(1, numAt(prop("tblStyleColBandSize"), "w:val", 1));
    const tableBorders = prs.map((n) => kid(n, "tblBorders"));
    const margins = prs.map((n) => kid(n, "tblCellMar"));
    const margin = (containers: (XmlNode | undefined)[], fallback: number, ...names: string[]) => {
      for (const c of containers)
        for (const name of names) if (kid(c, name)) return numAt(kid(c, name), "w:w") * TWIP;
      return fallback;
    };
    const edgeOf = (containers: (XmlNode | undefined)[], ...names: string[]) => {
      for (const c of containers)
        for (const name of names) if (kid(c, name)) return borderOf(kid(c, name));
      return undefined;
    };
    const grid = kids(kid(tbl, "tblGrid"), "gridCol").map((c) => numAt(c, "w:w") * TWIP);
    const trs = rowsOf(tbl, "tr");
    const spans = trs.map((tr) => {
      const trPr = kid(tr, "trPr");
      return { tr, trPr, before: numAt(kid(trPr, "gridBefore"), "w:val"), cells: rowsOf(tr, "tc") };
    });
    const columns = spans.reduce(
      (n, s) =>
        Math.max(
          n,
          s.before +
            numAt(kid(s.trPr, "gridAfter"), "w:val") +
            s.cells.reduce(
              (sum, tc) => sum + Math.max(1, numAt(kid(kid(tc, "tcPr"), "gridSpan"), "w:val", 1)),
              0,
            ),
        ),
      Math.max(1, grid.length),
    );
    const min = new Array<number>(columns).fill(0);
    const max = new Array<number>(columns).fill(0);
    const lastRow = trs.length - 1;
    const rows: TableRow[] = [];
    for (const [r, { trPr, before, cells: tcs }] of spans.entries()) {
      const cells: TableCell[] = [];
      let col = before;
      for (const tc of tcs) {
        const tcPr = kid(tc, "tcPr");
        const span = Math.max(1, numAt(kid(tcPr, "gridSpan"), "w:val", 1));
        const vMerge = kid(tcPr, "vMerge");
        const merge = vMerge
          ? at(vMerge, "w:val") === "restart"
            ? "restart"
            : "continue"
          : undefined;
        const last = col + span >= columns;
        // Conditional formats in ascending priority.
        const band = (index: number, size: number, offset: boolean) =>
          Math.floor((index - (offset ? 1 : 0)) / size) % 2 ? 2 : 1;
        const header = look.firstRow && r === 0;
        const footer = look.lastRow && r === lastRow;
        const types = ["wholeTable"];
        if (look.vBand && !(look.firstCol && col === 0) && !(look.lastCol && last))
          types.push(`band${band(col, colBand, look.firstCol)}Vert`);
        if (look.hBand && !header && !footer)
          types.push(`band${band(r, rowBand, look.firstRow)}Horz`);
        if (look.firstCol && col === 0) types.push("firstCol");
        if (look.lastCol && last) types.push("lastCol");
        if (header) types.push("firstRow");
        if (footer) types.push("lastRow");
        if (header && look.firstCol && col === 0) types.push("nwCell");
        if (header && look.lastCol && last) types.push("neCell");
        if (footer && look.firstCol && col === 0) types.push("swCell");
        if (footer && look.lastCol && last) types.push("seCell");
        const conds = types
          .flatMap((t) => (style.cond.has(t) ? [style.cond.get(t)!] : []))
          .reverse();
        const styled: Styled = {
          p: Object.assign(
            {},
            style.styled.p,
            ...conds.map((c) => readPPr(kid(c, "pPr"))).reverse(),
          ),
          r: Object.assign(
            {},
            style.styled.r,
            ...conds.map((c) => readRPr(kid(c, "rPr"))).reverse(),
          ),
        };
        const tcPrs = [tcPr, ...conds.map((c) => kid(c, "tcPr")), ...style.tcPr];
        const fill = [...tcPrs, ...prs].map(shadingOf).find((v) => v !== undefined) ?? undefined;
        const cellBorders = tcPrs.map((n) => kid(n, "tcBorders"));
        const edges = {
          top: edgeOf(cellBorders, "top") ?? edgeOf(tableBorders, r === 0 ? "top" : "insideH"),
          bottom:
            edgeOf(cellBorders, "bottom") ??
            edgeOf(tableBorders, r === lastRow ? "bottom" : "insideH"),
          left:
            edgeOf(cellBorders, "left", "start") ??
            edgeOf(tableBorders, ...(col === 0 ? ["left", "start"] : ["insideV"])),
          right:
            edgeOf(cellBorders, "right", "end") ??
            edgeOf(tableBorders, ...(last ? ["right", "end"] : ["insideV"])),
        };
        const cellMargins = [kid(tcPr, "tcMar"), ...margins];
        const pad = {
          left: margin(cellMargins, 108 * TWIP, "left", "start"),
          right: margin(cellMargins, 108 * TWIP, "right", "end"),
          top: margin(cellMargins, 0, "top"),
          bottom: margin(cellMargins, 0, "bottom"),
        };
        const widths = merge === "continue" ? { min: 0, max: 0 } : await contentWidths(tc, styled);
        const cell: TableCell = {
          tc,
          col,
          span,
          merge,
          below: false,
          style: styled,
          fill,
          edges,
          pad,
          valign: at(kid(tcPr, "vAlign"), "w:val") ?? "top",
          min: widths.min + pad.left + pad.right,
          max: widths.max + pad.left + pad.right,
          pref: kid(tcPr, "tcW"),
        };
        if (span === 1 && col < columns) {
          min[col] = Math.max(min[col]!, cell.min);
          max[col] = Math.max(max[col]!, cell.max);
        }
        cells.push(cell);
        col += span;
      }
      const trHeight = kid(trPr, "trHeight");
      rows.push({
        cells,
        header: onOff(kid(trPr, "tblHeader")) ?? false,
        height: numAt(trHeight, "w:val") * TWIP,
        rule: at(trHeight, "w:hRule") ?? "atLeast",
        cantSplit: onOff(kid(trPr, "cantSplit")) ?? false,
      });
    }
    const open = new Map<number, TableCell>();
    rows.forEach((row, r) => {
      for (const cell of row.cells) {
        if (cell.merge === "restart") open.set(cell.col, cell);
        else if (cell.merge === "continue") cell.fill ??= open.get(cell.col)?.fill;
        if (cell.merge)
          cell.below =
            rows[r + 1]?.cells.some((c) => c.col === cell.col && c.merge === "continue") ?? false;
      }
    });
    // Spanning cells widen the columns they cover in proportion to what those columns already need.
    for (const row of rows)
      for (const cell of row.cells) {
        if (cell.span === 1) continue;
        const cols = Array.from(
          { length: Math.min(cell.span, columns - cell.col) },
          (_, i) => cell.col + i,
        );
        for (const [need, values] of [
          [cell.min, min],
          [cell.max, max],
        ] as const) {
          const have = cols.reduce((s, c) => s + values[c]!, 0);
          if (need > have)
            for (const c of cols)
              values[c]! += have
                ? ((need - have) * values[c]!) / have
                : (need - have) / cols.length;
        }
      }
    return {
      rows,
      columns,
      grid,
      min,
      max,
      fixed: at(prop("tblLayout"), "w:type") === "fixed",
      tblW: kid(tblPr, "tblW") ?? prop("tblW"),
      indent: numAt(prop("tblInd"), "w:w") * TWIP,
      jc: at(prop("jc"), "w:val"),
    };
  };

  /** Word's column widths: preferred widths where given, content where not, always within `width`. */
  const columnWidths = (info: TableInfo, width: number) => {
    const n = info.columns;
    const avail = Math.max(1, width - Math.max(0, info.indent));
    const tblW = widthOf(info.tblW, width);
    const pref = Array.from({ length: n }, (_, c) => info.grid[c] ?? 0);
    for (const row of info.rows)
      for (const cell of row.cells) {
        const w = widthOf(cell.pref, tblW ?? avail);
        if (!w) continue;
        const cols = Array.from(
          { length: Math.min(cell.span, n - cell.col) },
          (_, i) => cell.col + i,
        );
        if (cols.every((c) => !info.grid[c]))
          for (const c of cols) pref[c] = Math.max(pref[c]!, w / cols.length);
      }
    const mins = info.fixed ? new Array<number>(n).fill(0) : info.min;
    let desired = pref.map((p, c) => (p ? Math.max(p, mins[c]!) : info.fixed ? 0 : info.max[c]!));
    if (info.fixed && desired.some((d) => !d)) {
      const unknown = desired.filter((d) => !d).length;
      const share =
        Math.max(0, (tblW ?? avail) - desired.reduce((s, d) => s + d, 0)) / unknown || avail / n;
      desired = desired.map((d) => d || share);
    }
    const sum = desired.reduce((s, d) => s + d, 0);
    if (!sum) return new Array<number>(n).fill(Math.min(tblW ?? avail, avail) / n);
    const target = Math.min(tblW ?? sum, avail);
    if (sum < target) {
      // Extra width from an explicit table width goes to auto columns first.
      const growable = desired.map((_, c) => !pref[c]);
      const pool = growable.some(Boolean) ? growable : growable.map(() => true);
      const weight = desired.reduce((s, d, c) => s + (pool[c] ? d : 0), 0);
      const count = pool.filter(Boolean).length;
      return desired.map((d, c) =>
        pool[c] ? d + (target - sum) * (weight ? d / weight : 1 / count) : d,
      );
    }
    if (sum === target) return desired;
    const minSum = mins.reduce((s, v) => s + v, 0);
    if (minSum >= target) return mins.map((v) => (minSum ? (v * target) / minSum : target / n));
    return desired.map((d, c) => mins[c]! + ((d - mins[c]!) * (target - minSum)) / (sum - minSum));
  };

  const table = async (tbl: XmlNode, target: Target, width: number, offsetX: number) => {
    const info = await analyze(tbl);
    const widths = columnWidths(info, width);
    const xs = [0];
    for (const w of widths) xs.push(xs.at(-1)! + w);
    const tableWidth = xs.at(-1)!;
    const jc = info.jc;
    const left = Math.min(
      offsetX +
        (jc === "center"
          ? (width - tableWidth) / 2
          : jc === "right" || jc === "end"
            ? width - tableWidth
            : info.indent),
      offsetX + width - tableWidth,
    );
    const laid = new Map<TableCell, Laid>();
    const heights: number[] = [];
    for (const row of info.rows) {
      let height = 0;
      for (const cell of row.cells) {
        const x = left + xs[cell.col]!;
        const w = xs[Math.min(cell.col + cell.span, widths.length)]! - xs[cell.col]!;
        const inner: Target = { items: [], y: cell.pad.top, paginate: false, style: cell.style };
        if (cell.merge !== "continue")
          await blocks(
            cell.tc,
            inner,
            Math.max(1, w - cell.pad.left - cell.pad.right),
            x + cell.pad.left,
          );
        const cellHeight = inner.y + cell.pad.bottom;
        laid.set(cell, { x, w, items: inner.items, height: cellHeight });
        if (!cell.merge) height = Math.max(height, cellHeight);
      }
      heights.push(
        row.rule === "exact" && row.height ? row.height : Math.max(row.height, height, 1),
      );
    }
    // A vertically merged cell's content stretches the last row it spans.
    info.rows.forEach((row, r) => {
      for (const cell of row.cells) {
        if (cell.merge !== "restart") continue;
        let end = r;
        while (info.rows[end]?.cells.find((c) => c.col === cell.col)?.below) end++;
        const need = laid.get(cell)!.height - heights.slice(r, end + 1).reduce((s, h) => s + h, 0);
        if (need > 0 && info.rows[end]!.rule !== "exact") heights[end]! += need;
      }
    });
    const spanHeight = (r: number, cell: TableCell) => {
      let h = heights[r]!;
      for (let next = r; info.rows[next]?.cells.find((c) => c.col === cell.col)?.below; next++)
        h += heights[next + 1]!;
      return h;
    };
    // Fills paint first, then cell content, then borders, so neither covers the other.
    let contents: Paint[] = [];
    let borders: Paint[] = [];
    const flush = () => {
      target.items.push(...contents, ...borders);
      contents = [];
      borders = [];
    };
    const edge = (e: Edge | undefined, x1: number, y1: number, x2: number, y2: number) => {
      if (e) borders.push({ t: "line", x1, y1, x2, y2, color: e.color, width: e.width });
    };
    // Paints rows[r] for the content slice [from, to) at the current y.
    const emit = (r: number, from: number, to: number) => {
      const row = info.rows[r]!;
      const end = to >= heights[r]!;
      const h = to - from;
      const y = target.y;
      for (const cell of row.cells) {
        const box = laid.get(cell)!;
        if (cell.fill) target.items.push({ t: "rect", x: box.x, y, w: box.w, h, fill: cell.fill });
        if (cell.merge !== "continue") {
          const room = cell.merge === "restart" ? spanHeight(r, cell) : heights[r]!;
          const dy =
            from === 0 && end
              ? Math.max(
                  0,
                  (room - box.height) *
                    (cell.valign === "center" ? 0.5 : cell.valign === "bottom" ? 1 : 0),
                )
              : 0;
          for (const item of box.items) {
            const top = extent(item)[0];
            if ((from === 0 || top >= from - 0.01) && (top < to || end))
              contents.push(shift(item, 0, y - from + dy));
          }
        }
        if (from === 0 && cell.merge !== "continue")
          edge(cell.edges.top, box.x, y, box.x + box.w, y);
        if (end && !cell.below) edge(cell.edges.bottom, box.x, y + h, box.x + box.w, y + h);
        edge(cell.edges.left, box.x, y, box.x, y + h);
        edge(cell.edges.right, box.x + box.w, y, box.x + box.w, y + h);
      }
      target.y += h;
    };
    const headers = info.rows.findIndex((row) => !row.header);
    const headerCount = headers < 0 ? 0 : headers;
    const nextPage = () => {
      flush();
      breakPage(target);
      for (let h = 0; h < headerCount; h++) emit(h, 0, heights[h]!);
    };
    target.prev = undefined;
    let fresh = target.paginate && target.y <= page.top + 0.5;
    for (let r = 0; r < info.rows.length; r++) {
      const row = info.rows[r]!;
      let from = 0;
      while (target.paginate && heights[r]! - from > pageBottom() - target.y) {
        // Rows split between lines, so no painted item straddles the cut; a row that may not split moves first.
        let cut = from;
        if (fresh || (!row.cantSplit && row.rule !== "exact" && !row.cells.some((c) => c.merge))) {
          cut = from + pageBottom() - target.y;
          for (let moved = true; moved;) {
            moved = false;
            for (const cell of row.cells)
              for (const item of laid.get(cell)!.items) {
                const [top, bottom] = extent(item);
                if (top >= from && top < cut && bottom > cut) {
                  cut = top;
                  moved = true;
                }
              }
          }
        }
        if (cut > from + 1) {
          emit(r, from, cut);
          from = cut;
        } else if (fresh) break;
        nextPage();
        fresh = true;
      }
      emit(r, from, heights[r]!);
      fresh = false;
    }
    flush();
  };

  const block = async (child: XmlNode, target: Target, width: number, offsetX: number) => {
    if (child.name === "p") await paragraph(child, target, width, offsetX);
    else if (child.name === "tbl") await table(child, target, width, offsetX);
    else if (child.name === "sdt" || child.name === "customXml" || child.name === "ins")
      await blocks(kid(child, "sdtContent") ?? child, target, width, offsetX);
  };
  const blocks = async (container: XmlNode, target: Target, width: number, offsetX: number) => {
    for (const child of container.children) await block(child, target, width, offsetX);
  };
  const target: Target = { items: frame.items, y: page.top, paginate: true };
  let truncated = pkg.truncated;
  try {
    for (const child of body.children) {
      await block(child, target, page.width - page.left - page.right, page.left);
      if (child.name !== "p" || !kid(kid(child, "pPr"), "sectPr") || section + 1 >= sections.length)
        continue;
      const next = sections[++section]!;
      page = next.geometry;
      if (next.type !== "continuous") breakPage(target);
    }
  } catch (cause) {
    if (cause !== PAGE_LIMIT) throw cause;
    truncated = true;
  }
  pkg.forget(mainPath);

  // Headers and footers, laid out per page so PAGE and NUMPAGES fields read true.
  ctx.recordBookmarks = false;
  ctx.page.count = pages.length;
  for (const [index, frameOf] of pages.entries()) {
    const s = sections[pageSection[index]!]!;
    const geometry = s.geometry;
    const firstOfSection = index === 0 || pageSection[index - 1] !== pageSection[index];
    const kind =
      s.titlePg && firstOfSection ? "first" : evenOdd && index % 2 === 1 ? "even" : "default";
    ctx.page.number = index + 1;
    for (const footer of [false, true]) {
      const part = (footer ? s.footer : s.header)[kind];
      const root = part ? kid(await pkg.xml(part), footer ? "ftr" : "hdr") : undefined;
      if (!part || !root) continue;
      ctx.rels = await pkg.rels(part);
      const area: Target = { items: [], y: 0, paginate: false };
      await blocks(root, area, geometry.width - geometry.left - geometry.right, geometry.left);
      const dy = footer ? geometry.height - geometry.footer - area.y : geometry.header;
      for (const item of area.items) frameOf.items.push(shift(item, 0, dy));
    }
  }
  return { pages, images: ctx.images, bookmarks, truncated };
}

const cropOf = (rect: XmlNode): [number, number, number, number] => [
  numAt(rect, "l") / 100000,
  numAt(rect, "t") / 100000,
  numAt(rect, "r") / 100000,
  numAt(rect, "b") / 100000,
];

function shift(item: Paint, dx: number, dy: number): Paint {
  if (item.t === "line")
    return { ...item, x1: item.x1 + dx, x2: item.x2 + dx, y1: item.y1 + dy, y2: item.y2 + dy };
  return { ...item, x: item.x + dx, y: item.y + dy };
}

export type CellBorder = {
  color: string;
  width: number;
  dash?: number[] | undefined;
  double?: boolean | undefined;
};
export type CellStyle = {
  font: string;
  size: number;
  color: string;
  fill: string | undefined;
  align: string | undefined;
  valign: string | undefined;
  wrap: boolean;
  indent: number;
  borders: Partial<Record<"left" | "right" | "top" | "bottom", CellBorder>> | undefined;
  format: string;
  bold: boolean;
  underline: boolean;
  strike: boolean;
};
export type SheetCell = {
  value: string | number | boolean | null;
  text: string;
  formula?: string;
  style: number;
  error?: boolean;
};
export type SheetData = {
  name: string;
  rows: Map<number, Map<number, SheetCell>>;
  maxRow: number;
  maxColumn: number;
  columnWidths: Map<number, number>;
  rowHeights: Map<number, number>;
  hiddenRows: Set<number>;
  hiddenColumns: Set<number>;
  merges: { r1: number; c1: number; r2: number; c2: number }[];
  frozen: { rows: number; columns: number };
  gridlines: boolean;
  links: Map<string, string>;
  defaultWidth: number;
  defaultHeight: number;
  /** Cells past the preview's row or column limit were left out. */
  truncated: boolean;
};

/** Cells one sheet keeps, bounding the worker's maps and the copy sent to the window. */
const MAX_SHEET_CELLS = 2_000_000;
export type Workbook = {
  sheets: { name: string; path: string; hidden: boolean; rels: string }[];
  styles: CellStyle[];
  strings: string[];
  date1904: boolean;
  active: number;
  theme: string[];
};

const BUILTIN_FORMATS: Record<number, string> = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  5: '"$"#,##0_);\\("$"#,##0\\)',
  6: '"$"#,##0_);[Red]\\("$"#,##0\\)',
  7: '"$"#,##0.00_);\\("$"#,##0.00\\)',
  8: '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)',
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  12: "# ?/?",
  13: "# ??/??",
  14: "m/d/yyyy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "m/d/yyyy h:mm",
  37: "#,##0 ;(#,##0)",
  38: "#,##0 ;[Red](#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;[Red](#,##0.00)",
  41: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)',
  42: '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)',
  44: '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)',
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mmss.0",
  48: "##0.0E+0",
  49: "@",
};
const INDEXED = [
  "000000",
  "FFFFFF",
  "FF0000",
  "00FF00",
  "0000FF",
  "FFFF00",
  "FF00FF",
  "00FFFF",
  "000000",
  "FFFFFF",
  "FF0000",
  "00FF00",
  "0000FF",
  "FFFF00",
  "FF00FF",
  "00FFFF",
  "800000",
  "008000",
  "000080",
  "808000",
  "800080",
  "008080",
  "C0C0C0",
  "808080",
  "9999FF",
  "993366",
  "FFFFCC",
  "CCFFFF",
  "660066",
  "FF8080",
  "0066CC",
  "CCCCFF",
  "000080",
  "FF00FF",
  "FFFF00",
  "00FFFF",
  "800080",
  "800000",
  "008080",
  "0000FF",
  "00CCFF",
  "CCFFFF",
  "CCFFCC",
  "FFFF99",
  "99CCFF",
  "FF99CC",
  "CC99FF",
  "FFCC99",
  "3366FF",
  "33CCCC",
  "99CC00",
  "FFCC00",
  "FF9900",
  "FF6600",
  "666699",
  "969696",
  "003366",
  "339966",
  "003300",
  "333300",
  "993300",
  "993366",
  "333399",
  "333333",
];

function tint(hex: string, amount: number) {
  if (!amount) return hex;
  const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return c
    .map((v) =>
      Math.round(amount < 0 ? v * (1 + amount) : v + (255 - v) * amount)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
}
function sheetColor(node: XmlNode | undefined, theme: string[]) {
  if (!node) return undefined;
  const rgb = at(node, "rgb");
  if (rgb) return `#${rgb.slice(-6)}`;
  const themed = at(node, "theme");
  if (themed !== undefined) {
    // Spreadsheet theme indexes swap the first two pairs: lt1, dk1, lt2, dk2.
    const index = [1, 0, 3, 2][Number(themed)] ?? Number(themed);
    const base = theme[index];
    return base ? `#${tint(base, numAt(node, "tint"))}` : undefined;
  }
  const indexed = at(node, "indexed");
  if (indexed !== undefined)
    return Number(indexed) === 64
      ? undefined
      : INDEXED[Number(indexed)]
        ? `#${INDEXED[Number(indexed)]}`
        : undefined;
  return undefined;
}
function themeColors(theme: XmlNode | undefined) {
  const scheme = find(theme, "clrScheme");
  return [
    "dk1",
    "lt1",
    "dk2",
    "lt2",
    "accent1",
    "accent2",
    "accent3",
    "accent4",
    "accent5",
    "accent6",
    "hlink",
    "folHlink",
  ].map((name) => {
    const node = kid(scheme, name);
    return (
      at(kid(node, "srgbClr"), "val") ??
      at(kid(node, "sysClr"), "lastClr") ??
      (name === "lt1" ? "FFFFFF" : "000000")
    );
  });
}

export async function openXlsx(
  bytes: ArrayBuffer | Uint8Array,
): Promise<{ pkg: OfficePackage; workbook: Workbook }> {
  const pkg = OfficePackage.open(bytes, "xlsx");
  const rootRels = await pkg.rels("");
  const path =
    [...rootRels.values()].find((r) => r.type === "officeDocument")?.target ?? "xl/workbook.xml";
  if (!pkg.has(path)) throw new PreviewError({ code: "office-not-open-xml" });
  const xml = await pkg.xml(path);
  const rels = await pkg.rels(path);
  const partOf = (type: string) => [...rels.values()].find((r) => r.type === type)?.target;
  const theme = themeColors(partOf("theme") ? await pkg.xml(partOf("theme")!) : undefined);
  const strings: string[] = [];
  const sst = partOf("sharedStrings") ? await pkg.xml(partOf("sharedStrings")!) : undefined;
  for (const si of kids(kid(sst, "sst"), "si"))
    strings.push(
      kids(si, "t")
        .map((t) => t.text)
        .join("") ||
        kids(si, "r")
          .map((r) => kid(r, "t")?.text ?? "")
          .join(""),
    );
  const stylesXml = partOf("styles") ? await pkg.xml(partOf("styles")!) : undefined;
  const sheetStyles = kid(stylesXml, "styleSheet");
  const formats = new Map<number, string>();
  for (const fmt of kids(kid(sheetStyles, "numFmts"), "numFmt"))
    formats.set(numAt(fmt, "numFmtId"), at(fmt, "formatCode") ?? "General");
  const flag = (node: XmlNode | undefined) => !!node && onOff(node)!;
  const fonts = kids(kid(sheetStyles, "fonts"), "font").map((f) => {
    const px = numAt(kid(f, "sz"), "val", 11) * (96 / 72);
    const bold = flag(kid(f, "b"));
    return {
      font: fontCss(at(kid(f, "name"), "val") ?? "Calibri", px, bold, flag(kid(f, "i"))),
      size: px,
      color: sheetColor(kid(f, "color"), theme) ?? "#000000",
      bold,
      underline: !!kid(f, "u") && at(kid(f, "u"), "val") !== "none",
      strike: flag(kid(f, "strike")),
    };
  });
  const fills = kids(kid(sheetStyles, "fills"), "fill").map((f) => {
    const pattern = kid(f, "patternFill");
    const type = at(pattern, "patternType");
    if (type && type !== "none")
      return (
        sheetColor(kid(pattern, "fgColor"), theme) ??
        sheetColor(kid(pattern, "bgColor"), theme) ??
        (type === "solid" ? "#000000" : undefined)
      );
    return sheetColor(find(kid(f, "gradientFill"), "color"), theme);
  });
  const BORDER: Record<string, Omit<CellBorder, "color">> = {
    thin: { width: 1 },
    hair: { width: 1, dash: [1, 1] },
    dotted: { width: 1, dash: [1, 2] },
    dashed: { width: 1, dash: [3, 2] },
    dashDot: { width: 1, dash: [4, 2, 1, 2] },
    dashDotDot: { width: 1, dash: [4, 2, 1, 2, 1, 2] },
    medium: { width: 2 },
    mediumDashed: { width: 2, dash: [5, 3] },
    mediumDashDot: { width: 2, dash: [5, 2, 2, 2] },
    mediumDashDotDot: { width: 2, dash: [5, 2, 2, 2, 2, 2] },
    slantDashDot: { width: 2, dash: [5, 1, 2, 1] },
    thick: { width: 3 },
    double: { width: 3, double: true },
  };
  const borderLists = kids(kid(sheetStyles, "borders"), "border").map((b) => {
    const out: Partial<Record<"left" | "right" | "top" | "bottom", CellBorder>> = {};
    for (const side of ["left", "right", "top", "bottom"] as const) {
      const node =
        kid(b, side) ?? kid(b, side === "left" ? "start" : side === "right" ? "end" : side);
      const style = at(node, "style");
      if (style && style !== "none")
        out[side] = {
          color: sheetColor(kid(node, "color"), theme) ?? "#000000",
          ...(BORDER[style] ?? BORDER.thin!),
        };
    }
    return Object.keys(out).length ? out : undefined;
  });
  const styles = kids(kid(sheetStyles, "cellXfs"), "xf").map((xf): CellStyle => {
    const font = fonts[numAt(xf, "fontId")] ?? {
      font: fontCss("Calibri", 14.67),
      size: 14.67,
      color: "#000",
      bold: false,
      underline: false,
      strike: false,
    };
    const alignment = kid(xf, "alignment");
    const id = numAt(xf, "numFmtId");
    return {
      ...font,
      fill: fills[numAt(xf, "fillId")],
      align: at(alignment, "horizontal"),
      valign: at(alignment, "vertical"),
      wrap: ["1", "true"].includes(at(alignment, "wrapText") ?? ""),
      indent: numAt(alignment, "indent"),
      borders: borderLists[numAt(xf, "borderId")],
      format: formats.get(id) ?? BUILTIN_FORMATS[id] ?? "General",
    };
  });
  // Strings and styles are extracted; their trees would otherwise stay cached for the workbook's life.
  pkg.forget(partOf("sharedStrings"));
  pkg.forget(partOf("styles"));
  pkg.forget(path);
  const workbook = kid(xml, "workbook");
  const sheets = kids(kid(workbook, "sheets"), "sheet").map((s) => ({
    name: at(s, "name") ?? "Sheet",
    path: rels.get(at(s, "r:id") ?? "")?.target ?? "",
    hidden: (at(s, "state") ?? "visible") !== "visible",
    rels: at(s, "r:id") ?? "",
  }));
  return {
    pkg,
    workbook: {
      sheets,
      styles,
      strings,
      date1904: at(kid(workbook, "workbookPr"), "date1904") === "1",
      active: numAt(kid(kid(workbook, "bookViews"), "workbookView"), "activeTab"),
      theme,
    },
  };
}

export const columnName = (index: number) => {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};
function parseCellRef(ref: string) {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(ref.trim());
  if (!m) return undefined;
  let column = 0;
  for (const ch of m[1]!.toUpperCase()) column = column * 26 + ch.charCodeAt(0) - 64;
  return { row: Number(m[2]) - 1, column: column - 1 };
}

/** Reads one worksheet with a streaming scan of its rows, so large sheets build no XML tree. */
export async function readSheet(
  pkg: OfficePackage,
  workbook: Workbook,
  index: number,
): Promise<SheetData> {
  const sheet = workbook.sheets[index]!;
  const xml = await pkg.text(sheet.path);
  const data: SheetData = {
    name: sheet.name,
    rows: new Map(),
    maxRow: 0,
    maxColumn: 0,
    columnWidths: new Map(),
    rowHeights: new Map(),
    hiddenRows: new Set(),
    hiddenColumns: new Set(),
    merges: [],
    frozen: { rows: 0, columns: 0 },
    gridlines: true,
    links: new Map(),
    defaultWidth: 64,
    defaultHeight: 20,
    truncated: false,
  };
  const head = xml.slice(0, Math.max(0, xml.indexOf("<sheetData"))) || xml.slice(0, 20000);
  const view = /<sheetView\b([^>]*)>/.exec(head)?.[1] ?? "";
  if (/showGridLines="(0|false)"/.test(view)) data.gridlines = false;
  const pane = /<pane\b([^>]*)\/?>/.exec(head)?.[1] ?? "";
  if (/state="frozen/.test(pane))
    data.frozen = {
      rows: Number(/ySplit="([\d.]+)"/.exec(pane)?.[1] ?? 0),
      columns: Number(/xSplit="([\d.]+)"/.exec(pane)?.[1] ?? 0),
    };
  const format = /<sheetFormatPr\b([^>]*)>/.exec(head)?.[1] ?? "";
  const defaultChars = Number(
    /defaultColWidth="([\d.]+)"/.exec(format)?.[1] ??
      /baseColWidth="([\d.]+)"/.exec(format)?.[1] ??
      8.43,
  );
  data.defaultWidth = Math.round(defaultChars * 7 + 5);
  data.defaultHeight = Number(/defaultRowHeight="([\d.]+)"/.exec(format)?.[1] ?? 15) * (96 / 72);
  for (const m of head.matchAll(/<col\b([^>]*)\/?>/g)) {
    const attrs = m[1]!;
    const min = Number(/min="(\d+)"/.exec(attrs)?.[1] ?? 1);
    const max = Math.min(Number(/max="(\d+)"/.exec(attrs)?.[1] ?? min), 16384);
    const width = /width="([\d.]+)"/.exec(attrs)?.[1];
    const hidden = /hidden="(1|true)"/.test(attrs);
    for (let c = min - 1; c < max; c++) {
      if (width) data.columnWidths.set(c, Math.round(Number(width) * 7 + 5));
      if (hidden) data.hiddenColumns.add(c);
    }
  }
  const strings = workbook.strings;
  const rowPattern = /<row\b([^>]*?)(\/>|>([\s\S]*?)<\/row>)/g;
  const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let nextRow = 0;
  const shared = new Map<string, { formula: string; row: number; column: number }>();
  const start = xml.indexOf("<sheetData");
  rowPattern.lastIndex = start < 0 ? xml.length : start;
  let cells = 0;
  for (let rm = rowPattern.exec(xml); rm; rm = rowPattern.exec(xml)) {
    const attrs = rm[1]!;
    const r = Number(/\br="(\d+)"/.exec(attrs)?.[1] ?? nextRow + 1) - 1;
    nextRow = r + 1;
    if (r >= OFFICE_PREVIEW_MAX_ROWS) {
      data.truncated = true;
      break;
    }
    const ht = /\bht="([\d.]+)"/.exec(attrs)?.[1];
    if (ht) data.rowHeights.set(r, Number(ht) * (96 / 72));
    if (/hidden="(1|true)"/.test(attrs)) data.hiddenRows.add(r);
    const body = rm[3];
    if (!body) continue;
    const row = new Map<number, SheetCell>();
    let nextColumn = 0;
    for (let cm = cellPattern.exec(body); cm; cm = cellPattern.exec(body)) {
      const ca = cm[1]!;
      const ref = /\br="([A-Z]+\d+)"/.exec(ca)?.[1];
      const column = ref ? parseCellRef(ref)!.column : nextColumn;
      nextColumn = column + 1;
      if (column >= OFFICE_PREVIEW_MAX_COLUMNS) {
        data.truncated = true;
        continue;
      }
      const type = /\bt="(\w+)"/.exec(ca)?.[1] ?? "n";
      const style = Number(/\bs="(\d+)"/.exec(ca)?.[1] ?? 0);
      const inner = cm[2] ?? "";
      const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      const f = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(inner);
      let formula = f?.[2] !== undefined && f[2] !== "" ? decodeEntities(f[2]) : undefined;
      const si = f && /t="shared"/.test(f[1]!) ? /si="(\d+)"/.exec(f[1]!)?.[1] : undefined;
      if (si !== undefined) {
        const master = shared.get(si);
        if (formula !== undefined) shared.set(si, { formula, row: r, column });
        else if (master)
          formula = shiftFormula(master.formula, r - master.row, column - master.column);
      }
      let value: SheetCell["value"] = null;
      let error = false;
      if (type === "s" && raw !== undefined) value = strings[Number(raw)] ?? "";
      else if (type === "inlineStr")
        value = decodeEntities(
          [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""),
        );
      else if (type === "str" && raw !== undefined) value = decodeEntities(raw);
      else if (type === "b" && raw !== undefined) value = raw === "1";
      else if (type === "e") {
        value = raw ?? "#N/A";
        error = true;
      } else if (raw !== undefined && raw !== "") value = Number(raw);
      if (value === null && formula === undefined && !style) continue;
      row.set(column, {
        value,
        text: "",
        style,
        ...(formula !== undefined ? { formula } : {}),
        ...(error ? { error } : {}),
      });
      if (value !== null || formula !== undefined)
        data.maxColumn = Math.max(data.maxColumn, column + 1);
    }
    if (row.size) {
      data.rows.set(r, row);
      data.maxRow = Math.max(data.maxRow, r + 1);
    }
    if ((cells += row.size) > MAX_SHEET_CELLS) {
      data.truncated = true;
      break;
    }
  }
  const tail = xml.slice(xml.lastIndexOf("</sheetData>") + 1 || xml.length);
  for (const m of tail.matchAll(/<mergeCell\b[^>]*ref="([A-Z]+\d+):([A-Z]+\d+)"/g)) {
    const a = parseCellRef(m[1]!)!;
    const b = parseCellRef(m[2]!)!;
    data.merges.push({ r1: a.row, c1: a.column, r2: b.row, c2: b.column });
  }
  const rels = await pkg.rels(sheet.path);
  for (const m of tail.matchAll(/<hyperlink\b([^>]*)\/?>/g)) {
    const ref = /ref="([A-Z]+\d+)/.exec(m[1]!)?.[1];
    const target = rels.get(/r:id="([^"]+)"/.exec(m[1]!)?.[1] ?? "");
    const location = /location="([^"]+)"/.exec(m[1]!)?.[1];
    if (ref && (target?.external || location))
      data.links.set(ref, target?.external ? target.target : `#${decodeEntities(location!)}`);
  }
  evaluateSheet(data, workbook);
  return data;
}

type Value = number | string | boolean | null | Value[];
const flat = (v: Value): Value[] => (Array.isArray(v) ? v.flatMap(flat) : [v]);
const toNumber = (v: Value): number =>
  typeof v === "number"
    ? v
    : typeof v === "boolean"
      ? Number(v)
      : typeof v === "string" && v.trim() && Number.isFinite(Number(v))
        ? Number(v)
        : 0;
const FUNCTIONS: Record<string, (args: Value[]) => Value> = {
  SUM: (a) => flat(a).reduce<number>((s, v) => s + (typeof v === "number" ? v : 0), 0),
  AVERAGE: (a) => {
    const n = flat(a).filter((v): v is number => typeof v === "number");
    return n.length ? n.reduce((s, v) => s + v, 0) / n.length : "#DIV/0!";
  },
  COUNT: (a) => flat(a).filter((v) => typeof v === "number").length,
  COUNTA: (a) => flat(a).filter((v) => v !== null && v !== "").length,
  MIN: (a) => extreme(numbers(a), (x, y) => x < y),
  MAX: (a) => extreme(numbers(a), (x, y) => x > y),
  PRODUCT: (a) => numbers(a).reduce((p, v) => p * v, 1),
  MEDIAN: (a) => {
    const n = numbers(a).sort((x, y) => x - y);
    return n.length ? (n[(n.length - 1) >> 1]! + n[n.length >> 1]!) / 2 : "#NUM!";
  },
  SUMIF: (a) => conditional(a, (picked) => picked.reduce<number>((s, v) => s + toNumber(v), 0)),
  COUNTIF: (a) =>
    conditional([a[0] ?? null, a[1] ?? null, a[0] ?? null], (picked) => picked.length),
  AVERAGEIF: (a) =>
    conditional(a, (picked) =>
      picked.length
        ? picked.reduce<number>((s, v) => s + toNumber(v), 0) / picked.length
        : "#DIV/0!",
    ),
  IFERROR: (a) => (isError(a[0] ?? null) ? (a[1] ?? "") : (a[0] ?? "")),
  INT: (a) => Math.floor(toNumber(a[0] ?? 0)),
  MOD: (a) => {
    const d = toNumber(a[1] ?? 0);
    return d ? toNumber(a[0] ?? 0) - d * Math.floor(toNumber(a[0] ?? 0) / d) : "#DIV/0!";
  },
  ROUNDUP: (a) => roundAway(toNumber(a[0] ?? 0), toNumber(a[1] ?? 0), true),
  ROUNDDOWN: (a) => roundAway(toNumber(a[0] ?? 0), toNumber(a[1] ?? 0), false),
  SQRT: (a) => (toNumber(a[0] ?? 0) < 0 ? "#NUM!" : Math.sqrt(toNumber(a[0] ?? 0))),
  POWER: (a) => toNumber(a[0] ?? 0) ** toNumber(a[1] ?? 0),
  LEFT: (a) => display(a[0] ?? "").slice(0, toNumber(a[1] ?? 1)),
  RIGHT: (a) => (toNumber(a[1] ?? 1) ? display(a[0] ?? "").slice(-toNumber(a[1] ?? 1)) : ""),
  MID: (a) =>
    display(a[0] ?? "").slice(
      toNumber(a[1] ?? 1) - 1,
      toNumber(a[1] ?? 1) - 1 + toNumber(a[2] ?? 0),
    ),
  TRIM: (a) =>
    display(a[0] ?? "")
      .trim()
      .replace(/\s+/g, " "),
  IF: (a) => (truthy(a[0] ?? false) ? (a[1] ?? true) : (a[2] ?? false)),
  AND: (a) => flat(a).every(truthy),
  OR: (a) => flat(a).some(truthy),
  NOT: (a) => !truthy(a[0] ?? false),
  ABS: (a) => Math.abs(toNumber(a[0] ?? 0)),
  ROUND: (a) => {
    const f = 10 ** toNumber(a[1] ?? 0);
    return Math.round(toNumber(a[0] ?? 0) * f) / f;
  },
  CONCATENATE: (a) => flat(a).map(display).join(""),
  CONCAT: (a) => flat(a).map(display).join(""),
  LEN: (a) => display(a[0] ?? "").length,
  UPPER: (a) => display(a[0] ?? "").toUpperCase(),
  LOWER: (a) => display(a[0] ?? "").toLowerCase(),
};
const extreme = (n: number[], better: (x: number, y: number) => boolean) =>
  n.length ? n.reduce((m, v) => (better(v, m) ? v : m)) : 0;
const numbers = (a: Value[]) => flat(a).filter((v): v is number => typeof v === "number");
const isError = (v: Value) =>
  typeof v === "string" && /^#(DIV\/0!|N\/A|NAME\?|NULL!|NUM!|REF!|VALUE!)$/.test(v);
const roundAway = (v: number, digits: number, up: boolean) => {
  const f = 10 ** digits;
  return (
    (Math.sign(v) * (up ? Math.ceil(Math.abs(v) * f - 1e-9) : Math.floor(Math.abs(v) * f + 1e-9))) /
    f
  );
};
/** SUMIF-style criteria ("&gt;5", "apple", "a*") over a range, aggregating the matching cells of a second range. */
function conditional(a: Value[], aggregate: (picked: Value[]) => Value): Value {
  const range = flat(a[0] ?? null);
  const values = a[2] === undefined ? range : flat(a[2]);
  const [, op = "=", operand = ""] = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(display(a[1] ?? "")) ?? [];
  const numeric = operand.trim() !== "" && Number.isFinite(Number(operand));
  const pattern = new RegExp(
    `^${operand
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
    "i",
  );
  const test = (v: Value) => {
    if (numeric && typeof v === "number") {
      const x = Number(operand);
      return op === "="
        ? v === x
        : op === "<>"
          ? v !== x
          : op === "<"
            ? v < x
            : op === ">"
              ? v > x
              : op === "<="
                ? v <= x
                : v >= x;
    }
    const matched = pattern.test(display(v));
    return op === "=" ? matched : op === "<>" ? !matched : false;
  };
  return aggregate(range.flatMap((v, i) => (test(v) ? [values[i] ?? null] : [])));
}
/** Moves a shared formula's relative references by the offset from its master cell. */
function shiftFormula(formula: string, rows: number, columns: number) {
  return formula
    .split(/("(?:[^"]|"")*")/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(
            /(^|[^A-Za-z0-9_.])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\d(])/g,
            (m, lead: string, colAbs: string, col: string, rowAbs: string, row: string) => {
              const ref = parseCellRef(`${col}${row}`);
              if (!ref) return m;
              return `${lead}${colAbs}${colAbs ? col : columnName(ref.column + columns)}${rowAbs}${rowAbs ? row : ref.row + rows + 1}`;
            },
          ),
    )
    .join("");
}
const truthy = (v: Value): boolean =>
  typeof v === "string" ? v.toUpperCase() === "TRUE" : Boolean(Array.isArray(v) ? v.length : v);
const display = (v: Value): string =>
  v === null
    ? ""
    : typeof v === "boolean"
      ? v
        ? "TRUE"
        : "FALSE"
      : Array.isArray(v)
        ? display(v[0] ?? null)
        : String(v);

/** Evaluates an A1-style formula: arithmetic, comparisons, `&`, ranges and common functions. */
function evaluateFormula(formula: string, lookup: (row: number, column: number) => Value): Value {
  const tokens =
    formula
      .replace(/^=/, "")
      .match(
        /"(?:[^"]|"")*"|\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?|\d+(?:\.\d+)?(?:E[+-]?\d+)?|[A-Z_][A-Z0-9_.]*(?=\()|TRUE|FALSE|<=|>=|<>|[-+*/^&=<>(),:%]/gi,
      ) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const expect = (t: string) => {
    if (tokens[i] !== t) throw new Error("#NAME?");
    i++;
  };
  const primary = (): Value => {
    const t = tokens[i++];
    if (t === undefined) throw new Error("#VALUE!");
    if (t === "(") {
      const v = comparison();
      expect(")");
      return v;
    }
    if (t === "-") return -toNumber(primary());
    if (t === "+") return primary();
    if (t[0] === '"') return t.slice(1, -1).replace(/""/g, '"');
    if (/^\d/.test(t)) return Number(t);
    if (/^(TRUE|FALSE)$/i.test(t)) return t.toUpperCase() === "TRUE";
    if (peek() === "(" && /^[A-Z_]/i.test(t)) {
      i++;
      const args: Value[] = [];
      while (peek() !== ")" && i < tokens.length) {
        args.push(comparison());
        if (peek() === ",") i++;
      }
      expect(")");
      const fn = FUNCTIONS[t.toUpperCase()];
      if (!fn) throw new Error("#NAME?");
      return fn(args);
    }
    const [a, b] = t.split(":");
    const start = parseCellRef(a!);
    if (!start) throw new Error("#NAME?");
    if (!b) return lookup(start.row, start.column);
    const end = parseCellRef(b)!;
    const out: Value[] = [];
    for (
      let r = Math.min(start.row, end.row);
      r <= Math.max(start.row, end.row) && out.length < 1e6;
      r++
    )
      for (let c = Math.min(start.column, end.column); c <= Math.max(start.column, end.column); c++)
        out.push(lookup(r, c));
    return out;
  };
  const percent = (): Value => {
    let v = primary();
    while (peek() === "%") {
      i++;
      v = toNumber(v) / 100;
    }
    return v;
  };
  const power = (): Value => {
    let v = percent();
    while (peek() === "^") {
      i++;
      v = toNumber(v) ** toNumber(percent());
    }
    return v;
  };
  const product = (): Value => {
    let v = power();
    while (peek() === "*" || peek() === "/") {
      const op = tokens[i++];
      const r = toNumber(power());
      if (op === "/" && r === 0) return "#DIV/0!";
      v = op === "*" ? toNumber(v) * r : toNumber(v) / r;
    }
    return v;
  };
  const sum = (): Value => {
    let v = product();
    while (peek() === "+" || peek() === "-")
      v =
        tokens[i++] === "+" ? toNumber(v) + toNumber(product()) : toNumber(v) - toNumber(product());
    return v;
  };
  const concat = (): Value => {
    let v = sum();
    while (peek() === "&") {
      i++;
      v = display(v) + display(sum());
    }
    return v;
  };
  const comparison = (): Value => {
    let v = concat();
    while (["=", "<>", "<", ">", "<=", ">="].includes(peek() ?? "")) {
      const op = tokens[i++];
      const r = concat();
      const [x, y] =
        typeof v === "number" && typeof r === "number"
          ? [v, r]
          : [display(v).toLowerCase(), display(r).toLowerCase()];
      v =
        op === "="
          ? x === y
          : op === "<>"
            ? x !== y
            : op === "<"
              ? x < y
              : op === ">"
                ? x > y
                : op === "<="
                  ? x <= y
                  : x >= y;
    }
    return v;
  };
  try {
    const value = comparison();
    return Array.isArray(value) ? (value[0] ?? null) : value;
  } catch (error) {
    return error instanceof Error && error.message.startsWith("#") ? error.message : "#VALUE!";
  }
}

function evaluateSheet(sheet: SheetData, workbook: Workbook) {
  const visiting = new Set<string>();
  const valueAt = (row: number, column: number): Value => {
    const cell = sheet.rows.get(row)?.get(column);
    if (!cell) return null;
    if (cell.formula !== undefined && cell.value === null) {
      const key = `${row}:${column}`;
      if (visiting.has(key)) return "#REF!";
      visiting.add(key);
      cell.value = evaluateFormula(cell.formula, valueAt) as SheetCell["value"];
      visiting.delete(key);
    }
    return cell.value;
  };
  for (const [r, row] of sheet.rows)
    for (const [c, cell] of row) {
      valueAt(r, c);
      if (isError(cell.value)) cell.error = true;
      cell.text = formatValue(
        cell.value,
        workbook.styles[cell.style]?.format ?? "General",
        workbook.date1904,
      );
    }
}

/** Excel number formats: sections, decimals, grouping, percent, scientific, dates and times, and literals. */
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const literal = (s: string) =>
  s
    .replace(/"([^"]*)"/g, "$1")
    .replace(/\\(.)/g, "$1")
    .replace(/_./g, " ")
    .replace(/\*./g, "");

type FormatSection = (number: number, date1904: boolean) => string;

/** One `;` section of a number format, parsed once; the result formats any number. */
function compileSection(raw: string): FormatSection {
  const section = raw
    .replace(/\[\$([^\]-]*)(?:-[^\]]*)?\]/g, '"$1"')
    .replace(
      /\[(?:Red|Black|Blue|Green|White|Yellow|Cyan|Magenta|Color\s*\d+|[<>=]+[\d.]+)\]/gi,
      "",
    );
  if (
    /[dmyhs]/i.test(section.replace(/"[^"]*"/g, "")) &&
    !/0/.test(section.replace(/"[^"]*"|\[[^\]]*\]/g, "").replace(/\.0+/, ""))
  ) {
    const ampm = /AM\/PM|A\/P/i.test(section);
    const lower = section.toLowerCase();
    return (number, date1904) => {
      const ms = Math.round((number - (date1904 ? -1462 : 25569)) * 86400000);
      const d = new Date(ms);
      const pm = d.getUTCHours() >= 12;
      const hours = ampm ? d.getUTCHours() % 12 || 12 : d.getUTCHours();
      let minuteContext = false;
      return literal(
        section.replace(
          /"[^"]*"|\[h+\]|yyyy|yy|mmmmm|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|AM\/PM|A\/P|\.0+/gi,
          (token) => {
            const t = token.toLowerCase();
            if (token.startsWith('"')) return token;
            if (t.startsWith("[h")) return String(Math.floor(number * 24));
            if (t === "yyyy") return String(d.getUTCFullYear());
            if (t === "yy") return String(d.getUTCFullYear()).slice(-2);
            if (t.startsWith("h")) {
              minuteContext = true;
              return t === "hh" ? String(hours).padStart(2, "0") : String(hours);
            }
            if (t === "mmmmm") return MONTHS[d.getUTCMonth()]![0]!;
            if (t === "mmmm") return MONTHS[d.getUTCMonth()]!;
            if (t === "mmm") return MONTHS[d.getUTCMonth()]!.slice(0, 3);
            if (t === "mm" || t === "m") {
              const minutes =
                minuteContext || /^\s*:?s/.test(section.slice(lower.indexOf(t) + t.length));
              minuteContext = false;
              const v = minutes ? d.getUTCMinutes() : d.getUTCMonth() + 1;
              return t === "mm" ? String(v).padStart(2, "0") : String(v);
            }
            if (t === "dddd") return DAYS[d.getUTCDay()]!;
            if (t === "ddd") return DAYS[d.getUTCDay()]!.slice(0, 3);
            if (t === "dd") return String(d.getUTCDate()).padStart(2, "0");
            if (t === "d") return String(d.getUTCDate());
            if (t === "ss") return String(d.getUTCSeconds()).padStart(2, "0");
            if (t === "s") return String(d.getUTCSeconds());
            if (t === "am/pm") return pm ? "PM" : "AM";
            if (t === "a/p") return pm ? "P" : "A";
            if (t.startsWith(".0"))
              return `.${String(d.getUTCMilliseconds())
                .padStart(3, "0")
                .slice(0, t.length - 1)}`;
            return token;
          },
        ),
      );
    };
  }
  const code = section.replace(/"[^"]*"/g, (q) => q.replace(/[0#?.,%E]/g, (c) => `\\${c}`));
  // Keep the literal prefix and suffix around the number pattern.
  const pattern = /(?<!\\)[0#?][0#?,.]*(?:E[+-][0#]+)?/i.exec(code);
  if (!pattern) {
    const text = literal(section);
    return () => text;
  }
  const scale = 100 ** (code.match(/(?<!\\)%/g) ?? []).length;
  const scientific = /(?<!\\)E[+-]/i.test(code);
  const decimals = (/(?<!\\)\.([0#?]+)/.exec(code)?.[1] ?? "").length;
  const grouping = /[0#?],[0#?]/.test(code);
  const minimumDigits = (/(?<!\\)(0+)(?:[.,]|$|[^0#?,.])/.exec(code.split(".")[0] ?? "")?.[1] ?? "")
    .length;
  const optional = (/(?<!\\)\.(0*)(#*)/.exec(code)?.[1] ?? "").length;
  const trailingZeros =
    optional < decimals ? new RegExp(`(\\.\\d{${optional}}\\d*?)0+$`) : undefined;
  const before = literal(code.slice(0, pattern.index).replace(/\\(.)/g, "$1"));
  const after = literal(code.slice(pattern.index + pattern[0].length).replace(/\\(.)/g, "$1"));
  return (value) => {
    const number = value * scale;
    let formatted: string;
    if (scientific) {
      const [mantissa, exponent] = number.toExponential(decimals).split("e");
      formatted = `${mantissa}E${Number(exponent) < 0 ? "-" : "+"}${String(Math.abs(Number(exponent))).padStart(2, "0")}`;
    } else {
      let digits = Math.abs(number).toFixed(decimals);
      if (trailingZeros) digits = digits.replace(trailingZeros, "$1").replace(/\.$/, "");
      let [whole, fraction] = digits.split(".");
      whole = whole!.padStart(minimumDigits, "0");
      if (whole === "0" && !minimumDigits) whole = "";
      if (grouping) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      formatted = (number < 0 ? "-" : "") + whole + (fraction ? `.${fraction}` : "");
    }
    return before + formatted + after;
  };
}

/** Number formats by code, each section compiled on first use; a workbook uses a few dozen. */
const compiledFormats = new Map<string, { sections: string[]; compiled: FormatSection[] }>();

function formatValue(value: SheetCell["value"], format: string, date1904 = false): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "string") {
    const textSection = format.split(";")[3];
    return textSection ? textSection.replace(/@/g, value).replace(/"([^"]*)"/g, "$1") : value;
  }
  if (!Number.isFinite(value)) return String(value);
  if (format === "General" || !format)
    return Math.abs(value) >= 1e11 || (Math.abs(value) < 1e-9 && value)
      ? value
          .toExponential(5)
          .replace(/\.?0+e/, "E")
          .replace("E+", "E+")
      : String(Math.round(value * 1e10) / 1e10);
  let entry = compiledFormats.get(format);
  if (!entry) {
    if (compiledFormats.size > 4096) compiledFormats.clear();
    entry = { sections: format.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/), compiled: [] };
    compiledFormats.set(format, entry);
  }
  let index = 0;
  let number = value;
  if (value < 0 && entry.sections[1] !== undefined) {
    index = 1;
    number = -value;
  } else if (value === 0 && entry.sections[2] !== undefined) index = 2;
  const section = (entry.compiled[index] ??= compileSection(entry.sections[index]!));
  return section(number, date1904);
}

/** The cells of a range as the tab-separated text a spreadsheet pastes. */
export function sheetTsv(sheet: SheetData, r1: number, c1: number, r2: number, c2: number) {
  const lines: string[] = [];
  for (let r = r1; r <= r2; r++) {
    const row = sheet.rows.get(r);
    const cells: string[] = [];
    for (let c = c1; c <= c2; c++) {
      const text = row?.get(c)?.text ?? "";
      cells.push(/[\t\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
    }
    lines.push(cells.join("\t"));
  }
  return lines.join("\n");
}

export type PresentationModel = { slides: OfficeFrame[]; images: OfficeImage[] };
type ShapeText = {
  paragraphs: XmlNode[];
  body: XmlNode | undefined;
  listStyle: XmlNode | undefined;
};
type Inherited = {
  xfrm?: XmlNode | undefined;
  text?: XmlNode | undefined;
  spPr?: XmlNode | undefined;
};
const PRESET_FALLBACK = new Set([
  "rect",
  "roundRect",
  "ellipse",
  "triangle",
  "rtTriangle",
  "diamond",
  "line",
  "straightConnector1",
  "parallelogram",
  "hexagon",
  "octagon",
  "chevron",
  "rightArrow",
  "leftArrow",
  "upArrow",
  "downArrow",
  "pentagon",
  "homePlate",
  "flowChartProcess",
  "flowChartAlternateProcess",
  "flowChartDecision",
  "flowChartTerminator",
  "snip1Rect",
  "round2SameRect",
  "wedgeRectCallout",
  "cloud",
  "star5",
  "plus",
  "can",
  "donut",
]);

// PowerPoint's default table style ("Medium Style 2 - Accent 1"), which files reference without defining.
const MEDIUM_STYLE_2 = (() => {
  const clr = (val: string, tint = "") =>
    `<a:solidFill><a:schemeClr val="${val}">${tint ? `<a:tint val="${tint}"/>` : ""}</a:schemeClr></a:solidFill>`;
  const fill = (val: string, tint = "") => `<a:fill>${clr(val, tint)}</a:fill>`;
  const edges = ["left", "right", "top", "bottom", "insideH", "insideV"]
    .map((side) => `<a:${side}><a:ln w="12700">${clr("lt1")}</a:ln></a:${side}>`)
    .join("");
  const strong = (name: string) =>
    `<a:${name}><a:tcTxStyle b="on"><a:schemeClr val="lt1"/></a:tcTxStyle><a:tcStyle>${fill("accent1")}</a:tcStyle></a:${name}>`;
  return kid(
    parseXml(
      `<a:tblStyle><a:wholeTbl><a:tcTxStyle><a:schemeClr val="dk1"/></a:tcTxStyle><a:tcStyle><a:tcBdr>${edges}</a:tcBdr>${fill("accent1", "20000")}</a:tcStyle></a:wholeTbl><a:band1H><a:tcStyle>${fill("accent1", "40000")}</a:tcStyle></a:band1H><a:band1V><a:tcStyle>${fill("accent1", "40000")}</a:tcStyle></a:band1V>${strong("lastCol")}${strong("firstCol")}${strong("lastRow")}${strong("firstRow")}</a:tblStyle>`,
    ),
    "tblStyle",
  )!;
})();
function autoNumber(n: number, type: string) {
  const [, scheme = "arabic", style = "Period"] =
    /^(arabic|alphaLc|alphaUc|romanLc|romanUc)(.*)$/.exec(type) ?? [];
  const value = formatCounter(
    n,
    {
      arabic: "decimal",
      alphaLc: "lowerLetter",
      alphaUc: "upperLetter",
      romanLc: "lowerRoman",
      romanUc: "upperRoman",
    }[scheme]!,
  );
  return style === "ParenR"
    ? `${value})`
    : style === "ParenBoth"
      ? `(${value})`
      : style === "Plain"
        ? value
        : `${value}.`;
}

export async function layoutPptx(
  bytes: ArrayBuffer | Uint8Array,
  rawMeasure: Measure = approximateMeasure,
): Promise<PresentationModel> {
  const measure = memoMeasure(rawMeasure);
  const pkg = OfficePackage.open(bytes, "pptx");
  const rootRels = await pkg.rels("");
  const path =
    [...rootRels.values()].find((r) => r.type === "officeDocument")?.target ??
    "ppt/presentation.xml";
  const presentation = kid(await pkg.xml(path), "presentation");
  const rels = await pkg.rels(path);
  const size = kid(presentation, "sldSz");
  const width = numAt(size, "cx", 9144000) * EMU;
  const height = numAt(size, "cy", 5143500) * EMU;
  const images: OfficeImage[] = [];
  const imageCache = new Map<string, number>();
  const tableStylesPath = [...rels.values()].find((r) => r.type === "tableStyles")?.target;
  const tableStyleList = kid(
    tableStylesPath ? await pkg.xml(tableStylesPath) : undefined,
    "tblStyleLst",
  );
  const tableStyles = new Map(
    kids(tableStyleList, "tblStyle").map((style) => [at(style, "styleId") ?? "", style]),
  );
  const defaultTableStyle = at(tableStyleList, "def") ?? "";
  // Slides share a few layouts, masters and themes; their derived tables are built once per part.
  const themes = new Map<
    string,
    Promise<{ palette: string[]; fonts: { major: string; minor: string } }>
  >();
  const themeOf = (themePath: string | undefined) => {
    let entry = themes.get(themePath ?? "");
    if (!entry) {
      entry = (themePath ? pkg.xml(themePath) : Promise.resolve(undefined)).then((theme) => ({
        palette: themeColors(theme),
        fonts: {
          major: at(find(find(theme, "majorFont"), "latin"), "typeface") ?? "Calibri Light",
          minor: at(find(find(theme, "minorFont"), "latin"), "typeface") ?? "Calibri",
        },
      }));
      themes.set(themePath ?? "", entry);
    }
    return entry;
  };
  const placeholderMaps = new Map<string, Map<string, XmlNode>>();
  const placeholdersOf = (partPath: string | undefined, tree: XmlNode | undefined) => {
    let map = partPath ? placeholderMaps.get(partPath) : undefined;
    if (map) return map;
    map = new Map<string, XmlNode>();
    for (const sp of findAll(find(tree, "spTree"), "sp")) {
      const ph = find(kid(sp, "nvSpPr"), "ph");
      if (!ph) continue;
      const type = at(ph, "type") ?? "body";
      map.set(`type:${type}`, sp);
      if (at(ph, "idx")) map.set(`idx:${at(ph, "idx")}`, sp);
    }
    if (partPath) placeholderMaps.set(partPath, map);
    return map;
  };
  const slides: OfficeFrame[] = [];
  const slideIds = kids(kid(presentation, "sldIdLst"), "sldId").slice(0, 500);
  for (const id of slideIds) {
    const slidePath = rels.get(at(id, "r:id") ?? "")?.target;
    if (!slidePath) continue;
    const slide = kid(await pkg.xml(slidePath), "sld");
    const slideRels = await pkg.rels(slidePath);
    const layoutPath = [...slideRels.values()].find((r) => r.type === "slideLayout")?.target;
    const layout = layoutPath ? kid(await pkg.xml(layoutPath), "sldLayout") : undefined;
    const layoutRels = layoutPath ? await pkg.rels(layoutPath) : new Map();
    const masterPath = [...layoutRels.values()].find((r) => r.type === "slideMaster")?.target;
    const master = masterPath ? kid(await pkg.xml(masterPath), "sldMaster") : undefined;
    const masterRels = masterPath ? await pkg.rels(masterPath) : new Map();
    const themePath = [...masterRels.values()].find((r) => r.type === "theme")?.target;
    const { palette, fonts } = await themeOf(themePath);
    const clrMap = kid(master, "clrMap")?.attrs ?? {};
    const schemeIndex: Record<string, number> = {
      dk1: 0,
      lt1: 1,
      dk2: 2,
      lt2: 3,
      accent1: 4,
      accent2: 5,
      accent3: 6,
      accent4: 7,
      accent5: 8,
      accent6: 9,
      hlink: 10,
      folHlink: 11,
    };
    const color = (node: XmlNode | undefined): string | undefined => {
      if (!node) return undefined;
      const c = (node.name === "solidFill" ? node : (kid(node, "solidFill") ?? node)).children.find(
        (child) => child.name.endsWith("Clr"),
      );
      if (!c) return undefined;
      let hex: string | undefined;
      if (c.name === "srgbClr") hex = at(c, "val");
      else if (c.name === "sysClr") hex = at(c, "lastClr");
      else if (c.name === "schemeClr") {
        const name = at(c, "val") ?? "";
        const mapped =
          clrMap[name] ?? { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" }[name] ?? name;
        hex = palette[schemeIndex[mapped] ?? 0];
      } else if (c.name === "prstClr")
        hex = {
          black: "000000",
          white: "FFFFFF",
          red: "FF0000",
          green: "00FF00",
          blue: "0000FF",
          yellow: "FFFF00",
          gray: "808080",
        }[at(c, "val") ?? ""];
      if (!hex) return undefined;
      const lumMod = numAt(kid(c, "lumMod"), "val", 100000) / 100000;
      const lumOff = numAt(kid(c, "lumOff"), "val", 0) / 100000;
      const tintBy = numAt(kid(c, "tint"), "val", 100000) / 100000;
      const shadeBy = numAt(kid(c, "shade"), "val", 100000) / 100000;
      if (lumMod !== 1 || lumOff || tintBy !== 1 || shadeBy !== 1)
        hex = [0, 2, 4]
          .map((i) => {
            let v = parseInt(hex!.slice(i, i + 2), 16) * shadeBy;
            v += (255 - v) * (1 - tintBy);
            return Math.round(Math.max(0, Math.min(255, v * lumMod + 255 * lumOff)))
              .toString(16)
              .padStart(2, "0");
          })
          .join("");
      const alpha = numAt(kid(c, "alpha"), "val", 100000) / 100000;
      return alpha < 1
        ? `#${hex}${Math.round(alpha * 255)
            .toString(16)
            .padStart(2, "0")}`
        : `#${hex}`;
    };
    const items: Paint[] = [];
    const imageFor = async (
      rid: string | undefined,
      relsMap: Map<string, { target: string; external: boolean }>,
    ) => {
      const rel = rid ? relsMap.get(rid) : undefined;
      if (!rel || rel.external) return -1;
      if (imageCache.has(rel.target)) return imageCache.get(rel.target)!;
      const data = await pkg.bytes(rel.target);
      const index = data ? images.push({ mime: mimeOf(rel.target), bytes: data }) - 1 : -1;
      imageCache.set(rel.target, index);
      return index;
    };
    const layoutPh = placeholdersOf(layoutPath, layout);
    const masterPh = placeholdersOf(masterPath, master);
    const txStyles = kid(master, "txStyles");
    const inherit = (sp: XmlNode): Inherited[] => {
      const ph = find(kid(sp, "nvSpPr"), "ph");
      if (!ph) return [];
      const type = at(ph, "type") ?? "body";
      const key = at(ph, "idx") ? `idx:${at(ph, "idx")}` : `type:${type}`;
      const normalized = type === "ctrTitle" ? "title" : type === "subTitle" ? "body" : type;
      const fromLayout = layoutPh.get(key) ?? layoutPh.get(`type:${type}`);
      const fromMaster =
        masterPh.get(`type:${normalized}`) ??
        masterPh.get(`type:${type}`) ??
        (normalized === "body" || normalized === "obj" ? masterPh.get("type:body") : undefined);
      return [fromLayout, fromMaster]
        .filter((n): n is XmlNode => !!n)
        .map((n) => ({
          xfrm: find(kid(n, "spPr"), "xfrm"),
          text: kid(n, "txBody"),
          spPr: kid(n, "spPr"),
        }));
    };
    const transform = { x: (v: number) => v, y: (v: number) => v, sx: 1, sy: 1 };
    type Frame = typeof transform;
    const frameOf = (xfrm: XmlNode | undefined, group: Frame) => {
      const off = kid(xfrm, "off");
      const ext = kid(xfrm, "ext");
      return {
        x: group.x(numAt(off, "x") * EMU),
        y: group.y(numAt(off, "y") * EMU),
        w: numAt(ext, "cx") * EMU * group.sx,
        h: numAt(ext, "cy") * EMU * group.sy,
        rotation: numAt(xfrm, "rot") / 60000,
        flipH: at(xfrm, "flipH") === "1",
      };
    };
    type TextDefaults = { color?: string | undefined; bold?: boolean | undefined };
    /** Lays out a text body in `box`, painting into `out`; returns the height the text needs. */
    const drawText = (
      text: ShapeText,
      box: { x: number; y: number; w: number; h: number },
      kind: string,
      inherited: Inherited[],
      defaults: TextDefaults = {},
      out: Paint[] = items,
    ) => {
      const bodyPr = text.body;
      const inheritedBody = inherited.map((i) => kid(i.text, "bodyPr")).find(Boolean);
      const inset = (name: string, fallback: number) =>
        numAt(bodyPr, name, numAt(inheritedBody, name, fallback)) * EMU;
      const [l, t, r, b] = [
        inset("lIns", 91440),
        inset("tIns", 45720),
        inset("rIns", 91440),
        inset("bIns", 45720),
      ];
      const autofit = find(bodyPr, "normAutofit");
      const scale = numAt(autofit, "fontScale", 100000) / 100000;
      const reduction = 1 - numAt(autofit, "lnSpcReduction", 0) / 100000;
      const anchor =
        at(bodyPr, "anchor") ?? at(inheritedBody, "anchor") ?? (kind === "title" ? "ctr" : "t");
      const masterStyle =
        kind === "title"
          ? kid(txStyles, "titleStyle")
          : kind === "other"
            ? kid(txStyles, "otherStyle")
            : kid(txStyles, "bodyStyle");
      const blocks: {
        lines: Line[];
        align: string;
        before: number;
        after: number;
        indent: number;
      }[] = [];
      const counters: number[] = [];
      for (const p of text.paragraphs) {
        const pPr = kid(p, "pPr");
        const level = numAt(pPr, "lvl");
        const levelName = `lvl${level + 1}pPr`;
        const sources = [
          pPr,
          kid(text.listStyle, levelName),
          ...inherited.map((i) => kid(kid(i.text, "lstStyle"), levelName)),
          kid(masterStyle, levelName),
        ];
        const pick = (name: string) => sources.map((s) => at(s, name)).find((v) => v !== undefined);
        const defRPr = (attr: string) =>
          sources.map((s) => at(kid(s, "defRPr"), attr)).find((v) => v !== undefined);
        const defColor =
          sources.map((s) => color(kid(s, "defRPr"))).find(Boolean) ?? defaults.color;
        const bulletSource = sources.find(
          (s) => kid(s, "buNone") || kid(s, "buChar") || kid(s, "buAutoNum"),
        );
        const autoNum = kid(bulletSource, "buAutoNum");
        let bullet = kid(bulletSource, "buChar")
          ? bulletText(at(kid(bulletSource, "buChar"), "char") ?? "•")
          : undefined;
        if (autoNum) {
          counters[level] = (counters[level] ?? numAt(autoNum, "startAt", 1) - 1) + 1;
          counters.length = level + 1;
          bullet = autoNumber(counters[level]!, at(autoNum, "type") ?? "arabicPeriod");
        } else counters.length = level;
        const runs: Run[] = [];
        let firstSize = 0;
        for (const child of p.children) {
          if (child.name !== "r" && child.name !== "fld" && child.name !== "br") continue;
          const rPr = kid(child, "rPr");
          const pt =
            (Number(at(rPr, "sz") ?? defRPr("sz") ?? (kind === "title" ? 4400 : 1800)) / 100) *
            scale;
          const px = pt * PT;
          firstSize ||= px;
          const typeface =
            at(kid(rPr, "latin"), "typeface") ??
            sources.map((s) => at(kid(kid(s, "defRPr"), "latin"), "typeface")).find(Boolean);
          const family =
            !typeface || typeface === "+mn-lt"
              ? fonts.minor
              : typeface === "+mj-lt"
                ? fonts.major
                : typeface;
          const boldAttr = at(rPr, "b") ?? defRPr("b");
          const bold = boldAttr === undefined ? !!defaults.bold : boldAttr === "1";
          const italic = (at(rPr, "i") ?? defRPr("i")) === "1";
          const link = kid(rPr, "hlinkClick");
          const base: Run = {
            text: "",
            font: fontCss(kind === "title" && !typeface ? fonts.major : family, px, bold, italic),
            size: px,
            color: color(rPr) ?? defColor ?? "#000000",
            underline: (at(rPr, "u") ?? "none") !== "none",
            strike: (at(rPr, "strike") ?? "noStrike") !== "noStrike",
            link: link ? slideRels.get(at(link, "r:id") ?? "")?.target : undefined,
            highlight: color(kid(rPr, "highlight")),
          };
          if (child.name === "br") runs.push({ ...base, breakAfter: "line" });
          else runs.push({ ...base, text: kid(child, "t")?.text ?? "" });
        }
        const endSize =
          (Number(at(kid(p, "endParaRPr"), "sz") ?? defRPr("sz") ?? 1800) / 100) * scale * PT;
        const size = firstSize || endSize;
        const marL = Number(pick("marL") ?? 0) * EMU;
        const indent = Number(pick("indent") ?? 0) * EMU;
        if (bullet && runs.some((run) => run.text.trim())) {
          const buSource = sources.find((s) => kid(s, "buClr") || kid(s, "buSzPct"));
          const marker: Run = {
            ...runs[0]!,
            text: bullet,
            link: undefined,
            underline: false,
            strike: false,
            highlight: undefined,
            color: color(kid(buSource, "buClr")) ?? runs[0]!.color,
          };
          const ratio = numAt(kid(buSource, "buSzPct"), "val", 100000) / 100000;
          if (ratio !== 1)
            Object.assign(marker, {
              size: marker.size * ratio,
              font: marker.font.replace(/[\d.]+px/, `${marker.size * ratio}px`),
            });
          runs.unshift(marker, { ...marker, text: " ", tab: indent < 0 });
        }
        const spacingOf = (node: XmlNode | undefined) =>
          kid(node, "spcPts")
            ? (numAt(kid(node, "spcPts"), "val") / 100) * PT
            : kid(node, "spcPct")
              ? (numAt(kid(node, "spcPct"), "val") / 100000) * size * 1.2
              : 0;
        const spacingFrom = (name: string) =>
          spacingOf(sources.map((s) => kid(s, name)).find(Boolean));
        const lnSpc = sources.map((s) => kid(s, "lnSpc")).find(Boolean);
        const spacing =
          (kid(lnSpc, "spcPct") ? numAt(kid(lnSpc, "spcPct"), "val", 100000) / 100000 : 1) *
          reduction;
        const lines = breakLines(
          runs.length
            ? runs
            : [{ text: "", font: fontCss(fonts.minor, endSize), size: endSize, color: "#000" }],
          Math.max(10, box.w - l - r - marL),
          measure,
          Math.max(-marL, indent),
          spacing * 0.95,
        );
        if (kid(lnSpc, "spcPts"))
          for (const line of lines) line.height = (numAt(kid(lnSpc, "spcPts"), "val") / 100) * PT;
        blocks.push({
          lines,
          align: pick("algn") ?? "l",
          before: blocks.length ? spacingFrom("spcBef") : 0,
          after: spacingFrom("spcAft"),
          indent: marL,
        });
      }
      const total = blocks.reduce(
        (s, block) =>
          s + block.before + block.after + block.lines.reduce((h, line) => h + line.height, 0),
        0,
      );
      let y =
        box.y +
        t +
        (anchor === "ctr"
          ? (box.h - t - b - total) / 2
          : anchor === "b"
            ? box.h - t - b - total
            : 0);
      for (const block of blocks) {
        y += block.before;
        for (const line of block.lines) {
          const available = box.w - l - r - block.indent;
          const slack = available - line.width;
          const dx = block.align === "ctr" ? slack / 2 : block.align === "r" ? slack : 0;
          const baseline = y + line.ascent;
          for (const item of line.items) {
            if (!item.text.trim()) continue;
            const x = box.x + l + block.indent + dx + item.x;
            if (item.run.highlight)
              out.push({
                t: "rect",
                x,
                y: baseline - item.run.size * 0.95,
                w: item.width,
                h: item.run.size * 1.2,
                fill: item.run.highlight,
              });
            out.push({
              t: "text",
              x,
              y: baseline,
              text: item.text,
              font: item.run.font,
              size: item.run.size,
              color: item.run.color,
              underline: item.run.underline,
              strike: item.run.strike,
              link: item.run.link,
              width: item.width,
            });
          }
          y += line.height;
        }
        y += block.after;
      }
      return t + total + b;
    };
    // Theme style references: index 0 means none.
    const styleRef = (ref: XmlNode | undefined) => (numAt(ref, "idx") > 0 ? color(ref) : undefined);
    const shapeFill = (spPr: XmlNode | undefined, style: XmlNode | undefined) =>
      kid(spPr, "noFill")
        ? undefined
        : (color(kid(spPr, "solidFill")) ??
          color(find(kid(spPr, "gradFill"), "gs")) ??
          (spPr?.children.some((c) => c.name.endsWith("Fill"))
            ? undefined
            : styleRef(kid(style, "fillRef"))));
    const pictureAt = async (
      blipFill: XmlNode,
      box: { x: number; y: number; w: number; h: number },
      relsMap: Map<string, { target: string; external: boolean }>,
    ) => {
      const index = await imageFor(at(find(blipFill, "blip"), "r:embed"), relsMap);
      const crop = kid(blipFill, "srcRect");
      if (index >= 0)
        items.push({
          t: "image",
          x: box.x,
          y: box.y,
          w: box.w,
          h: box.h,
          image: index,
          ...(crop ? { crop: cropOf(crop) } : {}),
        });
    };
    const table = (tbl: XmlNode, box: { x: number; y: number; w: number; h: number }) => {
      const tblPr = kid(tbl, "tblPr");
      const style =
        tableStyles.get(kid(tblPr, "tableStyleId")?.text.trim() ?? "") ??
        tableStyles.get(defaultTableStyle) ??
        MEDIUM_STYLE_2;
      const on = (name: string) => at(tblPr, name) === "1";
      const columns = kids(kid(tbl, "tblGrid"), "gridCol").map((c) => numAt(c, "w") * EMU);
      const xs = [box.x];
      for (const w of columns) xs.push(xs.at(-1)! + w);
      const trs = kids(tbl, "tr");
      const parts = (r: number, c: number) => {
        const out = ["wholeTbl"];
        const banded = (on("firstRow") ? r - 1 : r) % 2 ? "band2H" : "band1H";
        if (
          on("bandRow") &&
          !(on("firstRow") && r === 0) &&
          !(on("lastRow") && r === trs.length - 1)
        )
          out.push(banded);
        if (on("bandCol")) out.push((on("firstCol") ? c - 1 : c) % 2 ? "band2V" : "band1V");
        if (on("firstCol") && c === 0) out.push("firstCol");
        if (on("lastCol") && c === columns.length - 1) out.push("lastCol");
        if (on("lastRow") && r === trs.length - 1) out.push("lastRow");
        if (on("firstRow") && r === 0) out.push("firstRow");
        return out.flatMap((name) => (kid(style, name) ? [kid(style, name)!] : [])).reverse();
      };
      type Cell = {
        tc: XmlNode;
        r: number;
        c: number;
        colSpan: number;
        rowSpan: number;
        styles: XmlNode[];
      };
      const cells: Cell[] = [];
      trs.forEach((tr, r) =>
        kids(tr, "tc").forEach((tc, c) => {
          if (at(tc, "hMerge") === "1" || at(tc, "vMerge") === "1") return;
          cells.push({
            tc,
            r,
            c,
            colSpan: Math.max(1, numAt(tc, "gridSpan", 1)),
            rowSpan: Math.max(1, numAt(tc, "rowSpan", 1)),
            styles: parts(r, c),
          });
        }),
      );
      const textOf = (cell: Cell, w: number, h: number, out: Paint[], y = 0) => {
        const tcPr = kid(cell.tc, "tcPr");
        const body = kid(cell.tc, "txBody");
        if (!body) return 0;
        const tx = cell.styles.map((s) => kid(s, "tcTxStyle")).filter(Boolean);
        const bodyPr: XmlNode = {
          name: "bodyPr",
          attrs: {
            lIns: at(tcPr, "marL") ?? "91440",
            rIns: at(tcPr, "marR") ?? "91440",
            tIns: at(tcPr, "marT") ?? "45720",
            bIns: at(tcPr, "marB") ?? "45720",
            anchor: at(tcPr, "anchor") ?? "t",
          },
          children: [],
          text: "",
        };
        const bold = tx.map((n) => at(n, "b")).find((v) => v !== undefined);
        return drawText(
          { paragraphs: kids(body, "p"), body: bodyPr, listStyle: kid(body, "lstStyle") },
          { x: xs[cell.c]!, y, w, h },
          "other",
          [],
          {
            color: tx.map((n) => color(n) ?? color(kid(n, "fontRef"))).find(Boolean),
            bold: bold === "on",
          },
          out,
        );
      };
      const widthOf = (cell: Cell) =>
        xs[Math.min(cell.c + cell.colSpan, columns.length)]! - xs[cell.c]!;
      // Rows grow to fit their text, as PowerPoint does.
      const heights = trs.map((tr) => numAt(tr, "h") * EMU);
      for (const cell of cells)
        if (cell.rowSpan === 1)
          heights[cell.r] = Math.max(heights[cell.r]!, textOf(cell, widthOf(cell), 0, []));
      const ys = [box.y];
      for (const h of heights) ys.push(ys.at(-1)! + h);
      const lines: Paint[] = [];
      for (const cell of cells) {
        const tcPr = kid(cell.tc, "tcPr");
        const x = xs[cell.c]!;
        const y = ys[cell.r]!;
        const w = widthOf(cell);
        const h = ys[Math.min(cell.r + cell.rowSpan, heights.length)]! - y;
        const tcStyles = cell.styles.map((s) => kid(s, "tcStyle"));
        const fill = kid(tcPr, "noFill")
          ? undefined
          : (color(kid(tcPr, "solidFill")) ??
            tcStyles.map((n) => color(kid(kid(n, "fill"), "solidFill"))).find(Boolean));
        if (fill) items.push({ t: "rect", x, y, w, h, fill });
        textOf(cell, w, h, items, y);
        const sides = {
          L: ["left", cell.c === 0 ? "left" : "insideV", x, y, x, y + h],
          R: [
            "right",
            cell.c + cell.colSpan >= columns.length ? "right" : "insideV",
            x + w,
            y,
            x + w,
            y + h,
          ],
          T: ["top", cell.r === 0 ? "top" : "insideH", x, y, x + w, y],
          B: [
            "bottom",
            cell.r + cell.rowSpan >= heights.length ? "bottom" : "insideH",
            x,
            y + h,
            x + w,
            y + h,
          ],
        } as const;
        for (const [key, [side, edge, x1, y1, x2, y2]] of Object.entries(sides)) {
          const ln =
            kid(tcPr, `ln${key}`) ??
            tcStyles
              .map(
                (n) =>
                  kid(kid(kid(n, "tcBdr"), side), "ln") ?? kid(kid(kid(n, "tcBdr"), edge), "ln"),
              )
              .find(Boolean);
          const stroke = ln && !kid(ln, "noFill") ? color(ln) : undefined;
          if (stroke)
            lines.push({
              t: "line",
              x1,
              y1,
              x2,
              y2,
              color: stroke,
              width: Math.max(0.75, numAt(ln, "w", 12700) * EMU),
            });
        }
      }
      items.push(...lines);
    };
    const walk = async (
      tree: XmlNode | undefined,
      group: Frame,
      relsMap: Map<string, { target: string; external: boolean }>,
      decorations: boolean,
    ) => {
      for (const node of tree?.children ?? []) {
        if (node.name === "sp" || node.name === "cxnSp") {
          const ph = find(node.children[0], "ph");
          if (decorations && ph) continue;
          const inherited = node.name === "sp" ? inherit(node) : [];
          const spPr = kid(node, "spPr");
          const xfrm = kid(spPr, "xfrm") ?? inherited.map((i) => i.xfrm).find(Boolean);
          if (!xfrm) continue;
          const box = frameOf(xfrm, group);
          const geometry = at(kid(spPr, "prstGeom"), "prst") ?? "rect";
          const line = kid(spPr, "ln");
          const style = kid(node, "style");
          const stroke = kid(line, "noFill")
            ? undefined
            : (color(line) ?? styleRef(kid(style, "lnRef")));
          const fill = node.name === "cxnSp" ? undefined : shapeFill(spPr, style);
          if (geometry === "line" || geometry.includes("Connector") || node.name === "cxnSp")
            items.push({
              t: "line",
              x1: box.flipH ? box.x + box.w : box.x,
              y1: at(xfrm, "flipV") === "1" ? box.y + box.h : box.y,
              x2: box.flipH ? box.x : box.x + box.w,
              y2: at(xfrm, "flipV") === "1" ? box.y : box.y + box.h,
              color: stroke ?? "#000",
              width: Math.max(1, numAt(line, "w", 12700) * EMU),
            });
          else if (fill || stroke)
            items.push({
              t: "rect",
              ...box,
              fill,
              stroke,
              lineWidth: Math.max(0.75, numAt(line, "w", 9525) * EMU),
              shape: PRESET_FALLBACK.has(geometry) ? geometry : "rect",
              rotation: box.rotation,
            });
          const picture = kid(spPr, "blipFill");
          if (picture) await pictureAt(picture, box, relsMap);
          const txBody = kid(node, "txBody");
          if (txBody) {
            const type = at(ph, "type") ?? (ph ? "body" : "other");
            drawText(
              {
                paragraphs: kids(txBody, "p"),
                body: kid(txBody, "bodyPr"),
                listStyle: kid(txBody, "lstStyle"),
              },
              box,
              type === "title" || type === "ctrTitle"
                ? "title"
                : type === "other"
                  ? "other"
                  : "body",
              inherited,
              { color: color(kid(style, "fontRef")) },
            );
          }
        } else if (node.name === "pic") {
          const box = frameOf(kid(kid(node, "spPr"), "xfrm"), group);
          await pictureAt(kid(node, "blipFill") ?? node, box, relsMap);
        } else if (node.name === "grpSp") {
          const xfrm = kid(kid(node, "grpSpPr"), "xfrm");
          const outer = frameOf(xfrm, group);
          const chOff = kid(xfrm, "chOff");
          const chExt = kid(xfrm, "chExt");
          const sx = numAt(chExt, "cx") ? outer.w / (numAt(chExt, "cx") * EMU) : 1;
          const sy = numAt(chExt, "cy") ? outer.h / (numAt(chExt, "cy") * EMU) : 1;
          await walk(
            node,
            {
              x: (v) => outer.x + (v - numAt(chOff, "x") * EMU) * sx,
              y: (v) => outer.y + (v - numAt(chOff, "y") * EMU) * sy,
              sx: sx * group.sx,
              sy: sy * group.sy,
            },
            relsMap,
            decorations,
          );
        } else if (node.name === "graphicFrame") {
          const tbl = find(node, "tbl");
          if (tbl) table(tbl, frameOf(kid(node, "xfrm"), group));
        } else if (node.name === "AlternateContent")
          await walk(kid(node, "Choice") ?? kid(node, "Fallback"), group, relsMap, decorations);
      }
    };
    const background = (node: XmlNode | undefined) => {
      const bg = kid(kid(node, "cSld"), "bg");
      return bg
        ? (color(kid(kid(bg, "bgPr"), "solidFill")) ??
            color(find(kid(bg, "bgPr"), "gs")) ??
            color(kid(bg, "bgRef")))
        : undefined;
    };
    // A picture background paints beneath everything on the slide.
    const backdrop = [
      { node: slide, rels: slideRels },
      { node: layout, rels: layoutRels },
      { node: master, rels: masterRels },
    ].find((part) => kid(kid(part.node, "cSld"), "bg"));
    const backdropFill = kid(kid(kid(kid(backdrop?.node, "cSld"), "bg"), "bgPr"), "blipFill");
    if (backdrop && backdropFill)
      await pictureAt(backdropFill, { x: 0, y: 0, w: width, h: height }, backdrop.rels);
    const showMaster = at(slide, "showMasterSp") !== "0" && at(layout, "showMasterSp") !== "0";
    if (showMaster) await walk(find(master, "spTree"), transform, masterRels, true);
    await walk(find(layout, "spTree"), transform, layoutRels, true);
    await walk(find(slide, "spTree"), transform, slideRels, false);
    const notesPath = [...slideRels.values()].find((r) => r.type === "notesSlide")?.target;
    const notesXml = notesPath ? await pkg.xml(notesPath) : undefined;
    const notesBody = findAll(notesXml, "sp").find((sp) => at(find(sp, "ph"), "type") === "body");
    const notes = notesBody
      ? kids(kid(notesBody, "txBody"), "p")
          .map((p) => textOf(p).trim())
          .join("\n")
          .trim()
      : "";
    slides.push({
      width,
      height,
      background: background(slide) ?? background(layout) ?? background(master) ?? "#ffffff",
      items,
      hidden: at(slide, "show") === "0",
      ...(notes ? { notes } : {}),
    });
  }
  return { slides, images };
}
