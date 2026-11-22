import type { FileContents, LineAnnotation, SelectedLineRange } from "@t3tools/shared/diff/patch";
import {
  createContext,
  use,
  useLayoutEffect,
  useReducer,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { isMacPlatform } from "~/lib/utils";

import { Editor } from "./Editor";
import { alignOffset, PROBE_LENGTH, ViewEngine, type SectionSpec } from "./engine";
import { useGutter } from "./gutter";
import { annotationCells, estimateLineHeight, LineCell, NumberCell } from "./rows";
import { isFindShortcut, SearchWidget } from "./search";
import { ensureThemeStyles, languageOf, splitLines, tokensFor, type LineTokens } from "./tokens";
import type { EditorChangeEvent, EditorOptions, FileOptions, FileViewInstance } from "./types";
import "./codeView.css";

interface VirtualizerValue {
  readonly scroller: HTMLElement | null;
}

const VirtualizerContext = createContext<VirtualizerValue | null>(null);
/** How far past the viewport a file keeps rows mounted, so drags and finds land on real rows. */
const FILE_OVERSCAN = 1200;

/** The scroller a `File` windows its rows against. */
export function Virtualizer(props: { readonly className?: string; readonly children: ReactNode }) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setScroller} className={props.className} style={{ overflowAnchor: "none" }}>
      <VirtualizerContext value={{ scroller }}>{props.children}</VirtualizerContext>
    </div>
  );
}

interface FileRows {
  readonly count: number;
  /** The 0-based line a row shows, or -1 for an annotation row. */
  line(row: number): number;
  annotationLine(row: number): number;
  rowOfLine(line: number): number;
}

function buildRows<L>(
  lineCount: number,
  annotations: ReadonlyArray<LineAnnotation<L>> | undefined,
): {
  readonly rows: FileRows;
  readonly byLine: ReadonlyMap<number, LineAnnotation<L>[]>;
} {
  const byLine = new Map<number, LineAnnotation<L>[]>();
  for (const annotation of annotations ?? []) {
    if (annotation.lineNumber > lineCount) continue;
    const list = byLine.get(annotation.lineNumber);
    if (list) list.push(annotation);
    else byLine.set(annotation.lineNumber, [annotation]);
  }
  if (byLine.size === 0) {
    return {
      byLine,
      rows: {
        count: lineCount,
        line: (row) => row,
        annotationLine: () => -1,
        rowOfLine: (line) => line,
      },
    };
  }
  // Rows are encoded as line + 1, or -(lineNumber + 1) for the annotation row below a line.
  const encoded = new Int32Array(lineCount + byLine.size);
  const rowOf = new Int32Array(lineCount);
  let row = 0;
  if (byLine.has(0)) encoded[row++] = -1;
  for (let line = 0; line < lineCount; line++) {
    rowOf[line] = row;
    encoded[row++] = line + 1;
    if (byLine.has(line + 1)) encoded[row++] = -(line + 2);
  }
  return {
    byLine,
    rows: {
      count: row,
      line: (index) => (encoded[index]! > 0 ? encoded[index]! - 1 : -1),
      annotationLine: (index) => (encoded[index]! < 0 ? -encoded[index]! - 1 : -1),
      rowOfLine: (line) => rowOf[Math.max(0, Math.min(line, lineCount - 1))] ?? 0,
    },
  };
}

/** Everything one render reads, so the compiled component re-renders when any of it changes. */
interface FileView<L> {
  readonly start: number;
  readonly end: number;
  readonly before: number;
  readonly after: number;
  readonly rows: FileRows;
  readonly tokens: LineTokens;
  readonly byLine: ReadonlyMap<number, LineAnnotation<L>[]>;
  readonly lineCount: number;
  readonly digits: number;
  readonly maxChars: number;
  readonly epoch: number;
  readonly editor: Editor<L> | null;
  readonly find: Editor<L>["find"] | null;
}

