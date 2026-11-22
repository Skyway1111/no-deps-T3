import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";

export type UniqueIdentifier = string | number;
export interface Coordinates {
  x: number;
  y: number;
}
export interface ClientRect {
  width: number;
  height: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
}
export interface Transform extends Coordinates {
  scaleX: number;
  scaleY: number;
}
type Data = Record<string, unknown>;
type DataRef = { current: Data | undefined };

export interface Active {
  id: UniqueIdentifier;
  data: DataRef;
  rect: { current: { initial: ClientRect | null; translated: ClientRect | null } };
}
export interface Over {
  id: UniqueIdentifier;
  rect: ClientRect;
  data: DataRef;
  disabled: boolean;
}
export interface DroppableContainer {
  id: UniqueIdentifier;
  key: string;
  disabled: boolean;
  data: DataRef;
  node: RefObject<HTMLElement | null>;
  rect: RefObject<ClientRect | null>;
}
export interface Collision {
  id: UniqueIdentifier;
  data?: Data;
}
export type CollisionDetection = (args: {
  active: Active;
  collisionRect: ClientRect;
  droppableRects: Map<UniqueIdentifier, ClientRect>;
  droppableContainers: DroppableContainer[];
  pointerCoordinates: Coordinates | null;
}) => Collision[];
export type Modifier = (args: {
  transform: Transform;
  active: Active | null;
  activatorEvent: Event | null;
  activeNodeRect: ClientRect | null;
  draggingNodeRect: ClientRect | null;
  containerNodeRect: ClientRect | null;
  over: Over | null;
  scrollableAncestorRects: ClientRect[];
}) => Transform;
export type SortingStrategy = (args: {
  activeNodeRect: ClientRect | null;
  activeIndex: number;
  index: number;
  rects: ClientRect[];
  overIndex: number;
}) => Transform | null;

export interface SensorContext {
  readonly active: Active | null;
  readonly collisionRect: ClientRect | null;
  readonly droppableRects: Map<UniqueIdentifier, ClientRect>;
  readonly droppableContainers: DroppableContainer[];
  readonly over: Over | null;
}
export interface SensorProps<O> {
  active: UniqueIdentifier;
  activeNode: HTMLElement | null;
  event: Event;
  context: SensorContext;
  options: O;
  onPending: (
    id: UniqueIdentifier,
    constraint: unknown,
    initial: Coordinates,
    offset?: Coordinates,
  ) => void;
  onStart: (coordinates: Coordinates) => void;
  onMove: (coordinates: Coordinates) => void;
  onEnd: () => void;
  onCancel: () => void;
  onAbort: (id: UniqueIdentifier) => void;
}
export interface Sensor<O> {
  new (props: SensorProps<O>): { autoScrollEnabled: boolean };
  // `never` lets sensors narrow the React event they accept.
  activators: ReadonlyArray<{
    eventName: "onPointerDown" | "onKeyDown";
    handler: (event: never, options: O) => boolean;
  }>;
}
export interface SensorDescriptor {
  sensor: Sensor<never>;
  options: unknown;
}

interface DragEventBase {
  active: Active;
  activatorEvent: Event;
}
export type DragStartEvent = DragEventBase;
export interface DragOverEvent extends DragEventBase {
  over: Over | null;
  collisions: Collision[];
  delta: Coordinates;
}
export type DragEndEvent = DragOverEvent;

export interface AutoScrollOptions {
  threshold?: Coordinates;
  acceleration?: number;
  interval?: number;
}

const ZERO: Transform = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
const translateRect = (rect: ClientRect, { x, y }: Coordinates): ClientRect => ({
  width: rect.width,
  height: rect.height,
  top: rect.top + y,
  bottom: rect.bottom + y,
  left: rect.left + x,
  right: rect.right + x,
});
/** Layout rect of `node`, ignoring its own CSS translate. */
function measure(node: Element): ClientRect {
  const rect = node.getBoundingClientRect();
  const transform = getComputedStyle(node).transform;
  if (!transform || transform === "none") return rect;
  const matrix = new DOMMatrixReadOnly(transform);
  return translateRect(rect, { x: -matrix.m41, y: -matrix.m42 });
}
function scrollableAncestors(node: Element | null): Element[] {
  const result: Element[] = [];
  for (let el = node?.parentElement; el; el = el.parentElement) {
    if (/(auto|scroll|overlay)/.test(getComputedStyle(el).overflow)) result.push(el);
  }
  const root = node?.ownerDocument.scrollingElement;
  if (root && !result.includes(root)) result.push(root);
  return result;
}
const viewportRect = (el: Element): ClientRect =>
  el === el.ownerDocument.scrollingElement
    ? {
        top: 0,
        left: 0,
        width: innerWidth,
        height: innerHeight,
        right: innerWidth,
        bottom: innerHeight,
      }
    : el.getBoundingClientRect();

