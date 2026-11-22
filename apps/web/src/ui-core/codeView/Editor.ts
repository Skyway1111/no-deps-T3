import type { FileContents, LineAnnotation } from "@t3tools/shared/diff/patch";

import { findAll, setSearchHighlights, textRange } from "./search";
import { languageOf, LineTokens, splitLines } from "./tokens";
import type { EditorPosition, EditorSelection } from "./types";

interface Selection {
  readonly anchor: EditorPosition;
  readonly focus: EditorPosition;
}

interface Step {
  readonly start: EditorPosition;
  readonly removed: string;
  inserted: string;
  readonly before: Selection | null;
  after: Selection;
  readonly kind: "type" | "delete" | "other";
  at: number;
}

interface Match {
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

const MERGE_WINDOW_MS = 1_000;
const HISTORY_LIMIT = 500;

function compare(a: EditorPosition, b: EditorPosition) {
  return a.line - b.line || a.character - b.character;
}

function ordered(selection: Selection): [EditorPosition, EditorPosition] {
  return compare(selection.anchor, selection.focus) <= 0
    ? [selection.anchor, selection.focus]
    : [selection.focus, selection.anchor];
}

/** Where `text` ends when inserted at `start`. */
function endOf(start: EditorPosition, text: string): EditorPosition {
  const lines = splitLines(text);
  return lines.length === 1
    ? { line: start.line, character: start.character + text.length }
    : { line: start.line + lines.length - 1, character: lines.at(-1)!.length };
}

const WORD = /[\p{L}\p{N}_$]/u;

/**
 * An editable file: lines with incremental tokens, one selection, and undo history. The view
 * renders its lines and forwards input; this maps between DOM points and line positions.
 */
export class Editor<LAnnotation = undefined> {
  file!: FileContents;
  tokens!: LineTokens;
  revision = 0;
  selection: Selection | null = null;
  annotations: ReadonlyArray<LineAnnotation<LAnnotation>> | undefined;
  content: HTMLElement | null = null;
  layer: HTMLElement | null = null;
  find = { open: false, query: "", replace: "", matches: [] as Match[], current: -1 };
  findInput: HTMLInputElement | null = null;
  /** Wired by the view. */
  view = {
    rerender: () => {},
    changed: () => {},
    scrollToLine: (_line: number, _align: "center" | "nearest") => {},
    firstVisibleLine: () => 0,
  };
  private eol = "\n";
  private contentsCache: { readonly revision: number; readonly text: string } | null = null;
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  private written: readonly [Node, number, Node, number] | null = null;

  attach(slot: "content" | "layer" | "findInput", node: HTMLElement | null) {
    if (slot === "findInput") this.findInput = node as HTMLInputElement | null;
    else this[slot] = node;
  }

  setReplacement(value: string) {
    this.find = { ...this.find, replace: value };
    this.view.rerender();
  }

  constructor(file: FileContents) {
    this.load(file);
  }

  load(file: FileContents) {
    this.file = file;
    this.eol = file.contents.includes("\r\n") ? "\r\n" : "\n";
    this.tokens = new LineTokens(splitLines(file.contents), languageOf(file.name, file.lang));
    this.undoStack = [];
    this.redoStack = [];
    this.contentsCache = null;
    this.revision++;
    if (this.selection) {
      const clamp = (position: EditorPosition) => {
        const line = Math.min(position.line, this.lineCount - 1);
        return { line, character: Math.min(position.character, this.line(line).length) };
      };
      this.selection = { anchor: clamp(this.selection.anchor), focus: clamp(this.selection.focus) };
    }
    if (this.find.open) this.searchFor(this.find.query);
  }

  get lineCount() {
    return this.tokens.lines.length;
  }

  line(index: number) {
    return this.tokens.lines[index] ?? "";
  }

  get contents() {
    if (this.contentsCache?.revision !== this.revision)
      this.contentsCache = { revision: this.revision, text: this.tokens.lines.join(this.eol) };
    return this.contentsCache.text;
  }

