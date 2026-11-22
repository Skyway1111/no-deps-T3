import { observeResize } from "~/lib/observeResize";
import {
  cloneElement,
  createContext,
  createElement,
  isValidElement,
  use,
  useId,
  useInsertionEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type SyntheticEvent,
} from "react";

type Tag = keyof JSX.IntrinsicElements;
// Merging works on loose prop bags; each component types its own props.
type Props = Record<string, unknown>;

/** Change details passed to every `on*Change` callback, matching Base UI's shape. */
export interface ChangeEventDetails {
  reason: string;
  event: Event;
  cancel: () => void;
  readonly isCanceled: boolean;
  allowPropagation: () => void;
}
export function changeDetails(reason: string, event?: Event | SyntheticEvent): ChangeEventDetails {
  let canceled = false;
  return {
    reason,
    event: event ? ("nativeEvent" in event ? event.nativeEvent : event) : new Event(reason),
    cancel: () => {
      canceled = true;
    },
    get isCanceled() {
      return canceled;
    },
    allowPropagation: () => {},
  };
}

export type RenderProp<S> = ReactElement | ((props: Props, state: S) => ReactElement);
/** Props every primitive part accepts: native props, plus `className`/`style` as state functions and `render`. */
export type PartProps<T extends Tag, S = object> = Omit<
  ComponentPropsWithRef<T>,
  "className" | "style"
> & {
  className?: string | ((state: S) => string | undefined) | undefined;
  style?: CSSProperties | ((state: S) => CSSProperties | undefined) | undefined;
  render?: RenderProp<S> | undefined;
};

const isHandler = (key: string, value: unknown) =>
  key.length > 2 &&
  key[0] === "o" &&
  key[1] === "n" &&
  key.charCodeAt(2) >= 65 &&
  key.charCodeAt(2) <= 90 &&
  (typeof value === "function" || value === undefined);

type PreventableEvent = SyntheticEvent & {
  preventBaseUIHandler?: () => void;
  baseUIHandlerPrevented?: boolean | undefined;
};
const preventable = (event: unknown) => {
  if (event && typeof event === "object" && "nativeEvent" in event) {
    const e = event as PreventableEvent;
    e.preventBaseUIHandler ??= () => {
      e.baseUIHandlerPrevented = true;
    };
  }
  return event as PreventableEvent | undefined;
};

/** Later props win; handlers chain (later first, earlier skipped after `preventBaseUIHandler`); classes join; styles merge. */
export function mergeProps<_T extends Tag = "div">(...sources: Array<object | undefined>): Props {
  const merged: Props = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      const previous = merged[key];
      if (key === "className")
        merged.className = value
          ? previous
            ? `${value as string} ${previous as string}`
            : value
          : previous;
      else if (key === "style")
        merged.style =
          value || previous ? { ...(previous as object), ...(value as object) } : undefined;
      else if (
        isHandler(key, value) &&
        typeof previous === "function" &&
        typeof value === "function"
      ) {
        merged[key] = (...args: unknown[]) => {
          const event = preventable(args[0]);
          const result = (value as (...a: unknown[]) => unknown)(...args);
          if (!event?.baseUIHandlerPrevented) (previous as (...a: unknown[]) => unknown)(...args);
          return result;
        };
      } else if (value !== undefined || !(key in merged)) merged[key] = value;
    }
  }
  return merged;
}

function mergeRefs<T>(...refs: Array<Ref<T> | undefined>): Ref<T> {
  return (value: T | null) => {
    const cleanups = refs.map((ref) => {
      if (typeof ref === "function") return ref(value);
      if (ref) (ref as { current: T | null }).current = value;
      return undefined;
    });
    return () => {
      for (const [i, ref] of refs.entries()) {
        const cleanup = cleanups[i];
        if (typeof cleanup === "function") cleanup();
        else if (typeof ref === "function") ref(null);
        else if (ref) (ref as { current: T | null }).current = null;
      }
    };
  };
}

const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
/** Base UI's state → data attribute mapping: `true` → `data-x`, strings/numbers → `data-x="v"`. */
function stateAttributes(state: object): Props {
  const attrs: Props = {};
  for (const [key, value] of Object.entries(state)) {
    if (value === true) attrs[`data-${kebab(key)}`] = "";
    else if (typeof value === "string" || typeof value === "number")
      attrs[`data-${kebab(key)}`] = value;
  }
  return attrs;
}

/** Renders a part: resolves state-driven className/style, merges internal props under the caller's, honors `render`. */
type AnyPartProps<S> = {
  render?: RenderProp<S> | undefined;
  className?: unknown;
  style?: unknown;
  ref?: unknown;
  children?: ReactNode;
};
type ElementRef = Ref<HTMLElement> | undefined;
export function renderPart<S extends object>(
  tag: Tag,
  partProps: AnyPartProps<S>,
  state: S,
  internal: Props = {},
  internalRef?: ElementRef,
): ReactElement {
  const { render, className, style, ref, ...props } = partProps as AnyPartProps<S> & Props;
  const resolved = mergeProps(internal, props, {
    className: typeof className === "function" ? (className as (s: S) => string)(state) : className,
    style: typeof style === "function" ? (style as (s: S) => CSSProperties)(state) : style,
  });
  const refs = internalRef || ref ? mergeRefs(internalRef, ref as ElementRef) : undefined;
  if (refs) resolved.ref = refs;
  if (typeof render === "function") return render(resolved, state);
  if (isValidElement<Props>(render)) {
    const own = render.props;
    const out = mergeProps(resolved, own);
    const ownRef = own.ref as ElementRef;
    if (ownRef || refs) out.ref = mergeRefs(refs, ownRef);
    return cloneElement(render, out);
  }
  return createElement(tag, resolved);
}