const center = (r: ClientRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

/** Droppables sorted by distance between their center and the dragged rect's center. */
export const closestCenter: CollisionDetection = ({
  collisionRect,
  droppableRects,
  droppableContainers,
}) => {
  const origin = center(collisionRect);
  const collisions: Array<Collision & { value: number }> = [];
  for (const container of droppableContainers) {
    const rect = droppableRects.get(container.id);
    if (!rect) continue;
    const c = center(rect);
    const value = Math.hypot(c.x - origin.x, c.y - origin.y);
    collisions.push({ id: container.id, data: { droppableContainer: container, value }, value });
  }
  return collisions.sort((a, b) => a.value - b.value);
};

function listStrategy(axis: "x" | "y"): SortingStrategy {
  const [start, end, size] =
    axis === "y" ? (["top", "bottom", "height"] as const) : (["left", "right", "width"] as const);
  return ({ rects, activeNodeRect, activeIndex, overIndex, index }) => {
    const activeRect = rects[activeIndex] ?? activeNodeRect;
    if (!activeRect) return null;
    const current = rects[index];
    const before = rects[index - 1];
    const after = rects[index + 1];
    const gapAfter = current && after ? after[start] - current[end] : undefined;
    const gapBefore = current && before ? current[start] - before[end] : undefined;
    const gap = (activeIndex < index ? (gapBefore ?? gapAfter) : (gapAfter ?? gapBefore)) ?? 0;
    const shift = (offset: number) => ({ ...ZERO, [axis]: offset });
    if (index === activeIndex) {
      const overRect = rects[overIndex];
      return overRect
        ? shift(
            index < overIndex
              ? overRect[end] - activeRect[end]
              : overRect[start] - activeRect[start],
          )
        : null;
    }
    if (index > activeIndex && index <= overIndex) return shift(-activeRect[size] - gap);
    if (index < activeIndex && index >= overIndex) return shift(activeRect[size] + gap);
    return ZERO;
  };
}
export const verticalListSortingStrategy = listStrategy("y");
export const horizontalListSortingStrategy = listStrategy("x");

function restrictToRect(
  transform: Transform,
  rect: ClientRect | null,
  bounds: ClientRect | undefined | null,
) {
  if (!rect || !bounds) return transform;
  const value = { ...transform };
  if (rect.top + transform.y <= bounds.top) value.y = bounds.top - rect.top;
  else if (rect.bottom + transform.y >= bounds.bottom) value.y = bounds.bottom - rect.bottom;
  if (rect.left + transform.x <= bounds.left) value.x = bounds.left - rect.left;
  else if (rect.right + transform.x >= bounds.right) value.x = bounds.right - rect.right;
  return value;
}
export const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });
export const restrictToHorizontalAxis: Modifier = ({ transform }) => ({ ...transform, y: 0 });
export const restrictToParentElement: Modifier = ({
  transform,
  draggingNodeRect,
  containerNodeRect,
}) => restrictToRect(transform, draggingNodeRect, containerNodeRect);
export const restrictToFirstScrollableAncestor: Modifier = ({
  transform,
  draggingNodeRect,
  scrollableAncestorRects,
}) => restrictToRect(transform, draggingNodeRect, scrollableAncestorRects[0]);

export function arrayMove<T>(array: readonly T[], from: number, to: number): T[] {
  const next = array.slice();
  next.splice(to < 0 ? next.length + to : to, 0, next.splice(from, 1)[0]!);
  return next;
}

export const CSS = {
  Translate: {
    toString: (t: Transform | null | undefined) =>
      t ? `translate3d(${Math.round(t.x)}px, ${Math.round(t.y)}px, 0)` : undefined,
  },
};

type PointerOptions = {
  activationConstraint?: { distance: number } | { delay: number; tolerance: number };
};

abstract class DocumentSensor<O> {
  autoScrollEnabled = true;
  protected readonly doc: Document;
  private readonly cleanups: Array<() => void> = [];
  protected started = false;
  private finished = false;

