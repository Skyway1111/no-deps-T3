import {
  type ComposerBlock,
  type ComposerEditResult,
  type ComposerEditorState,
  collapsedSelection,
  isPlainParagraph,
  resolveFlatOffset,
  selectionEmpty,
  selectionFrom,
  selectionTo,
} from "~/components/composer/types";
import { isClosingFence, parseOpeningFence, serializeSelection } from "~/composer-rich-text-doc";

const INDENT = "  ";
const outdentLine = (line: string) =>
  line.startsWith(INDENT) ? line.slice(INDENT.length) : line.startsWith("\t") || line.startsWith(" ") ? line.slice(1) : line;

function codeBlockRange(state: ComposerEditorState) {
  const start = resolveFlatOffset(state.doc, selectionFrom(state.selection));
  const end = resolveFlatOffset(state.doc, selectionTo(state.selection));
  if (start.block.kind !== "codeBlock" || start.blockIndex !== end.blockIndex) return null;
  return { blockIndex: start.blockIndex, block: start.block, from: start.start, to: start.end, text: start.block.code };
}

export const selectionInOneCodeBlock = (state: ComposerEditorState): boolean => codeBlockRange(state) !== null;

export function indentedNewlineInCodeBlock(state: ComposerEditorState): ComposerEditResult | null {
  const target = codeBlockRange(state);
  if (!target) return null;
  const selFrom = selectionFrom(state.selection);
  const startOff = selFrom - target.from;
  const endOff = selectionTo(state.selection) - target.from;
  const before = target.text.slice(0, startOff);
  const indent = /^[ \t]*/.exec(before.slice(before.lastIndexOf("\n") + 1))?.[0] ?? "";
  const inserted = `\n${indent}`;
  const nextCode = target.text.slice(0, startOff) + inserted + target.text.slice(endOff);
  return {
    doc: { blocks: state.doc.blocks.map((b, i) => (i === target.blockIndex ? { ...target.block, code: nextCode } : b)) },
    selection: collapsedSelection(selFrom + inserted.length),
    changeKind: "insert",
  };
}

export function exitCodeBlockOnTrailingBlankLines(state: ComposerEditorState): ComposerEditResult | null {
  if (!selectionEmpty(state.selection)) return null;
  const target = codeBlockRange(state);
  if (!target || state.selection.head - target.from !== target.text.length) return null;
  const trailing = /\n[ \t]*\n[ \t]*$/.exec(target.text);
  if (!trailing) return null;
  const code = target.text.slice(0, target.text.length - trailing[0].length);
  const blocks = [...state.doc.blocks];
  blocks.splice(
    target.blockIndex,
    1,
    { ...target.block, code, close: target.block.close || `\n${target.block.fence}` },
    { kind: "line", prefix: null, inlines: [] },
  );
  return { doc: { blocks }, selection: collapsedSelection(target.from + code.length + 1), changeKind: "other" };
}

export function exitCodeBlockOnClosingFence(state: ComposerEditorState): ComposerEditResult | null {
  if (!selectionEmpty(state.selection)) return null;
  const target = codeBlockRange(state);
  if (!target) return null;
  const caret = state.selection.head - target.from;
  const lineStart = target.text.lastIndexOf("\n", caret - 1) + 1;
  const nlAfter = target.text.indexOf("\n", caret);
  const lineEnd = nlAfter === -1 ? target.text.length : nlAfter;
  const line = target.text.slice(lineStart, lineEnd);
  if (caret !== lineEnd || !isClosingFence(line, target.block.fence)) return null;
  const code = target.text.slice(0, Math.max(0, lineStart - 1));
  const rest = nlAfter === -1 ? [] : target.text.slice(nlAfter + 1).split("\n");
  const para = (text: string): ComposerBlock => ({
    kind: "line",
    prefix: null,
    inlines: text ? [{ kind: "text", text, marks: [] }] : [],
  });
  const blocks = [...state.doc.blocks];
  blocks.splice(target.blockIndex, 1, { ...target.block, code, close: `\n${line}` }, para(""), ...rest.map(para));
  return { doc: { blocks }, selection: collapsedSelection(target.from + code.length + 1), changeKind: "other" };
}

export function indentCodeBlock(state: ComposerEditorState, direction: "in" | "out"): ComposerEditResult | null {
  const target = codeBlockRange(state);
  if (!target) return null;
  const from = selectionFrom(state.selection);
  const to = selectionTo(state.selection);
  const startOff = from - target.from;
  const endOff = to - target.from;
  if (from === to && direction === "in") {
    const nextCode = target.text.slice(0, startOff) + INDENT + target.text.slice(endOff);
    return {
      doc: { blocks: state.doc.blocks.map((b, i) => (i === target.blockIndex ? { ...target.block, code: nextCode } : b)) },
      selection: collapsedSelection(from + INDENT.length),
      changeKind: "insert",
    };
  }
  const lineStart = startOff === 0 ? 0 : target.text.lastIndexOf("\n", startOff - 1) + 1;
  const nlAfter = target.text.indexOf("\n", Math.max(startOff, endOff - 1));
  const lineEnd = nlAfter === -1 ? target.text.length : nlAfter;
  const orig = target.text.slice(lineStart, lineEnd).split("\n");
  const next = orig.map((l) => (direction === "in" ? (l ? `${INDENT}${l}` : l) : outdentLine(l)));
  const origStr = orig.join("\n");
  const nextStr = next.join("\n");
  if (nextStr === origStr) return { doc: state.doc, selection: state.selection };
  const nextCode = target.text.slice(0, lineStart) + nextStr + target.text.slice(lineEnd);
  const firstDelta = (next[0]?.length ?? 0) - (orig[0]?.length ?? 0);
  const nextFrom = Math.max(target.from + lineStart, from + firstDelta);
  const nextTo = Math.max(nextFrom, to + (nextStr.length - origStr.length));
  return {
    doc: { blocks: state.doc.blocks.map((b, i) => (i === target.blockIndex ? { ...target.block, code: nextCode } : b)) },
    selection: { anchor: nextFrom, head: nextTo },
    changeKind: "other",
  };
}

export function convertCodeFenceOnEnter(state: ComposerEditorState): ComposerEditResult | null {
  if (!selectionEmpty(state.selection)) return null;
  const res = resolveFlatOffset(state.doc, state.selection.head);
  if (!isPlainParagraph(res.block) || res.offsetInBlock !== res.end - res.start) return null;
  const opening = parseOpeningFence(serializeSelection(state.doc, res.start, res.end));
  if (!opening) return null;
  const codeBlock: ComposerBlock = { kind: "codeBlock", language: opening.language, fence: opening.fence, close: `\n${opening.fence}`, code: "" };
  return {
    doc: { blocks: state.doc.blocks.map((b, i) => (i === res.blockIndex ? codeBlock : b)) },
    selection: collapsedSelection(res.start),
    changeKind: "other",
  };
}

export function unwrapCodeBlockAtStart(state: ComposerEditorState): ComposerEditResult | null {
  if (!selectionEmpty(state.selection)) return null;
  const res = resolveFlatOffset(state.doc, state.selection.head);
  if (res.block.kind !== "codeBlock" || res.offsetInBlock !== 0) return null;
  const paragraphs: ComposerBlock[] = res.block.code.split("\n").map((line) => ({
    kind: "line",
    prefix: null,
    inlines: line ? [{ kind: "text", text: line, marks: [] }] : [],
  }));
  const blocks = [...state.doc.blocks];
  blocks.splice(res.blockIndex, 1, ...paragraphs);
  return { doc: { blocks }, selection: collapsedSelection(res.start), changeKind: "delete" };
}