/** Base UI's `useRender`: renders `render` (element or function) with merged props, else `defaultTagName`. */
export function renderElement<S extends object = object>({
  render,
  props = {},
  ref,
  state,
  defaultTagName = "div",
}: {
  render?: RenderProp<S> | undefined;
  props?: object | undefined;
  ref?: ElementRef | Array<ElementRef> | undefined;
  state?: S | undefined;
  defaultTagName?: Tag | undefined;
}): ReactElement {
  const refs = Array.isArray(ref) ? mergeRefs(...ref) : ref;
  return renderPart(defaultTagName, { ...(props as Props), render }, (state ?? {}) as S, {}, refs);
}
export declare namespace useRender {
  type ComponentProps<T extends Tag, S = object> = ComponentPropsWithRef<T> & {
    render?: RenderProp<S> | undefined;
  };
  type RenderProp<S = object> = ReactElement | ((props: Props, state: S) => ReactElement);
}

/** Stable handler that always calls the latest `fn`; call from handlers and effects, not render. */
export function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- updates the handler before any layout effect can call it.
  useInsertionEffect(() => {
    latest.current = fn;
  });
  const [stable] = useState(
    () =>
      (...args: A) =>
        latest.current(...args),
  );
  return stable;
}

/** Controlled-or-uncontrolled value. */
export function useControlled<T>(controlled: T | undefined, initial: T): [T, (next: T) => void] {
  const [own, setOwn] = useState(initial);
  const value = controlled === undefined ? own : controlled;
  return [value, setOwn];
}

/** Arrow/Home/End roving focus among `selector` matches inside `root`. */
function rovingKeyDown(
  event: KeyboardEvent<HTMLElement>,
  selector: string,
  orientation: "horizontal" | "vertical" | "both" = "both",
) {
  const keys = {
    horizontal: { ArrowLeft: -1, ArrowRight: 1 },
    vertical: { ArrowUp: -1, ArrowDown: 1 },
    both: { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 },
  }[orientation] as Record<string, number>;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(selector)].filter(
    (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true",
  );
  const current = items.indexOf(event.target as HTMLElement);
  let next = -1;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = items.length - 1;
  else if (keys[event.key] !== undefined && current !== -1) {
    const rtl =
      getComputedStyle(event.currentTarget).direction === "rtl" &&
      orientation !== "vertical" &&
      event.key.startsWith("Arrow") &&
      (event.key === "ArrowLeft" || event.key === "ArrowRight");
    next = (current + (rtl ? -1 : 1) * keys[event.key]! + items.length) % items.length;
  }
  if (next === -1 || !items[next]) return false;
  event.preventDefault();
  items[next]!.focus();
  return true;
}

type Orientation = "horizontal" | "vertical";
function SeparatorPart({
  orientation = "horizontal",
  ...props
}: PartProps<"div", { orientation: Orientation }> & { orientation?: Orientation | undefined }) {
  const state = { orientation };
  return renderPart("div", props, state, {
    role: "separator",
    "aria-orientation": orientation,
    ...stateAttributes(state),
  });
}
export const Separator = SeparatorPart;
export declare namespace Separator {
  type Props = Parameters<typeof SeparatorPart>[0];
}

interface ToggleState {
  pressed: boolean;
  disabled: boolean;
}
const ToggleGroupCtx = createContext<{
  value: readonly string[];
  toggle: (value: string, pressed: boolean, event: SyntheticEvent) => void;
  disabled: boolean;
} | null>(null);

type TogglePartProps = PartProps<"button", ToggleState> & {
  pressed?: boolean | undefined;
  defaultPressed?: boolean | undefined;
  onPressedChange?: ((pressed: boolean, details: ChangeEventDetails) => void) | undefined;
  value?: string | undefined;
  nativeButton?: boolean | undefined;
};
function TogglePart({
  pressed: pressedProp,
  defaultPressed = false,
  onPressedChange,
  value,
  disabled: disabledProp,
  nativeButton: _n,
  ...props
}: TogglePartProps) {
  const group = use(ToggleGroupCtx);
  const [own, setOwn] = useControlled(pressedProp, defaultPressed);
  const pressed = group && value !== undefined ? group.value.includes(value) : own;
  const disabled = Boolean(disabledProp || group?.disabled);
  const state = { pressed, disabled };
  return renderPart("button", props, state, {
    type: "button",
    "aria-pressed": pressed,
    disabled,
    ...stateAttributes(state),
    onClick: (event: SyntheticEvent) => {
      const next = !pressed;
      const details = changeDetails("none", event);
      onPressedChange?.(next, details);
      if (details.isCanceled) return;
      setOwn(next);
      if (group && value !== undefined) group.toggle(value, next, event);
    },
  });
}
export const Toggle = TogglePart;
export declare namespace Toggle {
  type Props = TogglePartProps;
  type State = ToggleState;
}

type ToggleGroupProps = PartProps<
  "div",
  { disabled: boolean; orientation: Orientation; multiple: boolean }
> & {
  value?: readonly string[] | undefined;
  defaultValue?: readonly string[] | undefined;
  onValueChange?: ((value: string[], details: ChangeEventDetails) => void) | undefined;
  multiple?: boolean | undefined;
  disabled?: boolean | undefined;
  orientation?: Orientation | undefined;
  loopFocus?: boolean | undefined;
};
function ToggleGroupPart({
  value: valueProp,
  defaultValue = [],
  onValueChange,
  multiple = false,
  disabled = false,
  orientation = "horizontal",
  loopFocus: _l,
  ...props
}: ToggleGroupProps) {
  const [value, setValue] = useControlled(valueProp, defaultValue);
  const toggle = (item: string, pressed: boolean, event: SyntheticEvent) => {
    const next = pressed ? (multiple ? [...value, item] : [item]) : value.filter((v) => v !== item);
    const details = changeDetails("none", event);
    onValueChange?.(next, details);
    if (!details.isCanceled) setValue(next);
  };
  const state = { disabled, orientation, multiple };
  return (
    <ToggleGroupCtx value={{ value, toggle, disabled }}>
      {renderPart("div", props, state, {
        role: "group",
        ...stateAttributes(state),
        onKeyDown: (event: KeyboardEvent<HTMLElement>) =>
          rovingKeyDown(event, "button", orientation),
      })}
    </ToggleGroupCtx>
  );
}
export const ToggleGroup = ToggleGroupPart;
export declare namespace ToggleGroup {
  type Props = ToggleGroupProps;
}