  constructor(protected readonly props: SensorProps<O>) {
    this.doc = (props.event.target as Node | null)?.ownerDocument ?? document;
  }
  protected listen<K extends keyof DocumentEventMap>(
    target: Document | Window,
    type: K,
    fn: (event: DocumentEventMap[K]) => void,
    capture = true,
  ) {
    target.addEventListener(type, fn as EventListener, { capture, passive: false });
    this.cleanups.push(() => target.removeEventListener(type, fn as EventListener, { capture }));
  }
  protected start(coordinates: Coordinates) {
    this.started = true;
    this.props.onStart(coordinates);
  }
  protected finish(cancelled: boolean) {
    if (this.finished) return;
    this.finished = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    if (!this.started) this.props.onAbort(this.props.active);
    if (cancelled) this.props.onCancel();
    else this.props.onEnd();
  }
}

export class PointerSensor extends DocumentSensor<PointerOptions> {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: ({ nativeEvent }: { nativeEvent: PointerEvent }) =>
        nativeEvent.isPrimary && nativeEvent.button === 0,
    },
  ];
  private readonly origin: Coordinates;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(props: SensorProps<PointerOptions>) {
    super(props);
    const event = props.event as PointerEvent;
    this.origin = { x: event.clientX, y: event.clientY };
    const win = this.doc.defaultView ?? window;
    const cancel = () => this.end(true);
    this.listen(this.doc, "pointermove", this.move);
    this.listen(this.doc, "pointerup", () => this.end(false));
    this.listen(this.doc, "pointercancel", cancel);
    this.listen(this.doc, "keydown", (e) => e.key === "Escape" && cancel());
    this.listen(this.doc, "visibilitychange", cancel);
    this.listen(win, "resize", cancel);
    this.listen(this.doc, "dragstart", (e) => e.preventDefault());
    const constraint = props.options.activationConstraint;
    if (!constraint) this.activate();
    else if ("delay" in constraint)
      this.timer = setTimeout(() => this.activate(), constraint.delay);
  }
  private activate() {
    this.listen(this.doc, "selectionchange", () => this.doc.getSelection()?.removeAllRanges());
    this.listen(this.doc, "contextmenu", (e) => e.preventDefault());
    this.start(this.origin);
  }
  private move = (event: PointerEvent) => {
    const point = { x: event.clientX, y: event.clientY };
    const moved = Math.hypot(point.x - this.origin.x, point.y - this.origin.y);
    const constraint = this.props.options.activationConstraint;
    if (!this.started) {
      if (constraint && "delay" in constraint) {
        if (moved > constraint.tolerance) this.end(true);
        return;
      }
      if (constraint && moved <= constraint.distance) return;
      this.activate();
    }
    if (event.cancelable) event.preventDefault();
    this.props.onMove(point);
  };
  private end(cancelled: boolean) {
    clearTimeout(this.timer);
    if (this.started) {
      // Swallow the click that follows a drag release.
      const stop = (e: Event) => e.stopPropagation();
      this.doc.addEventListener("click", stop, { capture: true, once: true });
      setTimeout(() => this.doc.removeEventListener("click", stop, { capture: true }), 50);
    }
    this.finish(cancelled);
  }
}

type KeyboardOptions = {
  coordinateGetter?: (
    event: KeyboardEvent,
    args: { active: UniqueIdentifier; currentCoordinates: Coordinates; context: SensorContext },
  ) => Coordinates | undefined;
};

export class KeyboardSensor extends DocumentSensor<KeyboardOptions> {
  static activators = [
    {
      eventName: "onKeyDown" as const,
      handler: (event: { nativeEvent: KeyboardEvent; preventDefault(): void }) => {
        if (event.nativeEvent.code !== "Space" && event.nativeEvent.code !== "Enter") return false;
        event.preventDefault();
        return true;
      },
    },
  ];
  override autoScrollEnabled = false;
  private coordinates: Coordinates;

  constructor(props: SensorProps<KeyboardOptions>) {
    super(props);
    const rect = props.activeNode?.getBoundingClientRect();
    this.coordinates = { x: rect?.left ?? 0, y: rect?.top ?? 0 };
    // The activating keydown is still dispatching; listen from the next task.
    setTimeout(() => {
      const win = this.doc.defaultView ?? window;
      this.listen(win, "keydown", this.keydown, false);
      this.listen(win, "resize", () => this.finish(true));
      this.listen(this.doc, "visibilitychange", () => this.finish(true));
    });
    this.start(this.coordinates);
  }
  private keydown = (event: KeyboardEvent) => {
    if (event.code === "Escape" || event.code === "Space" || event.code === "Enter") {
      event.preventDefault();
      this.finish(event.code === "Escape");
      return;
    }
    const next = this.props.options.coordinateGetter?.(event, {
      active: this.props.active,
      currentCoordinates: this.coordinates,
      context: this.props.context,
    });
    if (!next) return;
    event.preventDefault();
    this.coordinates = next;
    this.props.onMove(next);
  };
}