  // The app's surface: focus, selections, and view state.

  focus(options: { preventScroll?: boolean; lineNumber?: number | "first-visible" } = {}) {
    if (!this.selection) {
      const line =
        options.lineNumber === "first-visible" || options.lineNumber === undefined
          ? this.view.firstVisibleLine()
          : Math.max(0, Math.min(options.lineNumber - 1, this.lineCount - 1));
      this.selection = { anchor: { line, character: 0 }, focus: { line, character: 0 } };
    }
    this.content?.focus({ preventScroll: options.preventScroll ?? false });
    this.writeNativeSelection();
    this.paint();
  }

  blur() {
    if (this.content && this.content.contains(document.activeElement)) this.content.blur();
  }

  setSelections(selections: ReadonlyArray<EditorSelection>) {
    const first = selections[0];
    if (!first) {
      this.selection = null;
      const native = document.getSelection();
      if (native?.anchorNode && this.content?.contains(native.anchorNode)) native.removeAllRanges();
    } else {
      const backward = first.direction === "backward";
      this.selection = {
        anchor: backward ? first.end : first.start,
        focus: backward ? first.start : first.end,
      };
      this.writeNativeSelection();
    }
    this.paint();
    this.view.rerender();
  }

  getViewState(): { selections: EditorSelection[] } {
    if (!this.selection) return { selections: [] };
    const [start, end] = ordered(this.selection);
    const direction =
      compare(start, end) === 0 ? "none" : start === this.selection.anchor ? "forward" : "backward";
    return { selections: [{ start, end, direction }] };
  }

  // Editing.

  textBetween(start: EditorPosition, end: EditorPosition) {
    if (start.line === end.line) return this.line(start.line).slice(start.character, end.character);
    const parts = [this.line(start.line).slice(start.character)];
    for (let line = start.line + 1; line < end.line; line++) parts.push(this.line(line));
    parts.push(this.line(end.line).slice(0, end.character));
    return parts.join("\n");
  }

  selectedText() {
    if (!this.selection) return "";
    const [start, end] = ordered(this.selection);
    return this.textBetween(start, end);
  }

  private apply(start: EditorPosition, end: EditorPosition, text: string): EditorPosition {
    const before = this.line(start.line).slice(0, start.character);
    const after = this.line(end.line).slice(end.character);
    const inserted = splitLines(text);
    const lastLength = inserted.at(-1)!.length;
    inserted[0] = before + inserted[0];
    inserted[inserted.length - 1] += after;
    this.tokens.edit(start.line, end.line - start.line + 1, inserted);
    this.remapAnnotations(start.line, end.line, inserted.length);
    this.revision++;
    return {
      line: start.line + inserted.length - 1,
      character: inserted.length === 1 ? before.length + lastLength : lastLength,
    };
  }

  /** Annotations below replaced lines move with them; ones on removed lines move up to the edit. */
  private remapAnnotations(first: number, last: number, count: number) {
    const annotations = this.annotations;
    if (!annotations || annotations.length === 0) return;
    const shift = count - (last - first + 1);
    let moved = false;
    const next = annotations.map((annotation) => {
      const line = annotation.lineNumber;
      if (line === 0 || line - 1 <= first) return annotation;
      const lineNumber = line - 1 > last ? line + shift : Math.min(line, first + count);
      if (lineNumber === line) return annotation;
      moved = true;
      return { ...annotation, lineNumber };
    });
    if (moved) this.annotations = next;
  }

  replace(start: EditorPosition, end: EditorPosition, text: string, kind: Step["kind"]) {
    const removed = this.textBetween(start, end);
    if (removed === "" && text === "") return;
    const before = this.selection;
    const caret = this.apply(start, end, text);
    const after = { anchor: caret, focus: caret };
    this.selection = after;
    const now = Date.now();
    const last = this.undoStack.at(-1);
    if (
      kind === "type" &&
      last?.kind === "type" &&
      removed === "" &&
      !text.includes("\n") &&
      compare(endOf(last.start, last.inserted), start) === 0 &&
      now - last.at < MERGE_WINDOW_MS
    ) {
      last.inserted += text;
      last.after = after;
      last.at = now;
    } else {
      this.undoStack.push({ start, removed, inserted: text, before, after, kind, at: now });
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    }
    this.redoStack = [];
    this.edited();
  }

