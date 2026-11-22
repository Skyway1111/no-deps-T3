import { observeResize } from "~/lib/observeResize";

import { Fenwick } from "../virtualList";

/** One block of rows: a file's diff or a file. Specs are compared by identity. */
export interface SectionSpec {
  readonly key: string;
  readonly hasHeader: boolean;
  readonly padTop: number;
  readonly padBottom: number;
  readonly collapsed: boolean;
  readonly rowCount: number;
  /** A row's identity for its measured height; stable across specs. */
  readonly rowKey: (row: number) => string;
  readonly rowIndex: (key: string) => number | undefined;
  readonly estimate: (row: number, metrics: FontMetrics) => number;
  /** Rows of a kind share one height (such as separators), learned from the first one measured. */
  readonly kind?: (row: number) => string | undefined;
}

export interface FontMetrics {
  readonly lineHeight: number;
  readonly charWidth: number;
  /** The view's width when its lines wrap, else 0. */
  readonly width: number;
}

interface Section {
  readonly spec: SectionSpec;
  header: number;
  rows: Fenwick;
}

export type RowWindow = ReadonlyMap<number, readonly [start: number, end: number]>;

/** A section-relative point: `row` -1 is the section's top. */
interface Anchor {
  readonly section: number;
  readonly row: number;
  readonly delta: number;
}

const HEADER_ESTIMATE = 32;
const SIZE_CACHE_LIMIT = 20_000;
const MAX_SETTLES_PER_FRAME = 12;
export const PROBE_LENGTH = 32;
/** Windows snap to this many rows, so scrolling re-renders once per chunk rather than per row. */
const CHUNK = 16;

// Shared by every view: the code font and fixed-height rows measure the same everywhere.
let sharedMetrics: Omit<FontMetrics, "width"> = { lineHeight: 20, charWidth: 7.8 };
const learnedHeights = new Map<string, number>();

/** The content offset that shows `[top, top + height)` aligned in a viewport under a sticky band. */
export function alignOffset(
  top: number,
  height: number,
  viewport: number,
  align: "start" | "center" | "end" | "nearest",
  current: number,
  sticky = 0,
) {
  const visible = viewport - sticky;
  switch (align) {
    case "start":
      return top - sticky;
    case "end":
      return top + height - viewport;
    case "center":
      return top - sticky - Math.max(0, (visible - height) / 2);
    case "nearest":
      if (top - sticky < current) return top - sticky;
      if (top + height > current + viewport) return top + height - viewport;
      return current;
  }
}

/**
 * Windows sections of rows inside a scroller. Measured row heights replace estimates as rows
 * mount, and the row at the top of the viewport stays put while they do.
 */
export class ViewEngine {
  scroller: HTMLElement | null = null;
  root: HTMLElement | null = null;
  overscan = 600;
  metrics: FontMetrics = { ...sharedMetrics, width: 0 };
  /** Lines wrap, so estimates follow the view's width. */
  wrap = false;
  window: RowWindow = new Map();
  private sections: Section[] = [];
  private sectionIndex = new Map<string, number>();
  private heights = new Fenwick([]);
  /** Measured heights by section key, then row key ("" for the header). */
  private sizes = new Map<string, Map<string, number>>();
  private sizeCount = 0;
  private origin = 0;
  /** Until the scroller is measured, the window is the likeliest upper bound. */
  private viewport = typeof window === "undefined" ? 0 : window.innerHeight;
  private scrollTop = 0;
  private pendingScroll: number | null = null;
  private target: (() => number | null) | null = null;
  private settles = 0;
  private stopScroller: (() => void) | null = null;
  private stopRoot: (() => void) | null = null;
  private probe: HTMLElement | null = null;
  rerender: () => void = () => {};
  onScroll: (() => void) | null = null;
  /** Runs before rows are measured, for layout the rows' own CSS cannot express. */
  beforeMeasure: ((root: HTMLElement) => void) | null = null;

  get height() {
    return this.heights.total;
  }

