import {
  createContext,
  use,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import {
  partsFor,
  RootView,
  usePopup,
  usePopupRoot,
  type PopupPartProps,
  type PositionerProps,
  type RootProps,
} from "./popups";

const popupParts = partsFor("combobox");
import {
  changeDetails,
  renderPart,
  useControlled,
  useEvent,
  type ChangeEventDetails,
  type PartProps,
} from "./primitives";

/** Base UI's `useFilter`: locale-aware, case- and accent-insensitive matching. */
function createFilter(options: Intl.CollatorOptions & { locale?: string | undefined } = {}) {
  const collator = new Intl.Collator(options.locale, {
    usage: "search",
    sensitivity: "base",
    ...options,
  });
  const normalize = (text: string) => text.normalize("NFD");
  const test =
    (mode: "contains" | "startsWith" | "endsWith") =>
    <T,>(item: T, query: string, toString?: (item: T) => string): boolean => {
      const text = normalize(toString ? toString(item) : String(item));
      const needle = normalize(query);
      if (!needle) return true;
      const n = needle.length;
      if (mode === "startsWith") return collator.compare(text.slice(0, n), needle) === 0;
      if (mode === "endsWith") return collator.compare(text.slice(-n), needle) === 0;
      for (let i = 0; i + n <= text.length; i++)
        if (collator.compare(text.slice(i, i + n), needle) === 0) return true;
      return false;
    };
  return { contains: test("contains"), startsWith: test("startsWith"), endsWith: test("endsWith") };
}

type HighlightReason = "keyboard" | "pointer" | "none";
interface ListApi {
  kind: "combobox" | "autocomplete";
  query: string;
  setQuery: (query: string, event: SyntheticEvent | undefined, reason: string) => void;
  items: readonly unknown[];
  filtered: readonly unknown[];
  virtualized: boolean;
  highlighted: { value: unknown; index: number } | null;
  highlight: (value: unknown, index: number, reason: HighlightReason) => void;
  move: (delta: 1 | -1 | "first" | "last", event: KeyboardEvent) => void;
  select: (value: unknown, event: SyntheticEvent) => void;
  isSelected: (value: unknown) => boolean;
  label: (value: unknown) => string;
  equal: (a: unknown, b: unknown) => boolean;
  listId: string;
  optionId: (index: number) => string;
  list: { current: HTMLElement | null };
  setList: (el: HTMLElement | null) => void;
  elements: Map<unknown, HTMLElement>;
  inline: boolean;
  hoverHighlights: boolean;
  disabled: boolean;
  value: unknown;
  clear: (event: SyntheticEvent) => void;
}
const ListCtx = createContext<ListApi | null>(null);
function useList() {
  const ctx = use(ListCtx);
  if (!ctx) throw new Error("Combobox parts must render inside their Root");
  return ctx;
}
const GroupItemsCtx = createContext<readonly unknown[] | null>(null);
const ItemIndexCtx = createContext<number | undefined>(undefined);
// Stable React keys for items: objects get an id, primitives key by value.
const objectKeys = new WeakMap<object, string>();
let nextObjectKey = 0;
const keyOf = (item: unknown) => {
  if (typeof item !== "object" || item === null) return String(item);
  let key = objectKeys.get(item);
  if (!key) objectKeys.set(item, (key = `item-${++nextObjectKey}`));
  return key;
};

type ListRootProps<V = any> = Omit<RootProps, "children"> & {
  items?: readonly V[] | undefined;
  filteredItems?: readonly V[] | undefined;
  filter?: ((item: V, query: string, toString?: (item: V) => string) => boolean) | null | undefined;
  limit?: number | undefined;
  itemToStringLabel?: ((item: V) => string) | undefined;
  itemToStringValue?: ((item: V) => string) | undefined;
  isItemEqualToValue?: ((item: V, value: V) => boolean) | undefined;
  value?: any;
  defaultValue?: any;
  onValueChange?: ((value: any, details: ChangeEventDetails) => void) | undefined;
  inputValue?: string | undefined;
  defaultInputValue?: string | undefined;
  onInputValueChange?: ((value: string, details: ChangeEventDetails) => void) | undefined;
  autoHighlight?: boolean | "always" | undefined;
  keepHighlight?: boolean | undefined;
  highlightItemOnHover?: boolean | undefined;
  onItemHighlighted?:
    | ((value: V | undefined, details: { index: number; reason: HighlightReason }) => void)
    | undefined;
  inline?: boolean | undefined;
  multiple?: boolean | undefined;
  virtualized?: boolean | undefined;
  mode?: "list" | "both" | "inline" | "none" | undefined;
  openOnInputClick?: boolean | undefined;
  readOnly?: boolean | undefined;
  required?: boolean | undefined;
  name?: string | undefined;
  submitOnItemClick?: boolean | undefined;
  grid?: boolean | undefined;
  loopFocus?: boolean | undefined;
  locale?: string | undefined;
  children?: ReactNode;
};

const defaultLabel = (item: unknown): string =>
  item && typeof item === "object" && "label" in item
    ? String((item as { label: unknown }).label)
    : item === null || item === undefined
      ? ""
      : String(item);

function useListRoot(kind: ListApi["kind"], props: ListRootProps) {
  const {
    items = [],
    filteredItems,
    filter,
    limit,
    itemToStringLabel,
    itemToStringValue,
    isItemEqualToValue,
    value: valueProp,
    defaultValue,
    onValueChange,
    inputValue,
    defaultInputValue = "",
    onInputValueChange,
    autoHighlight = false,
    keepHighlight: _k,
    highlightItemOnHover = true,
    onItemHighlighted,
    inline = false,
    multiple = false,
    virtualized = false,
    mode = "list",
    openOnInputClick: _o,
    readOnly: _r,
    required: _req,
    name: _n,
    submitOnItemClick: _s,
    grid: _g,
    loopFocus = true,
    locale,
    children: _c,
    ...rootProps
  } = props;
  const popup = usePopupRoot(
    "combobox",
    { ...rootProps, ...(inline ? { open: true } : {}) },
    { modal: false, delay: 0, closeDelay: 0 },
  );
  const [value, setValue] = useControlled<unknown>(
    valueProp,
    defaultValue ?? (kind === "autocomplete" ? "" : multiple ? [] : null),
  );
  const [ownQuery, setOwnQuery] = useControlled(inputValue, defaultInputValue);
  // A single-select combobox's input shows the selected label until the user types.
  const [typing, setTyping] = useState(false);
  const label = (item: unknown) =>
    item === null || item === undefined
      ? ""
      : itemToStringLabel
        ? itemToStringLabel(item)
        : defaultLabel(item);
  const mirrorsSelection = kind === "combobox" && !multiple && inputValue === undefined && !typing;
  const query =
    kind === "autocomplete" ? String(value ?? "") : mirrorsSelection ? label(value) : ownQuery;
  // The mirrored label is a display, not a filter.
  const filterQuery = mirrorsSelection ? "" : query;
  // Closing without a pick puts the selected label back.
  if (typing && !popup.open && !inline) setTyping(false);
  const equal = (a: unknown, b: unknown) =>
    a === null || a === undefined || b === null || b === undefined
      ? a === b
      : isItemEqualToValue
        ? isItemEqualToValue(a, b)
        : Object.is(a, b);
  const contains = createFilter({ locale }).contains;
  const filtered = (() => {
    if (filteredItems) return filteredItems;
    const shown =
      mode === "none" || filter === null || !filterQuery
        ? items
        : items.filter((item) => (filter ?? contains)(item, filterQuery, label));
    return limit === undefined ? shown : shown.slice(0, limit);
  })();
  const [highlighted, setHighlighted] = useState<{ value: unknown; index: number } | null>(null);
  const list = useRef<HTMLElement | null>(null);
  const [elements] = useState(() => new Map<unknown, HTMLElement>());
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  const highlight = (item: unknown, index: number, reason: HighlightReason) => {
    reported.current = item;
    setHighlighted(index < 0 ? null : { value: item, index });
    onItemHighlighted?.(index < 0 ? undefined : item, { index, reason });
  };
  // "always" keeps the first item highlighted as results change.
  // autoHighlight puts the first result under the cursor while a query is typed ("always": even when empty).
  const autoFirst =
    (autoHighlight === "always" || (autoHighlight && filterQuery !== "")) && filtered.length > 0;
  const effectiveHighlight =
    highlighted && filtered.some((item) => equal(item, highlighted.value))
      ? highlighted
      : autoFirst
        ? { value: filtered[0], index: 0 }
        : virtualized
          ? highlighted
          : null;
  const reported = useRef<unknown>(undefined);
  const reportHighlight = useEvent(() => {
    const value = effectiveHighlight?.value;
    if (Object.is(value, reported.current) || highlighted) return;
    reported.current = value;
    onItemHighlighted?.(value, { index: effectiveHighlight?.index ?? -1, reason: "none" });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports a highlight derived from new results.
  useLayoutEffect(() => reportHighlight());
  // DOM order of rendered options, or the filtered items when an external virtualizer renders them.
  const navigable = (): Array<{ value: unknown; index: number }> => {
    if (virtualized || !list.current) return filtered.map((v, index) => ({ value: v, index }));
    return [
      ...list.current.querySelectorAll<HTMLElement>('[role="option"]:not([data-disabled])'),
    ].map((el, index) => ({ value: [...elements].find(([, node]) => node === el)?.[0], index }));
  };
  const move = (delta: 1 | -1 | "first" | "last", event: KeyboardEvent) => {
    const all = navigable();
    if (all.length === 0) return;
    const current = effectiveHighlight
      ? all.findIndex((entry) => equal(entry.value, effectiveHighlight.value))
      : -1;
    let next =
      delta === "first"
        ? 0
        : delta === "last"
          ? all.length - 1
          : current === -1
            ? delta > 0
              ? 0
              : all.length - 1
            : current + delta;
    if (next < 0 || next >= all.length)
      next = loopFocus
        ? (next + all.length) % all.length
        : Math.max(0, Math.min(all.length - 1, next));
    const entry = all[next]!;
    highlight(entry.value, entry.index, "keyboard");
    elements.get(entry.value)?.scrollIntoView({ block: "nearest" });
    event.preventDefault();
  };
  const isSelected = (item: unknown) =>
    multiple && Array.isArray(value)
      ? value.some((v) => equal(item, v))
      : kind === "combobox" && equal(item, value);
  const setQuery = (next: string, event: SyntheticEvent | undefined, reason: string) => {
    const details = changeDetails(reason, event);
    if (kind === "autocomplete") {
      onValueChange?.(next, details);
      if (!details.isCanceled) setValue(next);
    } else {
      onInputValueChange?.(next, details);
      if (!details.isCanceled) {
        setOwnQuery(next);
        setTyping(reason === "input-change");
      }
    }
    if (reason === "input-change") {
      if (!popup.open && !inline) popup.setOpen(true, event, "input-change");
      // The next render derives the auto highlight from the new results.
      setHighlighted(null);
    }
  };
  const select = (item: unknown, event: SyntheticEvent) => {
    const details = changeDetails("item-press", event);
    if (kind === "autocomplete") {
      if (mode !== "none") {
        onValueChange?.(itemToStringValue ? itemToStringValue(item) : label(item), details);
        if (!details.isCanceled)
          setValue(itemToStringValue ? itemToStringValue(item) : label(item));
      }
    } else {
      const next = multiple
        ? isSelected(item)
          ? (value as unknown[]).filter((v) => !equal(item, v))
          : [...((value as unknown[]) ?? []), item]
        : item;
      onValueChange?.(next, details);
      if (!details.isCanceled) {
        setValue(next);
        if (!multiple && inputValue === undefined) {
          setOwnQuery("");
          setTyping(false);
        }
      }
    }
    if (!multiple && !inline) popup.setOpen(false, event, "item-press");
  };
  const clear = (event: SyntheticEvent) => {
    if (kind === "combobox") {
      const details = changeDetails("clear-press", event);
      onValueChange?.(multiple ? [] : null, details);
      if (!details.isCanceled) setValue(multiple ? [] : null);
    }
    setQuery("", event, "clear-press");
  };
  const api: ListApi = {
    kind,
    query,
    setQuery,
    items,
    filtered,
    virtualized,
    highlighted: effectiveHighlight,
    highlight,
    move,
    select,
    isSelected,
    label,
    equal,
    listId,
    optionId,
    list,
    setList: (el) => {
      list.current = el;
    },
    elements,
    inline,
    hoverHighlights: highlightItemOnHover,
    disabled: Boolean(rootProps.disabled),
    value,
    clear,
  };
  return { popup, api };
}

function ListRoot(kind: ListApi["kind"]) {
  return function Root(props: ListRootProps) {
    const { popup, api } = useListRoot(kind, props);
    return (
      <ListCtx value={api}>
        <RootView api={popup}>{props.children}</RootView>
      </ListCtx>
    );
  };
}

type InputProps = Omit<
  PartProps<"input", { open: boolean; disabled: boolean }>,
  "value" | "defaultValue"
> & { value?: string | undefined };
function ListInput({ value: valueProp, ...props }: InputProps) {
  const list = useList();
  const popup = usePopup("combobox");
  const active = list.highlighted;
  const onKey = useEvent((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!popup.open && !list.inline) {
        popup.setOpenType("keyboard");
        popup.setOpen(true, event, "list-navigation");
      }
      list.move(event.key === "ArrowDown" ? 1 : -1, event);
    } else if ((event.key === "Home" || event.key === "End") && event.ctrlKey)
      list.move(event.key === "Home" ? "first" : "last", event);
    else if (event.key === "Enter" && active) {
      event.preventDefault();
      const el = list.elements.get(active.value);
      if (el) el.click();
      else list.select(active.value, event);
    }
  });
  return renderPart(
    "input",
    props,
    { open: popup.open, disabled: list.disabled },
    {
      role: "combobox",
      type: "text",
      autoComplete: "off",
      "aria-autocomplete": "list",
      "aria-expanded": popup.open,
      "aria-controls": list.listId,
      "aria-activedescendant": active ? list.optionId(active.index) : undefined,
      disabled: list.disabled,
      value: valueProp ?? list.query,
      onChange: (event: SyntheticEvent<HTMLInputElement>) =>
        list.setQuery(event.currentTarget.value, event, "input-change"),
      onKeyDown: onKey,
      ...(popup.open ? { "data-popup-open": "" } : {}),
    },
    (el: HTMLElement | null) => {
      if (!el) return;
      // An input outside the popup anchors it; one inside makes the popup a dialog.
      const inside = el.closest("[data-side]") !== null;
      if (inside) popup.setInnerInput(true);
      else popup.setTrigger(el);
    },
  );
}
function ListTrigger({
  nativeButton: _n,
  ...props
}: PartProps<"button", { open: boolean; disabled: boolean }> & {
  nativeButton?: boolean | undefined;
}) {
  const popup = usePopup("combobox");
  const list = useList();
  return renderPart(
    "button",
    props,
    { open: popup.open, disabled: list.disabled },
    {
      type: "button",
      role: "combobox",
      tabIndex: props.render ? undefined : -1,
      "aria-haspopup": "listbox",
      "aria-expanded": popup.open,
      disabled: list.disabled,
      ...(popup.open ? { "data-popup-open": "" } : {}),
      onPointerDown: (event: ReactPointerEvent) => {
        popup.setOpenType((event.pointerType as "mouse") || "mouse");
      },
      onClick: (event: MouseEvent) => popup.setOpen(!popup.open, event, "trigger-press"),
    },
    (el: HTMLElement | null) => {
      if (el) popup.setTrigger(el);
    },
  );
}
function ListPopup(props: PopupPartProps) {
  return <popupParts.Popup {...props} />;
}
function ListList({
  children,
  ...props
}: Omit<PartProps<"div", object>, "children"> & {
  children?: ReactNode | ((item: any, index: number) => ReactNode);
}) {
  const list = useList();
  const content =
    typeof children === "function"
      ? list.filtered.map((item, index) => (
          <ItemIndexCtx key={keyOf(item)} value={index}>
            {children(item, index)}
          </ItemIndexCtx>
        ))
      : children;
  if (list.filtered.length === 0 && typeof children === "function") return null;
  return renderPart(
    "div",
    { ...props, children: content },
    {},
    { id: list.listId, role: "listbox", "data-list-root": "" },
    list.setList,
  );
}
function ListCollection({ children }: { children: (item: any, index: number) => ReactNode }) {
  const list = useList();
  const groupItems = use(GroupItemsCtx);
  const source = groupItems ?? list.filtered;
  const visible =
    groupItems && !list.virtualized
      ? source.filter((item) => list.filtered.some((f) => list.equal(f, item)))
      : source;
  return (
    <>
      {visible.map((item, i) => (
        <ItemIndexCtx key={keyOf(item)} value={groupItems ? undefined : i}>
          {children(item, i)}
        </ItemIndexCtx>
      ))}
    </>
  );
}
const ItemCtx = createContext({ selected: false, highlighted: false, disabled: false });
type ItemProps = PartProps<
  "div",
  { selected: boolean; highlighted: boolean; disabled: boolean }
> & {
  value: unknown;
  index?: number | undefined;
  disabled?: boolean | undefined;
  nativeButton?: boolean | undefined;
};
function ListItem({
  value,
  index: indexProp,
  disabled = false,
  nativeButton: _n,
  ...props
}: ItemProps) {
  const list = useList();
  const contextIndex = use(ItemIndexCtx);
  const index =
    indexProp ?? contextIndex ?? list.filtered.findIndex((item) => list.equal(item, value));
  const highlighted = Boolean(list.highlighted && list.equal(list.highlighted.value, value));
  const selected = list.isSelected(value);
  const state = { selected, highlighted, disabled };
  return (
    <ItemCtx value={state}>
      {renderPart(
        "div",
        props,
        state,
        {
          id: list.optionId(index),
          role: "option",
          "aria-selected": highlighted || selected,
          "aria-disabled": disabled || undefined,
          ...(highlighted ? { "data-highlighted": "" } : {}),
          ...(selected ? { "data-selected": "" } : {}),
          ...(disabled ? { "data-disabled": "" } : {}),
          onPointerMove: () => {
            if (list.hoverHighlights && !disabled && !highlighted)
              list.highlight(value, index, "pointer");
          },
          // Keep focus in the input.
          onMouseDown: (event: MouseEvent) => event.preventDefault(),
          onClick: (event: MouseEvent) => {
            if (!disabled) list.select(value, event);
          },
        },
        (el: HTMLElement | null) => {
          if (el) list.elements.set(value, el);
          else if (list.elements.get(value)?.isConnected === false) list.elements.delete(value);
        },
      )}
    </ItemCtx>
  );
}
function ListItemIndicator({
  keepMounted = false,
  ...props
}: PartProps<"span", object> & { keepMounted?: boolean | undefined }) {
  const item = use(ItemCtx);
  if (!keepMounted && !item.selected) return null;
  return renderPart("span", props, {}, { "aria-hidden": true });
}
function ListEmpty(props: PartProps<"div", object>) {
  const list = useList();
  return renderPart(
    "div",
    { ...props, children: list.filtered.length === 0 ? props.children : null },
    {},
    {},
  );
}
function ListStatus(props: PartProps<"div", object>) {
  return renderPart(
    "div",
    props,
    {},
    { role: "status", "aria-live": "polite", "aria-atomic": true },
  );
}
function ListClear({
  nativeButton: _n,
  keepMounted: _k,
  ...props
}: PartProps<"button", object> & {
  nativeButton?: boolean | undefined;
  keepMounted?: boolean | undefined;
}) {
  const list = useList();
  return renderPart(
    "button",
    props,
    {},
    {
      type: "button",
      tabIndex: -1,
      "aria-label": props["aria-label"],
      onClick: (event: SyntheticEvent) => list.clear(event),
    },
  );
}
function ListIcon(props: PartProps<"span", object>) {
  return renderPart("span", props, {}, { "aria-hidden": true });
}
function ListGroup({
  items,
  ...props
}: PartProps<"div", object> & { items?: readonly unknown[] | undefined }) {
  const labelId = useId();
  return (
    <GroupLabelCtx value={labelId}>
      <GroupItemsCtx value={items ?? null}>
        {renderPart("div", props, {}, { role: "group", "aria-labelledby": labelId })}
      </GroupItemsCtx>
    </GroupLabelCtx>
  );
}
const GroupLabelCtx = createContext<string | undefined>(undefined);
function ListGroupLabel(props: PartProps<"div", object>) {
  return renderPart("div", props, {}, { id: use(GroupLabelCtx) });
}
function ListSeparator(props: PartProps<"div", object>) {
  return renderPart("div", props, {}, { role: "separator" });
}

const parts = {
  Input: ListInput,
  Trigger: ListTrigger,
  Portal: popupParts.Portal,
  Positioner: popupParts.Positioner,
  Popup: ListPopup,
  List: ListList,
  Collection: ListCollection,
  Item: ListItem,
  ItemIndicator: ListItemIndicator,
  Empty: ListEmpty,
  Status: ListStatus,
  Clear: ListClear,
  Icon: ListIcon,
  Group: ListGroup,
  GroupLabel: ListGroupLabel,
  Separator: ListSeparator,
  useFilter: createFilter,
};
export const Combobox = { Root: ListRoot("combobox"), ...parts };
export const Autocomplete = { Root: ListRoot("autocomplete"), ...parts };
export declare namespace Combobox {
  namespace Root {
    type Props<V = any, _M = false> = ListRootProps<V>;
  }
  namespace Input {
    type Props = InputProps;
  }
  namespace Trigger {
    type Props = Parameters<typeof ListTrigger>[0];
  }
  namespace Positioner {
    type Props = PositionerProps;
  }
  namespace Popup {
    type Props = PopupPartProps;
  }
  namespace List {
    type Props = Parameters<typeof ListList>[0];
  }
  namespace Collection {
    type Props = Parameters<typeof ListCollection>[0];
  }
  namespace Item {
    type Props = ItemProps;
  }
  namespace Empty {
    type Props = PartProps<"div", object>;
  }
  namespace Status {
    type Props = PartProps<"div", object>;
  }
  namespace Clear {
    type Props = Parameters<typeof ListClear>[0];
  }
  namespace Group {
    type Props = Parameters<typeof ListGroup>[0];
  }
  namespace GroupLabel {
    type Props = PartProps<"div", object>;
  }
}
export declare namespace Autocomplete {
  namespace Root {
    type Props<V = any> = ListRootProps<V>;
  }
  namespace Input {
    type Props = InputProps;
  }
  namespace Trigger {
    type Props = Parameters<typeof ListTrigger>[0];
  }
  namespace Positioner {
    type Props = PositionerProps;
  }
  namespace Popup {
    type Props = PopupPartProps;
  }
  namespace List {
    type Props = Parameters<typeof ListList>[0];
  }
  namespace Collection {
    type Props = Parameters<typeof ListCollection>[0];
  }
  namespace Item {
    type Props = ItemProps;
  }
  namespace Empty {
    type Props = PartProps<"div", object>;
  }
  namespace Clear {
    type Props = Parameters<typeof ListClear>[0];
  }
  namespace Group {
    type Props = Parameters<typeof ListGroup>[0];
  }
  namespace GroupLabel {
    type Props = PartProps<"div", object>;
  }
}
