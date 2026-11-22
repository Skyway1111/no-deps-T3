import { useAtomValue } from "@effect/atom-react";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextClipboardHtml,
} from "@t3tools/shared/composerContextClipboard";
import {
  Fragment,
  use,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";

import {
  clampCollapsedComposerCursor,
  collapseExpandedComposerCursor,
  expandCollapsedComposerCursor,
  pastedPathQueryLength,
} from "~/composer-logic";
import { indentCodeBlock, selectionInOneCodeBlock } from "~/composer-code-block";
import {
  collectComposerPromptInlineTokens,
  selectionTouchesMentionBoundary,
} from "~/composer-editor-mentions";
import { normalizeMarkdownSource, touchesMarkdownSource } from "~/composer-markdown-source";
import {
  applySkillChipReplacements,
  buildComposerBlocks,
  buildComposerDoc,
  flatToMarkdown,
  indentListItemForTab,
  markdownToFlat,
  serializeEditorDoc,
  serializedMarkdownOffset,
  serializeSelection,
  skillChipReplacements,
  stepCaretAcrossStyledEdge,
  surroundSelectionWithMark,
} from "~/composer-rich-text-doc";
import { caretLineDirection } from "~/composer-text-direction";
import { useStableCallback } from "~/hooks/useStableCallback";
import { isRichTextFormattingShortcut, isThreadNavigationShortcut } from "~/keybindings";
import { collectInlineContextIds } from "~/lib/composerContextReferences";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { cn, isMacPlatform } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { hasCommandForKeyDown } from "~/shortcuts/dispatcher";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { resolveAssistantCitationCommentDismissal } from "../chat/assistantCitationCommentDismissal";
import { modelMentionKey, modelMentionKeysAtom } from "../chat/ModelMentionChip";
import { getTimelinePageScrollKey } from "../chat/pageScrollController";
import { captureComposerAttachmentInsertion } from "../composerAttachmentInsertion";
import {
  createCodeBlockHighlighter,
  type ComposerCodeBlockHighlighter,
} from "../composerCodeBlockHighlight";
import {
  ComposerContextActionsContext,
  ComposerContextRecordsContext,
} from "../composerContextPresentation";
import {
  importPastedComposerText,
  readPastedComposerContext,
  readPastedPlainText,
} from "../composerInlineTokenPaste";
import { didComposerSelectionChangeVisibly } from "../composerSelection";
import {
  ComposerCitationCommentContext,
  RichComposerSkillsContext,
  composerSkillMeta,
} from "./ComposerChips";
import { ComposerDocView } from "./ComposerDocView";
import {
  applyFlatSelectionToDom,
  domSelectionToFlat,
  isCaretOnVisualEdge,
  readDocFromDom,
  revealCaretInScroller,
} from "./domSync";
import {
  deleteBackward,
  deleteForward,
  deleteRange,
  findCitationByKey,
  insertLineBreak,
  insertPastedBlocks,
  insertText,
  removeCitationByKey,
  sameSelection,
  selectionHasNonSourceStyledOrAtom,
  selectionSpansChips,
  surroundSelectionWithLiterals,
  toggleInlineMark,
  toggleTaskItemChecked,
  updateCitationComment,
  updateCodeBlockLanguage,
} from "./edits";
import { ComposerHistory } from "./history";
import {
  type CitationInsertedSpaces,
  type ComposerCitationCommentRequest,
  type ComposerDocChangeEvent,
  type ComposerEditResult,
  type ComposerEditorController,
  type ComposerEditorState,
  type ComposerPromptEditorHandle,
  type ComposerPromptEditorProps,
  type OpenCitationComment,
  adjacentChipAt,
  collapsedSelection,
  computeFlatBlockSpans,
  docFlatLength,
  isCaretAdjacentToChip,
  isListPrefix,
  isPlainParagraph,
  resolveFlatOffset,
  selectionEmpty,
  selectionFrom,
  selectionTo,
} from "./types";

export type {
  ComposerCitationCommentRequest,
  ComposerPromptEditorHandle,
  ComposerPromptEditorProps,
};

const SURROUND_CLOSE: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
  "'": "'",
  '"': '"',
  "“": "”",
  "`": "`",
  "<": ">",
  "«": "»",
  "*": "*",
  _: "_",
};