/** Keyboard coordinates that step the dragged item onto the nearest droppable in the arrow's direction. */
export const sortableKeyboardCoordinates: NonNullable<KeyboardOptions["coordinateGetter"]> = (
  event,
  { context: { active, collisionRect, droppableRects, droppableContainers } },
) => {
  const dir = { ArrowDown: [0, 1], ArrowUp: [0, -1], ArrowRight: [1, 0], ArrowLeft: [-1, 0] }[
    event.code
  ];
  if (!dir || !active || !collisionRect) return undefined;
  let best: ClientRect | undefined;
  let bestDistance = Infinity;
  for (const container of droppableContainers) {
    const rect = droppableRects.get(container.id);
    if (!rect || container.disabled || container.id === active.id) continue;
    const dx = rect.left - collisionRect.left;
    const dy = rect.top - collisionRect.top;
    if (dx * dir[0]! + dy * dir[1]! <= 0) continue;
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) [best, bestDistance] = [rect, distance];
  }
  return best && { x: best.left, y: best.top };
};

/** Pairs a sensor with its options; DndContext reads its sensors at event time. */
export const sensor = <O,>(sensor: Sensor<O>, options: O): SensorDescriptor => ({
  sensor: sensor as Sensor<never>,
  options,
});

interface Snapshot {
  active: Active | null;
  activatorEvent: Event | null;
  over: Over | null;
  transform: Transform;
  droppableRects: Map<UniqueIdentifier, ClientRect>;
}
interface DndProps {
  sensors?: SensorDescriptor[];
  collisionDetection?: CollisionDetection;
  modifiers?: Modifier[];
  autoScroll?: boolean | AutoScrollOptions;
  onDragStart?: (event: DragStartEvent) => void;
  onDragOver?: (event: DragOverEvent) => void;
  onDragEnd?: (event: DragEndEvent) => void;
  onDragCancel?: (event: DragEndEvent) => void;
}
interface Draggable {
  node: RefObject<HTMLElement | null>;
  data: DataRef;
}