function ToolbarRoot({
  orientation = "horizontal",
  ...props
}: PartProps<"div", { orientation: Orientation }> & { orientation?: Orientation | undefined }) {
  const state = { orientation };
  return renderPart("div", props, state, {
    role: "toolbar",
    "aria-orientation": orientation,
    ...stateAttributes(state),
    onKeyDown: (event: KeyboardEvent<HTMLElement>) =>
      rovingKeyDown(event, "[data-toolbar-item]", orientation),
  });
}
function ToolbarButton({
  disabled = false,
  focusableWhenDisabled: _f,
  nativeButton: _n,
  ...props
}: PartProps<"button", { disabled: boolean }> & {
  focusableWhenDisabled?: boolean;
  nativeButton?: boolean | undefined;
}) {
  const state = { disabled };
  return renderPart("button", props, state, {
    type: "button",
    disabled,
    "data-toolbar-item": "",
    ...stateAttributes(state),
  });
}
export const Toolbar = { Root: ToolbarRoot, Button: ToolbarButton };

interface CheckedState {
  checked: boolean;
  disabled: boolean;
  readOnly: boolean;
  required: boolean;
}
const checkedAttrs = (s: CheckedState & { indeterminate?: boolean | undefined }) => ({
  ...(s.indeterminate
    ? { "data-indeterminate": "" }
    : s.checked
      ? { "data-checked": "" }
      : { "data-unchecked": "" }),
  ...(s.disabled ? { "data-disabled": "" } : {}),
  ...(s.readOnly ? { "data-readonly": "" } : {}),
  ...(s.required ? { "data-required": "" } : {}),
});
type CheckedProps = {
  checked?: boolean | undefined;
  defaultChecked?: boolean | undefined;
  onCheckedChange?: ((checked: boolean, details: ChangeEventDetails) => void) | undefined;
  disabled?: boolean | undefined;
  readOnly?: boolean | undefined;
  required?: boolean | undefined;
  name?: string | undefined;
  value?: string | undefined;
  inputRef?: Ref<HTMLInputElement> | undefined;
  nativeButton?: boolean | undefined;
};
/** Shared button + hidden checkbox input behavior for Switch and Checkbox. */
function useCheckedControl({
  checked: checkedProp,
  defaultChecked = false,
  onCheckedChange,
  disabled = false,
  readOnly = false,
  required = false,
}: CheckedProps) {
  const [checked, setChecked] = useControlled(checkedProp, defaultChecked);
  const state = { checked, disabled, readOnly, required };
  const toggle = (event: SyntheticEvent) => {
    if (disabled || readOnly) return;
    const details = changeDetails("none", event);
    onCheckedChange?.(!checked, details);
    if (!details.isCanceled) setChecked(!checked);
  };
  return { state, toggle };
}
function HiddenInput({
  name,
  value,
  checked,
  required,
  disabled,
  inputRef,
}: {
  name?: string | undefined;
  value?: string | undefined;
  checked: boolean;
  required: boolean;
  disabled: boolean;
  inputRef?: Ref<HTMLInputElement> | undefined;
}) {
  if (!name && !inputRef) return null;
  return (
    <input
      type="checkbox"
      ref={inputRef}
      name={name}
      value={value ?? "on"}
      checked={checked}
      required={required}
      disabled={disabled}
      readOnly
      aria-hidden
      tabIndex={-1}
      style={{
        position: "absolute",
        opacity: 0,
        pointerEvents: "none",
        width: 1,
        height: 1,
        margin: 0,
      }}
    />
  );
}

const SwitchCtx = createContext<CheckedState>({
  checked: false,
  disabled: false,
  readOnly: false,
  required: false,
});
type SwitchRootProps = Omit<
  PartProps<"button", CheckedState>,
  "value" | "defaultChecked" | "onChange"
> &
  CheckedProps;
function SwitchRoot({
  checked,
  defaultChecked,
  onCheckedChange,
  disabled,
  readOnly,
  required,
  name,
  value,
  inputRef,
  nativeButton: _n,
  children,
  ...props
}: SwitchRootProps) {
  const { state, toggle } = useCheckedControl({
    checked,
    defaultChecked,
    onCheckedChange,
    disabled,
    readOnly,
    required,
  });
  return (
    <SwitchCtx value={state}>
      {renderPart(
        "button",
        {
          ...props,
          children: (
            <>
              {children}
              <HiddenInput
                name={name}
                value={value}
                checked={state.checked}
                required={state.required}
                disabled={state.disabled}
                inputRef={inputRef}
              />
            </>
          ),
        },
        state,
        {
          type: "button",
          role: "switch",
          "aria-checked": state.checked,
          "aria-readonly": state.readOnly || undefined,
          disabled: state.disabled,
          ...checkedAttrs(state),
          onClick: toggle,
        },
      )}
    </SwitchCtx>
  );
}
function SwitchThumb(props: PartProps<"span", CheckedState>) {
  const state = use(SwitchCtx);
  return renderPart("span", props, state, checkedAttrs(state));
}
export const Switch = { Root: SwitchRoot, Thumb: SwitchThumb };
export declare namespace Switch {
  namespace Root {
    type Props = SwitchRootProps;
  }
}

type CheckboxState = CheckedState & { indeterminate: boolean };
const CheckboxCtx = createContext<CheckboxState>({
  checked: false,
  disabled: false,
  readOnly: false,
  required: false,
  indeterminate: false,
});
type CheckboxRootProps = Omit<
  PartProps<"button", CheckboxState>,
  "value" | "defaultChecked" | "onChange"
> &
  CheckedProps & { indeterminate?: boolean | undefined };
