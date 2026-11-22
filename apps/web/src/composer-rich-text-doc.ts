import { composerMathRanges } from "@t3tools/shared/composerInlineTokens";

import {
  type ComposerBlock,
  type ComposerChip,
  type ComposerDoc,
  type ComposerEditResult,
  type ComposerEditorState,
  type ComposerInline,
  type LinePrefix,
  MARK_ORDER,
  collapsedSelection,
  computeFlatBlockSpans,
  deriveFlatBlockSpans,
  inlineAfterOffset,
  inlineBeforeOffset,
  inlineFlatLength,
  isChipInline,
  isListPrefix,
  isPlainParagraph,
  isTrailingEmptyParagraphAfterRule,
  normalizeInlines,
  readChipSource,
  resolveFlatOffset,
  sameMarkSet,
  selectionEmpty,
  selectionFrom,
  selectionTo,
  sliceInlines,
  sortMarks,
} from "~/components/composer/types";
import { splitPromptIntoComposerSegments } from "~/composer-editor-mentions";
import {
  listIndentForTab,
  listOutdentForTab,
  nextOrderedMarkerText,
} from "~/composer-list-continuation";
import { parseInlineMarkdown, RICH_TEXT_DELIMITERS, type RichTextMark } from "~/composer-rich-text";
import { collectInlineContextIds } from "~/lib/composerContextReferences";
import { markdownMathRanges } from "~/markdown/wordsHast";

export type SkillMeta = { label: string; description: string | null };
export type IsKnownModel = (instanceId: string, model: string) => boolean;

interface ChipResolver {
  skill: (name: string) => SkillMeta | null;
  model: IsKnownModel;
}

const NO_MODELS: IsKnownModel = () => false;
const randomCiteKey = () => `cite-${Math.random().toString(36).slice(2)}`;

export function parseOpeningFence(line: string): { fence: string; language: string } | null {
  const match = /^(`{3,}|~{3,})([^\n]*)$/.exec(line);
  if (!match) return null;
  const [, fence, language] = match;
  if (fence!.startsWith("`") && language!.includes("`")) return null;
  return { fence: fence!, language: language! };
}

export function isClosingFence(line: string, fence: string): boolean {
  const match = /^(`{3,}|~{3,})[ \t]*\r?$/.exec(line);
  return match !== null && match[1]![0] === fence[0] && match[1]!.length >= fence.length;
}

function parseListPrefix(
  line: string,
): {
  prefix: Extract<LinePrefix, { kind: "bullet" | "ordered" | "task" }>;
  markerLength: number;
} | null {
  const task = /^([ \t]*)-([ \t]+)\[([ xX])\]([ \t]*)/.exec(line);
  if (task && (line.length === task[0].length || task[4])) {
    return {
      prefix: {
        kind: "task",
        indent: task[1]!,
        checked: task[3]!.toLowerCase() === "x",
        markerSpace: task[2]!,
        contentSpace: task[4]!,
      },
      markerLength: task[0].length,
    };
  }
  const ordered = /^([ \t]*)(\d+[.)])((?:[ \t]+)|$)/.exec(line);
  if (ordered) {
    return {
      prefix: { kind: "ordered", indent: ordered[1]!, marker: ordered[2]!, space: ordered[3]! },
      markerLength: ordered[0].length,
    };
  }
  const bullet = /^([ \t]*)([-*+])((?:[ \t]+)|$)/.exec(line);
  if (bullet) {
    return {
      prefix: { kind: "bullet", indent: bullet[1]!, marker: bullet[2]!, space: bullet[3]! },
      markerLength: bullet[0].length,
    };
  }
  return null;
}

function chipForSegment(
  segment: Exclude<ReturnType<typeof splitPromptIntoComposerSegments>[number], { type: "text" }>,
  chips: ChipResolver,
): ComposerChip | null {
  if (segment.type === "mention")
    return { kind: "composer-mention", path: segment.path, source: segment.source };
  if (segment.type === "skill") {
    const meta = chips.skill(segment.name);
    return meta
      ? {
          kind: "composer-skill",
          skillName: segment.name,
          skillLabel: meta.label,
          skillDescription: meta.description,
        }
      : null;
  }
  if (segment.type === "model") {
    return chips.model(segment.instanceId, segment.model)
      ? {
          kind: "composer-model",
          instanceId: segment.instanceId,
          model: segment.model,
          source: segment.source,
        }
      : null;
  }
  if (segment.type === "citation") {
    return {
      kind: "composer-citation",
      citation: segment.citation,
      source: segment.source,
      citeKey: randomCiteKey(),
    };
  }
  return {
    kind: "composer-context-reference",
    refKind: segment.kind,
    contextId: segment.contextId,
    label: segment.label,
    source: segment.source,
  };
}