class DndManager {
  props: DndProps = {};
  sensors: SensorDescriptor[] = [];
  setProps(props: DndProps, sensors: SensorDescriptor[]) {
    this.props = props;
    this.sensors = sensors;
  }
  readonly droppables = new Map<UniqueIdentifier, DroppableContainer>();
  readonly draggables = new Map<UniqueIdentifier, Draggable>();
  snapshot: Snapshot = {
    active: null,
    activatorEvent: null,
    over: null,
    transform: ZERO,
    droppableRects: new Map(),
  };
  private readonly listeners = new Set<() => void>();
  private sensor: { autoScrollEnabled: boolean } | null = null;
  private origin: Coordinates = { x: 0, y: 0 };
  private pointer: Coordinates | null = null;
  private initialRect: ClientRect | null = null;
  private ancestors: Element[] = [];
  private ancestorScroll: Coordinates[] = [];
  private collisions: Collision[] = [];
  private collisionRect: ClientRect | null = null;
  private stopDrag: (() => void) | null = null;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private set(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  private enabledDroppables = () => [...this.droppables.values()].filter((d) => !d.disabled);

  readonly sensorContext: SensorContext = (() => {
    const manager = this;
    return {
      get active() {
        return manager.snapshot.active;
      },
      get over() {
        return manager.snapshot.over;
      },
      get collisionRect() {
        return manager.collisionRect;
      },
      get droppableRects() {
        return manager.snapshot.droppableRects;
      },
      get droppableContainers() {
        return manager.enabledDroppables();
      },
    };
  })();

  activate(
    id: UniqueIdentifier,
    descriptor: SensorDescriptor,
    handler: (e: never, o: never) => boolean,
    event: SyntheticEvent,
  ) {
    const native = event.nativeEvent as Event & { dndCaptured?: boolean };
    if (this.sensor || native.dndCaptured || !handler(event as never, descriptor.options as never))
      return;
    native.dndCaptured = true;
    const finish = (cancelled: boolean) => () => this.end(cancelled);
    this.sensor = new descriptor.sensor({
      active: id,
      activeNode: this.draggables.get(id)?.node.current ?? null,
      event: native,
      context: this.sensorContext,
      options: descriptor.options as never,
      onPending: () => {},
      onAbort: () => {},
      onStart: (coordinates) => this.start(id, coordinates, native),
      onMove: (coordinates) => {
        this.pointer = coordinates;
        this.update();
        if (native instanceof KeyboardEvent) this.revealKeyboardTarget();
      },
      onEnd: finish(false),
      onCancel: finish(true),
    });
  }

  private start(id: UniqueIdentifier, coordinates: Coordinates, activatorEvent: Event) {
    const draggable = this.draggables.get(id);
    const node = draggable?.node.current;
    if (!draggable || !node) return;
    this.origin = coordinates;
    this.pointer = activatorEvent instanceof KeyboardEvent ? null : coordinates;
    this.initialRect = measure(node);
    this.ancestors = scrollableAncestors(node);
    this.ancestorScroll = this.ancestors.map((el) => ({ x: el.scrollLeft, y: el.scrollTop }));
    const active: Active = {
      id,
      data: draggable.data,
      rect: { current: { initial: this.initialRect, translated: this.initialRect } },
    };
    this.snapshot = {
      ...this.snapshot,
      active,
      activatorEvent,
      droppableRects: this.measureDroppables(),
    };
    const doc = node.ownerDocument;
    const onScroll = () => this.update();
    doc.addEventListener("scroll", onScroll, { capture: true, passive: true });
    const autoScroll = this.props.autoScroll ?? true;
    const timer =
      autoScroll === false
        ? undefined
        : this.startAutoScroll(autoScroll === true ? {} : autoScroll);
    this.stopDrag = () => {
      doc.removeEventListener("scroll", onScroll, { capture: true });
      clearInterval(timer);
    };
    this.props.onDragStart?.({ active, activatorEvent });
    this.update(coordinates);
  }

  private scrollDelta(): Coordinates {
    let x = 0;
    let y = 0;
    this.ancestors.forEach((el, i) => {
      x += el.scrollLeft - this.ancestorScroll[i]!.x;
      y += el.scrollTop - this.ancestorScroll[i]!.y;
    });
    return { x, y };
  }

  /** `node`'s layout rect in drag-start coordinates (current layout plus scroll since the drag began). */
  measureStart(node: Element) {
    return translateRect(measure(node), this.snapshot.active ? this.scrollDelta() : { x: 0, y: 0 });
  }
  private measureDroppables() {
    const rects = new Map<UniqueIdentifier, ClientRect>();
    for (const droppable of this.droppables.values()) {
      const node = droppable.node.current;
      if (!node) continue;
      const rect = this.measureStart(node);
      droppable.rect.current = rect;
      rects.set(droppable.id, rect);
    }
    return rects;
  }
  remeasure() {
    if (!this.snapshot.active) return;
    this.snapshot = { ...this.snapshot, droppableRects: this.measureDroppables() };
    this.update();
  }

  private update(pointer = this.pointer ?? this.origin) {
    const { active, activatorEvent, droppableRects } = this.snapshot;
    const initialRect = this.initialRect;
    if (!active || !initialRect) return;
    const scroll = this.scrollDelta();
    const node = this.draggables.get(active.id)?.node.current;
    const activeNodeRect = translateRect(initialRect, { x: -scroll.x, y: -scroll.y });
    const parent = node?.parentElement;
    // Pointer coordinates are client-space; keyboard ones are already drag-start rects.
    const keyboard = activatorEvent instanceof KeyboardEvent;
    const raw = {
      ...ZERO,
      x: pointer.x - this.origin.x + (keyboard ? 0 : scroll.x),
      y: pointer.y - this.origin.y + (keyboard ? 0 : scroll.y),
    };
    const transform = (this.props.modifiers ?? []).reduce(
      (t, modifier) =>
        modifier({
          transform: t,
          active,
          activatorEvent,
          activeNodeRect,
          draggingNodeRect: activeNodeRect,
          containerNodeRect: parent ? parent.getBoundingClientRect() : null,
          over: this.snapshot.over,
          scrollableAncestorRects: this.ancestors.map(viewportRect),
        }),
      raw,
    );
    const collisionRect = translateRect(initialRect, transform);
    this.collisionRect = collisionRect;
    active.rect.current.translated = translateRect(activeNodeRect, transform);
    this.collisions = (this.props.collisionDetection ?? closestCenter)({
      active,
      collisionRect,
      droppableRects,
      droppableContainers: this.enabledDroppables(),
      pointerCoordinates: this.pointer,
    });
    const overId = this.collisions[0]?.id;
    const container = overId === undefined ? undefined : this.droppables.get(overId);
    const rect = overId === undefined ? undefined : droppableRects.get(overId);
    const over =
      container && rect
        ? { id: container.id, rect, data: container.data, disabled: container.disabled }
        : null;
    const overChanged = over?.id !== this.snapshot.over?.id;
    const t = this.snapshot.transform;
    if (overChanged || t.x !== transform.x || t.y !== transform.y) this.set({ transform, over });
    if (overChanged && activatorEvent) {
      this.props.onDragOver?.({
        active,
        activatorEvent,
        over,
        collisions: this.collisions,
        delta: transform,
      });
    }
  }

  /** Scrolls the nearest clipping ancestor so a keyboard-moved item stays in view. */
  private revealKeyboardTarget() {
    const target = this.collisionRect;
    if (!target) return;
    const scroll = this.scrollDelta();
    const r = translateRect(target, { x: -scroll.x, y: -scroll.y });
    const past = (lo: number, hi: number, min: number, max: number) =>
      lo < min ? lo - min : hi > max ? hi - max : 0;
    for (const el of this.ancestors) {
      const v = viewportRect(el);
      const top = past(r.top, r.bottom, v.top, v.bottom);
      const left = past(r.left, r.right, v.left, v.right);
      if (top || left) {
        el.scrollBy({ top, left, behavior: "smooth" });
        return;
      }
    }
  }

  private startAutoScroll({
    threshold = { x: 0.2, y: 0.2 },
    acceleration = 10,
    interval = 5,
  }: AutoScrollOptions) {
    return setInterval(() => {
      const pointer = this.pointer;
      if (!pointer || !this.sensor?.autoScrollEnabled) return;
      for (const el of this.ancestors) {
        const rect = viewportRect(el);
        const zone = { x: rect.width * threshold.x, y: rect.height * threshold.y };
        const speed = (
          pos: number,
          start: number,
          end: number,
          size: number,
          scroll: number,
          max: number,
        ) =>
          scroll > 0 && pos <= start + size
            ? -acceleration * Math.abs((start + size - pos) / size)
            : scroll < max && pos >= end - size
              ? acceleration * Math.abs((end - size - pos) / size)
              : 0;
        const dy = zone.y
          ? speed(
              pointer.y,
              rect.top,
              rect.bottom,
              zone.y,
              el.scrollTop,
              el.scrollHeight - el.clientHeight,
            )
          : 0;
        const dx = zone.x
          ? speed(
              pointer.x,
              rect.left,
              rect.right,
              zone.x,
              el.scrollLeft,
              el.scrollWidth - el.clientWidth,
            )
          : 0;
        if (dx || dy) {
          el.scrollBy(dx, dy);
          return;
        }
      }
    }, interval);
  }

  private end(cancelled: boolean) {
    this.sensor = null;
    this.stopDrag?.();
    this.stopDrag = null;
    const { active, activatorEvent, over, transform } = this.snapshot;
    if (!active || !activatorEvent) return;
    const event = { active, activatorEvent, over, collisions: this.collisions, delta: transform };
    this.initialRect = null;
    this.collisionRect = null;
    this.set({ active: null, activatorEvent: null, over: null, transform: ZERO });
    (cancelled ? this.props.onDragCancel : this.props.onDragEnd)?.(event);
  }
}

const DndCtx = createContext<DndManager | null>(null);
const DEFAULT_SENSORS: SensorDescriptor[] = [
  { sensor: PointerSensor, options: {} },
  { sensor: KeyboardSensor, options: {} },
];

export function DndContext({
  children,
  sensors = DEFAULT_SENSORS,
  ...props
}: DndProps & { children?: ReactNode }) {
  const [manager] = useState(() => new DndManager());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- event handlers read the latest props during a drag.
  useLayoutEffect(() => manager.setProps(props, sensors));
  return <DndCtx.Provider value={manager}>{children}</DndCtx.Provider>;
}

// Outside a DndContext, draggables render inert.
const INERT = new DndManager();
const useDnd = () => useContext(DndCtx) ?? INERT;

/** Subscribes to one derived slice of the drag snapshot; re-renders only when `isEqual` says it changed. */
function useDragSlice<T>(
  manager: DndManager,
  select: (s: Snapshot) => T,
  isEqual: (a: T, b: T) => boolean,
): T {
  const cache = useRef<{ snapshot: Snapshot; value: T } | null>(null);
  const get = () => {
    const prev = cache.current;
    const value = select(manager.snapshot);
    if (prev && isEqual(prev.value, value)) {
      cache.current = { snapshot: manager.snapshot, value: prev.value };
      return prev.value;
    }
    cache.current = { snapshot: manager.snapshot, value };
    return value;
  };
  return useSyncExternalStore(manager.subscribe, get, get);
}

const sameTransform = (a: Transform | null, b: Transform | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.x === b.x &&
    a.y === b.y &&
    a.scaleX === b.scaleX &&
    a.scaleY === b.scaleY);

function listenersFor(manager: DndManager, id: UniqueIdentifier, disabled: boolean) {
  {
    if (disabled) return undefined;
    // Sensors are read at event time, so a new sensors array never re-renders rows.
    const activate = (eventName: "onPointerDown" | "onKeyDown") => (event: SyntheticEvent) => {
      for (const descriptor of manager.sensors) {
        for (const activator of descriptor.sensor.activators) {
          if (activator.eventName === eventName)
            manager.activate(id, descriptor, activator.handler, event);
        }
      }
    };
    return { onPointerDown: activate("onPointerDown"), onKeyDown: activate("onKeyDown") };
  }
}

function useNodeRef() {
  const node = useRef<HTMLElement | null>(null);
  const [setNode] = useState(() => (el: HTMLElement | null) => {
    node.current = el;
  });
  return [node, setNode] as const;
}

function useRegisterDraggable(
  manager: DndManager,
  id: UniqueIdentifier,
  node: RefObject<HTMLElement | null>,
  data: Data | undefined,
) {
  const dataRef = useRef<Data | undefined>(data);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this node with the drag engine.
  useLayoutEffect(() => {
    dataRef.current = data;
    manager.draggables.set(id, { node, data: dataRef });
    return () => {
      if (manager.draggables.get(id)?.node === node) manager.draggables.delete(id);
    };
  });
  return dataRef;
}

export function useDraggable({
  id,
  data,
  disabled = false,
}: {
  id: UniqueIdentifier;
  data?: Data;
  disabled?: boolean;
}) {
  const manager = useDnd();
  const [node, setNodeRef] = useNodeRef();
  useRegisterDraggable(manager, id, node, data);
  const transform = useDragSlice(
    manager,
    (s) => (s.active?.id === id ? s.transform : null),
    sameTransform,
  );
  return {
    node,
    setNodeRef,
    listeners: listenersFor(manager, id, disabled),
    attributes: {
      role: "button",
      tabIndex: 0,
      "aria-disabled": disabled,
      "aria-roledescription": "draggable",
    },
    transform,
    isDragging: transform !== null,
  };
}

interface SortableCtx {
  items: UniqueIdentifier[];
  strategy: SortingStrategy;
  sortedRects: (rects: Map<UniqueIdentifier, ClientRect>) => ClientRect[];
}
const SortableContextCtx = createContext<SortableCtx>({
  items: [],
  strategy: verticalListSortingStrategy,
  sortedRects: () => [],
});

const sortedCache = new WeakMap<
  Map<UniqueIdentifier, ClientRect>,
  WeakMap<UniqueIdentifier[], ClientRect[]>
>();
/** Rects in item order (sparse where unmeasured), cached per measurement pass and id list. */
function sortedRects(rects: Map<UniqueIdentifier, ClientRect>, ids: UniqueIdentifier[]) {
  let byIds = sortedCache.get(rects);
  if (!byIds) sortedCache.set(rects, (byIds = new WeakMap()));
  let sorted = byIds.get(ids);
  if (!sorted) {
    sorted = [];
    for (const [i, id] of ids.entries()) {
      const rect = rects.get(id);
      if (rect) sorted[i] = rect;
    }
    byIds.set(ids, sorted);
  }
  return sorted;
}

export function SortableContext({
  items,
  strategy = verticalListSortingStrategy,
  children,
}: {
  items: ReadonlyArray<UniqueIdentifier | { id: UniqueIdentifier }>;
  strategy?: SortingStrategy;
  children?: ReactNode;
}) {
  const manager = useDnd();
  const ids = items.map((item) => (typeof item === "object" ? item.id : item));
  const key = ids.join("\0");
  // Keep one array per id sequence so equal re-renders leave rows memoized.
  const [stable, setStable] = useState({ key, ids });
  if (stable.key !== key) setStable({ key, ids });
  const stableIds = stable.key === key ? stable.ids : ids;
  const value: SortableCtx = {
    items: stableIds,
    strategy,
    sortedRects: (rects) => sortedRects(rects, stableIds),
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- items reordered mid-drag move their droppable rects.
  useLayoutEffect(() => manager.remeasure());
  return <SortableContextCtx.Provider value={value}>{children}</SortableContextCtx.Provider>;
}

interface SortableSlice {
  transform: Transform | null;
  isDragging: boolean;
  isSorting: boolean;
  keyboard: boolean;
}

export function useSortable({
  id,
  data,
  disabled = false,
}: {
  id: UniqueIdentifier;
  data?: Data;
  disabled?: boolean | { draggable?: boolean; droppable?: boolean };
}) {
  const manager = useDnd();
  const { items, strategy, sortedRects } = useContext(SortableContextCtx);
  const draggableDisabled = typeof disabled === "boolean" ? disabled : disabled.draggable === true;
  const droppableDisabled = typeof disabled === "boolean" ? disabled : disabled.droppable === true;
  const [node, setNodeRef] = useNodeRef();
  const dataRef = useRegisterDraggable(manager, id, node, data);
  const [rect] = useState(() => ({ current: null as ClientRect | null }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this node as a drop target.
  useLayoutEffect(() => {
    const container: DroppableContainer = {
      id,
      key: String(id),
      disabled: droppableDisabled,
      data: dataRef,
      node,
      rect,
    };
    manager.droppables.set(id, container);
    return () => {
      if (manager.droppables.get(id) === container) manager.droppables.delete(id);
    };
  }, [manager, id, droppableDisabled, dataRef, node, rect]);

  const index = items.indexOf(id);
  const slice = useDragSlice<SortableSlice>(
    manager,
    (s) => {
      const isDragging = s.active?.id === id;
      const activeIndex = s.active ? items.indexOf(s.active.id) : -1;
      const overIndex = s.over ? items.indexOf(s.over.id) : -1;
      const displace = activeIndex >= 0 && overIndex >= 0 && index >= 0;
      return {
        isDragging,
        isSorting: s.active !== null,
        keyboard: s.activatorEvent instanceof KeyboardEvent,
        transform: !displace
          ? null
          : isDragging
            ? s.transform
            : strategy({
                rects: sortedRects(s.droppableRects),
                activeNodeRect: s.active?.rect.current.initial ?? null,
                activeIndex,
                overIndex,
                index,
              }),
      };
    },
    (a, b) =>
      a.isDragging === b.isDragging &&
      a.isSorting === b.isSorting &&
      a.keyboard === b.keyboard &&
      sameTransform(a.transform, b.transform),
  );

  // FLIP rows whose index changes mid-drag from their previous rect to the new one.
  const [derived, setDerived] = useState<Transform | null>(null);
  const previous = useRef({ index, transform: slice.transform });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the DOM after a mid-drag reorder to animate it.
  useLayoutEffect(() => {
    const last = previous.current;
    previous.current = { index, transform: slice.transform };
    const before = rect.current;
    if (last.index === index || !slice.isSorting || !before || !node.current) return;
    const now = manager.measureStart(node.current);
    const x = before.left + (last.transform?.x ?? 0) - now.left;
    const y = before.top + (last.transform?.y ?? 0) - now.top;
    if (x === (slice.transform?.x ?? 0) && y === (slice.transform?.y ?? 0)) return;
    setDerived({ ...ZERO, x, y });
    const frame = requestAnimationFrame(() => setDerived(null));
    return () => cancelAnimationFrame(frame);
  }, [index, slice.isSorting, slice.transform, manager, node, rect]);

  return {
    node,
    setNodeRef,
    listeners: listenersFor(manager, id, draggableDisabled),
    attributes: {
      role: "button",
      tabIndex: draggableDisabled ? -1 : 0,
      "aria-disabled": draggableDisabled,
      "aria-pressed": slice.isDragging || undefined,
      "aria-roledescription": "sortable",
    },
    index,
    isDragging: slice.isDragging,
    isSorting: slice.isSorting,
    transform: derived ?? slice.transform,
    transition: derived
      ? "transform 0ms linear"
      : slice.isSorting && (!slice.isDragging || slice.keyboard)
        ? "transform 200ms ease"
        : undefined,
  };
}
