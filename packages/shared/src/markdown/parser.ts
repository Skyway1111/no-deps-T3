import { resolveCodexArtifactTemplate } from "../codexArtifactTemplates.ts";
import { GITHUB_ALERT_MARKER } from "../markdownGithubAlerts.ts";
import { UNFINISHED_DRIVE_PATH } from "../markdownLinks.ts";
import { isWindowsAbsolutePath } from "../path.ts";
import { decodeHtmlEntities } from "./entities.ts";
import type {
  MdBlockquote,
  MdCode,
  MdDefinition,
  MdDirective,
  MdFootnoteDefinition,
  MdHeading,
  MdHtml,
  MdInlineCode,
  MdInlineMath,
  MdLeadingWhitespace,
  MdLink,
  MdList,
  MdListItem,
  MdMath,
  MdNode,
  MdParagraph,
  MdRoot,
  MdTable,
  MdTableCell,
  MdTableRow,
  MdText,
  ParseOptions,
  SourcePoint,
  SourcePosition,
} from "./types.ts";

// --- Character classification helpers (charCode-based, zero regex overhead) ---

const isSpace = (c: number) => c === 32 || c === 9;
const isEol = (c: number) => c === 10 || c === 13;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isAlphaNum = (c: number) => isDigit(c) || isAlpha(c);
const isAsciiPunct = (c: number) =>
  (c >= 33 && c <= 47) ||
  (c >= 58 && c <= 64) ||
  (c >= 91 && c <= 96) ||
  (c >= 123 && c <= 126);

const UNICODE_PUNCT_RE = /[\p{P}\p{S}]/u;
const UNICODE_SPACE_RE = /\s/u;

function isUnicodePunct(ch: string): boolean {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return isAsciiPunct(c);
  return UNICODE_PUNCT_RE.test(ch);
}

function isUnicodeSpace(ch: string): boolean {
  if (!ch) return true;
  const c = ch.charCodeAt(0);
  if (c < 128) return c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
  return UNICODE_SPACE_RE.test(ch);
}

// CJK Symbols & Punctuation, Halfwidth/Fullwidth Forms, Arabic comma/semicolon/question/full-stop.
const SCRIPT_PUNCTUATION_RE = /(?=[　-〿＀-￯،؛؟۔])[\p{P}\p{S}]/u;

function isScriptPunctuation(ch: string): boolean {
  const c = ch.charCodeAt(0);
  if (c < 128) return false;
  return (
    ((c >= 0x3000 && c <= 0x303f) ||
      (c >= 0xff00 && c <= 0xffef) ||
      c === 0x060c ||
      c === 0x061b ||
      c === 0x061f ||
      c === 0x06d4) &&
    SCRIPT_PUNCTUATION_RE.test(ch)
  );
}

const nextTabStop = (col: number) => (Math.floor(col / 4) + 1) * 4;

// --- Line index for exact UTF-16 positions ---

interface LineInfo {
  readonly start: number;
  readonly end: number; // before line ending
  readonly rawEnd: number; // after line ending
}

interface LineSlice {
  readonly lineNum: number; // 1-based
  readonly start: number; // start offset in original source (after container prefix)
  readonly end: number; // end offset before EOL in original source
  readonly rawEnd: number; // end offset after EOL
  readonly baseCol: number; // column where `start` sits
  readonly insideTabSpaces: number; // leftover spaces if container split a tab
  readonly typedLeadingWs: string; // extra spaces/tabs past container indent (for leadingWhitespace)
  readonly lazy?: boolean;
}

class LineIndex {
  readonly lines: LineInfo[] = [];
  readonly source: string;

  constructor(source: string) {
    this.source = source;
    const len = source.length;
    let start = 0;
    for (let i = 0; i < len; i++) {
      const c = source.charCodeAt(i);
      if (c === 13 /* \r */) {
        const rawEnd = i + 1 < len && source.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
        this.lines.push({ start, end: i, rawEnd });
        start = rawEnd;
        i = rawEnd - 1;
      } else if (c === 10 /* \n */) {
        this.lines.push({ start, end: i, rawEnd: i + 1 });
        start = i + 1;
      }
    }
    if (start < len || len === 0) {
      this.lines.push({ start, end: len, rawEnd: len });
    }
  }

  pointAt(offset: number): SourcePoint {
    const clamped = Math.max(0, Math.min(offset, this.source.length));
    let lo = 0;
    let hi = this.lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lines[mid]!.start <= clamped) lo = mid;
      else hi = mid - 1;
    }
    const line = this.lines[lo]!;
    return {
      line: lo + 1,
      column: clamped - line.start + 1,
      offset: clamped,
    };
  }

  pos(start: number, end: number): SourcePosition {
    return { start: this.pointAt(start), end: this.pointAt(end) };
  }

  toSlices(): LineSlice[] {
    return this.lines.map((l, idx) => ({
      lineNum: idx + 1,
      start: l.start,
      end: l.end,
      rawEnd: l.rawEnd,
      baseCol: 0,
      insideTabSpaces: 0,
      typedLeadingWs: "",
    }));
  }
}

// --- Indent helpers on a LineSlice ---

interface IndentScan {
  readonly offset: number;
  readonly col: number;
  readonly indent: number; // columns relative to slice.baseCol
  readonly isBlank: boolean;
}

function scanIndent(src: string, slice: LineSlice): IndentScan {
  let pos = slice.start;
  let col = slice.baseCol + slice.insideTabSpaces;
  while (pos < slice.end) {
    const c = src.charCodeAt(pos);
    if (c === 32) {
      col++;
      pos++;
    } else if (c === 9) {
      col = nextTabStop(col);
      pos++;
    } else {
      break;
    }
  }
  return {
    offset: pos,
    col,
    indent: col - slice.baseCol,
    isBlank: pos >= slice.end,
  };
}

function advanceColumns(
  src: string,
  slice: LineSlice,
  columns: number,
): { start: number; baseCol: number; insideTabSpaces: number; ok: boolean } {
  let remaining = columns;
  let insideTab = slice.insideTabSpaces;
  let baseCol = slice.baseCol;
  let pos = slice.start;

  if (insideTab > 0) {
    if (insideTab >= remaining) {
      return {
        start: pos,
        baseCol: baseCol + remaining,
        insideTabSpaces: insideTab - remaining,
        ok: true,
      };
    }
    remaining -= insideTab;
    baseCol += insideTab;
    insideTab = 0;
  }

  while (remaining > 0 && pos < slice.end) {
    const c = src.charCodeAt(pos);
    if (c === 32) {
      pos++;
      baseCol++;
      remaining--;
    } else if (c === 9) {
      const step = nextTabStop(baseCol) - baseCol;
      if (step > remaining) {
        return {
          start: pos + 1,
          baseCol: baseCol + remaining,
          insideTabSpaces: step - remaining,
          ok: true,
        };
      }
      pos++;
      baseCol += step;
      remaining -= step;
    } else {
      return { start: pos, baseCol, insideTabSpaces: 0, ok: false };
    }
  }
  return { start: pos, baseCol, insideTabSpaces: 0, ok: remaining === 0 };
}

function sliceText(src: string, slice: LineSlice): string {
  const prefix = slice.insideTabSpaces > 0 ? " ".repeat(slice.insideTabSpaces) : "";
  return prefix + src.slice(slice.start, slice.end);
}

function trimSliceLeadingWs(src: string, slice: LineSlice): { text: string; ws: string; start: number } {
  const scan = scanIndent(src, slice);
  const ws =
    (slice.insideTabSpaces > 0 ? " ".repeat(slice.insideTabSpaces) : "") +
    src.slice(slice.start, scan.offset);
  return {
    text: src.slice(scan.offset, slice.end),
    ws,
    start: scan.offset,
  };
}

// --- Block HTML patterns (CommonMark types 1-7) ---

const HTML_BLOCK_TYPE1_OPEN = /^<(?:pre|script|style|textarea)(?:[\s>]|$)/i;
const HTML_BLOCK_TYPE1_CLOSE = /<\/(?:pre|script|style|textarea)>/i;
const HTML_BLOCK_TYPE6_TAGS = new Set(
  "address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul".split(
    " ",
  ),
);
const HTML_BLOCK_TYPE6_RE = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:[\s>]|\/?>|$)/;
const HTML_BLOCK_TYPE7_RE =
  /^(?:<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[a-zA-Z][a-zA-Z0-9-]*\s*>)[ \t]*$/;

function detectHtmlBlockType(text: string, canInterruptParagraph: boolean): number {
  if (!text.startsWith("<")) return 0;
  if (HTML_BLOCK_TYPE1_OPEN.test(text)) return 1;
  if (text.startsWith("<!--")) return 2;
  if (text.startsWith("<?")) return 3;
  if (/^<![A-Za-z]/.test(text)) return 4;
  if (text.startsWith("<![CDATA[")) return 5;
  const m6 = HTML_BLOCK_TYPE6_RE.exec(text);
  if (m6 && HTML_BLOCK_TYPE6_TAGS.has(m6[1]!.toLowerCase())) return 6;
  if (!canInterruptParagraph && HTML_BLOCK_TYPE7_RE.test(text)) return 7;
  return 0;
}

// --- Block regexes ---

