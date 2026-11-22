import {
  type ComposerBlock,
  type ComposerDoc,
  type ComposerEditorState,
  type ComposerInline,
  type ComposerSelection,
  computeFlatBlockSpans,
  inlineAfterOffset,
  inlineBeforeOffset,
  inlineFlatLength,
  inlinesFlatLength,
  inlinesPlainText,
  isChipInline,
  normalizeInlines,
  resolveFlatOffset,
  selectionEmpty,
  selectionFrom,
  selectionTo,
  sliceInlines,
} from "~/components/composer/types";
import { inlineMarkdownUnitMarks, type RichTextMark } from "~/composer-rich-text";
import { caretTakesMarksBefore, serializeEditorDoc, visitRuns } from "~/composer-rich-text-doc";

const ATOM = "\uFFFC";
const DELIMITER = /[*_~`]/;

export interface TextRange { from: number; to: number }
export interface StyledRange extends TextRange {
  escapedOpener: boolean;
  markers: { at: number; closing: boolean; text: string }[];
}
export interface MarkdownSourcePreviewSegment {
  readonly text: string;
  readonly marks: readonly RichTextMark[];
  readonly isMarker: boolean;
  readonly hidden?: boolean;
}

const sameMarks = (l: readonly RichTextMark[] | null, r: readonly RichTextMark[] | null) =>
  l === null || r === null ? l === r : l.length === r.length && l.every((m) => r.includes(m));

function forEachUnitRun(
  units: ReadonlyArray<RichTextMark[] | null>,
  visit: (start: number, end: number, marks: RichTextMark[] | null) => void,
): void {
  for (let s = 0; s < units.length; ) {
    let e = s + 1;
    while (e < units.length && sameMarks(units[e]!, units[s]!)) e += 1;
    visit(s, e, units[s]!);
    s = e;
  }
}

export function touchesRange(sel: ComposerSelection, { from, to }: TextRange): boolean {
  const s = selectionFrom(sel);
  const e = selectionTo(sel);
  return s === e ? s >= from && s <= to : s < to && e > from;
}

export function touchesMarkdownSource(state: ComposerEditorState, from: number, to: number): boolean {
  const s = resolveFlatOffset(state.doc, from);
  if (s.block.kind !== "line") return false;
  if (from < to) {
    if (s.blockIndex !== resolveFlatOffset(state.doc, to).blockIndex) return false;
    return sliceInlines(s.block.inlines, from - s.start, to - s.start).some((i) => i.kind === "text" && i.isMarkdownSource);
  }
  const before = inlineBeforeOffset(s.block.inlines, s.offsetInBlock);
  const after = inlineAfterOffset(s.block.inlines, s.offsetInBlock);
  return Boolean((before?.kind === "text" && before.isMarkdownSource) || (after?.kind === "text" && after.isMarkdownSource));
}

/** Styled ranges never cross blocks, so `within` limits the walk to blocks touching it. */
export function collectStyledRanges(doc: ComposerDoc, within?: TextRange): StyledRange[] {
  const ranges: StyledRange[] = [];
  const map = serializeEditorDoc(doc);
  let range: StyledRange | null = null;
  let openLen = 0;
  visitRuns(map, (run, flat, md) => {
    if (run.nodeName === "codeBlock") return;
    const flatStart = flat + run.flatStart;
    const mdStart = md + run.mdStart;
    if (run.openLen > 0) {
      let slashes = 0;
      while (map.value[mdStart - slashes - 1] === "\\") slashes += 1;
      range ??= { from: flatStart, to: flatStart, escapedOpener: slashes % 2 !== 0, markers: [] };
      range.markers.push({ at: flatStart, closing: false, text: map.value.slice(mdStart, mdStart + run.openLen) });
    }
    if (!range) return;
    range.to = flatStart + run.docLen;
    if (run.closeLen > 0) {
      const end = mdStart + run.mdLen;
      range.markers.push({ at: range.to, closing: true, text: map.value.slice(end - run.closeLen, end) });
    }
    openLen += run.openLen - run.closeLen;
    if (openLen === 0) {
      ranges.push(range);
      range = null;
    }
  }, within?.from, within?.to);
  return ranges;
}

function withAdjacentDelimiters(inlines: readonly ComposerInline[], lineStart: number, region: TextRange): TextRange {
  const lf = region.from - lineStart;
  const lt = region.to - lineStart;
  let { from, to } = region;
  const before = inlineBeforeOffset(inlines, lf);
  if (before?.kind === "text" && before.marks.length === 0 && !before.isMarkdownSource) {
    const pre = inlinesPlainText(sliceInlines(inlines, 0, lf), ATOM);
    let c = 0;
    while (c < pre.length && DELIMITER.test(pre[pre.length - 1 - c]!)) c += 1;
    let slashes = 0;
    while (pre[pre.length - 1 - c - slashes] === "\\") slashes += 1;
    if (c > 0 && slashes % 2 === 1) c -= 1;
    from -= c;
  }
  const after = inlineAfterOffset(inlines, lt);
  if (after?.kind === "text" && after.marks.length === 0 && !after.isMarkdownSource) {
    const suf = inlinesPlainText(sliceInlines(inlines, lt, inlinesFlatLength(inlines)), ATOM);
    let c = 0;
    while (c < suf.length && DELIMITER.test(suf[c]!)) c += 1;
    to += c;
  }
  return { from, to };
}

export function revealsFaithfully(doc: ComposerDoc, range: StyledRange): boolean {
  if (range.escapedOpener) return false;
  const res = resolveFlatOffset(doc, range.from);
  if (res.block.kind !== "line") return false;
  const adj = withAdjacentDelimiters(res.block.inlines, res.start, range);
  if (adj.from !== range.from || adj.to !== range.to) return false;
  const markers = range.markers.toSorted((a, b) => a.at - b.at || Number(b.closing) - Number(a.closing));
  const expected: Array<RichTextMark[] | null> = [];
  let text = "";
  let next = 0;
  const addMarkers = (pos: number) => {
    while (next < markers.length && markers[next]!.at <= pos) {
      const m = markers[next++]!.text;
      text += m;
      expected.push(...m.split("").map(() => null));
    }
  };
  let pos = range.from;
  for (const item of sliceInlines(res.block.inlines, range.from - res.start, range.to - res.start)) {
    const content = item.kind === "text" ? item.text : ATOM;
    const marks = [...(item.marks ?? [])];
    for (let i = 0; i < content.length; i += 1) {
      addMarkers(pos + i);
      text += content[i];
      expected.push(marks);
    }
    pos += content.length;
  }
  addMarkers(range.to);
  const parsed = inlineMarkdownUnitMarks(text);
  return parsed.length === expected.length && parsed.every((m, i) => sameMarks(m, expected[i]!));
}

const sourceFreeBlocks = new WeakSet<ComposerBlock>();

function collectSourceRegions(doc: ComposerDoc) {
  const regions: Array<{ blockIndex: number; lineStart: number; from: number; to: number }> = [];
  for (const span of computeFlatBlockSpans(doc)) {
    if (span.block.kind !== "line" || sourceFreeBlocks.has(span.block)) continue;
    if (!span.block.inlines.some((i) => i.kind === "text" && i.isMarkdownSource)) {
      sourceFreeBlocks.add(span.block);
      continue;
    }
    let pos = span.start;
    let cur: (typeof regions)[number] | null = null;
    for (const item of span.block.inlines) {
      const len = inlineFlatLength(item);
      if (item.kind === "text" && item.isMarkdownSource) {
        if (cur) cur.to = pos + len;
        else regions.push((cur = { blockIndex: span.blockIndex, lineStart: span.start, from: pos, to: pos + len }));
      } else cur = null;
      pos += len;
    }
  }
  return regions;
}

export function collapseShownMarkdownSource(
  state: ComposerEditorState,
  keep: (region: TextRange) => boolean = () => false,
): { readonly doc: ComposerDoc; readonly selection: ComposerSelection; readonly collapsed: boolean } {
  const raw = collectSourceRegions(state.doc);
  if (raw.length === 0) return { doc: state.doc, selection: state.selection, collapsed: false };
  let doc = state.doc;
  const deletions: TextRange[] = [];
  let collapsed = false;
  let caretAtEnd = false;
  const selFrom = selectionFrom(state.selection);

  for (const region of raw.toReversed()) {
    const block = doc.blocks[region.blockIndex]!;
    if (block.kind !== "line") continue;
    const ext = withAdjacentDelimiters(block.inlines, region.lineStart, region);
    const len = inlinesFlatLength(block.inlines);
    const lf = ext.from - region.lineStart;
    const lt = ext.to - region.lineStart;
    if (keep(ext)) {
      if (ext.from !== region.from || ext.to !== region.to) {
        const mid = sliceInlines(block.inlines, lf, lt).map((i) =>
          i.kind === "text" ? { ...i, marks: [] as RichTextMark[], isMarkdownSource: true } : i,
        );
        doc = {
          blocks: doc.blocks.map((b, i) =>
            i === region.blockIndex ? { ...block, inlines: normalizeInlines([...sliceInlines(block.inlines, 0, lf), ...mid, ...sliceInlines(block.inlines, lt, len)]) } : b,
          ),
        };
        collapsed = true;
      }
      continue;
    }
    collapsed = true;
    if (selectionEmpty(state.selection) && ext.to === selFrom) caretAtEnd = true;
    const mid = sliceInlines(block.inlines, lf, lt);
    const units = inlineMarkdownUnitMarks(inlinesPlainText(mid, ATOM));
    const rebuilt: ComposerInline[] = [];
    let u = 0;
    for (const item of mid) {
      if (isChipInline(item)) {
        const m = units[u];
        if (m !== null) {
          if (m?.length) rebuilt.push({ ...item, marks: m });
          else {
            const { marks: _dropped, ...rest } = item;
            rebuilt.push(rest);
          }
        }
        else deletions.push({ from: ext.from + u, to: ext.from + u + 1 });
        u += 1;
      } else {
        forEachUnitRun(units.slice(u, u + item.text.length), (s, e, m) => {
          if (m === null) deletions.push({ from: ext.from + u + s, to: ext.from + u + e });
          else rebuilt.push({ kind: "text", text: item.text.slice(s, e), marks: m });
        });
        u += item.text.length;
      }
    }
    doc = {
      blocks: doc.blocks.map((b, i) =>
        i === region.blockIndex
          ? { ...block, inlines: normalizeInlines([...sliceInlines(block.inlines, 0, lf), ...rebuilt, ...sliceInlines(block.inlines, lt, len)]) }
          : b,
      ),
    };
  }

  if (!collapsed) return { doc: state.doc, selection: state.selection, collapsed: false };
  const mapOff = (o: number) =>
    Math.max(0, deletions.reduce((n, d) => (d.to <= o ? n - (d.to - d.from) : d.from < o ? n - (o - d.from) : n), o));
  return {
    doc,
    selection: { anchor: mapOff(state.selection.anchor), head: mapOff(state.selection.head), ...(caretAtEnd ? { storedMarks: [] } : {}) },
    collapsed: true,
  };
}

export function normalizeMarkdownSource(state: ComposerEditorState, typed: boolean): ComposerEditorState | null {
  const col = collapseShownMarkdownSource(state, (r) => touchesRange(state.selection, r));
  let { doc, selection } = col;
  let changed = col.collapsed;
  const ranges = collectStyledRanges(doc, { from: selectionFrom(selection), to: selectionTo(selection) }).filter((r) => touchesRange(selection, r) && revealsFaithfully(doc, r));
  if (ranges.length === 0) return changed ? { doc, selection } : null;

  const takesBefore = caretTakesMarksBefore({ doc, selection });
  const insertions: { at: number; length: number; closing: boolean }[] = [];

  for (const range of ranges.toReversed()) {
    const res = resolveFlatOffset(doc, range.from);
    if (res.block.kind !== "line") continue;
    const mid = sliceInlines(res.block.inlines, range.from - res.start, range.to - res.start);
    const markers = range.markers.toSorted((a, b) => a.at - b.at || Number(b.closing) - Number(a.closing));
    const src: ComposerInline[] = [];
    let mi = 0;
    const flush = (pos: number) => {
      while (mi < markers.length && markers[mi]!.at <= pos) {
        const m = markers[mi++]!;
        src.push({ kind: "text", text: m.text, marks: [], isMarkdownSource: true });
        insertions.push({ at: m.at, length: m.text.length, closing: m.closing });
      }
    };
    let pos = range.from;
    for (const item of mid) {
      if (isChipInline(item)) {
        flush(pos);
        const { marks: _dropped, ...rest } = item;
        src.push(rest);
        pos += 1;
      } else {
        for (let i = 0; i < item.text.length; i += 1) {
          flush(pos + i);
          src.push({ kind: "text", text: item.text[i]!, marks: [], isMarkdownSource: true });
        }
        pos += item.text.length;
      }
    }
    flush(range.to);
    const len = inlinesFlatLength(res.block.inlines);
    const nextInlines = normalizeInlines([
      ...sliceInlines(res.block.inlines, 0, range.from - res.start),
      ...src,
      ...sliceInlines(res.block.inlines, range.to - res.start, len),
    ]);
    doc = { blocks: doc.blocks.map((b, i) => (i === res.blockIndex ? { ...res.block, inlines: nextInlines } : b)) };
    changed = true;
  }

  const mapPos = (pos: number) => {
    let next = pos;
    for (const { at, length, closing } of insertions) {
      const inside = typed && selectionEmpty(selection) && (closing ? takesBefore : !takesBefore);
      if (at < pos || (at === pos && closing !== inside)) next += length;
    }
    return next;
  };
  return changed ? { doc, selection: { anchor: mapPos(selection.anchor), head: mapPos(selection.head) } } : null;
}

export function previewMarkdownSourceSpans(text: string, hideDelimiters = false): MarkdownSourcePreviewSegment[] {
  const segments: MarkdownSourcePreviewSegment[] = [];
  forEachUnitRun(inlineMarkdownUnitMarks(text), (s, e, marks) => {
    segments.push(
      marks === null
        ? { text: text.slice(s, e), marks: [], isMarker: true, hidden: hideDelimiters }
        : { text: text.slice(s, e), marks, isMarker: false },
    );
  });
  return segments;
}
