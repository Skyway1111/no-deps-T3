import type {
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
  SelectionSide,
} from "@t3tools/shared/diff/patch";
import { useGT } from "@t3tools/shared/i18n/react";
import type { CSSProperties, ReactNode } from "react";

import {
  buildDiffRows,
  type DiffLayoutInput,
  type DiffRow,
  type LineRef,
  wordEmphasis,
} from "./diffLayout";
import type { SectionSpec } from "./engine";
import { annotationCells, estimateLineHeight, LineCell, NumberCell } from "./rows";
import { languageOf, tokensFor, type LineTokens } from "./tokens";

export type SeparatorStyle = DiffLayoutInput["separators"];

export interface DiffModel {
  readonly diff: FileDiffMetadata;
  readonly rows: ReadonlyArray<DiffRow>;
  /** `${side}:${lineNumber}` to row; a context line is under both sides. */
  readonly rowOf: ReadonlyMap<string, number>;
  readonly deletions: LineTokens;
  readonly additions: LineTokens;
  readonly split: boolean;
  readonly separators: SeparatorStyle;
  readonly emphasis: boolean;
  readonly digits: number;
  readonly maxChars: number;
  readonly emphasisCache: Map<number, ReadonlyArray<number> | undefined>;
  readonly rowByKey: ReadonlyMap<string, number>;
}

function stripBreak(line: string) {
  return line.endsWith("\n") ? line.slice(0, line.endsWith("\r\n") ? -2 : -1) : line;
}

function sideTokens(diff: FileDiffMetadata, side: SelectionSide): LineTokens {
  const lines = side === "additions" ? diff.additionLines : diff.deletionLines;
  const name = side === "deletions" ? (diff.prevName ?? diff.name) : diff.name;
  return tokensFor(
    diff.cacheKey === undefined ? undefined : `${diff.cacheKey}:${side}`,
    lines,
    languageOf(name, diff.lang),
    () => lines.map(stripBreak),
  );
}

export function buildDiffModel(input: DiffLayoutInput & { readonly emphasis: boolean }): DiffModel {
  const rows = buildDiffRows(input);
  const rowOf = new Map<string, number>();
  let maxLine = 0;
  rows.forEach((row, index) => {
    if (row.kind !== "line") return;
    for (const line of [row.left, row.right]) {
      if (!line) continue;
      rowOf.set(`${line.side}:${line.lineNumber}`, index);
      if (line.altLineNumber !== undefined) rowOf.set(`deletions:${line.altLineNumber}`, index);
      maxLine = Math.max(maxLine, line.lineNumber, line.altLineNumber ?? 0);
    }
  });
  const deletions = sideTokens(input.diff, "deletions");
  const additions = sideTokens(input.diff, "additions");
  let maxChars = 0;
  for (const lines of [deletions.lines, additions.lines])
    for (const line of lines) if (line.length > maxChars) maxChars = line.length;
  return {
    diff: input.diff,
    rows,
    rowOf,
    deletions,
    additions,
    split: input.split,
    separators: input.separators,
    emphasis: input.emphasis,
    digits: Math.max(3, String(maxLine).length),
    maxChars,
    emphasisCache: new Map(),
    rowByKey: new Map(rows.map((row, index) => [row.key, index])),
  };
}

export function lineText(model: DiffModel, line: LineRef) {
  return (line.side === "additions" ? model.additions : model.deletions).lines[line.index] ?? "";
}

export function diffSectionSpec(
  key: string,
  model: DiffModel,
  options: { readonly hasHeader: boolean; readonly collapsed: boolean },
): SectionSpec {
  const columns = model.split ? 2 : 1;
  return {
    key,
    hasHeader: options.hasHeader,
    padTop: options.hasHeader ? 0 : 8,
    padBottom: 8,
    collapsed: options.collapsed,
    rowCount: model.rows.length,
    rowKey: (row) => model.rows[row]!.key,
    rowIndex: (rowKey) => model.rowByKey.get(rowKey),
    kind: (index) =>
      model.rows[index]!.kind === "separator" ? `separator:${model.separators}` : undefined,
    estimate: (index, metrics) => {
      const row = model.rows[index]!;
      if (row.kind === "separator") return model.separators === "simple" ? 4 : 32;
      if (row.kind === "annotation") return metrics.lineHeight * 2;
      const length = Math.max(
        row.left ? lineText(model, row.left).length : 0,
        row.right ? lineText(model, row.right).length : 0,
      );
      return estimateLineHeight(length, metrics, columns, model.digits);
    },
  };
}

