import type { ComposerBlock, ComposerDoc, ComposerEditorState } from "~/components/composer/types";
import { resolveFlatOffset } from "~/components/composer/types";
import { textDirection, type TextDirection } from "~/textDirection";

export interface ComposerTextDirections {
  readonly blocks: ReadonlyArray<TextDirection | null>;
}

const blockCache = new WeakMap<ComposerBlock, TextDirection | null>();
const docCache = new WeakMap<ComposerDoc, ComposerTextDirections>();

function blockDirection(block: ComposerBlock): TextDirection | null {
  let dir = blockCache.get(block);
  if (dir === undefined) {
    const prose =
      block.kind === "line"
        ? block.inlines.map((i) => (i.kind === "text" && !i.marks.includes("code") ? i.text : " ")).join("")
        : "";
    dir = textDirection(prose) ?? null;
    blockCache.set(block, dir);
  }
  return dir;
}

/** Empty/neutral lines inherit the line above; code blocks stay LTR. */
export function composerTextDirections(doc: ComposerDoc): ComposerTextDirections {
  const cached = docCache.get(doc);
  if (cached) return cached;
  const blocks: Array<TextDirection | null> = [];
  let previous: TextDirection | null = null;
  for (const block of doc.blocks) {
    if (block.kind === "codeBlock") {
      blocks.push("ltr");
      continue;
    }
    const dir = blockDirection(block) ?? previous;
    blocks.push(dir);
    previous = dir;
  }
  const result = { blocks };
  docCache.set(doc, result);
  return result;
}

export function caretLineDirection(state: ComposerEditorState): TextDirection | null {
  const { blockIndex } = resolveFlatOffset(state.doc, state.selection.head);
  return composerTextDirections(state.doc).blocks[blockIndex] ?? null;
}
