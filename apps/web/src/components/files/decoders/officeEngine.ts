// Zero-dependency semantic OOXML engine: Word pages, Excel workbooks and PowerPoint slides as plain, cloneable data.
import { openZip, type NativeZipReader } from "@t3tools/client-runtime/zip/native-zip";

// ---------- XML ----------

export type XmlNode = { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string };
const ENTITY: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const decodeEntities = (s: string) =>
  s.indexOf("&") < 0 ? s : s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITY[e] ?? m)));

/** A non-validating parser: element names lose their namespace prefix, attributes keep theirs. */
export function parseXml(xml: string): XmlNode {
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
    else if (xml.startsWith("<!", lt)) throw new Error("XML declarations are not supported");
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
      const node: XmlNode = { name: qualified.slice(qualified.indexOf(":") + 1), attrs: {}, children: [], text: "" };
      if (space >= 0) for (const m of body.slice(space).matchAll(attrPattern)) node.attrs[m[1]!] = decodeEntities(m[2] ?? m[3] ?? "");
      top.children.push(node);
      if (!selfClosing) stack.push(node);
    }
  }
  return root;
}
const kid = (node: XmlNode | undefined, name: string) => node?.children.find((c) => c.name === name);
const kids = (node: XmlNode | undefined, name: string) => node?.children.filter((c) => c.name === name) ?? [];
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
const at = (node: XmlNode | undefined, name: string) => node?.attrs[name] ?? node?.attrs[name.slice(name.indexOf(":") + 1)];
const numAt = (node: XmlNode | undefined, name: string, fallback = 0) => {
  const v = Number(at(node, name));
  return Number.isFinite(v) && at(node, name) !== undefined ? v : fallback;
};
const onOff = (node: XmlNode | undefined) => (node ? !["0", "false", "off", "none"].includes(at(node, "w:val") ?? at(node, "val") ?? "1") : undefined);
const textOf = (node: XmlNode): string => node.text + node.children.map(textOf).join("");

// ---------- Package ----------

