import {
  type ComposerChangeKind,
  type ComposerUndoMeta,
  groupUndoByChangeKind,
} from "~/composer-undo-grouping";
import type { ComposerEditorState } from "./types";

const MAX_HISTORY_DEPTH = 200;

export class ComposerHistory {
  private undoStack: ComposerEditorState[] = [];
  private redoStack: ComposerEditorState[] = [];
  private previousKind: ComposerChangeKind | null = null;
  private previousTimestamp: number | undefined;
  private inputRuleUndo: ComposerEditorState | null = null;

  reset(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.previousKind = null;
    this.previousTimestamp = undefined;
    this.inputRuleUndo = null;
  }

  canUndo = (): boolean => this.undoStack.length > 0;
  canRedo = (): boolean => this.redoStack.length > 0;
  clearInputRuleUndo(): void { this.inputRuleUndo = null; }
  consumeInputRuleUndo(): ComposerEditorState | null {
    const entry = this.inputRuleUndo;
    this.inputRuleUndo = null;
    return entry;
  }

  record(
    before: ComposerEditorState,
    meta: ComposerUndoMeta,
    now = Date.now(),
    inputRuleUndo?: ComposerEditorState,
  ): void {
    this.inputRuleUndo = inputRuleUndo ?? null;
    const { kind, closeGroup } = groupUndoByChangeKind(meta, this.previousKind, now, this.previousTimestamp);
    this.previousKind = kind;
    this.previousTimestamp = now;
    if (this.undoStack.length === 0 || closeGroup) {
      this.undoStack.push(before);
      if (this.undoStack.length > MAX_HISTORY_DEPTH) this.undoStack.shift();
    }
    this.redoStack = [];
  }

  undo(current: ComposerEditorState): ComposerEditorState | null {
    const target = this.undoStack.pop();
    if (!target) return null;
    this.redoStack.push(current);
    this.previousKind = "other";
    this.previousTimestamp = undefined;
    this.inputRuleUndo = null;
    return target;
  }

  redo(current: ComposerEditorState): ComposerEditorState | null {
    const target = this.redoStack.pop();
    if (!target) return null;
    this.undoStack.push(current);
    this.previousKind = "other";
    this.previousTimestamp = undefined;
    this.inputRuleUndo = null;
    return target;
  }
}
