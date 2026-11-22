import { msg, useGT } from "@t3tools/shared/i18n/react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { m } from "~/i18n/messages";
import { observeResize } from "~/lib/observeResize";
import { columnName, sheetTsv, type CellStyle, type SheetData } from "../decoders/officeEngine";
import { FileSurfaceLoading, FileSurfaceNotice } from "../fileSurfaceChrome";
import type { WorkbookView } from "../officePreviewProtocol";
import { externalUrl } from "./links";
import type { OfficeMethods } from "./office.worker";
import { createWorkerClient } from "./worker-rpc";

type Engine = ReturnType<typeof createWorkerClient<OfficeMethods>>;
type Opened = {
  engine: Engine;
  tabs: readonly { index: number; name: string }[];
  styles: readonly CellStyle[];
};
type Selection = { row: number; column: number; anchorRow: number; anchorColumn: number };

/** Offsets along one axis with O(log k) lookups, where k counts rows or columns of custom size. */
function axis(
  count: number,
  base: number,
  custom: ReadonlyMap<number, number>,
  hidden: ReadonlySet<number>,
) {
  const size = (i: number) => (hidden.has(i) ? 0 : (custom.get(i) ?? base));
  const exceptions = [...new Set([...custom.keys(), ...hidden])]
    .filter((i) => i < count)
    .sort((a, b) => a - b);
  const before: number[] = [];
  let delta = 0;
  for (const i of exceptions) {
    before.push(delta);
    delta += size(i) - base;
  }
  const start = (i: number) => {
    let lo = 0;
    let hi = exceptions.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (exceptions[mid]! < i) lo = mid + 1;
      else hi = mid;
    }
    return i * base + (lo < exceptions.length ? before[lo]! : delta);
  };
  const index = (offset: number) => {
    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (start(mid) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  return { size, start, index, count, total: start(count) };
}

const HEADER = 22;

function wrapText(context: CanvasRenderingContext2D, text: string, width: number) {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/(\s+)/)) {
      const next = line + word;
      if (line.trim() && context.measureText(next).width > width) {
        lines.push(line.trimEnd());
        line = word.trimStart();
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

export default function Spreadsheet(props: {
  bytes: ArrayBuffer;
  view: WorkbookView;
  onDetails: (text: string) => void;
  onError: (cause: unknown) => void;
}) {
  const { onError, bytes: source, onDetails, view } = props;
  const gt = useGT();
  const [opened, setOpened] = useState<Opened>();
  const [sheet, setSheet] = useState<{ index: number; data: SheetData }>();
  const [error, setError] = useState("");
  const picking = useRef<AbortController | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own the workbook worker and its sheet requests for this file, closing it when the file changes or unmounts.
  useEffect(() => {
    const controller = new AbortController();
    const worker = new Worker(new URL("./office.worker.ts", import.meta.url), { type: "module" });
    const engine = createWorkerClient<OfficeMethods>(worker);
    const bytes = source.slice(0);
    void engine
      .call("workbook", { bytes, view }, { transfer: [bytes], signal: controller.signal })
      .then(async ({ tabs, active, styles }) => {
        if (!tabs.length) throw new Error(m(msg("This workbook has no visible sheets.")));
        const data = await engine.call("sheet", { sheet: active }, { signal: controller.signal });
        setOpened({ engine, tabs, styles });
        setSheet({ index: active, data });
        onDetails(
          m(
            msg("{count, plural, one {{count} sheet} other {{count} sheets}}", {
              count: tabs.length,
            }),
          ),
        );
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) onError(cause);
      });
    return () => {
      controller.abort();
      picking.current?.abort();
      engine.close();
    };
  }, [source, view, onDetails, onError]);
  if (!opened || !sheet) return <FileSurfaceLoading />;
  const show = (index: number) => {
    picking.current?.abort();
    if (index === sheet.index) return;
    const controller = new AbortController();
    picking.current = controller;
    void opened.engine
      .call("sheet", { sheet: index }, { signal: controller.signal })
      .then((data) => {
        setError("");
        setSheet({ index, data });
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(m(msg("This sheet could not be opened.")));
      });
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error ? <FileSurfaceNotice>{error}</FileSurfaceNotice> : null}
      <SheetGrid
        key={sheet.index}
        sheet={sheet.data}
        styles={opened.styles}
        gridlines={sheet.data.gridlines && !view.hiddenGridlines.includes(sheet.index)}
        onNavigate={(name) => {
          const tab = opened.tabs.find(
            (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
          );
          if (tab) show(tab.index);
        }}
      />
      <div
        role="tablist"
        aria-label={gt("Sheets")}
        className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-t border-border px-2"
        onKeyDown={(event) => {
          const current = opened.tabs.findIndex((tab) => tab.index === sheet.index);
          const count = opened.tabs.length;
          const next = {
            ArrowRight: (current + 1) % count,
            ArrowLeft: (current + count - 1) % count,
            Home: 0,
            End: count - 1,
          }[event.key];
          if (next === undefined) return;
          event.preventDefault();
          const tab = opened.tabs[next];
          if (tab) show(tab.index);
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
        }}
      >
        {opened.tabs.map((tab) => (
          <button
            key={tab.index}
            type="button"
            role="tab"
            aria-selected={tab.index === sheet.index}
            tabIndex={tab.index === sheet.index ? 0 : -1}
            onClick={() => show(tab.index)}
            className="h-7 shrink-0 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-accent aria-selected:bg-accent aria-selected:text-foreground"
          >
            {tab.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function SheetGrid(props: {
  sheet: SheetData;
  styles: readonly CellStyle[];
  gridlines: boolean;
  onNavigate: (sheet: string) => void;
}) {
  const { sheet, styles, gridlines } = props;
  const gt = useGT();
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [viewport, setViewport] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [selection, setSelection] = useState<Selection>({
    row: 0,
    column: 0,
    anchorRow: 0,
    anchorColumn: 0,
  });
  const dragging = useRef(false);
  const rows = axis(
    Math.max(sheet.maxRow + 50, 100),
    sheet.defaultHeight,
    sheet.rowHeights,
    sheet.hiddenRows,
  );
  const columns = axis(
    Math.max(sheet.maxColumn + 10, 26),
    sheet.defaultWidth,
    sheet.columnWidths,
    sheet.hiddenColumns,
  );
  const covered = new Map<string, SheetData["merges"][number]>();
  for (const merge of sheet.merges)
    if ((merge.r2 - merge.r1 + 1) * (merge.c2 - merge.c1 + 1) <= 10000)
      for (let r = merge.r1; r <= merge.r2; r++)
        for (let c = merge.c1; c <= merge.c2; c++) covered.set(`${r}:${c}`, merge);
  const gutter = Math.max(36, String(rows.count).length * 8 + 14);
  const frozenRows = Math.min(sheet.frozen.rows, rows.count);
  const frozenColumns = Math.min(sheet.frozen.columns, columns.count);
  const frozenHeight = rows.start(frozenRows);
  const frozenWidth = columns.start(frozenColumns);
  // Screen positions: frozen panes stay put, the rest scrolls beneath them.
  const xOf = (c: number) => gutter + columns.start(c) - (c < frozenColumns ? 0 : viewport.left);
  const yOf = (r: number) => HEADER + rows.start(r) - (r < frozenRows ? 0 : viewport.top);
  const cellAt = (x: number, y: number) => {
    const ix = x - gutter;
    const iy = y - HEADER;
    const column =
      ix < frozenWidth ? columns.index(Math.max(0, ix)) : columns.index(ix + viewport.left);
    const row = iy < frozenHeight ? rows.index(Math.max(0, iy)) : rows.index(iy + viewport.top);
    return { row, column };
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Observe the scroll container's size for the painted viewport.
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const update = () =>
      setViewport({
        left: node.scrollLeft,
        top: node.scrollTop,
        width: node.clientWidth,
        height: node.clientHeight,
      });
    update();
    return observeResize(node, update);
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Paint the visible cells into the canvas whenever the viewport, selection or sheet changes.
  useEffect(() => {
    const target = canvas.current;
    if (!target || !viewport.width || !viewport.height) return;
    const ratio = window.devicePixelRatio || 1;
    target.width = Math.round(viewport.width * ratio);
    target.height = Math.round(viewport.height * ratio);
    const context = target.getContext("2d");
    if (!context) return;
    context.scale(ratio, ratio);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, viewport.width, viewport.height);
    context.textBaseline = "middle";
    const rangeOf = (
      frozen: number,
      frozenSize: number,
      scroll: number,
      extent: number,
      header: number,
      along: typeof rows,
    ) => {
      const first = along.index(frozenSize + scroll);
      const last = along.index(frozenSize + scroll + Math.max(0, extent - header - frozenSize));
      return { first: Math.max(frozen, first), last };
    };
    const visibleRows = rangeOf(
      frozenRows,
      frozenHeight,
      viewport.top,
      viewport.height,
      HEADER,
      rows,
    );
    const visibleColumns = rangeOf(
      frozenColumns,
      frozenWidth,
      viewport.left,
      viewport.width,
      gutter,
      columns,
    );
    const rowList = [
      ...Array.from({ length: frozenRows }, (_, i) => i),
      ...Array.from(
        { length: visibleRows.last - visibleRows.first + 1 },
        (_, i) => visibleRows.first + i,
      ),
    ];
    const columnList = [
      ...Array.from({ length: frozenColumns }, (_, i) => i),
      ...Array.from(
        { length: visibleColumns.last - visibleColumns.first + 1 },
        (_, i) => visibleColumns.first + i,
      ),
    ];
    const region = (r: number, c: number) => ({
      x: r < 0 ? 0 : c < frozenColumns ? gutter : gutter + frozenWidth,
      y: r < frozenRows ? HEADER : HEADER + frozenHeight,
    });
    const clipTo = (r: number, c: number, draw: () => void) => {
      const { x, y } = region(r, c);
      context.save();
      context.beginPath();
      context.rect(
        x,
        y,
        c < frozenColumns ? frozenWidth : viewport.width - x,
        r < frozenRows ? frozenHeight : viewport.height - y,
      );
      context.clip();
      draw();
      context.restore();
    };
    const drawCell = (
      r: number,
      c: number,
      x: number,
      y: number,
      w: number,
      h: number,
      overflowRight: number,
    ) => {
      const cell = sheet.rows.get(r)?.get(c);
      const style = cell ? styles[cell.style] : undefined;
      if (style?.fill) {
        context.fillStyle = style.fill;
        context.fillRect(x, y, w, h);
      }
      if (cell?.text) {
        context.font = style?.font ?? "400 14.67px Carlito, Calibri, sans-serif";
        context.fillStyle = cell.error ? "#c00000" : (style?.color ?? "#000");
        const numeric = typeof cell.value === "number" && !style?.align;
        const align =
          style?.align === "general" || !style?.align
            ? numeric
              ? "right"
              : typeof cell.value === "boolean" || cell.error
                ? "center"
                : "left"
            : style.align;
        const size = style?.size ?? 14.67;
        const inset = 4 + (style?.indent ?? 0) * 9;
        // Wrapped cells break on words within the column; others stay one line and may spill right.
        const lines = style?.wrap ? wrapText(context, cell.text, w - 8) : [cell.text];
        const lineHeight = size * 1.2;
        const block = lines.length * lineHeight;
        context.save();
        context.beginPath();
        context.rect(x, y, align === "left" && !style?.wrap ? w + overflowRight : w, h);
        context.clip();
        const top =
          style?.valign === "top"
            ? y + 2
            : style?.valign === "center"
              ? y + (h - block) / 2
              : y + h - block - 2;
        context.textAlign =
          align === "right"
            ? "right"
            : align === "center" || align === "centerContinuous"
              ? "center"
              : "left";
        const tx =
          context.textAlign === "right"
            ? x + w - inset
            : context.textAlign === "center"
              ? x + w / 2
              : x + inset;
        lines.forEach((line, i) => {
          const ty = top + lineHeight * (i + 0.5);
          context.fillText(line, tx, ty);
          if (style?.underline || style?.strike) {
            const width = context.measureText(line).width;
            const left =
              context.textAlign === "right"
                ? tx - width
                : context.textAlign === "center"
                  ? tx - width / 2
                  : tx;
            if (style.underline) context.fillRect(left, ty + size * 0.4, width, 1);
            if (style.strike) context.fillRect(left, ty, width, 1);
          }
        });
        context.restore();
      }
      const borders = style?.borders;
      if (borders) {
        for (const [side, border] of Object.entries(borders)) {
          context.strokeStyle = border.color;
          context.lineWidth = border.double ? 1 : border.width;
          context.setLineDash(border.dash ?? []);
          const offsets = border.double ? [-1, 1] : [0];
          for (const offset of offsets) {
            context.beginPath();
            if (side === "left" || side === "right") {
              const bx = Math.round(side === "left" ? x : x + w) + 0.5 + offset;
              context.moveTo(bx, y);
              context.lineTo(bx, y + h);
            } else {
              const by = Math.round(side === "top" ? y : y + h) + 0.5 + offset;
              context.moveTo(x, by);
              context.lineTo(x + w, by);
            }
            context.stroke();
          }
        }
        context.setLineDash([]);
      }
    };
    for (const r of rowList) {
      const h = rows.size(r);
      if (!h) continue;
      for (const c of columnList) {
        const w = columns.size(c);
        if (!w) continue;
        const merge = covered.get(`${r}:${c}`);
        if (merge && (merge.r1 !== r || merge.c1 !== c)) continue;
        clipTo(r, c, () => {
          const x = xOf(c);
          const y = yOf(r);
          if (gridlines && !merge) {
            context.strokeStyle = "#e1e1e1";
            context.lineWidth = 1;
            context.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, w, h);
          }
          if (merge) {
            const mw = columns.start(merge.c2 + 1) - columns.start(merge.c1);
            const mh = rows.start(merge.r2 + 1) - rows.start(merge.r1);
            context.fillStyle = "#fff";
            context.fillRect(x, y, mw, mh);
            if (gridlines) {
              context.strokeStyle = "#e1e1e1";
              context.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, mw, mh);
            }
            drawCell(r, c, x, y, mw, mh, 0);
            return;
          }
          let overflow = 0;
          for (
            let next = c + 1;
            next < Math.min(columns.count, c + 8) &&
            !sheet.rows.get(r)?.get(next)?.text &&
            !covered.has(`${r}:${next}`);
            next++
          )
            overflow += columns.size(next);
          drawCell(r, c, x, y, w, h, overflow);
        });
      }
    }
    // Selection.
    const r1 = Math.min(selection.row, selection.anchorRow);
    const r2 = Math.max(selection.row, selection.anchorRow);
    const c1 = Math.min(selection.column, selection.anchorColumn);
    const c2 = Math.max(selection.column, selection.anchorColumn);
    context.save();
    context.beginPath();
    context.rect(gutter, HEADER, viewport.width - gutter, viewport.height - HEADER);
    context.clip();
    const sx = xOf(c1);
    const sy = yOf(r1);
    const sw = xOf(c2) + columns.size(c2) - sx;
    const sh = yOf(r2) + rows.size(r2) - sy;
    context.fillStyle = "rgba(33, 115, 70, 0.12)";
    if (r1 !== r2 || c1 !== c2) context.fillRect(sx, sy, sw, sh);
    context.strokeStyle = "#217346";
    context.lineWidth = 2;
    context.strokeRect(sx, sy, sw, sh);
    context.restore();
    // Headers.
    context.font = "400 12px system-ui, sans-serif";
    context.textAlign = "center";
    context.fillStyle = "#f5f5f5";
    context.fillRect(0, 0, viewport.width, HEADER);
    context.fillRect(0, 0, gutter, viewport.height);
    for (const c of columnList) {
      const w = columns.size(c);
      if (!w) continue;
      const x = xOf(c);
      if (x + w < gutter) continue;
      context.fillStyle = c >= c1 && c <= c2 ? "#dcebe2" : "#f5f5f5";
      context.fillRect(Math.max(gutter, x), 0, w, HEADER);
      context.fillStyle = "#555";
      context.fillText(columnName(c), x + w / 2, HEADER / 2);
      context.fillStyle = "#d4d4d4";
      context.fillRect(Math.round(x + w), 0, 1, HEADER);
    }
    for (const r of rowList) {
      const h = rows.size(r);
      if (!h) continue;
      const y = yOf(r);
      if (y + h < HEADER) continue;
      context.fillStyle = r >= r1 && r <= r2 ? "#dcebe2" : "#f5f5f5";
      context.fillRect(0, Math.max(HEADER, y), gutter, h);
      context.fillStyle = "#555";
      context.fillText(String(r + 1), gutter / 2, y + h / 2);
      context.fillStyle = "#d4d4d4";
      context.fillRect(0, Math.round(y + h), gutter, 1);
    }
    context.fillStyle = "#c8c8c8";
    context.fillRect(0, HEADER - 1, viewport.width, 1);
    context.fillRect(gutter - 1, 0, 1, viewport.height);
    if (frozenRows) context.fillRect(0, HEADER + frozenHeight, viewport.width, 1);
    if (frozenColumns) context.fillRect(gutter + frozenWidth, 0, 1, viewport.height);
  });

  const r1 = Math.min(selection.row, selection.anchorRow);
  const r2 = Math.max(selection.row, selection.anchorRow);
  const c1 = Math.min(selection.column, selection.anchorColumn);
  const c2 = Math.max(selection.column, selection.anchorColumn);
  const active = sheet.rows.get(selection.row)?.get(selection.column);
  const address = `${columnName(selection.column)}${selection.row + 1}`;
  const link = sheet.links.get(address);
  const external = link && !link.startsWith("#") ? externalUrl(link) : undefined;
  const reveal = (row: number, column: number) => {
    const node = scroller.current;
    if (!node) return;
    if (row >= frozenRows) {
      const top = rows.start(row) - frozenHeight;
      const bottom =
        rows.start(row + 1) - frozenHeight - (node.clientHeight - HEADER - frozenHeight);
      if (top < node.scrollTop) node.scrollTop = top;
      else if (bottom > node.scrollTop) node.scrollTop = bottom;
    }
    if (column >= frozenColumns) {
      const left = columns.start(column) - frozenWidth;
      const right =
        columns.start(column + 1) - frozenWidth - (node.clientWidth - gutter - frozenWidth);
      if (left < node.scrollLeft) node.scrollLeft = left;
      else if (right > node.scrollLeft) node.scrollLeft = right;
    }
  };
  const step = (row: number, column: number, dr: number, dc: number) => {
    let r = row;
    let c = column;
    do r = Math.min(rows.count - 1, Math.max(0, r + dr));
    while (dr && rows.size(r) === 0 && r > 0 && r < rows.count - 1);
    do c = Math.min(columns.count - 1, Math.max(0, c + dc));
    while (dc && columns.size(c) === 0 && c > 0 && c < columns.count - 1);
    return { row: r, column: c };
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === "c") {
      event.preventDefault();
      void navigator.clipboard?.writeText(sheetTsv(sheet, r1, c1, r2, c2));
      return;
    }
    if (modifier && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelection({
        row: Math.max(0, sheet.maxRow - 1),
        column: Math.max(0, sheet.maxColumn - 1),
        anchorRow: 0,
        anchorColumn: 0,
      });
      return;
    }
    const page = Math.max(1, Math.floor((viewport.height - HEADER) / sheet.defaultHeight) - 1);
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      PageUp: [-page, 0],
      PageDown: [page, 0],
      Enter: [1, 0],
      Tab: [0, event.shiftKey ? -1 : 1],
    };
    let next: { row: number; column: number } | undefined;
    if (event.key === "Home") next = { row: modifier ? 0 : selection.row, column: 0 };
    else if (event.key === "End")
      next = modifier
        ? { row: Math.max(0, sheet.maxRow - 1), column: Math.max(0, sheet.maxColumn - 1) }
        : { row: selection.row, column: Math.max(0, sheet.maxColumn - 1) };
    else if (moves[event.key]) next = step(selection.row, selection.column, ...moves[event.key]!);
    if (!next) return;
    event.preventDefault();
    const extend = event.shiftKey && event.key !== "Tab" && event.key !== "Enter";
    setSelection((current) => ({
      ...next,
      anchorRow: extend ? current.anchorRow : next.row,
      anchorColumn: extend ? current.anchorColumn : next.column,
    }));
    reveal(next.row, next.column);
  };
  const point = (event: PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return cellAt(event.clientX - box.left, event.clientY - box.top);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2 text-xs">
        <span className="w-16 shrink-0 font-mono text-muted-foreground">{address}</span>
        <span className="min-w-0 flex-1 truncate font-mono select-text" aria-live="polite">
          {active?.formula ? `=${active.formula}` : (active?.text ?? "")}
        </span>
        {external ? (
          <a
            href={external}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-primary underline"
          >
            {gt("Open link")}
          </a>
        ) : link?.startsWith("#") ? (
          <button
            type="button"
            className="shrink-0 text-primary underline"
            onClick={() => props.onNavigate(link.slice(1).split("!")[0]!.replace(/^'|'$/g, ""))}
          >
            {gt("Go to {target}", { target: link.slice(1) })}
          </button>
        ) : null}
      </div>
      <div
        ref={scroller}
        role="grid"
        aria-label={sheet.name}
        aria-rowcount={sheet.maxRow}
        aria-colcount={sheet.maxColumn}
        tabIndex={0}
        className="relative min-h-0 flex-1 overflow-auto outline-none"
        onKeyDown={onKeyDown}
        onScroll={(event) => {
          const node = event.currentTarget;
          setViewport({
            left: node.scrollLeft,
            top: node.scrollTop,
            width: node.clientWidth,
            height: node.clientHeight,
          });
        }}
      >
        <div style={{ width: gutter + columns.total, height: HEADER + rows.total }}>
          <canvas
            ref={canvas}
            aria-hidden="true"
            className="sticky top-0 left-0 block"
            style={{ width: viewport.width, height: viewport.height }}
            onPointerDown={(event) => {
              const cell = point(event);
              event.currentTarget.setPointerCapture(event.pointerId);
              dragging.current = true;
              setSelection((current) => ({
                ...cell,
                anchorRow: event.shiftKey ? current.anchorRow : cell.row,
                anchorColumn: event.shiftKey ? current.anchorColumn : cell.column,
              }));
            }}
            onPointerMove={(event) => {
              if (!dragging.current) return;
              const cell = point(event);
              setSelection((current) =>
                current.row === cell.row && current.column === cell.column
                  ? current
                  : { ...current, ...cell },
              );
            }}
            onPointerUp={() => {
              dragging.current = false;
            }}
            onDoubleClick={() => {
              if (external) window.open(external, "_blank", "noopener,noreferrer");
            }}
          />
        </div>
      </div>
    </div>
  );
}
