import { memo, type ReactNode } from "react";

import { lineHtml } from "./tokens";

export interface LineCellProps {
  readonly row: number;
  readonly lineNumber: number;
  readonly altLineNumber?: number | undefined;
  readonly type?: string | undefined;
  readonly text: string;
  readonly tokens: Uint32Array | undefined;
  readonly emphasis?: ReadonlyArray<number> | undefined;
  readonly selected: boolean;
  readonly hovered: boolean;
}

/** A line's code. Rows re-render only when their own text, tokens, or state change. */
export const LineCell = memo(function LineCell(props: LineCellProps) {
  return (
    <div
      data-line={props.lineNumber}
      data-alt-line={props.altLineNumber}
      data-line-type={props.type}
      data-row={props.row}
      data-selected-line={props.selected ? "" : undefined}
      data-hovered={props.hovered ? "" : undefined}
      dangerouslySetInnerHTML={{ __html: lineHtml(props.text, props.tokens, props.emphasis) }}
    />
  );
});

export function NumberCell(props: {
  readonly row: number;
  readonly lineNumber: number;
  readonly type?: string | undefined;
  readonly selected: boolean;
  readonly hovered: boolean;
  readonly utility?: ReactNode;
}) {
  return (
    <div
      data-line-type={props.type}
      data-column-number={props.lineNumber}
      data-row={props.row}
      data-selected-line={props.selected ? "" : undefined}
      data-hovered={props.hovered ? "" : undefined}
    >
      <span data-line-number-content="">{props.lineNumber}</span>
      {props.utility}
    </div>
  );
}

/** The gutter and code cells of an annotation row. */
export function annotationCells(
  key: string,
  row: number,
  selected: boolean,
  children: ReactNode,
): [ReactNode, ReactNode] {
  const mark = selected ? "" : undefined;
  return [
    <div key={key} data-gutter-buffer="annotation" data-row={row} data-selected-line={mark} />,
    <div key={key} data-line-annotation="" data-row={row} data-selected-line={mark}>
      <div data-annotation-content="">{children}</div>
    </div>,
  ];
}

export function UtilityButton(props: {
  readonly label: string;
  readonly onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div data-gutter-utility-slot="">
      <button
        type="button"
        data-utility-button=""
        aria-label={props.label}
        onPointerDown={props.onPointerDown}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path
            fill="currentColor"
            d="M8 3a.75.75 0 0 1 .75.75v3.5h3.5a.75.75 0 0 1 0 1.5h-3.5v3.5a.75.75 0 0 1-1.5 0v-3.5h-3.5a.75.75 0 0 1 0-1.5h3.5v-3.5A.75.75 0 0 1 8 3"
          />
        </svg>
      </button>
    </div>
  );
}

/** Row heights before measurement. */
export function estimateLineHeight(
  length: number,
  metrics: { lineHeight: number; charWidth: number; width: number },
  columns: number,
  gutterChars: number,
) {
  if (metrics.width === 0) return metrics.lineHeight;
  const available = metrics.width / columns - (gutterChars + 4) * metrics.charWidth;
  const perLine = Math.max(8, Math.floor(available / metrics.charWidth));
  return metrics.lineHeight * Math.max(1, Math.ceil(length / perLine));
}
