import {
  createContext,
  use,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { observeResize } from "~/lib/observeResize";
import {
  changeDetails,
  useEvent,
  renderPart,
  transitionAttrs,
  useControlled,
  useTransitionStatus,
  type ChangeEventDetails,
  type PartProps,
} from "./primitives";

type OpenChange = (open: boolean, details: ChangeEventDetails) => void;
type TransitionStatus = "starting" | "ending" | undefined;
type OpenType = "mouse" | "touch" | "pen" | "keyboard" | "";
export interface PopupActions {
  close: () => void;
  unmount: () => void;
  cancel: () => void;
}

// Dismissal stack: the topmost open popup handles Escape; a press outside a popup closes it and everything opened after it.
interface Layer {
  owner?: unknown;
  contains: (target: Node) => boolean;
  dismiss: (reason: "outside-press" | "escape-key", event: Event) => void;
  outside: () => boolean;
  escape: () => boolean;
}
const layers: Layer[] = [];
let listening = false;
// The last input modality, for popups opened without a trigger press.
let lastModality: "keyboard" | "pointer" = "pointer";
function listen() {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener("keydown", () => (lastModality = "keyboard"), true);
  document.addEventListener("pointerdown", () => (lastModality = "pointer"), true);
  document.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target as Node;
      let hit = -1;
      for (let i = layers.length - 1; i >= 0; i--) {
        if (layers[i]!.contains(target)) {
          hit = i;
          break;
        }
      }
      for (const layer of layers.slice(hit + 1).reverse())
        if (layer.outside()) layer.dismiss("outside-press", event);
    },
    true,
  );
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.isComposing) return;
    const top = layers.findLast((layer) => layer.escape());
    if (!top) return;
    top.dismiss("escape-key", event);
  });
}
function useLayer(active: boolean, layer: Layer) {
  const current = useRef(layer);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- dismissal handlers read the latest props.
  useLayoutEffect(() => {
    current.current = layer;
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the open popup with the document-level dismissal stack.
  useLayoutEffect(() => {
    if (!active) return;
    listen();
    const entry: Layer = {
      owner: current.current.owner,
      contains: (t) => current.current.contains(t),
      dismiss: (r, e) => current.current.dismiss(r, e),
      outside: () => current.current.outside(),
      escape: () => current.current.escape(),
    };
    layers.push(entry);
    return () => {
      layers.splice(layers.indexOf(entry), 1);
    };
  }, [active]);
}

/** Non-modal popups close when focus lands outside them and their trigger. */
function useFocusOut(active: boolean, api: PopupApi) {
  const latest = useRef(api);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the focus listener reads the latest popup.
  useLayoutEffect(() => {
    latest.current = api;
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- watches document focus while the popup is open.
  useLayoutEffect(() => {
    if (!active) return;
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Node;
      // Focus inside a popup opened over this one stays inside; popups opened before it are outside.
      const mine = layers.findIndex((layer) => layer.owner === latest.current.ids.popup);
      const inOverlay = layers.slice(mine + 1).some((layer) => layer.contains(target));
      const current = latest.current;
      if (isInsidePopupTree(current, target) || inOverlay) return;
      // Tab from the trigger continues into the portaled popup, as if it followed the trigger.
      const popup = current.popup.current;
      const from = event.relatedTarget as Node | null;
      if (
        popup &&
        from &&
        current.getTrigger()?.contains(from) &&
        target.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_PRECEDING
      ) {
        (tabbables(popup)[0] ?? popup).focus();
        return;
      }
      {
        current.setOpen(false, event, "focus-out");
      }
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [active]);
}

let scrollLocks = 0;
function lockScroll() {
  scrollLocks += 1;
  if (scrollLocks > 1) return;
  document.documentElement.dataset.scrollLocked = "";
  document.documentElement.style.overflow = "hidden";
}
function unlockScroll() {
  scrollLocks -= 1;
  if (scrollLocks > 0) return;
  delete document.documentElement.dataset.scrollLocked;
  document.documentElement.style.overflow = "";
}
function useScrollLock(active: boolean) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- locks page scroll while a modal popup is open.
  useLayoutEffect(() => {
    if (!active) return;
    lockScroll();
    return unlockScroll;
  }, [active]);
}

const TABBABLE =
  'a[href],button:not(:disabled),input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
const tabbables = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.getClientRects().length > 0);
const LIST_ITEM = '[role="option"],[role^="menuitem"]';
const ACTIVE_ITEM =
  '[role="option"][aria-selected="true"],[role="option"][data-selected],[role^="menuitem"][data-checked]';
/** Tab out of a list popup continues from its trigger, as if the popup sat right after it. */
function tabFromTrigger(api: PopupApi, event: KeyboardEvent) {
  const trigger = api.getTrigger();
  if (!trigger) return;
  const scope = trigger.closest<HTMLElement>('[aria-modal="true"]') ?? document.body;
  const items = tabbables(scope).filter((el) => !api.popup.current?.contains(el));
  const at = items.indexOf(trigger);
  const next = at === -1 ? trigger : items.at((at + (event.shiftKey ? -1 : 1)) % items.length);
  event.preventDefault();
  const target = next ?? trigger;
  target.focus();
  // Focus that left the popup tree already closed it ("focus-out").
  if (isInsidePopupTree(api, target)) api.setOpen(false, event, "focus-out");
}

// Handles: triggers rendered apart from their Root (`createHandle`).
export interface PopupHandle<P = unknown> {
  open: (triggerId?: string) => void;
  close: () => void;
  readonly isOpen: boolean;
  /** @internal */ store: HandleStore<P>;
}
interface HandleStore<P> {
  state: { open: boolean; triggerId: string | null; payload: P | undefined; reason: string };
  triggers: Map<string, { el: HTMLElement | null; payload: P | undefined }>;
  listeners: Set<() => void>;

  set: (patch: Partial<HandleStore<P>["state"]>) => void;
}
/** Each handle's mounted Root, so imperative opens reach its onOpenChange. */
const handleRoots = new WeakMap<object, PopupApi>();
function createHandle<P = unknown>(): PopupHandle<P> {
  const store: HandleStore<P> = {
    state: { open: false, triggerId: null, payload: undefined, reason: "none" },
    triggers: new Map(),
    listeners: new Set(),

    set(patch) {
      store.state = { ...store.state, ...patch };
      for (const listener of store.listeners) listener();
    },
  };
  return {
    store,
    open: (triggerId) => {
      const id = triggerId ?? store.triggers.keys().next().value ?? null;
      const root = handleRoots.get(store);
      if (root) root.setOpen(true, undefined, "imperative-action", id);
      else
        store.set({
          open: true,
          triggerId: id,
          payload: id ? store.triggers.get(id)?.payload : undefined,
          reason: "imperative-action",
        });
    },
    close: () => {
      const root = handleRoots.get(store);
      if (root) root.setOpen(false, undefined, "imperative-action");
      else store.set({ open: false, reason: "imperative-action" });
    },
    get isOpen() {
      return store.state.open;
    },
  };
}
const subscribeNoop = () => () => {};
const NO_HANDLE_STATE = { open: false, triggerId: null, payload: undefined, reason: "none" };

/** One popup's state shared by its parts. */
interface PopupApi {
  kind:
    | "dialog"
    | "alertdialog"
    | "popover"
    | "menu"
    | "tooltip"
    | "previewcard"
    | "select"
    | "combobox";
  open: boolean;
  mounted: boolean;
  status: TransitionStatus;
  setOpen: (
    open: boolean,
    event: Event | SyntheticEvent | undefined,
    reason: string,
    triggerId?: string | null,
  ) => (ChangeEventDetails & { propagationAllowed: boolean }) | undefined;
  openType: { current: OpenType };
  closeType: { current: OpenType };
  pointerDismissal: boolean;
  /** The active trigger element, looked up when needed (handle triggers register after the Root). */
  getTrigger: () => HTMLElement | null;
  popup: RefObject<HTMLElement | null>;
  positioner: { current: HTMLElement | null };
  ids: { popup: string; title: string; description: string };
  payload: unknown;
  activeTriggerId: string | null;
  handle: PopupHandle | undefined;
  modal: boolean;
  instant: boolean;
  parent: PopupApi | null;
  /** Children popups (submenus, nested dialogs) count toward "inside" for dismissal. */
  children: Set<PopupApi>;
  hover: HoverApi;
  setTrigger: (el: HTMLElement | null) => void;
  setOpenType: (type: OpenType) => void;
  setPositioner: (el: HTMLElement | null) => void;
  /** A combobox whose input sits inside its popup presents the popup as a dialog. */
  innerInput: boolean;
  setInnerInput: (inside: boolean) => void;
  labelled: { title: boolean; description: boolean };
  setLabelled: (part: "title" | "description", present: boolean) => void;
}
interface HoverApi {
  delay: number;
  closeDelay: number;
  enter: (event: SyntheticEvent, triggerId?: string | null) => void;
  leave: (event: SyntheticEvent) => void;
  cancel: () => void;
}
type Kind = PopupApi["kind"];
// One context per family, so a Menu trigger rendered inside a Tooltip still finds its Menu.
const contexts: Record<Kind, ReturnType<typeof createContext<PopupApi | null>>> = {
  dialog: createContext<PopupApi | null>(null),
  alertdialog: createContext<PopupApi | null>(null),
  popover: createContext<PopupApi | null>(null),
  menu: createContext<PopupApi | null>(null),
  tooltip: createContext<PopupApi | null>(null),
  previewcard: createContext<PopupApi | null>(null),
  select: createContext<PopupApi | null>(null),
  combobox: createContext<PopupApi | null>(null),
};
function usePopup(kind: Kind): PopupApi {
  const api = use(contexts[kind]);
  if (!api) throw new Error(`${kind} parts must render inside their Root`);
  return api;
}

interface RootProps<P = unknown> {
  open?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  onOpenChange?: OpenChange | undefined;
  onOpenChangeComplete?: ((open: boolean) => void) | undefined;
  actionsRef?: RefObject<PopupActions | null> | undefined;
  handle?: PopupHandle<P> | undefined;
  modal?: boolean | undefined;
  disabled?: boolean | undefined;
  delay?: number | undefined;
  closeDelay?: number | undefined;
  children?: ReactNode | ((state: { payload: P | undefined }) => ReactNode);
  triggerId?: string | null | undefined;
  defaultTriggerId?: string | null | undefined;
}

function usePopupRoot<P>(
  kind: PopupApi["kind"],
  props: RootProps<P>,
  defaults: { modal: boolean; delay: number; closeDelay: number },
): PopupApi {
  const {
    open: openProp,
    defaultOpen = false,
    onOpenChange,
    onOpenChangeComplete,
    actionsRef,
    handle,
    disabled = false,
  } = props;
  const modal = props.modal ?? defaults.modal;
  const handleState = useSyncExternalStore(
    handle
      ? (l) => (handle.store.listeners.add(l), () => handle.store.listeners.delete(l))
      : subscribeNoop,
    () => (handle ? handle.store.state : NO_HANDLE_STATE),
    () => NO_HANDLE_STATE,
  );
  const [own, setOwn] = useControlled(openProp, defaultOpen);
  const open = handle && openProp === undefined ? handleState.open : own;
  const activeTriggerId = props.triggerId ?? handleState.triggerId;
  const popup = useRef<HTMLElement | null>(null);
  const [forceUnmount, setForceUnmount] = useState(false);
  const { mounted, status } = useTransitionStatus(
    open && !forceUnmount,
    popup,
    onOpenChangeComplete,
  );
  const trigger = useRef<HTMLElement | null>(null);
  const positioner = useRef<HTMLElement | null>(null);
  const openType = useRef<OpenType>("");
  const closeType = useRef<OpenType>("");
  const [innerInput, setInnerInput] = useState(false);
  const [labelled, setLabelledState] = useState({ title: false, description: false });
  const [setLabelled] = useState(
    () => (part: "title" | "description", present: boolean) =>
      setLabelledState((prev) => (prev[part] === present ? prev : { ...prev, [part]: present })),
  );
  const [instant, setInstant] = useState(false);
  const parent = use(contexts[kind]);
  const [children] = useState(() => new Set<PopupApi>());
  const ids = { popup: useId(), title: useId(), description: useId() };
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const provider = use(TooltipProviderCtx);
  const delay =
    props.delay ?? (kind === "tooltip" ? (provider?.delay ?? defaults.delay) : defaults.delay);
  const closeDelay =
    props.closeDelay ??
    (kind === "tooltip" ? (provider?.closeDelay ?? defaults.closeDelay) : defaults.closeDelay);

  const setOpen = (
    next: boolean,
    event: Event | SyntheticEvent | undefined,
    reason: string,
    triggerId?: string | null,
  ) => {
    if (next && disabled) return undefined;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    if (
      next === open &&
      (!handle || triggerId === undefined || triggerId === handleState.triggerId)
    )
      return undefined;
    let propagationAllowed = false;
    const details = Object.assign(changeDetails(reason, event), {
      allowPropagation: () => {
        propagationAllowed = true;
      },
    });
    const result = Object.defineProperty(details, "propagationAllowed", {
      get: () => propagationAllowed,
    }) as ChangeEventDetails & { propagationAllowed: boolean };
    onOpenChange?.(next, details);
    if (details.isCanceled) return result;
    if (next) setForceUnmount(false);
    else {
      const native = details.event as Event & { pointerType?: string };
      closeType.current = native.type.startsWith("key")
        ? "keyboard"
        : native.pointerType
          ? (native.pointerType as OpenType)
          : native.type === "click" || native.type.startsWith("mouse")
            ? "mouse"
            : "";
    }
    if (handle) {
      const id = triggerId ?? handle.store.state.triggerId;
      handle.store.set({
        open: next,
        triggerId: id,
        payload: id ? handle.store.triggers.get(id)?.payload : undefined,
        reason,
      });
    }
    setOwn(next);
    if (!next) for (const child of children) child.setOpen(false, event, reason);
    return result;
  };
  const api: PopupApi = {
    kind,
    open,
    mounted,
    status,
    setOpen,
    openType,
    closeType,
    pointerDismissal: !(props as { disablePointerDismissal?: boolean }).disablePointerDismissal,
    getTrigger: () =>
      handle && activeTriggerId
        ? (handle.store.triggers.get(activeTriggerId)?.el ?? null)
        : trigger.current,
    popup,
    positioner,
    ids,
    payload: props.triggerId
      ? handle?.store.triggers.get(props.triggerId)?.payload
      : handleState.payload,
    activeTriggerId,
    handle: handle as PopupHandle | undefined,
    modal,
    instant,
    parent,
    children,
    setTrigger: (el) => {
      trigger.current = el;
    },
    setOpenType: (type) => {
      openType.current = type;
    },
    setPositioner: (el) => {
      positioner.current = el;
    },
    innerInput,
    setInnerInput,
    labelled,
    setLabelled,
    hover: {
      delay,
      closeDelay,
      enter: (event, triggerId) => {
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        const now = provider?.recentlyClosed() ?? false;
        setInstant(now);
        const go = () => setOpen(true, event, "trigger-hover", triggerId);
        if (open || now || delay <= 0) go();
        else hoverTimer.current = setTimeout(go, delay);
      },
      leave: (event) => {
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        hoverTimer.current = null;
        if (!open) return;
        const go = () => {
          provider?.markClosed();
          setOpen(false, event, "trigger-hover");
        };
        if (closeDelay <= 0) go();
        else hoverTimer.current = setTimeout(go, closeDelay);
      },
      cancel: () => {
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        hoverTimer.current = null;
      },
    },
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- exposes imperative close/unmount and links nested popups to their parent.
  useLayoutEffect(() => {
    if (handle) handleRoots.set(handle.store, api);
    if (actionsRef) {
      actionsRef.current = {
        close: () => setOpen(false, undefined, "imperative-action"),
        unmount: () => setForceUnmount(true),
        cancel: () => api.hover.cancel(),
      };
    }
    if (open && parent) {
      parent.children.add(api);
      return () => {
        parent.children.delete(api);
      };
    }
  });
  return api;
}

const isInsidePopupTree = (api: PopupApi, target: Node): boolean =>
  Boolean(
    api.popup.current?.contains(target) ||
    api.getTrigger()?.contains(target) ||
    api.positioner.current?.contains(target),
  ) || [...api.children].some((child) => isInsidePopupTree(child, target));

function RootView<P>({ api, children }: { api: PopupApi; children: RootProps<P>["children"] }) {
  const Ctx = contexts[api.kind];
  return (
    <Ctx value={api}>
      {typeof children === "function"
        ? children({ payload: api.payload as P | undefined })
        : children}
    </Ctx>
  );
}

type TriggerProps = PartProps<"button", { open: boolean; disabled: boolean }> & {
  handle?: PopupHandle<any> | undefined;
  payload?: unknown;
  nativeButton?: boolean | undefined;
  openOnHover?: boolean | undefined;
  delay?: number | undefined;
  closeDelay?: number | undefined;
};
function useTriggerProps(
  api: PopupApi,
  {
    id: idProp,
    payload,
    openOnHover = false,
    disabled = false,
  }: { id?: string | undefined; payload?: unknown; openOnHover?: boolean; disabled?: boolean },
  haspopup: string | undefined,
) {
  const generated = useId();
  const id = idProp ?? generated;
  const handle = api.handle;
  const ref = (el: HTMLElement | null) => {
    if (handle) {
      if (el) handle.store.triggers.set(id, { el, payload });
      else handle.store.triggers.delete(id);
    } else api.setTrigger(el);
  };
  const active = handle ? api.activeTriggerId === id && api.open : api.open;
  return {
    ref,
    active,
    props: {
      id,
      type: "button",
      disabled,
      "aria-haspopup": haspopup,
      "aria-expanded": active,
      "aria-controls": active ? api.ids.popup : undefined,
      ...(active ? { "data-popup-open": "" } : {}),
      ...(openOnHover
        ? {
            onPointerEnter: (event: SyntheticEvent) =>
              api.hover.enter(event, handle ? id : undefined),
            onPointerLeave: (event: SyntheticEvent) => api.hover.leave(event),
            // Keyboard focus opens a hover popover too, at once.
            onFocus: (event: SyntheticEvent<HTMLElement>) => {
              if (event.currentTarget.matches(":focus-visible"))
                api.setOpen(true, event, "trigger-focus", handle ? id : undefined);
            },
          }
        : {}),
      onPointerDown: (event: ReactPointerEvent) => {
        api.setOpenType((event.pointerType as OpenType) || "mouse");
      },
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") api.setOpenType("keyboard");
      },
      onClick: (event: MouseEvent) => {
        if (event.detail === 0) api.setOpenType("keyboard");
        if (handle && !active) api.setOpen(true, event, "trigger-press", id);
        else api.setOpen(!api.open, event, "trigger-press", handle ? id : undefined);
      },
    },
  };
}
function PopupTrigger({
  kind,
  handle: _h,
  payload,
  nativeButton: _n,
  openOnHover,
  delay: _d,
  closeDelay: _c,
  disabled,
  id,
  ...props
}: TriggerProps & { kind: Kind }) {
  const api = usePopup(kind);
  const haspopup =
    api.kind === "menu"
      ? "menu"
      : api.kind === "select"
        ? "listbox"
        : api.kind === "tooltip" || api.kind === "previewcard"
          ? undefined
          : "dialog";
  const trigger = useTriggerProps(
    api,
    { id, payload, openOnHover: openOnHover ?? false, disabled: disabled ?? false },
    haspopup,
  );
  return renderPart(
    "button",
    props,
    { open: trigger.active, disabled: Boolean(disabled) },
    trigger.props,
    trigger.ref,
  );
}
/** Triggers bound to a handle may render outside the Root. */
function HandleTrigger(props: TriggerProps & { kind: Kind }) {
  const api = use(contexts[props.kind]);
  if (api || !props.handle) return <PopupTrigger {...props} />;
  return <DetachedTrigger {...props} handle={props.handle as PopupHandle} />;
}
function DetachedTrigger({
  kind: _kind,
  handle,
  payload,
  nativeButton: _n,
  openOnHover: _o,
  delay: _d,
  closeDelay: _c,
  id: idProp,
  disabled,
  ...props
}: TriggerProps & { kind: Kind; handle: PopupHandle }) {
  const generated = useId();
  const id = idProp ?? generated;
  const state = useSyncExternalStore(
    (l) => (handle.store.listeners.add(l), () => handle.store.listeners.delete(l)),
    () => handle.store.state,
    () => NO_HANDLE_STATE,
  );
  const active = state.open && state.triggerId === id;
  return renderPart(
    "button",
    props,
    { open: active, disabled: Boolean(disabled) },
    {
      id,
      type: "button",
      disabled,
      "aria-haspopup": "dialog",
      "aria-expanded": active,
      ...(active ? { "data-popup-open": "" } : {}),
      onClick: () => (active ? handle.close() : handle.open(id)),
    },
    (el: HTMLElement | null) => {
      if (el) handle.store.triggers.set(id, { el, payload });
      else handle.store.triggers.delete(id);
    },
  );
}

type PortalProps = {
  children?: ReactNode;
  keepMounted?: boolean | undefined;
  container?: HTMLElement | null | undefined;
  className?: string;
};
function PopupPortal({
  kind,
  children,
  keepMounted = false,
  container,
}: PortalProps & { kind: Kind }) {
  const api = usePopup(kind);
  if (!api.mounted && !keepMounted) return null;
  if (typeof document === "undefined") return null;
  return createPortal(children, container ?? document.body);
}

type Side = "top" | "bottom" | "left" | "right" | "inline-start" | "inline-end";
type Align = "start" | "center" | "end";
type Padding = number | Partial<Record<"top" | "right" | "bottom" | "left", number>>;
type Anchor =
  | Element
  | null
  | RefObject<Element | null>
  | { getBoundingClientRect: () => DOMRect }
  | (() => Element | { getBoundingClientRect: () => DOMRect } | null);
export interface PositionerProps extends PartProps<
  "div",
  { open: boolean; side: string; align: string; anchorHidden: boolean }
> {
  side?: Side | undefined;
  align?: Align | undefined;
  sideOffset?: number | undefined;
  alignOffset?: number | undefined;
  collisionPadding?: Padding | undefined;
  collisionAvoidance?:
    | {
        side?: "flip" | "none" | "shift";
        align?: "flip" | "shift" | "none";
        fallbackAxisSide?: string;
      }
    | undefined;
  anchor?: Anchor | undefined;
  positionMethod?: "absolute" | "fixed" | undefined;
  sticky?: boolean | undefined;
  arrowPadding?: number | undefined;
  trackAnchor?: boolean | undefined;
  alignItemWithTrigger?: boolean | undefined;
  disableAnchorTracking?: boolean | undefined;
}
const resolveAnchor = (
  anchor: Anchor | undefined,
  fallback: HTMLElement | null,
): { getBoundingClientRect: () => DOMRect } | null => {
  if (anchor === undefined || anchor === null) return fallback;
  if (typeof anchor === "function") return anchor();
  if ("current" in anchor) return anchor.current;
  return anchor;
};
interface Placement {
  top: number;
  left: number;
  side: "top" | "bottom" | "left" | "right";
  align: Align;
  vars: Record<string, string>;
}
/** Places `floating` beside `anchor`: flips across the side when it doesn't fit, shifts along the edge to stay in view. */
export function computePlacement(
  anchorRect: DOMRect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  opts: {
    side: Side;
    align: Align;
    sideOffset: number;
    alignOffset: number;
    padding: Padding;
    flip: boolean;
    shift: boolean;
    rtl: boolean;
    mainShift?: boolean;
    alignFlip?: boolean;
    fallbackAxisSide?: "start" | "end" | undefined;
  },
): Placement {
  const pad =
    typeof opts.padding === "number"
      ? { top: opts.padding, right: opts.padding, bottom: opts.padding, left: opts.padding }
      : { top: 5, right: 5, bottom: 5, left: 5, ...opts.padding };
  const physical = (s: Side): Placement["side"] =>
    s === "inline-start"
      ? opts.rtl
        ? "right"
        : "left"
      : s === "inline-end"
        ? opts.rtl
          ? "left"
          : "right"
        : s;
  let side = physical(opts.side);
  const space = {
    top: anchorRect.top - pad.top - opts.sideOffset,
    bottom: viewport.height - anchorRect.bottom - pad.bottom - opts.sideOffset,
    left: anchorRect.left - pad.left - opts.sideOffset,
    right: viewport.width - anchorRect.right - pad.right - opts.sideOffset,
  };
  const opposite = { top: "bottom", bottom: "top", left: "right", right: "left" } as const;
  const fits = (s: Placement["side"]) =>
    space[s] >= (s === "top" || s === "bottom" ? size.height : size.width);
  if (opts.flip && !fits(side)) {
    const flipped = opposite[side];
    // Neither side fits: try the perpendicular axis before settling for the roomier side.
    const fallback = !opts.fallbackAxisSide
      ? null
      : side === "top" || side === "bottom"
        ? physical(opts.fallbackAxisSide === "end" ? "inline-end" : "inline-start")
        : opts.fallbackAxisSide === "end"
          ? "bottom"
          : "top";
    side = fits(flipped)
      ? flipped
      : fallback && fits(fallback)
        ? fallback
        : space[flipped] > space[side]
          ? flipped
          : side;
  }
  const vertical = side === "top" || side === "bottom";
  const crossPos = (a: Align) => {
    const [anchorStart, anchorLength, length] = vertical
      ? [anchorRect.left, anchorRect.width, size.width]
      : [anchorRect.top, anchorRect.height, size.height];
    // Inline alignment follows the reading direction.
    const start = vertical && opts.rtl ? a === "end" : a === "start";
    return a === "center"
      ? anchorStart + (anchorLength - length) / 2 + opts.alignOffset
      : start
        ? anchorStart + opts.alignOffset
        : anchorStart + anchorLength - length - opts.alignOffset;
  };
  const [min, max] = vertical
    ? [pad.left, viewport.width - pad.right - size.width]
    : [pad.top, viewport.height - pad.bottom - size.height];
  const overflow = (pos: number) => Math.max(0, min - pos) + Math.max(0, pos - max);
  let align = opts.align;
  let cross = crossPos(align);
  if (opts.alignFlip && align !== "center" && overflow(cross) > 0) {
    const flipped = align === "start" ? "end" : "start";
    if (overflow(crossPos(flipped)) < overflow(cross)) cross = crossPos((align = flipped));
  }
  if (opts.shift) cross = Math.min(Math.max(cross, min), max);
  let top = vertical
    ? side === "bottom"
      ? anchorRect.bottom + opts.sideOffset
      : anchorRect.top - opts.sideOffset - size.height
    : cross;
  let left = vertical
    ? cross
    : side === "right"
      ? anchorRect.right + opts.sideOffset
      : anchorRect.left - opts.sideOffset - size.width;
  // "shift" on the side axis slides the popup over its anchor instead of off screen.
  if (opts.mainShift) {
    if (vertical)
      top = Math.min(Math.max(top, pad.top), viewport.height - pad.bottom - size.height);
    else left = Math.min(Math.max(left, pad.left), viewport.width - pad.right - size.width);
  }
  const availableHeight =
    opts.mainShift && vertical
      ? viewport.height - pad.top - pad.bottom
      : vertical
        ? Math.max(
            0,
            side === "bottom"
              ? viewport.height - anchorRect.bottom - opts.sideOffset - pad.bottom
              : anchorRect.top - opts.sideOffset - pad.top,
          )
        : viewport.height - pad.top - pad.bottom;
  const availableWidth = vertical
    ? viewport.width - pad.left - pad.right
    : Math.max(
        0,
        side === "right"
          ? viewport.width - anchorRect.right - opts.sideOffset - pad.right
          : anchorRect.left - opts.sideOffset - pad.left,
      );
  const originX = vertical
    ? `${anchorRect.left + anchorRect.width / 2 - left}px`
    : side === "right"
      ? "0px"
      : `${size.width}px`;
  const originY = vertical
    ? side === "bottom"
      ? "0px"
      : `${size.height}px`
    : `${anchorRect.top + anchorRect.height / 2 - top}px`;
  return {
    top,
    left,
    side,
    align,
    vars: {
      "--anchor-width": `${anchorRect.width}px`,
      "--anchor-height": `${anchorRect.height}px`,
      "--available-width": `${availableWidth}px`,
      "--available-height": `${availableHeight}px`,
      "--transform-origin": `${originX} ${originY}`,
    },
  };
}

type ItemPlacement = Placement & { itemAligned?: true };
/** `el`'s layout offset inside `root`, unaffected by the popup's enter transform. */
function offsetIn(el: HTMLElement, root: HTMLElement) {
  let x = 0;
  let y = 0;
  for (let n: HTMLElement | null = el; n && n !== root; n = n.offsetParent as HTMLElement | null) {
    x += n.offsetLeft;
    y += n.offsetTop;
  }
  return { x, y };
}
/**
 * Base UI's `alignItemWithTrigger`: lays the selected item's text over the trigger's value,
 * scrolling the list when the viewport clips it. Null when the trigger sits too near an edge.
 */
function alignItem(
  positioner: HTMLElement,
  trigger: Element,
  rect: DOMRect,
  size: { width: number; height: number },
  rtl: boolean,
) {
  const option =
    positioner.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ??
    positioner.querySelector<HTMLElement>('[role="option"]');
  const text = option?.querySelector<HTMLElement>("[data-select-item-text]") ?? option;
  const value = trigger.querySelector("[data-select-value]")?.getBoundingClientRect();
  const list = positioner.querySelector<HTMLElement>("[data-list-root]");
  const margin = 10;
  const vh = window.innerHeight;
  const t = text ? offsetIn(text, positioner) : { x: 0, y: 0 };
  const textCenter = t.y + (text?.offsetHeight ?? 0) / 2;
  const offsetY = text && value ? textCenter - (value.top - rect.top + value.height / 2) : 0;
  const idealTop = rect.top - offsetY;
  const top = Math.max(margin, idealTop);
  const height = Math.min(vh - margin, idealTop + size.height) - top;
  if (
    rect.top < 20 ||
    rect.bottom > vh - 20 ||
    height + 1 < Math.min(size.height, 100) ||
    (!list && height < size.height)
  )
    return null;
  const left =
    text && value
      ? rtl
        ? value.right - t.x - text.offsetWidth
        : value.left - t.x
      : rtl
        ? rect.right - size.width
        : rect.left;
  return {
    top,
    left: Math.min(Math.max(left, 5), window.innerWidth - 5 - size.width),
    scrollTop: top - idealTop,
    listHeight: height - (size.height - (list?.offsetHeight ?? size.height)),
    originY: textCenter - (top - idealTop),
  };
}

function PopupPositioner({
  kind,
  side: sideProp,
  align = "center",
  sideOffset = 0,
  alignOffset = 0,
  collisionPadding = 5,
  collisionAvoidance,
  anchor,
  positionMethod: _p,
  sticky: _s,
  arrowPadding: _a,
  trackAnchor: _t,
  alignItemWithTrigger = true,
  disableAnchorTracking: _d,
  ...props
}: PositionerProps & { kind: Kind }) {
  const api = usePopup(kind);
  const side =
    sideProp ?? (api.parent?.kind === "menu" && api.kind === "menu" ? "inline-end" : "bottom");
  const [placement, setPlacement] = useState<ItemPlacement | null>(null);
  const el = useRef<HTMLElement | null>(null);
  // An item-aligned select's trigger rect and the list scroll still to apply.
  const aligned = useRef<{ rect: DOMRect; scrollTop: number | null } | null>(null);
  const setRef = useEvent((node: HTMLElement | null) => {
    el.current = node;
    api.setPositioner(node);
  });
  const getTarget = useEvent(() => resolveAnchor(anchor, api.getTrigger()));
  const update = useEvent(() => {
    const positioner = el.current;
    const target = getTarget();
    if (!positioner || !target) return;
    const rect = target.getBoundingClientRect();
    if (aligned.current) {
      // Follow the trigger without re-fitting, so the list keeps the scroll the alignment chose.
      const dx = rect.left - aligned.current.rect.left;
      const dy = rect.top - aligned.current.rect.top;
      aligned.current.rect = rect;
      if (dx || dy) setPlacement((p) => p && { ...p, left: p.left + dx, top: p.top + dy });
      return;
    }
    // Measure the natural size: a height already capped by --available-height would make flipping oscillate.
    const saved = positioner.style.cssText;
    positioner.style.setProperty("--available-height", "100000px");
    positioner.style.setProperty("--available-width", "100000px");
    const size = { width: positioner.offsetWidth, height: positioner.offsetHeight };
    const rtl = getComputedStyle(positioner).direction === "rtl";
    const item =
      api.kind === "select" &&
      alignItemWithTrigger &&
      api.openType.current !== "touch" &&
      target instanceof Element
        ? alignItem(positioner, target, rect, size, rtl)
        : null;
    positioner.style.cssText = saved;
    const next = computePlacement(
      rect,
      size,
      { width: window.innerWidth, height: window.innerHeight },
      {
        side,
        align,
        sideOffset,
        alignOffset,
        padding: collisionPadding,
        flip: collisionAvoidance?.side !== "none" && collisionAvoidance?.side !== "shift",
        mainShift: collisionAvoidance?.side === "shift",
        shift: collisionAvoidance?.align !== "none",
        alignFlip: collisionAvoidance?.align === undefined || collisionAvoidance.align === "flip",
        fallbackAxisSide:
          collisionAvoidance?.fallbackAxisSide === "start" ||
          collisionAvoidance?.fallbackAxisSide === "end"
            ? collisionAvoidance.fallbackAxisSide
            : undefined,
        rtl,
      },
    );
    if (item) {
      aligned.current = { rect, scrollTop: item.scrollTop };
      setPlacement({
        ...next,
        top: item.top,
        left: item.left,
        itemAligned: true,
        vars: {
          ...next.vars,
          "--available-height": `${item.listHeight}px`,
          "--transform-origin": `50% ${item.originY}px`,
        },
      });
      return;
    }
    setPlacement((prev) =>
      prev &&
      prev.top === next.top &&
      prev.left === next.left &&
      prev.side === next.side &&
      prev.align === next.align &&
      JSON.stringify(prev.vars) === JSON.stringify(next.vars)
        ? prev
        : next,
    );
  });
  // Inline option objects must not re-subscribe on every render.
  const optionsKey = JSON.stringify([
    side,
    align,
    sideOffset,
    alignOffset,
    collisionPadding,
    collisionAvoidance,
  ]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- positions the popup against its anchor as layout, scroll, and size change.
  useLayoutEffect(() => {
    if (!api.mounted) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    const target = getTarget();
    const observed = [el.current, target instanceof Element ? target : null].filter(
      (node): node is Element => node !== null,
    );
    const stopObserving = observeResize(observed, update);
    return () => {
      aligned.current = null;
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      stopObserving();
    };
  }, [
    api.mounted,
    update,
    getTarget,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- update reads the latest props; a new anchor or option re-places and re-observes.
    anchor,
    optionsKey,
  ]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the item-aligned list once its height cap has rendered.
  useLayoutEffect(() => {
    const pending = aligned.current;
    if (pending?.scrollTop == null || !placement?.itemAligned) return;
    const list = el.current?.querySelector<HTMLElement>("[data-list-root]");
    if (list) list.scrollTop = pending.scrollTop;
    pending.scrollTop = null;
  });
  const state = {
    open: api.open,
    side: placement?.itemAligned ? "none" : (placement?.side ?? side),
    align: placement?.align ?? align,
    anchorHidden: false,
  };
  const style = {
    // Translate rather than top/left: a fixed element's shrink-to-fit width depends on its left.
    position: "fixed",
    top: 0,
    left: 0,
    transform: `translate(${Math.round(placement?.left ?? 0)}px, ${Math.round(placement?.top ?? 0)}px)`,
    ...(placement ? placement.vars : {}),
  } as CSSProperties;
  return renderPart(
    "div",
    props,
    state,
    {
      role: "presentation",
      style,
      "data-side": state.side,
      "data-align": state.align,
      ...(api.open ? { "data-open": "" } : { "data-closed": "" }),
      ...(api.instant ? { "data-instant": "" } : {}),
      hidden: !api.mounted || undefined,
    },
    setRef,
  );
}

type InitialFocus =
  | boolean
  | RefObject<HTMLElement | null>
  | ((openType: OpenType) => HTMLElement | boolean | null | undefined | void);
type PopupPartProps = PartProps<
  "div",
  {
    open: boolean;
    transitionStatus: TransitionStatus;
    nested: boolean;
    side?: string;
    instant?: boolean;
  }
> & {
  initialFocus?: InitialFocus | undefined;
  finalFocus?:
    | boolean
    | RefObject<HTMLElement | null>
    | ((closeType: OpenType) => HTMLElement | boolean | null | undefined | void)
    | undefined;
};
function resolveFocus(
  target: InitialFocus | undefined,
  openType: OpenType,
  popup: HTMLElement,
  fallback: () => HTMLElement | null,
) {
  const value = typeof target === "function" ? target(openType) : target;
  if (value === false || value === null) return null;
  if (value === true || value === undefined) return fallback();
  if (value instanceof HTMLElement) return value;
  if (typeof value === "object" && "current" in value) return value.current;
  return popup;
}
function usePopupFocus(
  api: PopupApi,
  initialFocus: InitialFocus | undefined,
  finalFocus: PopupPartProps["finalFocus"],
  fallback: (popup: HTMLElement) => HTMLElement | null,
) {
  const returnTo = useRef<HTMLElement | null>(null);
  const latest = useRef({ api, initialFocus, finalFocus, fallback });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the focus effect reads the latest props without re-running.
  useLayoutEffect(() => {
    latest.current = { api, initialFocus, finalFocus, fallback };
  });
  const open = api.open;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves focus into the popup on open and back to the trigger on close.
  useLayoutEffect(() => {
    listen();
    const { api, initialFocus, finalFocus, fallback } = latest.current;
    const popup = api.popup.current;
    if (!open || !popup) return;
    returnTo.current = (document.activeElement as HTMLElement | null) ?? null;
    // Like Base UI, move focus in on the next frame, once the popup is laid out.
    const frame = requestAnimationFrame(() => {
      const now = document.activeElement;
      const isDialog = api.kind === "dialog" || api.kind === "alertdialog";
      // Focus already inside (autoFocus) stays; a non-modal popup also leaves focus the user moved elsewhere.
      const settled =
        (now && now !== popup && popup.contains(now)) ||
        (!(isDialog && api.modal) &&
          now &&
          now !== document.body &&
          now !== returnTo.current &&
          !popup.contains(now));
      if (!settled)
        resolveFocus(initialFocus, api.openType.current, popup, () => fallback(popup))?.focus({
          preventScroll: true,
        });
      // Lists open scrolled to their selected or active item, whatever the pointer modality.
      if (!isDialog && api.kind !== "tooltip" && api.kind !== "previewcard") {
        const active = document.activeElement;
        (active instanceof HTMLElement && popup.contains(active) && active.matches(LIST_ITEM)
          ? active
          : popup.querySelector(ACTIVE_ITEM)
        )?.scrollIntoView({ block: "nearest" });
      }
    });
    const keyboard =
      api.openType.current === "keyboard" ||
      (api.openType.current === "" && lastModality === "keyboard");
    return () => {
      cancelAnimationFrame(frame);
      const value =
        typeof finalFocus === "function" ? finalFocus(api.closeType.current) : finalFocus;
      if (value === false || value === null) return;
      const back =
        value && typeof value === "object" && "current" in value
          ? value.current
          : value instanceof HTMLElement
            ? value
            : (api.getTrigger() ?? returnTo.current);
      // Only reclaim focus that was inside the popup (or lost to the body).
      const active = document.activeElement;
      // Pointer-opened popups hand focus back without a focus ring. After the commit, so React's
      // focus restoration for the closing render cannot undo it.
      if (!active || active === document.body || popup.contains(active)) {
        queueMicrotask(() =>
          back?.focus({ preventScroll: true, focusVisible: keyboard } as FocusOptions),
        );
      }
    };
  }, [open]);
}

function PopupView({
  kind: family,
  initialFocus,
  finalFocus,
  role,
  ...props
}: PopupPartProps & { kind: Kind; role?: string | undefined }) {
  const api = usePopup(family);
  const kind = api.kind;
  const nestedOpen = [...api.children].filter((c) => c.open).length;
  const isDialog = kind === "dialog" || kind === "alertdialog";
  // Tooltips and preview cards never move focus, in or back out.
  const passive = kind === "tooltip" || kind === "previewcard";
  usePopupFocus(
    api,
    initialFocus ?? (passive ? false : undefined),
    finalFocus ?? (passive ? false : undefined),
    (popup) =>
      kind === "combobox"
        ? popup.querySelector<HTMLElement>("input")
        : kind === "select"
          ? (popup.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ??
            popup.querySelector<HTMLElement>('[role="option"]:not([data-disabled])') ??
            popup)
          : kind === "menu"
            ? ((api.openType.current === "keyboard"
                ? popup.querySelector<HTMLElement>('[role^="menuitem"]:not([data-disabled])')
                : null) ?? popup)
            : (tabbables(popup)[0] ?? popup),
  );
  useLayer(api.open, {
    owner: api.ids.popup,
    contains: (target) => isInsidePopupTree(api, target),
    dismiss: (reason, event) => {
      const details = api.setOpen(false, event, reason);
      if (reason !== "escape-key" || !details) return;
      if (!details.isCanceled) event.preventDefault();
      if (!details.propagationAllowed) event.stopPropagation();
    },
    outside: () => api.pointerDismissal && kind !== "alertdialog" && kind !== "tooltip",
    escape: () => true,
  });
  useScrollLock(api.open && isDialog && api.modal);
  useFocusOut(
    api.open && (kind === "popover" || kind === "menu" || kind === "select" || kind === "combobox"),
    api,
  );
  const state = {
    open: api.open,
    transitionStatus: api.status,
    nested: Boolean(api.parent && isDialog),
    instant: api.instant,
  };
  return renderPart(
    "div",
    props,
    state,
    {
      id: api.ids.popup,
      role:
        role ??
        (kind === "menu"
          ? "menu"
          : kind === "tooltip"
            ? "tooltip"
            : kind === "alertdialog"
              ? "alertdialog"
              : kind === "select" || (kind === "combobox" && !api.innerInput)
                ? "presentation"
                : "dialog"),
      tabIndex: -1,
      "aria-modal": isDialog && api.modal ? true : undefined,
      "aria-labelledby": api.labelled.title ? api.ids.title : undefined,
      "aria-describedby": api.labelled.description ? api.ids.description : undefined,
      hidden: !api.mounted || undefined,
      style: { "--nested-dialogs": nestedOpen } as CSSProperties,
      ...(api.open ? { "data-open": "" } : { "data-closed": "" }),
      ...(state.nested ? { "data-nested": "" } : {}),
      ...(nestedOpen > 0 ? { "data-nested-dialog-open": "" } : {}),
      ...(api.instant ? { "data-instant": "" } : {}),
      ...transitionAttrs(api.status),
      ...(kind === "previewcard" || (kind === "popover" && api.hover.delay >= 0)
        ? {
            onPointerEnter: () => api.hover.cancel(),
            onPointerLeave: (event: SyntheticEvent) =>
              kind === "previewcard" ? api.hover.leave(event) : undefined,
          }
        : {}),
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        // Modal dialogs keep Tab inside.
        // A nested popup's Tab (bubbled through the React tree) already moved focus.
        if (!isDialog || !api.modal || event.key !== "Tab" || event.defaultPrevented) return;
        const items = tabbables(event.currentTarget);
        if (items.length === 0) {
          event.preventDefault();
          return;
        }
        const first = items[0]!;
        const last = items.at(-1)!;
        // From the popup itself, Tab enters at either end.
        if (document.activeElement === event.currentTarget) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      },
    },
    api.popup as Ref<HTMLElement>,
  );
}

type BackdropProps = PartProps<"div", { open: boolean; transitionStatus: TransitionStatus }> & {
  forceRender?: boolean | undefined;
};
function PopupBackdrop({ kind, forceRender = false, ...props }: BackdropProps & { kind: Kind }) {
  const api = usePopup(kind);
  if (
    !api.mounted ||
    (api.parent && !forceRender && (api.kind === "dialog" || api.kind === "alertdialog"))
  )
    return null;
  return renderPart(
    "div",
    props,
    { open: api.open, transitionStatus: api.status },
    {
      role: "presentation",
      ...(api.open ? { "data-open": "" } : { "data-closed": "" }),
      ...transitionAttrs(api.status),
    },
  );
}
type ViewportProps = PartProps<"div", { open: boolean; transitionStatus: TransitionStatus }>;
function PopupViewport({ kind, ...props }: ViewportProps & { kind: Kind }) {
  const api = usePopup(kind);
  return renderPart(
    "div",
    props,
    { open: api.open, transitionStatus: api.status },
    {
      role: "presentation",
      // A kept-mounted closed popup stays in the DOM but must not catch the pointer.
      hidden: !api.mounted || undefined,
      ...(api.open ? { "data-open": "" } : { "data-closed": "" }),
      ...transitionAttrs(api.status),
    },
  );
}
function useLabelPart(setLabelled: PopupApi["setLabelled"], part: "title" | "description") {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the popup which labelling parts are mounted.
  useLayoutEffect(() => {
    setLabelled(part, true);
    return () => setLabelled(part, false);
  }, [setLabelled, part]);
}
function PopupTitle({ kind, ...props }: PartProps<"h2", object> & { kind: Kind }) {
  const api = usePopup(kind);
  useLabelPart(api.setLabelled, "title");
  return renderPart("h2", props, {}, { id: api.ids.title });
}
function PopupDescription({ kind, ...props }: PartProps<"p", object> & { kind: Kind }) {
  const api = usePopup(kind);
  useLabelPart(api.setLabelled, "description");
  return renderPart("p", props, {}, { id: api.ids.description });
}
type CloseProps = PartProps<"button", object> & { nativeButton?: boolean | undefined };
function PopupClose({ kind, nativeButton: _n, ...props }: CloseProps & { kind: Kind }) {
  const api = usePopup(kind);
  return renderPart(
    "button",
    props,
    {},
    {
      type: "button",
      onClick: (event: SyntheticEvent) => api.setOpen(false, event, "close-press"),
    },
  );
}

/** The shared parts bound to one family's context. */
function partsFor(kind: Kind) {
  return {
    Trigger: (props: TriggerProps) => <HandleTrigger kind={kind} {...props} />,
    Portal: (props: PortalProps) => <PopupPortal kind={kind} {...props} />,
    Positioner: (props: PositionerProps) => <PopupPositioner kind={kind} {...props} />,
    Popup: (props: PopupPartProps) => <PopupView kind={kind} {...props} />,
    Backdrop: (props: BackdropProps) => <PopupBackdrop kind={kind} {...props} />,
    Viewport: (props: ViewportProps) => <PopupViewport kind={kind} {...props} />,
    Title: (props: PartProps<"h2", object>) => <PopupTitle kind={kind} {...props} />,
    Description: (props: PartProps<"p", object>) => <PopupDescription kind={kind} {...props} />,
    Close: (props: CloseProps) => <PopupClose kind={kind} {...props} />,
  };
}

type DialogRootProps<P = unknown> = RootProps<P> & {
  dismissible?: boolean | undefined;
  disablePointerDismissal?: boolean | undefined;
};
function DialogRoot<P>({ children, ...props }: DialogRootProps<P>) {
  const api = usePopupRoot<P>("dialog", props, { modal: true, delay: 0, closeDelay: 0 });
  return <RootView api={api}>{children}</RootView>;
}
function AlertDialogRoot<P>({ children, ...props }: DialogRootProps<P>) {
  const api = usePopupRoot<P>("alertdialog", props, { modal: true, delay: 0, closeDelay: 0 });
  return <RootView api={api}>{children}</RootView>;
}
const { Positioner: _dp, ...dialogParts } = partsFor("dialog");
const { Positioner: _ap, ...alertParts } = partsFor("alertdialog");
export const Dialog = { Root: DialogRoot, ...dialogParts, createHandle };
export const AlertDialog = { Root: AlertDialogRoot, ...alertParts, createHandle };
export declare namespace Dialog {
  namespace Root {
    type Props<P = unknown> = DialogRootProps<P>;
    type Actions = PopupActions;
  }
  namespace Trigger {
    type Props = TriggerProps;
  }
  namespace Portal {
    type Props = PortalProps;
  }
  namespace Backdrop {
    type Props = BackdropProps;
  }
  namespace Viewport {
    type Props = ViewportProps;
  }
  namespace Popup {
    type Props = PopupPartProps;
  }
  namespace Title {
    type Props = PartProps<"h2", object>;
  }
  namespace Description {
    type Props = PartProps<"p", object>;
  }
  namespace Close {
    type Props = CloseProps;
  }
}
export declare namespace AlertDialog {
  namespace Root {
    type Props<P = unknown> = DialogRootProps<P>;
  }
  namespace Trigger {
    type Props = TriggerProps;
  }
  namespace Portal {
    type Props = PortalProps;
  }
  namespace Backdrop {
    type Props = BackdropProps;
  }
  namespace Viewport {
    type Props = ViewportProps;
  }
  namespace Popup {
    type Props = PopupPartProps;
  }
  namespace Title {
    type Props = PartProps<"h2", object>;
  }
  namespace Description {
    type Props = PartProps<"p", object>;
  }
  namespace Close {
    type Props = CloseProps;
  }
}

type PopoverRootProps<P = unknown> = RootProps<P> & { openOnHover?: boolean | undefined };
function PopoverRoot<P>({ children, openOnHover: _o, ...props }: PopoverRootProps<P>) {
  const api = usePopupRoot<P>("popover", props, { modal: false, delay: 300, closeDelay: 0 });
  return <RootView api={api}>{children}</RootView>;
}
export const Popover = { Root: PopoverRoot, ...partsFor("popover"), createHandle };
export declare namespace Popover {
  namespace Root {
    type Props<P = unknown> = PopoverRootProps<P>;
    type Actions = PopupActions;
  }
  namespace Trigger {
    type Props = TriggerProps;
  }
  namespace Portal {
    type Props = PortalProps;
  }
  namespace Positioner {
    type Props = PositionerProps;
  }
  namespace Popup {
    type Props = PopupPartProps;
  }
  namespace Title {
    type Props = PartProps<"h2", object>;
  }
  namespace Close {
    type Props = CloseProps;
  }
}

function PreviewCardRoot<P>({ children, ...props }: RootProps<P>) {
  const api = usePopupRoot<P>("previewcard", props, { modal: false, delay: 600, closeDelay: 300 });
  return <RootView api={api}>{children}</RootView>;
}
function PreviewCardTrigger({
  delay: _d,
  closeDelay: _c,
  ...props
}: PartProps<"a", { open: boolean }> & {
  delay?: number | undefined;
  closeDelay?: number | undefined;
}) {
  const api = usePopup("previewcard");
  return renderPart(
    "a",
    props,
    { open: api.open },
    {
      ...(api.open ? { "data-popup-open": "" } : {}),
      onPointerEnter: (event: SyntheticEvent) => api.hover.enter(event),
      onPointerLeave: (event: SyntheticEvent) => api.hover.leave(event),
      onFocus: (event: SyntheticEvent) => api.setOpen(true, event, "trigger-focus"),
      onBlur: (event: SyntheticEvent) => api.hover.leave(event),
    },
    (el: HTMLElement | null) => {
      api.setTrigger(el);
    },
  );
}
const previewParts = partsFor("previewcard");
export const PreviewCard = {
  Root: PreviewCardRoot,
  Trigger: PreviewCardTrigger,
  Portal: previewParts.Portal,
  Positioner: previewParts.Positioner,
  Popup: previewParts.Popup,
  Backdrop: previewParts.Backdrop,
};
export declare namespace PreviewCard {
  namespace Root {
    type Props<P = unknown> = RootProps<P>;
    type Actions = PopupActions;
  }
  namespace Trigger {
    type Props = Parameters<typeof PreviewCardTrigger>[0];
  }
  namespace Positioner {
    type Props = PositionerProps;
  }
  namespace Popup {
    type Props = PopupPartProps;
  }
}

const TooltipProviderCtx = createContext<{
  delay?: number | undefined;
  closeDelay?: number | undefined;
  recentlyClosed: () => boolean;
  markClosed: () => void;
} | null>(null);
function TooltipProvider({
  delay,
  closeDelay,
  timeout = 400,
  children,
}: {
  delay?: number | undefined;
  closeDelay?: number | undefined;
  timeout?: number | undefined;
  children?: ReactNode;
}) {
  const closedAt = useRef(-Infinity);
  return (
    <TooltipProviderCtx
      value={{
        delay,
        closeDelay,
        recentlyClosed: () => performance.now() - closedAt.current < timeout,
        markClosed: () => {
          closedAt.current = performance.now();
        },
      }}
    >
      {children}
    </TooltipProviderCtx>
  );
}
type TooltipRootProps<P = unknown> = RootProps<P> & {
  hoverable?: boolean | undefined;
  trackCursorAxis?: string | undefined;
};
function TooltipRoot<P>({
  children,
  hoverable: _h,
  trackCursorAxis: _t,
  ...props
}: TooltipRootProps<P>) {
  const api = usePopupRoot<P>("tooltip", props, { modal: false, delay: 600, closeDelay: 0 });
  return <RootView api={api}>{children}</RootView>;
}
function TooltipTrigger({
  delay: _d,
  closeDelay: _c,
  handle: _h,
  payload: _p,
  ...props
}: PartProps<"button", { open: boolean }> & {
  delay?: number | undefined;
  closeDelay?: number | undefined;
  handle?: unknown;
  payload?: unknown;
}) {
  const api = usePopup("tooltip");
  const pressed = useRef(false);
  const onPointerEnter = useEvent((event: ReactPointerEvent) => {
    if (event.pointerType === "touch" || pressed.current) return;
    api.hover.enter(event);
  });
  const onPointerLeave = useEvent((event: SyntheticEvent) => {
    pressed.current = false;
    api.hover.leave(event);
  });
  const onPointerDown = useEvent((event: SyntheticEvent) => {
    pressed.current = true;
    api.setOpen(false, event, "trigger-press");
  });
  return renderPart(
    "button",
    props,
    { open: api.open },
    {
      "aria-describedby": api.open ? api.ids.popup : undefined,
      ...(api.open ? { "data-popup-open": "" } : {}),
      onPointerEnter,
      onPointerLeave,
      onPointerDown,
      onFocus: (event: SyntheticEvent<HTMLElement>) => {
        if (event.currentTarget.matches(":focus-visible"))
          api.setOpen(true, event, "trigger-focus");
      },
      onBlur: (event: SyntheticEvent) => api.setOpen(false, event, "trigger-focus"),
    },
    (el: HTMLElement | null) => {
      api.setTrigger(el);
    },
  );
}
const tooltipParts = partsFor("tooltip");
export const Tooltip = {
  Provider: TooltipProvider,
  Root: TooltipRoot,
  Trigger: TooltipTrigger,
  Portal: tooltipParts.Portal,
  Positioner: tooltipParts.Positioner,
  Popup: tooltipParts.Popup,
};
export declare namespace Tooltip {
  namespace Root {
    type Props<P = unknown> = TooltipRootProps<P>;
    type Actions = PopupActions;
  }
  namespace Trigger {
    type Props = Parameters<typeof TooltipTrigger>[0];
  }
  namespace Positioner {
    type Props = PositionerProps;
  }
  namespace Popup {
    type Props = PopupPartProps;
  }
}

function listItems(popup: HTMLElement | null, selector: string) {
  return popup
    ? [...popup.querySelectorAll<HTMLElement>(selector)].filter(
        (el) =>
          !el.hasAttribute("data-disabled") &&
          el.closest('[role="menu"],[data-list-root]') ===
            el.closest('[role="menu"],[data-list-root]') &&
          el.getClientRects().length > 0,
      )
    : [];
}
function useTypeahead() {
  const buffer = useRef({ text: "", at: 0 });
  return (key: string, items: HTMLElement[], from: number) => {
    const now = performance.now();
    const text = (now - buffer.current.at < 500 ? buffer.current.text : "") + key.toLowerCase();
    buffer.current = { text, at: now };
    // Repeating one letter cycles through the items starting with it.
    const query = [...text].every((c) => c === text[0]) ? text[0]! : text;
    // A growing query may still match the current item; a cycling one moves on.
    const start = query.length > 1 ? Math.max(0, from) : from + 1;
    const ordered = [...items.slice(start), ...items.slice(0, start)];
    return ordered.find((el) => (el.textContent ?? "").trim().toLowerCase().startsWith(query));
  };
}
/** Items per visible page of the list's scroller (unbounded when it doesn't scroll). */
function pageStep(items: readonly HTMLElement[], current: number) {
  const item = items[Math.max(0, current)];
  let box = item?.parentElement ?? null;
  while (box && box.scrollHeight <= box.clientHeight) box = box.parentElement;
  const height = item?.offsetHeight ?? 0;
  if (!box || box === document.body || box === document.documentElement || !height) return Infinity;
  return Math.max(1, Math.floor(box.clientHeight / height) - 1);
}
function listKeyDown(
  event: KeyboardEvent<HTMLElement>,
  selector: string,
  typeahead: ReturnType<typeof useTypeahead>,
  loop: boolean,
) {
  const popup = event.currentTarget;
  const items = listItems(popup, selector);
  const current = items.indexOf(document.activeElement as HTMLElement);
  let next: HTMLElement | undefined;
  if (event.key === "ArrowDown") next = items[current + 1] ?? (loop ? items[0] : items[current]);
  else if (event.key === "ArrowUp")
    next =
      current === -1
        ? items.at(-1)
        : (items[current - 1] ?? (loop ? items.at(-1) : items[current]));
  else if (event.key === "Home") next = items[0];
  else if (event.key === "End") next = items.at(-1);
  else if (event.key === "PageDown" || event.key === "PageUp") {
    const step = pageStep(items, current);
    next =
      items[
        Math.max(0, Math.min(items.length - 1, current + (event.key === "PageDown" ? step : -step)))
      ];
  } else if (
    event.key.length === 1 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    event.key !== " " &&
    !(event.target instanceof HTMLInputElement)
  )
    next = typeahead(event.key, items, current);
  if (!next) return false;
  event.preventDefault();
  next.focus({ preventScroll: false });
  return true;
}
interface ItemState {
  highlighted: boolean;
  disabled: boolean;
}
function useHighlight(open: boolean) {
  const [highlighted, setHighlighted] = useState(false);
  return {
    highlighted,
    props: {
      onFocus: () => setHighlighted(true),
      onBlur: () => setHighlighted(false),
      onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
        // A closing popup ignores the pointer, so focus can return to the trigger.
        if (open && event.pointerType !== "touch" && document.activeElement !== event.currentTarget)
          event.currentTarget.focus({ preventScroll: true });
      },
      onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => {
        if (document.activeElement === event.currentTarget)
          (
            event.currentTarget.closest('[role="menu"],[data-list-root]') as HTMLElement | null
          )?.focus({ preventScroll: true });
      },
    },
  };
}

const MenuItemsCtx = createContext<{
  closeTree: (event: SyntheticEvent | Event | undefined) => void;
  typeahead: ReturnType<typeof useTypeahead>;
} | null>(null);
type MenuRootProps<P = unknown> = RootProps<P> & {
  loopFocus?: boolean | undefined;
  orientation?: string | undefined;
  openOnHover?: boolean | undefined;
  highlightItemOnHover?: boolean | undefined;
};
function MenuRoot<P>({
  children,
  loopFocus: _l,
  orientation: _o,
  openOnHover: _h,
  highlightItemOnHover: _hh,
  ...props
}: MenuRootProps<P>) {
  const api = usePopupRoot<P>("menu", props, { modal: false, delay: 100, closeDelay: 0 });
  const typeahead = useTypeahead();
  return (
    <MenuItemsCtx
      value={{ closeTree: (event) => api.setOpen(false, event, "item-press"), typeahead }}
    >
      <RootView api={api}>{children}</RootView>
    </MenuItemsCtx>
  );
}
function MenuTrigger(props: TriggerProps) {
  const api = usePopup("menu");
  return (
    <PopupTrigger
      kind="menu"
      {...props}
      onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
        props.onKeyDown?.(event);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          api.setOpenType("keyboard");
          api.setOpen(true, event, "list-navigation");
        }
      }}
    />
  );
}
const MENU_ITEMS = '[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]';
function MenuPopup(props: PopupPartProps) {
  const api = usePopup("menu");
  const tree = use(MenuItemsCtx);
  return (
    <PopupView
      kind="menu"
      {...props}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        props.onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (listKeyDown(event, MENU_ITEMS, tree!.typeahead, true)) return;
        if (
          api.parent?.kind === "menu" &&
          (event.key === "ArrowLeft" || event.key === "ArrowRight")
        ) {
          const closeKey =
            getComputedStyle(event.currentTarget).direction === "rtl" ? "ArrowRight" : "ArrowLeft";
          if (event.key === closeKey) {
            event.preventDefault();
            api.setOpen(false, event, "list-navigation");
            api.getTrigger()?.focus();
          }
        }
        if (event.key === "Tab") {
          let root = api;
          while (root.parent?.kind === "menu") root = root.parent;
          tabFromTrigger(root, event);
        }
      }}
    />
  );
}
type MenuItemProps = PartProps<"div", ItemState> & {
  closeOnClick?: boolean | undefined;
  disabled?: boolean | undefined;
  label?: string | undefined;
  nativeButton?: boolean | undefined;
};
function useMenuItem({
  closeOnClick,
  disabled = false,
  role,
  extra = {},
}: {
  closeOnClick: boolean;
  disabled?: boolean;
  role: string;
  extra?: Record<string, unknown>;
}) {
  const tree = use(MenuItemsCtx);
  const highlight = useHighlight(usePopup("menu").open);
  const state = { highlighted: highlight.highlighted, disabled };
  return {
    state,
    props: {
      role,
      tabIndex: -1,
      "aria-disabled": disabled || undefined,
      ...(disabled ? { "data-disabled": "" } : {}),
      ...(highlight.highlighted ? { "data-highlighted": "" } : {}),
      ...highlight.props,
      ...extra,
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (
          event.key === "Enter" ||
          (event.key === " " && !(event.target instanceof HTMLInputElement))
        ) {
          event.preventDefault();
          event.currentTarget.click();
        }
      },
      onClick: (event: MouseEvent) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        if (closeOnClick) tree?.closeTree(event);
      },
    },
  };
}
function MenuItem({
  closeOnClick = true,
  disabled,
  label: _l,
  nativeButton: _n,
  ...props
}: MenuItemProps) {
  const item = useMenuItem({ closeOnClick, disabled: disabled ?? false, role: "menuitem" });
  return renderPart("div", props, item.state, item.props);
}
interface MenuCheckState extends ItemState {
  checked: boolean;
}
const MenuCheckCtx = createContext<MenuCheckState>({
  checked: false,
  highlighted: false,
  disabled: false,
});
function MenuCheckboxItem({
  checked: checkedProp,
  defaultChecked = false,
  onCheckedChange,
  closeOnClick = false,
  disabled = false,
  label: _l,
  nativeButton: _n,
  ...props
}: Omit<PartProps<"div", MenuCheckState>, "defaultChecked"> & {
  checked?: boolean | undefined;
  defaultChecked?: boolean | undefined;
  onCheckedChange?: OpenChange | undefined;
  closeOnClick?: boolean | undefined;
  disabled?: boolean | undefined;
  label?: string | undefined;
  nativeButton?: boolean | undefined;
}) {
  const [checked, setChecked] = useControlled(checkedProp, defaultChecked);
  const item = useMenuItem({
    closeOnClick,
    disabled,
    role: "menuitemcheckbox",
    extra: {
      "aria-checked": checked,
      ...(checked ? { "data-checked": "" } : { "data-unchecked": "" }),
    },
  });
  const state = { ...item.state, checked };
  return (
    <MenuCheckCtx value={state}>
      {renderPart("div", props, state, {
        ...item.props,
        onClick: (event: MouseEvent) => {
          if (disabled) return;
          const details = changeDetails("item-press", event);
          onCheckedChange?.(!checked, details);
          if (!details.isCanceled) setChecked(!checked);
          item.props.onClick(event);
        },
      })}
    </MenuCheckCtx>
  );
}
function MenuIndicator({
  keepMounted = false,
  ...props
}: PartProps<"span", MenuCheckState> & { keepMounted?: boolean | undefined }) {
  const state = use(MenuCheckCtx);
  if (!keepMounted && !state.checked) return null;
  return renderPart(
    "span",
    props,
    state,
    state.checked ? { "data-checked": "" } : { "data-unchecked": "" },
  );
}
const MenuRadioCtx = createContext<{
  value: unknown;
  select: (value: unknown, event: SyntheticEvent) => void;
  disabled: boolean;
} | null>(null);
type MenuRadioGroupProps<V = any> = Omit<PartProps<"div", object>, "defaultValue"> & {
  value?: V | undefined;
  defaultValue?: V | undefined;
  onValueChange?: ((value: V, details: ChangeEventDetails) => void) | undefined;
  disabled?: boolean | undefined;
};
function MenuRadioGroup<V = any>({
  value: valueProp,
  defaultValue,
  onValueChange,
  disabled = false,
  ...props
}: MenuRadioGroupProps<V>) {
  const [value, setValue] = useControlled<V | undefined>(valueProp, defaultValue);
  const select = (next: unknown, event: SyntheticEvent) => {
    const details = changeDetails("item-press", event);
    onValueChange?.(next as V, details);
    if (!details.isCanceled) setValue(next as V);
  };
  return (
    <MenuRadioCtx value={{ value, select, disabled }}>
      {renderPart("div", props, {}, { role: "group" })}
    </MenuRadioCtx>
  );
}
function MenuRadioItem({
  value,
  closeOnClick = false,
  disabled: disabledProp,
  label: _l,
  nativeButton: _n,
  ...props
}: PartProps<"div", MenuCheckState> & {
  value: unknown;
  closeOnClick?: boolean | undefined;
  disabled?: boolean | undefined;
  label?: string | undefined;
  nativeButton?: boolean | undefined;
}) {
  const group = use(MenuRadioCtx);
  const checked = group ? Object.is(group.value, value) : false;
  const disabled = Boolean(disabledProp || group?.disabled);
  const item = useMenuItem({
    closeOnClick,
    disabled,
    role: "menuitemradio",
    extra: {
      "aria-checked": checked,
      ...(checked ? { "data-checked": "" } : { "data-unchecked": "" }),
    },
  });
  const state = { ...item.state, checked };
  return (
    <MenuCheckCtx value={state}>
      {renderPart("div", props, state, {
        ...item.props,
        onClick: (event: MouseEvent) => {
          if (disabled) return;
          group?.select(value, event);
          item.props.onClick(event);
        },
      })}
    </MenuCheckCtx>
  );
}
function MenuGroup(props: PartProps<"div", object>) {
  const labelId = useId();
  return (
    <MenuGroupCtx value={labelId}>
      {renderPart("div", props, {}, { role: "group", "aria-labelledby": labelId })}
    </MenuGroupCtx>
  );
}
const MenuGroupCtx = createContext<string | undefined>(undefined);
function MenuGroupLabel(props: PartProps<"div", object>) {
  const id = use(MenuGroupCtx);
  return renderPart("div", props, {}, { id, role: "presentation" });
}
function MenuSeparator(props: PartProps<"div", object>) {
  return renderPart("div", props, {}, { role: "separator", "aria-orientation": "horizontal" });
}
function MenuSubmenuRoot<P>({
  children,
  loopFocus: _l,
  orientation: _o,
  openOnHover: _h,
  highlightItemOnHover: _hh,
  ...props
}: MenuRootProps<P>) {
  const api = usePopupRoot<P>("menu", props, { modal: false, delay: 100, closeDelay: 0 });
  const parentTree = use(MenuItemsCtx);
  const typeahead = useTypeahead();
  return (
    <MenuItemsCtx
      value={{
        closeTree: (event) =>
          parentTree ? parentTree.closeTree(event) : api.setOpen(false, event, "item-press"),
        typeahead,
      }}
    >
      <RootView api={api}>{children}</RootView>
    </MenuItemsCtx>
  );
}
function MenuSubmenuTrigger({
  disabled = false,
  openOnHover = true,
  delay: _d,
  closeDelay: _c,
  label: _l,
  nativeButton: _n,
  ...props
}: PartProps<"div", ItemState & { open: boolean }> & {
  disabled?: boolean | undefined;
  openOnHover?: boolean | undefined;
  delay?: number | undefined;
  closeDelay?: number | undefined;
  label?: string | undefined;
  nativeButton?: boolean | undefined;
}) {
  const api = usePopup("menu");
  const highlight = useHighlight(api.open);
  const state = { highlighted: highlight.highlighted || api.open, disabled, open: api.open };
  const openWith = (event: SyntheticEvent, keyboard: boolean) => {
    api.setOpenType(keyboard ? "keyboard" : "mouse");
    api.setOpen(true, event, keyboard ? "list-navigation" : "trigger-hover");
  };
  return renderPart(
    "div",
    props,
    state,
    {
      role: "menuitem",
      tabIndex: -1,
      "aria-haspopup": "menu",
      "aria-expanded": api.open,
      "aria-disabled": disabled || undefined,
      ...(disabled ? { "data-disabled": "" } : {}),
      ...(state.highlighted ? { "data-highlighted": "" } : {}),
      ...(api.open ? { "data-popup-open": "" } : {}),
      ...highlight.props,
      onPointerEnter: (event: SyntheticEvent) => {
        if (!disabled && openOnHover) api.hover.enter(event);
      },
      onPointerLeave: () => api.hover.cancel(),
      onClick: (event: SyntheticEvent) => !disabled && openWith(event, false),
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        const openKey =
          getComputedStyle(event.currentTarget).direction === "rtl" ? "ArrowLeft" : "ArrowRight";
        if (!disabled && (event.key === openKey || event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          event.stopPropagation();
          flushSync(() => openWith(event, true));
        }
      },
    },
    (el: HTMLElement | null) => {
      api.setTrigger(el);
    },
  );
}
const menuParts = partsFor("menu");
export const Menu = {
  Root: MenuRoot,
  Trigger: MenuTrigger,
  Portal: menuParts.Portal,
  Positioner: menuParts.Positioner,
  Popup: MenuPopup,
  Backdrop: menuParts.Backdrop,
  Item: MenuItem,
  CheckboxItem: MenuCheckboxItem,
  CheckboxItemIndicator: MenuIndicator,
  RadioGroup: MenuRadioGroup,
  RadioItem: MenuRadioItem,
  RadioItemIndicator: MenuIndicator,
  Group: MenuGroup,
  GroupLabel: MenuGroupLabel,
  Separator: MenuSeparator,
  SubmenuRoot: MenuSubmenuRoot,
  SubmenuTrigger: MenuSubmenuTrigger,
  createHandle,
};
export declare namespace Menu {
  namespace Root {
    type Props<P = unknown> = MenuRootProps<P>;
    type Actions = PopupActions;
  }
  namespace Trigger {
    type Props = TriggerProps;
  }
  namespace Portal {
    type Props = PortalProps;
  }
  namespace Positioner {
    type Props = PositionerProps;
  }
  namespace Popup {
    type Props = PopupPartProps;
  }
  namespace Item {
    type Props = MenuItemProps;
  }
  namespace CheckboxItem {
    type Props = Parameters<typeof MenuCheckboxItem>[0];
  }
  namespace RadioGroup {
    type Props<V = any> = MenuRadioGroupProps<V>;
  }
  namespace RadioItem {
    type Props = Parameters<typeof MenuRadioItem>[0];
  }
  namespace RadioItemIndicator {
    type Props = Parameters<typeof MenuIndicator>[0];
  }
  namespace Group {
    type Props = PartProps<"div", object>;
  }
  namespace GroupLabel {
    type Props = PartProps<"div", object>;
  }
  namespace Separator {
    type Props = PartProps<"div", object>;
  }
  namespace SubmenuRoot {
    type Props<P = unknown> = MenuRootProps<P>;
  }
  namespace SubmenuTrigger {
    type Props = Parameters<typeof MenuSubmenuTrigger>[0];
  }
}

