import { flatToMarkdown, markdownToFlat, serializeEditorDoc } from "../composer-rich-text-doc";
import {
  type ComposerContextReference,
  formatInlineContextReference,
  inlineContextReferenceReplacement,
} from "../lib/composerContextReferences";
import {
  type ComposerDocChangeEvent,
  type ComposerEditorController,
  type ComposerInline,
  collapsedSelection,
  inlinesFlatLength,
  normalizeInlines,
  resolveFlatOffset,
  selectionFrom,
  selectionTo,
  sliceInlines,
} from "./composer/types";

let nextInsertionOrder = 0;

function mapOffset(pos: number, e: ComposerDocChangeEvent, bias: -1 | 1) {
  const delta = e.insertedLength - (e.to - e.from);
  if (e.from === pos && e.to === pos) {
    return { pos: bias === 1 ? pos + e.insertedLength : pos, deletedAcross: false, deletedBefore: false, deletedAfter: false };
  }
  if (e.to <= pos) {
    return { pos: pos + delta, deletedAcross: false, deletedBefore: e.to === pos && e.from < e.to, deletedAfter: false };
  }
  if (e.from >= pos) {
    return { pos, deletedAcross: false, deletedBefore: false, deletedAfter: e.from === pos && e.to > e.from };
  }
  return { pos: bias === 1 ? e.from + e.insertedLength : e.from, deletedAcross: true, deletedBefore: true, deletedAfter: true };
}

export function captureComposerAttachmentInsertion(editor: ComposerEditorController) {
  const order = nextInsertionOrder++;
  let from = selectionFrom(editor.getState().selection);
  let to = selectionTo(editor.getState().selection);
  let lost = false;

  const dispose = editor.subscribeChanges((event) => {
    if (event.replacedWholeDoc) {
      lost = true;
      return;
    }
    const ins = event.insertionOrder;
    const followsEarlier = ins !== undefined && ins.order < order;
    if (followsEarlier && from === to && from === ins.from) {
      from = to = ins.end;
      return;
    }
    const bias: -1 | 1 = followsEarlier ? 1 : -1;
    const start = mapOffset(from, event, bias);
    const end = mapOffset(to, event, bias);
    lost ||= start.deletedAcross || end.deletedAcross;
    from = start.pos;
    to = start.deletedAfter || end.deletedBefore ? from : end.pos;
  });

  return {
    insert: (references: ReadonlyArray<ComposerContextReference>): boolean => {
      dispose();
      if (lost || editor.isDestroyed() || references.length === 0) return false;
      const { doc } = editor.getState();
      const map = serializeEditorDoc(doc);
      const edit = inlineContextReferenceReplacement(
        map.value,
        { start: flatToMarkdown(map, from), end: flatToMarkdown(map, to) },
        references,
      );
      const replaceEnd = markdownToFlat(map, edit.end);
      const startRes = resolveFlatOffset(doc, from);
      const endRes = resolveFlatOffset(doc, replaceEnd);
      if (startRes.blockIndex !== endRes.blockIndex || startRes.block.kind === "horizontalRule") return false;

      if (startRes.block.kind === "codeBlock") {
        const nextCode =
          startRes.block.code.slice(0, from - startRes.start) +
          edit.text +
          startRes.block.code.slice(replaceEnd - startRes.start);
        const insertedLength = edit.text.length;
        editor.applyEdit(
          {
            doc: { blocks: doc.blocks.map((b, i) => (i === startRes.blockIndex ? { ...startRes.block, code: nextCode } : b)) },
            selection: collapsedSelection(from + insertedLength),
            changeKind: "other",
          },
          {
            clipboardEvent: "paste",
            changeEvent: { from, to: replaceEnd, insertedLength, insertionOrder: { order, from, end: from + insertedLength } },
          },
        );
        return true;
      }

      const content: ComposerInline[] = edit.text.startsWith(" ") ? [{ kind: "text", text: " ", marks: [] }] : [];
      for (const ref of references) {
        content.push(
          { kind: "composer-context-reference", refKind: ref.kind, contextId: ref.contextId, label: ref.label, source: formatInlineContextReference(ref) },
          { kind: "text", text: " ", marks: [] },
        );
      }
      const nextInlines = normalizeInlines([
        ...sliceInlines(startRes.block.inlines, 0, from - startRes.start),
        ...content,
        ...sliceInlines(startRes.block.inlines, replaceEnd - startRes.start, startRes.end - startRes.start),
      ]);
      const insertedLength = inlinesFlatLength(content);
      editor.applyEdit(
        {
          doc: { blocks: doc.blocks.map((b, i) => (i === startRes.blockIndex ? { ...startRes.block, inlines: nextInlines } : b)) },
          selection: collapsedSelection(from + insertedLength),
          changeKind: "other",
        },
        {
          clipboardEvent: "paste",
          changeEvent: { from, to: replaceEnd, insertedLength, insertionOrder: { order, from, end: from + insertedLength } },
        },
      );
      return true;
    },
    dispose,
  };
}

export type ComposerAttachmentInsertion = ReturnType<typeof captureComposerAttachmentInsertion>;