// A token can only collapse the cursor if its first character precedes it (`!` of `![...](...)` is followed by `[`).
const TOKEN_START = /[@[\p{Sc}]/u;

/** collapseExpandedComposerCursor, skipping its full-prompt token scan when nothing before the cursor can start a token. */
function collapseCursor(value: string, expanded: number, literalText: boolean): number {
  return literalText ||
    TOKEN_START.test(value.slice(0, expanded + 1)) ||
    value.lastIndexOf("model:", expanded - 1) !== -1
    ? collapseExpandedComposerCursor(value, expanded, literalText)
    : Math.max(0, Math.min(value.length, expanded));
}

const clampCursorFor = (literalText: boolean, t: string, p: number) =>
  literalText
    ? Math.max(0, Math.min(t.length, Number.isFinite(p) ? Math.floor(p) : t.length))
    : clampCollapsedComposerCursor(t, p);
const expandCursorFor = (literalText: boolean, t: string, p: number) =>
  literalText ? p : expandCollapsedComposerCursor(t, p);

export function ComposerPromptEditor(props: ComposerPromptEditorProps) {
  const restoreFocusRef = useRef(false);
  const { onChange: onPromptChange } = props;
  // The last reported caret, so a remounted inner editor restores the exact expanded offset.
  const [lastSelection, setLastSelection] = useState<LastSelection | null>(null);
  const onChange: ComposerPromptEditorProps["onChange"] = (
    value,
    cursor,
    expandedCursor,
    ...rest
  ) => {
    setLastSelection({ value, cursor, expandedCursor });
    onPromptChange(value, cursor, expandedCursor, ...rest);
  };
  return (
    <ComposerPromptEditorInner
      key={`${props.draftKey ?? ""}:${props.literalText ? "literal" : props.richTextEnabled ? "rich" : "plain"}`}
      {...props}
      restoreFocusRef={restoreFocusRef}
      lastSelection={lastSelection}
      onChange={onChange}
    />
  );
}

interface LastSelection {
  readonly value: string;
  readonly cursor: number;
  readonly expandedCursor: number;
}

function ComposerPromptEditorInner(
  props: ComposerPromptEditorProps & {
    lastSelection: LastSelection | null;
    restoreFocusRef: RefObject<boolean>;
  },
) {
  const {
    value,
    cursor,
    richTextEnabled,
    literalText = false,
    contextRecords,
    buildContextClipboardFragment,
    importContextFragment,
    skills,
    disabled,
    placeholder,
    ariaLabel,
    suggestionListId,
    activeSuggestionId,
    isPathQueryActive,
    containerClassName,
    className,
    placeholderClassName,
    placeholderSuffix,
    onChange,
    onVisibleSelectionChange,
    onCommandKeyDown,
    onPageScrollKeyDown,
    onPageScrollKeyUp,
    onPageScrollRelease,
    onCitationSubmitAndSend,
    onCitationDraftSave,
    onPaste,
    editorRef,
    restoreFocusRef,
    lastSelection,
  } = props;

  const richText = !literalText && (richTextEnabled ?? false);
  const clampCursor = (t: string, p: number) => clampCursorFor(literalText, t, p);
  const expandCursor = (t: string, p: number) => expandCursorFor(literalText, t, p);

  const { environmentId } = use(ComposerContextActionsContext);
  const modelKeys = useAtomValue(modelMentionKeysAtom(environmentId ?? ""));
  const skillLabelFor = useStableCallback((name: string) => composerSkillMeta(skills, name));
  const isKnownModel = useStableCallback((instanceId: string, model: string) =>
    modelKeys.has(modelMentionKey(instanceId, model)),
  );
  const readCallbacks = useStableCallback(() => ({
    onChange,
    onVisibleSelectionChange,
    onCommandKeyDown,
    isPathQueryActive,
    importContextFragment,
  }));

  const [{ initialCursor, initialExpandedCursor }] = useState(() => {
    const expanded =
      lastSelection?.value === value && lastSelection.cursor === cursor
        ? lastSelection.expandedCursor
        : expandCollapsedComposerCursor(value, cursor, literalText);
    return {
      initialCursor: clampCursor(value, cursor),
      initialExpandedCursor: Math.max(0, Math.min(value.length, expanded)),
    };
  });

  const [editorState, setEditorState] = useState<ComposerEditorState>(() => {
    const doc = buildComposerDoc(value, (n) => composerSkillMeta(skills, n), {
      styling: richText,
      literalText,
      isKnownModel: (inst, mod) => modelKeys.has(modelMentionKey(inst, mod)),
    });
    const map = serializeEditorDoc(doc);
    return {
      doc,
      selection: collapsedSelection(
        markdownToFlat(map, serializedMarkdownOffset(value, map.value, initialExpandedCursor)),
      ),
    };
  });

  const [domRevision, setDomRevision] = useState(0);
  const [, setHighlightTick] = useState(0);
  const [isFocused, setIsFocused] = useState(false);
  const [openCitation, setOpenCitation] = useState<OpenCitationComment | null>(null);

  const stateRef = useRef(editorState);
  stateRef.current = editorState;
  const domRef = useRef<HTMLDivElement | null>(null);
  const historyRef = useRef(new ComposerHistory());
  const listenersRef = useRef<Set<(e: ComposerDocChangeEvent) => void>>(new Set());
  const destroyedRef = useRef(false);
  const composingRef = useRef(false);
  const syncingSelRef = useRef(false);
  const pendingRevealRef = useRef(false);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const latestValueRef = useRef(value);
  const appliedControlledRef = useRef(false);
  const citationReqRef = useRef<ComposerCitationCommentRequest | null>(null);
  const citationDraftRef = useRef<{ key: string; comment: string } | null>(null);
  const snapshotRef = useRef({
    value,
    cursor: initialCursor,
    expandedCursor: initialExpandedCursor,
    contextIds: literalText ? [] : collectInlineContextIds(value),
  });
  const selRangeRef = useRef({ start: initialExpandedCursor, end: initialExpandedCursor });

  const highlighterRef = useRef<ComposerCodeBlockHighlighter | null>(null);
  highlighterRef.current ??= createCodeBlockHighlighter({
    resolveTheme: () =>
      resolveDiffThemeName(
        typeof document !== "undefined" && document.documentElement.classList.contains("dark")
          ? "dark"
          : "light",
      ),
    onUpdate: () => setHighlightTick((t) => t + 1),
  });

  useEffect(() => {
    destroyedRef.current = false;
    const hl = highlighterRef.current;
    return () => {
      destroyedRef.current = true;
      hl?.dispose();
    };
  }, []);

  useEffect(() => {
    if (richText) highlighterRef.current?.syncDoc(editorState.doc, true);
  }, [editorState.doc, richText]);

  const emitChange = (e: ComposerDocChangeEvent) => {
    for (const fn of listenersRef.current) fn(e);
  };

  const notifyHost = (
    next: ComposerEditorState,
    opts?: { silentSelection?: boolean; skipEmit?: boolean },
  ) => {
    const map = serializeEditorDoc(next.doc);
    const contextIds = literalText ? [] : [...map.contextIds];
    const fromFlat = selectionFrom(next.selection);
    const toFlat = selectionTo(next.selection);
    const nextValue = map.value;
    const nextExpanded = Math.max(0, Math.min(nextValue.length, flatToMarkdown(map, fromFlat)));
    const nextCursor = collapseCursor(nextValue, nextExpanded, literalText);
    const toMd = flatToMarkdown(map, toFlat);
    const nextRange = { start: Math.min(nextExpanded, toMd), end: Math.max(nextExpanded, toMd) };
    const prevRange = selRangeRef.current;
    selRangeRef.current = nextRange;
    if (opts?.skipEmit || opts?.silentSelection) return;

    const prev = snapshotRef.current;
    const changed = !(
      prev.value === nextValue &&
      prev.cursor === nextCursor &&
      prev.expandedCursor === nextExpanded &&
      prev.contextIds.length === contextIds.length &&
      prev.contextIds.every((id, i) => id === contextIds[i])
    );
    if (!changed) {
      if (didComposerSelectionChangeVisibly(prevRange, nextRange))
        readCallbacks().onVisibleSelectionChange?.();
      return;
    }
    if (prev.value === nextValue && nextValue !== latestValueRef.current) return;
    snapshotRef.current = {
      value: nextValue,
      cursor: nextCursor,
      expandedCursor: nextExpanded,
      contextIds,
    };
    const suppressTrigger =
      literalText ||
      resolveFlatOffset(next.doc, fromFlat).block.kind === "codeBlock" ||
      isCaretAdjacentToChip(next.doc, fromFlat);
    readCallbacks().onChange(
      nextValue,
      nextCursor,
      nextExpanded,
      suppressTrigger,
      contextIds,
      prev.value !== nextValue,
    );
  };

  const commit = (
    next: ComposerEditResult,
    opts?: {
      addToHistory?: boolean;
      clipboardEvent?: "paste" | "cut";
      compositionReplace?: boolean;
      isComposition?: boolean;
      silentSelection?: boolean;
      skipEmit?: boolean;
      revealCaret?: boolean;
      bumpDom?: boolean;
      changeEvent?: ComposerDocChangeEvent;
    },
  ) => {
    const prev = stateRef.current;
    const docChanged = next.doc !== prev.doc;
    if (docChanged && opts?.addToHistory !== false) {
      historyRef.current.record(
        prev,
        {
          docChanged: true,
          clipboardEvent: opts?.clipboardEvent,
          compositionReplace: opts?.compositionReplace,
          isComposition: opts?.isComposition,
          changeKind: next.changeKind ?? "other",
        },
        Date.now(),
        next.inputRuleUndo,
      );
    } else if (!docChanged && !sameSelection(prev.selection, next.selection)) {
      historyRef.current.clearInputRuleUndo();
    }
    let finalState: ComposerEditorState = { doc: next.doc, selection: next.selection };
    if (richText && !composingRef.current) {
      const normalized = normalizeMarkdownSource(finalState, docChanged);
      if (normalized) finalState = normalized;
    }
    stateRef.current = finalState;
    if (opts?.revealCaret) pendingRevealRef.current = true;
    if (opts?.bumpDom) setDomRevision((r) => r + 1);
    setEditorState(finalState);
    if (docChanged) {
      emitChange(
        opts?.changeEvent ?? {
          from: selectionFrom(prev.selection),
          to: selectionTo(prev.selection),
          insertedLength: Math.max(
            0,
            docFlatLength(finalState.doc) -
              docFlatLength(prev.doc) +
              (selectionTo(prev.selection) - selectionFrom(prev.selection)),
          ),
        },
      );
    }
    notifyHost(finalState, opts);
  };

  const controllerRef = useRef<ComposerEditorController | null>(null);
  controllerRef.current ??= {
    isDestroyed: () => destroyedRef.current,
    isEditable: () => !disabledRef.current,
    getState: () => stateRef.current,
    subscribeChanges: (fn) => {
      listenersRef.current.add(fn);
      return () => {
        listenersRef.current.delete(fn);
      };
    },
    applyEdit: (next, opts) => commit(next, { ...opts, revealCaret: true }),
  };

  useLayoutEffect(() => {
    const root = domRef.current;
    if (!root || composingRef.current) return;
    if (document.activeElement === root) {
      syncingSelRef.current = true;
      applyFlatSelectionToDom(root, editorState.doc, editorState.selection);
      if (pendingRevealRef.current) {
        pendingRevealRef.current = false;
        revealCaretInScroller(root);
      }
      queueMicrotask(() => {
        syncingSelRef.current = false;
      });
    } else {
      pendingRevealRef.current = false;
    }
  }, [editorState, domRevision]);

  const onSelectionChange = useEffectEvent(() => {
    if (syncingSelRef.current || composingRef.current) return;
    const root = domRef.current;
    if (!root || document.activeElement !== root) return;
    const sel = domSelectionToFlat(root, stateRef.current.doc);
    if (
      !sel ||
      (sel.anchor === stateRef.current.selection.anchor &&
        sel.head === stateRef.current.selection.head)
    )
      return;
    commit({ doc: stateRef.current.doc, selection: sel }, { addToHistory: false });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the document's native selectionchange event
  useEffect(() => {
    const onSel = () => onSelectionChange();
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  const resumeFocusRef = useRef(false);
  useEffect(() => {
    const dom = domRef.current;
    if (!dom) return;
    const owner = dom.ownerDocument;
    if (disabled) {
      if (owner.activeElement === dom) resumeFocusRef.current = true;
      if (!resumeFocusRef.current) return;
      const cancel = (e: FocusEvent) => {
        if (!e.composedPath().includes(dom)) resumeFocusRef.current = false;
      };
      owner.addEventListener("focusin", cancel, true);
      return () => owner.removeEventListener("focusin", cancel, true);
    }
    if (!resumeFocusRef.current) return;
    resumeFocusRef.current = false;
    if (owner.activeElement === owner.body || owner.activeElement === dom) {
      dom.focus();
      applyFlatSelectionToDom(dom, stateRef.current.doc, stateRef.current.selection);
    }
  }, [disabled]);

  const readSnapshot = () => {
    const map = serializeEditorDoc(stateRef.current.doc);
    const expanded = Math.max(
      0,
      Math.min(map.value.length, flatToMarkdown(map, selectionFrom(stateRef.current.selection))),
    );
    const next = {
      value: map.value,
      cursor: collapseCursor(map.value, expanded, literalText),
      expandedCursor: expanded,
      contextIds: literalText ? [] : [...map.contextIds],
    };
    const toMd = flatToMarkdown(map, selectionTo(stateRef.current.selection));
    selRangeRef.current = { start: Math.min(expanded, toMd), end: Math.max(expanded, toMd) };
    snapshotRef.current = next;
    return next;
  };

  const openPendingCitation = (
    doc: ComposerEditorState["doc"],
    req: ComposerCitationCommentRequest,
  ) => {
    const map = serializeEditorDoc(doc);
    if (map.value !== req.value) return;
    const run = map.runs.find(
      (r) =>
        r.kind === "token" && r.nodeName === "composer-citation" && r.mdStart === req.citationStart,
    );
    const chip = run ? adjacentChipAt(doc, run.flatStart, 1)?.chip : null;
    if (chip?.kind === "composer-citation") {
      citationReqRef.current = null;
      setOpenCitation({
        key: chip.citeKey,
        sourceAnchor: req.sourceAnchor,
        removeOnCancel: req.insertedSpaces,
      });
    }
  };

  const saveCitationDraft = useEffectEvent((replacedValue: string) => {
    const draft = citationDraftRef.current;
    citationDraftRef.current = null;
    if (!draft || !onCitationDraftSave) return;
    const target = findCitationByKey(stateRef.current.doc, draft.key);
    if (!target) return;
    const dismissal = resolveAssistantCitationCommentDismissal({
      reason: "none",
      draft: draft.comment,
      savedComment: target.citation.comment,
    });
    if (dismissal.kind !== "commit") return;
    const updated = updateCitationComment(stateRef.current.doc, draft.key, dismissal.comment);
    if (updated) onCitationDraftSave(replacedValue, serializeEditorDoc(updated).value);
  });

  useLayoutEffect(() => {
    latestValueRef.current = value;
    const initial = !appliedControlledRef.current;
    appliedControlledRef.current = true;
    const prev = snapshotRef.current;
    // The host echoing our own snapshot back: its cursor is already clamped.
    if (!initial && prev.value === value && prev.cursor === cursor) return;
    const normCursor = clampCursorFor(literalText, value, cursor);
    if (!initial && prev.value === value && prev.cursor === normCursor) return;

    const normExpanded = initial
      ? initialExpandedCursor
      : expandCursorFor(literalText, value, normCursor);
    snapshotRef.current = {
      value,
      cursor: normCursor,
      expandedCursor: normExpanded,
      contextIds: literalText ? [] : collectInlineContextIds(value),
    };
    selRangeRef.current = { start: normExpanded, end: normExpanded };
    const root = domRef.current;
    const focused = Boolean(root && document.activeElement === root);
    if (!initial && prev.value === value && !focused) return;

    let nextDoc = stateRef.current.doc;
    if (prev.value !== value) {
      saveCitationDraft(prev.value);
      nextDoc = buildComposerDoc(value, skillLabelFor, {
        styling: richText,
        literalText,
        isKnownModel,
      });
      historyRef.current.reset();
      emitChange({ from: 0, to: 0, insertedLength: 0, replacedWholeDoc: true });
    }
    const map = serializeEditorDoc(nextDoc);
    let nextState: ComposerEditorState = {
      doc: nextDoc,
      selection: collapsedSelection(
        markdownToFlat(map, serializedMarkdownOffset(value, map.value, normExpanded)),
      ),
    };
    if (richText) {
      const normalized = normalizeMarkdownSource(nextState, false);
      if (normalized) {
        const nm = serializeEditorDoc(normalized.doc);
        nextState = {
          doc: normalized.doc,
          selection: collapsedSelection(
            markdownToFlat(nm, serializedMarkdownOffset(value, nm.value, normExpanded)),
          ),
        };
      }
    }
    stateRef.current = nextState;
    pendingRevealRef.current = focused;
    setEditorState(nextState);
    if (initial && !focused) {
      window.requestAnimationFrame(() => {
        if (!destroyedRef.current && domRef.current) {
          applyFlatSelectionToDom(
            domRef.current,
            stateRef.current.doc,
            stateRef.current.selection,
          );
          revealCaretInScroller(domRef.current);
        }
      });
    }
    if (citationReqRef.current?.value === value)
      openPendingCitation(nextState.doc, citationReqRef.current);
  }, [cursor, isKnownModel, literalText, richText, skillLabelFor, value]);

  useEffect(() => {
    if (literalText) return;
    const reps = skillChipReplacements(
      stateRef.current.doc,
      (n) => composerSkillMeta(skills, n),
      (inst, mod) => modelKeys.has(modelMentionKey(inst, mod)),
    );
    if (reps.length === 0) return;
    const nextDoc = applySkillChipReplacements(stateRef.current.doc, reps);
    const maxLen = docFlatLength(nextDoc);
    commit(
      {
        doc: nextDoc,
        selection: {
          anchor: Math.min(stateRef.current.selection.anchor, maxLen),
          head: Math.min(stateRef.current.selection.head, maxLen),
        },
      },
      { addToHistory: false, skipEmit: true },
    );
  }, [literalText, modelKeys, skills]);

  useLayoutEffect(() => {
    const root = domRef.current;
    if (!root) return;
    if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      root.focus();
      applyFlatSelectionToDom(root, stateRef.current.doc, stateRef.current.selection);
      revealCaretInScroller(root);
    }
    return () => {
      restoreFocusRef.current = document.activeElement === root;
    };
  }, [restoreFocusRef]);

  const focusAt = (nextCursor: number, exactExpanded?: number) => {
    const root = domRef.current;
    if (!root) return;
    root.focus();
    if (snapshotRef.current.value !== latestValueRef.current) return;
    const bounded = clampCursor(snapshotRef.current.value, nextCursor);
    const expanded = exactExpanded ?? expandCursor(snapshotRef.current.value, bounded);
    const map = serializeEditorDoc(stateRef.current.doc);
    const flatPos = markdownToFlat(
      map,
      serializedMarkdownOffset(snapshotRef.current.value, map.value, expanded),
    );
    commit(
      { doc: stateRef.current.doc, selection: collapsedSelection(flatPos) },
      { addToHistory: false, skipEmit: true, revealCaret: true },
    );
    applyFlatSelectionToDom(root, stateRef.current.doc, stateRef.current.selection);
    revealCaretInScroller(root);
    if (bounded === snapshotRef.current.cursor) return;
    snapshotRef.current = { ...snapshotRef.current, cursor: bounded, expandedCursor: expanded };
    selRangeRef.current = { start: expanded, end: expanded };
    readCallbacks().onChange(
      snapshotRef.current.value,
      bounded,
      expanded,
      literalText,
      snapshotRef.current.contextIds,
      false,
    );
  };

  const focusAtStable = useStableCallback(focusAt);
  const readSnapshotStable = useStableCallback(readSnapshot);
  const openPendingCitationStable = useStableCallback(openPendingCitation);
  useImperativeHandle(
    editorRef,
    () => ({
      focus: () => focusAtStable(snapshotRef.current.cursor, snapshotRef.current.expandedCursor),
      focusAt: (c) => focusAtStable(c),
      focusAtEnd: () =>
        focusAtStable(
          collapseCursor(snapshotRef.current.value, snapshotRef.current.value.length, literalText),
        ),
      readSelectionRange: () => {
        readSnapshotStable();
        return selRangeRef.current;
      },
      captureAttachmentInsertion: () =>
        controllerRef.current
          ? captureComposerAttachmentInsertion(controllerRef.current)
          : undefined,
      requestCitationComment: (req) => {
        citationReqRef.current = req;
        openPendingCitationStable(stateRef.current.doc, req);
      },
      readSnapshot: readSnapshotStable,
      isCaretOnVisualEdge: (edge) => {
        const s = readSnapshotStable();
        return isCaretOnVisualEdge(domRef.current, s.value, s.expandedCursor, edge);
      },
    }),
    [focusAtStable, literalText, openPendingCitationStable, readSnapshotStable],
  );

  const runHistory = (dir: "undo" | "redo") => {
    if (disabled) return;
    const entry =
      dir === "undo"
        ? historyRef.current.undo(stateRef.current)
        : historyRef.current.redo(stateRef.current);
    if (!entry) return;
    let restored = entry;
    if (!literalText) {
      const stale = skillChipReplacements(entry.doc, skillLabelFor, isKnownModel).filter(
        (r) => r.inline.kind === "text",
      );
      if (stale.length > 0) {
        const nextDoc = applySkillChipReplacements(entry.doc, stale);
        const maxLen = docFlatLength(nextDoc);
        restored = {
          doc: nextDoc,
          selection: {
            anchor: Math.min(entry.selection.anchor, maxLen),
            head: Math.min(entry.selection.head, maxLen),
          },
        };
      }
    }
    commit(restored, { addToHistory: false, revealCaret: true });
  };

  const handleInsertOrSurround = (text: string) => {
    const state = stateRef.current;
    const from = selectionFrom(state.selection);
    const to = selectionTo(state.selection);
    const closer =
      !literalText && !composingRef.current && text.length === 1 ? SURROUND_CLOSE[text] : undefined;
    if (closer && from < to && !selectionHasNonSourceStyledOrAtom(state.doc, from, to)) {
      const map = serializeEditorDoc(state.doc);
      if (
        !selectionTouchesMentionBoundary(
          map.value,
          flatToMarkdown(map, from),
          flatToMarkdown(map, to),
        )
      ) {
        const edit =
          (richText ? surroundSelectionWithMark(state, from, to, text) : null) ??
          surroundSelectionWithLiterals(state, from, to, text, closer);
        if (edit) {
          commit(edit, { revealCaret: true });
          return;
        }
      }
    }
    commit(insertText(state, text, { richText, literalText }), { revealCaret: true });
  };

  const handleBeforeInput = useEffectEvent((e: InputEvent) => {
    if (disabled) {
      e.preventDefault();
      return;
    }
    const type = e.inputType;
    if (
      typeof type !== "string" ||
      composingRef.current ||
      e.isComposing ||
      type === "insertCompositionText" ||
      type === "deleteCompositionText"
    )
      return;
    if ((type === "insertText" || type === "insertReplacementText") && typeof e.data === "string") {
      e.preventDefault();
      handleInsertOrSurround(e.data);
      return;
    }
    if (type === "insertLineBreak" || type === "insertParagraph") {
      e.preventDefault();
      commit(insertLineBreak(stateRef.current, richText), { revealCaret: true });
      return;
    }
    if (type.startsWith("delete") && type.endsWith("Backward")) {
      e.preventDefault();
      if (type === "deleteContentBackward" && selectionEmpty(stateRef.current.selection)) {
        const undoRule = historyRef.current.consumeInputRuleUndo();
        if (undoRule) {
          commit({ ...undoRule, changeKind: "delete" }, { revealCaret: true });
          return;
        }
      }
      const res = deleteBackward(
        stateRef.current,
        type === "deleteWordBackward" ? "word" : type === "deleteContentBackward" ? "char" : "line",
      );
      if (res) commit(res, { revealCaret: true });
      return;
    }
    if (type.startsWith("delete") && type.endsWith("Forward")) {
      e.preventDefault();
      const res = deleteForward(
        stateRef.current,
        type === "deleteWordForward" ? "word" : type === "deleteContentForward" ? "char" : "line",
      );
      if (res) commit(res, { revealCaret: true });
      return;
    }
    if (type === "historyUndo" || type === "historyRedo") {
      e.preventDefault();
      runHistory(type === "historyUndo" ? "undo" : "redo");
      return;
    }
    if (type === "deleteByCut" || type === "insertFromPaste") {
      e.preventDefault();
      return;
    }
    const fmt = richText
      ? ({ formatBold: "bold", formatItalic: "italic", formatStrikeThrough: "strike" } as const)[
          type
        ]
      : undefined;
    if (fmt) {
      e.preventDefault();
      const res = toggleInlineMark(stateRef.current, fmt);
      if (res) commit(res, { revealCaret: true });
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- native beforeinput listener; React's onBeforeInput wraps legacy textInput, which has no inputType
  useEffect(() => {
    const root = domRef.current;
    if (!root) return;
    const listener = (e: InputEvent) => handleBeforeInput(e);
    root.addEventListener("beforeinput", listener);
    return () => root.removeEventListener("beforeinput", listener);
  }, []);

  const syncDom = (isComposition: boolean) => {
    const root = domRef.current;
    if (!root) return;
    const { doc, selection } = readDocFromDom(root, stateRef.current.doc);
    commit(
      { doc, selection, changeKind: "insert" },
      { isComposition, bumpDom: true, revealCaret: true },
    );
  };

  const handleKeyDown = (re: ReactKeyboardEvent<HTMLDivElement>) => {
    const ev = re.nativeEvent;
    if (ev.key === "Control" || ev.key === "Meta" || ev.key === "Alt" || ev.key === "Shift")
      onPageScrollRelease?.();
    if ((ev.key === "PageUp" || ev.key === "PageDown") && domRef.current) {
      const t = domRef.current;
      const pk = getTimelinePageScrollKey({
        altKey: ev.altKey,
        clientHeight: t.clientHeight,
        ctrlKey: ev.ctrlKey,
        defaultPrevented: ev.defaultPrevented,
        isComposing: ev.isComposing,
        key: ev.key,
        keyCode: ev.keyCode,
        metaKey: ev.metaKey,
        scrollHeight: t.scrollHeight,
        scrollTop: t.scrollTop,
        shiftKey: ev.shiftKey,
      });
      if (!pk) onPageScrollRelease?.();
      else if (onPageScrollKeyDown) {
        re.preventDefault();
        onPageScrollKeyDown(pk);
        return;
      }
    }
    if (disabled) return;
    const mac = isMacPlatform(navigator.platform);
    const mod = mac ? ev.metaKey : ev.ctrlKey;

    if (isRichTextFormattingShortcut(ev)) {
      if (readCallbacks().onCommandKeyDown?.(ev.key, ev)) {
        re.preventDefault();
        re.stopPropagation();
        return;
      }
      if (hasCommandForKeyDown(ev)) return;
      if (richText) {
        const k = ev.key.toLowerCase();
        const mark =
          k === "b" && !ev.shiftKey
            ? "bold"
            : k === "i" && !ev.shiftKey
              ? "italic"
              : k === "s" && ev.shiftKey
                ? "strike"
                : k === "e" && !ev.shiftKey
                  ? "code"
                  : null;
        if (mark) {
          re.preventDefault();
          re.stopPropagation();
          const r = toggleInlineMark(stateRef.current, mark);
          if (r) commit(r, { revealCaret: true });
          return;
        }
      }
    }
    if (mod && !ev.altKey && !ev.isComposing) {
      const k = ev.key.toLowerCase();
      if (k === "z" || (k === "y" && !mac && !ev.shiftKey)) {
        re.preventDefault();
        re.stopPropagation();
        runHistory(k === "z" && !ev.shiftKey ? "undo" : "redo");
        return;
      }
    }

    const state = stateRef.current;
    const backArrow = caretLineDirection(state) === "rtl" ? "ArrowRight" : "ArrowLeft";
    const boundary = ev.metaKey
      ? ev.key === "ArrowLeft" || ev.key === "ArrowRight"
        ? "lineboundary"
        : ev.key === "ArrowUp" || ev.key === "ArrowDown"
          ? "documentboundary"
          : null
      : ev.key === "Home" || ev.key === "End"
        ? "lineboundary"
        : null;
    if (mac && boundary && !ev.altKey && !ev.ctrlKey && !ev.isComposing) {
      if (
        isThreadNavigationShortcut(ev, appAtomRegistry.get(primaryServerKeybindingsAtom), {
          context: { editableFocus: true },
        })
      )
        return;
      const domSel = window.getSelection();
      if (
        domRef.current &&
        domSel?.anchorNode &&
        domRef.current.contains(domSel.anchorNode) &&
        typeof domSel.modify === "function"
      ) {
        re.preventDefault();
        re.stopPropagation();
        const backward = ev.key === "Home" || ev.key === "ArrowUp" || ev.key === backArrow;
        domSel.modify(ev.shiftKey ? "extend" : "move", backward ? "backward" : "forward", boundary);
        const flat = domSelectionToFlat(domRef.current, state.doc);
        if (flat)
          commit({ doc: state.doc, selection: flat }, { addToHistory: false, revealCaret: true });
        return;
      }
    }

    if (
      ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(ev.key) &&
      !ev.shiftKey &&
      !ev.altKey &&
      !ev.metaKey &&
      !ev.ctrlKey &&
      !ev.isComposing &&
      selectionEmpty(state.selection)
    ) {
      const dir: -1 | 1 = ev.key === "ArrowUp" || ev.key === backArrow ? -1 : 1;
      const horiz = ev.key === "ArrowLeft" || ev.key === "ArrowRight";
      const atEdge = state.selection.head === (dir === -1 ? 0 : docFlatLength(state.doc));
      const step = horiz || atEdge ? stepCaretAcrossStyledEdge(state, dir) : null;
      if (step) {
        re.preventDefault();
        re.stopPropagation();
        commit(step, { addToHistory: false });
        return;
      }
      if (horiz && adjacentChipAt(state.doc, state.selection.head, dir)) {
        re.preventDefault();
        re.stopPropagation();
        commit(
          { doc: state.doc, selection: collapsedSelection(state.selection.head + dir) },
          { addToHistory: false, revealCaret: true },
        );
        return;
      }
    }

    if (
      ev.key === "Tab" &&
      ev.shiftKey &&
      !ev.altKey &&
      !ev.metaKey &&
      !ev.ctrlKey &&
      selectionEmpty(state.selection)
    ) {
      const before = adjacentChipAt(state.doc, state.selection.head, -1);
      const line = before && resolveFlatOffset(state.doc, before.start);
      const btn =
        line && before.chip.kind === "composer-citation"
          ? domRef.current?.querySelector<HTMLElement>(
              `[data-composer-block-index="${line.blockIndex}"] [data-composer-chip-offset="${line.offsetInBlock}"] [data-citation-comment-trigger]`,
            )
          : null;
      if (btn) {
        re.preventDefault();
        re.stopPropagation();
        btn.focus();
        return;
      }
    }

    if (ev.key === "Enter" && (ev.isComposing || ev.keyCode === 229)) {
      re.stopPropagation();
      return;
    }
    if (ev.key === "Enter" && ev.target instanceof HTMLInputElement) {
      re.preventDefault();
      return;
    }
    if (ev.key === "Tab" && !ev.metaKey && !ev.ctrlKey && selectionInOneCodeBlock(state)) {
      re.preventDefault();
      re.stopPropagation();
      const indented = indentCodeBlock(state, ev.shiftKey ? "out" : "in");
      if (indented) commit(indented, { revealCaret: true });
      return;
    }
    // List indent stays in the model so it lands in undo history; a suggestion menu keeps Tab.
    if (
      ev.key === "Tab" &&
      richText &&
      !activeSuggestionId &&
      !ev.altKey &&
      !ev.metaKey &&
      !ev.ctrlKey &&
      !ev.isComposing &&
      selectionEmpty(state.selection)
    ) {
      const edit = indentListItemForTab(state, ev.shiftKey, (next) =>
        buildComposerDoc(next, skillLabelFor, { styling: true, isKnownModel }),
      );
      if (edit) {
        re.preventDefault();
        re.stopPropagation();
        commit(edit, { revealCaret: true });
        return;
      }
    }
    if (ev.key === "Enter" && richText && !ev.metaKey && !ev.ctrlKey && !ev.isComposing) {
      if (selectionInOneCodeBlock(state)) {
        re.preventDefault();
        re.stopPropagation();
        commit(insertLineBreak(state, true), { revealCaret: true });
        return;
      }
      const res = resolveFlatOffset(state.doc, state.selection.head);
      if (
        isPlainParagraph(res.block) &&
        /^(`{3,}|~{3,})/.test(serializeSelection(state.doc, res.start, res.end))
      ) {
        const fenceRes = insertLineBreak(state, true);
        if (fenceRes.doc.blocks[res.blockIndex]?.kind === "codeBlock") {
          re.preventDefault();
          re.stopPropagation();
          commit(fenceRes, { revealCaret: true });
          return;
        }
      }
    }
    const handler = readCallbacks().onCommandKeyDown;
    if (ev.key === "Enter") {
      const res = resolveFlatOffset(state.doc, state.selection.head);
      const isList = richText && res.block.kind === "line" && isListPrefix(res.block.prefix);
      if (handler?.("Enter", ev, isList)) {
        re.preventDefault();
        re.stopPropagation();
        return;
      }
      re.preventDefault();
      commit(insertLineBreak(state, richText), { revealCaret: true });
      return;
    }
    if (handler?.(ev.key, ev)) {
      re.preventDefault();
      re.stopPropagation();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || disabled || !e.clipboardData) return;
    const cd = e.clipboardData;
    if (cd.files.length > 0 && (literalText || !readPastedComposerContext(cd)?.records.length))
      return;
    const plain = readPastedPlainText(cd);
    if (!plain) return;
    e.preventDefault();
    const state = stateRef.current;
    const from = selectionFrom(state.selection);
    const to = selectionTo(state.selection);
    const res = resolveFlatOffset(state.doc, from);
    if (res.block.kind === "codeBlock") {
      commit(insertText(state, plain, { richText: false, literalText: true }), {
        clipboardEvent: "paste",
        revealCaret: true,
      });
      return;
    }
    if (
      touchesMarkdownSource(state, from, to) &&
      !plain.includes("\n") &&
      collectComposerPromptInlineTokens(`${plain}\n`).length === 0
    ) {
      commit(
        insertText(state, plain, { richText: false, literalText: false, applyInputRules: false }),
        { clipboardEvent: "paste", revealCaret: true },
      );
      return;
    }
    const importFn = readCallbacks().importContextFragment;
    let text = !literalText && importFn ? importPastedComposerText(cd, importFn) : plain;
    const tokens = literalText ? [] : collectComposerPromptInlineTokens(`${text}\n`);
    const isChipTok = (t: (typeof tokens)[number] | undefined) =>
      t?.type === "mention" ||
      (t?.type === "skill" && skillLabelFor(t.value) !== null) ||
      (t?.type === "model" && isKnownModel(t.instanceId, t.model));
    if (isChipTok(tokens.at(-1)) && tokens.at(-1)?.end === text.length) text += " ";
    if (isChipTok(tokens[0]) && tokens[0]?.start === 0) {
      const map = serializeEditorDoc(state.doc);
      const off = flatToMarkdown(map, from);
      if (off > 0 && !/\s/.test(map.value[off - 1]!)) text = ` ${text}`;
    }
    const literalLength = literalText
      ? 0
      : pastedPathQueryLength(
          serializeSelection(state.doc, res.start, from),
          text,
          readCallbacks().isPathQueryActive?.(),
        );
    const nested =
      res.block.kind === "line" &&
      (isListPrefix(res.block.prefix) || res.block.prefix?.kind === "quote");
    commit(
      insertPastedBlocks(
        state,
        buildComposerBlocks(text, skillLabelFor, {
          styling: richText,
          blocks: !nested,
          literalText,
          literalLength,
          isKnownModel,
        }),
      ),
      {
        clipboardEvent: "paste",
        revealCaret: true,
      },
    );
  };

  const handleCopyCut = (e: React.ClipboardEvent, cut: boolean) => {
    if (cut && disabled) return;
    const state = stateRef.current;
    const from = selectionFrom(state.selection);
    const to = selectionTo(state.selection);
    if (from === to) return;
    const text = serializeSelection(state.doc, from, to);
    const ids = literalText ? [] : Array.from(new Set(collectInlineContextIds(text)));
    const frag = ids.length > 0 ? buildContextClipboardFragment?.(ids) : null;
    e.preventDefault();
    e.clipboardData.setData("text/plain", text);
    if (frag) {
      e.clipboardData.setData(COMPOSER_CONTEXT_CLIPBOARD_MIME, frag);
      e.clipboardData.setData("text/html", encodeComposerContextClipboardHtml(text, frag));
    }
    if (cut) commit(deleteRange(state.doc, from, to), { clipboardEvent: "cut", revealCaret: true });
  };

  const citationHandlers = {
    onOpenChange: useStableCallback((k: string, open: boolean) => {
      if (!open && citationDraftRef.current?.key === k) citationDraftRef.current = null;
      setOpenCitation((c) => (open ? (c?.key === k ? c : { key: k }) : c?.key === k ? null : c));
    }),
    onDraftChange: useStableCallback((k: string, comment: string) => {
      citationDraftRef.current = { key: k, comment };
    }),
    onSaveComment: useStableCallback((k: string, comment: string) => {
      if (disabled) return false;
      const updated = updateCitationComment(stateRef.current.doc, k, comment);
      if (!updated) return false;
      commit({ doc: updated, selection: stateRef.current.selection, changeKind: "other" });
      return true;
    }),
    onRemoveCitation: useStableCallback((k: string, spaces: CitationInsertedSpaces) => {
      const res = removeCitationByKey(stateRef.current.doc, k, spaces);
      if (!res) return;
      commit(res, { revealCaret: !disabled });
      if (!disabled) domRef.current?.focus();
    }),
    onRestoreFocusAfterCitation: useStableCallback((k: string, sent: boolean) => {
      if (disabled || !domRef.current) return;
      const found = findCitationByKey(stateRef.current.doc, k);
      if (!found) {
        if (sent) domRef.current.focus();
        return;
      }
      domRef.current.focus();
      commit(
        { doc: stateRef.current.doc, selection: collapsedSelection(found.flatPos + 1) },
        { addToHistory: false, silentSelection: sent, revealCaret: true },
      );
    }),
    onSubmitAndSend: useStableCallback(() => onCitationSubmitAndSend?.() ?? false),
  };
  // Stable callbacks, so the compiler keeps this object (and citation chips) unchanged while typing.
  const citationCtx = {
    openComment: openCitation,
    isEditable: !disabled,
    ...citationHandlers,
  };

  const getCodeHighlightSpans = useStableCallback(
    (lang: string, code: string) => highlighterRef.current?.getSpans(lang, code) ?? [],
  );
  const onChangeCodeLanguage = useStableCallback((bi: number, lang: string) => {
    const res = updateCodeBlockLanguage(stateRef.current.doc, bi, lang);
    if (res) {
      commit(res, { revealCaret: true });
      domRef.current?.focus();
    }
  });
  const onToggleTaskItem = useStableCallback((bi: number) => {
    const res = toggleTaskItemChecked(stateRef.current.doc, bi, stateRef.current.selection);
    if (res) commit(res);
  });
  const onDeleteReadOnlyChip = useStableCallback((bi: number, offset: number) => {
    const flat = (computeFlatBlockSpans(stateRef.current.doc)[bi]?.start ?? 0) + offset;
    commit(deleteRange(stateRef.current.doc, flat, flat + 1));
  });

  const isEmpty = serializeEditorDoc(editorState.doc).value.length === 0;

  return (
    <RichComposerSkillsContext value={skills}>
      <ComposerContextRecordsContext value={contextRecords}>
        <ComposerCitationCommentContext value={citationCtx}>
          <div
            className={cn(
              "relative grid grid-cols-[minmax(0,1fr)] font-(family-name:--font-composer,var(--font-sans)) text-(length:--font-size-prompt,var(--text-sm)) max-sm:pointer-coarse:text-(length:--font-size-prompt-touch)",
              containerClassName,
            )}
          >
            <div
              className="col-start-1 row-start-1"
              onPasteCapture={onPaste}
              onCopyCapture={(e) => handleCopyCut(e, false)}
              onCutCapture={(e) => handleCopyCut(e, true)}
            >
              <div
                ref={domRef}
                contentEditable={!disabled}
                suppressContentEditableWarning
                dir={caretLineDirection(editorState) ?? undefined}
                className={cn(
                  "composer-tiptap ProseMirror -m-1 block max-h-52 min-h-[calc(2lh+--spacing(2))] overflow-y-auto p-1 whitespace-pre-wrap wrap-break-word bg-transparent leading-relaxed text-foreground focus:outline-none",
                  isFocused && "ProseMirror-focused",
                  className,
                )}
                data-testid="composer-editor"
                data-composer-rich-text={richText ? "true" : "false"}
                role="textbox"
                aria-multiline="true"
                aria-label={ariaLabel}
                aria-readonly={disabled ? "true" : undefined}
                aria-autocomplete={!disabled && suggestionListId ? "list" : undefined}
                aria-haspopup={!disabled && suggestionListId ? "listbox" : undefined}
                aria-controls={
                  !disabled && suggestionListId && activeSuggestionId ? suggestionListId : undefined
                }
                aria-activedescendant={
                  !disabled && suggestionListId && activeSuggestionId
                    ? activeSuggestionId
                    : undefined
                }
                aria-placeholder={placeholder}
                onFocus={() => setIsFocused(true)}
                onBlur={() => {
                  setIsFocused(false);
                  onPageScrollRelease?.();
                }}
                onInput={() => {
                  if (!disabled && !composingRef.current) syncDom(false);
                }}
                onCompositionStart={() => {
                  composingRef.current = true;
                  const s = stateRef.current;
                  const f = selectionFrom(s.selection);
                  const t = selectionTo(s.selection);
                  if (selectionSpansChips(s.doc, f, t))
                    commit(deleteRange(s.doc, f, t), {
                      compositionReplace: true,
                      revealCaret: true,
                    });
                }}
                onCompositionEnd={() => {
                  composingRef.current = false;
                  syncDom(true);
                }}
                onKeyDown={handleKeyDown}
                onKeyUp={(e) => onPageScrollKeyUp?.(e.key)}
                onPaste={handlePaste}
              >
                <Fragment key={domRevision}>
                  <ComposerDocView
                    doc={editorState.doc}
                    selection={editorState.selection}
                    isEditable={!disabled}
                    getCodeHighlightSpans={getCodeHighlightSpans}
                    onChangeCodeLanguage={onChangeCodeLanguage}
                    onToggleTaskItem={onToggleTaskItem}
                    onDeleteReadOnlyChip={onDeleteReadOnlyChip}
                  />
                </Fragment>
              </div>
            </div>
            {isEmpty && contextRecords.size === 0 && placeholder ? (
              <div
                className={cn(
                  "pointer-events-none relative col-start-1 row-start-1 leading-relaxed text-placeholder",
                  placeholderClassName,
                )}
              >
                {placeholder}
                {placeholderSuffix}
              </div>
            ) : null}
          </div>
        </ComposerCitationCommentContext>
      </ComposerContextRecordsContext>
    </RichComposerSkillsContext>
  );
}
