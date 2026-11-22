import { flushSync } from "react-dom";
import { observeResize } from "~/lib/observeResize";
import {
  isValidElement,
  memo,
  useImperativeHandle,
  useLayoutEffect,
  useReducer,
  useState,
  type ComponentType,
  type CSSProperties,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";

/** Prefix sums over item sizes: O(log n) update, append, offset → index lookup, and prefix query. */
export class Fenwick {
  private tree: Float64Array;
  private values: Float64Array;
  private n: number;
  private top: number;

  constructor(values: ArrayLike<number>) {
    const n = values.length;
    this.n = n;
    this.values = new Float64Array(Math.max(16, n));
    this.values.set(values);
    this.tree = new Float64Array(this.values.length + 1);
    for (let i = 1; i <= n; i++) {
      this.tree[i]! += this.values[i - 1]!;
      const parent = i + (i & -i);
      if (parent <= n) this.tree[parent]! += this.tree[i]!;
    }
    this.top = n === 0 ? 0 : 2 ** Math.floor(Math.log2(n));
  }
  get length() {
    return this.n;
  }
  get(index: number) {
    return index < this.n ? this.values[index]! : 0;
  }
  set(index: number, value: number) {
    const delta = value - this.values[index]!;
    if (delta === 0) return;
    this.values[index] = value;
    for (let i = index + 1; i <= this.n; i += i & -i) this.tree[i]! += delta;
  }
  /** Appends in O(log n); capacity grows geometrically. */
  push(value: number) {
    if (this.n === this.values.length) {
      const values = new Float64Array(this.values.length * 2);
      values.set(this.values);
      const tree = new Float64Array(values.length + 1);
      tree.set(this.tree);
      this.values = values;
      this.tree = tree;
    }
    const i = ++this.n;
    this.values[i - 1] = value;
    // A node covers (i - lowbit(i), i]: the new value plus the sums of its covered children.
    this.tree[i] = value + this.prefix(i - 1) - this.prefix(i - (i & -i));
    if (i >= this.top * 2) this.top = this.top === 0 ? 1 : this.top * 2;
  }
  /** Sum of sizes before `index`. */
  prefix(index: number) {
    let sum = 0;
    for (let i = Math.min(index, this.n); i > 0; i -= i & -i) sum += this.tree[i]!;
    return sum;
  }
  get total() {
    return this.prefix(this.n);
  }
  /** Index of the item covering `offset` (clamped to the list). */
  indexAt(offset: number) {
    let pos = 0;
    let rest = offset;
    for (let step = this.top; step > 0; step >>= 1) {
      const next = pos + step;
      if (next <= this.n && this.tree[next]! <= rest) {
        pos = next;
        rest -= this.tree[next]!;
      }
    }
    return Math.max(0, Math.min(pos, this.n - 1));
  }
}

/** Measured sizes outlive their list so a revisited dataset restores without jumps; this bounds them. */
const SIZE_CACHE_LIMIT = 12_000;

export interface MaintainScrollAtEndOptions {
  animated?: boolean;
  on?: {
    dataChange?: boolean;
    dataAppend?: boolean;
    itemLayout?: boolean;
    layout?: boolean;
    footerLayout?: boolean;
  };
}
type Trigger = keyof NonNullable<MaintainScrollAtEndOptions["on"]>;
export interface AnchoredEndSpaceConfig {
  anchorIndex: number;
  anchorOffset?: number;
  anchorMaxSize?: number;
  onSizeChanged?: (size: number) => void;
  onReady?: (info: {
    anchorIndex: number | undefined;
    anchorKey: string | undefined;
    size: number;
  }) => void;
}
type Listenable =
  | "totalSize"
  | "headerSize"
  | "footerSize"
  | "isAtStart"
  | "isAtEnd"
  | "isFollowingEnd";

export interface VirtualListState {
  // The ref erases the item type, as consumers read rows they rendered.
  data: readonly any[];
  scroll: number;
  scrollLength: number;
  contentLength: number;
  isAtStart: boolean;
  isAtEnd: boolean;
  isFollowingEnd: boolean;
  /** Header and padding above the first item; item positions start here. */
  startOffset: number;
  start: number;
  end: number;
  startBuffered: number;
  endBuffered: number;
  sizes: Map<string, number>;
  indexByKey: (key: string) => number | undefined;
  positionAtIndex: (index: number) => number;
  sizeAtIndex: (index: number) => number;
  elementAtIndex: (index: number) => HTMLElement | undefined;
  listen: (type: Listenable, callback: (value: number | boolean) => void) => () => void;
  listenToPosition: (key: string, callback: (position: number) => void) => () => void;
}
interface ScrollToIndexParams {
  index: number;
  animated?: boolean;
  viewOffset?: number;
  viewPosition?: number;
}
export interface VirtualListRef {
  getState(): VirtualListState;
  getScrollableNode(): HTMLElement | null;
  cancelScroll(): void;
  /** Keeps `key`'s row fixed through later size changes until the reader scrolls; ends end-follow. */
  anchorVisibleContent(options: { key: string }): { key: string; offset: number } | undefined;
  scrollToIndex(params: ScrollToIndexParams): Promise<void>;
  scrollIndexIntoView(params: {
    index: number;
    animated?: boolean;
    viewportMargin?: { start?: number; end?: number };
  }): Promise<void>;
  scrollToOffset(params: { offset: number; animated?: boolean }): Promise<void>;
  scrollToEnd(params?: { animated?: boolean; viewOffset?: number }): Promise<void>;
}

type Slot = ReactNode | ComponentType;
export interface VirtualListProps<T> extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "onScroll" | "onLayout" | "onLoad" | "children"
> {
  ref?: Ref<VirtualListRef>;
  data: readonly T[];
  renderItem: (info: {
    item: T;
    index: number;
    extraData: unknown;
    type: string | undefined;
  }) => ReactNode;
  keyExtractor?: (item: T, index: number) => string;
  getItemType?: (item: T, index: number) => string | undefined;
  extraData?: unknown;
  dataVersion?: string | number;
  /** Identity of the dataset; changing it restarts initial placement. */
  dataKey?: string | number;
  estimatedItemSize?: number;
  drawDistance?: number;
  /** LegendList compatibility; rows are never recycled. */
  recycleItems?: boolean;
  initialScrollAtEnd?: boolean;
  initialScrollOffset?: number;
  maintainScrollAtEnd?: boolean | MaintainScrollAtEndOptions;
  maintainScrollAtEndThreshold?: number;
  maintainVisibleContentPosition?: boolean | { data?: boolean; size?: boolean };
  anchoredEndSpace?: AnchoredEndSpaceConfig;
  contentInsetEndAdjustment?: number;
  alwaysRender?: { top?: number; bottom?: number; indices?: number[]; keys?: string[] };
  ListHeaderComponent?: Slot;
  ListFooterComponent?: Slot;
  ItemSeparatorComponent?: ComponentType<{ leadingItem: T }>;
  contentContainerClassName?: string;
  contentContainerStyle?: CSSProperties;
  style?: CSSProperties;
  onScroll?: (event: {
    nativeEvent: {
      contentOffset: { x: number; y: number };
      contentSize: { width: number; height: number };
      layoutMeasurement: { width: number; height: number };
    };
  }) => void;
  onLayout?: (event: {
    nativeEvent: { layout: { x: number; y: number; width: number; height: number } };
  }) => void;
  onLoad?: (info: { elapsedTimeInMs: number }) => void;
  onReady?: () => void;
  onItemSizeChanged?: (info: {
    size: number;
    previous: number;
    index: number;
    itemKey: string;
    itemData: T;
  }) => void;
  onMetricsChange?: (metrics: { headerSize: number; footerSize: number }) => void;
  onEndReached?: (info: { distanceFromEnd: number }) => void;
  onEndReachedThreshold?: number | null;
}

const USER_INPUT_WINDOW_MS = 250;
function SlotView({ slot }: { slot: Slot }) {
  if (
    isValidElement(slot) ||
    (typeof slot !== "function" &&
      (typeof slot !== "object" || slot === null || !("$$typeof" in slot)))
  ) {
    return slot as ReactNode;
  }
  const Component = slot as ComponentType;
  return <Component />;
}

/** Scroll engine; React renders `window`, the engine owns measurement, anchoring and end-follow. */
class Engine<T> {
  props!: VirtualListProps<T>;
  scroller: HTMLDivElement | null = null;
  readonly elements = new Map<string, HTMLElement>();
  /** Measured sizes by key, oldest first; current keys are refreshed when a dataset (re)opens. */
  readonly sizes = new Map<string, number>();
  /** Item types of the current list, by index. */
  private types: Array<string | undefined> = [];
  /** Measured [sum, count] per type over the current list, for estimating unmeasured items. */
  private typeTotals = new Map<string | undefined, [number, number]>();
  keys: string[] = [];
  private indexByKey = new Map<string, number>();
  fenwick = new Fenwick([]);
  private data: readonly T[] | null = null;
  private dataKey: unknown;
  private anchorHeld = false;
  private scrollGeneration = 0;
  private dataVersion: unknown;
  window = { start: 0, end: -1, extras: [] as number[] };
  scroll = 0;
  scrollLength = 0;
  headerSize = 0;
  footerSize = 0;
  paddingStart = 0;
  paddingEnd = 0;
  endSpace = 0;
  following = false;
  private placingEnd = false;
  private settles = 0;
  private loaded = false;
  private readonly mountedAt = performance.now();
  private userInputAt = -Infinity;
  private expectedScroll: number | null = null;
  private animatingTo: number | null = null;
  private rearmTimer: ReturnType<typeof setTimeout> | undefined;
  private anchor: { key: string; delta: number } | null = null;
  private dataChanged = false;
  private appendOnly = false;
  private endReached = false;
  private anchorReadyKey: string | undefined;
  private readonly stops = new Map<Element, () => void>();
  private readonly listeners = new Map<Listenable, Set<(value: number | boolean) => void>>();
  private readonly lastNotified = new Map<Listenable, number | boolean>();
  private readonly positionListeners = new Map<string, Set<(position: number) => void>>();
  private readonly lastPositions = new Map<string, number>();
  rerender: () => void = () => {};

  get startOffset() {
    return this.paddingStart + this.headerSize;
  }
  get contentLength() {
    return (
      this.startOffset +
      this.fenwick.total +
      this.footerSize +
      this.endSpace +
      this.paddingEnd +
      (this.props.contentInsetEndAdjustment ?? 0)
    );
  }
  get maxScroll() {
    return Math.max(0, this.contentLength - this.scrollLength);
  }
  get distanceFromEnd() {
    return Math.max(0, this.contentLength - this.scroll - this.scrollLength);
  }
  position(index: number) {
    return this.fenwick.prefix(index);
  }
  typeAt(index: number) {
    return this.types[index];
  }

  /**
   * Re-indexes when the dataset changes. Rows changed in place (streaming) cost O(n) reference
   * checks and no rebuild, appended rows O(k log n); anything else rebuilds in O(n).
   */
  sync(props: VirtualListProps<T>, rerender: () => void) {
    this.props = props;
    this.rerender = rerender;
    if (props.dataKey !== this.dataKey) {
      if (this.dataKey !== undefined) {
        this.loaded = false;
        this.anchor = null;
        this.following = false;
        this.data = null;
      }
      this.dataKey = props.dataKey;
    }
    if (props.data === this.data && props.dataVersion === this.dataVersion) return;
    const previousData = this.data;
    const previousKeys = this.keys;
    const data = props.data;
    this.data = data;
    this.dataVersion = props.dataVersion;
    const keyOf = props.keyExtractor ?? ((_: T, i: number) => String(i));
    const shared = Math.min(data.length, previousKeys.length);
    let same = 0;
    while (
      same < shared &&
      (previousData?.[same] === data[same] || keyOf(data[same]!, same) === previousKeys[same])
    ) {
      same++;
    }
    if (same === previousKeys.length && previousKeys.length > 0) {
      for (let i = 0; i < same; i++) {
        if (previousData?.[i] !== data[i]) this.retype(i, props.getItemType?.(data[i]!, i));
      }
      for (let i = same; i < data.length; i++) this.append(keyOf(data[i]!, i), data[i]!, i);
      this.appendOnly = data.length > same;
    } else {
      this.rebuild(data, keyOf, previousKeys);
      this.appendOnly = false;
    }
    this.dataChanged = this.loaded;
    this.computeWindow();
  }

  private rebuild(data: readonly T[], keyOf: (item: T, i: number) => string, previous: string[]) {
    const previousIndex = this.indexByKey;
    this.keys = data.map((item, i) => keyOf(item, i));
    this.indexByKey = new Map(this.keys.map((key, i) => [key, i]));
    // A dataset sharing no rows with the last one is a fresh start, as for a new dataKey.
    const fresh = previous.length === 0 || !this.keys.some((key) => previousIndex.has(key));
    if (fresh && previous.length > 0 && this.keys.length > 0) {
      this.loaded = false;
      this.anchor = null;
      this.anchorHeld = false;
      this.following = false;
    }
    this.typeTotals = new Map();
    this.types = data.map((item, i) => {
      const type = this.props.getItemType?.(item, i);
      const key = this.keys[i]!;
      const size = this.sizes.get(key);
      if (size !== undefined) {
        this.addTotal(type, size, 1);
        // A reopened dataset's sizes become the most recent, so they outlive other lists'.
        if (fresh) {
          this.sizes.delete(key);
          this.sizes.set(key, size);
        }
      }
      return type;
    });
    this.fenwick = new Fenwick(
      this.keys.map((key, i) => this.sizes.get(key) ?? this.estimate(this.types[i])),
    );
  }

  private append(key: string, item: T, index: number) {
    const type = this.props.getItemType?.(item, index);
    const size = this.sizes.get(key);
    if (size !== undefined) this.addTotal(type, size, 1);
    this.keys.push(key);
    this.indexByKey.set(key, index);
    this.types.push(type);
    this.fenwick.push(size ?? this.estimate(type));
  }

  private retype(index: number, type: string | undefined) {
    const previous = this.types[index];
    if (previous === type) return;
    this.types[index] = type;
    const size = this.sizes.get(this.keys[index]!);
    if (size === undefined) return;
    this.addTotal(previous, -size, -1);
    this.addTotal(type, size, 1);
  }

  private addTotal(type: string | undefined, size: number, count: number) {
    const total = this.typeTotals.get(type);
    if (total) {
      total[0] += size;
      total[1] += count;
    } else this.typeTotals.set(type, [size, count]);
  }

  private estimate(type: string | undefined) {
    const total = this.typeTotals.get(type);
    return total && total[1] > 0 ? total[0] / total[1] : (this.props.estimatedItemSize ?? 100);
  }

  computeWindow() {
    const { drawDistance = 250, alwaysRender } = this.props;
    const n = this.keys.length;
    const viewport =
      this.scrollLength || (typeof window === "undefined" ? 1000 : window.innerHeight);
    // Render the end region directly when the next pass will pin there anyway.
    const pinned =
      (!this.loaded && this.props.initialScrollAtEnd) ||
      this.placingEnd ||
      (this.dataChanged &&
        this.following &&
        this.maintainsEnd(this.appendOnly ? "dataAppend" : "dataChange"));
    const scroll = pinned ? Math.max(0, this.contentLength - viewport) : this.scroll;
    const top = scroll - this.startOffset - drawDistance;
    const bottom = scroll - this.startOffset + viewport + drawDistance;
    const start = n === 0 ? 0 : this.fenwick.indexAt(Math.max(0, top));
    const end = n === 0 ? -1 : this.fenwick.indexAt(Math.max(0, bottom));
    const extras = new Set<number>();
    if (alwaysRender) {
      for (let i = 0; i < Math.min(alwaysRender.top ?? 0, n); i++) extras.add(i);
      for (let i = Math.max(0, n - (alwaysRender.bottom ?? 0)); i < n; i++) extras.add(i);
      for (const i of alwaysRender.indices ?? []) if (i >= 0 && i < n) extras.add(i);
      for (const key of alwaysRender.keys ?? []) {
        const i = this.indexByKey.get(key);
        if (i !== undefined) extras.add(i);
      }
    }
    const extraList = [...extras].filter((i) => i < start || i > end).sort((a, b) => a - b);
    const w = this.window;
    if (
      w.start === start &&
      w.end === end &&
      w.extras.length === extraList.length &&
      w.extras.every((i, k) => i === extraList[k])
    )
      return false;
    this.window = { start, end, extras: extraList };
    return true;
  }

  observe(key: string, el: HTMLElement | null) {
    const previous = this.elements.get(key);
    if (previous === el) return;
    if (previous) this.unwatch(previous);
    if (el) {
      this.elements.set(key, el);
      this.watch(el);
    } else {
      this.elements.delete(key);
    }
  }
  /** Scroller and content-container padding around the items. */
  private measurePadding() {
    const scroller = this.scroller!;
    const content = scroller.firstElementChild;
    const outer = getComputedStyle(scroller);
    const inner = content ? getComputedStyle(content) : null;
    this.scrollLength = scroller.clientHeight;
    this.paddingStart =
      (parseFloat(outer.paddingTop) || 0) + (parseFloat(inner?.paddingTop ?? "") || 0);
    this.paddingEnd =
      (parseFloat(outer.paddingBottom) || 0) + (parseFloat(inner?.paddingBottom ?? "") || 0);
  }
  observeFixed(el: Element | null) {
    if (el) this.watch(el);
  }
  private watch(el: Element) {
    if (!this.stops.has(el))
      this.stops.set(
        el,
        observeResize(el, (entries) => this.onResize(entries)),
      );
  }
  private unwatch(el: Element) {
    this.stops.get(el)?.();
    this.stops.delete(el);
  }
  private measureFixed() {
    const scroller = this.scroller!;
    const content = scroller.firstElementChild as HTMLElement | null;
    this.measurePadding();
    const height = (role: string) =>
      content
        ?.querySelector<HTMLElement>(`:scope > [data-vl-role="${role}"]`)
        ?.getBoundingClientRect().height ?? 0;
    this.headerSize = height("header");
    this.footerSize = height("footer");
  }

  private setItemSize(key: string, size: number) {
    const index = this.indexByKey.get(key);
    if (index === undefined) return false;
    const previous = this.fenwick.get(index);
    const measured = this.sizes.get(key);
    if (Math.abs(previous - size) < 0.01 && measured !== undefined) return false;
    if (measured === undefined) this.addTotal(this.types[index], size, 1);
    else {
      this.addTotal(this.types[index], size - measured, 0);
      this.sizes.delete(key);
    }
    this.sizes.set(key, size);
    if (this.sizes.size - this.indexByKey.size > SIZE_CACHE_LIMIT) this.evictSizes();
    this.fenwick.set(index, size);
    this.props.onItemSizeChanged?.({
      size,
      previous,
      index,
      itemKey: key,
      itemData: this.props.data[index]!,
    });
    return true;
  }

  /** Drops the oldest sizes outside the current list, down to three quarters of the limit. */
  private evictSizes() {
    let excess = this.sizes.size - this.indexByKey.size - (SIZE_CACHE_LIMIT * 3) / 4;
    for (const key of this.sizes.keys()) {
      if (excess <= 0) break;
      if (this.indexByKey.has(key)) continue;
      this.sizes.delete(key);
      excess--;
    }
  }

  /** Measures items React just mounted, so the commit's anchoring uses real sizes. */
  measureMounted() {
    let changed = false;
    for (const [key, el] of this.elements) {
      if (!this.sizes.has(key))
        changed = this.setItemSize(key, el.getBoundingClientRect().height) || changed;
    }
    return changed;
  }

  private onResize(entries: readonly ResizeObserverEntry[]) {
    const scroller = this.scroller;
    if (!scroller) return;
    let items = false;
    let layout = false;
    let footer = false;
    let metrics = false;
    for (const entry of entries) {
      const el = entry.target as HTMLElement;
      const height = entry.borderBoxSize?.[0]?.blockSize ?? el.getBoundingClientRect().height;
      const role = el.dataset.vlRole;
      if (el === scroller) {
        layout = Math.abs(this.scrollLength - scroller.clientHeight) > 0.5 || layout;
        this.measurePadding();
        this.props.onLayout?.({
          nativeEvent: {
            layout: { x: 0, y: 0, width: scroller.clientWidth, height: scroller.clientHeight },
          },
        });
      } else if (role === "header") {
        metrics = metrics || this.headerSize !== height;
        this.headerSize = height;
      } else if (role === "footer") {
        footer = footer || this.footerSize !== height;
        metrics = metrics || footer;
        this.footerSize = height;
      } else if (el.dataset.vlKey !== undefined) {
        items = this.setItemSize(el.dataset.vlKey, height) || items;
      }
    }
    if (metrics)
      this.props.onMetricsChange?.({ headerSize: this.headerSize, footerSize: this.footerSize });
    if (!items && !layout && !footer && !metrics) return;
    this.settle(items ? "itemLayout" : footer ? "footerLayout" : "layout");
  }

  private captureAnchor() {
    if (this.anchorHeld) return;
    const offset = this.scroll - this.startOffset;
    if (this.keys.length === 0 || offset <= 0) {
      this.anchor = null;
      return;
    }
    const index = this.fenwick.indexAt(offset);
    this.anchor = { key: this.keys[index]!, delta: offset - this.position(index) };
  }

  private writeScroll(top: number, animated = false) {
    const scroller = this.scroller;
    if (!scroller) return;
    const target = Math.max(0, Math.min(top, this.maxScroll));
    if (Math.abs(target - scroller.scrollTop) < 0.5) return;
    if (animated) {
      this.animatingTo = target;
      scroller.scrollTo({ top: target, behavior: "smooth" });
    } else {
      this.animatingTo = null;
      this.expectedScroll = target;
      scroller.scrollTop = target;
      this.scroll = scroller.scrollTop;
    }
  }

  private maintainsEnd(trigger: Trigger) {
    const option = this.props.maintainScrollAtEnd;
    if (!option) return false;
    if (option === true || !option.on) return true;
    return (
      option.on[trigger] === true || (trigger === "dataAppend" && option.on.dataChange === true)
    );
  }

  /** After sizes or data change: follow the end, or keep the anchored row where it was. */
  settle(trigger: Trigger | "data" | "commit") {
    this.updateEndSpace();
    const mvcp = this.props.maintainVisibleContentPosition;
    const { data = false, size = true } =
      typeof mvcp === "object" ? mvcp : mvcp === undefined ? {} : { data: mvcp, size: mvcp };
    const stabilize = trigger === "data" ? data : size;
    const endTrigger: Trigger =
      trigger === "data"
        ? this.appendOnly
          ? "dataAppend"
          : "dataChange"
        : trigger === "commit"
          ? "itemLayout"
          : trigger;
    if (this.placingEnd) {
      this.writeScroll(this.maxScroll);
    } else if (this.following && this.maintainsEnd(endTrigger)) {
      const option = this.props.maintainScrollAtEnd;
      this.writeScroll(this.maxScroll, typeof option === "object" && option.animated === true);
    } else if (stabilize && this.anchor) {
      const index = this.indexByKey.get(this.anchor.key);
      if (index !== undefined)
        this.writeScroll(this.startOffset + this.position(index) + this.anchor.delta);
    }
    if (this.computeWindow()) this.rerender();
    // Initial end placement holds until a frame passes with nothing left to measure.
    if (this.placingEnd && this.loaded) {
      const settles = ++this.settles;
      requestAnimationFrame(() => {
        if (settles === this.settles) this.placingEnd = false;
      });
    }
    this.notify();
  }

  onScroll() {
    const scroller = this.scroller;
    if (!scroller) return;
    const previous = this.scroll;
    this.scroll = scroller.scrollTop;
    const user = performance.now() - this.userInputAt < USER_INPUT_WINDOW_MS;
    const ours =
      !user &&
      ((this.expectedScroll !== null && Math.abs(this.scroll - this.expectedScroll) < 1) ||
        this.animatingTo !== null);
    this.expectedScroll = null;
    // A scroll from outside the list replaces a held anchor with whatever is now on top.
    if (!ours) this.anchorHeld = false;
    if (this.animatingTo !== null && (user || Math.abs(this.scroll - this.animatingTo) < 1))
      this.animatingTo = null;
    // Any scroll toward the start we did not issue (reader, screen reader, scrollIntoView) leaves the end.
    if (!ours && this.scroll < previous - 0.5 && this.distanceFromEnd > 1) {
      this.following = false;
      this.placingEnd = false;
      this.anchorHeld = false;
      this.scrollGeneration++;
    }
    if (user) {
      this.anchorHeld = false;
      clearTimeout(this.rearmTimer);
      this.rearmTimer = setTimeout(() => {
        const threshold = (this.props.maintainScrollAtEndThreshold ?? 0.1) * this.scrollLength;
        if (this.props.maintainScrollAtEnd && this.distanceFromEnd <= threshold) {
          this.following = true;
          this.notify();
        }
      }, 150);
    }
    if (this.scroll > previous && this.distanceFromEnd <= 1 && this.props.maintainScrollAtEnd)
      this.following = true;
    this.captureAnchor();
    // Mount newly exposed rows before the next paint, as a scroll can outrun drawDistance.
    if (this.computeWindow()) flushSync(this.rerender);
    this.props.onScroll?.({
      nativeEvent: {
        contentOffset: { x: scroller.scrollLeft, y: this.scroll },
        contentSize: { width: scroller.scrollWidth, height: scroller.scrollHeight },
        layoutMeasurement: { width: scroller.clientWidth, height: scroller.clientHeight },
      },
    });
    this.notify();
  }
  attachScroller = (el: HTMLDivElement | null) => {
    this.scroller = el;
    this.observeFixed(el);
  };
  markUserInput = () => {
    this.userInputAt = performance.now();
  };

  /** Runs after each React commit. */
  commit() {
    const scroller = this.scroller;
    if (!scroller) return;
    if (!this.loaded) {
      this.measureFixed();
      if (this.props.initialScrollAtEnd) {
        this.placingEnd = true;
        this.following = Boolean(this.props.maintainScrollAtEnd);
      }
    }
    this.measureMounted();
    if (!this.loaded && !this.props.initialScrollAtEnd && this.props.initialScrollOffset) {
      this.writeScroll(this.props.initialScrollOffset);
    }
    const dataChanged = this.dataChanged;
    this.dataChanged = false;
    this.settle(dataChanged ? "data" : "commit");
    if (!this.loaded && this.keys.length > 0) {
      this.loaded = true;
      this.captureAnchor();
      this.props.onLoad?.({ elapsedTimeInMs: performance.now() - this.mountedAt });
      this.props.onReady?.();
    }
  }

  private updateEndSpace() {
    const config = this.props.anchoredEndSpace;
    let size = 0;
    const index = config?.anchorIndex;
    if (config && index !== undefined && index >= 0 && index < this.keys.length) {
      const anchorSize = Math.min(this.fenwick.get(index), config.anchorMaxSize ?? Infinity);
      const below = anchorSize + this.fenwick.total - this.position(index + 1) + this.footerSize;
      size = Math.max(0, this.scrollLength - (config.anchorOffset ?? 0) - below);
      let ready = true;
      for (let i = index; ready && i < this.keys.length; i++) ready = this.sizes.has(this.keys[i]!);
      if (ready && this.anchorReadyKey !== this.keys[index]) {
        this.anchorReadyKey = this.keys[index];
        queueMicrotask(() =>
          config.onReady?.({ anchorIndex: index, anchorKey: this.keys[index], size }),
        );
      }
    } else {
      this.anchorReadyKey = undefined;
    }
    if (Math.abs(size - this.endSpace) < 0.5) return;
    this.endSpace = size;
    config?.onSizeChanged?.(size);
    this.rerender();
  }

  private notify() {
    const isAtEnd = this.contentLength <= this.scrollLength || this.distanceFromEnd <= 1;
    // Reaching the end by any route arms end-follow; a user scroll toward the start releases it.
    if (
      isAtEnd &&
      this.props.maintainScrollAtEnd &&
      performance.now() - this.userInputAt > USER_INPUT_WINDOW_MS
    ) {
      this.following = true;
    }
    const values: Record<Listenable, number | boolean> = {
      totalSize: this.fenwick.total,
      headerSize: this.headerSize,
      footerSize: this.footerSize,
      isAtStart: this.scroll <= 1,
      isAtEnd,
      isFollowingEnd: this.following,
    };
    for (const [type, set] of this.listeners) {
      const value = values[type];
      if (this.lastNotified.get(type) === value) continue;
      this.lastNotified.set(type, value);
      for (const callback of set) callback(value);
    }
    for (const [key, set] of this.positionListeners) {
      const index = this.indexByKey.get(key);
      if (index === undefined) continue;
      const position = this.position(index);
      if (this.lastPositions.get(key) === position) continue;
      this.lastPositions.set(key, position);
      for (const callback of set) callback(position);
    }
    const { onEndReached, onEndReachedThreshold } = this.props;
    if (onEndReached && this.keys.length > 0) {
      const near = this.distanceFromEnd <= (onEndReachedThreshold ?? 0.5) * this.scrollLength;
      if (near && !this.endReached) onEndReached({ distanceFromEnd: this.distanceFromEnd });
      this.endReached = near;
    }
  }

  private addListener<K, V>(map: Map<K, Set<V>>, key: K, callback: V) {
    const set = map.get(key) ?? new Set();
    map.set(key, set);
    set.add(callback);
    return () => {
      set.delete(callback);
    };
  }

  private async settleScroll(target: () => number, animated: boolean) {
    const generation = ++this.scrollGeneration;
    this.anchorHeld = false;
    this.placingEnd = false;
    this.writeScroll(target(), animated);
    // Rows measured on the way in move the target; re-aim until it holds for two frames.
    let stable = 0;
    for (let frame = 0; frame < 60 && stable < 2; frame++) {
      await new Promise(requestAnimationFrame);
      const scroller = this.scroller;
      if (!scroller || generation !== this.scrollGeneration) return;
      if (this.animatingTo !== null) continue;
      const goal = Math.max(0, Math.min(target(), this.maxScroll));
      if (Math.abs(goal - scroller.scrollTop) < 1) stable++;
      else {
        stable = 0;
        this.writeScroll(goal);
      }
    }
    this.captureAnchor();
  }

  readonly api: VirtualListRef = {
    getScrollableNode: () => this.scroller,
    cancelScroll: () => {
      this.scrollGeneration++;
      this.placingEnd = false;
      const scroller = this.scroller;
      if (scroller && this.animatingTo !== null) {
        this.animatingTo = null;
        scroller.scrollTo({ top: scroller.scrollTop, behavior: "instant" });
      }
    },
    anchorVisibleContent: ({ key }) => {
      const index = this.indexByKey.get(key);
      if (index === undefined) return undefined;
      const offset = this.scroll - this.startOffset - this.position(index);
      this.anchor = { key, delta: offset };
      this.anchorHeld = true;
      this.following = false;
      return { key, offset };
    },
    getState: () => {
      const engine = this;
      const w = engine.window;
      return {
        data: engine.props.data,
        scroll: engine.scroll,
        scrollLength: engine.scrollLength,
        contentLength: engine.contentLength,
        isAtStart: engine.scroll <= 1,
        isAtEnd: engine.contentLength <= engine.scrollLength || engine.distanceFromEnd <= 1,
        isFollowingEnd: engine.following,
        startOffset: engine.startOffset,
        start: engine.keys.length
          ? engine.fenwick.indexAt(Math.max(0, engine.scroll - engine.startOffset))
          : -1,
        end: engine.keys.length
          ? engine.fenwick.indexAt(
              Math.max(0, engine.scroll - engine.startOffset + engine.scrollLength),
            )
          : -1,
        startBuffered: w.start,
        endBuffered: w.end,
        sizes: engine.sizes,
        indexByKey: (key) => engine.indexByKey.get(key),
        positionAtIndex: (index) => engine.position(index),
        sizeAtIndex: (index) => engine.sizes.get(engine.keys[index] ?? "") ?? 0,
        elementAtIndex: (index) => engine.elements.get(engine.keys[index] ?? ""),
        listen: (type, callback) => engine.addListener(engine.listeners, type, callback),
        listenToPosition: (key, callback) =>
          engine.addListener(engine.positionListeners, key, callback),
      };
    },
    scrollToOffset: ({ offset, animated = false }) => {
      this.following = false;
      return this.settleScroll(() => offset, animated);
    },
    scrollToEnd: ({ animated = false, viewOffset = 0 } = {}) => {
      if (this.props.maintainScrollAtEnd) this.following = true;
      return this.settleScroll(() => this.maxScroll + viewOffset, animated);
    },
    scrollToIndex: ({ index, animated = false, viewOffset = 0, viewPosition = 0 }) => {
      this.following = false;
      const target = () =>
        this.startOffset +
        this.position(index) -
        viewOffset -
        viewPosition * (this.scrollLength - this.fenwick.get(index));
      return this.settleScroll(target, animated);
    },
    scrollIndexIntoView: ({ index, animated = false, viewportMargin = {} }) => {
      const top = this.startOffset + this.position(index);
      const bottom = top + this.fenwick.get(index);
      const viewTop = this.scroll + (viewportMargin.start ?? 0);
      const viewBottom = this.scroll + this.scrollLength - (viewportMargin.end ?? 0);
      if (top >= viewTop && bottom <= viewBottom) return Promise.resolve();
      return top < viewTop
        ? this.api.scrollToIndex({ index, animated, viewOffset: viewportMargin.start ?? 0 })
        : this.api.scrollToIndex({
            index,
            animated,
            viewPosition: 1,
            viewOffset: -(viewportMargin.end ?? 0),
          });
    },
  };

  dispose() {
    for (const stop of this.stops.values()) stop();
    this.stops.clear();
    clearTimeout(this.rearmTimer);
  }
}

interface RowProps<T> {
  engine: Engine<T>;
  itemKey: string;
  item: T;
  index: number;
  type: string | undefined;
  extraData: unknown;
  renderItem: VirtualListProps<T>["renderItem"];
  Separator: VirtualListProps<T>["ItemSeparatorComponent"];
  last: boolean;
}
const Row = memo(function Row<T>({
  engine,
  itemKey,
  item,
  index,
  type,
  extraData,
  renderItem,
  Separator,
  last,
}: RowProps<T>) {
  return (
    <div
      ref={(el) => engine.observe(itemKey, el)}
      data-vl-key={itemKey}
      data-index={index}
      style={{ display: "flow-root" }}
    >
      {renderItem({ item, index, extraData, type })}
      {Separator && !last ? <Separator leadingItem={item} /> : null}
    </div>
  );
}) as <T>(props: RowProps<T>) => ReactElement;

/** Variable-height virtualized list: Fenwick-indexed spacers, ResizeObserver measurement, end-follow and anchoring. */
export function VirtualList<T>(props: VirtualListProps<T>) {
  const {
    ref,
    data,
    renderItem,
    keyExtractor: _k,
    getItemType: _git,
    extraData,
    dataVersion: _dv,
    dataKey: _dk,
    estimatedItemSize: _e,
    drawDistance: _d,
    recycleItems: _r,
    initialScrollAtEnd: _i,
    initialScrollOffset: _io,
    maintainScrollAtEnd: _m,
    maintainScrollAtEndThreshold: _mt,
    maintainVisibleContentPosition: _mv,
    anchoredEndSpace: _a,
    contentInsetEndAdjustment = 0,
    alwaysRender: _ar,
    ListHeaderComponent,
    ListFooterComponent,
    ItemSeparatorComponent,
    contentContainerClassName,
    contentContainerStyle,
    style,
    onScroll: _os,
    onLayout: _ol,
    onLoad: _ld,
    onReady: _rd,
    onItemSizeChanged: _isc,
    onMetricsChange: _mc,
    onEndReached: _er,
    onEndReachedThreshold: _ert,
    ...rest
  } = props;
  const [engine] = useState(() => new Engine<T>());
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  engine.sync(props, rerender);
  useImperativeHandle(ref, () => engine.api, [engine]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the committed rows and corrects the scroll position before paint.
  useLayoutEffect(() => engine.commit());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the ResizeObserver.
  useLayoutEffect(() => () => engine.dispose(), [engine]);

  const { start, end, extras } = engine.window;
  const indices = [
    ...extras.filter((i) => i < start),
    ...Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => start + i),
    ...extras.filter((i) => i > end),
  ];
  const children: ReactNode[] = [];
  let cursor = 0;
  for (const index of indices) {
    if (index > cursor) {
      children.push(
        <div
          key={`gap-${cursor}`}
          aria-hidden
          style={{ height: engine.position(index) - engine.position(cursor) }}
        />,
      );
    }
    const key = engine.keys[index]!;
    children.push(
      <Row
        key={key}
        engine={engine}
        itemKey={key}
        item={data[index]!}
        index={index}
        type={engine.typeAt(index)}
        extraData={extraData}
        renderItem={renderItem}
        Separator={ItemSeparatorComponent}
        last={index === data.length - 1}
      />,
    );
    cursor = index + 1;
  }
  if (cursor < data.length) {
    children.push(
      <div
        key="gap-end"
        aria-hidden
        style={{ height: engine.fenwick.total - engine.position(cursor) }}
      />,
    );
  }
  const trailing = engine.endSpace + contentInsetEndAdjustment;

  return (
    <div
      {...rest}
      ref={(el) => engine.attachScroller(el)}
      style={{ overflowY: "auto", overflowAnchor: "none", position: "relative", ...style }}
      onScroll={() => engine.onScroll()}
      onWheel={() => engine.markUserInput()}
      onTouchMove={() => engine.markUserInput()}
      onPointerDown={(event) => {
        engine.markUserInput();
        rest.onPointerDown?.(event);
      }}
      onPointerMove={(event) => {
        if (event.buttons) engine.markUserInput();
        rest.onPointerMove?.(event);
      }}
      onKeyDown={(event) => {
        engine.markUserInput();
        rest.onKeyDown?.(event);
      }}
    >
      <div className={contentContainerClassName} style={contentContainerStyle}>
        {ListHeaderComponent ? (
          <div
            data-vl-role="header"
            ref={(el) => engine.observeFixed(el)}
            style={{ display: "flow-root" }}
          >
            <SlotView slot={ListHeaderComponent} />
          </div>
        ) : null}
        {children}
        {ListFooterComponent ? (
          <div
            data-vl-role="footer"
            ref={(el) => engine.observeFixed(el)}
            style={{ display: "flow-root" }}
          >
            <SlotView slot={ListFooterComponent} />
          </div>
        ) : null}
        {trailing > 0 ? <div aria-hidden style={{ height: trailing }} /> : null}
      </div>
    </div>
  );
}