function CheckboxRoot({
  checked,
  defaultChecked,
  onCheckedChange,
  disabled,
  readOnly,
  required,
  name,
  value,
  inputRef,
  indeterminate = false,
  nativeButton: _n,
  children,
  ...props
}: CheckboxRootProps) {
  const { state: base, toggle } = useCheckedControl({
    checked,
    defaultChecked,
    onCheckedChange,
    disabled,
    readOnly,
    required,
  });
  const state = { ...base, indeterminate };
  return (
    <CheckboxCtx value={state}>
      {renderPart(
        "button",
        {
          ...props,
          children: (
            <>
              {children}
              <HiddenInput
                name={name}
                value={value}
                checked={state.checked}
                required={state.required}
                disabled={state.disabled}
                inputRef={inputRef}
              />
            </>
          ),
        },
        state,
        {
          type: "button",
          role: "checkbox",
          "aria-checked": indeterminate ? "mixed" : state.checked,
          "aria-readonly": state.readOnly || undefined,
          disabled: state.disabled,
          ...checkedAttrs(state),
          onClick: toggle,
        },
      )}
    </CheckboxCtx>
  );
}
function CheckboxIndicator({
  keepMounted = false,
  ...props
}: PartProps<"span", CheckboxState> & { keepMounted?: boolean | undefined }) {
  const state = use(CheckboxCtx);
  if (!keepMounted && !state.checked && !state.indeterminate) return null;
  return renderPart("span", props, state, checkedAttrs(state));
}
export const Checkbox = { Root: CheckboxRoot, Indicator: CheckboxIndicator };
export declare namespace Checkbox {
  namespace Root {
    type Props = CheckboxRootProps;
    type State = CheckboxState;
  }
}

const RadioGroupCtx = createContext<{
  value: unknown;
  select: (value: unknown, event: SyntheticEvent) => void;
  disabled: boolean;
  readOnly: boolean;
  name: string | undefined;
} | null>(null);
type RadioGroupProps<V = any> = Omit<
  PartProps<"div", { disabled: boolean; readOnly: boolean }>,
  "defaultValue" | "onChange"
> & {
  value?: V | undefined;
  defaultValue?: V | undefined;
  onValueChange?: ((value: V, details: ChangeEventDetails) => void) | undefined;
  disabled?: boolean | undefined;
  readOnly?: boolean | undefined;
  required?: boolean | undefined;
  name?: string | undefined;
};
function RadioGroupPart<V>({
  value: valueProp,
  defaultValue,
  onValueChange,
  disabled = false,
  readOnly = false,
  required: _r,
  name,
  ...props
}: RadioGroupProps<V>) {
  const [value, setValue] = useControlled<V | undefined>(valueProp, defaultValue);
  const select = (next: unknown, event: SyntheticEvent) => {
    if (disabled || readOnly || Object.is(next, value)) return;
    const details = changeDetails("none", event);
    onValueChange?.(next as V, details);
    if (!details.isCanceled) setValue(next as V);
  };
  const state = { disabled, readOnly };
  return (
    <RadioGroupCtx value={{ value, select, disabled, readOnly, name }}>
      {renderPart("div", props, state, {
        role: "radiogroup",
        "aria-disabled": disabled || undefined,
        ...stateAttributes(state),
        onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
          // Arrow keys move focus and select, like native radios.
          if (rovingKeyDown(event, '[role="radio"]'))
            (event.currentTarget.ownerDocument.activeElement as HTMLElement | null)?.click();
        },
      })}
    </RadioGroupCtx>
  );
}
export const RadioGroup = RadioGroupPart;
export declare namespace RadioGroup {
  type Props<V = any> = RadioGroupProps<V>;
}

type RadioState = CheckedState;
const RadioCtx = createContext<RadioState>({
  checked: false,
  disabled: false,
  readOnly: false,
  required: false,
});
type RadioRootProps = Omit<PartProps<"button", RadioState>, "value"> & {
  value: unknown;
  disabled?: boolean;
  readOnly?: boolean;
  nativeButton?: boolean | undefined;
};
function RadioRoot({
  value,
  disabled: disabledProp = false,
  readOnly: readOnlyProp = false,
  nativeButton: _n,
  ...props
}: RadioRootProps) {
  const group = use(RadioGroupCtx);
  const checked = group ? Object.is(group.value, value) : false;
  const disabled = disabledProp || Boolean(group?.disabled);
  const state = {
    checked,
    disabled,
    readOnly: readOnlyProp || Boolean(group?.readOnly),
    required: false,
  };
  const hasSelection = group?.value !== undefined && group?.value !== null;
  return (
    <RadioCtx value={state}>
      {renderPart("button", props, state, {
        type: "button",
        role: "radio",
        "aria-checked": checked,
        disabled,
        tabIndex: checked || !hasSelection ? 0 : -1,
        ...checkedAttrs(state),
        onClick: (event: SyntheticEvent) => group?.select(value, event),
      })}
    </RadioCtx>
  );
}
function RadioIndicator({
  keepMounted = false,
  ...props
}: PartProps<"span", RadioState> & { keepMounted?: boolean | undefined }) {
  const state = use(RadioCtx);
  if (!keepMounted && !state.checked) return null;
  return renderPart("span", props, state, checkedAttrs(state));
}
export const Radio = { Root: RadioRoot, Indicator: RadioIndicator };
export declare namespace Radio {
  namespace Root {
    type Props = RadioRootProps;
  }
}

interface CollapsibleState {
  open: boolean;
  disabled: boolean;
}
const CollapsibleCtx = createContext<{
  open: boolean;
  disabled: boolean;
  setOpen: (open: boolean, event: SyntheticEvent) => void;
  panelId: string;
} | null>(null);
type CollapsibleRootProps = PartProps<"div", CollapsibleState> & {
  open?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean, details: ChangeEventDetails) => void) | undefined;
  disabled?: boolean | undefined;
};
function CollapsibleRoot({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  disabled = false,
  ...props
}: CollapsibleRootProps) {
  const [open, setOwn] = useControlled(openProp, defaultOpen);
  const panelId = useId();
  const setOpen = (next: boolean, event: SyntheticEvent) => {
    const details = changeDetails("trigger-press", event);
    onOpenChange?.(next, details);
    if (!details.isCanceled) setOwn(next);
  };
  const state = { open, disabled };
  return (
    <CollapsibleCtx value={{ open, disabled, setOpen, panelId }}>
      {renderPart("div", props, state, open ? { "data-open": "" } : { "data-closed": "" })}
    </CollapsibleCtx>
  );
}
function useCollapsible() {
  const ctx = use(CollapsibleCtx);
  if (!ctx) throw new Error("Collapsible parts must render inside Collapsible.Root");
  return ctx;
}
function CollapsibleTrigger({
  nativeButton: _n,
  ...props
}: PartProps<"button", CollapsibleState> & { nativeButton?: boolean | undefined }) {
  const { open, disabled, setOpen, panelId } = useCollapsible();
  return renderPart(
    "button",
    props,
    { open, disabled },
    {
      type: "button",
      "aria-expanded": open,
      "aria-controls": panelId,
      disabled,
      ...(open ? { "data-panel-open": "" } : {}),
      onClick: (event: SyntheticEvent) => setOpen(!open, event),
    },
  );
}