/** Keeps literalLength leading characters unstyled so path queries reach file search unchanged. */
export function buildComposerBlocks(
  value: string,
  skillLabelFor: (name: string) => SkillMeta | null,
  options?: {
    styling?: boolean;
    blocks?: boolean;
    literalText?: boolean;
    literalLength?: number;
    isKnownModel?: IsKnownModel;
  },
): ComposerBlock[] {
  if (options?.literalText) {
    return value.split("\n").map((line) => ({
      kind: "line",
      prefix: null,
      inlines: line ? [{ kind: "text", text: line, marks: [] }] : [],
    }));
  }
  const chips: ChipResolver = { skill: skillLabelFor, model: options?.isKnownModel ?? NO_MODELS };
  const styling = options?.styling ?? true;
  const blockSyntax = styling && (options?.blocks ?? true);

  let sentinel = "\uFFFC";
  for (let cp = 0xe000; value.includes(sentinel); cp += 1) sentinel = String.fromCodePoint(cp);

  const atoms: ComposerInline[] = [];
  const atomSources: string[] = [];
  const literal = value.slice(0, options?.literalLength ?? 0);
  const remainder = value.slice(literal.length);
  const formulas = composerMathRanges(remainder, markdownMathRanges);
  let cursor = 0;
  let masked = "";
  const pushChunk = (slice: string) => {
    for (const seg of splitPromptIntoComposerSegments(slice)) {
      if (seg.type === "text") {
        masked += seg.text;
      } else {
        const chip = chipForSegment(seg, chips);
        if (!chip) masked += seg.source;
        else {
          atoms.push(chip);
          atomSources.push(seg.source);
          masked += sentinel;
        }
      }
    }
  };
  for (const f of formulas) {
    pushChunk(remainder.slice(cursor, f.start));
    atoms.push({ kind: "text", text: f.source, marks: [] });
    atomSources.push(f.source);
    masked += sentinel;
    cursor = f.end;
  }
  pushChunk(remainder.slice(cursor));

  let atomIndex = 0;
  const buildInline = (content: string): ComposerInline[] => {
    const spans = styling ? parseInlineMarkdown(content) : [{ text: content, marks: [] }];
    const out: ComposerInline[] = [];
    for (const span of spans) {
      const marks = sortMarks(span.marks);
      span.text.split(sentinel).forEach((piece, idx) => {
        if (idx > 0) {
          const atom = atoms[atomIndex++]!;
          out.push(
            atom.kind === "text" ? { ...atom, marks } : marks.length ? { ...atom, marks } : atom,
          );
        }
        if (piece) out.push({ kind: "text", text: piece, marks });
      });
    }
    return normalizeInlines(out);
  };

  const restoreSources = (line: string) =>
    line
      .split(sentinel)
      .reduce(
        (acc, piece, idx) => (idx === 0 ? piece : acc + atomSources[atomIndex++]! + piece),
        "",
      );

  const sourceLines = masked.split("\n");
  const rawBlocks: ComposerBlock[] = [];
  for (let i = 0; i < sourceLines.length; i += 1) {
    const line = sourceLines[i]!;
    if (i === 0 && literal) {
      rawBlocks.push({
        kind: "line",
        prefix: null,
        inlines: normalizeInlines([
          { kind: "text", text: literal, marks: [] },
          ...buildInline(line),
        ]),
      });
      continue;
    }
    const opening = blockSyntax ? parseOpeningFence(line) : null;
    if (opening) {
      const language = restoreSources(opening.language);
      const body: string[] = [];
      let j = i + 1;
      let close = "";
      while (j < sourceLines.length) {
        if (isClosingFence(sourceLines[j]!, opening.fence)) {
          close = `\n${sourceLines[j]!}`;
          break;
        }
        body.push(restoreSources(sourceLines[j]!));
        j += 1;
      }
      rawBlocks.push({
        kind: "codeBlock",
        language,
        fence: opening.fence,
        close,
        code: body.join("\n"),
      });
      i = j < sourceLines.length ? j : sourceLines.length;
      continue;
    }
    if (blockSyntax && /^([-*_])(?:[ \t]*\1){2,}[ \t]*\r?$/.test(line)) {
      rawBlocks.push({ kind: "horizontalRule", source: line });
      continue;
    }
    const heading = blockSyntax ? /^(#{1,6})([ \t]+)([^\n]*)$/.exec(line) : null;
    if (heading) {
      rawBlocks.push({
        kind: "line",
        prefix: { kind: "heading", level: heading[1]!.length, space: heading[2]! },
        inlines: buildInline(heading[3]!),
      });
      continue;
    }
    const quote = blockSyntax ? /^(>[ \t]*)([^\n]*)$/.exec(line) : null;
    if (quote) {
      rawBlocks.push({
        kind: "line",
        prefix: { kind: "quote", prefix: quote[1]! },
        inlines: buildInline(quote[2]!),
      });
      continue;
    }
    const list = blockSyntax ? parseListPrefix(line) : null;
    if (list) {
      rawBlocks.push({
        kind: "line",
        prefix: list.prefix,
        inlines: buildInline(line.slice(list.markerLength)),
      });
      continue;
    }
    rawBlocks.push({ kind: "line", prefix: null, inlines: buildInline(line) });
  }

  // Strip the single blank-line separator the serializer places between a quote/list and prose.
  const blocks: ComposerBlock[] = [];
  for (let i = 0; i < rawBlocks.length; i += 1) {
    const curr = rawBlocks[i]!;
    const prev = blocks.at(-1);
    const prevIsQuote = prev?.kind === "line" && prev.prefix?.kind === "quote";
    const prevIsList = prev?.kind === "line" && isListPrefix(prev.prefix);
    if ((prevIsQuote || prevIsList) && isPlainParagraph(curr) && curr.inlines.length === 0) {
      let nextIdx = i + 1;
      if (prevIsList) {
        while (
          isPlainParagraph(rawBlocks[nextIdx]) &&
          (rawBlocks[nextIdx] as Extract<ComposerBlock, { kind: "line" }>).inlines.length === 0
        ) {
          nextIdx += 1;
        }
      }
      const after = rawBlocks[nextIdx];
      if (isPlainParagraph(after) && after.inlines.length > 0) continue;
    }
    blocks.push(curr);
  }
  return blocks;
}

export function buildComposerDoc(
  value: string,
  skillLabelFor: (name: string) => SkillMeta | null,
  options?: { styling?: boolean; literalText?: boolean; isKnownModel?: IsKnownModel },
): ComposerDoc {
  const blocks = buildComposerBlocks(value, skillLabelFor, options);
  if (blocks.length === 0) blocks.push({ kind: "line", prefix: null, inlines: [] });
  if (blocks.at(-1)?.kind === "horizontalRule")
    blocks.push({ kind: "line", prefix: null, inlines: [] });
  return { blocks };
}

export interface RichRun {
  kind: "text" | "token" | "break" | "prefix";
  flatStart: number;
  docLen: number;
  mdLen: number;
  openLen: number;
  closeLen: number;
  mdStart: number;
  nodeName?: string;
}

/** A block plus its leading separator, serialized with runs relative to the part start; cached per block object. */
interface RichPart {
  readonly value: string;
  readonly runs: readonly RichRun[];
  readonly flat: number;
  readonly md: number;
  readonly contextIds: readonly string[];
  readonly variant: number;
}

interface RichAcc {
  runs: RichRun[];
  value: string;
  flat: number;
  md: number;
}
const newAcc = (): RichAcc => ({ runs: [], value: "", flat: 0, md: 0 });
const toPart = ({ value, runs, flat, md }: RichAcc, variant: number): RichPart => ({
  value,
  runs,
  flat,
  md,
  variant,
  contextIds: collectInlineContextIds(value),
});

const pushBreak = (acc: RichAcc) => {
  acc.runs.push({
    kind: "break",
    flatStart: acc.flat,
    docLen: 1,
    mdLen: 1,
    openLen: 0,
    closeLen: 0,
    mdStart: acc.md,
  });
  acc.value += "\n";
  acc.flat += 1;
  acc.md += 1;
};

const pushPrefix = (acc: RichAcc, text: string) => {
  acc.runs.push({
    kind: "prefix",
    flatStart: acc.flat,
    docLen: 0,
    mdLen: text.length,
    openLen: 0,
    closeLen: 0,
    mdStart: acc.md,
  });
  acc.value += text;
  acc.md += text.length;
};

function linePrefixText(prefix: LinePrefix, empty: boolean): string {
  if (prefix.kind === "heading") return `${"#".repeat(prefix.level)}${prefix.space}`;
  if (prefix.kind === "quote") return prefix.prefix;
  if (prefix.kind === "task") {
    const cs =
      typeof prefix.contentSpace === "string"
        ? prefix.contentSpace || (empty ? "" : " ")
        : empty
          ? ""
          : " ";
    return `${prefix.indent}-${prefix.markerSpace || " "}[${prefix.checked ? "x" : " "}]${cs}`;
  }
  return `${prefix.indent}${prefix.marker || "-"}${prefix.space || (empty ? "" : " ")}`;
}

function codeBlockSource(block: Extract<ComposerBlock, { kind: "codeBlock" }>, followed: boolean) {
  let fence = block.fence || "```";
  let close = block.close;
  const longest = Math.max(
    0,
    ...block.code
      .split("\n")
      .filter((l) => isClosingFence(l, fence))
      .map((l) => /^[`~]+/.exec(l)![0].length),
  );
  if (longest > 0) {
    fence = fence[0]!.repeat(longest + 1);
    if (close) close = `\n${fence}`;
  }
  if (!close && followed) close = `\n${fence}`;
  return { open: `${fence}${block.language}${block.code ? "\n" : ""}`, content: block.code, close };
}

function pushInlineRun(acc: RichAcc, p: ComposerInline, open: string, close: string): void {
  const isText = p.kind === "text";
  const source = isText ? p.text : readChipSource(p);
  const docLen = isText ? source.length : 1;
  const mdLen = open.length + source.length + close.length;
  const run: RichRun = {
    kind: isText ? "text" : "token",
    flatStart: acc.flat,
    docLen,
    mdLen,
    openLen: open.length,
    closeLen: close.length,
    mdStart: acc.md,
  };
  if (!isText) run.nodeName = p.kind;
  acc.runs.push(run);
  acc.value += open + source + close;
  acc.flat += docLen;
  acc.md += mdLen;
}

function needsBlankLineBetween(blocks: readonly ComposerBlock[], index: number): boolean {
  const prev = blocks[index - 1]!;
  const curr = blocks[index]!;
  if (
    prev.kind === "line" &&
    isListPrefix(prev.prefix) &&
    !(curr.kind === "line" && isListPrefix(curr.prefix))
  ) {
    let next = index;
    while (
      isPlainParagraph(blocks[next]) &&
      (blocks[next] as Extract<ComposerBlock, { kind: "line" }>).inlines.length === 0
    ) {
      next += 1;
    }
    return isPlainParagraph(blocks[next]);
  }
  if (
    prev.kind === "line" &&
    prev.prefix?.kind === "quote" &&
    !(curr.kind === "line" && curr.prefix?.kind === "quote")
  ) {
    return isPlainParagraph(curr) && curr.inlines.length > 0;
  }
  return (
    curr.kind === "horizontalRule" &&
    isPlainParagraph(prev) &&
    prev.inlines.length > 0 &&
    /^-+[ \t]*\r?$/.test(curr.source || "---")
  );
}

const isUnmarked = (i: ComposerInline) =>
  i.kind === "text" ? i.isMarkdownSource || i.marks.length === 0 : !i.marks?.length;

// Unmarked inlines reset all delimiter state, so only the marked islands between them need the full pass.
function appendInlineRuns(inlines: readonly ComposerInline[], acc: RichAcc): void {
  if (inlines.length === 0) {
    acc.runs.push({
      kind: "text",
      flatStart: acc.flat,
      docLen: 0,
      mdLen: 0,
      openLen: 0,
      closeLen: 0,
      mdStart: acc.md,
    });
    return;
  }
  for (let i = 0; i < inlines.length;) {
    if (isUnmarked(inlines[i]!)) {
      pushInlineRun(acc, inlines[i++]!, "", "");
      continue;
    }
    let j = i + 1;
    while (j < inlines.length && !isUnmarked(inlines[j]!)) j += 1;
    const island = markedIsland(inlines, i, j);
    for (const r of island.runs)
      acc.runs.push({
        ...r,
        flatStart: r.flatStart + acc.flat,
        mdStart: r.mdStart + acc.md,
      });
    acc.value += island.value;
    acc.flat += island.flat;
    acc.md += island.md;
    i = j;
  }
}

// Keyed by the island's first inline; edits elsewhere in the line keep these inline objects.
const islandCache = new WeakMap<
  ComposerInline,
  { readonly items: readonly ComposerInline[]; readonly acc: RichAcc }
>();

function markedIsland(inlines: readonly ComposerInline[], from: number, to: number): RichAcc {
  const hit = islandCache.get(inlines[from]!);
  if (
    hit &&
    hit.items.length === to - from &&
    hit.items.every((item, k) => item === inlines[from + k])
  )
    return hit.acc;
  const items = inlines.slice(from, to);
  const acc = newAcc();
  appendMarkedIsland(items, acc);
  islandCache.set(items[0]!, { items, acc });
  return acc;
}

function appendMarkedIsland(inlines: readonly ComposerInline[], acc: RichAcc): void {
  const pieces: ComposerInline[] = [];
  for (const item of inlines) {
    if (
      item.kind !== "text" ||
      item.isMarkdownSource ||
      item.marks.includes("code") ||
      item.marks.length === 0
    ) {
      pieces.push(item);
      continue;
    }
    const start = item.text.length - item.text.trimStart().length;
    const end = Math.max(start, item.text.trimEnd().length);
    let off = 0;
    for (const b of [start, end, item.text.length]) {
      if (b > off) pieces.push({ ...item, text: item.text.slice(off, b) });
      off = b;
    }
  }
  for (const mark of MARK_ORDER) {
    if (mark === "code") continue;
    for (const dir of [1, -1]) {
      let hasContent = false;
      for (let i = dir === 1 ? 0 : pieces.length - 1; i >= 0 && i < pieces.length; i += dir) {
        const p = pieces[i]!;
        const marks = p.marks ?? [];
        if (!marks.includes(mark) || (p.kind === "text" && p.isMarkdownSource)) hasContent = false;
        else if (p.kind === "text" && !marks.includes("code") && /^\s+$/.test(p.text)) {
          if (!hasContent) pieces[i] = { ...p, marks: marks.filter((m) => m !== mark) };
        } else hasContent = true;
      }
    }
  }
  const markEnds = new Map<RichTextMark, number>();
  const ordered: RichTextMark[][] = [];
  for (let i = pieces.length - 1; i >= 0; i -= 1) {
    const p = pieces[i]!;
    const marks = p.kind === "text" && p.isMarkdownSource ? [] : [...(p.marks ?? [])];
    for (const mark of MARK_ORDER) {
      if (!marks.includes(mark)) markEnds.delete(mark);
      else if (!markEnds.has(mark)) markEnds.set(mark, i);
    }
    ordered[i] = marks.sort(
      (a, b) =>
        markEnds.get(b)! - markEnds.get(a)! || MARK_ORDER.indexOf(a) - MARK_ORDER.indexOf(b),
    );
  }
  for (let i = 1; i < ordered.length; i += 1) {
    const marks = ordered[i]!;
    const kept: RichTextMark[] = [];
    for (const m of ordered[i - 1]!) {
      if (!marks.includes(m)) break;
      kept.push(m);
    }
    ordered[i] = [...kept, ...marks.filter((m) => !kept.includes(m))];
  }
  const common = (l: RichTextMark[], r: RichTextMark[]) => {
    let i = 0;
    while (i < l.length && l[i] === r[i]) i += 1;
    return i;
  };
  for (let i = 0; i < pieces.length; i += 1) {
    const p = pieces[i]!;
    const marks = ordered[i]!;
    const open = marks
      .slice(common(marks, ordered[i - 1] ?? []))
      .map((m) => RICH_TEXT_DELIMITERS[m])
      .join("");
    const close = marks
      .slice(common(marks, ordered[i + 1] ?? []))
      .toReversed()
      .map((m) => RICH_TEXT_DELIMITERS[m])
      .join("");
    pushInlineRun(acc, p, open, close);
  }
}

// Variant index: bit 0 = leading break, bit 1 = blank line, bit 2 = code block followed by another block.
const blockParts = new WeakMap<ComposerBlock, RichPart[]>();

function blockPart(block: ComposerBlock, variant: number): RichPart {
  let variants = blockParts.get(block);
  const cached = variants?.[variant];
  if (cached) return cached;
  const part = buildPart(block, variant);
  if (!variants) blockParts.set(block, (variants = []));
  variants[variant] = part;
  return part;
}

function buildPart(block: ComposerBlock, variant: number): RichPart {
  const acc = newAcc();
  if (variant & 1) pushBreak(acc);
  if (variant & 2) pushPrefix(acc, "\n");
  if (block.kind === "codeBlock") {
    const { open, content, close } = codeBlockSource(block, (variant & 4) !== 0);
    const mdLen = open.length + content.length + close.length;
    acc.runs.push({
      kind: "text",
      flatStart: acc.flat,
      docLen: content.length,
      mdLen,
      openLen: open.length,
      closeLen: close.length,
      mdStart: acc.md,
      nodeName: "codeBlock",
    });
    acc.flat += content.length;
    acc.md += mdLen;
    acc.value += open + content + close;
  } else if (block.kind === "horizontalRule") {
    pushPrefix(acc, block.source || "---");
  } else {
    if (block.prefix) pushPrefix(acc, linePrefixText(block.prefix, block.inlines.length === 0));
    appendInlineRuns(block.inlines, acc);
  }
  return toPart(acc, variant);
}

interface PendingLineEdit {
  readonly prev: RichDocMap;
  readonly index: number;
}
// A doc maps to its serialization, or to the single-line edit it can be derived from.
const serializedDocs = new WeakMap<ComposerDoc, RichDocMap | PendingLineEdit>();
const NO_IDS: readonly string[] = [];

/**
 * `doc` with block `index` replaced by `block`, `delta` flat chars longer. A line keeps its prefix kind and stays
 * non-empty (a code block may change freely); that keeps every separator unchanged, so spans and serialization
 * derive from `doc`'s in O(1) amortized.
 */
export function withLineBlock(
  doc: ComposerDoc,
  index: number,
  block: ComposerBlock,
  delta: number,
): ComposerDoc {
  const blocks = doc.blocks.slice();
  blocks[index] = block;
  const next: ComposerDoc = { blocks };
  deriveFlatBlockSpans(doc, next, index, delta);
  const prev = serializedDocs.get(doc);
  if (prev instanceof RichDocMap) serializedDocs.set(next, { prev, index });
  return next;
}

function deriveSerialization(
  doc: ComposerDoc,
  { prev, index }: PendingLineEdit,
): RichDocMap | null {
  const old = prev.parts[index]!;
  // Uncached: the next keystroke replaces this block, and later full passes rebuild it once if needed.
  const part = buildPart(doc.blocks[index]!, old.variant);
  if (old.contextIds.length > 0 || part.contextIds.length > 0) return null;
  const parts = prev.parts.slice();
  parts[index] = part;
  const flats = prev.flats.slice();
  const mds = prev.mds.slice();
  const dFlat = part.flat - old.flat;
  const dMd = part.md - old.md;
  for (let i = index + 1; i < flats.length; i += 1) {
    flats[i]! += dFlat;
    mds[i]! += dMd;
  }
  return new RichDocMap(
    prev.value.slice(0, prev.mds[index]) + part.value + prev.value.slice(prev.mds[index + 1]),
    parts,
    flats,
    mds,
    prev.contextIds,
  );
}

export function serializeEditorDoc(doc: ComposerDoc): RichDocMap {
  const entry = serializedDocs.get(doc);
  if (entry instanceof RichDocMap) return entry;
  const derived = entry && deriveSerialization(doc, entry);
  if (derived) {
    serializedDocs.set(doc, derived);
    return derived;
  }
  const n = doc.blocks.length;
  const parts = new Array<RichPart>(n);
  const flats: number[] = [0];
  const mds: number[] = [0];
  let value = "";
  let ids: string[] | null = null;
  for (let i = 0; i < n; i += 1) {
    const block = doc.blocks[i]!;
    const variant =
      (i > 0 && !isTrailingEmptyParagraphAfterRule(doc, i) ? 1 : 0) |
      (i > 0 && needsBlankLineBetween(doc.blocks, i) ? 2 : 0) |
      (block.kind === "codeBlock" && i < n - 1 ? 4 : 0);
    const part = (parts[i] = blockPart(block, variant));
    value += part.value;
    flats.push(flats[i]! + part.flat);
    mds.push(mds[i]! + part.md);
    if (part.contextIds.length > 0) (ids ??= []).push(...part.contextIds);
  }
  const map = new RichDocMap(
    value,
    parts,
    flats,
    mds,
    ids ? Array.from(new Set<string>(ids)) : NO_IDS,
  );
  serializedDocs.set(doc, map);
  return map;
}

export class RichDocMap {
  readonly value: string;
  readonly contextIds: readonly string[];
  /** Per-block parts with their absolute flat/markdown starts (`length + 1` prefix sums). */
  readonly parts: readonly RichPart[];
  readonly flats: readonly number[];
  readonly mds: readonly number[];
  #runs: RichRun[] | undefined;
  constructor(
    value: string,
    parts: readonly RichPart[],
    flats: readonly number[],
    mds: readonly number[],
    contextIds: readonly string[],
  ) {
    this.value = value;
    this.parts = parts;
    this.flats = flats;
    this.mds = mds;
    this.contextIds = contextIds;
  }
  get docLength(): number {
    return this.flats[this.parts.length]!;
  }
  /** Absolute runs, built on first access; hot paths use `visitRuns` instead. */
  get runs(): readonly RichRun[] {
    return (this.#runs ??= this.parts.flatMap((p, i) => {
      const flat = this.flats[i]!;
      const md = this.mds[i]!;
      return p.runs.map((r) => ({
        ...r,
        flatStart: r.flatStart + flat,
        mdStart: r.mdStart + md,
      }));
    }));
  }
}

/** First part index whose end in `ends` (prefix sums) satisfies `ok`, which must be monotonic. */
function firstPart(ends: readonly number[], count: number, ok: (end: number) => boolean): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ok(ends[mid + 1]!)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Visits runs (with absolute bases) of blocks overlapping flat [from, to]; stops when `visit` returns true. */
export function visitRuns(
  map: RichDocMap,
  visit: (run: Readonly<RichRun>, flatBase: number, mdBase: number) => boolean | void,
  from = 0,
  to = Infinity,
): void {
  const { parts, flats, mds } = map;
  for (
    let i = firstPart(flats, parts.length, (end) => end >= from);
    i < parts.length && flats[i]! <= to;
    i += 1
  ) {
    for (const run of parts[i]!.runs) if (visit(run, flats[i]!, mds[i]!)) return;
  }
}

export function serializeSelection(doc: ComposerDoc, from: number, to: number): string {
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  if (start === end) return "";
  const selected: ComposerBlock[] = [];
  for (const span of computeFlatBlockSpans(doc)) {
    if (span.end < start || span.start > end) continue;
    const b = span.block;
    if (b.kind === "horizontalRule") {
      if (span.start > start && span.end < end) selected.push(b);
    } else if (b.kind === "codeBlock") {
      if (start <= span.start && end >= span.end) selected.push(b);
      else {
        const text = b.code.slice(
          Math.max(0, start - span.start),
          Math.min(b.code.length, end - span.start),
        );
        selected.push({
          kind: "line",
          prefix: null,
          inlines: text ? [{ kind: "text", text, marks: [] }] : [],
        });
      }
    } else {
      const inlines = sliceInlines(
        b.inlines,
        Math.max(0, start - span.start),
        Math.min(span.end - span.start, end - span.start),
      );
      selected.push({ kind: "line", prefix: start <= span.start ? b.prefix : null, inlines });
    }
  }
  return selected.length > 0 ? serializeEditorDoc({ blocks: selected }).value : "";
}

export function serializedMarkdownOffset(
  value: string,
  serialized: string,
  offset: number,
): number {
  if (value === serialized) return offset;
  let i = 0;
  let mapped = 0;
  let target = -1;
  while (i < value.length && mapped < serialized.length) {
    if (i === offset && target < 0) target = mapped;
    if (value[i] === serialized[mapped] || serialized[mapped] !== "\n") i += 1;
    mapped += 1;
  }
  if (i !== value.length || mapped !== serialized.length) return offset;
  return target < 0 ? mapped + (offset - i) : target;
}

export function flatToMarkdown(map: RichDocMap, flatOffset: number): number {
  const bounded = Math.max(0, Math.min(flatOffset, map.docLength));
  let result = map.value.length;
  visitRuns(
    map,
    (run, flat, md) => {
      const start = flat + run.flatStart;
      const end = start + run.docLen;
      if (bounded < end || (bounded === end && run.nodeName === "codeBlock")) {
        result =
          md +
          run.mdStart +
          (run.kind === "text" || run.kind === "token" ? run.openLen : 0) +
          (bounded - start);
        return true;
      }
    },
    bounded,
  );
  return result;
}

export function markdownToFlat(map: RichDocMap, markdownOffset: number): number {
  const { parts, flats, mds } = map;
  for (
    let i = firstPart(mds, parts.length, (end) => end > markdownOffset);
    i < parts.length;
    i += 1
  ) {
    for (const run of parts[i]!.runs) {
      const mdStart = mds[i]! + run.mdStart;
      if (markdownOffset >= mdStart + run.mdLen) continue;
      const flatStart = flats[i]! + run.flatStart;
      if (run.kind === "prefix") return flatStart;
      if (run.kind === "text" || run.kind === "token") {
        const within = markdownOffset - mdStart;
        if (within <= run.openLen) return flatStart;
        if (run.kind === "token" || within >= run.openLen + run.docLen)
          return flatStart + run.docLen;
        return flatStart + (within - run.openLen);
      }
      return flatStart + (markdownOffset - mdStart);
    }
  }
  return map.docLength;
}

export interface SkillChipReplacement {
  readonly from: number;
  readonly to: number;
  readonly inline: ComposerInline;
}

export function skillChipReplacements(
  doc: ComposerDoc,
  skillLabelFor: (name: string) => SkillMeta | null,
  isKnownModel: IsKnownModel = NO_MODELS,
): SkillChipReplacement[] {
  const chips: ChipResolver = { skill: skillLabelFor, model: isKnownModel };
  const replacements: SkillChipReplacement[] = [];
  for (const span of computeFlatBlockSpans(doc)) {
    if (span.block.kind !== "line") continue;
    let pos = span.start;
    for (const item of span.block.inlines) {
      if (
        (item.kind === "composer-skill" && item.skillName !== "" && !chips.skill(item.skillName)) ||
        (item.kind === "composer-model" && !chips.model(item.instanceId, item.model))
      ) {
        replacements.push({
          from: pos,
          to: pos + 1,
          inline: { kind: "text", text: readChipSource(item), marks: item.marks ?? [] },
        });
      }
      pos += inlineFlatLength(item);
    }
  }
  const map = serializeEditorDoc(doc);
  let end = 0;
  for (const seg of splitPromptIntoComposerSegments(map.value)) {
    const start = end;
    end += seg.type === "text" ? seg.text.length : seg.source.length;
    if (seg.type !== "skill" && seg.type !== "model") continue;
    const chip = chipForSegment(seg, chips);
    if (!chip) continue;
    const run = map.runs.find(
      (r) =>
        r.kind === "text" &&
        r.nodeName !== "codeBlock" &&
        start >= r.mdStart + r.openLen &&
        end <= r.mdStart + r.openLen + r.docLen,
    );
    if (!run) continue;
    const from = run.flatStart + (start - run.mdStart - run.openLen);
    const res = resolveFlatOffset(doc, from);
    const marks =
      res.block.kind === "line"
        ? (inlineAfterOffset(res.block.inlines, res.offsetInBlock)?.marks ?? [])
        : [];
    replacements.push({
      from,
      to: from + seg.source.length,
      inline: marks.length ? { ...chip, marks } : chip,
    });
  }
  return replacements.sort((a, b) => b.from - a.from);
}

export function applySkillChipReplacements(
  doc: ComposerDoc,
  replacements: readonly SkillChipReplacement[],
): ComposerDoc {
  let current = doc;
  for (const { from, to, inline } of replacements) {
    const res = resolveFlatOffset(current, from);
    if (res.block.kind !== "line") continue;
    const nextInlines = normalizeInlines([
      ...sliceInlines(res.block.inlines, 0, from - res.start),
      inline,
      ...sliceInlines(res.block.inlines, to - res.start, res.end - res.start),
    ]);
    current = {
      blocks: current.blocks.map((b, i) =>
        i === res.blockIndex ? { ...res.block, inlines: nextInlines } : b,
      ),
    };
  }
  return current;
}

const SURROUND_MARKS: Record<string, RichTextMark> = { "`": "code", "*": "italic", _: "italic" };

export function surroundSelectionWithMark(
  state: ComposerEditorState,
  from: number,
  to: number,
  marker: string,
): ComposerEditResult | null {
  const mark = SURROUND_MARKS[marker];
  if (!mark || from >= to) return null;
  const startRes = resolveFlatOffset(state.doc, from);
  const endRes = resolveFlatOffset(state.doc, to);
  if (startRes.blockIndex !== endRes.blockIndex || startRes.block.kind !== "line") return null;
  const selected = sliceInlines(startRes.block.inlines, from - startRes.start, to - startRes.start);
  if (selected.some((i) => i.kind === "text" && i.isMarkdownSource)) return null;
  const marked = selected.map((i) => ({
    ...i,
    marks: sortMarks([...(i.marks ?? []), mark].filter((v, idx, arr) => arr.indexOf(v) === idx)),
  }));
  const nextInlines = normalizeInlines([
    ...sliceInlines(startRes.block.inlines, 0, from - startRes.start),
    ...marked,
    ...sliceInlines(startRes.block.inlines, to - startRes.start, startRes.end - startRes.start),
  ]);
  const testLine: ComposerBlock = {
    kind: "line",
    prefix: null,
    inlines: normalizeInlines(
      nextInlines.map((i) =>
        isChipInline(i) ? { kind: "text", text: "\uFFFC", marks: i.marks ?? [] } : i,
      ),
    ),
  };
  const restored = buildComposerBlocks(
    serializeEditorDoc({ blocks: [testLine] }).value,
    () => null,
    { blocks: false },
  )[0];
  if (
    !restored ||
    restored.kind !== "line" ||
    restored.inlines.length !== testLine.inlines.length ||
    !testLine.inlines.every((a, i) => {
      const b = restored.inlines[i]!;
      return (
        a.kind === "text" && b.kind === "text" && a.text === b.text && sameMarkSet(a.marks, b.marks)
      );
    })
  ) {
    return null;
  }
  return {
    doc: {
      blocks: state.doc.blocks.map((b, i) =>
        i === startRes.blockIndex ? { ...startRes.block, inlines: nextInlines } : b,
      ),
    },
    selection: { anchor: from, head: to },
    changeKind: "other",
  };
}

type ListPrefix = Extract<LinePrefix, { kind: "bullet" | "ordered" | "task" }>;

/** The item a nested list line hangs under, or null at the top level. */
export function parentListPrefix(
  blocks: readonly ComposerBlock[],
  index: number,
): ListPrefix | null {
  const line = blocks[index];
  if (line?.kind !== "line" || !isListPrefix(line.prefix) || !line.prefix.indent) return null;
  for (let i = index - 1; i >= 0; i -= 1) {
    const above = blocks[i]!;
    if (above.kind !== "line" || !isListPrefix(above.prefix)) return null;
    if (above.prefix.indent.length < line.prefix.indent.length) return above.prefix;
  }
  return null;
}

/** The prefix of a new item right after `prefix` at its level. */
export const siblingPrefixOf = (prefix: ListPrefix): ListPrefix =>
  prefix.kind === "ordered"
    ? { ...prefix, marker: nextOrderedMarkerText(prefix.marker) }
    : prefix.kind === "task"
      ? { ...prefix, checked: false }
      : prefix;

/** Renumbers the ordered items that follow `from` at its level, starting at `index`. */
export function renumberOrderedAfter(
  blocks: ComposerBlock[],
  index: number,
  from: LinePrefix,
): void {
  if (from.kind !== "ordered") return;
  const delim = from.marker.slice(-1);
  let prevMarker = from.marker;
  for (let i = index; i < blocks.length; i += 1) {
    const sib = blocks[i]!;
    if (
      sib.kind !== "line" ||
      !isListPrefix(sib.prefix) ||
      sib.prefix.indent.length < from.indent.length
    )
      break;
    if (sib.prefix.indent !== from.indent) continue;
    if (sib.prefix.kind !== "ordered" || sib.prefix.marker.slice(-1) !== delim) break;
    prevMarker = nextOrderedMarkerText(prevMarker);
    blocks[i] = { ...sib, prefix: { ...sib.prefix, marker: prevMarker } };
  }
}

const newlinesIn = (text: string): number => {
  let n = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n += 1;
  return n;
};

/**
 * Tab / Shift+Tab on a list item. The Markdown rule rewrites only list markers, so only those blocks' prefixes change
 * and chips (with their cite keys) and per-block caches survive; `rebuild` reparses when that does not hold.
 */
export function indentListItemForTab(
  state: ComposerEditorState,
  outdent: boolean,
  rebuild: (value: string) => ComposerDoc,
): ComposerEditResult | null {
  if (!selectionEmpty(state.selection)) return null;
  const res = resolveFlatOffset(state.doc, state.selection.head);
  if (res.block.kind !== "line" || !isListPrefix(res.block.prefix)) return null;
  const map = serializeEditorDoc(state.doc);
  const at = flatToMarkdown(map, state.selection.head);
  const edit = (outdent ? listOutdentForTab : listIndentForTab)(map.value, at, at);
  if (!edit) return null;
  const value = map.value.slice(0, edit.start) + edit.replacement + map.value.slice(edit.end);
  const oldLines = map.value.split("\n");
  const newLines = value.split("\n");
  const blocks = state.doc.blocks.slice();
  let changed = 0;
  let lastIndex = -1;
  let line = 0;
  const editEnd = Math.max(edit.end, edit.start + 1);
  for (let j = 0; j < blocks.length && map.mds[j]! < editEnd; j += 1) {
    const part = map.parts[j]!;
    const own = line + (part.variant & 1) + ((part.variant >> 1) & 1);
    line += newlinesIn(part.value);
    const block = blocks[j]!;
    if (map.mds[j + 1]! <= edit.start || oldLines[own] === newLines[own]) continue;
    const parsed = isListPrefix(block.kind === "line" ? block.prefix : null)
      ? parseListPrefix(newLines[own] ?? "")
      : null;
    if (block.kind !== "line" || !parsed) {
      changed = -1;
      break;
    }
    blocks[j] = { ...block, prefix: parsed.prefix };
    changed += 1;
    lastIndex = j;
  }
  let doc: ComposerDoc =
    changed === 1 ? withLineBlock(state.doc, lastIndex, blocks[lastIndex]!, 0) : { blocks };
  if (changed < 1 || oldLines.length !== newLines.length || serializeEditorDoc(doc).value !== value)
    doc = rebuild(value);
  return {
    doc,
    selection: collapsedSelection(markdownToFlat(serializeEditorDoc(doc), edit.cursorAfter)),
    changeKind: "other",
  };
}

export function splitOrLiftListItem(state: ComposerEditorState): ComposerEditResult | null {
  const from = selectionFrom(state.selection);
  const to = selectionTo(state.selection);
  const startRes = resolveFlatOffset(state.doc, from);
  const endRes = resolveFlatOffset(state.doc, to);
  if (
    startRes.blockIndex !== endRes.blockIndex ||
    startRes.block.kind !== "line" ||
    !isListPrefix(startRes.block.prefix)
  ) {
    return null;
  }
  const { prefix, inlines } = startRes.block;
  const blocks = [...state.doc.blocks];
  if (inlines.length === 0) {
    // An empty nested item lifts into its parent list; a top-level one leaves the list.
    const parent = parentListPrefix(blocks, startRes.blockIndex);
    const lifted = parent && siblingPrefixOf(parent);
    blocks[startRes.blockIndex] = { kind: "line", prefix: lifted, inlines: [] };
    if (lifted) renumberOrderedAfter(blocks, startRes.blockIndex + 1, lifted);
    return { doc: { blocks }, selection: collapsedSelection(startRes.start), changeKind: "other" };
  }
  const before = sliceInlines(inlines, 0, from - startRes.start);
  const after = sliceInlines(inlines, to - startRes.start, startRes.end - startRes.start);
  const nextPrefix: LinePrefix =
    prefix.kind === "task"
      ? { ...prefix, checked: false, contentSpace: " " }
      : prefix.kind === "ordered"
        ? { ...prefix, marker: nextOrderedMarkerText(prefix.marker), space: " " }
        : { ...prefix, space: " " };
  blocks.splice(
    startRes.blockIndex,
    1,
    { kind: "line", prefix, inlines: before },
    { kind: "line", prefix: nextPrefix, inlines: after },
  );
  renumberOrderedAfter(blocks, startRes.blockIndex + 2, nextPrefix);
  return { doc: { blocks }, selection: collapsedSelection(from + 1), changeKind: "insert" };
}

export function convertBulletItemToTask(
  state: ComposerEditorState,
  checked: boolean,
  stripPrefixLength = 0,
): ComposerEditResult | null {
  const from = selectionFrom(state.selection);
  const res = resolveFlatOffset(state.doc, from);
  if (res.block.kind !== "line" || res.block.prefix?.kind !== "bullet") return null;
  const p = res.block.prefix;
  const nextInlines =
    stripPrefixLength > 0
      ? sliceInlines(res.block.inlines, stripPrefixLength, res.end - res.start)
      : res.block.inlines;
  const task: ComposerBlock = {
    kind: "line",
    prefix: {
      kind: "task",
      indent: p.indent,
      checked,
      markerSpace: p.space || " ",
      contentSpace: " ",
    },
    inlines: nextInlines,
  };
  return {
    doc: { blocks: state.doc.blocks.map((b, i) => (i === res.blockIndex ? task : b)) },
    selection: collapsedSelection(Math.max(res.start, from - stripPrefixLength)),
    changeKind: "other",
  };
}

function styledEdge(state: ComposerEditorState) {
  if (!selectionEmpty(state.selection)) return null;
  const res = resolveFlatOffset(state.doc, state.selection.head);
  if (res.block.kind !== "line") return null;
  const beforeItem = inlineBeforeOffset(res.block.inlines, res.offsetInBlock);
  const afterItem = inlineAfterOffset(res.block.inlines, res.offsetInBlock);
  const before =
    beforeItem && !(beforeItem.kind === "text" && beforeItem.isMarkdownSource)
      ? (beforeItem.marks ?? [])
      : [];
  const after =
    afterItem && !(afterItem.kind === "text" && afterItem.isMarkdownSource)
      ? (afterItem.marks ?? [])
      : [];
  if (sameMarkSet(before, after)) return null;
  return { before, after, current: state.selection.storedMarks ?? before };
}

export function caretTakesMarksBefore(state: ComposerEditorState): boolean {
  const edge = styledEdge(state);
  return edge !== null && sameMarkSet(edge.current, edge.before);
}

export function stepCaretAcrossStyledEdge(
  state: ComposerEditorState,
  direction: -1 | 1,
): ComposerEditResult | null {
  const edge = styledEdge(state);
  if (!edge || (!sameMarkSet(edge.current, edge.before) && !sameMarkSet(edge.current, edge.after)))
    return null;
  const target = direction === -1 ? edge.before : edge.after;
  if (sameMarkSet(edge.current, target)) return null;
  return { doc: state.doc, selection: { ...state.selection, storedMarks: [...target] } };
}
