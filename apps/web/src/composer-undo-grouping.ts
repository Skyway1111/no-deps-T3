export const COMPOSER_UNDO_GROUP_DELAY = 1000;
export type ComposerChangeKind = "insert" | "delete" | "other";

export interface ComposerUndoMeta {
  docChanged?: boolean;
  isHistory?: boolean;
  uiEvent?: string;
  clipboardEvent?: "paste" | "cut";
  isComposition?: boolean;
  compositionReplace?: boolean;
  changeKind?: ComposerChangeKind;
}

export const markAsClipboardEdit = <T extends ComposerUndoMeta>(meta: T, event: "paste" | "cut"): T => ({
  ...meta,
  clipboardEvent: event,
});

export const markAsCompositionReplace = <T extends ComposerUndoMeta>(meta: T): T => ({
  ...meta,
  compositionReplace: true,
});

export function changeKindOf(meta: ComposerUndoMeta): ComposerChangeKind | null {
  if (meta.docChanged === false) return null;
  if (meta.uiEvent === "paste" || meta.uiEvent === "drop" || meta.uiEvent === "cut" || meta.clipboardEvent != null) {
    return "other";
  }
  if (meta.isComposition || meta.compositionReplace) return "insert";
  return meta.changeKind ?? "other";
}

export function groupUndoByChangeKind(
  meta: ComposerUndoMeta,
  previous: ComposerChangeKind | null,
  now?: number,
  previousTimestamp?: number,
): { readonly kind: ComposerChangeKind | null; readonly closeGroup: boolean } {
  if (meta.isHistory) return { kind: "other", closeGroup: true };
  const kind = changeKindOf(meta);
  if (kind === null) return { kind: previous, closeGroup: false };
  const timedOut =
    now !== undefined && previousTimestamp !== undefined && now - previousTimestamp >= COMPOSER_UNDO_GROUP_DELAY;
  const closeGroup =
    Boolean(meta.compositionReplace) ||
    timedOut ||
    (previous !== null && (kind !== previous || kind === "other"));
  return { kind, closeGroup };
}