type SelectItems = ReadonlyArray<{ value: unknown; label: ReactNode }> | Record<string, ReactNode>;
interface SelectApi {
  value: unknown;
  multiple: boolean;
  select: (value: unknown, event: SyntheticEvent) => void;
  isSelected: (value: unknown) => boolean;
  labelFor: (value: unknown) => ReactNode;
  labels: Map<unknown, ReactNode>;
  disabled: boolean;
  typeahead: ReturnType<typeof useTypeahead>;
}
const SelectCtx = createContext<SelectApi | null>(null);
type SelectRootProps<V = any> = Omit<RootProps, "children"> & {
  value?: V | undefined;
  defaultValue?: V | undefined;
  onValueChange?: ((value: V, details: ChangeEventDetails) => void) | undefined;
  items?: SelectItems | undefined;
  multiple?: boolean | undefined;
  name?: string | undefined;
  required?: boolean | undefined;
  readOnly?: boolean | undefined;
  itemToStringLabel?: ((value: V) => string) | undefined;
  itemToStringValue?: ((value: V) => string) | undefined;
  isItemEqualToValue?: ((item: V, value: V) => boolean) | undefined;
  children?: ReactNode;
};
function SelectRoot<V>({
  value: valueProp,
  defaultValue,
  onValueChange,
  items,
  multiple = false,
  name,
  required: _r,
  readOnly: _ro,
  itemToStringLabel,
  itemToStringValue,
  isItemEqualToValue,
  children,
  ...props
}: SelectRootProps<V>) {
  const api = usePopupRoot("select", props, { modal: false, delay: 0, closeDelay: 0 });
  const [value, setValue] = useControlled<V | undefined>(valueProp, defaultValue);
  const [labels] = useState(() => new Map<unknown, ReactNode>());
  const typeahead = useTypeahead();
  const equal = (a: unknown, b: unknown) =>
    isItemEqualToValue ? isItemEqualToValue(a as V, b as V) : Object.is(a, b);
  const isSelected = (item: unknown) =>
    multiple && Array.isArray(value)
      ? value.some((v) => equal(item, v))
      : value !== undefined && value !== null && equal(item, value);
  const select = (item: unknown, event: SyntheticEvent) => {
    const next = (
      multiple
        ? isSelected(item)
          ? ((value as unknown[]) ?? []).filter((v) => !equal(item, v))
          : [...((value as unknown[]) ?? []), item]
        : item
    ) as V;
    const details = changeDetails("item-press", event);
    onValueChange?.(next, details);
    if (!details.isCanceled) setValue(next);
    if (!multiple) api.setOpen(false, event, "item-press");
  };
  const labelFor = (item: unknown): ReactNode => {
    if (itemToStringLabel && item !== undefined && item !== null)
      return itemToStringLabel(item as V);
    if (Array.isArray(items))
      return (
        (items as ReadonlyArray<{ value: unknown; label: ReactNode }>).find((entry) =>
          equal(entry.value, item),
        )?.label ??
        labels.get(item) ??
        (item as ReactNode)
      );
    if (items && typeof item === "string")
      return (items as Record<string, ReactNode>)[item] ?? labels.get(item) ?? item;
    return labels.get(item) ?? (typeof item === "string" || typeof item === "number" ? item : null);
  };
  return (
    <RootView api={api}>
      <SelectCtx
        value={{
          value,
          multiple,
          select,
          isSelected,
          labelFor,
          labels,
          disabled: Boolean(props.disabled),
          typeahead,
        }}
      >
        {children}
        {name ? (
          <input
            type="hidden"
            name={name}
            value={
              value === undefined || value === null
                ? ""
                : itemToStringValue
                  ? itemToStringValue(value)
                  : String(value)
            }
          />
        ) : null}
      </SelectCtx>
    </RootView>
  );
}
function useSelect() {
  const ctx = use(SelectCtx);
  if (!ctx) throw new Error("Select parts must render inside Select.Root");
  return ctx;
}
function SelectTrigger({
  nativeButton: _n,
  ...props
}: PartProps<"button", { open: boolean; disabled: boolean; placeholder: boolean }> & {
  nativeButton?: boolean | undefined;
}) {
  const api = usePopup("select");
  const select = useSelect();
  const trigger = useTriggerProps(
    api,
    { id: props.id, disabled: select.disabled || Boolean(props.disabled) },
    "listbox",
  );
  const empty =
    select.value === undefined ||
    select.value === null ||
    (Array.isArray(select.value) && select.value.length === 0);
  return renderPart(
    "button",
    props,
    { open: api.open, disabled: select.disabled, placeholder: empty },
    {
      ...trigger.props,
      role: "combobox",
      ...(empty ? { "data-placeholder": "" } : {}),
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          api.setOpenType("keyboard");
          api.setOpen(true, event, "list-navigation");
        } else trigger.props.onKeyDown(event);
      },
    },
    trigger.ref,
  );
}
function SelectValue({
  children,
  placeholder,
  ...props
}: Omit<PartProps<"span", { value: unknown; placeholder: boolean }>, "children"> & {
  children?: ReactNode | ((value: never) => ReactNode);
  placeholder?: ReactNode;
}) {
  const select = useSelect();
  const empty =
    select.value === undefined ||
    select.value === null ||
    (Array.isArray(select.value) && select.value.length === 0);
  const content =
    typeof children === "function"
      ? children(select.value as never)
      : (children ??
        (empty
          ? placeholder
          : Array.isArray(select.value)
            ? select.value.map((v) => select.labelFor(v)).join(", ")
            : select.labelFor(select.value)));
  return renderPart(
    "span",
    { ...props, children: content },
    { value: select.value, placeholder: empty },
    { "data-select-value": "", ...(empty ? { "data-placeholder": "" } : {}) },
  );
}
function SelectIcon(props: PartProps<"span", object>) {
  return renderPart("span", props, {}, { "aria-hidden": true });
}
function SelectPopup(props: PopupPartProps) {
  const select = useSelect();
  const api = usePopup("select");
  return (
    <PopupView
      kind="select"
      {...props}
      role="presentation"
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        props.onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === "Tab") tabFromTrigger(api, event);
        else listKeyDown(event, '[role="option"]', select.typeahead, false);
      }}
    />
  );
}
function SelectList(props: PartProps<"div", object>) {
  const select = useSelect();
  return renderPart(
    "div",
    props,
    {},
    {
      role: "listbox",
      "aria-multiselectable": select.multiple || undefined,
      "data-list-root": "",
      tabIndex: -1,
    },
  );
}
const SelectItemCtx = createContext<{ selected: boolean; highlighted: boolean; disabled: boolean }>(
  { selected: false, highlighted: false, disabled: false },
);
function SelectItem({
  value,
  disabled = false,
  label,
  nativeButton: _n,
  ...props
}: PartProps<"div", { selected: boolean; highlighted: boolean; disabled: boolean }> & {
  value: unknown;
  disabled?: boolean | undefined;
  label?: string | undefined;
  nativeButton?: boolean | undefined;
}) {
  const select = useSelect();
  const highlight = useHighlight(usePopup("select").open);
  const selected = select.isSelected(value);
  const state = { selected, highlighted: highlight.highlighted, disabled };
  const register = (el: HTMLElement | null) => {
    if (el && !select.labels.has(value))
      select.labels.set(
        value,
        label ?? el.querySelector("[data-select-item-text]")?.textContent ?? el.textContent,
      );
  };
  return (
    <SelectItemCtx value={state}>
      {renderPart(
        "div",
        props,
        state,
        {
          role: "option",
          tabIndex: -1,
          "aria-selected": selected,
          "aria-disabled": disabled || undefined,
          ...(selected ? { "data-selected": "" } : {}),
          ...(highlight.highlighted ? { "data-highlighted": "" } : {}),
          ...(disabled ? { "data-disabled": "" } : {}),
          ...highlight.props,
          onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              if (!disabled) select.select(value, event);
            }
          },
          onClick: (event: SyntheticEvent) => !disabled && select.select(value, event),
        },
        register,
      )}
    </SelectItemCtx>
  );
}
function SelectItemText(props: PartProps<"span", object>) {
  return renderPart("span", props, {}, { "data-select-item-text": "" });
}
function SelectItemIndicator({
  keepMounted = false,
  ...props
}: PartProps<"span", object> & { keepMounted?: boolean | undefined }) {
  const item = use(SelectItemCtx);
  if (!keepMounted && !item.selected) return null;
  return renderPart("span", props, {}, { "aria-hidden": true });
}
function SelectGroup(props: PartProps<"div", object>) {
  const labelId = useId();
  return (
    <MenuGroupCtx value={labelId}>
      {renderPart("div", props, {}, { role: "group", "aria-labelledby": labelId })}
    </MenuGroupCtx>
  );
}
const SelectScrollArrow = (_props: PartProps<"div", object>): ReactElement | null => null;
const selectParts = partsFor("select");
export const Select = {
  Root: SelectRoot,
  Trigger: SelectTrigger,
  Value: SelectValue,
  Icon: SelectIcon,
  Portal: selectParts.Portal,
  Positioner: selectParts.Positioner,
  Popup: SelectPopup,
  List: SelectList,
  Item: SelectItem,
  ItemText: SelectItemText,
  ItemIndicator: SelectItemIndicator,
  Group: SelectGroup,
  GroupLabel: MenuGroupLabel,
  Separator: MenuSeparator,
  ScrollUpArrow: SelectScrollArrow,
  ScrollDownArrow: SelectScrollArrow,
  Backdrop: selectParts.Backdrop,
};
export declare namespace Select {
  namespace Root {
    type Props<V = any> = SelectRootProps<V>;
  }
  namespace Trigger {
    type Props = Parameters<typeof SelectTrigger>[0];
  }
  namespace Value {
    type Props = Parameters<typeof SelectValue>[0];
  }
  namespace Positioner {
    type Props = PositionerProps;
  }
  namespace Popup {
    type Props = PopupPartProps;
  }
  namespace Item {
    type Props = Parameters<typeof SelectItem>[0];
  }
  namespace Group {
    type Props = PartProps<"div", object>;
  }
  namespace GroupLabel {
    type Props = PartProps<"div", object>;
  }
}

export {
  pageStep,
  usePopup,
  usePopupRoot,
  RootView,
  partsFor,
  type PopupApi,
  type RootProps,
  type PopupPartProps,
};