  replaceSelection(text: string, kind: Step["kind"] = "type") {
    if (!this.selection) return;
    const [start, end] = ordered(this.selection);
    this.replace(start, end, text, kind);
  }

  /** Deletes the selection, or the character (or word) beside a caret. */
  deleteBy(direction: -1 | 1, unit: "character" | "word" | "line") {
    if (!this.selection) return;
    const [start, end] = ordered(this.selection);
    if (compare(start, end) !== 0) return this.replace(start, end, "", "delete");
    const target = this.step(start, direction, unit);
    if (compare(target, start) === 0) return;
    const [from, to] = direction < 0 ? [target, start] : [start, target];
    this.replace(from, to, "", "delete");
  }

  private step(position: EditorPosition, direction: -1 | 1, unit: "character" | "word" | "line") {
    const text = this.line(position.line);
    if (direction < 0 && position.character === 0) {
      return position.line === 0
        ? position
        : { line: position.line - 1, character: this.line(position.line - 1).length };
    }
    if (direction > 0 && position.character === text.length) {
      return position.line === this.lineCount - 1
        ? position
        : { line: position.line + 1, character: 0 };
    }
    if (unit === "line") return { line: position.line, character: direction < 0 ? 0 : text.length };
    let at = position.character;
    if (unit === "character") {
      const code = text.charCodeAt(direction < 0 ? at - 1 : at);
      const surrogate =
        direction < 0 ? code >= 0xdc00 && code <= 0xdfff : code >= 0xd800 && code <= 0xdbff;
      return { line: position.line, character: at + direction * (surrogate ? 2 : 1) };
    }
    const charAt = (index: number) => text[index] ?? "";
    const next = () => (direction < 0 ? charAt(at - 1) : charAt(at));
    while (next() !== "" && /\s/u.test(next())) at += direction;
    const word = WORD.test(next());
    while (next() !== "" && !/\s/u.test(next()) && WORD.test(next()) === word) at += direction;
    return { line: position.line, character: at };
  }

  wordAt(position: EditorPosition): [number, number] {
    const text = this.line(position.line);
    let start = position.character;
    let end = position.character;
    while (start > 0 && WORD.test(text[start - 1]!)) start--;
    while (end < text.length && WORD.test(text[end]!)) end++;
    return [start, end];
  }

  undo() {
    const step = this.undoStack.pop();
    if (!step) return;
    this.apply(step.start, endOf(step.start, step.inserted), step.removed);
    const caret = endOf(step.start, step.removed);
    this.selection = step.before ?? { anchor: caret, focus: caret };
    this.redoStack.push(step);
    this.edited();
  }

  redo() {
    const step = this.redoStack.pop();
    if (!step) return;
    this.apply(step.start, endOf(step.start, step.removed), step.inserted);
    this.selection = step.after;
    this.undoStack.push({ ...step, at: 0 });
    this.edited();
  }

  private edited() {
    if (this.find.open) this.searchFor(this.find.query, false);
    this.view.changed();
    this.view.rerender();
  }

  // DOM mapping.

  /** The line position of a DOM point inside a mounted row, else null. */
  pointToPosition(node: Node | null, offset: number): EditorPosition | null {
    const element = node instanceof Element ? node : node?.parentElement;
    const row = element?.closest<HTMLElement>("[data-line]");
    if (!node || !row || !this.content?.contains(row)) return null;
    const line = Number(row.dataset.line) - 1;
    const range = document.createRange();
    range.setStart(row, 0);
    range.setEnd(node, offset);
    return { line, character: Math.min(range.toString().length, this.line(line).length) };
  }

