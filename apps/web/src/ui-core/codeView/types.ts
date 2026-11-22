import type {
  DiffLineAnnotation,
  FileContents,
  FileDiffContentsLoader,
  FileDiffMetadata,
  HunkSeparators,
  LineAnnotation,
  LineDiffTypes,
  PostRenderPhase,
  SelectedLineRange,
  SelectionSide,
} from "@t3tools/shared/diff/patch";
import type { ReactNode, Ref } from "react";

export type {
  AnnotationSide,
  DiffLineAnnotation,
  FileContents,
  FileDiffContentsLoader,
  FileDiffMetadata,
  LineAnnotation,
  PostRenderPhase,
  SelectedLineRange,
  SelectionSide,
} from "@t3tools/shared/diff/patch";

export interface LinePosition {
  readonly top: number;
  readonly height: number;
}

/** What a diff view exposes to post-render hooks and the code view's rendered items. */
export interface FileDiffInstance {
  readonly fileDiff: FileDiffMetadata;
  getDiffForSearch(): FileDiffMetadata;
  /** Expands the collapsed context holding a line; false when it is already shown. */
  revealLine(lineNumber: number, side?: SelectionSide): boolean;
  expandHunk(hunkIndex: number, direction: "up" | "down" | "both", lineCount?: number): void;
  /** The line's row relative to the top of the diff, when the line has one. */
  getLinePosition(lineNumber: number, side?: SelectionSide): LinePosition | undefined;
}

interface ViewOptions {
  readonly theme?: string;
  readonly themeType?: "light" | "dark";
  readonly overflow?: "scroll" | "wrap";
  readonly enableLineSelection?: boolean;
  readonly enableGutterUtility?: boolean;
}

export interface FileDiffOptions extends ViewOptions {
  readonly diffStyle?: "unified" | "split";
  readonly lineDiffType?: LineDiffTypes;
  readonly hunkSeparators?: Exclude<HunkSeparators, "metadata" | "custom">;
  readonly disableFileHeader?: boolean;
  readonly collapsed?: boolean;
  /** Whole-file contents for a patch-only diff, so its unchanged lines can expand. */
  readonly loadDiffFiles?: FileDiffContentsLoader;
  readonly onGutterUtilityClick?: (range: SelectedLineRange) => void;
  readonly onLineSelectionChange?: (range: SelectedLineRange | null) => void;
  readonly onLineSelectionEnd?: (range: SelectedLineRange | null) => void;
}

export interface CodeViewDiffItem<LAnnotation = undefined> {
  readonly id: string;
  readonly type: "diff";
  readonly fileDiff: FileDiffMetadata;
  readonly annotations?: ReadonlyArray<DiffLineAnnotation<LAnnotation>>;
  readonly collapsed?: boolean;
  /** When set, the item re-lays out only when this or its diff changes. */
  readonly version?: number;
}

export type CodeViewItem<LAnnotation = undefined> = CodeViewDiffItem<LAnnotation>;

export interface CodeViewLineSelection {
  readonly id: string;
  readonly range: SelectedLineRange;
}

export type CodeViewScrollAlign = "start" | "center" | "end" | "nearest";

export type CodeViewScrollTarget =
  | { readonly type: "position"; readonly position: number }
  | { readonly type: "item"; readonly id: string; readonly align?: CodeViewScrollAlign }
  | {
      readonly type: "line";
      readonly id: string;
      readonly lineNumber: number;
      readonly side?: SelectionSide;
      readonly align?: CodeViewScrollAlign;
    }
  | {
      readonly type: "range";
      readonly id: string;
      readonly range: SelectedLineRange;
      readonly align?: CodeViewScrollAlign;
    };

export interface CodeViewInstance {
  getHeight(): number;
  getScrollHeight(): number;
  getRenderedItems(): ReadonlyArray<{ readonly id: string; readonly instance: FileDiffInstance }>;
  render(immediate?: boolean): void;
}