export interface FileProps<L> {
  readonly file: FileContents;
  readonly options?: FileOptions;
  readonly lineAnnotations?: ReadonlyArray<LineAnnotation<L>>;
  readonly selectedLines?: SelectedLineRange | null;
  readonly renderAnnotation?: (annotation: LineAnnotation<L>) => ReactNode;
  readonly className?: string;
  /** Makes the file an editor. */
  readonly edit?: boolean;
  readonly editorOptions?: EditorOptions<Editor<L>>;
  readonly onEditChange?: (event: EditorChangeEvent<L>) => void;
}

const isMac = typeof navigator !== "undefined" && isMacPlatform(navigator.platform);

class FileController<L> {
  readonly engine = new ViewEngine();
  editor: Editor<L> | null = null;
  props!: FileProps<L>;
  tokens!: LineTokens;
  rows!: FileRows;
  byLine: ReadonlyMap<number, LineAnnotation<L>[]> = new Map();
  lineCount = 0;
  digits = 3;
  maxChars = 0;
  epoch = 0;
  root: HTMLElement | null = null;
  attached = false;
  posted = false;
  /** Outside a `Virtualizer` every row renders. */
  virtualized = false;
  private spec: SectionSpec | null = null;
  private inputs: ReadonlyArray<unknown> = [];
  private givenAnnotations: ReadonlyArray<LineAnnotation<L>> | undefined;
  private subscribed: LineTokens | null = null;
  private unsubscribe: (() => void) | null = null;
  private drag: { x: number; y: number; frame: number; stop: () => void } | null = null;

  readonly instance: FileViewInstance = {
    get file(): FileContents {
      return controller(this).currentFile();
    },
    get height() {
      return controller(this).engine.height;
    },
    getLinePosition: (lineNumber) => {
      if (lineNumber < 1 || lineNumber > this.lineCount) return undefined;
      const row = this.rows.rowOfLine(lineNumber - 1);
      return { top: this.engine.rowTop(0, row), height: this.engine.rowHeight(0, row) };
    },
  };

  constructor() {
    instances.set(this.instance, this as FileController<unknown>);
  }

  attachRoot(node: HTMLElement | null) {
    this.root = node;
  }

  /** Routes the editable rows' input through the model; returns the ref cleanup. */
  attachContent(editor: Editor<L>, node: HTMLElement) {
    editor.attach("content", node);
    const onBeforeInput = (event: InputEvent) => this.beforeInput(event);
    node.addEventListener("beforeinput", onBeforeInput);
    return () => {
      node.removeEventListener("beforeinput", onBeforeInput);
      if (editor.content === node) editor.attach("content", null);
    };
  }

  currentFile(): FileContents {
    return this.editor ? { ...this.props.file, contents: this.editor.contents } : this.props.file;
  }

  /** `_version` is the render counter: the view must change when internal state does. */
  sync(
    props: FileProps<L>,
    rerender: () => void,
    context: VirtualizerValue | null,
    _version: number,
  ): FileView<L> {
    this.update(props, rerender, context);
    if (this.subscribed !== this.tokens) {
      this.unsubscribe?.();
      this.subscribed = this.tokens;
      // Idle tokenizing of a long file finishes after the render that asked for it.
      this.unsubscribe = this.tokens.subscribe(rerender);
    }
    const [start, end] = this.window();
    const gaps = this.virtualized ? this.engine.gaps(0, start, end) : { before: 8, after: 8 };
    return {
      start,
      end,
      ...gaps,
      rows: this.rows,
      tokens: this.tokens,
      byLine: this.byLine,
      lineCount: this.lineCount,
      digits: this.digits,
      maxChars: this.maxChars,
      epoch: this.epoch,
      editor: this.editor,
      find: this.editor ? this.editor.find : null,
    };
  }

