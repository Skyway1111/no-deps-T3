import type { AssistantCitation } from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";

import type { RichTextMark } from "~/composer-rich-text";
import {
  convertCodeFenceOnEnter,
  exitCodeBlockOnClosingFence,
  exitCodeBlockOnTrailingBlankLines,
  indentedNewlineInCodeBlock,
  selectionInOneCodeBlock,
  unwrapCodeBlockAtStart,
} from "~/composer-code-block";
import { collapseShownMarkdownSource, touchesMarkdownSource } from "~/composer-markdown-source";
import {
  convertBulletItemToTask,
  parentListPrefix,
  renumberOrderedAfter,
  siblingPrefixOf,
  splitOrLiftListItem,
  withLineBlock,
} from "~/composer-rich-text-doc";
import {
  type CitationInsertedSpaces,
  type ComposerBlock,
  type ComposerDoc,
  type ComposerEditResult,
  type ComposerEditorState,
  type ComposerInline,
  type LinePrefix,
  type ResolvedFlatOffset,
  collapsedSelection,
  computeFlatBlockSpans,
  docFlatLength,
  inlineAfterOffset,
  inlineBeforeOffset,
  inlineFlatLength,
  inlinesFlatLength,
  inlinesPlainText,
  isChipInline,
  isPlainParagraph,
  normalizeInlines,
  resolveFlatOffset,
  sameMarkSet,
  selectionEmpty,
  selectionFrom,
  selectionTo,
  sliceInlines,
  sortMarks,
} from "./types";

const finalize = (blocks: ComposerBlock[]): ComposerDoc =>
  blocks.length === 0
    ? { blocks: [{ kind: "line", prefix: null, inlines: [] }] }
    : blocks.at(-1)?.kind === "horizontalRule"
      ? { blocks: [...blocks, { kind: "line", prefix: null, inlines: [] }] }
      : { blocks };

/** Flat caret at `offset` in block `index` of the result; filling the empty line after a rule shifts its start. */
const caretAt = (
  doc: ComposerDoc,
  index: number,
  offset: number,
  storedMarks?: ComposerEditResult["selection"]["storedMarks"],
) => collapsedSelection(computeFlatBlockSpans(doc)[index]!.start + offset, storedMarks);

export function deleteRange(doc: ComposerDoc, rawFrom: number, rawTo: number): ComposerEditResult {
  const total = docFlatLength(doc);
  const from = Math.max(0, Math.min(rawFrom, rawTo, total));
  const to = Math.max(0, Math.min(Math.max(rawFrom, rawTo), total));
  if (from === to) return { doc, selection: collapsedSelection(from) };

  const s = resolveFlatOffset(doc, from);
  const e = resolveFlatOffset(doc, to);

  if (s.blockIndex === e.blockIndex) {
    const b = s.block;
    if (b.kind === "codeBlock") {
      const code = b.code.slice(0, from - s.start) + b.code.slice(to - s.start);
      return {
        doc: withLineBlock(doc, s.blockIndex, { ...b, code }, from - to),
        selection: collapsedSelection(from),
        changeKind: "delete",
      };
    }
    if (b.kind === "line") {
      const inlines = normalizeInlines([
        ...sliceInlines(b.inlines, 0, from - s.start),
        ...sliceInlines(b.inlines, to - s.start, s.end - s.start),
      ]);
      const block = { ...b, inlines };
      return {
        // Emptying a line can change its separators, which withLineBlock cannot derive.
        doc:
          inlines.length > 0
            ? withLineBlock(doc, s.blockIndex, block, from - to)
            : finalize(doc.blocks.map((blk, i) => (i === s.blockIndex ? block : blk))),
        selection: collapsedSelection(from),
        changeKind: "delete",
      };
    }
  }

  const tailInlines: ComposerInline[] =
    e.block.kind === "codeBlock"
      ? (() => {
          const t = e.block.code.slice(to - e.start);
          return t ? [{ kind: "text", text: t, marks: [] }] : [];
        })()
      : e.block.kind === "line"
        ? sliceInlines(e.block.inlines, to - e.start, e.end - e.start)
        : [];

  const merged: ComposerBlock =
    s.block.kind === "codeBlock"
      ? {
          ...s.block,
          code: s.block.code.slice(0, from - s.start) + inlinesPlainText(tailInlines, ""),
        }
      : s.block.kind === "line"
        ? {
            ...s.block,
            inlines: normalizeInlines([
              ...sliceInlines(s.block.inlines, 0, from - s.start),
              ...tailInlines,
            ]),
          }
        : { kind: "line", prefix: null, inlines: tailInlines };

  const blocks = [
    ...doc.blocks.slice(0, s.blockIndex),
    merged,
    ...doc.blocks.slice(e.blockIndex + 1),
  ];
  return { doc: finalize(blocks), selection: collapsedSelection(from), changeKind: "delete" };
}

