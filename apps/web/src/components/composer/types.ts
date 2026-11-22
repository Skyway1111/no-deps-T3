import type {
  AssistantCitation,
  ComposerContextClipboardFragment,
  ServerProviderSkill,
} from "@t3tools/contracts";
import type { ReactNode, RefObject } from "react";

import type { RichTextMark } from "~/composer-rich-text";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import type { ComposerAttachmentInsertion } from "../composerAttachmentInsertion";
import type { ComposerDraftContextRecords } from "../composerContextPresentation";

export type ComposerChip =
  | {
      readonly kind: "composer-mention";
      readonly path: string;
      readonly source: string;
      readonly marks?: readonly RichTextMark[];
    }
  | {
      readonly kind: "composer-skill";
      readonly skillName: string;
      readonly skillLabel: string;
      readonly skillDescription: string | null;
      readonly marks?: readonly RichTextMark[];
    }
  | {
      readonly kind: "composer-model";
      readonly instanceId: string;
      readonly model: string;
      readonly source: string;
      readonly marks?: readonly RichTextMark[];
    }
  | {
      readonly kind: "composer-citation";
      readonly citation: AssistantCitation;
      readonly source: string;
      readonly citeKey: string;
      readonly marks?: readonly RichTextMark[];
    }
  | {
      readonly kind: "composer-context-reference";
      readonly refKind: string;
      readonly contextId: string;
      readonly label: string;
      readonly source: string;
      readonly marks?: readonly RichTextMark[];
    };

export interface ComposerTextInline {
  readonly kind: "text";
  readonly text: string;
  readonly marks: readonly RichTextMark[];
  readonly isMarkdownSource?: boolean;
}

export type ComposerInline = ComposerTextInline | ComposerChip;

export type LinePrefix =
  | { readonly kind: "heading"; readonly level: number; readonly space: string }
  | { readonly kind: "quote"; readonly prefix: string }
  | {
      readonly kind: "bullet";
      readonly indent: string;
      readonly marker: string;
      readonly space: string;
    }
  | {
      readonly kind: "ordered";
      readonly indent: string;
      readonly marker: string;
      readonly space: string;
    }
  | {
      readonly kind: "task";
      readonly indent: string;
      readonly checked: boolean;
      readonly markerSpace: string;
      readonly contentSpace: string | null;
    };

export type ComposerBlock =
  | {
      readonly kind: "line";
      readonly prefix: LinePrefix | null;
      readonly inlines: readonly ComposerInline[];
    }
  | {
      readonly kind: "codeBlock";
      readonly language: string;
      readonly fence: string;
      readonly close: string;
      readonly code: string;
    }
  | { readonly kind: "horizontalRule"; readonly source: string };

export interface ComposerDoc {
  readonly blocks: readonly ComposerBlock[];
}
export interface ComposerSelection {
  readonly anchor: number;
  readonly head: number;
  readonly storedMarks?: readonly RichTextMark[] | null;
}
export interface ComposerEditorState {
  readonly doc: ComposerDoc;
  readonly selection: ComposerSelection;
}
export interface ComposerEditResult {
  readonly doc: ComposerDoc;
  readonly selection: ComposerSelection;
  readonly changeKind?: "insert" | "delete" | "other";
  readonly inputRuleUndo?: ComposerEditorState;
}

export interface ComposerDocChangeEvent {
  readonly from: number;
  readonly to: number;
  readonly insertedLength: number;
  readonly insertionOrder?: { readonly order: number; readonly from: number; readonly end: number };
  readonly replacedWholeDoc?: boolean;
}

export interface ComposerEditorController {
  readonly isDestroyed: () => boolean;
  readonly isEditable: () => boolean;
  readonly getState: () => ComposerEditorState;
  readonly subscribeChanges: (listener: (event: ComposerDocChangeEvent) => void) => () => void;
  readonly applyEdit: (
    next: ComposerEditResult,
    options?: {
      readonly addToHistory?: boolean;
      readonly clipboardEvent?: "paste" | "cut";
      readonly compositionReplace?: boolean;
      readonly silentSelection?: boolean;
      readonly changeEvent?: ComposerDocChangeEvent;
    },
  ) => void;
}

export type CitationInsertedSpaces = { before: boolean; after: boolean };
export type ComposerCitationCommentRequest = {
  previousValue: string;
  value: string;
  citationStart: number;
  sourceAnchor: AssistantCitationSourceAnchor;
  insertedSpaces: CitationInsertedSpaces;
};
export type OpenCitationComment = {
  key: string;
  sourceAnchor?: AssistantCitationSourceAnchor;
  removeOnCancel?: CitationInsertedSpaces;
};

export interface ComposerPromptEditorHandle {
  focus: () => void;
  focusAt: (cursor: number) => void;
  focusAtEnd: () => void;
  readSelectionRange: () => { start: number; end: number };
  captureAttachmentInsertion: () => ComposerAttachmentInsertion | undefined;
  requestCitationComment: (request: ComposerCitationCommentRequest) => void;
  readSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    contextIds: string[];
  };
  isCaretOnVisualEdge: (edge: "start" | "end") => boolean;
}