type TransitionStatus = "starting" | "ending" | undefined;
/** Mount/unmount with Base UI's transition hooks: `data-starting-style` for a frame on open, `data-ending-style` until animations finish on close. */
export function useTransitionStatus(
  open: boolean,
  element: { current: HTMLElement | null },
  onDoneProp?: (open: boolean) => void,
) {
  const onDone = useEvent((value: boolean) => onDoneProp?.(value));
  const opening = useRef(false);
  const [mounted, setMounted] = useState(open);
  const [status, setStatus] = useState<TransitionStatus>(open ? undefined : undefined);
  if (open && !mounted) {
    setMounted(true);
    setStatus("starting");
  }
  if (!open && mounted && status !== "ending") setStatus("ending");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drives CSS transitions from the committed DOM.
  useLayoutEffect(() => {
    if (status === "starting") {
      opening.current = true;
      const frame = requestAnimationFrame(() => setStatus(undefined));
      return () => cancelAnimationFrame(frame);
    }
    if (status === undefined && opening.current) {
      // Report the open as complete once the transitions it started finish.
      opening.current = false;
      let cancelled = false;
      const frame = requestAnimationFrame(() => {
        const animations = element.current?.getAnimations?.({ subtree: true }) ?? [];
        void Promise.allSettled(animations.map((a) => a.finished)).then(
          () => !cancelled && onDone(true),
        );
      });
      return () => {
        cancelled = true;
        cancelAnimationFrame(frame);
      };
    }
    if (status !== "ending") return;
    let cancelled = false;
    const finish = () => {
      if (cancelled) return;
      setMounted(false);
      setStatus(undefined);
      onDone(false);
    };
    const el = element.current;
    // Let the ending style apply, then wait for the transitions it starts.
    const frame = requestAnimationFrame(() => {
      const animations = el?.getAnimations?.({ subtree: true }) ?? [];
      if (animations.length === 0) finish();
      else void Promise.allSettled(animations.map((a) => a.finished)).then(finish);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [status, element, onDone]);
  return { mounted, status };
}
/** Calls `onChange` when `el`'s children (and `el` itself) resize, following children as they change. */
function observeChildren(el: HTMLElement, self: boolean, onChange: () => void) {
  const targets = () => (self ? [el, ...el.children] : [...el.children]);
  let stop = observeResize(targets(), onChange);
  const mutations = new MutationObserver(() => {
    stop();
    stop = observeResize(targets(), onChange);
    onChange();
  });
  mutations.observe(el, { childList: true });
  return () => {
    stop();
    mutations.disconnect();
  };
}

export const transitionAttrs = (status: TransitionStatus) =>
  status === "starting"
    ? { "data-starting-style": "" }
    : status === "ending"
      ? { "data-ending-style": "" }
      : {};

function CollapsiblePanel({
  keepMounted = false,
  hiddenUntilFound = false,
  style,
  ...props
}: PartProps<"div", CollapsibleState & { transitionStatus: TransitionStatus }> & {
  keepMounted?: boolean;
  hiddenUntilFound?: boolean | undefined;
}) {
  const { open, disabled, panelId } = useCollapsible();
  const ref = useRef<HTMLDivElement | null>(null);
  const setRef = useEvent((el: HTMLDivElement | null) => {
    ref.current = el;
  });
  const { mounted, status } = useTransitionStatus(open, ref);
  const [height, setHeight] = useState<number | undefined>(undefined);
  // Measures when the content resizes rather than on every render, which forced a layout each time.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the panel's content height for the height transition.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !mounted) return;
    const measure = () => setHeight(el.scrollHeight);
    measure();
    return observeChildren(el, false, measure);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- opening or closing remeasures the content the transition runs to or from.
  }, [mounted, open]);
  if (!mounted && !keepMounted && !hiddenUntilFound) return null;
  const state = { open, disabled, transitionStatus: status };
  const varStyle = {
    "--collapsible-panel-height": height === undefined ? "auto" : `${height}px`,
  } as CSSProperties;
  return renderPart(
    "div",
    {
      ...props,
      style: (s: CollapsibleState & { transitionStatus: TransitionStatus }) => ({
        ...varStyle,
        ...(typeof style === "function" ? style(s) : style),
      }),
    },
    state,
    {
      id: panelId,
      hidden: !mounted ? (hiddenUntilFound ? "until-found" : true) : undefined,
      ...(open ? { "data-open": "" } : { "data-closed": "" }),
      ...transitionAttrs(status),
    },
    setRef,
  );
}
export const Collapsible = {
  Root: CollapsibleRoot,
  Trigger: CollapsibleTrigger,
  Panel: CollapsiblePanel,
};
export declare namespace Collapsible {
  namespace Root {
    type Props = CollapsibleRootProps;
  }
  namespace Trigger {
    type Props = Parameters<typeof CollapsibleTrigger>[0];
  }
  namespace Panel {
    type Props = Parameters<typeof CollapsiblePanel>[0];
  }
}

interface InputState {
  disabled: boolean;
  focused: boolean;
  filled: boolean;
}
type InputPartProps = PartProps<"input", InputState> & {
  onValueChange?: (value: string, details: ChangeEventDetails) => void;
};
function InputPart({ onValueChange, ...props }: InputPartProps) {
  const [focused, setFocused] = useState(false);
  const state = {
    disabled: Boolean(props.disabled),
    focused,
    filled: Boolean(props.value ?? props.defaultValue),
  };
  return renderPart("input", props, state, {
    ...stateAttributes(state),
    onChange: (event: SyntheticEvent<HTMLInputElement>) =>
      onValueChange?.(event.currentTarget.value, changeDetails("none", event)),
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
  });
}
export const Input = InputPart;
export declare namespace Input {
  type Props = InputPartProps;
}
function FieldControl({ onValueChange, ...props }: InputPartProps) {
  return renderPart(
    "input",
    props,
    { disabled: Boolean(props.disabled), focused: false, filled: false },
    {
      onChange: (event: SyntheticEvent<HTMLInputElement>) =>
        onValueChange?.(event.currentTarget.value, changeDetails("none", event)),
    },
  );
}
export const Field = { Control: FieldControl };

interface NumberFieldState {
  value: number | null;
  disabled: boolean;
  readOnly: boolean;
}
interface NumberFieldApi {
  state: NumberFieldState;
  text: string;
  edit: (text: string, event: SyntheticEvent) => void;
  commitText: (event: SyntheticEvent) => void;
  step: (direction: 1 | -1, event: SyntheticEvent | undefined, unit?: "small" | "large") => void;
  min: number | undefined;
  max: number | undefined;
  id: string | undefined;
  name: string | undefined;
  required: boolean;
}
const NumberFieldCtx = createContext<NumberFieldApi | null>(null);
type NumberFieldRootProps = Omit<
  PartProps<"div", NumberFieldState>,
  "defaultValue" | "onChange"
> & {
  value?: number | null | undefined;
  defaultValue?: number | null | undefined;
  onValueChange?: ((value: number | null, details: ChangeEventDetails) => void) | undefined;
  onValueCommitted?: ((value: number | null, details: ChangeEventDetails) => void) | undefined;
  min?: number | undefined;
  max?: number | undefined;
  step?: number | "any" | undefined;
  smallStep?: number | undefined;
  largeStep?: number | undefined;
  format?: Intl.NumberFormatOptions | undefined;
  locale?: string | undefined;
  disabled?: boolean | undefined;
  readOnly?: boolean | undefined;
  required?: boolean | undefined;
  name?: string | undefined;
};
// A NumberFormat is costly to build; fields format on every keystroke and render.
const numberFormats = new Map<string, Intl.NumberFormat>();
function numberFormat(locale: string | undefined, options?: Intl.NumberFormatOptions) {
  const key = `${locale ?? ""}\0${options ? JSON.stringify(options) : ""}`;
  let format = numberFormats.get(key);
  if (!format) numberFormats.set(key, (format = new Intl.NumberFormat(locale, options)));
  return format;
}
/** Parses text in `locale`'s number format (group and decimal separators). */
const parseNumber = (text: string, locale: string | undefined) => {
  const parts = numberFormat(locale).formatToParts(11111.1);
  const group = parts.find((p) => p.type === "group")?.value ?? ",";
  const decimal = parts.find((p) => p.type === "decimal")?.value ?? ".";
  const cleaned = text
    .split(group)
    .join("")
    .replace(decimal, ".")
    .replace(/[^\d.-]/g, "");
  return cleaned === "" || cleaned === "-" || cleaned === "." ? null : Number(cleaned);
};
function NumberFieldRoot({
  value: valueProp,
  defaultValue = null,
  onValueChange,
  onValueCommitted,
  min,
  max,
  step = 1,
  smallStep = 0.1,
  largeStep = 10,
  format,
  locale,
  disabled = false,
  readOnly = false,
  required = false,
  name,
  id,
  ...props
}: NumberFieldRootProps) {
  const [value, setValue] = useControlled(valueProp, defaultValue);
  // The input's text while the user edits it; otherwise the formatted value shows.
  const [draft, setDraft] = useState<string | null>(null);
  const formatted = value === null ? "" : numberFormat(locale, format).format(value);
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
  const change = (next: number | null, details: ChangeEventDetails) => {
    if (Object.is(next, value)) return;
    onValueChange?.(next, details);
    if (!details.isCanceled) setValue(next);
  };
  const commit = (next: number | null, event: SyntheticEvent | undefined, reason: string) => {
    const clamped = next === null || Number.isNaN(next) ? null : clamp(next);
    setDraft(null);
    change(clamped, changeDetails(reason, event));
    onValueCommitted?.(clamped, changeDetails(reason, event));
  };
  const unitFor = (unit?: "small" | "large") =>
    unit === "small" ? smallStep : unit === "large" ? largeStep : step === "any" ? 1 : step;
  const api: NumberFieldApi = {
    state: { value, disabled, readOnly },
    text: draft ?? formatted,
    edit: (text, event) => {
      setDraft(text);
      const parsed = parseNumber(text, locale);
      if (!Number.isNaN(parsed)) change(parsed, changeDetails("input-change", event));
    },
    commitText: (event) => {
      if (draft === null) return;
      commit(parseNumber(draft, locale), event, "input-blur");
    },
    step: (direction, event, unit) => {
      const size = unitFor(unit);
      const base = value ?? (direction > 0 ? (min ?? 0) - size : (max ?? 0) + size);
      commit(
        Number((base + direction * size).toFixed(10)),
        event,
        direction > 0 ? "increment-press" : "decrement-press",
      );
    },
    min,
    max,
    id,
    name,
    required,
  };
  return (
    <NumberFieldCtx value={api}>
      {renderPart("div", props, api.state, stateAttributes({ disabled, readOnly }))}
    </NumberFieldCtx>
  );
}
function useNumberField() {
  const ctx = use(NumberFieldCtx);
  if (!ctx) throw new Error("NumberField parts must render inside NumberField.Root");
  return ctx;
}
function NumberFieldGroup(props: PartProps<"div", NumberFieldState>) {
  const { state } = useNumberField();
  return renderPart("div", props, state, {
    role: "group",
    ...stateAttributes({ disabled: state.disabled }),
  });
}
function NumberFieldInput(props: PartProps<"input", NumberFieldState>) {
  const ctx = useNumberField();
  const { state } = ctx;
  return renderPart("input", props, state, {
    id: ctx.id,
    name: ctx.name,
    required: ctx.required,
    type: "text",
    inputMode: "decimal",
    autoComplete: "off",
    autoCorrect: "off",
    spellCheck: false,
    disabled: state.disabled,
    readOnly: state.readOnly,
    value: ctx.text,
    onChange: (event: SyntheticEvent<HTMLInputElement>) =>
      ctx.edit(event.currentTarget.value, event),
    onBlur: (event: SyntheticEvent<HTMLInputElement>) => ctx.commitText(event),
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      const direction = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
      if (!direction || state.readOnly) return;
      event.preventDefault();
      ctx.step(direction, event, event.shiftKey ? "large" : event.altKey ? "small" : undefined);
    },
  });
}
function NumberFieldStepper({
  direction,
  ...props
}: PartProps<"button", NumberFieldState> & { direction: 1 | -1 }) {
  const { state, step, min, max } = useNumberField();
  const limited =
    direction > 0
      ? max !== undefined && state.value !== null && state.value >= max
      : min !== undefined && state.value !== null && state.value <= min;
  const disabled = state.disabled || state.readOnly || limited;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = useEvent(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  });
  const press = useEvent((event: SyntheticEvent<HTMLButtonElement, PointerEvent>) => {
    if (event.nativeEvent.button !== 0 || disabled) return;
    event.preventDefault();
    step(direction, event);
    // Press-and-hold repeats after a short delay.
    const repeat = (delay: number) => {
      timer.current = setTimeout(() => {
        step(direction, undefined);
        repeat(60);
      }, delay);
    };
    repeat(400);
  });
  return renderPart("button", props, state, {
    type: "button",
    tabIndex: -1,
    disabled,
    ...stateAttributes({ disabled }),
    onPointerDown: press,
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
    onClick: (event: SyntheticEvent<HTMLButtonElement, MouseEvent>) => {
      // Keyboard and assistive-tech activation; pointer presses already stepped.
      if (event.nativeEvent.detail === 0) step(direction, event);
    },
  });
}
function NumberFieldIncrement(props: PartProps<"button", NumberFieldState>) {
  return <NumberFieldStepper direction={1} {...props} />;
}
function NumberFieldDecrement(props: PartProps<"button", NumberFieldState>) {
  return <NumberFieldStepper direction={-1} {...props} />;
}
export const NumberField = {
  Root: NumberFieldRoot,
  Group: NumberFieldGroup,
  Input: NumberFieldInput,
  Increment: NumberFieldIncrement,
  Decrement: NumberFieldDecrement,
};
export declare namespace NumberField {
  namespace Root {
    type Props = NumberFieldRootProps;
  }
  namespace Group {
    type Props = PartProps<"div", NumberFieldState>;
  }
  namespace Input {
    type Props = PartProps<"input", NumberFieldState>;
  }
  namespace Increment {
    type Props = PartProps<"button", NumberFieldState>;
  }
  namespace Decrement {
    type Props = PartProps<"button", NumberFieldState>;
  }
}

