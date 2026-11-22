import type { SelectedLineRange, SelectionSide } from "@t3tools/shared/diff/patch";
import { useGT } from "@t3tools/shared/i18n/react";
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { UtilityButton } from "./rows";

export interface LinePoint {
  readonly row: number;
  readonly lineNumber: number;
  readonly side?: SelectionSide | undefined;
}

export interface GutterOptions {
  readonly lineSelection: boolean;
  readonly gutterUtility: boolean;
  readonly selection: SelectedLineRange | null;
  /** The line a row cell (gutter or code) belongs to. */
  readonly pointAt: (cell: HTMLElement) => LinePoint | null;
  readonly pointFor: (lineNumber: number, side: SelectionSide | undefined) => LinePoint | null;
  readonly onChange: (range: SelectedLineRange | null) => void;
  readonly onEnd: (range: SelectedLineRange | null) => void;
  readonly onUtility: (range: SelectedLineRange) => void;
}

function rangeOf(anchor: LinePoint, focus: LinePoint): SelectedLineRange {
  const [start, end] = focus.row < anchor.row ? [focus, anchor] : [anchor, focus];
  return start.side === undefined
    ? { start: start.lineNumber, end: end.lineNumber }
    : { start: start.lineNumber, side: start.side, end: end.lineNumber, endSide: end.side! };
}

function cellAt(target: EventTarget | null, selector = "[data-row]") {
  return target instanceof Element ? target.closest<HTMLElement>(selector) : null;
}

/** Line-number selection, the hovered row, and the gutter's add button. */
export function useGutter(options: GutterOptions) {
  const gt = useGT();
  const [hovered, setHovered] = useState<number | null>(null);
  const drag = useRef<{
    readonly anchor: LinePoint;
    readonly utility: boolean;
    range: SelectedLineRange;
  } | null>(null);
  const tracking = options.lineSelection || options.gutterUtility;

  const begin = (event: ReactPointerEvent<HTMLElement>, point: LinePoint, utility: boolean) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const pre =
      (event.currentTarget as HTMLElement).closest<HTMLElement>("pre") ?? event.currentTarget;
    pre.setPointerCapture(event.pointerId);
    const current = options.selection;
    const inSelection =
      current !== null &&
      (() => {
        const start = options.pointFor(current.start, current.side);
        const end = options.pointFor(current.end, current.endSide ?? current.side);
        return start !== null && end !== null && point.row >= start.row && point.row <= end.row;
      })();
    if (utility && inSelection && current) {
      drag.current = { anchor: point, utility, range: current };
      return;
    }
    const anchor =
      event.shiftKey && current ? (options.pointFor(current.start, current.side) ?? point) : point;
    const range = rangeOf(anchor, point);
    drag.current = { anchor, utility, range };
    options.onChange(range);
  };

  const finish = () => {
    const ended = drag.current;
    if (!ended) return;
    drag.current = null;
    if (ended.utility) options.onUtility(ended.range);
    else options.onEnd(ended.range);
  };

  return {
    hovered: tracking ? hovered : null,
    utility: (row: number) =>
      options.gutterUtility ? (
        <UtilityButton
          label={gt("Comment on lines")}
          onPointerDown={(event) => {
            const cell = cellAt(event.currentTarget);
            const point = cell ? options.pointAt(cell) : null;
            if (point && point.row === row) begin(event, point, true);
          }}
        />
      ) : null,
    handlers: tracking
      ? {
          onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
            if (!options.lineSelection) return;
            const cell = cellAt(event.target, "[data-column-number]");
            const point = cell ? options.pointAt(cell) : null;
            if (point) begin(event, point, false);
          },
          onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
            const active = drag.current;
            if (active) {
              const cell = cellAt(document.elementFromPoint(event.clientX, event.clientY));
              const point = cell ? options.pointAt(cell) : null;
              if (!point) return;
              const range = rangeOf(active.anchor, point);
              if (
                range.start === active.range.start &&
                range.end === active.range.end &&
                range.side === active.range.side &&
                range.endSide === active.range.endSide
              )
                return;
              active.range = range;
              options.onChange(range);
              return;
            }
            const cell = cellAt(event.target);
            if (!cell || cell.closest("[data-line-annotation]")) return setHovered(null);
            const point = options.pointAt(cell);
            setHovered(point?.row ?? null);
          },
          onPointerLeave: () => setHovered(null),
          onPointerUp: finish,
          onPointerCancel: finish,
        }
      : {},
  };
}