/**
 * Split scroll diffs are two grids, one per side, so an annotation row only lines up when both
 * sides' cells take the taller annotation's height.
 */
export function syncSplitAnnotations(root: HTMLElement) {
  for (const pre of root.querySelectorAll('[data-diff-type="split"][data-overflow="scroll"]')) {
    const right = new Map<string, HTMLElement>();
    for (const cell of pre.querySelectorAll<HTMLElement>(
      ":scope > [data-additions] > [data-content] > [data-line-annotation]",
    ))
      right.set(cell.dataset.row!, cell);
    for (const left of pre.querySelectorAll<HTMLElement>(
      ":scope > [data-deletions] > [data-content] > [data-line-annotation]",
    )) {
      const other = right.get(left.dataset.row!);
      if (!other) continue;
      const height = `${Math.max(
        left.firstElementChild?.getBoundingClientRect().height ?? 0,
        other.firstElementChild?.getBoundingClientRect().height ?? 0,
      )}px`;
      if (left.style.minHeight !== height) left.style.minHeight = height;
      if (other.style.minHeight !== height) other.style.minHeight = height;
    }
  }
}

/** The row range a line selection covers. */
export function selectedRows(model: DiffModel, range: SelectedLineRange | null) {
  if (!range) return null;
  const start = model.rowOf.get(`${range.side ?? "additions"}:${range.start}`);
  const end = model.rowOf.get(`${range.endSide ?? range.side ?? "additions"}:${range.end}`);
  if (start === undefined || end === undefined) return null;
  return start <= end ? ([start, end] as const) : ([end, start] as const);
}

function emphasisOf(model: DiffModel, row: number, line: LineRef) {
  if (!model.emphasis || line.partner === undefined) return undefined;
  const key = row * 2 + (line.side === "additions" ? 1 : 0);
  if (model.emphasisCache.has(key)) return model.emphasisCache.get(key);
  const partner =
    (line.side === "additions" ? model.deletions : model.additions).lines[line.partner] ?? "";
  const ranges = wordEmphasis(lineText(model, line), partner, line.side === "additions");
  model.emphasisCache.set(key, ranges);
  return ranges;
}

export interface DiffBodyProps {
  readonly model: DiffModel;
  readonly start: number;
  readonly end: number;
  readonly overflow: "scroll" | "wrap";
  readonly entering?: boolean;
  /** Changes when idle tokenizing reaches more lines, so rows pick up their colors. */
  readonly tokensVersion?: number;
  readonly selected: readonly [number, number] | null;
  readonly hovered: number | null;
  readonly interactive: boolean;
  readonly utility: (row: number) => ReactNode;
  readonly renderAnnotation: (annotation: DiffLineAnnotation<unknown>) => ReactNode;
  readonly onExpand: (hunkIndex: number, direction: "up" | "down" | "both", count?: number) => void;
  readonly handlers: GutterHandlers;
}

export type GutterHandlers = Pick<
  React.DOMAttributes<HTMLElement>,
  "onPointerDown" | "onPointerMove" | "onPointerLeave" | "onPointerUp" | "onPointerCancel"
>;

function ExpandIcon({ direction }: { direction: "up" | "down" | "both" }) {
  return (
    <svg data-icon="" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d={
          direction === "both"
            ? "M11.47 9.47a.75.75 0 1 1 1.06 1.06l-4 4a.75.75 0 0 1-1.06 0l-4-4a.75.75 0 1 1 1.06-1.06L8 12.94zM7.526 1.418a.75.75 0 0 1 1.004.052l4 4a.75.75 0 1 1-1.06 1.06L8 3.06 4.53 6.53a.75.75 0 1 1-1.06-1.06l4-4z"
            : "M3.47 10.53a.75.75 0 0 0 1.06 0L8 7.06l3.47 3.47a.75.75 0 1 0 1.06-1.06l-4-4a.75.75 0 0 0-1.06 0l-4 4a.75.75 0 0 0 0 1.06"
        }
      />
    </svg>
  );
}

const EXPAND_DIRECTIONS = {
  leading: ["down"],
  middle: ["up", "down"],
  trailing: ["up"],
} as const;