export interface ComposerPromptEditorProps {
  draftKey?: string;
  value: string;
  cursor: number;
  richTextEnabled?: boolean;
  literalText?: boolean;
  contextRecords: ComposerDraftContextRecords;
  buildContextClipboardFragment?:
    | ((contextIds: ReadonlyArray<string>) => string | null)
    | undefined;
  importContextFragment?:
    | ((fragment: ComposerContextClipboardFragment) => ReadonlyMap<string, string>)
    | undefined;
  skills: ReadonlyArray<ServerProviderSkill>;
  disabled: boolean;
  placeholder: string;
  placeholderSuffix?: ReactNode;
  ariaLabel?: string | undefined;
  suggestionListId?: string | undefined;
  activeSuggestionId?: string | undefined;
  isPathQueryActive?: () => boolean;
  containerClassName?: string;
  className?: string;
  placeholderClassName?: string;
  onChange: (
    nextValue: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
    contextIds: string[],
    textChanged: boolean,
    /** True when the change came from undo or redo. */
    fromHistory?: boolean,
  ) => void;
  onVisibleSelectionChange?: () => void;
  onCommandKeyDown?: (key: string, event: KeyboardEvent, isTaskItem?: boolean) => boolean;
  onPageScrollKeyDown?: (key: "PageUp" | "PageDown") => void;
  onPageScrollKeyUp?: (key: string) => void;
  onPageScrollRelease?: () => void;
  onCitationSubmitAndSend?: () => boolean;
  onCitationDraftSave?: (replacedValue: string, savedValue: string) => void;
  onPaste: React.ClipboardEventHandler<HTMLElement>;
  editorRef: RefObject<ComposerPromptEditorHandle | null>;
}

export interface FlatBlockSpan {
  readonly blockIndex: number;
  readonly block: ComposerBlock;
  readonly start: number;
  readonly end: number;
}
export interface ResolvedFlatOffset extends FlatBlockSpan {
  readonly offsetInBlock: number;
}

export const MARK_ORDER: readonly RichTextMark[] = ["strike", "bold", "italic", "code"];
export const sortMarks = (marks: readonly RichTextMark[]): RichTextMark[] =>
  [...marks].sort((a, b) => MARK_ORDER.indexOf(a) - MARK_ORDER.indexOf(b));
export const selectionFrom = (s: ComposerSelection): number => Math.min(s.anchor, s.head);
export const selectionTo = (s: ComposerSelection): number => Math.max(s.anchor, s.head);
export const selectionEmpty = (s: ComposerSelection): boolean => s.anchor === s.head;
export const collapsedSelection = (
  pos: number,
  storedMarks?: readonly RichTextMark[] | null,
): ComposerSelection =>
  storedMarks === undefined ? { anchor: pos, head: pos } : { anchor: pos, head: pos, storedMarks };
export const sameMarkSet = (a?: readonly RichTextMark[], b?: readonly RichTextMark[]): boolean => {
  const l = a ?? [];
  const r = b ?? [];
  return l.length === r.length && l.every((m) => r.includes(m));
};
export const isChipInline = (item: ComposerInline): item is ComposerChip => item.kind !== "text";
export const isListPrefix = (
  p: LinePrefix | null,
): p is Extract<LinePrefix, { kind: "bullet" | "ordered" | "task" }> =>
  p !== null && (p.kind === "bullet" || p.kind === "ordered" || p.kind === "task");
export const isPlainParagraph = (
  b: ComposerBlock | undefined,
): b is Extract<ComposerBlock, { kind: "line" }> => b?.kind === "line" && b.prefix === null;
export const inlineFlatLength = (item: ComposerInline): number =>
  item.kind === "text" ? item.text.length : 1;
export const inlinesFlatLength = (items: readonly ComposerInline[]): number =>
  items.reduce((sum, item) => sum + inlineFlatLength(item), 0);
export const readChipSource = (chip: ComposerChip): string =>
  chip.kind === "composer-skill" ? (chip.skillName ? `$${chip.skillName}` : "") : chip.source;
export const inlinesPlainText = (items: readonly ComposerInline[], atom = "\uFFFC"): string =>
  items.map((i) => (i.kind === "text" ? i.text : atom)).join("");

export function normalizeInlines(inlines: readonly ComposerInline[]): ComposerInline[] {
  const out: ComposerInline[] = [];
  for (const item of inlines) {
    if (item.kind !== "text") {
      out.push(item);
      continue;
    }
    if (!item.text) continue;
    const prev = out.at(-1);
    if (
      prev?.kind === "text" &&
      Boolean(prev.isMarkdownSource) === Boolean(item.isMarkdownSource) &&
      sameMarkSet(prev.marks, item.marks)
    ) {
      out[out.length - 1] = { ...prev, text: prev.text + item.text };
    } else {
      out.push(item);
    }
  }
  return out;
}