interface ScrollAreaApi {
  viewport: { current: HTMLDivElement | null };
  /** Mounted thumbs and their last sizes; sizes and offsets are written to the DOM directly. */
  thumbs: { y: HTMLElement | null; x: HTMLElement | null; ySize: number; xSize: number };
  overflow: { x: boolean; y: boolean };
  hovering: boolean;
  scrolling: boolean;
  update: () => void;
  setThumb: (vertical: boolean, thumb: HTMLElement | null) => void;
  markScrolling: () => void;
}
const ScrollAreaCtx = createContext<ScrollAreaApi | null>(null);
const NO_OVERFLOW = { x: false, y: false };

// One stylesheet per document instead of a <style> in every scroll area.
const styledDocuments = new WeakSet<Document>();
function ensureScrollAreaStyle(doc: Document) {
  if (styledDocuments.has(doc)) return;
  styledDocuments.add(doc);
  const style = doc.createElement("style");
  style.dataset.t3ScrollAreaStyle = "";
  style.textContent =
    "[data-scroll-area-viewport]{scrollbar-width:none}[data-scroll-area-viewport]::-webkit-scrollbar{display:none}";
  doc.head.append(style);
}

function placeThumb(thumb: HTMLElement | null, vertical: boolean, size: number, offset: number) {
  if (!thumb) return;
  thumb.style[vertical ? "height" : "width"] = `${size}px`;
  thumb.style.transform = vertical ? `translateY(${offset}px)` : `translateX(${offset}px)`;
}