  private update(props: FileProps<L>, rerender: () => void, context: VirtualizerValue | null) {
    this.props = props;
    this.engine.rerender = rerender;
    this.virtualized = context !== null;
    this.engine.overscan = FILE_OVERSCAN;
    this.engine.wrap = props.options?.overflow === "wrap";
    const { file } = props;
    if (props.edit) {
      if (!this.editor) this.editor = new Editor<L>(file);
      else if (this.editor.file !== file) {
        // A file with the same cacheKey is the same content; the editor keeps its edits.
        const same =
          file.cacheKey === undefined
            ? file.contents === this.editor.file.contents
            : file.cacheKey === this.editor.file.cacheKey;
        if (same) this.editor.file = file;
        else this.editor.load(file);
      }
      const editor = this.editor;
      if (this.givenAnnotations !== props.lineAnnotations)
        editor.annotations = props.lineAnnotations;
      editor.view = {
        rerender,
        changed: () =>
          this.props.onEditChange?.({
            file: { ...this.props.file, contents: editor.contents },
            lineAnnotations: editor.annotations,
          }),
        scrollToLine: (line, align) => this.scrollToLine(line, align),
        firstVisibleLine: () => Math.max(0, this.rows.line(this.engine.firstVisibleRow(0))),
      };
      this.tokens = editor.tokens;
    } else {
      if (this.editor) this.complete();
      this.tokens = tokensFor(file.cacheKey, file, languageOf(file.name, file.lang), () =>
        splitLines(file.contents),
      );
    }
    const lines = this.tokens.lines;
    // A final line break ends the last line rather than starting an empty one.
    const lineCount =
      !this.editor && lines.length > 1 && lines.at(-1) === "" ? lines.length - 1 : lines.length;
    const annotations = this.editor ? this.editor.annotations : props.lineAnnotations;
    const overflow = props.options?.overflow ?? "scroll";
    const inputs = [this.tokens, lineCount, this.editor?.revision, overflow, annotations];
    this.givenAnnotations = props.lineAnnotations;
    if (this.spec && inputs.every((value, index) => value === this.inputs[index])) {
      this.engine.setSections([this.spec]);
      return;
    }
    this.inputs = inputs;
    this.lineCount = lineCount;
    const built = buildRows(lineCount, annotations);
    this.rows = built.rows;
    this.byLine = built.byLine;
    this.digits = Math.max(3, String(lineCount).length);
    let maxChars = 0;
    for (let line = 0; line < lineCount; line++) maxChars = Math.max(maxChars, lines[line]!.length);
    this.maxChars = maxChars;
    const rows = this.rows;
    this.spec = {
      key: "file",
      hasHeader: false,
      padTop: 8,
      padBottom: 8,
      collapsed: false,
      rowCount: rows.count,
      rowKey: (row) =>
        rows.line(row) >= 0 ? `L${rows.line(row)}` : `A${rows.annotationLine(row)}`,
      rowIndex: (key) => {
        const value = Number(key.slice(1));
        if (key[0] === "L") return value < lineCount ? rows.rowOfLine(value) : undefined;
        return value === 0 ? 0 : value <= lineCount ? rows.rowOfLine(value - 1) + 1 : undefined;
      },
      estimate: (row, metrics) => {
        const line = rows.line(row);
        if (line < 0) return metrics.lineHeight * 2;
        return estimateLineHeight(this.tokens.lines[line]!.length, metrics, 1, this.digits);
      },
    };
    this.engine.setSections([this.spec]);
  }

  window(): readonly [number, number] {
    if (!this.virtualized) return [0, this.rows.count];
    return this.engine.window.get(0) ?? [0, 0];
  }

  scrollToLine(line: number, align: "center" | "nearest") {
    this.engine.scrollToContent(() => {
      const row = this.rows.rowOfLine(line);
      return alignOffset(
        this.engine.rowTop(0, row),
        this.engine.rowHeight(0, row),
        this.engine.viewportHeight,
        align,
        this.engine.contentScrollTop,
      );
    });
  }

  complete() {
    this.editor?.dispose();
    this.editor = null;
    this.attached = false;
    this.props.editorOptions?.onComplete?.();
  }