export function isTrailingEmptyParagraphAfterRule(doc: ComposerDoc, index: number): boolean {
  const b = doc.blocks[index];
  return (
    index === doc.blocks.length - 1 &&
    index > 0 &&
    isPlainParagraph(b) &&
    b.inlines.length === 0 &&
    doc.blocks[index - 1]?.kind === "horizontalRule"
  );
}

const docSpans = new WeakMap<ComposerDoc, readonly FlatBlockSpan[]>();

export function computeFlatBlockSpans(doc: ComposerDoc): readonly FlatBlockSpan[] {
  const cached = docSpans.get(doc);
  if (cached) return cached;
  const spans: FlatBlockSpan[] = [];
  let pos = 0;
  for (let i = 0; i < doc.blocks.length; i += 1) {
    const block = doc.blocks[i]!;
    if (i > 0 && !isTrailingEmptyParagraphAfterRule(doc, i)) pos += 1;
    const start = pos;
    pos +=
      block.kind === "codeBlock"
        ? block.code.length
        : block.kind === "line"
          ? inlinesFlatLength(block.inlines)
          : 0;
    spans.push({ blockIndex: i, block, start, end: pos });
  }
  docSpans.set(doc, spans);
  return spans;
}

/** Seeds `next`'s spans from `prev`'s when only block `index` changed, by `delta` flat chars. */
export function deriveFlatBlockSpans(
  prev: ComposerDoc,
  next: ComposerDoc,
  index: number,
  delta: number,
): void {
  const spans = docSpans.get(prev);
  if (!spans || spans.length !== next.blocks.length) return;
  const out = spans.slice();
  for (let i = index; i < out.length; i += 1) {
    const s = out[i]!;
    out[i] = {
      blockIndex: i,
      block: next.blocks[i]!,
      start: i === index ? s.start : s.start + delta,
      end: s.end + delta,
    };
  }
  docSpans.set(next, out);
}

export const docFlatLength = (doc: ComposerDoc): number =>
  computeFlatBlockSpans(doc).at(-1)?.end ?? 0;

export function resolveFlatOffset(doc: ComposerDoc, rawOffset: number): ResolvedFlatOffset {
  const spans = computeFlatBlockSpans(doc);
  if (spans.length === 0) {
    return {
      blockIndex: 0,
      block: { kind: "line", prefix: null, inlines: [] },
      start: 0,
      end: 0,
      offsetInBlock: 0,
    };
  }
  const offset = Math.max(0, Math.min(rawOffset, spans.at(-1)!.end));
  let lo = 0;
  let hi = spans.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid]!.end >= offset) hi = mid;
    else lo = mid + 1;
  }
  while (lo < spans.length - 1 && spans[lo]!.block.kind === "horizontalRule") lo += 1;
  const chosen = spans[lo]!;
  return {
    ...chosen,
    offsetInBlock: Math.max(0, Math.min(offset - chosen.start, chosen.end - chosen.start)),
  };
}

export function sliceInlines(
  inlines: readonly ComposerInline[],
  start: number,
  end: number,
): ComposerInline[] {
  if (end <= start) return [];
  const out: ComposerInline[] = [];
  let pos = 0;
  for (const item of inlines) {
    const len = inlineFlatLength(item);
    if (pos + len > start && pos < end) {
      if (item.kind === "text") {
        const s = Math.max(0, start - pos);
        const e = Math.min(len, end - pos);
        if (e > s) out.push(s === 0 && e === len ? item : { ...item, text: item.text.slice(s, e) });
      } else {
        out.push(item);
      }
    }
    pos += len;
  }
  return normalizeInlines(out);
}

export function inlineBeforeOffset(
  inlines: readonly ComposerInline[],
  offset: number,
): ComposerInline | null {
  if (offset <= 0) return null;
  let pos = 0;
  for (const item of inlines) {
    const len = inlineFlatLength(item);
    if (offset > pos && offset <= pos + len) return item;
    pos += len;
  }
  return null;
}

export function inlineAfterOffset(
  inlines: readonly ComposerInline[],
  offset: number,
): ComposerInline | null {
  let pos = 0;
  for (const item of inlines) {
    const len = inlineFlatLength(item);
    if (offset >= pos && offset < pos + len) return item;
    pos += len;
  }
  return null;
}

export function adjacentChipAt(
  doc: ComposerDoc,
  flatOffset: number,
  direction: -1 | 1,
): { readonly chip: ComposerChip; readonly start: number; readonly end: number } | null {
  const res = resolveFlatOffset(doc, flatOffset);
  if (res.block.kind !== "line") return null;
  let pos = res.start;
  for (const item of res.block.inlines) {
    const len = inlineFlatLength(item);
    if (isChipInline(item)) {
      if (direction === -1 && pos + 1 === flatOffset)
        return { chip: item, start: pos, end: pos + 1 };
      if (direction === 1 && pos === flatOffset) return { chip: item, start: pos, end: pos + 1 };
    }
    pos += len;
  }
  return null;
}

export const isCaretAdjacentToChip = (doc: ComposerDoc, flatOffset: number): boolean =>
  adjacentChipAt(doc, flatOffset, -1) !== null || adjacentChipAt(doc, flatOffset, 1) !== null;
