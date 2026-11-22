import type {
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
  SelectionSide,
} from "@t3tools/shared/diff/patch";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { observeResize } from "~/lib/observeResize";

import {
  EXPANSION_LINE_COUNT,
  growRegion,
  hydratedDiff,
  loadHydratedDiff,
  type Expansion,
} from "./diffLayout";
import {
  buildDiffModel,
  DiffBody,
  DiffHeader,
  selectedRows,
  syncSplitAnnotations,
} from "./DiffBody";
import { useGutter } from "./gutter";
import { ensureThemeStyles } from "./tokens";
import type { FileDiffOptions } from "./types";
import "./codeView.css";

const NO_EXPANSION: Expansion = new Map();

/** One file's diff, every row rendered; for short diffs outside a code view. */
export function FileDiff<L = undefined>(props: {
  readonly fileDiff: FileDiffMetadata;
  readonly options?: FileDiffOptions;
  readonly lineAnnotations?: ReadonlyArray<DiffLineAnnotation<L>>;
  readonly selectedLines?: SelectedLineRange | null;
  readonly renderAnnotation?: (annotation: DiffLineAnnotation<L>) => ReactNode;
  readonly renderHeaderPrefix?: () => ReactNode;
  readonly renderHeaderFilenameSuffix?: () => ReactNode;
  readonly renderHeaderMetadata?: () => ReactNode;
  readonly className?: string;
}) {
  const options = props.options ?? {};
  const [expansion, setExpansion] = useState(NO_EXPANSION);
  const [ownSelection, setOwnSelection] = useState<SelectedLineRange | null>(null);
  const [dragged, setDragged] = useState<SelectedLineRange | null>(null);
  const diff = hydratedDiff(props.fileDiff);
  const model = buildDiffModel({
    diff,
    split: options.diffStyle === "split",
    expansion,
    separators: options.hunkSeparators ?? "line-info",
    annotations: (props.lineAnnotations ?? []) as ReadonlyArray<DiffLineAnnotation<unknown>>,
    canLoad: options.loadDiffFiles !== undefined,
    emphasis: (options.lineDiffType ?? "word-alt") !== "none",
  });
  const selection =
    dragged ?? (props.selectedLines !== undefined ? props.selectedLines : ownSelection);
  const pointFor = (lineNumber: number, side: SelectionSide | undefined) => {
    const row = model.rowOf.get(`${side ?? "additions"}:${lineNumber}`);
    return row === undefined ? null : { row, lineNumber, side: side ?? "additions" };
  };
  const gutter = useGutter({
    lineSelection: options.enableLineSelection === true,
    gutterUtility: options.enableGutterUtility === true,
    selection,
    pointAt: (cell) => {
      const row = Number(cell.dataset.row);
      const entry = model.rows[row];
      if (entry?.kind !== "line") return null;
      const left = cell.closest("[data-deletions]") !== null;
      const line = model.split
        ? ((left ? entry.left : entry.right) ?? (left ? entry.right : entry.left))
        : (entry.left ?? entry.right);
      return line ? { row, lineNumber: line.lineNumber, side: line.side } : null;
    },
    pointFor,
    onChange: (range) => {
      setDragged(range);
      options.onLineSelectionChange?.(range);
    },
    onEnd: (range) => {
      setDragged(null);
      if (props.selectedLines === undefined) setOwnSelection(range);
      options.onLineSelectionEnd?.(range);
    },
    onUtility: (range) => {
      setDragged(null);
      if (props.selectedLines === undefined) setOwnSelection(range);
      options.onGutterUtilityClick?.(range);
    },
  });
  const expand = (
    hunkIndex: number,
    direction: "up" | "down" | "both",
    count = EXPANSION_LINE_COUNT,
  ) => {
    const apply = () =>
      setExpansion((current) =>
        new Map(current).set(hunkIndex, growRegion(current.get(hunkIndex), direction, count)),
      );
    if (!diff.isPartial) return apply();
    if (options.loadDiffFiles)
      loadHydratedDiff(diff, options.loadDiffFiles).then(apply, console.error);
  };
  const container = useRef<HTMLElement | null>(null);
  const split = options.diffStyle === "split";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aligns split annotation rows across the two side grids before paint.
  useLayoutEffect(() => {
    const node = container.current;
    if (!node || !split) return;
    syncSplitAnnotations(node);
    return observeResize(node, () => syncSplitAnnotations(node));
  });
  const hasHeader = options.disableFileHeader !== true;
  return (
    <diffs-file
      ref={container}
      className={props.className}
      data-hl-theme={ensureThemeStyles(options.theme ?? "pierre-dark")}
      style={options.themeType ? { colorScheme: options.themeType } : undefined}
    >
      {hasHeader ? (
        <DiffHeader
          diff={props.fileDiff}
          sticky={false}
          prefix={props.renderHeaderPrefix?.()}
          suffix={props.renderHeaderFilenameSuffix?.()}
          metadata={props.renderHeaderMetadata?.()}
        />
      ) : null}
      {options.collapsed ? null : (
        <>
          {hasHeader ? null : <div data-virtualizer-buffer="before" style={{ height: 8 }} />}
          <DiffBody
            model={model}
            start={0}
            end={model.rows.length}
            overflow={options.overflow ?? "scroll"}
            selected={selectedRows(model, selection)}
            hovered={gutter.hovered}
            interactive={options.enableLineSelection === true}
            utility={gutter.utility}
            renderAnnotation={(annotation) =>
              props.renderAnnotation?.(annotation as DiffLineAnnotation<L>)
            }
            onExpand={expand}
            handlers={gutter.handlers}
          />
          <div data-virtualizer-buffer="after" style={{ height: 8 }} />
        </>
      )}
    </diffs-file>
  );
}