  commit() {
    const editor = this.editor;
    if (editor && !this.attached) {
      this.attached = true;
      this.props.editorOptions?.onAttach?.(editor);
    }
    this.engine.commit();
    if (editor) {
      editor.writeNativeSelection();
      editor.paint();
      editor.paintFind();
    }
    if (this.root) {
      this.props.options?.onPostRender?.(
        this.root,
        this.instance,
        this.posted ? "update" : "mount",
      );
      this.posted = true;
    }
  }

  unmount() {
    this.unsubscribe?.();
    this.subscribed = null;
    if (this.root && this.posted)
      this.props.options?.onPostRender?.(this.root, this.instance, "unmount");
    this.posted = false;
    this.drag?.stop();
    if (this.editor) this.complete();
    this.engine.dispose();
  }

  /** The line position under a viewport point, clamped into the visible rows. */
  private positionAt(x: number, y: number) {
    const editor = this.editor;
    const content = editor?.content;
    if (!editor || !content) return null;
    const viewport = (this.engine.scroller ?? content).getBoundingClientRect();
    const box = content.getBoundingClientRect();
    const cx = Math.max(box.left + 1, Math.min(x, box.right - 1, viewport.right - 1));
    const cy = Math.max(
      viewport.top + 1,
      box.top + 1,
      Math.min(y, viewport.bottom - 1, box.bottom - 1),
    );
    const caret = document.caretPositionFromPoint?.(cx, cy);
    const position = caret ? editor.pointToPosition(caret.offsetNode, caret.offset) : null;
    if (position) return position;
    let nearest: HTMLElement | null = null;
    for (const row of content.querySelectorAll<HTMLElement>("[data-line]")) {
      const rect = row.getBoundingClientRect();
      if (rect.top <= cy) nearest = row;
      if (rect.bottom > cy) break;
    }
    if (!nearest) return { line: 0, character: 0 };
    const line = Number(nearest.dataset.line) - 1;
    return { line, character: cx < box.left + 8 ? 0 : editor.line(line).length };
  }

  pressContent(event: React.MouseEvent<HTMLElement>) {
    const editor = this.editor;
    const content = editor?.content;
    if (!editor || !content || event.button !== 0) return;
    if ((event.target as Element).closest("[data-line-annotation]")) return;
    event.preventDefault();
    content.focus({ preventScroll: true });
    const position = this.positionAt(event.clientX, event.clientY);
    if (!position) return;
    if (event.detail === 2) {
      const [start, end] = editor.wordAt(position);
      editor.selection = {
        anchor: { line: position.line, character: start },
        focus: { line: position.line, character: end },
      };
    } else if (event.detail >= 3) {
      const next = Math.min(position.line + 1, editor.lineCount - 1);
      editor.selection = {
        anchor: { line: position.line, character: 0 },
        focus:
          next === position.line
            ? { line: next, character: editor.line(next).length }
            : { line: next, character: 0 },
      };
    } else {
      const anchor = event.shiftKey && editor.selection ? editor.selection.anchor : position;
      editor.selection = { anchor, focus: position };
    }
    editor.writeNativeSelection();
    editor.paint();
    if (event.detail === 1) this.startDrag(event.clientX, event.clientY);
  }

  /** Drags the selection's focus, scrolling while the pointer is past the viewport's edge. */
  private startDrag(x: number, y: number) {
    this.drag?.stop();
    const move = (event: MouseEvent) => {
      if (!this.drag) return;
      this.drag.x = event.clientX;
      this.drag.y = event.clientY;
    };
    const stop = () => {
      const drag = this.drag;
      if (!drag) return;
      cancelAnimationFrame(drag.frame);
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", stop, true);
      this.drag = null;
      this.editor?.writeNativeSelection();
    };
    const tick = () => {
      const drag = this.drag;
      const editor = this.editor;
      if (!drag || !editor?.selection) return;
      const scroller = this.engine.scroller;
      if (scroller) {
        const box = scroller.getBoundingClientRect();
        const over =
          drag.y > box.bottom ? drag.y - box.bottom : drag.y < box.top ? drag.y - box.top : 0;
        if (over !== 0)
          scroller.scrollTop += Math.sign(over) * Math.min(120, Math.max(4, Math.abs(over) * 1.5));
      }
      const focus = this.positionAt(drag.x, drag.y);
      if (focus) {
        editor.selection = { anchor: editor.selection.anchor, focus };
        editor.paint();
      }
      drag.frame = requestAnimationFrame(tick);
    };
    this.drag = { x, y, frame: requestAnimationFrame(tick), stop };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", stop, true);
  }

