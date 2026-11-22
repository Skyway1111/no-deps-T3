import type { ComposerBlock, ComposerDoc, ComposerEditorState } from "~/components/composer/types";
import { resolveFlatOffset } from "~/components/composer/types";
import { textDirection, type TextDirection } from "~/textDirection";

export interface ComposerTextDirections {
  readonly blocks: ReadonlyArray<TextDirection | null>;
}

const proseCache = new WeakMap<ComposerBlock, string>();
const blockDirCache = new WeakMap<ComposerBlock, TextDirection | null>();
const docCache = new WeakMap<ComposerDoc, ComposerTextDirections>();

function prose(block: ComposerBlock): string {
  let text = proseCache.get(block);
  if (text === undefined) {
    text =
      block.kind === "line"
        ? block.inlines
            .map((i) => (i.kind === "text" && !i.marks.includes("code") ? i.text : " "))
            .join("")
        : "";
    proseCache.set(block, text);
  }
  return text;
}

function blockDirection(block: ComposerBlock): TextDirection | null {
  const cached = blockDirCache.get(block);
  if (cached !== undefined) return cached;
  const dir = textDirection(prose(block)) ?? null;
  blockDirCache.set(block, dir);
  return dir;
}

const groupOf = (block: ComposerBlock | undefined) =>
  block?.kind !== "line" || !block.prefix || block.prefix.kind === "heading"
    ? null
    : block.prefix.kind === "quote"
      ? "quote"
      : "list";

/** A list or quote takes one direction from all its lines; neutral lines inherit the line above; code stays LTR. */
export function composerTextDirections(doc: ComposerDoc): ComposerTextDirections {
  const cached = docCache.get(doc);
  if (cached) return cached;
  const blocks: Array<TextDirection | null> = [];
  let previous: TextDirection | null = null;
  for (let i = 0; i < doc.blocks.length;) {
    const block = doc.blocks[i]!;
    if (block.kind === "codeBlock") {
      blocks.push("ltr");
      i += 1;
      continue;
    }
    const group = groupOf(block);
    let end = i + 1;
    if (group) while (groupOf(doc.blocks[end]) === group) end += 1;
    const own =
      end - i === 1
        ? blockDirection(block)
        : textDirection(doc.blocks.slice(i, end).map(prose).join(" "));
    const dir: TextDirection | null = own ?? previous;
    for (; i < end; i += 1) blocks.push(dir);
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
