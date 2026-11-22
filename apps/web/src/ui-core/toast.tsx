import {
  createContext,
  use,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { createPortal } from "react-dom";
import { computePlacement } from "./popups";
import { renderPart, transitionAttrs, useEvent, type PartProps } from "./primitives";

export interface ToastManagerAddOptions<D = unknown> {
  id?: string | undefined;
  type?: string | undefined;
  title?: ReactNode;
  description?: ReactNode;
  timeout?: number | undefined;
  priority?: "low" | "high" | undefined;
  data?: D | undefined;
  actionProps?: ComponentPropsWithoutRef<"button"> | undefined;
  onClose?: (() => void) | undefined;
  onRemove?: (() => void) | undefined;
  positionerProps?:
    | {
        anchor?: Element | null | undefined;
        side?: "top" | "bottom" | "left" | "right" | undefined;
        sideOffset?: number | undefined;
        align?: "start" | "center" | "end" | undefined;
      }
    | undefined;
}
export interface ToastObject<D = unknown> extends ToastManagerAddOptions<D> {
  id: string;
  transitionStatus: "starting" | "ending" | undefined;
  swipeDirection?: string | undefined;
  height?: number | undefined;
}
type Listener = () => void;

let nextId = 0;
// Managers also run outside the DOM (unit tests, early boot).
const nextFrame = (fn: () => void) =>
  typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : setTimeout(fn, 16);
/** Toast queue shared by providers. Toasts before the first provider mounts wait for it; later ones need a mounted provider. */
function createToastManager<D = unknown>() {
  let toasts: ToastObject<D>[] = [];
  let booted = false;
  const listeners = new Set<Listener>();
  const timers = new Map<
    string,
    { remaining: number; started: number | null; handle: ReturnType<typeof setTimeout> | null }
  >();
  let paused = false;
  const emit = () => {
    toasts = [...toasts];
    for (const listener of listeners) listener();
  };
  const startTimer = (id: string) => {
    const timer = timers.get(id);
    if (!timer || timer.handle || paused || timer.remaining <= 0) return;
    timer.started = Date.now();
    timer.handle = setTimeout(() => manager.close(id), timer.remaining);
  };
  const stopTimer = (id: string) => {
    const timer = timers.get(id);
    if (!timer?.handle) return;
    clearTimeout(timer.handle);
    timer.handle = null;
    timer.remaining -= Date.now() - (timer.started ?? Date.now());
  };
  const schedule = (toast: ToastObject<D>) => {
    stopTimer(toast.id);
    const timeout = toast.timeout ?? (toast.type === "loading" ? 0 : manager.defaultTimeout);
    timers.set(toast.id, { remaining: timeout, started: null, handle: null });
    if (timeout > 0) startTimer(toast.id);
  };
  const manager = {
    /** Set by the provider's `timeout`. */
    defaultTimeout: 5000,
    setDefaultTimeout: (timeout: number) => {
      manager.defaultTimeout = timeout;
    },
    get toasts() {
      return toasts;
    },
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      booted = true;
      return () => {
        listeners.delete(listener);
        // Toasts belong to a mounted provider; the last one leaving drops them.
        if (listeners.size === 0) {
          for (const id of timers.keys()) stopTimer(id);
          timers.clear();
          toasts = [];
        }
      };
    },
    add: (options: ToastManagerAddOptions<D>): string => {
      const id = options.id ?? `toast-${++nextId}`;
      if (booted && listeners.size === 0) return id;
      const existing = toasts.find((t) => t.id === id);
      const toast: ToastObject<D> = {
        ...existing,
        ...options,
        id,
        transitionStatus: existing ? existing.transitionStatus : "starting",
      };
      toasts = existing ? toasts.map((t) => (t.id === id ? toast : t)) : [toast, ...toasts];
      schedule(toast);
      emit();
      if (!existing) {
        nextFrame(() =>
          nextFrame(() => {
            toasts = toasts.map((t) =>
              t.id === id && t.transitionStatus === "starting"
                ? { ...t, transitionStatus: undefined }
                : t,
            );
            emit();
          }),
        );
      }
      return id;
    },
    update: (id: string, options: Partial<ToastManagerAddOptions<D>>) => {
      const current = toasts.find((t) => t.id === id);
      if (!current) return;
      const next: ToastObject<D> = { ...current, ...options, id };
      toasts = toasts.map((t) => (t.id === id ? next : t));
      if (options.timeout !== undefined || options.type !== undefined) schedule(next);
      emit();
    },
    close: (id?: string, swipeDirection?: string) => {
      for (const toast of toasts) {
        if ((id === undefined || toast.id === id) && toast.transitionStatus !== "ending") {
          stopTimer(toast.id);
          timers.delete(toast.id);
          toast.onClose?.();
        }
      }
      toasts = toasts.map((t) =>
        id === undefined || t.id === id
          ? { ...t, transitionStatus: "ending", swipeDirection: swipeDirection ?? t.swipeDirection }
          : t,
      );
      emit();
    },
    remove: (id: string) => {
      const toast = toasts.find((t) => t.id === id);
      if (!toast) return;
      toasts = toasts.filter((t) => t.id !== id);
      toast.onRemove?.();
      emit();
    },
    promise: <T,>(
      promise: Promise<T>,
      options: {
        loading: ToastManagerAddOptions<D>;
        success: ToastManagerAddOptions<D> | ((value: T) => ToastManagerAddOptions<D>);
        error: ToastManagerAddOptions<D> | ((error: unknown) => ToastManagerAddOptions<D>);
      },
    ) => {
      const id = manager.add({ ...options.loading, type: "loading", timeout: 0 });
      promise.then(
        (value) =>
          manager.update(id, {
            type: "success",
            timeout: 5000,
            ...(typeof options.success === "function" ? options.success(value) : options.success),
          }),
        (error: unknown) =>
          manager.update(id, {
            type: "error",
            timeout: 5000,
            ...(typeof options.error === "function" ? options.error(error) : options.error),
          }),
      );
      return promise;
    },
    setHeight: (id: string, height: number) => {
      const toast = toasts.find((t) => t.id === id);
      if (!toast || toast.height === height) return;
      toasts = toasts.map((t) => (t.id === id ? { ...t, height } : t));
      emit();
    },
    pause: () => {
      paused = true;
      for (const id of timers.keys()) stopTimer(id);
    },
    resume: () => {
      paused = false;
      for (const id of timers.keys()) startTimer(id);
    },
  };
  return manager;
}
export type ToastManager<D = unknown> = ReturnType<typeof createToastManager<D>>;