  keyDown(event: React.KeyboardEvent<HTMLElement>) {
    const editor = this.editor;
    if (!editor || event.target !== editor.content) return;
    const mod = isMac ? event.metaKey : event.ctrlKey;
    const key = event.key.toLowerCase();
    if (isFindShortcut(event)) {
      event.preventDefault();
      editor.openFind();
    } else if (mod && key === "z") {
      event.preventDefault();
      if (event.shiftKey) editor.redo();
      else editor.undo();
    } else if (!isMac && event.ctrlKey && key === "y") {
      event.preventDefault();
      editor.redo();
    } else if (mod && key === "a" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      const last = editor.lineCount - 1;
      editor.selection = {
        anchor: { line: 0, character: 0 },
        focus: { line: last, character: editor.line(last).length },
      };
      editor.writeNativeSelection();
      editor.paint();
    } else if (event.key === "Tab" && !mod && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      editor.replaceSelection("\t");
    }
  }

  /** Every edit goes through the model; the DOM re-renders from it. */
  beforeInput(event: InputEvent) {
    const editor = this.editor;
    if (!editor || event.target !== editor.content || event.isComposing) return;
    const type = event.inputType;
    if (type === "insertCompositionText") return;
    event.preventDefault();
    editor.readNativeSelection();
    switch (type) {
      case "insertText":
      case "insertReplacementText":
      case "insertFromDrop":
      case "insertFromPaste": {
        const text = event.data ?? event.dataTransfer?.getData("text/plain") ?? "";
        if (text) editor.replaceSelection(text, type === "insertText" ? "type" : "other");
        return;
      }
      case "insertLineBreak":
      case "insertParagraph": {
        const focus = editor.selection?.focus;
        const indent = focus ? (/^[\t ]*/u.exec(editor.line(focus.line))?.[0] ?? "") : "";
        editor.replaceSelection(`\n${indent}`, "other");
        return;
      }
      case "deleteContentBackward":
        return editor.deleteBy(-1, "character");
      case "deleteContentForward":
        return editor.deleteBy(1, "character");
      case "deleteWordBackward":
        return editor.deleteBy(-1, "word");
      case "deleteWordForward":
        return editor.deleteBy(1, "word");
      case "deleteSoftLineBackward":
      case "deleteHardLineBackward":
        return editor.deleteBy(-1, "line");
      case "deleteSoftLineForward":
      case "deleteHardLineForward":
        return editor.deleteBy(1, "line");
      case "deleteByCut":
        return editor.replaceSelection("", "delete");
      case "historyUndo":
        return editor.undo();
      case "historyRedo":
        return editor.redo();
    }
  }

  clipboard(event: React.ClipboardEvent<HTMLElement>, cut: boolean) {
    const editor = this.editor;
    if (
      !editor ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLInputElement
    )
      return;
    const text = editor.selectedText();
    if (!text) return;
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
    if (cut) editor.replaceSelection("", "delete");
  }

  paste(event: React.ClipboardEvent<HTMLElement>) {
    const editor = this.editor;
    if (
      !editor ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLInputElement
    )
      return;
    event.preventDefault();
    editor.readNativeSelection();
    editor.replaceSelection(event.clipboardData.getData("text/plain"), "other");
  }