  /** The scroller's offset from the top of the first section. */
  get contentScrollTop() {
    return this.scrollTop - this.origin;
  }

  get viewportHeight() {
    return this.viewport;
  }

  /** The row at the top of the viewport in a section, or 0 above it. */
  firstVisibleRow(section: number) {
    const anchor = this.anchorAt(this.scrollTop);
    return anchor?.section === section && anchor.row > 0 ? anchor.row : 0;
  }

  setSections(specs: ReadonlyArray<SectionSpec>, rebuild = false) {
    let changed = rebuild || specs.length !== this.sections.length;
    const next = specs.map((spec, index) => {
      const previous = this.sections[index];
      if (!rebuild && previous?.spec === spec) return previous;
      changed = true;
      return this.buildSection(spec);
    });
    if (!changed) return;
    this.sections = next;
    this.sectionIndex = new Map(next.map((section, index) => [section.spec.key, index]));
    this.heights = new Fenwick(next.map((section) => this.sectionHeight(section)));
    this.computeWindow();
  }

  private buildSection(spec: SectionSpec): Section {
    const heights = new Float64Array(spec.rowCount);
    for (let row = 0; row < spec.rowCount; row++) {
      const kind = spec.kind?.(row);
      heights[row] = (kind && learnedHeights.get(kind)) || spec.estimate(row, this.metrics);
    }
    const measured = this.sizes.get(spec.key);
    let header = learnedHeights.get("header") ?? HEADER_ESTIMATE;
    for (const [key, height] of measured ?? []) {
      if (key === "") header = height;
      const row = key === "" ? undefined : spec.rowIndex(key);
      if (row !== undefined && row < spec.rowCount) heights[row] = height;
    }
    return { spec, header: spec.hasHeader ? header : 0, rows: new Fenwick(heights) };
  }

  private record(section: string, key: string, height: number) {
    let measured = this.sizes.get(section);
    if (!measured) this.sizes.set(section, (measured = new Map()));
    if (!measured.has(key)) this.sizeCount++;
    measured.set(key, height);
    if (this.sizeCount <= SIZE_CACHE_LIMIT) return;
    // Sections not on screen lose their sizes first.
    for (const [other, sizes] of this.sizes) {
      if (other === section) continue;
      this.sizeCount -= sizes.size;
      this.sizes.delete(other);
      if (this.sizeCount <= SIZE_CACHE_LIMIT * 0.75) break;
    }
  }

  private isMeasured(section: string, key: string) {
    return this.sizes.get(section)?.has(key) === true;
  }

  private sectionHeight({ spec, header, rows }: Section) {
    return header + (spec.collapsed ? 0 : spec.padTop + rows.total + spec.padBottom);
  }

  sectionTop(section: number) {
    return this.heights.prefix(section);
  }

  /** A row's top within the section. */
  rowTop(section: number, row: number) {
    const state = this.sections[section]!;
    return state.header + state.spec.padTop + state.rows.prefix(row);
  }

  rowHeight(section: number, row: number) {
    return this.sections[section]?.rows.get(row) ?? 0;
  }

  indexOf(key: string) {
    return this.sectionIndex.get(key);
  }

  /** Spacer heights around a section's mounted rows. */
  gaps(section: number, start: number, end: number) {
    const { spec, rows } = this.sections[section]!;
    return {
      before: spec.padTop + rows.prefix(start),
      after: rows.total - rows.prefix(end) + spec.padBottom,
    };
  }

  /** Re-reads the font probe and width; new metrics drop every measurement. */
  private measureMetrics() {
    const probe = this.probe;
    const root = this.root;
    if (!probe || !root) return false;
    const box = probe.getBoundingClientRect();
    const metrics: FontMetrics = {
      lineHeight: box.height || 20,
      charWidth: box.width / PROBE_LENGTH || 7.8,
      width: this.wrap ? root.clientWidth : 0,
    };
    const current = this.metrics;
    if (
      Math.abs(metrics.lineHeight - current.lineHeight) < 0.01 &&
      Math.abs(metrics.charWidth - current.charWidth) < 0.001 &&
      Math.abs(metrics.width - current.width) < 1
    )
      return false;
    this.metrics = metrics;
    sharedMetrics = { lineHeight: metrics.lineHeight, charWidth: metrics.charWidth };
    this.sizes.clear();
    this.sizeCount = 0;
    this.setSections(
      this.sections.map((section) => section.spec),
      true,
    );
    return true;
  }