export class OfficePackage {
  readonly zip: NativeZipReader;
  private readonly cache = new Map<string, Promise<XmlNode | undefined>>();
  constructor(zip: NativeZipReader) {
    this.zip = zip;
  }
  static open(bytes: ArrayBuffer | Uint8Array) {
    return new OfficePackage(openZip(bytes, { maxEntries: 20000 }));
  }
  has(path: string) {
    return !!this.zip.getEntry(path);
  }
  xml(path: string) {
    let part = this.cache.get(path);
    if (!part) {
      const entry = this.zip.getEntry(path);
      part = entry ? this.zip.readText(entry, { maxBytes: 256 * 1024 * 1024 }).then(parseXml) : Promise.resolve(undefined);
      this.cache.set(path, part);
    }
    return part;
  }
  bytes(path: string) {
    return this.zip.getEntry(path) ? this.zip.readBytes(path, { maxBytes: 64 * 1024 * 1024 }) : Promise.resolve(undefined);
  }
  /** A part's relationships by id, with targets resolved to package paths (or kept as external URLs). */
  async rels(path: string) {
    const slash = path.lastIndexOf("/");
    const xml = await this.xml(`${path.slice(0, slash + 1)}_rels/${path.slice(slash + 1)}.rels`);
    const out = new Map<string, { target: string; type: string; external: boolean }>();
    for (const rel of kids(kid(xml, "Relationships"), "Relationship")) {
      const external = at(rel, "TargetMode") === "External";
      const target = at(rel, "Target") ?? "";
      out.set(at(rel, "Id") ?? "", { target: external ? target : resolvePath(path.slice(0, slash + 1), target), type: (at(rel, "Type") ?? "").split("/").pop() ?? "", external });
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
const mimeOf = (path: string) => ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp", svg: "image/svg+xml", tif: "image/tiff", tiff: "image/tiff" })[path.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";

// ---------- Display lists ----------

export type Paint =
  | { readonly t: "text"; x: number; y: number; text: string; font: string; size: number; color: string; underline?: boolean | undefined; strike?: boolean | undefined; link?: string | undefined; width: number }
  | { readonly t: "rect"; x: number; y: number; w: number; h: number; fill?: string | undefined; stroke?: string | undefined; lineWidth?: number; shape?: string | undefined; rotation?: number }
  | { readonly t: "line"; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  | { readonly t: "image"; x: number; y: number; w: number; h: number; image: number };
export type OfficeFrame = { width: number; height: number; background?: string | undefined; items: Paint[]; hidden?: boolean; notes?: string };
export type OfficeImage = { mime: string; bytes: Uint8Array };
export type Measure = (text: string, font: string) => number;

/** Character-count metrics for environments without a canvas. */
export const approximateMeasure: Measure = (text, font) => {
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16);
  let w = 0;
  for (const ch of text) w += ch === " " ? 0.28 : /[iljtf.,;:!|']/.test(ch) ? 0.3 : /[A-Z]/.test(ch) ? 0.65 : /[mw]/.test(ch) ? 0.8 : ch.codePointAt(0)! > 0x2e80 ? 1 : 0.52;
  return w * size * (/\b(700|bold)\b/.test(font) ? 1.06 : 1);
};

const fontCss = (family: string, px: number, bold?: boolean, italic?: boolean) => {
  const fallback = /mono|courier|consol/i.test(family) ? "monospace" : /times|georgia|garamond|cambria|serif|roman/i.test(family) && !/sans/i.test(family) ? "serif" : "sans-serif";
  const alias = /calibri/i.test(family) ? `"Carlito", ` : /cambria/i.test(family) ? `"Caladea", ` : "";
  return `${italic ? "italic " : ""}${bold ? 700 : 400} ${Math.max(1, Math.round(px * 100) / 100)}px "${family.replace(/"/g, "")}", ${alias}${fallback}`;
};

type Run = { text: string; font: string; size: number; color: string; underline?: boolean | undefined; strike?: boolean | undefined; link?: string | undefined; image?: { index: number; w: number; h: number }; breakAfter?: "line" | "page"; tab?: boolean; highlight?: string | undefined; baseline?: number };
type Line = { items: { x: number; text: string; run: Run; width: number }[]; width: number; ascent: number; height: number; spaces: number; last: boolean; pageBreak?: boolean };

/** Greedy line breaking over measured word tokens: each token is measured once, so a paragraph is O(n). */
function breakLines(runs: Run[], width: number, measure: Measure, firstIndent = 0, lineSpacing = 1.15, tabStop = 48): Line[] {
  const lines: Line[] = [];
  const cache = new Map<string, number>();
  const measureToken = (text: string, font: string) => {
    const key = `${font}\u0000${text}`;
    let w = cache.get(key);
    if (w === undefined) cache.set(key, (w = measure(text, font)));
    return w;
  };
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
      place("", run, Math.min(run.image.w, width));
    } else if (run.tab) {
      // Within a hanging indent the first tab reaches the indent itself.
      place(" ", run, x < 0 ? -x : Math.max(8, tabStop - (x % tabStop)));
    } else {
      for (const token of run.text.split(/(\s+)/)) {
        if (!token) continue;
        const space = !token.trim();
        let w = measureToken(token, run.font);
        if (!space && x + w > limit && x > 0) push(false);
        if (space && x === 0 && lines.length) continue;
        if (!space && w > limit) {
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

// ---------- Word ----------

type ParaStyle = { align?: string; left?: number; right?: number; first?: number; before?: number; after?: number; line?: number; lineRule?: string; heading?: number; numId?: string | undefined; level?: number; shading?: string; pageBreakBefore?: boolean };
type RunStyle = { bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; size?: number; color?: string; font?: string; highlight?: string; caps?: boolean; vertAlign?: string };
const TWIP = 96 / 1440;
const EMU = 1 / 9525;
const HIGHLIGHT: Record<string, string> = { yellow: "#ffff00", green: "#00ff00", cyan: "#00ffff", magenta: "#ff00ff", blue: "#0000ff", red: "#ff0000", darkBlue: "#000080", darkCyan: "#008080", darkGreen: "#008000", darkMagenta: "#800080", darkRed: "#800000", darkYellow: "#808000", darkGray: "#808080", lightGray: "#c0c0c0", black: "#000000" };

function readPPr(pPr: XmlNode | undefined): ParaStyle {
  if (!pPr) return {};
  const out: ParaStyle = {};
  const ind = kid(pPr, "ind");
  const spacing = kid(pPr, "spacing");
  const jc = at(kid(pPr, "jc"), "w:val");
  if (jc) out.align = jc === "both" || jc === "distribute" ? "justify" : jc === "end" ? "right" : jc === "start" ? "left" : jc;
  if (ind) {
    if (at(ind, "w:left") ?? at(ind, "w:start")) out.left = numAt(ind, at(ind, "w:left") !== undefined ? "w:left" : "w:start") * TWIP;
    if (at(ind, "w:right") ?? at(ind, "w:end")) out.right = numAt(ind, at(ind, "w:right") !== undefined ? "w:right" : "w:end") * TWIP;
    if (at(ind, "w:firstLine")) out.first = numAt(ind, "w:firstLine") * TWIP;
    if (at(ind, "w:hanging")) out.first = -numAt(ind, "w:hanging") * TWIP;
  }
  if (spacing) {
    if (at(spacing, "w:before")) out.before = numAt(spacing, "w:before") * TWIP;
    if (at(spacing, "w:after")) out.after = numAt(spacing, "w:after") * TWIP;
    if (at(spacing, "w:line")) {
      out.line = numAt(spacing, "w:line");
      out.lineRule = at(spacing, "w:lineRule") ?? "auto";
    }
  }
  const numPr = kid(pPr, "numPr");
  if (numPr) {
    out.numId = at(kid(numPr, "numId"), "w:val");
    out.level = numAt(kid(numPr, "ilvl"), "w:val");
  }
  const outline = kid(pPr, "outlineLvl");
  if (outline) out.heading = numAt(outline, "w:val") + 1;
  const shd = at(kid(pPr, "shd"), "w:fill");
  if (shd && shd !== "auto") out.shading = `#${shd}`;
  if (kid(pPr, "pageBreakBefore") && onOff(kid(pPr, "pageBreakBefore"))) out.pageBreakBefore = true;
  return out;
}
function readRPr(rPr: XmlNode | undefined): RunStyle {
  if (!rPr) return {};
  const out: RunStyle = {};
  for (const [key, name] of [["bold", "b"], ["italic", "i"], ["strike", "strike"], ["caps", "caps"]] as const) {
    const flag = onOff(kid(rPr, name));
    if (flag !== undefined) out[key] = flag;
  }
  const u = at(kid(rPr, "u"), "w:val");
  if (u) out.underline = u !== "none";
  const size = at(kid(rPr, "sz"), "w:val");
  if (size) out.size = (Number(size) / 2) * (96 / 72);
  const color = at(kid(rPr, "color"), "w:val");
  if (color && color !== "auto") out.color = `#${color}`;
  const fonts = kid(rPr, "rFonts");
  const font = at(fonts, "w:ascii") ?? at(fonts, "w:hAnsi") ?? at(fonts, "w:cs");
  if (font) out.font = font;
  const highlight = at(kid(rPr, "highlight"), "w:val");
  if (highlight && HIGHLIGHT[highlight]) out.highlight = HIGHLIGHT[highlight];
  const shd = at(kid(rPr, "shd"), "w:fill");
  if (shd && shd !== "auto" && !out.highlight) out.highlight = `#${shd}`;
  const vert = at(kid(rPr, "vertAlign"), "w:val");
  if (vert) out.vertAlign = vert;
  return out;
}

type DocContext = {
  pkg: OfficePackage;
  styles: Map<string, { p: ParaStyle; r: RunStyle; basedOn: string | undefined; type: string; name: string; table: XmlNode | undefined }>;
  defaults: { p: ParaStyle; r: RunStyle };
  numbering: Map<string, { levels: { format: string; text: string; start: number; p: ParaStyle; r: RunStyle }[] }>;
  counters: Map<string, number[]>;
  rels: Map<string, { target: string; type: string; external: boolean }>;
  images: OfficeImage[];
  imageIndex: Map<string, number>;
  theme: { major: string; minor: string };
  measure: Measure;
};

function styleChain<T>(ctx: DocContext, id: string | undefined, pick: (s: { p: ParaStyle; r: RunStyle }) => T): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (let s = id ? ctx.styles.get(id) : undefined; s && !seen.has(s.name); s = s.basedOn ? ctx.styles.get(s.basedOn) : undefined) {
    seen.add(s.name);
    out.unshift(pick(s));
  }
  return out;
}

function formatCounter(value: number, format: string) {
  const roman = (n: number) => {
    let out = "";
    for (const [v, s] of [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]] as const)
      while (n >= v) {
        out += s;
        n -= v;
      }
    return out;
  };
  const letter = (n: number) => String.fromCharCode(97 + ((n - 1) % 26)).repeat(Math.floor((n - 1) / 26) + 1);
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
    default:
      return String(value);
  }
}

export type WordDocumentModel = { pages: OfficeFrame[]; images: OfficeImage[]; bookmarks: Record<string, { page: number; y: number }> };

export async function layoutDocx(bytes: ArrayBuffer | Uint8Array, measure: Measure = approximateMeasure): Promise<WordDocumentModel> {
  const pkg = OfficePackage.open(bytes);
  const rootRels = await pkg.rels("");
  const mainPath = [...rootRels.values()].find((r) => r.type === "officeDocument")?.target ?? "word/document.xml";
  const document = await pkg.xml(mainPath);
  const body = find(document, "body");
  if (!body) throw new Error("This document has no body.");
  const rels = await pkg.rels(mainPath);
  const partOf = (type: string) => [...rels.values()].find((r) => r.type === type)?.target;
  const ctx: DocContext = { pkg, styles: new Map(), defaults: { p: {}, r: {} }, numbering: new Map(), counters: new Map(), rels, images: [], imageIndex: new Map(), theme: { major: "Calibri Light", minor: "Calibri" }, measure };
  const theme = partOf("theme") ? await pkg.xml(partOf("theme")!) : undefined;
  ctx.theme = { major: at(find(find(theme, "majorFont"), "latin"), "typeface") ?? "Calibri Light", minor: at(find(find(theme, "minorFont"), "latin"), "typeface") ?? "Calibri" };
  const styles = partOf("styles") ? await pkg.xml(partOf("styles")!) : undefined;
  const docDefaults = find(styles, "docDefaults");
  ctx.defaults = { p: readPPr(find(docDefaults, "pPr")), r: readRPr(find(docDefaults, "rPr")) };
  const defaultFonts = find(find(docDefaults, "rPr"), "rFonts");
  if (!ctx.defaults.r.font) ctx.defaults.r.font = at(defaultFonts, "w:asciiTheme")?.startsWith("major") ? ctx.theme.major : ctx.theme.minor;
  for (const style of kids(kid(styles, "styles"), "style")) {
    const id = at(style, "w:styleId") ?? "";
    const name = at(kid(style, "name"), "w:val") ?? id;
    const p = readPPr(kid(style, "pPr"));
    const heading = /^heading (\d)$/i.exec(name) ?? /^Heading(\d)$/.exec(id);
    if (heading) p.heading = Number(heading[1]);
    if (/^title$/i.test(name)) p.heading = 0;
    const rFonts = kid(kid(style, "rPr"), "rFonts");
    const r = readRPr(kid(style, "rPr"));
    if (!r.font && at(rFonts, "w:asciiTheme")) r.font = at(rFonts, "w:asciiTheme")!.startsWith("major") ? ctx.theme.major : ctx.theme.minor;
    ctx.styles.set(id, { p, r, basedOn: at(kid(style, "basedOn"), "w:val"), type: at(style, "w:type") ?? "", name, table: kid(style, "tblPr") });
  }
  const numbering = partOf("numbering") ? await pkg.xml(partOf("numbering")!) : undefined;
  const abstracts = new Map<string, XmlNode>();
  for (const abstract of kids(kid(numbering, "numbering"), "abstractNum")) abstracts.set(at(abstract, "w:abstractNumId") ?? "", abstract);
  for (const num of kids(kid(numbering, "numbering"), "num")) {
    const abstract = abstracts.get(at(kid(num, "abstractNumId"), "w:val") ?? "");
    ctx.numbering.set(at(num, "w:numId") ?? "", {
      levels: kids(abstract, "lvl").map((lvl) => ({
        format: at(kid(lvl, "numFmt"), "w:val") ?? "decimal",
        text: at(kid(lvl, "lvlText"), "w:val") ?? "",
        start: numAt(kid(lvl, "start"), "w:val", 1),
        p: readPPr(kid(lvl, "pPr")),
        r: readRPr(kid(lvl, "rPr")),
      })),
    });
  }
  // Page geometry from the final section.
  const sect = kid(body, "sectPr");
  const pgSz = kid(sect, "pgSz");
  const pgMar = kid(sect, "pgMar");
  const page = { width: numAt(pgSz, "w:w", 12240) * TWIP, height: numAt(pgSz, "w:h", 15840) * TWIP, top: numAt(pgMar, "w:top", 1440) * TWIP, bottom: numAt(pgMar, "w:bottom", 1440) * TWIP, left: numAt(pgMar, "w:left", 1440) * TWIP, right: numAt(pgMar, "w:right", 1440) * TWIP };
  const pages: OfficeFrame[] = [];
  const bookmarks: WordDocumentModel["bookmarks"] = {};
  let frame: OfficeFrame = { width: page.width, height: page.height, items: [] };
  pages.push(frame);
  let y = page.top;
  const contentWidth = page.width - page.left - page.right;
  const newPage = () => {
    if (pages.length >= 1000) throw new Error("Preview limited to 1,000 pages.");
    frame = { width: page.width, height: page.height, items: [] };
    pages.push(frame);
    y = page.top;
  };
  const bottom = page.height - page.bottom;

  // Blocks render into a target that may be a page (paginating) or a table cell (measured, then placed).
  type Target = { items: Paint[]; y: number; paginate: boolean };
  const imageFor = async (rid: string) => {
    if (ctx.imageIndex.has(rid)) return ctx.imageIndex.get(rid)!;
    const rel = rels.get(rid);
    const data = rel && !rel.external ? await pkg.bytes(rel.target) : undefined;
    const index = data ? ctx.images.push({ mime: mimeOf(rel!.target), bytes: data }) - 1 : -1;
    ctx.imageIndex.set(rid, index);
    return index;
  };
  const runsOf = async (p: XmlNode, paraRun: RunStyle, styleId: string | undefined): Promise<{ runs: Run[]; bookmarks: string[] }> => {
    const runs: Run[] = [];
    const names: string[] = [];
    const visit = async (node: XmlNode, link: string | undefined) => {
      for (const child of node.children) {
        if (child.name === "r") {
          const runStyleId = at(kid(kid(child, "rPr"), "rStyle"), "w:val");
          const r: RunStyle = Object.assign({}, ctx.defaults.r, ...styleChain(ctx, styleId, (s) => s.r), paraRun, ...styleChain(ctx, runStyleId, (s) => s.r), readRPr(kid(child, "rPr")));
          const px = (r.size ?? 14.67) * (r.vertAlign && r.vertAlign !== "baseline" ? 0.65 : 1);
          const base = { font: fontCss(r.font ?? ctx.theme.minor, px, r.bold, r.italic), size: px, color: r.color ?? (link ? "#0563c1" : "#000000"), underline: r.underline ?? !!link, strike: r.strike, link, highlight: r.highlight, baseline: r.vertAlign === "superscript" ? -px * 0.5 : r.vertAlign === "subscript" ? px * 0.25 : 0 };
          for (const part of child.children) {
            if (part.name === "t") runs.push({ ...base, text: r.caps ? part.text.toUpperCase() : part.text });
            else if (part.name === "tab") runs.push({ ...base, text: " ", tab: true });
            else if (part.name === "br" || part.name === "cr") {
              if (at(part, "w:type") === "page") runs.push({ ...base, text: "", breakAfter: "page" });
              else runs.push({ ...base, text: "", breakAfter: "line" });
            } else if (part.name === "sym") runs.push({ ...base, text: String.fromCharCode(parseInt(at(part, "w:char") ?? "20", 16) & 0xffff) });
            else if (part.name === "drawing" || part.name === "AlternateContent" || part.name === "pict") {
              const blip = find(part, "blip");
              const extent = find(part, "extent");
              const rid = at(blip, "r:embed");
              if (rid && extent) {
                const index = await imageFor(rid);
                if (index >= 0) runs.push({ ...base, text: "", image: { index, w: numAt(extent, "cx") * EMU, h: numAt(extent, "cy") * EMU } });
              }
              for (const textbox of findAll(part, "txbxContent").slice(0, 1)) for (const inner of kids(textbox, "p")) await visit(inner, link);
            }
          }
        } else if (child.name === "hyperlink") {
          const rel = rels.get(at(child, "r:id") ?? "");
          await visit(child, rel?.external ? rel.target : at(child, "w:anchor") ? `#${at(child, "w:anchor")}` : link);
        } else if (child.name === "bookmarkStart") names.push(at(child, "w:name") ?? "");
        else if (["ins", "smartTag", "sdt", "sdtContent", "fldSimple", "customXml", "moveTo"].includes(child.name)) await visit(child, link);
      }
    };
    await visit(p, undefined);
    return { runs, bookmarks: names };
  };

  const paragraph = async (p: XmlNode, target: Target, width: number, offsetX: number) => {
    const pPr = kid(p, "pPr");
    const styleId = at(kid(pPr, "pStyle"), "w:val");
    const own = readPPr(pPr);
    const merged: ParaStyle = Object.assign({}, ctx.defaults.p, ...styleChain(ctx, styleId ?? "Normal", (s) => s.p), own);
    const numId = own.numId ?? merged.numId;
    const level = own.level ?? merged.level ?? 0;
    let marker: Run | undefined;
    const list = numId && numId !== "0" ? ctx.numbering.get(numId) : undefined;
    const lvl = list?.levels[level];
    const paraRun = readRPr(kid(pPr, "rPr"));
    if (lvl) {
      Object.assign(merged, { ...lvl.p, ...own });
      const counters = ctx.counters.get(numId!) ?? list.levels.map((l) => l.start - 1);
      counters[level] = (counters[level] ?? 0) + 1;
      for (let deeper = level + 1; deeper < counters.length; deeper++) counters[deeper] = (list.levels[deeper]?.start ?? 1) - 1;
      ctx.counters.set(numId!, counters);
      const text = lvl.format === "bullet" ? (/[•]/.test(lvl.text) || !lvl.text ? "•" : lvl.text.replace(/[-]/g, "▪")) : lvl.format === "none" ? "" : lvl.text.replace(/%(\d)/g, (_, n: string) => formatCounter(counters[Number(n) - 1] ?? 1, list.levels[Number(n) - 1]?.format ?? "decimal"));
      const r: RunStyle = Object.assign({}, ctx.defaults.r, ...styleChain(ctx, styleId, (s) => s.r), lvl.r);
      const px = r.size ?? 14.67;
      if (text) marker = { text: `${text}`, font: fontCss(r.font && !/symbol|wingdings/i.test(r.font) ? r.font : ctx.theme.minor, px, r.bold, r.italic), size: px, color: r.color ?? "#000" };
    }
    const { runs, bookmarks: names } = await runsOf(p, paraRun, styleId);
    const left = merged.left ?? 0;
    const right = merged.right ?? 0;
    const first = merged.first ?? 0;
    const spacing = merged.lineRule === "auto" || !merged.lineRule ? (merged.line ?? 259) / 240 : 1;
    const before = merged.before ?? 0;
    const after = merged.after ?? (merged.heading !== undefined ? 4 : 10.67);
    if (target.paginate && merged.pageBreakBefore && frame.items.length) newPage(), (target.y = y);
    if (!(target.paginate && target.y === page.top)) target.y += before;
    const all = marker ? [{ ...marker, text: marker.text }, { ...marker, text: " ", tab: true }, ...runs] : runs;
    const lines = breakLines(all.length ? all : [{ text: "", font: fontCss(ctx.defaults.r.font ?? ctx.theme.minor, ctx.defaults.r.size ?? 14.67), size: ctx.defaults.r.size ?? 14.67, color: "#000" }], width - left - right, ctx.measure, first, spacing);
    for (const name of names) bookmarks[name] = { page: pages.length - 1, y: target.y };
    for (const line of lines) {
      const fixed = merged.lineRule === "exact" || merged.lineRule === "atLeast" ? (merged.line ?? 0) * TWIP : 0;
      const height = merged.lineRule === "exact" ? fixed : Math.max(line.height, fixed);
      if (target.paginate && target.y + height > bottom && target.y > page.top) {
        newPage();
        target.y = y;
        target.items = frame.items;
      }
      const slack = width - left - right - line.width - (line === lines[0] ? first : 0);
      const align = merged.align ?? "left";
      const shift = align === "center" ? slack / 2 : align === "right" ? slack : 0;
      const stretch = align === "justify" && !line.last && line.spaces ? slack / line.spaces : 0;
      if (merged.shading) target.items.push({ t: "rect", x: offsetX + left, y: target.y, w: width - left - right, h: height, fill: merged.shading });
      let extra = 0;
      const baseline = target.y + line.ascent + (height - line.height) / 2;
      for (const item of line.items) {
        const x = offsetX + left + shift + item.x + extra + (line === lines[0] ? 0 : 0);
        if (!item.text.trim() && !item.run.image) extra += stretch * item.text.length;
        if (item.run.image) {
          target.items.push({ t: "image", x, y: baseline - item.run.image.h, w: item.width, h: item.run.image.h * (item.width / item.run.image.w), image: item.run.image.index });
          continue;
        }
        if (item.run.highlight) target.items.push({ t: "rect", x, y: baseline - item.run.size * 0.95, w: item.width, h: item.run.size * 1.2, fill: item.run.highlight });
        if (item.text.trim() || item.run.underline) target.items.push({ t: "text", x, y: baseline + (item.run.baseline ?? 0), text: item.text, font: item.run.font, size: item.run.size, color: item.run.color, underline: item.run.underline, strike: item.run.strike, link: item.run.link, width: item.width });
      }
      target.y += height;
      if (line.pageBreak && target.paginate) {
        newPage();
        target.y = y;
        target.items = frame.items;
      }
    }
    target.y += after;
  };

  const table = async (tbl: XmlNode, target: Target, width: number, offsetX: number) => {
    const tblPr = kid(tbl, "tblPr");
    const styleId = at(kid(tblPr, "tblStyle"), "w:val");
    let borders = kid(tblPr, "tblBorders");
    for (let id = styleId, depth = 0; !borders && id && depth < 16; id = ctx.styles.get(id)?.basedOn, depth++) borders = kid(ctx.styles.get(id)?.table, "tblBorders");
    const bordered = !!borders && borders.children.some((b) => !["nil", "none"].includes(at(b, "w:val") ?? "nil"));
    const grid = kids(kid(tbl, "tblGrid"), "gridCol").map((c) => numAt(c, "w:w") * TWIP);
    // Autofit tables widen a column to its widest unbreakable word, as Word does.
    if (at(kid(tblPr, "tblLayout"), "w:type") !== "fixed") {
      const font = fontCss(ctx.defaults.r.font ?? ctx.theme.minor, ctx.defaults.r.size ?? 14.67, true);
      for (const tr of kids(tbl, "tr")) {
        let column = 0;
        for (const tc of kids(tr, "tc")) {
          const span = numAt(kid(kid(tc, "tcPr"), "gridSpan"), "w:val", 1);
          if (span === 1 && column < grid.length) {
            const widest = Math.max(0, ...textOf(tc).split(/\s+/).map((word) => (word ? ctx.measure(word, font) : 0)));
            grid[column] = Math.max(grid[column]!, Math.min(widest * 1.25 + 18, width));
          }
          column += span;
        }
      }
    }
    const total = grid.reduce((s, w) => s + w, 0) || width;
    const scale = total > width ? width / total : 1;
    const columns = grid.length ? grid.map((w) => w * scale) : [width];
    const margins = kid(tblPr, "tblCellMar");
    const padLeft = numAt(kid(margins, "left") ?? kid(margins, "start"), "w:w", 108) * TWIP;
    const padRight = numAt(kid(margins, "right") ?? kid(margins, "end"), "w:w", 108) * TWIP;
    const jc = at(kid(tblPr, "jc"), "w:val");
    const tableWidth = columns.reduce((s, w) => s + w, 0);
    const left = offsetX + (jc === "center" ? (width - tableWidth) / 2 : jc === "right" ? width - tableWidth : numAt(kid(tblPr, "tblInd"), "w:w") * TWIP);
    for (const tr of kids(tbl, "tr")) {
      // Each cell lays out into its own list, then the row lands where it fits.
      let column = 0;
      const cells: { x: number; w: number; items: Paint[]; height: number; fill?: string | undefined; border: string | undefined; merged: boolean }[] = [];
      for (const tc of kids(tr, "tc")) {
        const tcPr = kid(tc, "tcPr");
        const span = numAt(kid(tcPr, "gridSpan"), "w:val", 1);
        const x = left + columns.slice(0, column).reduce((s, w) => s + w, 0);
        const w = columns.slice(column, column + span).reduce((s, v) => s + v, 0) || columns.at(-1)!;
        column += span;
        const vMerge = kid(tcPr, "vMerge");
        const merged = !!vMerge && at(vMerge, "w:val") !== "restart";
        const shading = at(kid(tcPr, "shd"), "w:fill");
        const edge = kid(tcPr, "tcBorders")?.children.find((b) => !["nil", "none"].includes(at(b, "w:val") ?? "nil"));
        const border = edge ? `#${(at(edge, "w:color") ?? "auto") === "auto" ? "000000" : at(edge, "w:color")}` : bordered ? "#808080" : undefined;
        const cell: Target = { items: [], y: 4, paginate: false };
        if (!merged) await blocks(tc, cell, w - padLeft - padRight, x + padLeft);
        cells.push({ x, w, items: cell.items, height: cell.y + 2, fill: shading && shading !== "auto" ? `#${shading}` : undefined, border, merged });
      }
      const rowHeight = Math.max(numAt(kid(kid(tr, "trPr"), "trHeight"), "w:val") * TWIP, ...cells.map((c) => c.height));
      if (target.paginate && target.y + rowHeight > bottom && target.y > page.top) {
        newPage();
        target.y = y;
        target.items = frame.items;
      }
      for (const cell of cells) {
        if (cell.fill) target.items.push({ t: "rect", x: cell.x, y: target.y, w: cell.w, h: rowHeight, fill: cell.fill });
        if (cell.border) target.items.push({ t: "rect", x: cell.x, y: target.y, w: cell.w, h: rowHeight, stroke: cell.border, lineWidth: 0.75 });
        for (const item of cell.items) target.items.push(shift(item, 0, target.y));
      }
      target.y += rowHeight;
    }
    target.y += 6;
  };

  const blocks = async (container: XmlNode, target: Target, width: number, offsetX: number) => {
    for (const child of container.children) {
      if (child.name === "p") await paragraph(child, target, width, offsetX);
      else if (child.name === "tbl") await table(child, target, width, offsetX);
      else if (child.name === "sdt") await blocks(kid(child, "sdtContent") ?? child, target, width, offsetX);
      else if (child.name === "customXml") await blocks(child, target, width, offsetX);
    }
  };
  const target: Target = { items: frame.items, y, paginate: true };
  await blocks(body, target, contentWidth, page.left);
  return { pages, images: ctx.images, bookmarks };
}

function shift(item: Paint, dx: number, dy: number): Paint {
  if (item.t === "line") return { ...item, x1: item.x1 + dx, x2: item.x2 + dx, y1: item.y1 + dy, y2: item.y2 + dy };
  return { ...item, x: item.x + dx, y: item.y + dy };
}

// ---------- Excel ----------

export type CellStyle = { font: string; color: string; fill: string | undefined; align: string | undefined; valign: string | undefined; wrap: boolean; borders: Partial<Record<"left" | "right" | "top" | "bottom", string>> | undefined; format: string; bold: boolean; underline: boolean };
export type SheetCell = { value: string | number | boolean | null; text: string; formula?: string; style: number; error?: boolean };
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
};
export type Workbook = { sheets: { name: string; path: string; hidden: boolean; rels: string }[]; styles: CellStyle[]; strings: string[]; date1904: boolean; active: number; theme: string[] };

const BUILTIN_FORMATS: Record<number, string> = { 0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??", 14: "m/d/yyyy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "m/d/yyyy h:mm", 37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)", 45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0", 48: "##0.0E+0", 49: "@" };
const INDEXED = ["000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF", "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF", "800000", "008000", "000080", "808000", "800080", "008080", "C0C0C0", "808080", "9999FF", "993366", "FFFFCC", "CCFFFF", "660066", "FF8080", "0066CC", "CCCCFF", "000080", "FF00FF", "FFFF00", "00FFFF", "800080", "800000", "008080", "0000FF", "00CCFF", "CCFFFF", "CCFFCC", "FFFF99", "99CCFF", "FF99CC", "CC99FF", "FFCC99", "3366FF", "33CCCC", "99CC00", "FFCC00", "FF9900", "FF6600", "666699", "969696", "003366", "339966", "003300", "333300", "993300", "993366", "333399", "333333"];

function tint(hex: string, amount: number) {
  if (!amount) return hex;
  const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return c.map((v) => Math.round(amount < 0 ? v * (1 + amount) : v + (255 - v) * amount).toString(16).padStart(2, "0")).join("");
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
  if (indexed !== undefined) return Number(indexed) === 64 ? undefined : INDEXED[Number(indexed)] ? `#${INDEXED[Number(indexed)]}` : undefined;
  return undefined;
}
function themeColors(theme: XmlNode | undefined) {
  const scheme = find(theme, "clrScheme");
  return ["dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"].map((name) => {
    const node = kid(scheme, name);
    return at(kid(node, "srgbClr"), "val") ?? at(kid(node, "sysClr"), "lastClr") ?? (name === "lt1" ? "FFFFFF" : "000000");
  });
}

export async function openXlsx(bytes: ArrayBuffer | Uint8Array): Promise<{ pkg: OfficePackage; workbook: Workbook }> {
  const pkg = OfficePackage.open(bytes);
  const rootRels = await pkg.rels("");
  const path = [...rootRels.values()].find((r) => r.type === "officeDocument")?.target ?? "xl/workbook.xml";
  const xml = await pkg.xml(path);
  const rels = await pkg.rels(path);
  const partOf = (type: string) => [...rels.values()].find((r) => r.type === type)?.target;
  const theme = themeColors(partOf("theme") ? await pkg.xml(partOf("theme")!) : undefined);
  const strings: string[] = [];
  const sst = partOf("sharedStrings") ? await pkg.xml(partOf("sharedStrings")!) : undefined;
  for (const si of kids(kid(sst, "sst"), "si")) strings.push(kids(si, "t").map((t) => t.text).join("") || kids(si, "r").map((r) => kid(r, "t")?.text ?? "").join(""));
  const stylesXml = partOf("styles") ? await pkg.xml(partOf("styles")!) : undefined;
  const sheetStyles = kid(stylesXml, "styleSheet");
  const formats = new Map<number, string>();
  for (const fmt of kids(kid(sheetStyles, "numFmts"), "numFmt")) formats.set(numAt(fmt, "numFmtId"), at(fmt, "formatCode") ?? "General");
  const fonts = kids(kid(sheetStyles, "fonts"), "font").map((f) => {
    const px = numAt(kid(f, "sz"), "val", 11) * (96 / 72);
    const bold = !!kid(f, "b") && onOff(kid(f, "b"))!;
    return { font: fontCss(at(kid(f, "name"), "val") ?? "Calibri", px, bold, !!kid(f, "i") && onOff(kid(f, "i"))!), color: sheetColor(kid(f, "color"), theme) ?? "#000000", bold, underline: !!kid(f, "u") };
  });
  const fills = kids(kid(sheetStyles, "fills"), "fill").map((f) => {
    const pattern = kid(f, "patternFill");
    return at(pattern, "patternType") && at(pattern, "patternType") !== "none" ? sheetColor(kid(pattern, "fgColor"), theme) : undefined;
  });
  const borderLists = kids(kid(sheetStyles, "borders"), "border").map((b) => {
    const out: Record<string, string> = {};
    for (const side of ["left", "right", "top", "bottom"]) {
      const node = kid(b, side);
      if (at(node, "style")) out[side] = sheetColor(kid(node, "color"), theme) ?? "#000000";
    }
    return out;
  });
  const styles = kids(kid(sheetStyles, "cellXfs"), "xf").map((xf): CellStyle => {
    const font = fonts[numAt(xf, "fontId")] ?? { font: fontCss("Calibri", 14.67), color: "#000", bold: false, underline: false };
    const alignment = kid(xf, "alignment");
    const id = numAt(xf, "numFmtId");
    return { font: font.font, color: font.color, bold: font.bold, underline: font.underline, fill: fills[numAt(xf, "fillId")], align: at(alignment, "horizontal"), valign: at(alignment, "vertical"), wrap: at(alignment, "wrapText") === "1", borders: borderLists[numAt(xf, "borderId")], format: formats.get(id) ?? BUILTIN_FORMATS[id] ?? "General" };
  });
  const workbook = kid(xml, "workbook");
  const sheets = kids(kid(workbook, "sheets"), "sheet").map((s) => ({ name: at(s, "name") ?? "Sheet", path: rels.get(at(s, "r:id") ?? "")?.target ?? "", hidden: (at(s, "state") ?? "visible") !== "visible", rels: at(s, "r:id") ?? "" }));
  return { pkg, workbook: { sheets, styles, strings, date1904: at(kid(workbook, "workbookPr"), "date1904") === "1", active: numAt(kid(kid(workbook, "bookViews"), "workbookView"), "activeTab"), theme } };
}

export const columnName = (index: number) => {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};
export function parseCellRef(ref: string) {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(ref.trim());
  if (!m) return undefined;
  let column = 0;
  for (const ch of m[1]!.toUpperCase()) column = column * 26 + ch.charCodeAt(0) - 64;
  return { row: Number(m[2]) - 1, column: column - 1 };
}

/** Reads one worksheet with a streaming scan of its rows, so large sheets build no XML tree. */
export async function readSheet(pkg: OfficePackage, workbook: Workbook, index: number): Promise<SheetData> {
  const sheet = workbook.sheets[index]!;
  const entry = pkg.zip.getEntry(sheet.path);
  const xml = entry ? await pkg.zip.readText(entry, { maxBytes: 512 * 1024 * 1024 }) : "";
  const data: SheetData = { name: sheet.name, rows: new Map(), maxRow: 0, maxColumn: 0, columnWidths: new Map(), rowHeights: new Map(), hiddenRows: new Set(), hiddenColumns: new Set(), merges: [], frozen: { rows: 0, columns: 0 }, gridlines: true, links: new Map(), defaultWidth: 64, defaultHeight: 20 };
  const head = xml.slice(0, Math.max(0, xml.indexOf("<sheetData"))) || xml.slice(0, 20000);
  const view = /<sheetView\b([^>]*)>/.exec(head)?.[1] ?? "";
  if (/showGridLines="(0|false)"/.test(view)) data.gridlines = false;
  const pane = /<pane\b([^>]*)\/?>/.exec(head)?.[1] ?? "";
  if (/state="frozen/.test(pane)) data.frozen = { rows: Number(/ySplit="([\d.]+)"/.exec(pane)?.[1] ?? 0), columns: Number(/xSplit="([\d.]+)"/.exec(pane)?.[1] ?? 0) };
  const format = /<sheetFormatPr\b([^>]*)>/.exec(head)?.[1] ?? "";
  const defaultChars = Number(/defaultColWidth="([\d.]+)"/.exec(format)?.[1] ?? /baseColWidth="([\d.]+)"/.exec(format)?.[1] ?? 8.43);
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
  const start = xml.indexOf("<sheetData");
  rowPattern.lastIndex = start < 0 ? xml.length : start;
  for (let rm = rowPattern.exec(xml); rm; rm = rowPattern.exec(xml)) {
    const attrs = rm[1]!;
    const r = Number(/\br="(\d+)"/.exec(attrs)?.[1] ?? nextRow + 1) - 1;
    nextRow = r + 1;
    if (r >= 1_048_576) break;
    const ht = /\bht="([\d.]+)"/.exec(attrs)?.[1];
    if (ht && /customHeight="(1|true)"/.test(attrs)) data.rowHeights.set(r, Number(ht) * (96 / 72));
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
      const type = /\bt="(\w+)"/.exec(ca)?.[1] ?? "n";
      const style = Number(/\bs="(\d+)"/.exec(ca)?.[1] ?? 0);
      const inner = cm[2] ?? "";
      const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(inner)?.[1];
      let value: SheetCell["value"] = null;
      let error = false;
      if (type === "s" && raw !== undefined) value = strings[Number(raw)] ?? "";
      else if (type === "inlineStr") value = decodeEntities([...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""));
      else if (type === "str" && raw !== undefined) value = decodeEntities(raw);
      else if (type === "b" && raw !== undefined) value = raw === "1";
      else if (type === "e") {
        value = raw ?? "#N/A";
        error = true;
      } else if (raw !== undefined && raw !== "") value = Number(raw);
      if (value === null && formula === undefined && !style) continue;
      row.set(column, { value, text: "", style, ...(formula !== undefined ? { formula: decodeEntities(formula) } : {}), ...(error ? { error } : {}) });
      if (value !== null || formula !== undefined) data.maxColumn = Math.max(data.maxColumn, column + 1);
    }
    if (row.size) {
      data.rows.set(r, row);
      data.maxRow = Math.max(data.maxRow, r + 1);
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
    if (ref && (target?.external || location)) data.links.set(ref, target?.external ? target.target : `#${decodeEntities(location!)}`);
  }
  evaluateSheet(data, workbook);
  return data;
}

// ---------- Formulas and number formats ----------

type Value = number | string | boolean | null | Value[];
const flat = (v: Value): Value[] => (Array.isArray(v) ? v.flatMap(flat) : [v]);
const toNumber = (v: Value): number => (typeof v === "number" ? v : typeof v === "boolean" ? Number(v) : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : 0);
const FUNCTIONS: Record<string, (args: Value[]) => Value> = {
  SUM: (a) => flat(a).reduce<number>((s, v) => s + (typeof v === "number" ? v : 0), 0),
  AVERAGE: (a) => {
    const n = flat(a).filter((v): v is number => typeof v === "number");
    return n.length ? n.reduce((s, v) => s + v, 0) / n.length : "#DIV/0!";
  },
  COUNT: (a) => flat(a).filter((v) => typeof v === "number").length,
  COUNTA: (a) => flat(a).filter((v) => v !== null && v !== "").length,
  MIN: (a) => Math.min(...flat(a).filter((v): v is number => typeof v === "number"), Infinity) === Infinity ? 0 : Math.min(...flat(a).filter((v): v is number => typeof v === "number")),
  MAX: (a) => Math.max(...flat(a).filter((v): v is number => typeof v === "number"), -Infinity) === -Infinity ? 0 : Math.max(...flat(a).filter((v): v is number => typeof v === "number")),
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
const truthy = (v: Value): boolean => (typeof v === "string" ? v.toUpperCase() === "TRUE" : Boolean(Array.isArray(v) ? v.length : v));
const display = (v: Value): string => (v === null ? "" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : Array.isArray(v) ? display(v[0] ?? null) : String(v));

/** Evaluates an A1-style formula: arithmetic, comparisons, `&`, ranges and common functions. */
export function evaluateFormula(formula: string, lookup: (row: number, column: number) => Value): Value {
  const tokens = formula.replace(/^=/, "").match(/"(?:[^"]|"")*"|\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?|\d+(?:\.\d+)?(?:E[+-]?\d+)?|[A-Z_][A-Z0-9_.]*(?=\()|TRUE|FALSE|<=|>=|<>|[-+*/^&=<>(),:%]/gi) ?? [];
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
    for (let r = Math.min(start.row, end.row); r <= Math.max(start.row, end.row) && out.length < 1e6; r++)
      for (let c = Math.min(start.column, end.column); c <= Math.max(start.column, end.column); c++) out.push(lookup(r, c));
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
    while (peek() === "+" || peek() === "-") v = tokens[i++] === "+" ? toNumber(v) + toNumber(product()) : toNumber(v) - toNumber(product());
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
      const [x, y] = typeof v === "number" && typeof r === "number" ? [v, r] : [display(v).toLowerCase(), display(r).toLowerCase()];
      v = op === "=" ? x === y : op === "<>" ? x !== y : op === "<" ? x < y : op === ">" ? x > y : op === "<=" ? x <= y : x >= y;
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
      cell.text = formatValue(cell.value, workbook.styles[cell.style]?.format ?? "General", workbook.date1904);
    }
}

/** Excel number formats: sections, decimals, grouping, percent, scientific, dates and times, and literals. */
export function formatValue(value: SheetCell["value"], format: string, date1904 = false): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "string") {
    const textSection = format.split(";")[3];
    return textSection ? textSection.replace(/@/g, value).replace(/"([^"]*)"/g, "$1") : value;
  }
  if (!Number.isFinite(value)) return String(value);
  if (format === "General" || !format) return Math.abs(value) >= 1e11 || (Math.abs(value) < 1e-9 && value) ? value.toExponential(5).replace(/\.?0+e/, "E").replace("E+", "E+") : String(Math.round(value * 1e10) / 1e10);
  const sections = format.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  let section = sections[0]!;
  let number = value;
  if (value < 0 && sections[1] !== undefined) {
    section = sections[1];
    number = -value;
  } else if (value === 0 && sections[2] !== undefined) section = sections[2];
  section = section.replace(/\[(?:Red|Black|Blue|Green|White|Yellow|Cyan|Magenta|Color\s*\d+|[<>=]+[\d.]+)\]/gi, "");
  const literal = (s: string) => s.replace(/"([^"]*)"/g, "$1").replace(/\\(.)/g, "$1").replace(/_./g, " ").replace(/\*./g, "");
  if (/[dmyhs]/i.test(section.replace(/"[^"]*"/g, "")) && !/0/.test(section.replace(/"[^"]*"|\[[^\]]*\]/g, "").replace(/\.0+/, ""))) {
    const ms = Math.round((number - (date1904 ? -1462 : 25569)) * 86400000);
    const d = new Date(ms);
    const pm = d.getUTCHours() >= 12;
    const ampm = /AM\/PM|A\/P/i.test(section);
    const hours = ampm ? d.getUTCHours() % 12 || 12 : d.getUTCHours();
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    let minuteContext = false;
    return literal(
      section.replace(/"[^"]*"|\[h+\]|yyyy|yy|mmmmm|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|AM\/PM|A\/P|\.0+/gi, (token) => {
        const t = token.toLowerCase();
        if (token.startsWith('"')) return token;
        if (t.startsWith("[h")) return String(Math.floor(number * 24));
        if (t === "yyyy") return String(d.getUTCFullYear());
        if (t === "yy") return String(d.getUTCFullYear()).slice(-2);
        if (t.startsWith("h")) {
          minuteContext = true;
          return t === "hh" ? String(hours).padStart(2, "0") : String(hours);
        }
        if (t === "mmmmm") return months[d.getUTCMonth()]![0]!;
        if (t === "mmmm") return months[d.getUTCMonth()]!;
        if (t === "mmm") return months[d.getUTCMonth()]!.slice(0, 3);
        if (t === "mm" || t === "m") {
          const minutes = minuteContext || /^\s*:?s/.test(section.slice(section.toLowerCase().indexOf(t) + t.length));
          minuteContext = false;
          const v = minutes ? d.getUTCMinutes() : d.getUTCMonth() + 1;
          return t === "mm" ? String(v).padStart(2, "0") : String(v);
        }
        if (t === "dddd") return days[d.getUTCDay()]!;
        if (t === "ddd") return days[d.getUTCDay()]!.slice(0, 3);
        if (t === "dd") return String(d.getUTCDate()).padStart(2, "0");
        if (t === "d") return String(d.getUTCDate());
        if (t === "ss") return String(d.getUTCSeconds()).padStart(2, "0");
        if (t === "s") return String(d.getUTCSeconds());
        if (t === "am/pm") return pm ? "PM" : "AM";
        if (t === "a/p") return pm ? "P" : "A";
        if (t.startsWith(".0")) return `.${String(d.getUTCMilliseconds()).padStart(3, "0").slice(0, t.length - 1)}`;
        return token;
      }),
    );
  }
  const code = section.replace(/"[^"]*"/g, (q) => q.replace(/[0#?.,%E]/g, (c) => `\\${c}`));
  const percent = (code.match(/(?<!\\)%/g) ?? []).length;
  number *= 100 ** percent;
  const scientific = /(?<!\\)E[+-]/i.exec(code);
  const decimals = (/(?<!\\)\.([0#?]+)/.exec(code)?.[1] ?? "").length;
  const grouping = /[0#?],[0#?]/.test(code);
  let formatted: string;
  if (scientific) {
    const [mantissa, exponent] = number.toExponential(decimals).split("e");
    formatted = `${mantissa}E${Number(exponent) < 0 ? "-" : "+"}${String(Math.abs(Number(exponent))).padStart(2, "0")}`;
  } else {
    const minimumDigits = (/(?<!\\)(0+)(?:[.,]|$|[^0#?,.])/.exec(code.split(".")[0] ?? "")?.[1] ?? "").length;
    const optional = (/(?<!\\)\.(0*)(#*)/.exec(code)?.[1] ?? "").length;
    let digits = Math.abs(number).toFixed(decimals);
    if (optional < decimals) digits = digits.replace(new RegExp(`(\\.\\d{${optional}}\\d*?)0+$`), "$1").replace(/\.$/, "");
    let [whole, fraction] = digits.split(".");
    whole = whole!.padStart(minimumDigits, "0");
    if (whole === "0" && !minimumDigits) whole = "";
    if (grouping) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    formatted = (number < 0 ? "-" : "") + whole + (fraction ? `.${fraction}` : "");
  }
  // Keep the literal prefix and suffix around the number pattern.
  const pattern = /(?<!\\)[0#?][0#?,.]*(?:E[+-][0#]+)?/i.exec(code);
  if (!pattern) return literal(section);
  const before = code.slice(0, pattern.index);
  const after = code.slice(pattern.index + pattern[0].length);
  return literal(before.replace(/\\(.)/g, "$1")) + formatted + literal(after.replace(/\\(.)/g, "$1"));
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

// ---------- PowerPoint ----------

export type PresentationModel = { slides: OfficeFrame[]; images: OfficeImage[] };
type ShapeText = { paragraphs: XmlNode[]; body: XmlNode | undefined; listStyle: XmlNode | undefined };
type Inherited = { xfrm?: XmlNode | undefined; text?: XmlNode | undefined; spPr?: XmlNode | undefined };
const PRESET_FALLBACK = new Set(["rect", "roundRect", "ellipse", "triangle", "rtTriangle", "diamond", "line", "straightConnector1", "parallelogram", "hexagon", "octagon", "chevron", "rightArrow", "leftArrow", "upArrow", "downArrow", "pentagon", "homePlate", "flowChartProcess", "flowChartAlternateProcess", "flowChartDecision", "flowChartTerminator", "snip1Rect", "round2SameRect", "wedgeRectCallout", "cloud", "star5", "plus", "can", "donut"]);

export async function layoutPptx(bytes: ArrayBuffer | Uint8Array, measure: Measure = approximateMeasure): Promise<PresentationModel> {
  const pkg = OfficePackage.open(bytes);
  const rootRels = await pkg.rels("");
  const path = [...rootRels.values()].find((r) => r.type === "officeDocument")?.target ?? "ppt/presentation.xml";
  const presentation = kid(await pkg.xml(path), "presentation");
  const rels = await pkg.rels(path);
  const size = kid(presentation, "sldSz");
  const width = numAt(size, "cx", 9144000) * EMU;
  const height = numAt(size, "cy", 5143500) * EMU;
  const images: OfficeImage[] = [];
  const imageCache = new Map<string, number>();
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
    const theme = themePath ? await pkg.xml(themePath) : undefined;
    const palette = themeColors(theme);
    const fonts = { major: at(find(find(theme, "majorFont"), "latin"), "typeface") ?? "Calibri Light", minor: at(find(find(theme, "minorFont"), "latin"), "typeface") ?? "Calibri" };
    const clrMap = kid(master, "clrMap")?.attrs ?? {};
    const schemeIndex: Record<string, number> = { dk1: 0, lt1: 1, dk2: 2, lt2: 3, accent1: 4, accent2: 5, accent3: 6, accent4: 7, accent5: 8, accent6: 9, hlink: 10, folHlink: 11 };
    const color = (node: XmlNode | undefined): string | undefined => {
      if (!node) return undefined;
      const c = (node.name === "solidFill" ? node : (kid(node, "solidFill") ?? node)).children.find((child) => child.name.endsWith("Clr"));
      if (!c) return undefined;
      let hex: string | undefined;
      if (c.name === "srgbClr") hex = at(c, "val");
      else if (c.name === "sysClr") hex = at(c, "lastClr");
      else if (c.name === "schemeClr") {
        const name = at(c, "val") ?? "";
        const mapped = clrMap[name] ?? { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" }[name] ?? name;
        hex = palette[schemeIndex[mapped] ?? 0];
      } else if (c.name === "prstClr") hex = { black: "000000", white: "FFFFFF", red: "FF0000", green: "00FF00", blue: "0000FF", yellow: "FFFF00", gray: "808080" }[at(c, "val") ?? ""];
      if (!hex) return undefined;
      const lumMod = numAt(kid(c, "lumMod"), "val", 100000) / 100000;
      const lumOff = numAt(kid(c, "lumOff"), "val", 0) / 100000;
      if (lumMod !== 1 || lumOff) hex = [0, 2, 4].map((i) => Math.round(Math.min(255, parseInt(hex!.slice(i, i + 2), 16) * lumMod + 255 * lumOff)).toString(16).padStart(2, "0")).join("");
      const alpha = numAt(kid(c, "alpha"), "val", 100000) / 100000;
      return alpha < 1 ? `#${hex}${Math.round(alpha * 255).toString(16).padStart(2, "0")}` : `#${hex}`;
    };
    const items: Paint[] = [];
    const imageFor = async (rid: string | undefined, relsMap: Map<string, { target: string; external: boolean }>) => {
      const rel = rid ? relsMap.get(rid) : undefined;
      if (!rel || rel.external) return -1;
      if (imageCache.has(rel.target)) return imageCache.get(rel.target)!;
      const data = await pkg.bytes(rel.target);
      const index = data ? images.push({ mime: mimeOf(rel.target), bytes: data }) - 1 : -1;
      imageCache.set(rel.target, index);
      return index;
    };
    const placeholders = (tree: XmlNode | undefined) => {
      const map = new Map<string, XmlNode>();
      for (const sp of findAll(find(tree, "spTree"), "sp")) {
        const ph = find(kid(sp, "nvSpPr"), "ph");
        if (!ph) continue;
        const type = at(ph, "type") ?? "body";
        map.set(`type:${type}`, sp);
        if (at(ph, "idx")) map.set(`idx:${at(ph, "idx")}`, sp);
      }
      return map;
    };
    const layoutPh = placeholders(layout);
    const masterPh = placeholders(master);
    const txStyles = kid(master, "txStyles");
    const inherit = (sp: XmlNode): Inherited[] => {
      const ph = find(kid(sp, "nvSpPr"), "ph");
      if (!ph) return [];
      const type = at(ph, "type") ?? "body";
      const key = at(ph, "idx") ? `idx:${at(ph, "idx")}` : `type:${type}`;
      const normalized = type === "ctrTitle" ? "title" : type === "subTitle" ? "body" : type;
      const fromLayout = layoutPh.get(key) ?? layoutPh.get(`type:${type}`);
      const fromMaster = masterPh.get(`type:${normalized}`) ?? masterPh.get(`type:${type}`) ?? (normalized === "body" || normalized === "obj" ? masterPh.get("type:body") : undefined);
      return [fromLayout, fromMaster].filter((n): n is XmlNode => !!n).map((n) => ({ xfrm: find(kid(n, "spPr"), "xfrm"), text: kid(n, "txBody"), spPr: kid(n, "spPr") }));
    };
    const transform = { x: (v: number) => v, y: (v: number) => v, sx: 1, sy: 1 };
    type Frame = typeof transform;
    const frameOf = (xfrm: XmlNode | undefined, group: Frame) => {
      const off = kid(xfrm, "off");
      const ext = kid(xfrm, "ext");
      return { x: group.x(numAt(off, "x") * EMU), y: group.y(numAt(off, "y") * EMU), w: numAt(ext, "cx") * EMU * group.sx, h: numAt(ext, "cy") * EMU * group.sy, rotation: numAt(xfrm, "rot") / 60000, flipH: at(xfrm, "flipH") === "1" };
    };
    const drawText = (text: ShapeText, box: { x: number; y: number; w: number; h: number }, kind: string, inherited: Inherited[]) => {
      const bodyPr = text.body;
      const inheritedBody = inherited.map((i) => kid(i.text, "bodyPr")).find(Boolean);
      const inset = (name: string, fallback: number) => numAt(bodyPr, name, numAt(inheritedBody, name, fallback)) * EMU;
      const [l, t, r, b] = [inset("lIns", 91440), inset("tIns", 45720), inset("rIns", 91440), inset("bIns", 45720)];
      const scale = numAt(find(bodyPr, "normAutofit"), "fontScale", 100000) / 100000;
      const anchor = at(bodyPr, "anchor") ?? at(inheritedBody, "anchor") ?? (kind === "title" ? "ctr" : "t");
      const masterStyle = kind === "title" ? kid(txStyles, "titleStyle") : kind === "other" ? kid(txStyles, "otherStyle") : kid(txStyles, "bodyStyle");
      const blocks: { lines: Line[]; align: string; before: number; indent: number }[] = [];
      for (const p of text.paragraphs) {
        const pPr = kid(p, "pPr");
        const level = numAt(pPr, "lvl");
        const levelName = `lvl${level + 1}pPr`;
        const sources = [pPr, kid(text.listStyle, levelName), ...inherited.map((i) => kid(kid(i.text, "lstStyle"), levelName)), kid(masterStyle, levelName)];
        const pick = (name: string) => sources.map((s) => at(s, name)).find((v) => v !== undefined);
        const defRPr = (attr: string) => sources.map((s) => at(kid(s, "defRPr"), attr)).find((v) => v !== undefined);
        const defColor = sources.map((s) => color(kid(s, "defRPr"))).find(Boolean);
        const buNone = sources.find((s) => kid(s, "buNone") || kid(s, "buChar") || kid(s, "buAutoNum"));
        const bullet = buNone && kid(buNone, "buChar") ? at(kid(buNone, "buChar"), "char") : buNone && kid(buNone, "buAutoNum") ? `${blocks.length + 1}.` : undefined;
        const runs: Run[] = [];
        for (const child of p.children) {
          if (child.name !== "r" && child.name !== "fld" && child.name !== "br") continue;
          const rPr = kid(child, "rPr");
          const pt = (Number(at(rPr, "sz") ?? defRPr("sz") ?? (kind === "title" ? 4400 : 1800)) / 100) * scale;
          const px = pt * (96 / 72);
          const typeface = at(kid(rPr, "latin"), "typeface") ?? sources.map((s) => at(kid(kid(s, "defRPr"), "latin"), "typeface")).find(Boolean);
          const family = !typeface || typeface === "+mn-lt" ? fonts.minor : typeface === "+mj-lt" ? fonts.major : typeface;
          const bold = (at(rPr, "b") ?? defRPr("b")) === "1";
          const italic = (at(rPr, "i") ?? defRPr("i")) === "1";
          const link = kid(rPr, "hlinkClick");
          const base: Run = { text: "", font: fontCss(kind === "title" && !typeface ? fonts.major : family, px, bold, italic), size: px, color: color(rPr) ?? defColor ?? "#000000", underline: (at(rPr, "u") ?? "none") !== "none", link: link ? slideRels.get(at(link, "r:id") ?? "")?.target : undefined };
          if (child.name === "br") runs.push({ ...base, breakAfter: "line" });
          else runs.push({ ...base, text: kid(child, "t")?.text ?? "" });
        }
        const endSize = (Number(at(kid(p, "endParaRPr"), "sz") ?? defRPr("sz") ?? 1800) / 100) * scale * (96 / 72);
        const marL = Number(pick("marL") ?? 0) * EMU;
        const indent = Number(pick("indent") ?? 0) * EMU;
        if (bullet && runs.some((r) => r.text.trim())) runs.unshift({ ...runs[0]!, text: `${bullet} `, link: undefined, underline: false });
        const spacing = numAt(kid(kid(pPr, "lnSpc"), "spcPct"), "val", 100000) / 100000;
        const lines = breakLines(runs.length ? runs : [{ text: "", font: fontCss(fonts.minor, endSize), size: endSize, color: "#000" }], Math.max(10, box.w - l - r - marL), measure, Math.max(-marL, indent), spacing * 0.95);
        const algn = pick("algn") ?? "l";
        blocks.push({ lines, align: algn, before: Number(at(kid(kid(pPr, "spcBef"), "spcPts"), "val") ?? 0) / 100 * (96 / 72), indent: marL });
      }
      const total = blocks.reduce((s, block) => s + block.before + block.lines.reduce((h, line) => h + line.height, 0), 0);
      let y = box.y + t + (anchor === "ctr" ? (box.h - t - b - total) / 2 : anchor === "b" ? box.h - t - b - total : 0);
      for (const block of blocks) {
        y += block.before;
        for (const line of block.lines) {
          const available = box.w - l - r - block.indent;
          const slack = available - line.width;
          const dx = block.align === "ctr" ? slack / 2 : block.align === "r" ? slack : 0;
          const baseline = y + line.ascent;
          for (const item of line.items)
            if (item.text.trim()) items.push({ t: "text", x: box.x + l + block.indent + dx + item.x, y: baseline, text: item.text, font: item.run.font, size: item.run.size, color: item.run.color, underline: item.run.underline, link: item.run.link, width: item.width });
          y += line.height;
        }
      }
    };
    // Theme style references: index 0 means none.
    const styleRef = (ref: XmlNode | undefined) => (numAt(ref, "idx") > 0 ? color(ref) : undefined);
    const shapeFill = (spPr: XmlNode | undefined, style: XmlNode | undefined) =>
      kid(spPr, "noFill") ? undefined : (color(kid(spPr, "solidFill")) ?? color(find(kid(spPr, "gradFill"), "gs")) ?? (spPr?.children.some((c) => c.name.endsWith("Fill")) ? undefined : styleRef(kid(style, "fillRef"))));
    const walk = async (tree: XmlNode | undefined, group: Frame, relsMap: Map<string, { target: string; external: boolean }>, decorations: boolean) => {
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
          const stroke = kid(line, "noFill") ? undefined : (color(line) ?? styleRef(kid(style, "lnRef")));
          const fill = node.name === "cxnSp" ? undefined : shapeFill(spPr, style);
          if (geometry === "line" || geometry.includes("Connector") || node.name === "cxnSp")
            items.push({ t: "line", x1: box.flipH ? box.x + box.w : box.x, y1: at(xfrm, "flipV") === "1" ? box.y + box.h : box.y, x2: box.flipH ? box.x : box.x + box.w, y2: at(xfrm, "flipV") === "1" ? box.y : box.y + box.h, color: stroke ?? "#000", width: Math.max(1, numAt(line, "w", 12700) * EMU) });
          else if (fill || stroke) items.push({ t: "rect", ...box, fill, stroke, lineWidth: Math.max(0.75, numAt(line, "w", 9525) * EMU), shape: PRESET_FALLBACK.has(geometry) ? geometry : "rect", rotation: box.rotation });
          const txBody = kid(node, "txBody");
          if (txBody) {
            const type = at(ph, "type") ?? (ph ? "body" : "other");
            drawText({ paragraphs: kids(txBody, "p"), body: kid(txBody, "bodyPr"), listStyle: kid(txBody, "lstStyle") }, box, type === "title" || type === "ctrTitle" ? "title" : type === "other" ? "other" : "body", inherited);
          }
        } else if (node.name === "pic") {
          const box = frameOf(kid(kid(node, "spPr"), "xfrm"), group);
          const index = await imageFor(at(find(node, "blip"), "r:embed"), relsMap);
          if (index >= 0) items.push({ t: "image", x: box.x, y: box.y, w: box.w, h: box.h, image: index });
        } else if (node.name === "grpSp") {
          const xfrm = kid(kid(node, "grpSpPr"), "xfrm");
          const outer = frameOf(xfrm, group);
          const chOff = kid(xfrm, "chOff");
          const chExt = kid(xfrm, "chExt");
          const sx = numAt(chExt, "cx") ? outer.w / (numAt(chExt, "cx") * EMU) : 1;
          const sy = numAt(chExt, "cy") ? outer.h / (numAt(chExt, "cy") * EMU) : 1;
          await walk(node, { x: (v) => outer.x + (v - numAt(chOff, "x") * EMU) * sx, y: (v) => outer.y + (v - numAt(chOff, "y") * EMU) * sy, sx: sx * group.sx, sy: sy * group.sy }, relsMap, decorations);
        } else if (node.name === "graphicFrame") {
          const box = frameOf(kid(node, "xfrm"), group);
          const tbl = find(node, "tbl");
          if (!tbl) continue;
          const columns = kids(kid(tbl, "tblGrid"), "gridCol").map((c) => numAt(c, "w") * EMU);
          let y = box.y;
          for (const tr of kids(tbl, "tr")) {
            const h = numAt(tr, "h") * EMU;
            let x = box.x;
            kids(tr, "tc").forEach((tc, index) => {
              const w = columns[index] ?? 0;
              const tcPr = kid(tc, "tcPr");
              items.push({ t: "rect", x, y, w, h, fill: color(kid(tcPr, "solidFill")), stroke: "#9a9a9a", lineWidth: 0.75 });
              const body = kid(tc, "txBody");
              if (body) drawText({ paragraphs: kids(body, "p"), body: kid(body, "bodyPr"), listStyle: undefined }, { x, y, w, h }, "other", []);
              x += w;
            });
            y += h;
          }
        } else if (node.name === "AlternateContent") await walk(kid(node, "Choice") ?? kid(node, "Fallback"), group, relsMap, decorations);
      }
    };
    const background = (node: XmlNode | undefined) => {
      const bg = kid(kid(node, "cSld"), "bg");
      return bg ? (color(kid(kid(bg, "bgPr"), "solidFill")) ?? color(find(kid(bg, "bgPr"), "gs")) ?? color(kid(bg, "bgRef"))) : undefined;
    };
    const showMaster = at(slide, "showMasterSp") !== "0" && at(layout, "showMasterSp") !== "0";
    if (showMaster) await walk(find(master, "spTree"), transform, masterRels, true);
    await walk(find(layout, "spTree"), transform, layoutRels, true);
    await walk(find(slide, "spTree"), transform, slideRels, false);
    const notesPath = [...slideRels.values()].find((r) => r.type === "notesSlide")?.target;
    const notesXml = notesPath ? await pkg.xml(notesPath) : undefined;
    const notesBody = findAll(notesXml, "sp").find((sp) => at(find(sp, "ph"), "type") === "body");
    const notes = notesBody ? kids(kid(notesBody, "txBody"), "p").map((p) => textOf(p).trim()).join("\n").trim() : "";
    slides.push({ width, height, background: background(slide) ?? background(layout) ?? background(master) ?? "#ffffff", items, hidden: at(slide, "show") === "0", ...(notes ? { notes } : {}) });
  }
  return { slides, images };
}

/** All text of a laid-out frame in reading order, for search and copy. */
export function frameText(frame: OfficeFrame) {
  return frame.items
    .filter((item): item is Extract<Paint, { t: "text" }> => item.t === "text")
    .map((item, i, all) => (i && Math.abs(all[i - 1]!.y - item.y) > 2 ? "\n" : i ? " " : "") + item.text)
    .join("");
}