  private positionToPoint(position: EditorPosition): [Node, number] | null {
    const row = this.content?.querySelector<HTMLElement>(`[data-line="${position.line + 1}"]`);
    if (!row) return null;
    let rest = position.character;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.nodeValue?.length ?? 0;
      if (rest <= length) return [node, rest];
      rest -= length;
    }
    return [
      row,
      row.childNodes.length > 0 && row.firstChild?.nodeName === "BR" ? 0 : row.childNodes.length,
    ];
  }

  /** Reads the browser's selection; an end on no mounted row keeps the one it had. */
  readNativeSelection() {
    const content = this.content;
    const native = document.getSelection();
    if (!content || !native || native.rangeCount === 0 || document.activeElement !== content)
      return;
    const { anchorNode, anchorOffset, focusNode, focusOffset } = native;
    const written = this.written;
    if (
      written &&
      written[0] === anchorNode &&
      written[1] === anchorOffset &&
      written[2] === focusNode &&
      written[3] === focusOffset
    )
      return;
    if (!content.contains(anchorNode) && !content.contains(focusNode)) return;
    const anchor = this.pointToPosition(anchorNode, anchorOffset) ?? this.selection?.anchor;
    const focus = this.pointToPosition(focusNode, focusOffset) ?? this.selection?.focus;
    if (!anchor || !focus) return;
    this.selection = { anchor, focus };
    this.paint();
  }

  /** Draws the selection's mounted part as the browser's own, so a caret shows. */
  writeNativeSelection() {
    const content = this.content;
    const selection = this.selection;
    if (!content || !selection || document.activeElement !== content) return;
    const rows = content.querySelectorAll<HTMLElement>("[data-line]");
    const first = rows[0];
    const last = rows[rows.length - 1];
    if (!first || !last) return;
    const firstLine = Number(first.dataset.line) - 1;
    const lastLine = Number(last.dataset.line) - 1;
    const clamp = (position: EditorPosition): EditorPosition =>
      position.line < firstLine
        ? { line: firstLine, character: 0 }
        : position.line > lastLine
          ? { line: lastLine, character: this.line(lastLine).length }
          : position;
    const anchor = this.positionToPoint(clamp(selection.anchor));
    const focus = this.positionToPoint(clamp(selection.focus));
    if (!anchor || !focus) return;
    const native = document.getSelection();
    if (
      native?.anchorNode === anchor[0] &&
      native.anchorOffset === anchor[1] &&
      native.focusNode === focus[0] &&
      native.focusOffset === focus[1]
    )
      return;
    native?.setBaseAndExtent(anchor[0], anchor[1], focus[0], focus[1]);
    this.written = [anchor[0], anchor[1], focus[0], focus[1]];
  }

  /** Paints `[data-selection-range]` boxes over the selection's mounted rows. */
  paint() {
    const layer = this.layer;
    const content = this.content;
    if (!layer || !content) return;
    const boxes: HTMLElement[] = [];
    const selection = this.selection;
    if (selection && compare(selection.anchor, selection.focus) !== 0) {
      const [start, end] = ordered(selection);
      const base = layer.getBoundingClientRect();
      const box = (left: number, top: number, width: number, height: number) => {
        const element = document.createElement("div");
        element.dataset.selectionRange = "";
        element.style.cssText = `left:${left - base.left}px;top:${top - base.top}px;width:${width}px;height:${height}px`;
        boxes.push(element);
      };
      for (const row of content.querySelectorAll<HTMLElement>("[data-line]")) {
        const line = Number(row.dataset.line) - 1;
        if (line < start.line || line > end.line) continue;
        const from = line === start.line ? start.character : 0;
        const to = line === end.line ? end.character : this.line(line).length;
        const rowBox = row.getBoundingClientRect();
        const range = to > from ? textRange(row, from, to) : null;
        let lastRight = rowBox.left + parseFloat(getComputedStyle(row).paddingLeft);
        let lastTop = rowBox.top;
        let lastHeight = rowBox.height;
        for (const rect of range?.getClientRects() ?? []) {
          if (rect.width === 0) continue;
          box(rect.left, rect.top, rect.width, rect.height);
          lastRight = rect.right;
          lastTop = rect.top;
          lastHeight = rect.height;
        }
        // The line break itself, so selected empty lines show.
        if (line < end.line) box(lastRight, lastTop, 6, lastHeight || rowBox.height);
      }
    }
    layer.replaceChildren(...boxes);
  }