  compositionEnd(event: React.CompositionEvent<HTMLElement>) {
    const editor = this.editor;
    if (!editor) return;
    // The browser wrote the composed text into rows React owns; rebuild them from the model.
    this.epoch++;
    editor.replaceSelection(event.data, "type");
  }
}

const instances = new WeakMap<FileViewInstance, FileController<unknown>>();
function controller(instance: FileViewInstance) {
  return instances.get(instance)!;
}

/** A file's lines, windowed against the enclosing `Virtualizer`; with `edit`, an editor. */
export function File<L = undefined>(props: FileProps<L>) {
  const context = use(VirtualizerContext);
  const [file] = useState(() => new FileController<L>());
  const [version, rerender] = useReducer((count: number) => count + 1, 0);
  const view = file.sync(props, rerender, context, version);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the committed rows, keeps the viewport's top row in place, and redraws the selection before paint.
  useLayoutEffect(() => {
    file.engine.attach(
      context?.scroller ?? null,
      file.root,
      file.root?.querySelector("[data-font-probe]") ?? null,
    );
    file.commit();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports the unmount and releases listeners and the editor.
  useLayoutEffect(() => () => file.unmount(), [file]);
  const { editor } = view;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the document selection into the editor, which only the document reports.
  useLayoutEffect(() => {
    if (!editor) return;
    const sync = () => editor.readNativeSelection();
    document.addEventListener("selectionchange", sync);
    return () => document.removeEventListener("selectionchange", sync);
  }, [editor]);

  const options = props.options ?? {};
  const [dragged, setDragged] = useState<SelectedLineRange | null>(null);
  const selection = dragged ?? props.selectedLines ?? null;
  const gutter = useGutter({
    lineSelection: options.enableLineSelection === true,
    gutterUtility: options.enableGutterUtility === true,
    selection,
    pointAt: (cell) => {
      const row = Number(cell.dataset.row);
      const line = view.rows.line(row);
      return line < 0 ? null : { row, lineNumber: line + 1 };
    },
    pointFor: (lineNumber) =>
      lineNumber >= 1 && lineNumber <= view.lineCount
        ? { row: view.rows.rowOfLine(lineNumber - 1), lineNumber }
        : null,
    onChange: (range) => {
      setDragged(range);
      options.onLineSelectionChange?.(range);
    },
    onEnd: (range) => {
      setDragged(null);
      options.onLineSelectionEnd?.(range);
    },
    onUtility: (range) => {
      setDragged(null);
      options.onGutterUtilityClick?.(range);
    },
  });

  const { start, end } = view;
  const selected = selection
    ? ([
        view.rows.rowOfLine(Math.min(selection.start, selection.end) - 1),
        view.rows.rowOfLine(Math.max(selection.start, selection.end) - 1),
      ] as const)
    : null;
  const gutterCells: ReactNode[] = [];
  const contentCells: ReactNode[] = [];
  for (let row = start; row < end; row++) {
    const isSelected = selected !== null && row >= selected[0] && row <= selected[1];
    const line = view.rows.line(row);
    if (line < 0) {
      const lineNumber = view.rows.annotationLine(row);
      const [cellGutter, cellContent] = annotationCells(
        `n${lineNumber}`,
        row,
        isSelected,
        (view.byLine.get(lineNumber) ?? []).map((annotation, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- a line's annotations keep their order and carry no ids.
          <div key={index} data-annotation-slot="" contentEditable={editor ? false : undefined}>
            {props.renderAnnotation?.(annotation)}
          </div>
        )),
      );
      gutterCells.push(cellGutter);
      contentCells.push(cellContent);
      continue;
    }
    const hovered = gutter.hovered === row;
    const key = `${view.epoch}:${line}`;
    gutterCells.push(
      <NumberCell
        key={key}
        row={row}
        lineNumber={line + 1}
        selected={isSelected}
        hovered={hovered}
        utility={hovered ? gutter.utility(row) : null}
      />,
    );
    contentCells.push(
      <LineCell
        key={key}
        row={row}
        lineNumber={line + 1}
        text={view.tokens.lines[line]!}
        tokens={view.tokens.tokens(line)}
        selected={isSelected}
        hovered={hovered}
      />,
    );
  }
  const span = { gridRow: `span ${Math.max(1, end - start)}` };
  const style = {
    "--diffs-min-number-column-width-default": `${view.digits}ch`,
    "--diffs-gutter-width": `calc(${view.digits + 3}ch + 2px)`,
    "--diffs-content-min-width": `${view.maxChars + 2}ch`,
  } as CSSProperties;
  return (
    <diffs-file
      ref={(node: HTMLElement | null) => file.attachRoot(node)}
      className={props.className}
      data-section="0"
      data-hl-theme={ensureThemeStyles(options.theme ?? "pierre-dark")}
      style={options.themeType ? { colorScheme: options.themeType } : undefined}
    >
      {editor && view.find?.open ? (
        <SearchWidget
          inputRef={(node) => editor.attach("findInput", node)}
          query={view.find.query}
          total={view.find.matches.length}
          current={view.find.current}
          onQueryChange={(query) => editor.searchFor(query)}
          onNavigate={(direction) => editor.navigateFind(direction)}
          onClose={() => editor.closeFind()}
          replace={{
            value: view.find.replace,
            onChange: (value) => editor.setReplacement(value),
            onReplace: () => editor.replaceCurrent(),
            onReplaceAll: () => editor.replaceAll(),
          }}
        />
      ) : null}
      <div data-virtualizer-buffer="before" style={{ height: view.before }} />
      <pre
        data-file=""
        data-overflow={options.overflow ?? "scroll"}
        data-interactive-line-numbers={options.enableLineSelection ? "" : undefined}
        data-editable={editor ? "" : undefined}
        style={style}
        tabIndex={editor ? undefined : -1}
        onKeyDown={
          editor
            ? undefined
            : (event) => {
                const mod = isMac ? event.metaKey : event.ctrlKey;
                if (!mod || event.key.toLowerCase() !== "a" || event.shiftKey || event.altKey)
                  return;
                const content = event.currentTarget.querySelector("[data-content]");
                if (!content) return;
                event.preventDefault();
                document.getSelection()?.selectAllChildren(content);
              }
        }
        {...gutter.handlers}
      >
        <code data-code="" data-container-size="">
          <div data-gutter="" style={span}>
            {gutterCells}
          </div>
          <div
            ref={(node) => (editor && node ? file.attachContent(editor, node) : undefined)}
            data-content=""
            style={span}
            contentEditable={editor ? "true" : undefined}
            suppressContentEditableWarning
            spellCheck={editor ? false : undefined}
            autoCorrect={editor ? "off" : undefined}
            autoCapitalize={editor ? "off" : undefined}
            translate={editor ? "no" : undefined}
            role={editor ? "textbox" : undefined}
            aria-multiline={editor ? true : undefined}
            onMouseDown={editor ? (event) => file.pressContent(event) : undefined}
            onKeyDown={editor ? (event) => file.keyDown(event) : undefined}
            onCopy={editor ? (event) => file.clipboard(event, false) : undefined}
            onCut={editor ? (event) => file.clipboard(event, true) : undefined}
            onPaste={editor ? (event) => file.paste(event) : undefined}
            onCompositionEnd={editor ? (event) => file.compositionEnd(event) : undefined}
            onFocus={editor ? () => editor.paint() : undefined}
          >
            {contentCells}
          </div>
          {editor ? (
            <div ref={(node) => editor.attach("layer", node)} data-selection-layer="" aria-hidden />
          ) : null}
        </code>
      </pre>
      <div data-virtualizer-buffer="after" style={{ height: view.after }} />
      <div data-font-probe="" aria-hidden>
        {"0".repeat(PROBE_LENGTH)}
      </div>
    </diffs-file>
  );
}