/** A block marker typed in front of existing text converts the line, so the view keeps matching its Markdown. */
function tryMarkerBeforeText(
  state: ComposerEditorState,
  res: ResolvedFlatOffset,
  before: ComposerEditorState,
): ComposerEditResult | null {
  if (res.block.kind !== "line") return null;
  const head = sliceInlines(res.block.inlines, 0, res.offsetInBlock);
  if (head.some((i) => i.kind !== "text" || i.marks.length > 0 || i.isMarkdownSource)) return null;
  let tail = sliceInlines(res.block.inlines, res.offsetInBlock, res.end - res.start);
  const first = tail[0]?.kind === "text" ? tail[0].text : "";
  if (/^\s/.test(first)) return null;
  const marker = inlinesPlainText(head);
  let m: RegExpExecArray | null;
  if (res.block.prefix?.kind === "bullet" && (m = /^\[([ xX])\] $/.exec(marker))) {
    const conv = convertBulletItemToTask(state, m[1] !== " ", marker.length);
    return conv ? { ...conv, inputRuleUndo: before } : null;
  }
  if (res.block.prefix !== null) return null;
  let prefix: LinePrefix | null = null;
  if ((m = /^(#{1,6}) $/.exec(marker)))
    prefix = { kind: "heading", level: m[1]!.length, space: " " };
  else if (marker === "> ") prefix = { kind: "quote", prefix: "> " };
  else if ((m = /^- \[([ xX])\] $/.exec(marker)))
    prefix = {
      kind: "task",
      indent: "",
      checked: m[1] !== " ",
      markerSpace: " ",
      contentSpace: " ",
    };
  else if ((m = /^(\d+[.)]) $/.exec(marker)))
    prefix = { kind: "ordered", indent: "", marker: m[1]!, space: " " };
  else if ((m = /^([-*+]) $/.exec(marker))) {
    const task = /^\[([ xX])\] (?=\S)/.exec(first);
    prefix = task
      ? { kind: "task", indent: "", checked: task[1] !== " ", markerSpace: " ", contentSpace: " " }
      : { kind: "bullet", indent: "", marker: m[1]!, space: " " };
    if (task) tail = sliceInlines(tail, task[0].length, inlinesFlatLength(tail));
  }
  if (!prefix) return null;
  const doc = finalize(
    state.doc.blocks.map((b, i) =>
      i === res.blockIndex ? { kind: "line", prefix, inlines: tail } : b,
    ),
  );
  return {
    doc,
    selection: caretAt(doc, res.blockIndex, 0),
    changeKind: "other",
    inputRuleUndo: before,
  };
}

function tryBlockInputRule(
  state: ComposerEditorState,
  before: ComposerEditorState,
): ComposerEditResult | null {
  if (!selectionEmpty(state.selection)) return null;
  const res = resolveFlatOffset(state.doc, state.selection.head);
  if (res.block.kind !== "line") return null;
  if (res.offsetInBlock !== res.end - res.start) return tryMarkerBeforeText(state, res, before);
  if (res.block.inlines.some((i) => isChipInline(i) || i.marks.length > 0 || i.isMarkdownSource))
    return null;
  const text = inlinesPlainText(res.block.inlines);

  if (res.block.prefix?.kind === "bullet") {
    const task = /^\[([ xX])\] $/.exec(text);
    if (!task) return null;
    const conv = convertBulletItemToTask(state, task[1]!.toLowerCase() === "x", task[0].length);
    return conv ? { ...conv, inputRuleUndo: before } : null;
  }
  if (res.block.prefix !== null) return null;

  const replaceBlock = (block: ComposerBlock, caret = res.start): ComposerEditResult => ({
    doc: finalize(state.doc.blocks.map((b, i) => (i === res.blockIndex ? block : b))),
    selection: collapsedSelection(caret),
    changeKind: "other",
    inputRuleUndo: before,
  });

  const heading = /^(#{1,6})(\s)$/.exec(text);
  if (heading)
    return replaceBlock({
      kind: "line",
      prefix: { kind: "heading", level: heading[1]!.length, space: heading[2]! },
      inlines: [],
    });

  const quote = /^>(\s)$/.exec(text);
  if (quote)
    return replaceBlock({
      kind: "line",
      prefix: { kind: "quote", prefix: `>${quote[1]!}` },
      inlines: [],
    });

  const hr = /^(---|\*\*\*|___)\s?$/.exec(text);
  if (hr && (hr[0].startsWith("---") || /\s$/.test(hr[0]))) {
    const blocks = [...state.doc.blocks];
    const nextIsPara = isPlainParagraph(blocks[res.blockIndex + 1]);
    blocks.splice(
      res.blockIndex,
      1,
      { kind: "horizontalRule", source: hr[0] },
      ...(nextIsPara ? [] : [{ kind: "line" as const, prefix: null, inlines: [] }]),
    );
    return {
      doc: finalize(blocks),
      selection: collapsedSelection(res.start),
      changeKind: "other",
      inputRuleUndo: before,
    };
  }

  const task = /^- \[([ xX])\] $/.exec(text);
  if (task)
    return replaceBlock({
      kind: "line",
      prefix: {
        kind: "task",
        indent: "",
        checked: task[1]!.toLowerCase() === "x",
        markerSpace: " ",
        contentSpace: " ",
      },
      inlines: [],
    });

  const plusStar = /^([*+])(\s)$/.exec(text);
  if (plusStar)
    return replaceBlock({
      kind: "line",
      prefix: { kind: "bullet", indent: "", marker: plusStar[1]!, space: plusStar[2]! },
      inlines: [],
    });

  // Wait for a non-space, non-'[' char after '- ' so '- [ ] ' reaches the task rule.
  const dash = /^(-)([ \t]+)([^\s[])$/.exec(text);
  if (dash) {
    const carried = dash[3]!;
    return replaceBlock(
      {
        kind: "line",
        prefix: { kind: "bullet", indent: "", marker: "-", space: dash[2]! },
        inlines: [{ kind: "text", text: carried, marks: [] }],
      },
      res.start + carried.length,
    );
  }

  const ordered = /^(\d+[.)])(\s)$/.exec(text);
  if (ordered)
    return replaceBlock({
      kind: "line",
      prefix: { kind: "ordered", indent: "", marker: ordered[1]!, space: ordered[2]! },
      inlines: [],
    });

  return null;
}

const INLINE_RULES: ReadonlyArray<{ trigger: string; regex: RegExp; mark: RichTextMark }> = [
  { trigger: "*", regex: /(?:^|[^*])(\*\*([^*]+)\*\*)$/, mark: "bold" },
  { trigger: "_", regex: /(?:^|[^_\w])(__([^_]+)__)$/, mark: "bold" },
  { trigger: "*", regex: /(?:^|[^*])(\*([^*]+)\*)$/, mark: "italic" },
  { trigger: "~", regex: /(?:^|[^~])(~~([^~]+)~~)$/, mark: "strike" },
  { trigger: "`", regex: /(?:^|[^`])(`([^`]+)`)$/, mark: "code" },
];

const INLINE_TRIGGERS = new Set(INLINE_RULES.map((r) => r.trigger));
// Every block rule's line text starts with one of these.
const BLOCK_RULE_START = /^[#>*+\-_[\d]/;

function tryInlineInputRule(state: ComposerEditorState, ch: string): ComposerEditResult | null {
  if (
    !INLINE_TRIGGERS.has(ch) ||
    !selectionEmpty(state.selection) ||
    touchesMarkdownSource(state, state.selection.head, state.selection.head)
  )
    return null;
  const res = resolveFlatOffset(state.doc, state.selection.head);
  if (res.block.kind !== "line") return null;
  const beforeSlice = sliceInlines(res.block.inlines, 0, res.offsetInBlock);
  const last = beforeSlice.at(-1);
  if (!last || last.kind !== "text" || last.marks.includes("code")) return null;
  const beforeText = inlinesPlainText(beforeSlice);

  for (const rule of INLINE_RULES) {
    if (rule.trigger !== ch) continue;
    const m = rule.regex.exec(beforeText);
    if (!m || !m[2]!.trim()) continue;
    const matchStart = beforeText.length - m[1]!.length;
    const delimLen = (m[1]!.length - m[2]!.length) / 2;
    // An unclosed backtick before the match opens a code span, which binds tighter than emphasis.
    const priorPlain = sliceInlines(res.block.inlines, 0, matchStart)
      .filter((i) => i.kind === "text" && !i.marks.includes("code"))
      .map((i) => (i.kind === "text" ? i.text : ""))
      .join("");
    if ([...priorPlain.matchAll(/(?<!`)`(?!`)/g)].length % 2 === 1) continue;
    const inner = sliceInlines(
      res.block.inlines,
      matchStart + delimLen,
      matchStart + delimLen + m[2]!.length,
    );
    const delimiters = [
      ...sliceInlines(res.block.inlines, matchStart, matchStart + delimLen),
      ...sliceInlines(res.block.inlines, beforeText.length - delimLen, beforeText.length),
    ];
    if (delimiters.some((i) => i.kind !== "text" || i.marks.includes("code"))) continue;
    const styled = inner.map((i) =>
      i.marks?.includes(rule.mark)
        ? i
        : { ...i, marks: sortMarks([...(i.marks ?? []), rule.mark]) },
    );
    const nextInlines = normalizeInlines([
      ...sliceInlines(res.block.inlines, 0, matchStart),
      ...styled,
      ...sliceInlines(res.block.inlines, res.offsetInBlock, res.end - res.start),
    ]);
    return {
      doc: {
        blocks: state.doc.blocks.map((b, i) =>
          i === res.blockIndex ? { ...res.block, inlines: nextInlines } : b,
        ),
      },
      selection: collapsedSelection(res.start + matchStart + m[2]!.length, []),
      changeKind: "insert",
    };
  }
  return null;
}

const isSourceText = (item: ComposerInline | null | undefined): boolean =>
  item?.kind === "text" && Boolean(item.isMarkdownSource);

/** Typing inside or right after a text inline extends that inline in place, matching the general path's merge. */
function typeIntoTextInline(
  state: ComposerEditorState,
  res: ResolvedFlatOffset,
  text: string,
  options: {
    readonly richText: boolean;
    readonly literalText: boolean;
    readonly applyInputRules?: boolean;
  },
): ComposerEditResult | null {
  if (res.block.kind !== "line" || res.offsetInBlock === 0) return null;
  const inlines = res.block.inlines;
  let pos = 0;
  let index = 0;
  for (; index < inlines.length; index += 1) {
    const len = inlineFlatLength(inlines[index]!);
    if (res.offsetInBlock <= pos + len) break;
    pos += len;
  }
  const item = inlines[index];
  const stored = state.selection.storedMarks;
  if (item?.kind !== "text") return null;
  const at = res.offsetInBlock - pos;
  // Shown source is non-inclusive, as ProseMirror marks: text typed at its edge is plain.
  if (
    item.isMarkdownSource &&
    (stored != null || (at === item.text.length && !isSourceText(inlines[index + 1])))
  )
    return null;
  if (stored != null && !sameMarkSet(item.marks, stored)) return null;
  const nextInlines = inlines.slice();
  nextInlines[index] = { ...item, text: item.text.slice(0, at) + text + item.text.slice(at) };
  const doc = withLineBlock(
    state.doc,
    res.blockIndex,
    { ...res.block, inlines: nextInlines },
    text.length,
  );
  const nextState: ComposerEditorState = {
    doc,
    selection: collapsedSelection(state.selection.head + text.length, state.selection.storedMarks),
  };
  if (
    options.applyInputRules !== false &&
    options.richText &&
    !options.literalText &&
    text.length === 1
  ) {
    const first = nextInlines[0];
    const blockRule =
      first?.kind === "text" && BLOCK_RULE_START.test(first.text)
        ? tryBlockInputRule(nextState, nextState)
        : null;
    const rule = blockRule ?? tryInlineInputRule(nextState, text);
    if (rule) return rule;
  }
  return { doc: nextState.doc, selection: nextState.selection, changeKind: "insert" };
}

export function insertText(
  state: ComposerEditorState,
  text: string,
  options: {
    readonly richText: boolean;
    readonly literalText: boolean;
    readonly applyInputRules?: boolean;
  },
): ComposerEditResult {
  const working = selectionEmpty(state.selection)
    ? state
    : deleteRange(state.doc, selectionFrom(state.selection), selectionTo(state.selection));
  const pos = working.selection.head;
  const res = resolveFlatOffset(working.doc, pos);

  if (res.block.kind === "codeBlock") {
    const off = pos - res.start;
    const code = res.block.code.slice(0, off) + text + res.block.code.slice(off);
    return {
      doc: withLineBlock(working.doc, res.blockIndex, { ...res.block, code }, text.length),
      selection: collapsedSelection(pos + text.length),
      changeKind: "insert",
    };
  }
  if (res.block.kind === "horizontalRule") {
    const blocks = [...working.doc.blocks];
    blocks.splice(res.blockIndex + 1, 0, {
      kind: "line",
      prefix: null,
      inlines: text ? [{ kind: "text", text, marks: [] }] : [],
    });
    const doc = finalize(blocks);
    return { doc, selection: caretAt(doc, res.blockIndex + 1, text.length), changeKind: "insert" };
  }

  if (!text.includes("\n")) {
    const fast = typeIntoTextInline(working, res, text, options);
    if (fast) return fast;
  }
  const beforeItem = inlineBeforeOffset(res.block.inlines, res.offsetInBlock);
  const inSource =
    working.selection.storedMarks == null &&
    isSourceText(beforeItem) &&
    isSourceText(inlineAfterOffset(res.block.inlines, res.offsetInBlock));
  const marks = inSource
    ? []
    : sortMarks(
        working.selection.storedMarks ??
          (beforeItem && !(beforeItem.kind === "text" && beforeItem.isMarkdownSource)
            ? (beforeItem.marks ?? [])
            : []),
      );
  const head = sliceInlines(res.block.inlines, 0, res.offsetInBlock);
  const tail = sliceInlines(res.block.inlines, res.offsetInBlock, res.end - res.start);
  const lines = text.split("\n");

  if (lines.length === 1) {
    const nextInlines = normalizeInlines([
      ...head,
      { kind: "text", text: lines[0]!, marks, ...(inSource ? { isMarkdownSource: true } : {}) },
      ...tail,
    ]);
    const doc = {
      blocks: working.doc.blocks.map((b, i) =>
        i === res.blockIndex ? { ...res.block, inlines: nextInlines } : b,
      ),
    };
    const nextState: ComposerEditorState = {
      doc,
      selection: caretAt(
        doc,
        res.blockIndex,
        res.offsetInBlock + text.length,
        working.selection.storedMarks,
      ),
    };
    if (
      options.applyInputRules !== false &&
      options.richText &&
      !options.literalText &&
      text.length === 1
    ) {
      const first = nextInlines[0];
      const blockRule =
        first?.kind === "text" && BLOCK_RULE_START.test(first.text)
          ? tryBlockInputRule(nextState, nextState)
          : null;
      return (
        blockRule ?? tryInlineInputRule(nextState, text) ?? { ...nextState, changeKind: "insert" }
      );
    }
    return { ...nextState, changeKind: "insert" };
  }

  const linePrefix: LinePrefix | null =
    res.block.prefix?.kind === "quote" ? res.block.prefix : null;
  const first: ComposerBlock = {
    ...res.block,
    inlines: normalizeInlines([
      ...head,
      ...(lines[0] ? [{ kind: "text" as const, text: lines[0], marks }] : []),
    ]),
  };
  const middle: ComposerBlock[] = lines.slice(1, -1).map((l) => ({
    kind: "line",
    prefix: linePrefix,
    inlines: l ? [{ kind: "text", text: l, marks }] : [],
  }));
  const lastText = lines.at(-1)!;
  const last: ComposerBlock = {
    kind: "line",
    prefix: linePrefix,
    inlines: normalizeInlines([
      ...(lastText ? [{ kind: "text" as const, text: lastText, marks }] : []),
      ...tail,
    ]),
  };
  const blocks = [...working.doc.blocks];
  blocks.splice(res.blockIndex, 1, first, ...middle, last);
  const doc = finalize(blocks);
  return {
    doc,
    selection: caretAt(doc, res.blockIndex + lines.length - 1, lastText.length),
    changeKind: "insert",
  };
}

export function insertLineBreak(state: ComposerEditorState, richText: boolean): ComposerEditResult {
  const collapsed = richText ? collapseShownMarkdownSource(state) : null;
  const working: ComposerEditorState = collapsed
    ? { doc: collapsed.doc, selection: collapsed.selection }
    : state;

  if (richText && selectionInOneCodeBlock(working)) {
    return (
      exitCodeBlockOnClosingFence(working) ??
      exitCodeBlockOnTrailingBlankLines(working) ??
      indentedNewlineInCodeBlock(working)!
    );
  }
  if (richText) {
    const special = convertCodeFenceOnEnter(working) ?? splitOrLiftListItem(working);
    if (special) return special;
  }
  const clean = selectionEmpty(working.selection)
    ? working
    : deleteRange(working.doc, selectionFrom(working.selection), selectionTo(working.selection));
  const pos = clean.selection.head;
  const res = resolveFlatOffset(clean.doc, pos);

  if (res.block.kind === "codeBlock") return indentedNewlineInCodeBlock(clean)!;
  if (res.block.kind === "horizontalRule") {
    const blocks = [...clean.doc.blocks];
    blocks.splice(res.blockIndex + 1, 0, { kind: "line", prefix: null, inlines: [] });
    return { doc: finalize(blocks), selection: collapsedSelection(pos), changeKind: "insert" };
  }
  // Empty blockquote line lifts out to plain paragraph.
  if (richText && res.block.prefix?.kind === "quote" && res.block.inlines.length === 0) {
    return {
      doc: finalize(
        clean.doc.blocks.map((b, i) =>
          i === res.blockIndex ? { kind: "line", prefix: null, inlines: [] } : b,
        ),
      ),
      selection: collapsedSelection(pos),
      changeKind: "other",
    };
  }
  const head = sliceInlines(res.block.inlines, 0, res.offsetInBlock);
  const tail = sliceInlines(res.block.inlines, res.offsetInBlock, res.end - res.start);
  const before = inlineBeforeOffset(res.block.inlines, res.offsetInBlock);
  const keptMarks =
    clean.selection.storedMarks ??
    (before && !(before.kind === "text" && before.isMarkdownSource)
      ? (before.marks ?? [])
      : undefined);
  const nextPrefix = res.block.prefix?.kind === "quote" ? res.block.prefix : null;
  const blocks = [...clean.doc.blocks];
  blocks.splice(
    res.blockIndex,
    1,
    { ...res.block, inlines: head },
    { kind: "line", prefix: nextPrefix, inlines: tail },
  );
  const doc = finalize(blocks);
  return { doc, selection: caretAt(doc, res.blockIndex + 1, 0, keptMarks), changeKind: "insert" };
}

function scanWord(text: string, offset: number, dir: -1 | 1): number {
  let i = offset;
  const step = () => (dir === -1 ? i > 0 : i < text.length);
  const ch = () => text[dir === -1 ? i - 1 : i]!;
  while (step() && /\s/.test(ch())) i += dir;
  while (step() && !/\s/.test(ch())) i += dir;
  return i;
}

export function deleteBackward(
  state: ComposerEditorState,
  unit: "char" | "word" | "line" = "char",
): ComposerEditResult | null {
  if (!selectionEmpty(state.selection))
    return deleteRange(state.doc, selectionFrom(state.selection), selectionTo(state.selection));
  const pos = state.selection.head;
  const res = resolveFlatOffset(state.doc, pos);

  if (res.offsetInBlock === 0) {
    if (res.block.kind === "codeBlock") return unwrapCodeBlockAtStart(state);
    if (res.block.kind === "line" && res.block.prefix !== null) {
      // A nested item lifts beside its parent item when it can hold it; otherwise it joins the line above.
      const blocks = [...state.doc.blocks];
      const parent = parentListPrefix(blocks, res.blockIndex);
      if (parent && (parent.kind === "task") !== (res.block.prefix.kind === "task"))
        return deleteRange(state.doc, pos - 1, pos);
      const prefix = parent && siblingPrefixOf(parent);
      blocks[res.blockIndex] = { ...res.block, prefix };
      if (prefix) renumberOrderedAfter(blocks, res.blockIndex + 1, prefix);
      return { doc: finalize(blocks), selection: collapsedSelection(pos), changeKind: "delete" };
    }
    if (res.blockIndex > 0 && state.doc.blocks[res.blockIndex - 1]?.kind === "horizontalRule") {
      return {
        doc: finalize(state.doc.blocks.filter((_, i) => i !== res.blockIndex - 1)),
        selection: collapsedSelection(Math.max(0, pos - 1)),
        changeKind: "delete",
      };
    }
    return pos === 0 ? null : deleteRange(state.doc, pos - 1, pos);
  }

  const text =
    res.block.kind === "codeBlock"
      ? res.block.code
      : res.block.kind === "line"
        ? inlinesPlainText(res.block.inlines)
        : "";
  if (unit === "line") {
    if (res.block.kind === "codeBlock") {
      const nl = text.lastIndexOf("\n", res.offsetInBlock - 1);
      const target = res.start + (nl === -1 ? 0 : nl + 1);
      return deleteRange(state.doc, target === pos ? Math.max(res.start, pos - 1) : target, pos);
    }
    return deleteRange(state.doc, res.start, pos);
  }
  if (unit === "word")
    return deleteRange(
      state.doc,
      Math.min(res.start + scanWord(text, res.offsetInBlock, -1), pos - 1),
      pos,
    );
  const lo = text.charCodeAt(res.offsetInBlock - 1);
  const hi = res.offsetInBlock >= 2 ? text.charCodeAt(res.offsetInBlock - 2) : 0;
  const len = lo >= 0xdc00 && lo <= 0xdfff && hi >= 0xd800 && hi <= 0xdbff ? 2 : 1;
  return deleteRange(state.doc, pos - len, pos);
}

export function deleteForward(
  state: ComposerEditorState,
  unit: "char" | "word" | "line" = "char",
): ComposerEditResult | null {
  if (!selectionEmpty(state.selection))
    return deleteRange(state.doc, selectionFrom(state.selection), selectionTo(state.selection));
  const pos = state.selection.head;
  const total = docFlatLength(state.doc);
  if (pos >= total) return null;
  const res = resolveFlatOffset(state.doc, pos);

  if (res.offsetInBlock === res.end - res.start) {
    const next = state.doc.blocks[res.blockIndex + 1];
    if (next?.kind === "codeBlock" && res.block.kind !== "codeBlock") return null;
    if (next?.kind === "horizontalRule") {
      return {
        doc: finalize(state.doc.blocks.filter((_, i) => i !== res.blockIndex + 1)),
        selection: collapsedSelection(pos),
        changeKind: "delete",
      };
    }
    return deleteRange(state.doc, pos, pos + 1);
  }

  const text =
    res.block.kind === "codeBlock"
      ? res.block.code
      : res.block.kind === "line"
        ? inlinesPlainText(res.block.inlines)
        : "";
  if (unit === "line") {
    if (res.block.kind === "codeBlock") {
      const nl = text.indexOf("\n", res.offsetInBlock);
      const target = nl === -1 ? res.end : res.start + nl;
      return deleteRange(state.doc, pos, target === pos ? Math.min(total, pos + 1) : target);
    }
    return deleteRange(state.doc, pos, res.end);
  }
  if (unit === "word")
    return deleteRange(
      state.doc,
      pos,
      Math.max(res.start + scanWord(text, res.offsetInBlock, 1), pos + 1),
    );
  const hi = text.charCodeAt(res.offsetInBlock);
  const lo = res.offsetInBlock + 1 < text.length ? text.charCodeAt(res.offsetInBlock + 1) : 0;
  const len = hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff ? 2 : 1;
  return deleteRange(state.doc, pos, pos + len);
}

export function toggleInlineMark(
  state: ComposerEditorState,
  mark: RichTextMark,
): ComposerEditResult | null {
  const { doc, selection } = collapseShownMarkdownSource(state);
  const from = selectionFrom(selection);
  const to = selectionTo(selection);
  if (from === to) {
    const res = resolveFlatOffset(doc, from);
    if (res.block.kind !== "line") return null;
    const cur =
      selection.storedMarks ??
      inlineBeforeOffset(res.block.inlines, res.offsetInBlock)?.marks ??
      [];
    const next = cur.includes(mark) ? cur.filter((m) => m !== mark) : sortMarks([...cur, mark]);
    return { doc, selection: collapsedSelection(from, next) };
  }
  const spans = computeFlatBlockSpans(doc);
  const hasUnmarked = spans.some(
    (s) =>
      s.end > from &&
      s.start < to &&
      s.block.kind === "line" &&
      sliceInlines(
        s.block.inlines,
        Math.max(0, from - s.start),
        Math.min(s.end - s.start, to - s.start),
      ).some((i) => !i.marks?.includes(mark)),
  );
  const blocks = doc.blocks.map((block, bi) => {
    const s = spans[bi]!;
    if (s.end <= from || s.start >= to || block.kind !== "line") return block;
    const lf = Math.max(0, from - s.start);
    const lt = Math.min(s.end - s.start, to - s.start);
    const mid = sliceInlines(block.inlines, lf, lt).map((i) => {
      const m = i.marks ?? [];
      const next = hasUnmarked
        ? m.includes(mark)
          ? m
          : sortMarks([...m, mark])
        : m.filter((x) => x !== mark);
      if (i.kind === "text") return { ...i, marks: next };
      if (next.length) return { ...i, marks: next };
      const { marks: _dropped, ...rest } = i;
      return rest;
    });
    return {
      ...block,
      inlines: normalizeInlines([
        ...sliceInlines(block.inlines, 0, lf),
        ...mid,
        ...sliceInlines(block.inlines, lt, s.end - s.start),
      ]),
    };
  });
  return { doc: { blocks }, selection: { anchor: from, head: to }, changeKind: "other" };
}

export function insertPastedBlocks(
  state: ComposerEditorState,
  pasted: readonly ComposerBlock[],
): ComposerEditResult {
  if (pasted.length === 0) return { doc: state.doc, selection: state.selection };
  const col = collapseShownMarkdownSource(state);
  const working = selectionEmpty(col.selection)
    ? { doc: col.doc, selection: col.selection }
    : deleteRange(col.doc, selectionFrom(col.selection), selectionTo(col.selection));
  const pos = working.selection.head;
  const res = resolveFlatOffset(working.doc, pos);

  if (pasted.length === 1 && isPlainParagraph(pasted[0]) && res.block.kind === "line") {
    const nextInlines = normalizeInlines([
      ...sliceInlines(res.block.inlines, 0, res.offsetInBlock),
      ...pasted[0].inlines,
      ...sliceInlines(res.block.inlines, res.offsetInBlock, res.end - res.start),
    ]);
    return {
      doc: finalize(
        working.doc.blocks.map((b, i) =>
          i === res.blockIndex ? { ...res.block, inlines: nextInlines } : b,
        ),
      ),
      selection: collapsedSelection(pos + inlinesFlatLength(pasted[0].inlines)),
      changeKind: "other",
    };
  }

  const head =
    res.block.kind === "line" ? sliceInlines(res.block.inlines, 0, res.offsetInBlock) : [];
  const tail =
    res.block.kind === "line"
      ? sliceInlines(res.block.inlines, res.offsetInBlock, res.end - res.start)
      : [];
  const inserted: ComposerBlock[] = [];
  // Lines a list item or quote cannot hold go after it rather than splitting into its text.
  const holdsOneLine =
    res.block.kind === "line" && res.block.prefix !== null && res.block.prefix.kind !== "heading";
  if (holdsOneLine && head.length > 0 && tail.length === 0) {
    const blocks = [...working.doc.blocks];
    blocks.splice(res.blockIndex + 1, 0, ...pasted);
    const nextDoc = finalize(blocks);
    return {
      doc: nextDoc,
      selection: collapsedSelection(
        computeFlatBlockSpans(nextDoc)[res.blockIndex + pasted.length]!.end,
      ),
      changeKind: "other",
    };
  }
  if (head.length > 0 && res.block.kind === "line") {
    if (isPlainParagraph(pasted[0])) {
      inserted.push(
        { ...res.block, inlines: normalizeInlines([...head, ...pasted[0].inlines]) },
        ...pasted.slice(1),
      );
    } else {
      inserted.push({ ...res.block, inlines: head }, ...pasted);
    }
  } else {
    inserted.push(...pasted);
  }

  if (tail.length > 0) {
    const lastIdx = inserted.length - 1;
    const last = inserted[lastIdx]!;
    if (last.kind === "line") {
      const beforeTail = inlinesFlatLength(last.inlines);
      inserted[lastIdx] = { ...last, inlines: normalizeInlines([...last.inlines, ...tail]) };
      const blocks = [...working.doc.blocks];
      blocks.splice(res.blockIndex, 1, ...inserted);
      const nextDoc = finalize(blocks);
      return {
        doc: nextDoc,
        selection: collapsedSelection(
          computeFlatBlockSpans(nextDoc)[res.blockIndex + lastIdx]!.start + beforeTail,
        ),
        changeKind: "other",
      };
    }
    inserted.push({ kind: "line", prefix: null, inlines: tail });
  } else if (
    pasted.at(-1)?.kind === "horizontalRule" &&
    working.doc.blocks[res.blockIndex + 1]?.kind !== "line"
  ) {
    inserted.push({ kind: "line", prefix: null, inlines: [] });
  }

  const blocks = [...working.doc.blocks];
  blocks.splice(res.blockIndex, 1, ...inserted);
  const nextDoc = finalize(blocks);
  return {
    doc: nextDoc,
    selection: collapsedSelection(
      computeFlatBlockSpans(nextDoc)[res.blockIndex + inserted.length - 1]!.end,
    ),
    changeKind: "other",
  };
}

export function findCitationByKey(
  doc: ComposerDoc,
  citeKey: string,
): { blockIndex: number; flatPos: number; citation: AssistantCitation } | null {
  for (const span of computeFlatBlockSpans(doc)) {
    if (span.block.kind !== "line") continue;
    let pos = span.start;
    for (const item of span.block.inlines) {
      if (item.kind === "composer-citation" && item.citeKey === citeKey)
        return { blockIndex: span.blockIndex, flatPos: pos, citation: item.citation };
      pos += inlineFlatLength(item);
    }
  }
  return null;
}

export function updateCitationComment(
  doc: ComposerDoc,
  citeKey: string,
  comment: string,
): ComposerDoc | null {
  const found = findCitationByKey(doc, citeKey);
  if (!found) return null;
  const next = withAssistantCitationComment(found.citation, comment);
  const source = serializeAssistantCitation(next);
  return {
    blocks: doc.blocks.map((b, i) =>
      i === found.blockIndex && b.kind === "line"
        ? {
            ...b,
            inlines: b.inlines.map((item) =>
              item.kind === "composer-citation" && item.citeKey === citeKey
                ? { ...item, citation: next, source }
                : item,
            ),
          }
        : b,
    ),
  };
}

export function removeCitationByKey(
  doc: ComposerDoc,
  citeKey: string,
  removeSpaces?: CitationInsertedSpaces,
): ComposerEditResult | null {
  const found = findCitationByKey(doc, citeKey);
  if (!found) return null;
  const res = resolveFlatOffset(doc, found.flatPos);
  const text = res.block.kind === "line" ? inlinesPlainText(res.block.inlines) : "";
  const local = found.flatPos - res.start;
  const from =
    removeSpaces?.before && local > 0 && text[local - 1] === " "
      ? found.flatPos - 1
      : found.flatPos;
  const to = removeSpaces?.after && text[local + 1] === " " ? found.flatPos + 2 : found.flatPos + 1;
  return deleteRange(doc, from, to);
}

export function updateCodeBlockLanguage(
  doc: ComposerDoc,
  blockIndex: number,
  language: string,
): ComposerEditResult | null {
  const block = doc.blocks[blockIndex];
  if (!block || block.kind !== "codeBlock") return null;
  const nextDoc: ComposerDoc = {
    blocks: doc.blocks.map((b, i) => (i === blockIndex ? { ...block, language } : b)),
  };
  return {
    doc: nextDoc,
    selection: collapsedSelection(computeFlatBlockSpans(nextDoc)[blockIndex]!.end),
    changeKind: "other",
  };
}

export function toggleTaskItemChecked(
  doc: ComposerDoc,
  blockIndex: number,
  selection: ComposerEditorState["selection"],
): ComposerEditResult | null {
  const b = doc.blocks[blockIndex];
  if (!b || b.kind !== "line" || b.prefix?.kind !== "task") return null;
  const prefix = { ...b.prefix, checked: !b.prefix.checked };
  return {
    doc: { blocks: doc.blocks.map((blk, i) => (i === blockIndex ? { ...b, prefix } : blk)) },
    selection,
    changeKind: "other",
  };
}

export function selectionHasNonSourceStyledOrAtom(
  doc: ComposerDoc,
  from: number,
  to: number,
): boolean {
  for (const s of computeFlatBlockSpans(doc)) {
    if (s.end <= from || s.start >= to) continue;
    if (s.block.kind !== "line") return true;
    for (const i of sliceInlines(
      s.block.inlines,
      Math.max(0, from - s.start),
      Math.min(s.end - s.start, to - s.start),
    )) {
      if (isChipInline(i) || (!i.isMarkdownSource && i.marks.length > 0)) return true;
    }
  }
  return false;
}

export function surroundSelectionWithLiterals(
  state: ComposerEditorState,
  from: number,
  to: number,
  opener: string,
  closer: string,
): ComposerEditResult | null {
  const s = resolveFlatOffset(state.doc, from);
  if (
    s.blockIndex !== resolveFlatOffset(state.doc, to).blockIndex ||
    s.block.kind === "horizontalRule"
  )
    return null;
  if (s.block.kind === "codeBlock") {
    const a = from - s.start;
    const b = to - s.start;
    const code =
      s.block.code.slice(0, a) + opener + s.block.code.slice(a, b) + closer + s.block.code.slice(b);
    return {
      doc: {
        blocks: state.doc.blocks.map((blk, i) => (i === s.blockIndex ? { ...s.block, code } : blk)),
      },
      selection: { anchor: from + opener.length, head: to + opener.length },
      changeKind: "other",
    };
  }
  const mid = sliceInlines(s.block.inlines, from - s.start, to - s.start);
  const inSrc = mid.some((i) => i.kind === "text" && i.isMarkdownSource);
  const nextInlines = normalizeInlines([
    ...sliceInlines(s.block.inlines, 0, from - s.start),
    { kind: "text", text: opener, marks: [], ...(inSrc ? { isMarkdownSource: true } : {}) },
    ...mid,
    { kind: "text", text: closer, marks: [], ...(inSrc ? { isMarkdownSource: true } : {}) },
    ...sliceInlines(s.block.inlines, to - s.start, s.end - s.start),
  ]);
  return {
    doc: {
      blocks: state.doc.blocks.map((blk, i) =>
        i === s.blockIndex ? { ...s.block, inlines: nextInlines } : blk,
      ),
    },
    selection: { anchor: from + opener.length, head: to + opener.length },
    changeKind: "other",
  };
}

export function selectionSpansChips(doc: ComposerDoc, from: number, to: number): boolean {
  if (from >= to) return false;
  for (const s of computeFlatBlockSpans(doc)) {
    if (s.end <= from || s.start >= to || s.block.kind !== "line") continue;
    let pos = s.start;
    for (const item of s.block.inlines) {
      if (isChipInline(item) && pos < to && pos + 1 > from) return true;
      pos += inlineFlatLength(item);
    }
  }
  return false;
}

export const sameSelection = (
  a: ComposerEditorState["selection"],
  b: ComposerEditorState["selection"],
): boolean =>
  a.anchor === b.anchor &&
  a.head === b.head &&
  sameMarkSet(a.storedMarks ?? undefined, b.storedMarks ?? undefined);
