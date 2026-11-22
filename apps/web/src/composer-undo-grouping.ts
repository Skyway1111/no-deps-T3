const GROUP_DELAY = 1000;
export type ComposerChangeKind = "insert" | "delete" | "other";

export interface ComposerUndoMeta {
  docChanged?: boolean | undefined;
  clipboardEvent?: "paste" | "cut" | undefined;
  isComposition?: boolean | undefined;
  compositionReplace?: boolean | undefined;
  changeKind?: ComposerChangeKind | undefined;
}

function changeKindOf(meta: ComposerUndoMeta): ComposerChangeKind | null {
  if (meta.docChanged === false) return null;
  if (meta.clipboardEvent != null) return "other";
  if (meta.isComposition || meta.compositionReplace) return "insert";
  return meta.changeKind ?? "other";
}

/** Typing and deleting each group into one undo step until the kind changes or a second passes. */
export function groupUndoByChangeKind(
  meta: ComposerUndoMeta,
  previous: ComposerChangeKind | null,
  now?: number,
  previousTimestamp?: number,
): { readonly kind: ComposerChangeKind | null; readonly closeGroup: boolean } {
  const kind = changeKindOf(meta);
  if (kind === null) return { kind: previous, closeGroup: false };
  const timedOut =
    now !== undefined && previousTimestamp !== undefined && now - previousTimestamp >= GROUP_DELAY;
  const closeGroup =
    Boolean(meta.compositionReplace) ||
    timedOut ||
    (previous !== null && (kind !== previous || kind === "other"));
  return { kind, closeGroup };
}