export interface CodeViewHandle<LAnnotation = undefined> {
  getInstance(): CodeViewInstance | undefined;
  getItem(id: string): CodeViewItem<LAnnotation> | undefined;
  scrollTo(target: CodeViewScrollTarget): void;
  openSearch(query?: string): void;
  closeSearch(): void;
  isSearchOpen(): boolean;
  navigateSearch(direction: 1 | -1): void;
}

interface ItemContext<LAnnotation> {
  readonly item: CodeViewItem<LAnnotation>;
}

export interface CodeViewOptions<LAnnotation = undefined> extends Omit<
  FileDiffOptions,
  | "collapsed"
  | "disableFileHeader"
  | "onGutterUtilityClick"
  | "onLineSelectionChange"
  | "onLineSelectionEnd"
> {
  readonly stickyHeaders?: boolean;
  readonly onGutterUtilityClick?: (
    range: SelectedLineRange,
    context: ItemContext<LAnnotation>,
  ) => void;
  readonly onLineSelectionEnd?: (
    range: SelectedLineRange | null,
    context: ItemContext<LAnnotation>,
  ) => void;
  readonly onItemCollapsedChange?: (
    item: CodeViewItem<LAnnotation>,
    nextItem: CodeViewItem<LAnnotation>,
  ) => void;
  /** After each render of a mounted diff; `node` is its `diffs-file`. */
  readonly onPostRender?: (
    node: HTMLElement,
    instance: FileDiffInstance,
    phase: PostRenderPhase,
  ) => void;
}

export type CodeViewAnnotationArgs<LAnnotation> = [
  annotation: DiffLineAnnotation<LAnnotation>,
  fileDiff: FileDiffMetadata,
  item: CodeViewItem<LAnnotation>,
];

export interface CodeViewProps<LAnnotation = undefined> {
  readonly items: ReadonlyArray<CodeViewItem<LAnnotation>>;
  readonly options?: CodeViewOptions<LAnnotation>;
  readonly className?: string;
  readonly style?: React.CSSProperties;
  readonly ref?: Ref<CodeViewHandle<LAnnotation>>;
  readonly containerRef?: Ref<HTMLDivElement>;
  readonly selectedLines?: CodeViewLineSelection | null;
  readonly onSelectedLinesChange?: (selection: CodeViewLineSelection | null) => void;
  readonly onScroll?: (scrollTop: number, viewer: CodeViewInstance) => void;
  readonly renderAnnotation?: (...args: CodeViewAnnotationArgs<LAnnotation>) => ReactNode;
  readonly renderHeaderPrefix?: (item: CodeViewItem<LAnnotation>) => ReactNode;
  readonly renderHeaderFilenameSuffix?: (item: CodeViewItem<LAnnotation>) => ReactNode;
  readonly renderHeaderMetadata?: (item: CodeViewItem<LAnnotation>) => ReactNode;
  readonly renderCodeViewFooter?: () => ReactNode;
}

export interface FileOptions extends ViewOptions {
  readonly onGutterUtilityClick?: (range: SelectedLineRange) => void;
  readonly onLineSelectionChange?: (range: SelectedLineRange | null) => void;
  readonly onLineSelectionEnd?: (range: SelectedLineRange | null) => void;
  readonly onPostRender?: (
    node: HTMLElement,
    instance: FileViewInstance,
    phase: PostRenderPhase,
  ) => void;
}

/** What a file view exposes to post-render hooks. */
export interface FileViewInstance {
  readonly file: FileContents;
  /** The file's rendered height, including rows not mounted. */
  readonly height: number;
  getLinePosition(lineNumber: number): LinePosition | undefined;
}

export interface EditorPosition {
  readonly line: number;
  readonly character: number;
}

export interface EditorSelection {
  readonly start: EditorPosition;
  readonly end: EditorPosition;
  readonly direction: "forward" | "backward" | "none";
}

export interface EditorChangeEvent<LAnnotation> {
  readonly file: FileContents;
  readonly lineAnnotations: ReadonlyArray<LineAnnotation<LAnnotation>> | undefined;
}

export interface EditorOptions<TEditor> {
  readonly onAttach?: (editor: TEditor) => void;
  readonly onComplete?: () => void;
}