  // Find and replace.

  openFind() {
    const selected = this.selectedText();
    let query = selected;
    if (query === "" || query.includes("\n")) {
      const focus = this.selection?.focus;
      if (focus) {
        const [start, end] = this.wordAt(focus);
        query = this.line(focus.line).slice(start, end);
      }
    }
    this.find = { ...this.find, open: true };
    if (query !== "" && !query.includes("\n")) this.searchFor(query);
    this.view.rerender();
    queueMicrotask(() => {
      this.findInput?.focus();
      this.findInput?.select();
    });
  }

  closeFind() {
    this.find = { ...this.find, open: false, matches: [], current: -1 };
    setSearchHighlights(this, [], []);
    this.view.rerender();
    this.content?.focus({ preventScroll: true });
    this.writeNativeSelection();
  }

  /** Matches `query`; the current match is the first at or after the caret. */
  searchFor(query: string, reveal = true) {
    const matches: Match[] = [];
    if (query !== "") {
      this.tokens.lines.forEach((text, line) => {
        for (const start of findAll(text, query))
          matches.push({ line, start, end: start + query.length });
      });
    }
    const caret = this.selection ? ordered(this.selection)[0] : { line: 0, character: 0 };
    const after = matches.findIndex(
      (match) => compare({ line: match.line, character: match.start }, caret) >= 0,
    );
    const current = matches.length === 0 ? -1 : after === -1 ? 0 : after;
    this.find = { ...this.find, query, matches, current };
    const match = matches[current];
    if (reveal && match) this.view.scrollToLine(match.line, "nearest");
    this.view.rerender();
  }

  navigateFind(direction: 1 | -1) {
    const { matches, current } = this.find;
    if (matches.length === 0) return;
    const next = (current + direction + matches.length) % matches.length;
    this.find = { ...this.find, current: next };
    this.view.scrollToLine(matches[next]!.line, "center");
    this.view.rerender();
  }

  replaceCurrent() {
    const match = this.find.matches[this.find.current];
    if (!match) return;
    this.replace(
      { line: match.line, character: match.start },
      { line: match.line, character: match.end },
      this.find.replace,
      "other",
    );
  }

  replaceAll() {
    const { matches, query } = this.find;
    if (matches.length === 0) return;
    const end = { line: this.lineCount - 1, character: this.line(this.lineCount - 1).length };
    const text = this.tokens.lines
      .map((line) => {
        let out = "";
        let at = 0;
        for (const start of findAll(line, query)) {
          out += line.slice(at, start) + this.find.replace;
          at = start + query.length;
        }
        return out + line.slice(at);
      })
      .join("\n");
    const selection = this.selection;
    this.replace({ line: 0, character: 0 }, end, text, "other");
    if (selection) this.selection = selection;
  }

  /** Draws find matches onto the rows now mounted. */
  paintFind() {
    const content = this.content;
    if (!content || !this.find.open || this.find.matches.length === 0) {
      setSearchHighlights(this, [], []);
      return;
    }
    const rows = new Map<number, HTMLElement>();
    for (const row of content.querySelectorAll<HTMLElement>("[data-line]"))
      rows.set(Number(row.dataset.line) - 1, row);
    const matches: Range[] = [];
    const current: Range[] = [];
    const active = this.find.matches[this.find.current];
    for (const match of this.find.matches) {
      const row = rows.get(match.line);
      const range = row && textRange(row, match.start, match.end);
      if (range) (match === active ? current : matches).push(range);
    }
    setSearchHighlights(this, matches, current);
  }

  dispose() {
    setSearchHighlights(this, [], []);
  }
}