const ProviderCtx = createContext<{
  manager: ToastManager<any>;
  limit: number;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
} | null>(null);
function useProvider() {
  const ctx = use(ProviderCtx);
  if (!ctx) throw new Error("Toast parts must render inside Toast.Provider");
  return ctx;
}
type ProviderProps = {
  toastManager?: ToastManager<any> | undefined;
  limit?: number | undefined;
  timeout?: number | undefined;
  children?: ReactNode;
};
function ToastProvider({
  toastManager: external,
  limit = 3,
  timeout = 5000,
  children,
}: ProviderProps) {
  const [own] = useState(() => createToastManager());
  const toastManager = external ?? own;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the provider's default timeout to its manager.
  useLayoutEffect(() => {
    toastManager.setDefaultTimeout(timeout);
  }, [toastManager, timeout]);
  const [expanded, setExpanded] = useState(false);
  return (
    <ProviderCtx value={{ manager: toastManager, limit, expanded, setExpanded }}>
      {children}
    </ProviderCtx>
  );
}
/** The provider's toasts plus its manager's methods. */
function useToastManager<D = unknown>() {
  const { manager } = useProvider();
  const toasts = useSyncExternalStore(
    manager.subscribe,
    () => manager.toasts,
    () => manager.toasts,
  ) as ToastObject<D>[];
  return {
    toasts,
    add: manager.add,
    close: manager.close,
    update: manager.update,
    promise: manager.promise,
  };
}
function ToastPortal({
  children,
  container,
}: {
  children?: ReactNode;
  container?: HTMLElement | null | undefined;
  className?: string;
}) {
  if (typeof document === "undefined") return null;
  return createPortal(children, container ?? document.body);
}
function ToastViewport(props: PartProps<"div", { expanded: boolean }>) {
  const { manager, expanded, setExpanded } = useProvider();
  const setHover = useEvent((next: boolean) => {
    setExpanded(next);
    if (next) manager.pause();
    else manager.resume();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pauses toast timers while the page is hidden.
  useLayoutEffect(() => {
    const sync = () => (document.hidden ? manager.pause() : manager.resume());
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [manager]);
  return renderPart(
    "div",
    props,
    { expanded },
    {
      role: "region",
      "aria-live": "polite",
      tabIndex: -1,
      ...(expanded ? { "data-expanded": "" } : {}),
      onPointerEnter: () => setHover(true),
      onPointerLeave: () => setHover(false),
      onFocus: () => setHover(true),
      onBlur: (event: SyntheticEvent<HTMLElement, FocusEvent>) => {
        if (!event.currentTarget.contains(event.nativeEvent.relatedTarget as Node | null))
          setHover(false);
      },
    },
  );
}

const RootCtx = createContext<(ToastObject & { titleId: string; descriptionId: string }) | null>(
  null,
);
function useToast() {
  const toast = use(RootCtx);
  if (!toast) throw new Error("Toast parts must render inside Toast.Root");
  return toast;
}
const SWIPE_THRESHOLD = 40;
type SwipeDirection = "left" | "right" | "up" | "down";
function ToastRoot({
  toast,
  swipeDirection = ["down", "right"],
  style,
  ...props
}: PartProps<"div", { transitionStatus: ToastObject["transitionStatus"]; expanded: boolean }> & {
  toast: ToastObject;
  swipeDirection?: SwipeDirection | SwipeDirection[] | undefined;
}) {
  const { manager, limit, expanded } = useProvider();
  const el = useRef<HTMLElement | null>(null);
  const [swipe, setSwipe] = useState({ x: 0, y: 0 });
  const setRef = useEvent((node: HTMLElement | null) => {
    el.current = node;
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures height for stacking and removes the toast after its exit transition.
  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    if (toast.transitionStatus === "ending") {
      const frame = requestAnimationFrame(() => {
        const animations = node.getAnimations();
        if (animations.length === 0) manager.remove(toast.id);
        else
          void Promise.allSettled(animations.map((a) => a.finished)).then(() =>
            manager.remove(toast.id),
          );
      });
      return () => cancelAnimationFrame(frame);
    }
    // Natural height changes with the toast's content, not with swipes or stacking.
    const previous = node.style.height;
    node.style.height = "auto";
    manager.setHeight(toast.id, node.offsetHeight);
    node.style.height = previous;
  }, [manager, toast]);
  const index = manager.toasts.filter((t) => t.transitionStatus !== "ending").indexOf(toast);
  const directions = Array.isArray(swipeDirection) ? swipeDirection : [swipeDirection];
  const onPointerDown = useEvent((event: SyntheticEvent<HTMLElement, PointerEvent>) => {
    const target = event.target as HTMLElement;
    if (event.nativeEvent.button !== 0 || target.closest("button,a,input,textarea,select")) return;
    const start = { x: event.nativeEvent.clientX, y: event.nativeEvent.clientY };
    const node = event.currentTarget;
    node.setPointerCapture?.(event.nativeEvent.pointerId);
    const clampAxis = (delta: number, negative: SwipeDirection, positive: SwipeDirection) =>
      (delta < 0 && directions.includes(negative)) || (delta > 0 && directions.includes(positive))
        ? delta
        : delta * 0.1;
    const move = (e: PointerEvent) =>
      setSwipe({
        x: clampAxis(e.clientX - start.x, "left", "right"),
        y: clampAxis(e.clientY - start.y, "up", "down"),
      });
    const up = (e: PointerEvent) => {
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      const dir: SwipeDirection | null =
        Math.abs(dx) > Math.abs(dy)
          ? dx > SWIPE_THRESHOLD
            ? "right"
            : dx < -SWIPE_THRESHOLD
              ? "left"
              : null
          : dy > SWIPE_THRESHOLD
            ? "down"
            : dy < -SWIPE_THRESHOLD
              ? "up"
              : null;
      if (dir && directions.includes(dir)) manager.close(toast.id, dir);
      else setSwipe({ x: 0, y: 0 });
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
  });
  const state = { transitionStatus: toast.transitionStatus, expanded };
  const titleId = `${toast.id}-title`;
  const descriptionId = `${toast.id}-description`;
  const vars = {
    "--toast-height": toast.height === undefined ? undefined : `${toast.height}px`,
    "--toast-swipe-movement-x": `${swipe.x}px`,
    "--toast-swipe-movement-y": `${swipe.y}px`,
    ...(typeof style === "function" ? style(state) : style),
  } as CSSProperties;
  return (
    <RootCtx value={{ ...toast, titleId, descriptionId }}>
      {renderPart(
        "div",
        { ...props, style: vars },
        state,
        {
          role: toast.priority === "high" ? "alertdialog" : "dialog",
          "aria-modal": false,
          "aria-labelledby": toast.title ? titleId : undefined,
          "aria-describedby": toast.description ? descriptionId : undefined,
          tabIndex: 0,
          "data-type": toast.type,
          ...(expanded ? { "data-expanded": "" } : {}),
          ...(index >= limit ? { "data-limited": "" } : {}),
          ...(toast.swipeDirection ? { "data-swipe-direction": toast.swipeDirection } : {}),
          ...transitionAttrs(toast.transitionStatus),
          onPointerDown,
          onKeyDown: (event: SyntheticEvent<HTMLElement, KeyboardEvent>) => {
            if (event.nativeEvent.key === "Escape") manager.close(toast.id);
          },
        },
        setRef,
      )}
    </RootCtx>
  );
}
function ToastContent(props: PartProps<"div", { expanded: boolean }>) {
  const { expanded } = useProvider();
  return renderPart("div", props, { expanded }, expanded ? { "data-expanded": "" } : {});
}
function ToastTitle(props: PartProps<"h2", object>) {
  const toast = useToast();
  return renderPart(
    "h2",
    { ...props, children: props.children ?? toast.title },
    {},
    { id: toast.titleId },
  );
}
function ToastDescription(props: PartProps<"p", object>) {
  const toast = useToast();
  return renderPart(
    "p",
    { ...props, children: props.children ?? toast.description },
    {},
    { id: toast.descriptionId },
  );
}
function ToastAction(props: PartProps<"button", object>) {
  const toast = useToast();
  if (!toast.actionProps && !props.children) return null;
  return renderPart(
    "button",
    { ...toast.actionProps, ...props } as PartProps<"button", object>,
    {},
    { type: "button" },
  );
}
function ToastClose(props: PartProps<"button", object>) {
  const toast = useToast();
  const { manager } = useProvider();
  return renderPart(
    "button",
    props,
    {},
    { type: "button", onClick: () => manager.close(toast.id) },
  );
}
function ToastPositioner({
  toast,
  sideOffset = 0,
  ...props
}: PartProps<"div", object> & { toast: ToastObject; sideOffset?: number | undefined }) {
  const el = useRef<HTMLElement | null>(null);
  const [place, setPlace] = useState<ReturnType<typeof computePlacement> | null>(null);
  const setRef = useEvent((node: HTMLElement | null) => {
    el.current = node;
  });
  const anchor = toast.positionerProps?.anchor;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- places an anchored toast beside its anchor element.
  useLayoutEffect(() => {
    const node = el.current;
    if (!node || !anchor) return;
    const update = () =>
      setPlace(
        computePlacement(
          anchor.getBoundingClientRect(),
          { width: node.offsetWidth, height: node.offsetHeight },
          { width: window.innerWidth, height: window.innerHeight },
          {
            side: toast.positionerProps?.side ?? "top",
            align: toast.positionerProps?.align ?? "center",
            sideOffset: toast.positionerProps?.sideOffset ?? sideOffset,
            alignOffset: 0,
            padding: 5,
            flip: true,
            shift: true,
            rtl: false,
          },
        ),
      );
    update();
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [anchor, sideOffset, toast.positionerProps]);
  return renderPart(
    "div",
    props,
    {},
    {
      style: {
        position: "fixed",
        top: 0,
        left: 0,
        transform: `translate(${Math.round(place?.left ?? 0)}px, ${Math.round(place?.top ?? 0)}px)`,
        visibility: place ? undefined : "hidden",
        ...place?.vars,
      } as CSSProperties,
      "data-side": place?.side,
    },
    setRef,
  );
}

export const Toast = {
  Provider: ToastProvider,
  Portal: ToastPortal,
  Viewport: ToastViewport,
  Root: ToastRoot,
  Content: ToastContent,
  Title: ToastTitle,
  Description: ToastDescription,
  Action: ToastAction,
  Close: ToastClose,
  Positioner: ToastPositioner,
  createToastManager,
  useToastManager,
};
export declare namespace Toast {
  namespace Provider {
    type Props = ProviderProps;
  }
  namespace Root {
    type Props = Parameters<typeof ToastRoot>[0];
  }
}