function Separator(props: {
  readonly row: Extract<DiffRow, { kind: "separator" }>;
  readonly index: number;
  readonly style: SeparatorStyle;
  readonly controls: boolean;
  readonly first: boolean;
  readonly last: boolean;
  readonly onExpand: DiffBodyProps["onExpand"];
}) {
  const gt = useGT();
  const { row } = props;
  const expandable = props.controls && row.expandable;
  const directions = row.hidden <= 100 ? (["both"] as const) : EXPAND_DIRECTIONS[row.position];
  const label = (direction: "up" | "down" | "both") =>
    direction === "both"
      ? gt("Expand all unmodified lines")
      : direction === "up"
        ? gt("Expand unmodified lines above")
        : gt("Expand unmodified lines below");
  return (
    <div
      data-separator={props.style}
      data-row={props.index}
      data-expand-index={expandable ? row.hunkIndex : undefined}
      data-separator-first={props.first ? "" : undefined}
      data-separator-last={props.last ? "" : undefined}
    >
      {props.controls && props.style !== "simple" ? (
        <div
          data-separator-wrapper=""
          data-separator-multi-button={expandable && directions.length > 1 ? "" : undefined}
        >
          {expandable
            ? directions.map((direction) => (
                <button
                  key={direction}
                  type="button"
                  data-expand-button=""
                  {...{ [`data-expand-${direction}`]: "" }}
                  aria-label={label(direction)}
                  onClick={() => props.onExpand(row.hunkIndex, direction)}
                >
                  <ExpandIcon direction={direction} />
                </button>
              ))
            : null}
          <div
            data-separator-content=""
            onClick={
              expandable ? () => props.onExpand(row.hunkIndex, "both", row.hidden) : undefined
            }
          >
            <span data-unmodified-lines="">
              {gt("{count, plural, one {# unmodified line} other {# unmodified lines}}", {
                count: row.hidden,
              })}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function sideCells(
  props: DiffBodyProps,
  index: number,
  side: "left" | "right" | "unified",
): [ReactNode, ReactNode] {
  const { model } = props;
  const row = model.rows[index]!;
  const selected =
    props.selected !== null && index >= props.selected[0] && index <= props.selected[1];
  if (row.kind === "separator") {
    const separator = (controls: boolean) => (
      <Separator
        key={row.key}
        row={row}
        index={index}
        style={model.separators}
        controls={controls}
        first={index === 0}
        last={index === model.rows.length - 1}
        onExpand={props.onExpand}
      />
    );
    return [separator(side !== "right"), separator(false)];
  }
  if (row.kind === "annotation") {
    const annotations = side === "left" ? row.left : row.right;
    return annotationCells(
      row.key,
      index,
      selected,
      annotations.map((annotation) => (
        <div key={`${annotation.side}:${annotation.lineNumber}`} data-annotation-slot="">
          {props.renderAnnotation(annotation)}
        </div>
      )),
    );
  }
  const line = side === "left" ? row.left : side === "right" ? row.right : (row.left ?? row.right);
  if (!line) {
    return [
      <div key={row.key} data-gutter-buffer="buffer" data-row={index} />,
      <div key={row.key} data-content-buffer="" data-row={index} />,
    ];
  }
  const hovered = props.hovered === index;
  return [
    <NumberCell
      key={row.key}
      row={index}
      lineNumber={line.lineNumber}
      type={line.type}
      selected={selected}
      hovered={hovered}
      utility={hovered ? props.utility(index) : null}
    />,
    <LineCell
      key={row.key}
      row={index}
      lineNumber={line.lineNumber}
      altLineNumber={line.altLineNumber}
      type={line.type}
      text={lineText(model, line)}
      tokens={(line.side === "additions" ? model.additions : model.deletions).tokens(line.index)}
      emphasis={emphasisOf(model, index, line)}
      selected={selected}
      hovered={hovered}
    />,
  ];
}

function codeColumn(props: DiffBodyProps, side: "left" | "right" | "unified") {
  const gutter: ReactNode[] = [];
  const content: ReactNode[] = [];
  for (let index = props.start; index < props.end; index++) {
    const [number, line] = sideCells(props, index, side);
    gutter.push(number);
    content.push(line);
  }
  const span = { gridRow: `span ${Math.max(1, props.end - props.start)}` };
  const sideAttribute =
    side === "left"
      ? { "data-deletions": "" }
      : side === "right"
        ? { "data-additions": "" }
        : { "data-unified": "" };
  return (
    <code key={side} data-code="" data-container-size="" {...sideAttribute}>
      <div data-gutter="" style={span}>
        {gutter}
      </div>
      <div data-content="" style={span}>
        {content}
      </div>
    </code>
  );
}

/** A diff's rows from `start` to `end`, unified or split, in Pierre's DOM shape. */
export function DiffBody(props: DiffBodyProps) {
  const { model } = props;
  const style = {
    "--diffs-min-number-column-width-default": `${model.digits}ch`,
    "--diffs-gutter-width": `calc(${model.digits + 3}ch + 2px)`,
    "--diffs-content-min-width": `${model.maxChars + 2}ch`,
  } as CSSProperties;
  return (
    <pre
      data-diff=""
      data-diff-type={model.split ? "split" : "unified"}
      data-overflow={props.overflow}
      data-background=""
      data-indicators="bars"
      data-interactive-line-numbers={props.interactive ? "" : undefined}
      data-entering={props.entering ? "" : undefined}
      style={style}
      {...props.handlers}
    >
      {model.split
        ? [codeColumn(props, "left"), codeColumn(props, "right")]
        : codeColumn(props, "unified")}
    </pre>
  );
}

function ChangeIcon({ type }: { type: FileDiffMetadata["type"] }) {
  const inner =
    type === "new"
      ? "M8 4a.75.75 0 0 1 .75.75v2.5h2.5a.75.75 0 0 1 0 1.5h-2.5v2.5a.75.75 0 0 1-1.5 0v-2.5h-2.5a.75.75 0 0 1 0-1.5h2.5v-2.5A.75.75 0 0 1 8 4"
      : type === "deleted"
        ? "M4.75 7.25h6.5a.75.75 0 0 1 0 1.5h-6.5a.75.75 0 0 1 0-1.5"
        : type === "change"
          ? "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6"
          : "M8.47 4.22a.75.75 0 0 0 0 1.06l1.97 1.97H4.75a.75.75 0 0 0 0 1.5h5.69l-1.97 1.97a.75.75 0 1 0 1.06 1.06l3.25-3.25a.75.75 0 0 0 0-1.06L9.53 4.22a.75.75 0 0 0-1.06 0";
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" data-change-icon={type} aria-hidden="true">
      <path
        fill="currentColor"
        d="M1.5 8c0 1.613.088 2.806.288 3.704.196.88.478 1.381.802 1.706s.826.607 1.706.802c.898.2 2.091.288 3.704.288s2.806-.088 3.704-.288c.88-.195 1.381-.478 1.706-.802s.607-.826.802-1.706c.2-.898.288-2.091.288-3.704s-.088-2.806-.288-3.704c-.195-.88-.478-1.381-.802-1.706s-.826-.606-1.706-.802C10.806 1.588 9.613 1.5 8 1.5s-2.806.088-3.704.288c-.88.196-1.381.478-1.706.802s-.606.826-.802 1.706C1.588 5.194 1.5 6.387 1.5 8M0 8c0-6.588 1.412-8 8-8s8 1.412 8 8-1.412 8-8 8-8-1.412-8-8"
      />
      <path fill="currentColor" d={inner} />
    </svg>
  );
}

export function DiffHeader(props: {
  readonly diff: FileDiffMetadata;
  readonly sticky: boolean;
  readonly prefix?: ReactNode;
  readonly suffix?: ReactNode;
  readonly metadata?: ReactNode;
}) {
  const { diff } = props;
  let additions = 0;
  let deletions = 0;
  for (const hunk of diff.hunks) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  return (
    <div
      data-diffs-header="default"
      data-change-type={diff.type}
      data-sticky={props.sticky ? "" : undefined}
    >
      <div data-header-content="">
        {props.prefix}
        <ChangeIcon type={diff.type} />
        {diff.prevName !== undefined && diff.prevName !== diff.name ? (
          <>
            <div data-prev-name="">
              <bdi>{diff.prevName}</bdi>
            </div>
            <svg width="16" height="16" viewBox="0 0 16 16" data-rename-icon="" aria-hidden="true">
              <path
                fill="currentColor"
                d="M8.47 4.22a.75.75 0 0 0 0 1.06l1.97 1.97H3.75a.75.75 0 0 0 0 1.5h6.69l-1.97 1.97a.75.75 0 1 0 1.06 1.06l3.25-3.25a.75.75 0 0 0 0-1.06L9.53 4.22a.75.75 0 0 0-1.06 0"
              />
            </svg>
          </>
        ) : null}
        <div data-title="">
          <bdi>{diff.name}</bdi>
        </div>
        {props.suffix}
      </div>
      <div data-metadata="">
        {deletions > 0 ? <span data-deletions-count="">-{deletions}</span> : null}
        {additions > 0 ? <span data-additions-count="">+{additions}</span> : null}
        {props.metadata}
      </div>
    </div>
  );
}