  attach(scroller: HTMLElement | null, root: HTMLElement | null, probe: HTMLElement | null) {
    if (root !== this.root || probe !== this.probe) {
      this.stopRoot?.();
      this.stopRoot = null;
      this.root = root;
      this.probe = probe;
      if (root && probe) {
        this.measureMetrics();
        const stopRoot = observeResize([root, probe], () => {
          if (this.measureMetrics()) this.rerender();
          else this.commit();
        });
        this.stopRoot = stopRoot;
      }
    }
    if (scroller === this.scroller) return;
    this.stopScroller?.();
    this.stopScroller = null;
    this.scroller = scroller;
    if (!scroller) return;
    const onScroll = () => {
      this.scrollTop = scroller.scrollTop;
      if (this.computeWindow()) this.rerender();
      this.onScroll?.();
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const stopResize = observeResize(scroller, () => {
      this.viewport = scroller.clientHeight;
      if (this.computeWindow()) this.rerender();
    });
    this.viewport = scroller.clientHeight;
    this.scrollTop = scroller.scrollTop;
    this.stopScroller = () => {
      scroller.removeEventListener("scroll", onScroll);
      stopResize();
    };
  }

  dispose() {
    this.attach(null, null, null);
  }

  computeWindow(): boolean {
    const next = new Map<number, readonly [number, number]>();
    const top = this.scrollTop - this.origin - this.overscan;
    const bottom = this.scrollTop - this.origin + this.viewport + this.overscan;
    if (this.sections.length > 0 && bottom > 0) {
      for (
        let index = this.heights.indexAt(Math.max(0, top));
        index < this.sections.length;
        index++
      ) {
        const sectionTop = this.heights.prefix(index);
        if (sectionTop > bottom) break;
        const { spec, rows, header } = this.sections[index]!;
        if (spec.collapsed || rows.length === 0) {
          next.set(index, [0, 0]);
          continue;
        }
        const rowsTop = sectionTop + header + spec.padTop;
        const start = rows.indexAt(Math.max(0, top - rowsTop));
        const end = rows.indexAt(Math.max(0, bottom - rowsTop)) + 1;
        next.set(index, [
          Math.floor(start / CHUNK) * CHUNK,
          Math.min(rows.length, Math.ceil(end / CHUNK) * CHUNK),
        ]);
      }
    }
    const previous = this.window;
    if (
      previous.size === next.size &&
      [...next].every(([index, [start, end]]) => {
        const old = previous.get(index);
        return old?.[0] === start && old[1] === end;
      })
    )
      return false;
    this.window = next;
    return true;
  }

  private anchorAt(scrollTop: number): Anchor | null {
    const offset = scrollTop - this.origin;
    if (offset <= 0 || this.sections.length === 0) return null;
    const section = this.heights.indexAt(offset);
    const sectionTop = this.heights.prefix(section);
    const { spec, rows, header } = this.sections[section]!;
    const rowsTop = sectionTop + header + spec.padTop;
    if (spec.collapsed || rows.length === 0 || offset < rowsTop)
      return { section, row: -1, delta: offset - sectionTop };
    const row = rows.indexAt(offset - rowsTop);
    return { section, row, delta: offset - rowsTop - rows.prefix(row) };
  }

  private anchorTop({ section, row }: Anchor) {
    return this.heights.prefix(section) + (row < 0 ? 0 : this.rowTop(section, row));
  }

  /** Scrolls to a content offset now and keeps re-resolving it until rows there have measured. */
  scrollToContent(resolve: () => number | null) {
    this.target = resolve;
    this.applyTarget();
  }

  private applyTarget() {
    const resolve = this.target;
    const scroller = this.scroller;
    if (!resolve || !scroller) return;
    const offset = resolve();
    if (offset === null) return;
    const max = Math.max(0, this.origin + this.height - scroller.clientHeight);
    const top = Math.max(0, Math.min(this.origin + offset, max));
    if (Math.abs(scroller.scrollTop - top) >= 1) scroller.scrollTop = top;
    this.scrollTop = scroller.scrollTop;
    if (this.computeWindow()) this.rerender();
  }

  cancelTarget() {
    this.target = null;
  }

  /** After each commit: measure mounted rows, keep the viewport's top row in place, window again. */
  commit() {
    const scroller = this.scroller;
    const root = this.root;
    if (!scroller || !root) return;
    if (this.pendingScroll !== null) {
      scroller.scrollTop = this.pendingScroll;
      this.pendingScroll = null;
    }
    this.beforeMeasure?.(root);
    const scrollerTop = scroller.getBoundingClientRect().top;
    this.origin = root.getBoundingClientRect().top - scrollerTop + scroller.scrollTop;
    this.scrollTop = scroller.scrollTop;
    this.viewport = scroller.clientHeight;
    const changes: Array<readonly [section: number, row: number, height: number]> = [];
    const elements = root.hasAttribute("data-section")
      ? [root]
      : root.querySelectorAll<HTMLElement>(":scope > [data-section]");
    for (const element of elements) {
      const section = Number(element.dataset.section);
      const state = this.sections[section];
      if (!state) continue;
      const header = state.spec.hasHeader
        ? element.querySelector<HTMLElement>(":scope > [data-diffs-header]")
        : null;
      if (header) {
        const height = header.getBoundingClientRect().height;
        if (Math.abs(height - state.header) > 0.25) changes.push([section, -1, height]);
      }
      const measured = new Map<number, number>();
      for (const cell of element.querySelectorAll<HTMLElement>("[data-content] > [data-row]")) {
        const row = Number(cell.dataset.row);
        measured.set(row, Math.max(measured.get(row) ?? 0, cell.getBoundingClientRect().height));
      }
      for (const [row, height] of measured) {
        if (
          Math.abs(height - state.rows.get(row)) > 0.25 ||
          !this.isMeasured(state.spec.key, state.spec.rowKey(row))
        )
          changes.push([section, row, height]);
      }
    }
    const resized = changes.some(
      ([section, row, height]) =>
        Math.abs(
          height -
            (row < 0 ? this.sections[section]!.header : this.sections[section]!.rows.get(row)),
        ) > 0.25,
    );
    if (resized && this.settles === 0) requestAnimationFrame(() => (this.settles = 0));
    if (changes.length > 0 && (!resized || this.settles++ < MAX_SETTLES_PER_FRAME)) {
      const anchor = this.target ? null : this.anchorAt(scroller.scrollTop);
      const before = anchor ? this.anchorTop(anchor) : 0;
      for (const [section, row, height] of changes) {
        const state = this.sections[section]!;
        this.record(state.spec.key, row < 0 ? "" : state.spec.rowKey(row), height);
        const kind = row < 0 ? "header" : state.spec.kind?.(row);
        if (kind) learnedHeights.set(kind, height);
        if (row < 0) state.header = height;
        else state.rows.set(row, height);
        this.heights.set(section, this.sectionHeight(state));
      }
      if (resized) {
        if (anchor) {
          const shift = this.anchorTop(anchor) - before;
          if (Math.abs(shift) >= 0.5) this.pendingScroll = scroller.scrollTop + shift;
        }
        this.computeWindow();
        this.rerender();
        return;
      }
    }
    if (this.target) {
      this.applyTarget();
      // A target holds until the rows around it stop changing size.
      if (!resized) this.target = null;
      return;
    }
    if (this.computeWindow()) this.rerender();
  }
}