/** Scrolling re-renders only when overflow, hover or the scrolling flag flips. */
function ScrollAreaRoot({ children, ...props }: PartProps<"div", object>) {
  const [overflow, setOverflow] = useState(NO_OVERFLOW);
  const [hovering, setHovering] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const [controller] = useState(() => {
    const viewport: ScrollAreaApi["viewport"] = { current: null };
    const thumbs: ScrollAreaApi["thumbs"] = { y: null, x: null, ySize: 0, xSize: 0 };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = false;
    const update = () => {
      const el = viewport.current;
      if (!el) return;
      const { scrollTop, scrollHeight, clientHeight, scrollWidth, clientWidth } = el;
      const scrollLeft = Math.abs(el.scrollLeft);
      const ySize =
        scrollHeight > clientHeight
          ? Math.max(20, (clientHeight / scrollHeight) * clientHeight)
          : 0;
      const xSize =
        scrollWidth > clientWidth ? Math.max(20, (clientWidth / scrollWidth) * clientWidth) : 0;
      thumbs.ySize = ySize;
      thumbs.xSize = xSize;
      placeThumb(
        thumbs.y,
        true,
        ySize,
        ySize ? (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - ySize) : 0,
      );
      placeThumb(
        thumbs.x,
        false,
        xSize,
        xSize ? (scrollLeft / (scrollWidth - clientWidth)) * (clientWidth - xSize) : 0,
      );
      // Overflow edges drive the fade masks.
      el.style.setProperty("--scroll-area-overflow-y-start", `${scrollTop}px`);
      el.style.setProperty(
        "--scroll-area-overflow-y-end",
        `${Math.max(0, scrollHeight - clientHeight - scrollTop)}px`,
      );
      el.style.setProperty("--scroll-area-overflow-x-start", `${scrollLeft}px`);
      el.style.setProperty(
        "--scroll-area-overflow-x-end",
        `${Math.max(0, scrollWidth - clientWidth - scrollLeft)}px`,
      );
      const x = scrollWidth > clientWidth + 1;
      const y = scrollHeight > clientHeight + 1;
      setOverflow((prev) => (prev.x === x && prev.y === y ? prev : { x, y }));
    };
    const markScrolling = () => {
      if (!active) {
        active = true;
        setScrolling(true);
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        active = false;
        setScrolling(false);
      }, 500);
    };
    const setThumb = (vertical: boolean, thumb: HTMLElement | null) => {
      thumbs[vertical ? "y" : "x"] = thumb;
      if (thumb) update();
    };
    return { viewport, thumbs, update, setThumb, markScrolling };
  });
  const api: ScrollAreaApi = { ...controller, overflow, hovering, scrolling };
  return (
    <ScrollAreaCtx value={api}>
      {renderPart(
        "div",
        { ...props, children },
        {},
        {
          onPointerEnter: () => setHovering(true),
          onPointerLeave: () => setHovering(false),
          style: { position: "relative" },
        },
      )}
    </ScrollAreaCtx>
  );
}
function useScrollArea() {
  const ctx = use(ScrollAreaCtx);
  if (!ctx) throw new Error("ScrollArea parts must render inside ScrollArea.Root");
  return ctx;
}
function ScrollAreaViewport(props: PartProps<"div", object>) {
  const { viewport, overflow, update, markScrolling } = useScrollArea();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks content and viewport size for the custom scrollbars.
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    ensureScrollAreaStyle(el.ownerDocument);
    update();
    return observeChildren(el, true, update);
  }, [viewport, update]);
  return renderPart(
    "div",
    props,
    {},
    {
      "data-scroll-area-viewport": "",
      // Focusable like Base UI's viewport: in the tab order only while it scrolls.
      tabIndex: overflow.x || overflow.y ? 0 : -1,
      ...(overflow.x ? { "data-has-overflow-x": "" } : {}),
      ...(overflow.y ? { "data-has-overflow-y": "" } : {}),
      onScroll: () => {
        update();
        markScrolling();
      },
    },
    viewport,
  );
}
const ScrollbarCtx = createContext<Orientation>("vertical");
function ScrollAreaScrollbar({
  orientation = "vertical",
  keepMounted = false,
  ...props
}: PartProps<"div", { orientation: Orientation }> & {
  orientation?: Orientation;
  keepMounted?: boolean | undefined;
}) {
  const { overflow, hovering, scrolling, viewport } = useScrollArea();
  const visible = orientation === "vertical" ? overflow.y : overflow.x;
  if (!visible && !keepMounted) return null;
  const state = { orientation };
  const vertical = orientation === "vertical";
  return (
    <ScrollbarCtx value={orientation}>
      {renderPart("div", props, state, {
        "data-orientation": orientation,
        ...(hovering ? { "data-hovering": "" } : {}),
        ...(scrolling ? { "data-scrolling": "" } : {}),
        style: vertical
          ? { position: "absolute", top: 0, bottom: 0, insetInlineEnd: 0 }
          : { position: "absolute", left: 0, right: 0, bottom: 0 },
        onPointerDown: (event: SyntheticEvent<HTMLDivElement, PointerEvent>) =>
          pageTo(viewport, vertical, event),
      })}
    </ScrollbarCtx>
  );
}
/** Clicking a scrollbar track jumps the viewport toward the pointer. */
function pageTo(
  viewport: { current: HTMLDivElement | null },
  vertical: boolean,
  event: SyntheticEvent<HTMLDivElement, PointerEvent>,
) {
  const el = viewport.current;
  if (!el || event.target !== event.currentTarget) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const ratio = vertical
    ? (event.nativeEvent.clientY - rect.top) / rect.height
    : (event.nativeEvent.clientX - rect.left) / rect.width;
  if (vertical) el.scrollTop = ratio * (el.scrollHeight - el.clientHeight);
  else el.scrollLeft = ratio * (el.scrollWidth - el.clientWidth);
}
/** Dragging a thumb scrolls the viewport proportionally. */
function dragThumb(
  viewport: { current: HTMLDivElement | null },
  vertical: boolean,
  thumbSize: number,
  event: SyntheticEvent<HTMLDivElement, PointerEvent>,
) {
  const el = viewport.current;
  if (!el) return;
  event.preventDefault();
  const start = vertical ? event.nativeEvent.clientY : event.nativeEvent.clientX;
  const startScroll = vertical ? el.scrollTop : el.scrollLeft;
  const track =
    (event.currentTarget.parentElement?.getBoundingClientRect()[vertical ? "height" : "width"] ??
      1) - thumbSize;
  const range = vertical ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
  const move = (e: PointerEvent) => {
    const delta = ((vertical ? e.clientY : e.clientX) - start) * (range / Math.max(1, track));
    if (vertical) el.scrollTop = startScroll + delta;
    else el.scrollLeft = startScroll + delta;
  };
  const up = () => {
    el.ownerDocument.removeEventListener("pointermove", move);
    el.ownerDocument.removeEventListener("pointerup", up);
  };
  el.ownerDocument.addEventListener("pointermove", move);
  el.ownerDocument.addEventListener("pointerup", up);
}
function ScrollAreaThumb(props: PartProps<"div", object>) {
  const { thumbs, viewport, setThumb } = useScrollArea();
  const orientation = use(ScrollbarCtx);
  const vertical = orientation === "vertical";
  return renderPart(
    "div",
    props,
    {},
    {
      "data-orientation": orientation,
      onPointerDown: (event: SyntheticEvent<HTMLDivElement, PointerEvent>) =>
        dragThumb(viewport, vertical, vertical ? thumbs.ySize : thumbs.xSize, event),
    },
    (el: HTMLElement | null) => setThumb(vertical, el),
  );
}
function ScrollAreaCorner(props: PartProps<"div", object>) {
  const { overflow } = useScrollArea();
  if (!overflow.x || !overflow.y) return null;
  return renderPart(
    "div",
    props,
    {},
    { style: { position: "absolute", bottom: 0, insetInlineEnd: 0 } },
  );
}
export const ScrollArea = {
  Root: ScrollAreaRoot,
  Viewport: ScrollAreaViewport,
  Scrollbar: ScrollAreaScrollbar,
  Thumb: ScrollAreaThumb,
  Corner: ScrollAreaCorner,
};
export declare namespace ScrollArea {
  namespace Root {
    type Props = PartProps<"div", object>;
  }
  namespace Scrollbar {
    type Props = Parameters<typeof ScrollAreaScrollbar>[0];
  }
}

export type { ReactNode };