const THEMATIC_BREAK_RE = /^(?:(\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/;
const ATX_HEADING_RE = /^(#{1,6})(?:[ \t]+|$)(.*)$/;
const SETEXT_RE = /^(=+|-+)[ \t]*$/;
const FENCE_OPEN_RE = /^(`{3,}|~{3,})(.*)$/;
const LIST_MARKER_RE = /^([-*+]|(\d{1,9})([.)]))(?:([ \t]+)|$)/;
const TASK_CHECKBOX_RE = /^\[([ xX])\][ \t]+/;
const INSIGHT_OPEN_RE = /^( {0,3})(`?)★ Insight[ \t]+─{3,}\2[ \t]*$/u;
const INSIGHT_CLOSE_RE = /^( {0,3})(`?)─{3,}\2[ \t]*$/u;
const CODEX_LEAF_RE = /^::artifact-template(?:\[([^\]]*)\])?(?:\{([^}]*)\})?[ \t]*$/;
const FOOTNOTE_DEF_RE = /^\[\^([^\]\s\r\n]+)\]:(?:[ \t]*(.*))?$/;

// --- Shared context ---

interface ParserContext {
  readonly src: string;
  readonly idx: LineIndex;
  readonly opts: Required<ParseOptions>;
  readonly definitions: Map<string, MdDefinition>;
  readonly footnotes: Map<string, MdFootnoteDefinition>;
  readonly inlineTargets: Array<{
    readonly node: MdParagraph | MdHeading | MdTableCell;
    readonly slices: LineSlice[];
    readonly inTableCell: boolean;
  }>;
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

function unescapeMarkdown(value: string, keepWindows: boolean): string {
  if (keepWindows && isWindowsAbsolutePath(value)) {
    return decodeHtmlEntities(value, { strict: true });
  }
  const decoded = value.includes("&") ? decodeHtmlEntities(value, { strict: true }) : value;
  return decoded.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

function parseDirectiveAttributes(raw: string | undefined): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!raw) return attrs;
  let pos = 0;
  const len = raw.length;
  while (pos < len) {
    while (pos < len && isSpace(raw.charCodeAt(pos))) pos++;
    if (pos >= len) break;
    const keyStart = pos;
    while (pos < len) {
      const c = raw.charCodeAt(pos);
      if (isAlphaNum(c) || c === 95 || c === 45 || c === 58 || c === 46) pos++;
      else break;
    }
    if (pos === keyStart) {
      pos++;
      continue;
    }
    const key = raw.slice(keyStart, pos);
    while (pos < len && isSpace(raw.charCodeAt(pos))) pos++;
    if (pos < len && raw.charCodeAt(pos) === 61 /* = */) {
      pos++;
      while (pos < len && isSpace(raw.charCodeAt(pos))) pos++;
      if (pos < len && (raw.charCodeAt(pos) === 34 || raw.charCodeAt(pos) === 39)) {
        const quote = raw.charCodeAt(pos++);
        const valStart = pos;
        while (pos < len && raw.charCodeAt(pos) !== quote) {
          pos++;
        }
        const val = raw.slice(valStart, pos);
        if (pos < len && raw.charCodeAt(pos) === quote) pos++;
        attrs[key] = decodeHtmlEntities(val, { strict: true });
      } else {
        const valStart = pos;
        while (pos < len && !isSpace(raw.charCodeAt(pos)) && raw.charCodeAt(pos) !== 125) pos++;
        attrs[key] = decodeHtmlEntities(raw.slice(valStart, pos), { strict: true });
      }
    } else {
      attrs[key] = "";
    }
  }
  return attrs;
}

// --- Table delimiter & cell splitting ---

function parseTableDelimiterRow(text: string): Array<"left" | "center" | "right" | null> | null {
  const trimmed = text.trim();
  if (!trimmed.includes("-") || !/^[\s|:-]+$/.test(trimmed)) return null;
  let inner = trimmed;
  if (inner.startsWith("|")) inner = inner.slice(1);
  if (inner.endsWith("|")) inner = inner.slice(0, -1);
  const parts = inner.split("|");
  if (parts.length === 0) return null;
  const aligns: Array<"left" | "center" | "right" | null> = [];
  for (const part of parts) {
    const cell = part.trim();
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    aligns.push(left && right ? "center" : left ? "left" : right ? "right" : null);
  }
  return aligns;
}

interface TableCellSlice {
  readonly start: number;
  readonly end: number;
}

function splitTableCells(
  src: string,
  lineStart: number,
  lineEnd: number,
  mathEnabled: boolean,
): TableCellSlice[] {
  // Trim leading/trailing spaces
  let start = lineStart;
  let end = lineEnd;
  while (start < end && isSpace(src.charCodeAt(start))) start++;
  while (end > start && isSpace(src.charCodeAt(end - 1))) end--;

  const cells: TableCellSlice[] = [];
  let pos = start;
  if (pos < end && src.charCodeAt(pos) === 124 /* | */) pos++;

  let cellStart = pos;
  while (pos < end) {
    const c = src.charCodeAt(pos);
    if (c === 92 /* \ */) {
      if (mathEnabled && pos + 1 < end) {
        const n = src.charCodeAt(pos + 1);
        if (n === 40 /* ( */ || n === 91 /* [ */) {
          const closeEnd = findInlineTexMathEnd(src, pos, end, n === 91);
          if (closeEnd > 0) {
            pos = closeEnd;
            continue;
          }
        }
      }
      pos += 2;
      continue;
    }
    if (c === 96 /* ` */) {
      const codeEnd = findCodeSpanEnd(src, pos, end);
      if (codeEnd > 0) {
        pos = codeEnd;
        continue;
      }
      while (pos < end && src.charCodeAt(pos) === 96) pos++;
      continue;
    }
    if (c === 60 /* < */) {
      const tagEnd = findInlineHtmlOrAutolinkEnd(src, pos, end);
      if (tagEnd > 0) {
        pos = tagEnd;
        continue;
      }
    }
    if (c === 93 /* ] */ && pos + 1 < end && src.charCodeAt(pos + 1) === 40 /* ( */) {
      const dest = parseLinkDestinationInline(src, pos + 2, end, false);
      if (dest && dest.afterPos > pos + 2) {
        pos = dest.afterPos;
        continue;
      }
    }
    if (mathEnabled && c === 36 /* $ */) {
      const mathEnd = findInlineDollarMathEnd(src, pos, end);
      if (mathEnd > 0) {
        pos = mathEnd;
        continue;
      }
    }
    if (c === 124 /* | */) {
      cells.push(trimCellRange(src, cellStart, pos));
      pos++;
      cellStart = pos;
      continue;
    }
    pos++;
  }

  // Trailing pipe doesn't start an empty extra cell unless it's escaped `\|`.
  if (cellStart < end || (cells.length === 0 && start < end)) {
    cells.push(trimCellRange(src, cellStart, end));
  }
  return cells;
}

function trimCellRange(src: string, start: number, end: number): TableCellSlice {
  let s = start;
  let e = end;
  while (s < e && isSpace(src.charCodeAt(s))) s++;
  while (e > s && isSpace(src.charCodeAt(e - 1))) e--;
  return { start: s, end: e };
}

// --- Reference link definition parser ---

function tryParseReferenceDefinition(
  ctx: ParserContext,
  slices: LineSlice[],
  startIndex: number,
): { def: MdDefinition; nextIndex: number } | null {
  const first = slices[startIndex]!;
  const scan0 = scanIndent(ctx.src, first);
  if (scan0.indent > 3 || ctx.src.charCodeAt(scan0.offset) !== 91 /* [ */) return null;

  // Don't mistake footnote definition `[^x]:` for a link definition
  if (scan0.offset + 1 < first.end && ctx.src.charCodeAt(scan0.offset + 1) === 94 /* ^ */) {
    return null;
  }

  // Collect label (up to 999 chars, may span lines, no blank lines, no unescaped `[` or `]`).
  let lineIdx = startIndex;
  let pos = scan0.offset + 1;
  let label = "";
  let foundClose = false;

  outer: while (lineIdx < slices.length) {
    const sl = slices[lineIdx]!;
    while (pos < sl.end) {
      const c = ctx.src.charCodeAt(pos);
      if (c === 92 /* \ */ && pos + 1 < sl.end) {
        label += ctx.src.slice(pos, pos + 2);
        pos += 2;
      } else if (c === 93 /* ] */) {
        pos++;
        foundClose = true;
        break outer;
      } else if (c === 91 /* [ */) {
        return null;
      } else {
        label += ctx.src[pos]!;
        pos++;
      }
      if (label.length > 999) return null;
    }
    lineIdx++;
    if (lineIdx >= slices.length) return null;
    const nextScan = scanIndent(ctx.src, slices[lineIdx]!);
    if (nextScan.isBlank) return null;
    label += "\n";
    pos = slices[lineIdx]!.start;
  }

  if (!foundClose) return null;
  const normalized = normalizeLabel(label);
  if (!normalized) return null;

  const curSlice = slices[lineIdx]!;
  if (pos >= curSlice.end || ctx.src.charCodeAt(pos) !== 58 /* : */) return null;
  pos++;

  // Skip optional whitespace (and up to one line ending) before destination
  const skipWsOneLine = (): boolean => {
    while (pos < slices[lineIdx]!.end && isSpace(ctx.src.charCodeAt(pos))) pos++;
    if (pos >= slices[lineIdx]!.end) {
      if (lineIdx + 1 >= slices.length) return false;
      const nextScan = scanIndent(ctx.src, slices[lineIdx + 1]!);
      if (nextScan.isBlank) return false;
      lineIdx++;
      pos = nextScan.offset;
      return true;
    }
    return false;
  };
  skipWsOneLine();

  const destSlice = slices[lineIdx]!;
  if (pos >= destSlice.end) return null;

  // Parse destination
  let rawDest = "";
  let destEnd = pos;
  if (ctx.src.charCodeAt(pos) === 60 /* < */) {
    pos++;
    const dStart = pos;
    let closed = false;
    while (pos < destSlice.end) {
      const c = ctx.src.charCodeAt(pos);
      if (c === 92 && pos + 1 < destSlice.end) {
        pos += 2;
      } else if (c === 62 /* > */) {
        rawDest = ctx.src.slice(dStart, pos);
        pos++;
        destEnd = pos;
        closed = true;
        break;
      } else if (c === 60) {
        return null;
      } else {
        pos++;
      }
    }
    if (!closed) return null;
  } else {
    const dStart = pos;
    let parens = 0;
    while (pos < destSlice.end) {
      const c = ctx.src.charCodeAt(pos);
      if (c <= 32 || c === 127) break;
      if (c === 92 && pos + 1 < destSlice.end && isAsciiPunct(ctx.src.charCodeAt(pos + 1))) {
        pos += 2;
      } else if (c === 40 /* ( */) {
        parens++;
        if (parens > 32) return null;
        pos++;
      } else if (c === 41 /* ) */) {
        if (parens === 0) return null;
        parens--;
        pos++;
      } else {
        pos++;
      }
    }
    if (parens !== 0 || pos === dStart) return null;
    rawDest = ctx.src.slice(dStart, pos);
    destEnd = pos;
  }

  // Check optional title
  let endLineIdx = lineIdx;
  let endOffset = destEnd;
  let title: string | null = null;

  const afterDestLine = lineIdx;
  const afterDestPos = pos;
  let wsBeforeTitle = 0;
  let crossedLine = false;
  while (pos < slices[lineIdx]!.end && isSpace(ctx.src.charCodeAt(pos))) {
    wsBeforeTitle++;
    pos++;
  }
  const restOfDestLineEmpty = pos >= slices[lineIdx]!.end;
  if (restOfDestLineEmpty && lineIdx + 1 < slices.length) {
    const nextScan = scanIndent(ctx.src, slices[lineIdx + 1]!);
    if (!nextScan.isBlank) {
      lineIdx++;
      pos = nextScan.offset;
      crossedLine = true;
      wsBeforeTitle = 1;
    }
  }

  if (wsBeforeTitle > 0 && lineIdx < slices.length && pos < slices[lineIdx]!.end) {
    const q = ctx.src.charCodeAt(pos);
    if (q === 34 || q === 39 || q === 40) {
      const closeQ = q === 40 ? 41 : q;
      let tLine = lineIdx;
      let tPos = pos + 1;
      let rawTitle = "";
      let closed = false;
      titleLoop: while (tLine < slices.length) {
        const tsl = slices[tLine]!;
        while (tPos < tsl.end) {
          const c = ctx.src.charCodeAt(tPos);
          if (c === 92 && tPos + 1 < tsl.end) {
            rawTitle += ctx.src.slice(tPos, tPos + 2);
            tPos += 2;
          } else if (c === closeQ) {
            tPos++;
            closed = true;
            break titleLoop;
          } else {
            rawTitle += ctx.src[tPos]!;
            tPos++;
          }
        }
        tLine++;
        if (tLine >= slices.length) break;
        if (scanIndent(ctx.src, slices[tLine]!).isBlank) break;
        rawTitle += "\n";
        tPos = slices[tLine]!.start;
      }
      if (closed) {
        const trailing = ctx.src.slice(tPos, slices[tLine]!.end);
        if (/^[ \t]*$/.test(trailing)) {
          title = unescapeMarkdown(rawTitle, false);
          endLineIdx = tLine;
          endOffset = tPos;
        } else if (!crossedLine) {
          return null;
        }
      } else if (!crossedLine) {
        return null;
      }
    } else if (!crossedLine) {
      // Non-whitespace garbage on same line as destination
      return null;
    }
  } else if (!restOfDestLineEmpty) {
    const trailing = ctx.src.slice(afterDestPos, slices[afterDestLine]!.end);
    if (!/^[ \t]*$/.test(trailing)) return null;
  }

  const keepWin = ctx.opts.windowsPaths && !ctx.opts.windowsProsePathsOnly;
  const url = unescapeMarkdown(rawDest, keepWin);
  const def: MdDefinition = {
    type: "definition",
    identifier: normalized,
    label: label.trim(),
    url,
    ...(title !== null ? { title } : {}),
    position: ctx.idx.pos(scan0.offset, endOffset),
  };
  return { def, nextIndex: endLineIdx + 1 };
}

// --- Display math block scanners ---

function countPrecedingBackslashes(s: string, index: number): number {
  let n = 0;
  for (let i = index - 1; i >= 0 && s.charCodeAt(i) === 92; i--) n++;
  return n;
}

function tryParseDisplayMathBlock(
  ctx: ParserContext,
  slices: LineSlice[],
  startIndex: number,
): { node: MdMath; nextIndex: number } | null {
  const first = slices[startIndex]!;
  const scan0 = scanIndent(ctx.src, first);
  if (scan0.indent > 3) return null;
  const line = ctx.src.slice(scan0.offset, first.end);

  const isDollar = /^\$\$[ \t]*$/.test(line);
  const isBracket = !isDollar && /^\\\[[ \t]*$/.test(line);
  if (!isDollar && !isBracket) return null;

  const contentLines: string[] = [];
  for (let i = startIndex + 1; i < slices.length; i++) {
    const sl = slices[i]!;
    const sc = scanIndent(ctx.src, sl);
    const trimmed = ctx.src.slice(sc.offset, sl.end);
    if (isDollar) {
      if (sc.indent <= 3 && /^\$\$[ \t]*$/.test(trimmed)) {
        return {
          node: {
            type: "math",
            value: contentLines.join("\n"),
            position: ctx.idx.pos(scan0.offset, sl.end),
          },
          nextIndex: i + 1,
        };
      }
      // Also support closing `$$` at end of a content line (when not escaped by odd `\`).
      const trimmedEnd = trimmed.replace(/[ \t]+$/, "");
      if (trimmedEnd.endsWith("$$")) {
        const dollarPos = trimmedEnd.length - 2;
        if (countPrecedingBackslashes(trimmedEnd, dollarPos) % 2 === 0) {
          const before = trimmedEnd.slice(0, dollarPos);
          if (before.length > 0) contentLines.push(before);
          return {
            node: {
              type: "math",
              value: contentLines.join("\n"),
              position: ctx.idx.pos(scan0.offset, sc.offset + trimmedEnd.length),
            },
            nextIndex: i + 1,
          };
        }
      }
    } else if (sc.indent <= 3 && /^\\\][ \t]*$/.test(trimmed)) {
      return {
        node: {
          type: "math",
          value: contentLines.join("\n"),
          position: ctx.idx.pos(scan0.offset, sl.end),
        },
        nextIndex: i + 1,
      };
    }
    contentLines.push(sliceText(ctx.src, sl));
  }
  return null;
}

// --- Block parser ---

function canInterruptParagraph(ctx: ParserContext, slices: LineSlice[], i: number): boolean {
  const sl = slices[i]!;
  const scan = scanIndent(ctx.src, sl);
  if (scan.isBlank) return true;
  if (scan.indent > 3) return false;
  const text = ctx.src.slice(scan.offset, sl.end);
  if (text.startsWith(">")) return true;
  if (ATX_HEADING_RE.test(text)) return true;
  if (THEMATIC_BREAK_RE.test(text)) return true;
  if (FENCE_OPEN_RE.test(text)) {
    const m = FENCE_OPEN_RE.exec(text)!;
    if (m[1]![0] !== "`" || !m[2]!.includes("`")) return true;
  }
  if (detectHtmlBlockType(text, true) > 0) return true;
  if (ctx.opts.directives && CODEX_LEAF_RE.test(text)) {
    const m = CODEX_LEAF_RE.exec(text)!;
    if (resolveCodexArtifactTemplate(parseDirectiveAttributes(m[2]))) return true;
  }
  if (ctx.opts.math && (/^\$\$[ \t]*$/.test(text) || /^\\\[[ \t]*$/.test(text))) {
    if (tryParseDisplayMathBlock(ctx, slices, i) !== null) return true;
  }
  // List item can interrupt paragraph unless empty or ordered with start !== 1
  const lm = LIST_MARKER_RE.exec(text);
  if (lm) {
    const isEmpty = lm[0].length === text.length;
    const isOrdered = lm[2] !== undefined;
    if (!isEmpty && (!isOrdered || Number(lm[2]) === 1)) return true;
  }
  // GFM table can interrupt paragraph if this line + next line form a table!
  if (ctx.opts.gfm && i + 1 < slices.length && text.includes("|")) {
    const nextSl = slices[i + 1]!;
    const nextScan = scanIndent(ctx.src, nextSl);
    if (!nextScan.isBlank && nextScan.indent <= 3) {
      const nextText = ctx.src.slice(nextScan.offset, nextSl.end);
      const aligns = parseTableDelimiterRow(nextText);
      if (aligns) {
        const headerCells = splitTableCells(ctx.src, scan.offset, sl.end, ctx.opts.math);
        if (headerCells.length === aligns.length) return true;
      }
    }
  }
  return false;
}

function parseBlocks(
  ctx: ParserContext,
  slices: LineSlice[],
  isTopLevel: boolean,
): MdNode[] {
  const blocks: MdNode[] = [];
  let i = 0;

  while (i < slices.length) {
    const sl = slices[i]!;
    const scan = scanIndent(ctx.src, sl);
    if (scan.isBlank) {
      i++;
      continue;
    }

    // 1. Indented code block (4+ columns)
    if (scan.indent >= 4) {
      const codeLines: string[] = [];
      let endIdx = i;
      let j = i;
      while (j < slices.length) {
        const cur = slices[j]!;
        const sc = scanIndent(ctx.src, cur);
        if (sc.isBlank) {
          const adv = advanceColumns(ctx.src, cur, 4);
          codeLines.push(
            (adv.insideTabSpaces > 0 ? " ".repeat(adv.insideTabSpaces) : "") +
              ctx.src.slice(adv.start, cur.end),
          );
          j++;
          continue;
        }
        if (sc.indent >= 4) {
          const adv = advanceColumns(ctx.src, cur, 4);
          codeLines.push(
            (adv.insideTabSpaces > 0 ? " ".repeat(adv.insideTabSpaces) : "") +
              ctx.src.slice(adv.start, cur.end),
          );
          endIdx = j;
          j++;
          continue;
        }
        break;
      }
      // Trim trailing blank lines from indented code block
      const kept = codeLines.slice(0, endIdx - i + 1);
      const codeNode: MdCode = {
        type: "code",
        value: kept.join("\n"),
        fenced: false,
        closed: true,
        position: ctx.idx.pos(slices[i]!.start, slices[endIdx]!.end),
      };
      blocks.push(codeNode);
      i = endIdx + 1;
      continue;
    }

    const lineText = ctx.src.slice(scan.offset, sl.end);

    // 2. Top-level `★ Insight ───` callout block
    if (isTopLevel && ctx.opts.insights && lineText.includes("★ Insight")) {
      const fullLine = sliceText(ctx.src, sl);
      const openMatch = INSIGHT_OPEN_RE.exec(fullLine);
      if (openMatch) {
        const indentStr = openMatch[1] ?? "";
        const innerSlices: LineSlice[] = [];
        let j = i + 1;
        let inFenceChar = "";
        let inFenceLen = 0;
        let closeLineEnd = sl.end;
        while (j < slices.length) {
          const cur = slices[j]!;
          const curFull = sliceText(ctx.src, cur);
          const curTrim = curFull.trimStart();
          if (inFenceChar) {
            if (
              curFull.length - curTrim.length <= 3 &&
              curTrim.startsWith(inFenceChar.repeat(inFenceLen)) &&
              /^[`~]+[ \t]*$/.test(curTrim)
            ) {
              inFenceChar = "";
              inFenceLen = 0;
            }
          } else {
            const fm = FENCE_OPEN_RE.exec(curTrim);
            if (
              fm &&
              curFull.length - curTrim.length <= 3 &&
              (fm[1]![0] !== "`" || !fm[2]!.includes("`"))
            ) {
              inFenceChar = fm[1]![0]!;
              inFenceLen = fm[1]!.length;
            } else {
              const closeMatch = INSIGHT_CLOSE_RE.exec(curFull);
              if (closeMatch && closeMatch[1] === indentStr) {
                closeLineEnd = cur.end;
                j++;
                break;
              }
            }
          }
          innerSlices.push(cur);
          closeLineEnd = cur.end;
          j++;
        }
        const quoteChildren = parseBlocks(ctx, innerSlices, false);
        const bq: MdBlockquote = {
          type: "blockquote",
          alert: "insight",
          children: quoteChildren,
          position: ctx.idx.pos(sl.start, closeLineEnd),
        };
        blocks.push(bq);
        i = j;
        continue;
      }
    }

    // 3. ATX Heading
    const atx = ATX_HEADING_RE.exec(lineText);
    if (atx) {
      const depth = atx[1]!.length as 1 | 2 | 3 | 4 | 5 | 6;
      const contentStart = scan.offset + atx[1]!.length;
      let start = contentStart;
      while (start < sl.end && isSpace(ctx.src.charCodeAt(start))) start++;
      let end = sl.end;
      while (end > start && isSpace(ctx.src.charCodeAt(end - 1))) end--;
      // Optional closing `#` sequence preceded by space/tab (or whole content)
      let hashEnd = end;
      while (hashEnd > start && ctx.src.charCodeAt(hashEnd - 1) === 35 /* # */) hashEnd--;
      if (hashEnd < end && (hashEnd === start || isSpace(ctx.src.charCodeAt(hashEnd - 1)))) {
        end = hashEnd;
        while (end > start && isSpace(ctx.src.charCodeAt(end - 1))) end--;
      }
      const heading: MdHeading = {
        type: "heading",
        depth,
        children: [],
        position: ctx.idx.pos(scan.offset, sl.end),
      };
      if (start < end) {
        ctx.inlineTargets.push({
          node: heading,
          slices: [
            {
              lineNum: sl.lineNum,
              start,
              end,
              rawEnd: sl.rawEnd,
              baseCol: sl.baseCol + (start - sl.start),
              insideTabSpaces: 0,
              typedLeadingWs: "",
            },
          ],
          inTableCell: false,
        });
      }
      blocks.push(heading);
      i++;
      continue;
    }

    // 4. Fenced code block
    const fence = FENCE_OPEN_RE.exec(lineText);
    if (fence && (fence[1]![0] !== "`" || !fence[2]!.includes("`"))) {
      const fenceChar = fence[1]![0]!;
      const fenceLen = fence[1]!.length;
      const infoRaw = fence[2]!.trim();
      let lang: string | null = null;
      let meta: string | null = null;
      if (infoRaw.length > 0) {
        const sp = infoRaw.search(/[ \t]/);
        if (sp === -1) {
          lang = unescapeMarkdown(infoRaw, false);
        } else {
          lang = unescapeMarkdown(infoRaw.slice(0, sp), false);
          const rest = infoRaw.slice(sp + 1).trim();
          meta = rest.length > 0 ? unescapeMarkdown(rest, false) : null;
        }
      }
      const codeLines: string[] = [];
      let closed = false;
      let j = i + 1;
      let endOffset = sl.end;
      while (j < slices.length) {
        const cur = slices[j]!;
        const sc = scanIndent(ctx.src, cur);
        const trimmed = ctx.src.slice(sc.offset, cur.end);
        if (
          sc.indent <= 3 &&
          trimmed.startsWith(fenceChar.repeat(fenceLen)) &&
          new RegExp(`^\\${fenceChar}{${fenceLen},}[ \\t]*$`).test(trimmed)
        ) {
          closed = true;
          endOffset = cur.end;
          j++;
          break;
        }
        // Strip up to opening fence indent
        const stripCols = Math.min(scan.indent, sc.indent);
        const adv = advanceColumns(ctx.src, cur, stripCols);
        codeLines.push(
          (adv.insideTabSpaces > 0 ? " ".repeat(adv.insideTabSpaces) : "") +
            ctx.src.slice(adv.start, cur.end),
        );
        endOffset = cur.end;
        j++;
      }
      const codeNode: MdCode = {
        type: "code",
        ...(lang !== null ? { lang } : {}),
        ...(meta !== null ? { meta } : {}),
        value: codeLines.join("\n"),
        fenced: true,
        closed,
        position: ctx.idx.pos(scan.offset, endOffset),
      };
      blocks.push(codeNode);
      i = j;
      continue;
    }

    // 5. Display math block (`$$` or `\[` on own line)
    if (ctx.opts.math) {
      const mathBlock = tryParseDisplayMathBlock(ctx, slices, i);
      if (mathBlock) {
        blocks.push(mathBlock.node);
        i = mathBlock.nextIndex;
        continue;
      }
    }

    // 6. Codex leaf directive (`::artifact-template{...}`)
    if (ctx.opts.directives && lineText.startsWith("::artifact-template")) {
      const m = CODEX_LEAF_RE.exec(lineText);
      if (m) {
        const attrs = parseDirectiveAttributes(m[2]);
        const template = resolveCodexArtifactTemplate(attrs);
        if (template) {
          const dir: MdDirective = {
            type: "directive",
            kind: "leaf",
            name: "artifact-template",
            label: m[1] ?? "",
            attributes: attrs,
            template,
            children: [],
            position: ctx.idx.pos(scan.offset, sl.end),
          };
          blocks.push(dir);
          i++;
          continue;
        }
      }
    }

    // 7. Thematic break (check before list item since `- - -` is thematic break!)
    if (THEMATIC_BREAK_RE.test(lineText)) {
      blocks.push({
        type: "thematicBreak",
        position: ctx.idx.pos(scan.offset, sl.end),
      });
      i++;
      continue;
    }

    // 8. Blockquote
    if (lineText.startsWith(">")) {
      const quoteSlices: LineSlice[] = [];
      let j = i;
      let lastEnd = sl.end;
      let openParagraph = false;
      while (j < slices.length) {
        const cur = slices[j]!;
        const sc = scanIndent(ctx.src, cur);
        if (!sc.isBlank && sc.indent <= 3 && ctx.src.charCodeAt(sc.offset) === 62 /* > */) {
          let afterGt = sc.offset + 1;
          let col = sc.col + 1;
          let insideTab = 0;
          if (afterGt < cur.end) {
            const c = ctx.src.charCodeAt(afterGt);
            if (c === 32) {
              afterGt++;
              col++;
            } else if (c === 9) {
              const step = nextTabStop(col) - col;
              afterGt++;
              col += 1;
              insideTab = step - 1;
            }
          }
          const innerSlice: LineSlice = {
            lineNum: cur.lineNum,
            start: afterGt,
            end: cur.end,
            rawEnd: cur.rawEnd,
            baseCol: col,
            insideTabSpaces: insideTab,
            typedLeadingWs: "",
          };
          const innerScan = scanIndent(ctx.src, innerSlice);
          openParagraph =
            !innerScan.isBlank &&
            innerScan.indent <= 3 &&
            !canInterruptParagraph(ctx, [innerSlice], 0);
          quoteSlices.push(innerSlice);
          lastEnd = cur.end;
          j++;
          continue;
        }
        // Lazy continuation line when inside an open paragraph
        if (openParagraph && !sc.isBlank && !canInterruptParagraph(ctx, slices, j)) {
          quoteSlices.push({ ...cur, lazy: true });
          lastEnd = cur.end;
          j++;
          continue;
        }
        break;
      }
      const children = parseBlocks(ctx, quoteSlices, false);
      const bq: MdBlockquote = {
        type: "blockquote",
        children,
        position: ctx.idx.pos(scan.offset, lastEnd),
      };
      blocks.push(bq);
      i = j;
      continue;
    }

    // 9. List (ordered or unordered)
    const listMatch = LIST_MARKER_RE.exec(lineText);
    if (listMatch) {
      const ordered = listMatch[2] !== undefined;
      const delimiter = ordered ? listMatch[3]! : listMatch[1]!;
      const startNum = ordered ? Number(listMatch[2]) : null;
      const items: MdListItem[] = [];
      let spread = false;
      let j = i;
      let listEnd = sl.end;
      let expectedNumber = startNum ?? 1;

      while (j < slices.length) {
        const itemFirst = slices[j]!;
        const itemScan = scanIndent(ctx.src, itemFirst);
        if (itemScan.isBlank || itemScan.indent > 3) break;
        const itemLineText = ctx.src.slice(itemScan.offset, itemFirst.end);
        if (THEMATIC_BREAK_RE.test(itemLineText)) break;
        const m = LIST_MARKER_RE.exec(itemLineText);
        if (!m) break;
        const mOrdered = m[2] !== undefined;
        const mDelim = mOrdered ? m[3]! : m[1]!;
        if (mOrdered !== ordered || mDelim !== delimiter) break;

        const writtenNumber = mOrdered ? Number(m[2]) : undefined;
        const markerLen = m[1]!.length;
        const afterMarkerPos = itemScan.offset + markerLen;
        const afterMarkerCol = itemScan.col + markerLen;

        // Calculate spaces after marker
        let contentPos = afterMarkerPos;
        let contentCol = afterMarkerCol;
        while (contentPos < itemFirst.end) {
          const c = ctx.src.charCodeAt(contentPos);
          if (c === 32) {
            contentCol++;
            contentPos++;
          } else if (c === 9) {
            contentCol = nextTabStop(contentCol);
            contentPos++;
          } else {
            break;
          }
        }
        const spacesCols = contentCol - afterMarkerCol;
        const firstLineBlank = contentPos >= itemFirst.end;
        const isWideIndented = !firstLineBlank && spacesCols > 4;

        let itemIndentCols: number;
        let firstInnerSlice: LineSlice;

        if (firstLineBlank) {
          itemIndentCols = afterMarkerCol - itemFirst.baseCol + 1;
          firstInnerSlice = {
            lineNum: itemFirst.lineNum,
            start: itemFirst.end,
            end: itemFirst.end,
            rawEnd: itemFirst.rawEnd,
            baseCol: afterMarkerCol + 1,
            insideTabSpaces: 0,
            typedLeadingWs: "",
          };
        } else if (isWideIndented && ctx.opts.normalizeListIndentation) {
          // T3 Code: wide indentation on marker's first line recovers as normal markdown!
          itemIndentCols = contentCol - itemFirst.baseCol;
          firstInnerSlice = {
            lineNum: itemFirst.lineNum,
            start: contentPos,
            end: itemFirst.end,
            rawEnd: itemFirst.rawEnd,
            baseCol: contentCol,
            insideTabSpaces: 0,
            typedLeadingWs: "",
          };
        } else if (isWideIndented) {
          // Strict CommonMark: 1 space after marker, rest is indented code
          itemIndentCols = afterMarkerCol - itemFirst.baseCol + 1;
          const adv = advanceColumns(
            ctx.src,
            {
              ...itemFirst,
              start: afterMarkerPos,
              baseCol: afterMarkerCol,
              insideTabSpaces: 0,
            },
            1,
          );
          firstInnerSlice = {
            lineNum: itemFirst.lineNum,
            start: adv.start,
            end: itemFirst.end,
            rawEnd: itemFirst.rawEnd,
            baseCol: adv.baseCol,
            insideTabSpaces: adv.insideTabSpaces,
            typedLeadingWs: "",
          };
        } else {
          itemIndentCols = contentCol - itemFirst.baseCol;
          firstInnerSlice = {
            lineNum: itemFirst.lineNum,
            start: contentPos,
            end: itemFirst.end,
            rawEnd: itemFirst.rawEnd,
            baseCol: contentCol,
            insideTabSpaces: 0,
            typedLeadingWs: "",
          };
        }

        // Check GFM task checkbox at start of first line
        let checked: boolean | null | undefined;
        if (ctx.opts.gfm && !firstLineBlank) {
          const firstContent = ctx.src.slice(firstInnerSlice.start, firstInnerSlice.end);
          const taskM = TASK_CHECKBOX_RE.exec(firstContent);
          if (taskM) {
            checked = taskM[1] !== " ";
            const skip = taskM[0].length;
            firstInnerSlice = {
              ...firstInnerSlice,
              start: firstInnerSlice.start + skip,
              baseCol: firstInnerSlice.baseCol + skip,
            };
          }
        }

        const itemSlices: LineSlice[] = [firstInnerSlice];
        let k = j + 1;
        let lastNonBlankK = j;
        let trailingBlankLines = 0;

        while (k < slices.length) {
          const cur = slices[k]!;
          const sc = scanIndent(ctx.src, cur);
          if (sc.isBlank) {
            itemSlices.push({
              lineNum: cur.lineNum,
              start: cur.end,
              end: cur.end,
              rawEnd: cur.rawEnd,
              baseCol: cur.baseCol + itemIndentCols,
              insideTabSpaces: 0,
              typedLeadingWs: "",
            });
            trailingBlankLines++;
            k++;
            continue;
          }
          if (sc.indent >= itemIndentCols) {
            const adv = advanceColumns(ctx.src, cur, itemIndentCols);
            itemSlices.push({
              lineNum: cur.lineNum,
              start: adv.start,
              end: cur.end,
              rawEnd: cur.rawEnd,
              baseCol: adv.baseCol,
              insideTabSpaces: adv.insideTabSpaces,
              typedLeadingWs: "",
            });
            lastNonBlankK = k;
            trailingBlankLines = 0;
            k++;
            continue;
          }
          // A sibling list marker at lower indent ends this item rather than lazily continuing it.
          if (sc.indent <= 3 && sc.indent < itemIndentCols) {
            const curText = ctx.src.slice(sc.offset, cur.end);
            if (LIST_MARKER_RE.test(curText) || THEMATIC_BREAK_RE.test(curText)) break;
          }
          // Lazy continuation if no blank line preceded and not a block interrupt
          if (trailingBlankLines === 0 && !canInterruptParagraph(ctx, slices, k)) {
            itemSlices.push({ ...cur, lazy: true });
            lastNonBlankK = k;
            k++;
            continue;
          }
          break;
        }

        // Trim trailing blank slices from this item
        const hadTrailingBlank = trailingBlankLines > 0;
        while (
          itemSlices.length > 1 &&
          scanIndent(ctx.src, itemSlices[itemSlices.length - 1]!).isBlank
        ) {
          itemSlices.pop();
        }

        // Detect internal blank lines between blocks inside this item
        const itemChildren = parseBlocks(ctx, itemSlices, false);
        let itemSpread = false;
        if (itemChildren.length > 1) {
          let seenContent = false;
          let seenBlankAfterContent = false;
          for (const isl of itemSlices) {
            if (scanIndent(ctx.src, isl).isBlank) {
              if (seenContent) seenBlankAfterContent = true;
            } else {
              if (seenBlankAfterContent) {
                itemSpread = true;
                break;
              }
              seenContent = true;
            }
          }
        }
        if (itemSpread) spread = true;

        const itemEnd = slices[lastNonBlankK]!.end;
        const item: MdListItem = {
          type: "listItem",
          ...(checked !== undefined ? { checked } : {}),
          spread: itemSpread,
          ...(ordered &&
          ctx.opts.keepOrderedListNumbers &&
          writtenNumber !== undefined &&
          writtenNumber !== expectedNumber
            ? { value: writtenNumber }
            : {}),
          children: itemChildren,
          position: ctx.idx.pos(itemScan.offset, itemEnd),
        };
        if (ordered && writtenNumber !== undefined) {
          expectedNumber = (ctx.opts.keepOrderedListNumbers ? writtenNumber : expectedNumber) + 1;
        }
        items.push(item);
        listEnd = itemEnd;

        // If there were blank lines before the next item of the same list, the list is loose.
        j = k;
        if (j < slices.length && hadTrailingBlank) {
          const nextScan = scanIndent(ctx.src, slices[j]!);
          const nextText = ctx.src.slice(nextScan.offset, slices[j]!.end);
          const nextM = LIST_MARKER_RE.exec(nextText);
          if (
            nextScan.indent <= 3 &&
            nextM &&
            !THEMATIC_BREAK_RE.test(nextText) &&
            (nextM[2] !== undefined) === ordered &&
            (nextM[2] !== undefined ? nextM[3] : nextM[1]) === delimiter
          ) {
            spread = true;
          }
        }
      }

      const listNode: MdList = {
        type: "list",
        ordered,
        ...(ordered ? { start: startNum } : {}),
        spread,
        children: items,
        position: ctx.idx.pos(scan.offset, listEnd),
      };
      blocks.push(listNode);
      i = j;
      continue;
    }

    // 10. HTML block (CommonMark types 1-7)
    const htmlType = detectHtmlBlockType(lineText, false);
    if (htmlType > 0) {
      const htmlLines: string[] = [];
      let j = i;
      let endOffset = sl.end;
      while (j < slices.length) {
        const cur = slices[j]!;
        const sc = scanIndent(ctx.src, cur);
        if ((htmlType === 6 || htmlType === 7) && sc.isBlank) break;
        const rawLine = sliceText(ctx.src, cur);
        htmlLines.push(rawLine);
        endOffset = cur.end;
        j++;
        if (htmlType === 1 && HTML_BLOCK_TYPE1_CLOSE.test(rawLine)) break;
        if (htmlType === 2 && rawLine.includes("-->")) break;
        if (htmlType === 3 && rawLine.includes("?>")) break;
        if (htmlType === 4 && rawLine.includes(">")) break;
        if (htmlType === 5 && rawLine.includes("]]>")) break;
      }
      const htmlNode: MdHtml = {
        type: "html",
        value: htmlLines.join("\n"),
        block: true,
        position: ctx.idx.pos(sl.start, endOffset),
      };
      blocks.push(htmlNode);
      i = j;
      continue;
    }

    // 11. GFM Footnote definition (`[^label]: ...`)
    if (ctx.opts.gfm && lineText.startsWith("[^")) {
      const fm = FOOTNOTE_DEF_RE.exec(lineText);
      if (fm) {
        const label = fm[1]!;
        const identifier = normalizeLabel(label);
        const colonIdx = lineText.indexOf("]:");
        let afterColon = scan.offset + colonIdx + 2;
        while (afterColon < sl.end && isSpace(ctx.src.charCodeAt(afterColon))) afterColon++;
        const fnSlices: LineSlice[] = [];
        if (afterColon < sl.end) {
          fnSlices.push({
            lineNum: sl.lineNum,
            start: afterColon,
            end: sl.end,
            rawEnd: sl.rawEnd,
            baseCol: sl.baseCol + (afterColon - sl.start),
            insideTabSpaces: 0,
            typedLeadingWs: "",
          });
        }
        let j = i + 1;
        let lastEnd = sl.end;
        while (j < slices.length) {
          const cur = slices[j]!;
          const sc = scanIndent(ctx.src, cur);
          if (sc.isBlank) {
            fnSlices.push({
              lineNum: cur.lineNum,
              start: cur.end,
              end: cur.end,
              rawEnd: cur.rawEnd,
              baseCol: cur.baseCol + 4,
              insideTabSpaces: 0,
              typedLeadingWs: "",
            });
            j++;
            continue;
          }
          if (sc.indent >= 4) {
            const adv = advanceColumns(ctx.src, cur, 4);
            fnSlices.push({
              lineNum: cur.lineNum,
              start: adv.start,
              end: cur.end,
              rawEnd: cur.rawEnd,
              baseCol: adv.baseCol,
              insideTabSpaces: adv.insideTabSpaces,
              typedLeadingWs: "",
            });
            lastEnd = cur.end;
            j++;
            continue;
          }
          break;
        }
        while (
          fnSlices.length > 0 &&
          scanIndent(ctx.src, fnSlices[fnSlices.length - 1]!).isBlank
        ) {
          fnSlices.pop();
        }
        const fnDef: MdFootnoteDefinition = {
          type: "footnoteDefinition",
          identifier,
          label,
          children: parseBlocks(ctx, fnSlices, false),
          position: ctx.idx.pos(scan.offset, lastEnd),
        };
        if (!ctx.footnotes.has(identifier)) {
          ctx.footnotes.set(identifier, fnDef);
        }
        blocks.push(fnDef);
        i = j;
        continue;
      }
    }

    // 12. Link reference definition (`[label]: url "title"`)
    if (lineText.startsWith("[")) {
      const defResult = tryParseReferenceDefinition(ctx, slices, i);
      if (defResult) {
        if (!ctx.definitions.has(defResult.def.identifier)) {
          ctx.definitions.set(defResult.def.identifier, defResult.def);
        }
        blocks.push(defResult.def);
        i = defResult.nextIndex;
        continue;
      }
    }

    // 13. GFM Table
    if (ctx.opts.gfm && i + 1 < slices.length && lineText.includes("|")) {
      const nextSl = slices[i + 1]!;
      const nextScan = scanIndent(ctx.src, nextSl);
      if (!nextScan.isBlank && nextScan.indent <= 3) {
        const aligns = parseTableDelimiterRow(ctx.src.slice(nextScan.offset, nextSl.end));
        if (aligns) {
          const headerRanges = splitTableCells(ctx.src, scan.offset, sl.end, ctx.opts.math);
          if (headerRanges.length === aligns.length) {
            const makeRow = (rowSl: LineSlice, ranges: TableCellSlice[]): MdTableRow => {
              const cells: MdTableCell[] = [];
              for (let c = 0; c < aligns.length; c++) {
                const range = ranges[c];
                const cell: MdTableCell = {
                  type: "tableCell",
                  children: [],
                  ...(range ? { position: ctx.idx.pos(range.start, range.end) } : {}),
                };
                if (range && range.start < range.end) {
                  ctx.inlineTargets.push({
                    node: cell,
                    slices: [
                      {
                        lineNum: rowSl.lineNum,
                        start: range.start,
                        end: range.end,
                        rawEnd: rowSl.rawEnd,
                        baseCol: rowSl.baseCol + (range.start - rowSl.start),
                        insideTabSpaces: 0,
                        typedLeadingWs: "",
                      },
                    ],
                    inTableCell: true,
                  });
                }
                cells.push(cell);
              }
              return {
                type: "tableRow",
                children: cells,
                position: ctx.idx.pos(rowSl.start, rowSl.end),
              };
            };

            const rows: MdTableRow[] = [makeRow(sl, headerRanges)];
            let j = i + 2;
            let tableEnd = nextSl.end;
            while (j < slices.length) {
              const cur = slices[j]!;
              const sc = scanIndent(ctx.src, cur);
              if (sc.isBlank || sc.indent > 3) break;
              const rowText = ctx.src.slice(sc.offset, cur.end);
              if (!rowText.includes("|")) break;
              if (canInterruptParagraph(ctx, slices, j)) {
                // Only non-table block interrupts stop a table
                if (
                  rowText.startsWith(">") ||
                  ATX_HEADING_RE.test(rowText) ||
                  THEMATIC_BREAK_RE.test(rowText) ||
                  FENCE_OPEN_RE.test(rowText) ||
                  detectHtmlBlockType(rowText, true) > 0
                ) {
                  break;
                }
              }
              const bodyRanges = splitTableCells(ctx.src, sc.offset, cur.end, ctx.opts.math);
              rows.push(makeRow(cur, bodyRanges));
              tableEnd = cur.end;
              j++;
            }
            const table: MdTable = {
              type: "table",
              align: aligns,
              children: rows,
              position: ctx.idx.pos(scan.offset, tableEnd),
            };
            blocks.push(table);
            i = j;
            continue;
          }
        }
      }
    }

    // 14. Paragraph (or Setext heading)
    const paraSlices: LineSlice[] = [];
    let j = i;
    let setextDepth: 1 | 2 | null = null;
    let setextEnd = sl.end;

    while (j < slices.length) {
      const cur = slices[j]!;
      const sc = scanIndent(ctx.src, cur);
      if (sc.isBlank) break;
      if (j > i) {
        if (sc.indent <= 3) {
          const t = ctx.src.slice(sc.offset, cur.end);
          const sm = SETEXT_RE.exec(t);
          if (sm) {
            setextDepth = sm[1]![0] === "=" ? 1 : 2;
            setextEnd = cur.end;
            j++;
            break;
          }
        }
        if (canInterruptParagraph(ctx, slices, j)) break;
      }
      const trimmed = trimSliceLeadingWs(ctx.src, cur);
      paraSlices.push({
        lineNum: cur.lineNum,
        start: trimmed.start,
        end: cur.end,
        rawEnd: cur.rawEnd,
        baseCol: sc.col,
        insideTabSpaces: 0,
        typedLeadingWs: cur.lazy ? "" : trimmed.ws,
      });
      j++;
    }

    const firstP = paraSlices[0]!;
    const lastP = paraSlices[paraSlices.length - 1]!;

    if (setextDepth !== null) {
      const heading: MdHeading = {
        type: "heading",
        depth: setextDepth,
        children: [],
        position: ctx.idx.pos(firstP.start, setextEnd),
      };
      ctx.inlineTargets.push({ node: heading, slices: paraSlices, inTableCell: false });
      blocks.push(heading);
    } else {
      const para: MdParagraph = {
        type: "paragraph",
        children: [],
        position: ctx.idx.pos(firstP.start, lastP.end),
      };
      ctx.inlineTargets.push({ node: para, slices: paraSlices, inTableCell: false });
      blocks.push(para);
    }
    i = j;
  }

  return blocks;
}

// --- Inline scanners (charCode-based) ---

function findCodeSpanEnd(src: string, start: number, limit: number): number {
  let ticks = 0;
  let pos = start;
  while (pos < limit && src.charCodeAt(pos) === 96) {
    ticks++;
    pos++;
  }
  while (pos < limit) {
    if (src.charCodeAt(pos) === 96) {
      let closeTicks = 0;
      while (pos < limit && src.charCodeAt(pos) === 96) {
        closeTicks++;
        pos++;
      }
      if (closeTicks === ticks) return pos;
    } else {
      pos++;
    }
  }
  return -1;
}

function findInlineHtmlOrAutolinkEnd(src: string, start: number, limit: number): number {
  if (start + 2 >= limit) return -1;
  const c1 = src.charCodeAt(start + 1);
  // Comment `<!-- ... -->`
  if (src.startsWith("<!--", start)) {
    const close = src.indexOf("-->", start + 4);
    return close >= 0 && close + 3 <= limit ? close + 3 : -1;
  }
  // Closing tag `</tag>`
  if (c1 === 47 /* / */) {
    let p = start + 2;
    if (p >= limit || !isAlpha(src.charCodeAt(p))) return -1;
    p++;
    while (p < limit && (isAlphaNum(src.charCodeAt(p)) || src.charCodeAt(p) === 45)) p++;
    while (p < limit && isSpace(src.charCodeAt(p))) p++;
    return p < limit && src.charCodeAt(p) === 62 ? p + 1 : -1;
  }
  // Autolink `<scheme:...>` or `<email>` or open tag `<tag ...>`
  if (isAlpha(c1)) {
    // Check URI autolink `<scheme:...>`
    let p = start + 2;
    while (
      p < limit &&
      (isAlphaNum(src.charCodeAt(p)) ||
        src.charCodeAt(p) === 43 ||
        src.charCodeAt(p) === 45 ||
        src.charCodeAt(p) === 46)
    ) {
      p++;
    }
    if (p - (start + 1) >= 2 && p - (start + 1) <= 32 && p < limit && src.charCodeAt(p) === 58) {
      let q = p + 1;
      while (q < limit) {
        const ch = src.charCodeAt(q);
        if (ch === 62) return q + 1;
        if (ch <= 32 || ch === 60) break;
        q++;
      }
    }
    // Check email autolink `<a@b.c>`
    const gt = src.indexOf(">", start + 1);
    if (gt > start + 1 && gt < limit) {
      const inner = src.slice(start + 1, gt);
      if (/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/.test(inner)) {
        return gt + 1;
      }
      // Open HTML tag
      if (
        /^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>$/.test(
          src.slice(start, gt + 1),
        )
      ) {
        return gt + 1;
      }
    }
  }
  return -1;
}

const CITATION_BRACKET_RE = /^\s*\d+(?:\s*[,–-]\s*\d+)*\s*$/;

function isValidSingleDollarCloser(src: string, closePos: number, limit: number, contentStart: number): boolean {
  if (closePos <= contentStart) return false;
  const before = src.charCodeAt(closePos - 1);
  if (isSpace(before) || isEol(before)) return false;
  if (countPrecedingBackslashes(src, closePos) % 2 === 1) return false;
  if (closePos + 1 < limit) {
    const after = src.charCodeAt(closePos + 1);
    // `$5-$10`, `$HOME,$PATH`, `$HOME,$_PATH`, `$1,000,$2,000`
    if (isAlphaNum(after) || after === 95 /* _ */) return false;
    // `$HOME,${PATH}`, `$HOME,$(pwd)`, `$HOME,$@`, `$HOME,$?`
    if (
      before === 44 /* , */ &&
      (after === 123 /* { */ ||
        after === 40 /* ( */ ||
        after === 64 /* @ */ ||
        after === 63 /* ? */ ||
        after === 36 /* $ */)
    ) {
      return false;
    }
  }
  return true;
}

function findInlineDollarMathEnd(src: string, start: number, limit: number): number {
  const isDouble = start + 1 < limit && src.charCodeAt(start + 1) === 36;
  if (isDouble) {
    // `$$...$$` inline display math
    let pos = start + 2;
    if (pos >= limit) return -1;
    // Don't match `$$$` empty
    while (pos < limit) {
      const c = src.charCodeAt(pos);
      if (c === 92 /* \ */) {
        pos += 2;
        continue;
      }
      if (c === 96 /* ` */) {
        const ce = findCodeSpanEnd(src, pos, limit);
        if (ce > 0) return -1;
        pos++;
        continue;
      }
      if (c === 36 && pos + 1 < limit && src.charCodeAt(pos + 1) === 36) {
        if (pos === start + 2) return -1;
        return pos + 2;
      }
      pos++;
    }
    return -1;
  }

  // Single `$...$`
  const contentStart = start + 1;
  if (contentStart >= limit) return -1;
  const first = src.charCodeAt(contentStart);
  if (isSpace(first) || isEol(first) || first === 36) return -1;

  let pos = contentStart;
  while (pos < limit) {
    const c = src.charCodeAt(pos);
    if (c === 92 /* \ */) {
      pos += 2;
      continue;
    }
    if (c === 96 /* ` */) {
      const ce = findCodeSpanEnd(src, pos, limit);
      if (ce > 0) return -1; // code span wins (e.g. `$a`$HOME``)
      pos++;
      continue;
    }
    if (c === 36 /* $ */) {
      // Single-dollar math cannot contain an unescaped `$`; either this closes it or it fails.
      return isValidSingleDollarCloser(src, pos, limit, contentStart) ? pos + 1 : -1;
    }
    pos++;
  }
  return -1;
}

function findInlineTexMathEnd(src: string, start: number, limit: number, isDisplay: boolean): number {
  const closeChar = isDisplay ? 93 /* ] */ : 41 /* ) */;
  let pos = start + 2;
  while (pos < limit) {
    const c = src.charCodeAt(pos);
    if (c === 96 /* ` */) {
      const ce = findCodeSpanEnd(src, pos, limit);
      if (ce > 0) return -1; // code span wins (`\(a`\)``)
      pos++;
      continue;
    }
    if (c === 92 /* \ */ && pos + 1 < limit) {
      if (src.charCodeAt(pos + 1) === closeChar) {
        if (countPrecedingBackslashes(src, pos) % 2 === 0) {
          const body = src.slice(start + 2, pos);
          if (body.length === 0) return -1;
          if (isDisplay && CITATION_BRACKET_RE.test(body)) return -1;
          return pos + 2;
        }
      }
      pos += 2;
      continue;
    }
    pos++;
  }
  return -1;
}

interface ParsedDestination {
  readonly rawDest: string;
  readonly url: string;
  readonly title: string | null;
  readonly afterPos: number;
}

function parseLinkDestinationInline(
  src: string,
  start: number,
  limit: number,
  keepWindows: boolean,
): ParsedDestination | null {
  let pos = start;
  while (pos < limit && (isSpace(src.charCodeAt(pos)) || isEol(src.charCodeAt(pos)))) pos++;
  if (pos >= limit) return null;

  let rawDest = "";
  if (src.charCodeAt(pos) === 41 /* ) */) {
    return { rawDest: "", url: "", title: null, afterPos: pos + 1 };
  }

  if (src.charCodeAt(pos) === 60 /* < */) {
    pos++;
    const dStart = pos;
    let closed = false;
    while (pos < limit) {
      const c = src.charCodeAt(pos);
      if (c === 92 && pos + 1 < limit) {
        pos += 2;
      } else if (c === 62 /* > */) {
        rawDest = src.slice(dStart, pos);
        pos++;
        closed = true;
        break;
      } else if (c === 60 || isEol(c)) {
        return null;
      } else {
        pos++;
      }
    }
    if (!closed) return null;
  } else {
    const dStart = pos;
    let parens = 0;
    while (pos < limit) {
      const c = src.charCodeAt(pos);
      if (c <= 32 || c === 127) break;
      if (c === 92 && pos + 1 < limit && isAsciiPunct(src.charCodeAt(pos + 1))) {
        pos += 2;
      } else if (c === 40 /* ( */) {
        parens++;
        if (parens > 32) return null;
        pos++;
      } else if (c === 41 /* ) */) {
        if (parens === 0) break;
        parens--;
        pos++;
      } else {
        pos++;
      }
    }
    if (parens !== 0) return null;
    rawDest = src.slice(dStart, pos);
  }

  const wsStart = pos;
  while (pos < limit && (isSpace(src.charCodeAt(pos)) || isEol(src.charCodeAt(pos)))) pos++;
  if (pos >= limit) return null;

  let title: string | null = null;
  if (src.charCodeAt(pos) === 41 /* ) */) {
    return {
      rawDest,
      url: unescapeMarkdown(rawDest, keepWindows),
      title: null,
      afterPos: pos + 1,
    };
  }

  if (pos === wsStart) return null;
  const q = src.charCodeAt(pos);
  if (q !== 34 && q !== 39 && q !== 40) return null;
  const closeQ = q === 40 ? 41 : q;
  pos++;
  const tStart = pos;
  let closedTitle = false;
  while (pos < limit) {
    const c = src.charCodeAt(pos);
    if (c === 92 && pos + 1 < limit) {
      pos += 2;
    } else if (c === closeQ) {
      title = unescapeMarkdown(src.slice(tStart, pos), false);
      pos++;
      closedTitle = true;
      break;
    } else {
      pos++;
    }
  }
  if (!closedTitle) return null;
  while (pos < limit && (isSpace(src.charCodeAt(pos)) || isEol(src.charCodeAt(pos)))) pos++;
  if (pos >= limit || src.charCodeAt(pos) !== 41) return null;

  return {
    rawDest,
    url: unescapeMarkdown(rawDest, keepWindows),
    title,
    afterPos: pos + 1,
  };
}

// --- Codex inline directive scanner ---

const DIRECTIVE_INLINE_NAMES = ["codex-file-citation", "codex-followup"] as const;

function directiveNameEndsChar(ch: string | undefined): boolean {
  if (!ch) return true;
  const c = ch.charCodeAt(0);
  if (c === 45 || c === 95) return false; // `-` or `_`
  return isUnicodeSpace(ch) || isUnicodePunct(ch);
}

function tryParseInlineDirective(
  src: string,
  start: number,
  limit: number,
): {
  name: string;
  labelStart: number;
  labelEnd: number;
  attributes: Record<string, string>;
  end: number;
} | null {
  // Cannot be preceded by `:`
  if (start > 0 && src.charCodeAt(start - 1) === 58) return null;
  let matchedName: string | undefined;
  for (const name of DIRECTIVE_INLINE_NAMES) {
    if (
      src.startsWith(name, start + 1) &&
      directiveNameEndsChar(start + 1 + name.length < limit ? src[start + 1 + name.length] : undefined)
    ) {
      matchedName = name;
      break;
    }
  }
  if (!matchedName) return null;

  let pos = start + 1 + matchedName.length;
  let labelStart = -1;
  let labelEnd = -1;

  if (pos < limit && src.charCodeAt(pos) === 91 /* [ */) {
    labelStart = pos + 1;
    let depth = 0;
    let closed = false;
    while (pos < limit) {
      const c = src.charCodeAt(pos);
      if (c === 92 && pos + 1 < limit) {
        pos += 2;
        continue;
      }
      if (c === 91) depth++;
      else if (c === 93) {
        depth--;
        if (depth === 0) {
          labelEnd = pos;
          pos++;
          closed = true;
          break;
        }
      }
      pos++;
    }
    if (!closed) {
      labelStart = -1;
      labelEnd = -1;
      pos = start + 1 + matchedName.length;
    }
  }

  let attributes: Record<string, string> = {};
  if (pos < limit && src.charCodeAt(pos) === 123 /* { */) {
    const attrStart = pos + 1;
    let p = attrStart;
    let closed = false;
    while (p < limit) {
      const c = src.charCodeAt(p);
      if (c === 34 || c === 39) {
        const q = c;
        p++;
        while (p < limit && src.charCodeAt(p) !== q) p++;
        if (p < limit) p++;
        continue;
      }
      if (c === 125 /* } */) {
        attributes = parseDirectiveAttributes(src.slice(attrStart, p));
        pos = p + 1;
        closed = true;
        break;
      }
      p++;
    }
    if (!closed) return null;
  }

  return { name: matchedName, labelStart, labelEnd, attributes, end: pos };
}

// --- Full CommonMark + GFM + Math + Directive inline parser ---

interface Delimiter {
  readonly ch: string;
  count: number;
  readonly origCount: number;
  readonly nodeIndex: number; // index in nodes array (a text node holding the run)
  readonly canOpen: boolean;
  readonly canClose: boolean;
  active: boolean;
}

interface Bracket {
  readonly image: boolean;
  readonly nodeIndex: number; // index of the `[` or `![` text node
  readonly offset: number;
  readonly delimIndex: number;
  active: boolean;
}

// Build a unified virtual string from LineSlices with an exact map back to original offsets!
interface InlineBuffer {
  readonly text: string;
  readonly origOffset: (bufIdx: number) => number;
  readonly lineLeadingWs: Map<number, string>; // bufIdx of line start -> typed leading ws
}

function buildInlineBuffer(src: string, slices: LineSlice[], keepLeadingWs: boolean): InlineBuffer {
  if (slices.length === 1) {
    const sl = slices[0]!;
    const text = src.slice(sl.start, sl.end);
    const map = new Map<number, string>();
    if (keepLeadingWs && sl.typedLeadingWs) map.set(0, sl.typedLeadingWs);
    return {
      text,
      origOffset: (i) => sl.start + i,
      lineLeadingWs: map,
    };
  }

  const parts: string[] = [];
  const segStarts: number[] = [];
  const segOrigStarts: number[] = [];
  const segLens: number[] = [];
  const segEolLens: number[] = [];
  const lineLeadingWs = new Map<number, string>();
  let bufPos = 0;

  for (let i = 0; i < slices.length; i++) {
    const sl = slices[i]!;
    if (i > 0) {
      parts.push("\n");
      bufPos += 1;
    }
    if (keepLeadingWs && sl.typedLeadingWs) {
      lineLeadingWs.set(bufPos, sl.typedLeadingWs);
    }
    const seg = src.slice(sl.start, sl.end);
    segStarts.push(bufPos);
    segOrigStarts.push(sl.start);
    segLens.push(seg.length);
    segEolLens.push(sl.rawEnd - sl.end);
    parts.push(seg);
    bufPos += seg.length;
  }

  const text = parts.join("");
  const origOffset = (bufIdx: number): number => {
    const clamped = Math.max(0, Math.min(bufIdx, text.length));
    let lo = 0;
    let hi = segStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segStarts[mid]! <= clamped) lo = mid;
      else hi = mid - 1;
    }
    const delta = clamped - segStarts[lo]!;
    if (delta <= segLens[lo]!) return segOrigStarts[lo]! + delta;
    // Points to the `\n` separator -> map to end of line
    return segOrigStarts[lo]! + segLens[lo]! + Math.min(delta - segLens[lo]!, segEolLens[lo]!);
  };

  return { text, origOffset, lineLeadingWs };
}

function parseInlines(
  ctx: ParserContext,
  slices: LineSlice[],
  inTableCell: boolean,
): MdNode[] {
  const buf = buildInlineBuffer(ctx.src, slices, ctx.opts.leadingWhitespace);
  return parseInlineRange(ctx, buf, 0, buf.text.length, inTableCell, false);
}

function parseInlineRange(
  ctx: ParserContext,
  buf: InlineBuffer,
  rangeStart: number,
  rangeEnd: number,
  inTableCell: boolean,
  insideLink: boolean,
): MdNode[] {
  const src = buf.text;
  const nodes: MdNode[] = [];
  const delims: Delimiter[] = [];
  const brackets: Bracket[] = [];
  const keepWinDest = ctx.opts.windowsPaths && !ctx.opts.windowsProsePathsOnly;
  const keepWinProse = ctx.opts.windowsPaths || ctx.opts.windowsProsePathsOnly;

  // O(n) memoization: once a math opener scans to `rangeEnd` without finding a closer, skip rescanning
  let noCloseParenMath = false;
  let noCloseBracketMath = false;
  let noCloseDoubleDollar = false;

  const pos = (s: number, e: number) => ctx.idx.pos(buf.origOffset(s), buf.origOffset(e));

  const pushText = (value: string, s: number, e: number) => {
    if (!value) return;
    const prev = nodes.at(-1);
    if (prev?.type === "text" && !isProtectedDelimNode(nodes.length - 1)) {
      prev.value += value;
      if (prev.position) {
        (prev as { position: SourcePosition }).position = ctx.idx.pos(
          prev.position.start.offset,
          buf.origOffset(e),
        );
      }
      return;
    }
    nodes.push({ type: "text", value, position: pos(s, e) });
  };

  const delimNodeIndices = new Set<number>();
  const isProtectedDelimNode = (idx: number) => delimNodeIndices.has(idx);

  const hasOpenDelim = (ch: string) => {
    let balance = 0;
    for (const d of delims) {
      if (!d.active || d.ch !== ch || d.count === 0) continue;
      if (d.canClose && balance > 0) balance = Math.max(0, balance - d.count);
      else if (d.canOpen) balance += d.count;
    }
    return balance > 0;
  };

  let i = rangeStart;

  while (i < rangeEnd) {
    // Emit leading whitespace node at start of line if enabled
    if (ctx.opts.leadingWhitespace && buf.lineLeadingWs.has(i)) {
      const ws = buf.lineLeadingWs.get(i)!;
      buf.lineLeadingWs.delete(i);
      nodes.push({
        type: "leadingWhitespace",
        value: ws,
        position: pos(i, i),
      });
    }

    const c = src.charCodeAt(i);

    // 1. Line break (`\n`)
    if (c === 10 /* \n */) {
      // Check for trailing 2+ spaces hard break on previous text node
      const prev = nodes.at(-1);
      if (prev?.type === "text" && prev.value.endsWith("  ") && !isProtectedDelimNode(nodes.length - 1)) {
        prev.value = prev.value.replace(/ +$/, "");
        if (prev.value === "") nodes.pop();
        nodes.push({ type: "break", position: pos(i, i + 1) });
      } else {
        if (prev?.type === "text" && prev.value.endsWith(" ") && !isProtectedDelimNode(nodes.length - 1)) {
          prev.value = prev.value.slice(0, -1);
          if (prev.value === "") nodes.pop();
        }
        pushText("\n", i, i + 1);
      }
      i++;
      continue;
    }

    // 2. Backslash escape OR `\( ... \)` / `\[ ... \]` math OR `\` hard break
    if (c === 92 /* \ */) {
      if (i + 1 < rangeEnd) {
        const next = src.charCodeAt(i + 1);
        // Hard line break `\\\n`
        if (next === 10) {
          nodes.push({ type: "break", position: pos(i, i + 2) });
          i += 2;
          continue;
        }
        // TeX inline/display math `\(...\)` or `\[...\]`
        if (ctx.opts.math && (next === 40 || next === 91)) {
          const isDisp = next === 91;
          const alreadyFailed = isDisp ? noCloseBracketMath : noCloseParenMath;
          if (!alreadyFailed) {
            const end = findInlineTexMathEnd(src, i, rangeEnd, isDisp);
            if (end > 0) {
              const rawTex = src.slice(i + 2, end - 2);
              const tex = inTableCell ? rawTex : rawTex;
              nodes.push(makeInlineMathNode(tex, isDisp, pos(i, end)));
              i = end;
              continue;
            }
            if (!src.slice(i + 2, rangeEnd).includes(isDisp ? "\\]" : "\\)")) {
              if (isDisp) noCloseBracketMath = true;
              else noCloseParenMath = true;
            }
          }
        }
        // ASCII punctuation escape
        if (isAsciiPunct(next)) {
          // Windows prose path check: keep backslash literal inside drive path (e.g., `C:\Users\.t3`)
          if (keepWinProse && isInWindowsProsePath(nodes)) {
            pushText("\\" + src[i + 1]!, i, i + 2);
          } else {
            pushText(src[i + 1]!, i, i + 2);
          }
          i += 2;
          continue;
        }
      }
      pushText("\\", i, i + 1);
      i++;
      continue;
    }

    // 3. Inline code span (`` `...` ``)
    if (c === 96 /* ` */) {
      let ticks = 0;
      let p = i;
      while (p < rangeEnd && src.charCodeAt(p) === 96) {
        ticks++;
        p++;
      }
      const end = findCodeSpanEnd(src, i, rangeEnd);
      if (end > 0) {
        let code = src.slice(i + ticks, end - ticks).replace(/\n/g, " ");
        if (code.length >= 2 && code.startsWith(" ") && code.endsWith(" ") && /[^ ]/.test(code)) {
          code = code.slice(1, -1);
        }
        if (inTableCell) {
          code = code.replace(/\\\|/g, "|");
        }
        nodes.push({ type: "inlineCode", value: code, position: pos(i, end) });
        i = end;
        continue;
      }
      pushText(src.slice(i, p), i, p);
      i = p;
      continue;
    }

    // 4. Inline math (`$...$` / `$$...$$`)
    if (ctx.opts.math && c === 36 /* $ */) {
      const isDouble = i + 1 < rangeEnd && src.charCodeAt(i + 1) === 36;
      if (!(isDouble && noCloseDoubleDollar)) {
        const end = findInlineDollarMathEnd(src, i, rangeEnd);
        if (end > 0) {
          const delimLen = isDouble ? 2 : 1;
          const tex = src.slice(i + delimLen, end - delimLen);
          nodes.push(makeInlineMathNode(tex, isDouble, pos(i, end)));
          i = end;
          continue;
        }
        if (isDouble && !src.slice(i + 2, rangeEnd).includes("$$")) {
          noCloseDoubleDollar = true;
        }
      }
      // Consume contiguous `$` run if double-dollar failed to avoid splitting `$$` into `$` + `$`
      if (isDouble) {
        let endRun = i + 2;
        while (endRun < rangeEnd && src.charCodeAt(endRun) === 36) endRun++;
        pushText(src.slice(i, endRun), i, endRun);
        i = endRun;
        continue;
      }
      pushText("$", i, i + 1);
      i++;
      continue;
    }

    // 5. Codex inline directives (`:codex-file-citation`, `:codex-followup`)
    if (ctx.opts.directives && c === 58 /* : */) {
      const dir = tryParseInlineDirective(src, i, rangeEnd);
      if (dir) {
        const children =
          dir.labelStart >= 0 && dir.labelEnd >= dir.labelStart
            ? parseInlineRange(ctx, buf, dir.labelStart, dir.labelEnd, inTableCell, insideLink)
            : [];
        const labelText =
          dir.labelStart >= 0 && dir.labelEnd >= dir.labelStart
            ? src.slice(dir.labelStart, dir.labelEnd)
            : "";
        nodes.push({
          type: "directive",
          kind: "text",
          name: dir.name,
          label: labelText,
          attributes: dir.attributes,
          children,
          position: pos(i, dir.end),
        });
        i = dir.end;
        continue;
      }
    }

    // 6. Angle autolinks & inline HTML (`<...>`)
    if (c === 60 /* < */) {
      const end = findInlineHtmlOrAutolinkEnd(src, i, rangeEnd);
      if (end > 0) {
        const raw = src.slice(i, end);
        const inner = raw.slice(1, -1);
        if (/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*$/.test(inner)) {
          nodes.push({
            type: "link",
            url: inner,
            autolink: true,
            children: [{ type: "text", value: inner, position: pos(i + 1, end - 1) }],
            position: pos(i, end),
          });
          i = end;
          continue;
        }
        if (/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/.test(inner)) {
          nodes.push({
            type: "link",
            url: `mailto:${inner}`,
            autolink: true,
            children: [{ type: "text", value: inner, position: pos(i + 1, end - 1) }],
            position: pos(i, end),
          });
          i = end;
          continue;
        }
        nodes.push({ type: "html", value: raw, block: false, position: pos(i, end) });
        i = end;
        continue;
      }
      pushText("<", i, i + 1);
      i++;
      continue;
    }

    // 7. HTML character reference (`&...;`)
    if (c === 38 /* & */) {
      const semi = src.indexOf(";", i + 2);
      if (semi > i + 1 && semi < rangeEnd && semi - i <= 34) {
        const rawRef = src.slice(i, semi + 1);
        const decoded = decodeHtmlEntities(rawRef, { strict: true });
        if (decoded !== rawRef) {
          pushText(decoded, i, semi + 1);
          i = semi + 1;
          continue;
        }
      }
      pushText("&", i, i + 1);
      i++;
      continue;
    }

    // 8. GFM bare URLs (`http://`, `https://`, `www.`) and bare emails
    if (ctx.opts.gfm && !insideLink) {
      const autolink = tryParseBareAutolink(
        src,
        i,
        rangeStart,
        rangeEnd,
        ctx.opts.autolinkBoundaries,
        hasOpenDelim,
      );
      if (autolink) {
        nodes.push({
          type: "link",
          url: autolink.url,
          autolink: true,
          children: [{ type: "text", value: autolink.label, position: pos(i, autolink.end) }],
          position: pos(i, autolink.end),
        });
        i = autolink.end;
        continue;
      }
    }

    // 9. Image opener `![` or Link opener `[` (or GFM footnote reference `[^label]`)
    if (c === 33 /* ! */ && i + 1 < rangeEnd && src.charCodeAt(i + 1) === 91 /* [ */) {
      const nodeIndex = nodes.length;
      nodes.push({ type: "text", value: "![", position: pos(i, i + 2) });
      delimNodeIndices.add(nodeIndex);
      brackets.push({ image: true, nodeIndex, offset: i, delimIndex: delims.length, active: true });
      i += 2;
      continue;
    }

    if (c === 91 /* [ */) {
      // Check GFM footnote reference `[^label]`
      if (ctx.opts.gfm && i + 2 < rangeEnd && src.charCodeAt(i + 1) === 94 /* ^ */) {
        let p = i + 2;
        while (p < rangeEnd) {
          const ch = src.charCodeAt(p);
          if (ch === 93 || isSpace(ch) || isEol(ch)) break;
          p++;
        }
        if (p > i + 2 && p < rangeEnd && src.charCodeAt(p) === 93) {
          const label = src.slice(i + 2, p);
          const id = normalizeLabel(label);
          if (ctx.footnotes.has(id)) {
            nodes.push({
              type: "footnoteReference",
              identifier: id,
              label,
              position: pos(i, p + 1),
            });
            i = p + 1;
            continue;
          }
        }
      }
      const nodeIndex = nodes.length;
      nodes.push({ type: "text", value: "[", position: pos(i, i + 1) });
      delimNodeIndices.add(nodeIndex);
      brackets.push({ image: false, nodeIndex, offset: i, delimIndex: delims.length, active: true });
      i++;
      continue;
    }

    // 10. Closing bracket `]`
    if (c === 93 /* ] */) {
      const handled = handleClosingBracket(
        ctx,
        buf,
        nodes,
        delims,
        brackets,
        delimNodeIndices,
        i,
        rangeEnd,
        keepWinDest,
      );
      if (handled !== null) {
        i = handled;
        continue;
      }
      pushText("]", i, i + 1);
      i++;
      continue;
    }

    // 11. Emphasis / Strikethrough delimiters (`*`, `_`, `~`)
    if (c === 42 /* * */ || c === 95 /* _ */ || (ctx.opts.gfm && c === 126 /* ~ */)) {
      const ch = src[i]!;
      let runEnd = i + 1;
      while (runEnd < rangeEnd && src.charCodeAt(runEnd) === c) runEnd++;
      const count = runEnd - i;

      if (c === 126 && (count > 2 || (count === 1 && !ctx.opts.singleTilde))) {
        pushText(src.slice(i, runEnd), i, runEnd);
        i = runEnd;
        continue;
      }

      const beforeCh = i > rangeStart ? prevChar(src, i) : "";
      const afterCh = runEnd < rangeEnd ? nextChar(src, runEnd) : "";
      const beforeSpace = isUnicodeSpace(beforeCh);
      const afterSpace = isUnicodeSpace(afterCh);
      const beforePunct = isUnicodePunct(beforeCh);
      const afterPunct = isUnicodePunct(afterCh);

      const leftFlanking = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
      const rightFlanking = !beforeSpace && (!beforePunct || afterSpace || afterPunct);

      let canOpen: boolean;
      let canClose: boolean;
      if (c === 95 /* _ */) {
        canOpen = leftFlanking && (!rightFlanking || beforePunct);
        canClose = rightFlanking && (!leftFlanking || afterPunct);
      } else {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      }

      const nodeIndex = nodes.length;
      nodes.push({ type: "text", value: src.slice(i, runEnd), position: pos(i, runEnd) });
      delimNodeIndices.add(nodeIndex);
      if (canOpen || canClose) {
        delims.push({
          ch,
          count,
          origCount: count,
          nodeIndex,
          canOpen,
          canClose,
          active: true,
        });
      }
      i = runEnd;
      continue;
    }

    // 12. Fast scan for plain text until next special character
    const textStart = i;
    i++;
    while (i < rangeEnd) {
      const ch = src.charCodeAt(i);
      if (
        ch === 10 ||
        ch === 92 ||
        ch === 96 ||
        ch === 42 ||
        ch === 95 ||
        ch === 126 ||
        ch === 91 ||
        ch === 93 ||
        ch === 33 ||
        ch === 60 ||
        ch === 38 ||
        ch === 36 ||
        ch === 58 ||
        // Bare URL/email triggers
        (ctx.opts.gfm &&
          !insideLink &&
          (ch === 104 /* h */ ||
            ch === 72 /* H */ ||
            ch === 119 /* w */ ||
            ch === 87 /* W */ ||
            ch === 64 /* @ */))
      ) {
        // For email `@`, backtrack only if needed — instead, handle bare email right at word start!
        if (ch === 64) {
          // Check if the current plain text run ends with a valid email local-part!
          const emailMatch = tryParseBareEmailBacktrack(src, textStart, i, rangeEnd);
          if (emailMatch) {
            if (emailMatch.start > textStart) {
              pushText(src.slice(textStart, emailMatch.start), textStart, emailMatch.start);
            }
            nodes.push({
              type: "link",
              url: `mailto:${emailMatch.address}`,
              autolink: true,
              children: [
                {
                  type: "text",
                  value: emailMatch.address,
                  position: pos(emailMatch.start, emailMatch.end),
                },
              ],
              position: pos(emailMatch.start, emailMatch.end),
            });
            i = emailMatch.end;
            break;
          }
          i++;
          continue;
        }
        // Only break on h/H/w/W if it actually starts http(s):// or www.
        if (ch === 104 || ch === 72 || ch === 119 || ch === 87) {
          if (startsBareUrl(src, i, rangeStart, rangeEnd)) break;
          i++;
          continue;
        }
        break;
      }
      i++;
    }
    if (i > textStart && !(nodes.at(-1)?.type === "link" && nodes.at(-1)!.position?.end.offset === buf.origOffset(i))) {
      pushText(src.slice(textStart, i), textStart, i);
    }
  }

  processEmphasis(nodes, delims, 0);
  return compactNodes(nodes);
}

function makeInlineMathNode(tex: string, display: boolean, position: SourcePosition): MdInlineMath {
  return {
    type: "inlineMath",
    value: tex,
    display,
    data: {
      hProperties: {
        className: ["language-math", display ? "math-display" : "math-inline"],
      },
    },
    position,
  };
}

function isInWindowsProsePath(nodes: MdNode[]): boolean {
  const prev = nodes.at(-1);
  if (prev?.type !== "text") return false;
  const text = prev.value;
  const lastSpace = text.search(/\s[^\s]*$/);
  const word = lastSpace >= 0 ? text.slice(lastSpace + 1) : text;
  return UNFINISHED_DRIVE_PATH.test(word);
}

function prevChar(src: string, idx: number): string {
  const c = src.charCodeAt(idx - 1);
  if (c >= 0xdc00 && c <= 0xdfff && idx >= 2) return src.slice(idx - 2, idx);
  return src[idx - 1]!;
}

function nextChar(src: string, idx: number): string {
  const c = src.charCodeAt(idx);
  if (c >= 0xd800 && c <= 0xdbff && idx + 1 < src.length) return src.slice(idx, idx + 2);
  return src[idx]!;
}

function startsBareUrl(src: string, i: number, rangeStart: number, rangeEnd: number): boolean {
  if (i > rangeStart) {
    const prev = prevChar(src, i);
    const pc = prev.charCodeAt(0);
    // Allowed before bare URL: start, whitespace, `(`, `*`, `_`, `~`, or non-ASCII (e.g. CJK punctuation/text)
    if (pc < 128 && !isSpace(pc) && !isEol(pc) && pc !== 40 && pc !== 42 && pc !== 95 && pc !== 126) {
      return false;
    }
  }
  const rest = src.slice(i, Math.min(i + 8, rangeEnd)).toLowerCase();
  return rest.startsWith("http://") || rest.startsWith("https://") || rest.startsWith("www.");
}

function tryParseBareAutolink(
  src: string,
  start: number,
  rangeStart: number,
  rangeEnd: number,
  autolinkBoundaries: boolean,
  hasOpenDelim: (ch: string) => boolean,
): { url: string; label: string; end: number } | null {
  if (!startsBareUrl(src, start, rangeStart, rangeEnd)) return null;
  const prefix = src.slice(start, Math.min(start + 8, rangeEnd)).toLowerCase();
  const isWww = prefix.startsWith("www.");
  const domainStart = isWww ? start + 4 : start + (prefix.startsWith("https://") ? 8 : 7);
  if (domainStart >= rangeEnd) return null;

  let pos = domainStart;
  let sawNonAscii = false;

  while (pos < rangeEnd) {
    const ch = src[pos]!;
    const c = ch.charCodeAt(0);
    if (c <= 32 || c === 60 || c === 62) break;
    // T3 Code CJK/Arabic script punctuation boundary: if URL is ASCII so far and hits script punctuation, stop!
    if (autolinkBoundaries && c >= 128) {
      if (!sawNonAscii && isScriptPunctuation(ch)) break;
      sawNonAscii = true;
    }
    pos++;
  }

  let end = pos;

  // Trim GFM trailing punctuation, balancing parentheses and respecting open emphasis/strikethrough delimiters!
  while (end > domainStart) {
    const ch = src[end - 1]!;
    if ("?!.,:*'\"]".includes(ch)) {
      end--;
      continue;
    }
    if (ch === "_") {
      if (hasOpenDelim("_")) {
        end--;
        continue;
      }
      break;
    }
    if (ch === "~") {
      if (hasOpenDelim("~")) {
        end--;
        continue;
      }
      break;
    }
    if (ch === ")") {
      let opens = 0;
      let closes = 0;
      for (let k = start; k < end; k++) {
        if (src.charCodeAt(k) === 40) opens++;
        else if (src.charCodeAt(k) === 41) closes++;
      }
      if (closes > opens) {
        end--;
        continue;
      }
      break;
    }
    if (ch === ";") {
      const amp = src.lastIndexOf("&", end - 2);
      if (amp >= start && /^&(?:#\d+|#x[0-9a-f]+|[a-zA-Z][a-zA-Z0-9]*);$/i.test(src.slice(amp, end))) {
        end--;
        continue;
      }
      end--;
      continue;
    }
    break;
  }

  if (end <= domainStart) return null;

  // Validate domain portion after trimming trailing punctuation/emphasis markers
  const firstSlash = src.indexOf("/", domainStart);
  const firstQuery = src.indexOf("?", domainStart);
  const firstHash = src.indexOf("#", domainStart);
  let hostEnd = end;
  if (firstSlash >= 0 && firstSlash < hostEnd) hostEnd = firstSlash;
  if (firstQuery >= 0 && firstQuery < hostEnd) hostEnd = firstQuery;
  if (firstHash >= 0 && firstHash < hostEnd) hostEnd = firstHash;
  const host = src.slice(domainStart, hostEnd);
  if (host.length === 0) return null;
  if (isWww && !host.includes(".")) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(host) || host.startsWith(".") || host.endsWith("..")) return null;
  if (!host.includes(".") && !/^localhost(?::\d+)?$/i.test(host)) return null;

  const label = src.slice(start, end);
  return {
    url: isWww ? `http://${label}` : label,
    label,
    end,
  };
}

function tryParseBareEmailBacktrack(
  src: string,
  textStart: number,
  atIdx: number,
  rangeEnd: number,
): { start: number; end: number; address: string } | null {
  let localStart = atIdx;
  while (localStart > textStart) {
    const c = src.charCodeAt(localStart - 1);
    if (isAlphaNum(c) || c === 46 || c === 45 || c === 95 || c === 43) {
      localStart--;
    } else {
      break;
    }
  }
  if (localStart === atIdx) return null;
  if (localStart > textStart) {
    const prev = prevChar(src, localStart);
    const pc = prev.charCodeAt(0);
    if (pc < 128 && !isSpace(pc) && !isEol(pc) && pc !== 40 && pc !== 42 && pc !== 95 && pc !== 126) {
      return null;
    }
  }
  let end = atIdx + 1;
  while (end < rangeEnd) {
    const c = src.charCodeAt(end);
    if (isAlphaNum(c) || c === 46 || c === 45 || c === 95) end++;
    else break;
  }
  while (end > atIdx + 1 && src.charCodeAt(end - 1) === 46) end--;
  // Per GFM spec: email cannot end in `-` or `_`
  if (end <= atIdx + 1) return null;
  const last = src.charCodeAt(end - 1);
  if (last === 45 || last === 95) return null;
  const domain = src.slice(atIdx + 1, end);
  if (!domain.includes(".") || domain.startsWith(".") || domain.includes("..")) return null;
  const address = src.slice(localStart, end);
  return { start: localStart, end, address };
}

function handleClosingBracket(
  ctx: ParserContext,
  buf: InlineBuffer,
  nodes: MdNode[],
  delims: Delimiter[],
  brackets: Bracket[],
  delimNodeIndices: Set<number>,
  closeIdx: number,
  rangeEnd: number,
  keepWinDest: boolean,
): number | null {
  const opener = brackets.pop();
  if (!opener) return null;
  if (!opener.active) return null;

  const src = buf.text;
  let url: string | undefined;
  let title: string | null = null;
  let refId: string | undefined;
  let refLabel: string | undefined;
  let afterPos = closeIdx + 1;
  let isReference = false;

  // 1. Inline link `[text](dest "title")`
  if (closeIdx + 1 < rangeEnd && src.charCodeAt(closeIdx + 1) === 40 /* ( */) {
    const parsed = parseLinkDestinationInline(src, closeIdx + 2, rangeEnd, keepWinDest);
    if (parsed) {
      url = parsed.url;
      title = parsed.title;
      afterPos = parsed.afterPos;
    }
  }

  // 2. Reference link `[text][ref]`, `[text][]`, or shortcut `[text]`
  if (url === undefined) {
    let refText: string | undefined;
    let nextPos = closeIdx + 1;
    if (closeIdx + 1 < rangeEnd && src.charCodeAt(closeIdx + 1) === 91 /* [ */) {
      let p = closeIdx + 2;
      let valid = true;
      while (p < rangeEnd && src.charCodeAt(p) !== 93) {
        if (src.charCodeAt(p) === 92 && p + 1 < rangeEnd) p += 2;
        else if (src.charCodeAt(p) === 91) {
          valid = false;
          break;
        } else p++;
      }
      if (valid && p < rangeEnd && src.charCodeAt(p) === 93) {
        refText = src.slice(closeIdx + 2, p);
        nextPos = p + 1;
      }
    }
    const labelRaw = refText && refText.length > 0 ? refText : src.slice(opener.offset + (opener.image ? 2 : 1), closeIdx);
    const id = normalizeLabel(labelRaw);
    const def = id ? ctx.definitions.get(id) : undefined;
    if (def) {
      url = def.url;
      title = def.title ?? null;
      refId = def.identifier;
      refLabel = labelRaw;
      afterPos = nextPos;
      isReference = true;
    }
  }

  if (url === undefined) return null;

  // Process emphasis inside the bracket range
  processEmphasis(nodes, delims, opener.delimIndex);

  const innerRaw = nodes.slice(opener.nodeIndex + 1);
  const inner = compactNodes(innerRaw);
  const fullPos = ctx.idx.pos(buf.origOffset(opener.offset), buf.origOffset(afterPos));

  let replacement: MdNode;
  if (opener.image) {
    const alt = plainTextOf(inner);
    replacement = isReference && refId !== undefined
      ? {
          type: "imageReference",
          identifier: refId,
          label: refLabel ?? alt,
          alt,
          position: fullPos,
        }
      : {
          type: "image",
          url,
          alt,
          ...(title !== null ? { title } : {}),
          position: fullPos,
        };
  } else {
    // Deactivate earlier link openers (no nested links)
    for (const b of brackets) {
      if (!b.image) b.active = false;
    }
    replacement = {
      type: "link",
      url,
      ...(title !== null ? { title } : {}),
      children: inner,
      position: fullPos,
    };
  }

  // Replace opener and inner nodes with the new link/image node
  nodes.length = opener.nodeIndex;
  delimNodeIndices.delete(opener.nodeIndex);
  nodes.push(replacement);
  delims.length = opener.delimIndex;
  return afterPos;
}

function processEmphasis(nodes: MdNode[], delims: Delimiter[], stackBottom: number): void {
  const openersBottom: Record<string, number> = {};

  for (let closerIdx = stackBottom; closerIdx < delims.length; closerIdx++) {
    const closer = delims[closerIdx]!;
    if (!closer.active || !closer.canClose || closer.count === 0) continue;

    const key = `${closer.ch}:${closer.origCount % 3}:${closer.canOpen ? 1 : 0}`;
    const bottom = Math.max(stackBottom, openersBottom[key] ?? stackBottom);
    let openerIdx = closerIdx - 1;
    let found = false;

    while (openerIdx >= bottom) {
      const opener = delims[openerIdx]!;
      if (opener.active && opener.canOpen && opener.ch === closer.ch && opener.count > 0) {
        // CommonMark rule of 3
        const oddMatch =
          (closer.canOpen || opener.canClose) &&
          closer.origCount % 3 !== 0 &&
          (opener.origCount + closer.origCount) % 3 === 0;
        const tildeMismatch = closer.ch === "~" && opener.count !== closer.count;
        if (!oddMatch && !tildeMismatch) {
          found = true;
          break;
        }
      }
      openerIdx--;
    }

    if (!found) {
      openersBottom[key] = closerIdx;
      if (!closer.canOpen) closer.active = false;
      continue;
    }

    const opener = delims[openerIdx]!;
    const useCount =
      closer.ch === "~"
        ? opener.count
        : opener.count >= 2 && closer.count >= 2
          ? 2
          : 1;

    opener.count -= useCount;
    closer.count -= useCount;

    const openerText = nodes[opener.nodeIndex] as MdText;
    const closerText = nodes[closer.nodeIndex] as MdText;
    openerText.value = openerText.value.slice(0, openerText.value.length - useCount);
    closerText.value = closerText.value.slice(useCount);

    // Collect children between opener and closer
    const innerNodes: MdNode[] = [];
    for (let k = opener.nodeIndex + 1; k < closer.nodeIndex; k++) {
      const n = nodes[k];
      if (n && (n.type !== "text" || n.value !== "")) innerNodes.push(n);
      nodes[k] = { type: "text", value: "" };
    }

    const wrapped: MdNode =
      closer.ch === "~"
        ? { type: "delete", children: compactNodes(innerNodes) }
        : useCount === 2
          ? { type: "strong", children: compactNodes(innerNodes) }
          : { type: "emphasis", children: compactNodes(innerNodes) };

    if (openerText.position && closerText.position) {
      (wrapped as { position?: SourcePosition }).position = {
        start: {
          ...openerText.position.start,
          column: openerText.position.start.column + opener.count,
          offset: openerText.position.start.offset + opener.count,
        },
        end: {
          ...closerText.position.end,
          column: closerText.position.end.column - closer.count,
          offset: closerText.position.end.offset - closer.count,
        },
      };
    }

    // Place wrapped node right after opener (slot opener.nodeIndex + 1 if available)
    if (opener.nodeIndex + 1 < closer.nodeIndex) {
      nodes[opener.nodeIndex + 1] = wrapped;
    } else {
      // Empty emphasis — shouldn't happen in valid cases, insert safely
      nodes.splice(closer.nodeIndex, 0, wrapped);
      for (const d of delims) {
        if (d.nodeIndex >= closer.nodeIndex) (d as { nodeIndex: number }).nodeIndex++;
      }
    }

    // Deactivate delimiters between opener and closer
    for (let d = openerIdx + 1; d < closerIdx; d++) {
      delims[d]!.active = false;
    }

    if (closer.count > 0) closerIdx--;
  }
}

function compactNodes(nodes: MdNode[]): MdNode[] {
  const out: MdNode[] = [];
  for (const n of nodes) {
    if (n.type === "text") {
      if (n.value === "") continue;
      const prev = out.at(-1);
      if (prev?.type === "text") {
        prev.value += n.value;
        if (prev.position && n.position) {
          (prev as { position: SourcePosition }).position = {
            start: prev.position.start,
            end: n.position.end,
          };
        }
        continue;
      }
    }
    out.push(n);
  }
  return out;
}

export function plainTextOf(nodes: readonly MdNode[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text" || n.type === "inlineCode" || n.type === "code") out += n.value;
    else if (n.type === "image" || n.type === "imageReference") out += n.alt;
    else if (n.type === "break") out += "\n";
    else if ("children" in n) out += plainTextOf(n.children);
  }
  return out;
}

// --- Post-inline pass: GitHub alerts ---

function applyGithubAlerts(nodes: MdNode[]): void {
  for (const node of nodes) {
    if ("children" in node && Array.isArray(node.children)) {
      applyGithubAlerts(node.children);
    }
    if (node.type !== "blockquote" || node.alert !== undefined) continue;
    const firstBlock = node.children[0];
    if (firstBlock?.type !== "paragraph") continue;
    const firstInline = firstBlock.children[0];
    if (firstInline?.type !== "text") continue;
    const match = GITHUB_ALERT_MARKER.exec(firstInline.value);
    if (!match?.[1]) continue;

    const remainder = firstInline.value.slice(match[0].length);
    const markerEndsLine = match[0].endsWith("\n");
    if (remainder.length > 0) {
      firstInline.value = remainder;
    } else if (markerEndsLine || firstBlock.children.length === 1) {
      firstBlock.children.shift();
      if (firstBlock.children.length === 0) {
        node.children.shift();
      }
    } else {
      continue;
    }
    node.alert = match[1].toLowerCase();
  }
}

// --- Public entry point ---

const DEFAULT_PARSE_OPTIONS: Required<ParseOptions> = {
  gfm: true,
  singleTilde: true,
  math: false,
  directives: false,
  insights: false,
  windowsPaths: true,
  windowsProsePathsOnly: false,
  githubAlerts: false,
  normalizeListIndentation: false,
  keepOrderedListNumbers: false,
  leadingWhitespace: false,
  leadingWhitespaceIndent: 0,
  autolinkBoundaries: true,
};

/**
 * Single-pass CommonMark + GFM + Math + Codex Directives + Insights parser producing a compact IR
 * with exact UTF-16 source positions. Zero external dependencies.
 */
export function parseMarkdown(source: string, options?: ParseOptions): MdRoot {
  const opts: Required<ParseOptions> = { ...DEFAULT_PARSE_OPTIONS, ...options };
  const idx = new LineIndex(source);
  const definitions = new Map<string, MdDefinition>();
  const footnotes = new Map<string, MdFootnoteDefinition>();
  const inlineTargets: ParserContext["inlineTargets"] = [];
  const ctx: ParserContext = {
    src: source,
    idx,
    opts,
    definitions,
    footnotes,
    inlineTargets,
  };

  const slices = idx.toSlices();
  const children = parseBlocks(ctx, slices, true);

  for (const target of inlineTargets) {
    target.node.children = parseInlines(ctx, target.slices, target.inTableCell);
  }

  if (opts.githubAlerts) {
    applyGithubAlerts(children);
  }

  return {
    type: "root",
    children,
    definitions,
    footnotes,
    position: idx.pos(0, source.length),
  };
}
