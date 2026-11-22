import { batchedUpdates } from "./reconciler.ts";

export const SVG_NS = "http://www.w3.org/2000/svg";
export const MATH_NS = "http://www.w3.org/1998/Math/MathML";

const SKIP = new Set(["children", "key", "ref", "dangerouslySetInnerHTML", "suppressHydrationWarning", "suppressContentEditableWarning", "autoFocus", "is"]);
// Preact's heuristics: CSS properties that take bare numbers, and SVG presentation attributes written in camelCase.
export const UNITLESS = /acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i;
const SVG_CAMEL = /^(?:accent|alignment|arabic|baseline|cap|clip(?!PathU)|color|dominant|fill|flood|font|glyph(?!R)|horiz|image(?!S)|letter|lighting|marker(?!H|W|U)|overline|paint|pointer|shape|stop|strikethrough|stroke|text(?!L)|transform|underline|unicode|units|v|vector|vert|word|writing|x(?!C))[A-Z]/;
const ATTR_ONLY = /^(?:width|height|href|list|form|tabIndex|download|rowSpan|colSpan|role|popover)$/;
const BOOLEANISH = /^(?:spellCheck|draggable|contentEditable)$/;
const RENAMED: Record<string, string> = { className: "class", htmlFor: "for", acceptCharset: "accept-charset", httpEquiv: "http-equiv" };
const EVENTS: Record<string, string> = { DoubleClick: "dblclick", Focus: "focusin", Blur: "focusout" };
const PASSIVE = new Set(["touchstart", "touchmove", "wheel"]);

export function attrName(name: string, svg: boolean): string {
  name = RENAMED[name] ?? name;
  if (!svg) return name;
  if (name.startsWith("xlink") || name.startsWith("xml")) return name.replace(/^(xlink|xml)(?::)?([A-Z])/, (_, ns, c) => `${ns}:${c.toLowerCase()}`);
  return SVG_CAMEL.test(name) ? name.replace(/[A-Z]/g, "-$&").toLowerCase() : name;
}

export const styleValue = (k: string, v: unknown) =>
  v == null || typeof v === "boolean" ? "" : typeof v === "number" && v !== 0 && !UNITLESS.test(k) ? `${v}px` : String(v);

export const isEventProp = (name: string) => name[0] === "o" && name[1] === "n" && name.charCodeAt(2) < 97;

export function diffProps(dom: any, type: string, old: any, props: any, svg: boolean): void {
  for (const k in old) if (!(k in props) && !SKIP.has(k)) setProp(dom, type, k, null, old[k], props, svg);
  for (const k in props) {
    const v = props[k];
    if (!SKIP.has(k) && (v !== old[k] || k === "value" || k === "checked")) setProp(dom, type, k, v, old[k], props, svg);
  }
}

function setProp(dom: any, type: string, name: string, value: any, old: any, props: any, svg: boolean) {
  if (name === "style") return setStyle(dom.style, value, old);
  if (isEventProp(name)) return setEvent(dom, type, name, value, props);
  if (type === "select" && name === "value") return; // applied after the options exist
  if ((name === "value" || name === "checked") && (type === "input" || type === "textarea" || type === "select")) {
    if (!dom.__c) {
      dom.__c = true;
      dom.addEventListener(type === "input" && /^(?:checkbox|radio)$/i.test(props.type) ? "change" : "input", restoreSoon);
    }
    if (value == null) return;
    return name === "value" ? setValue(dom, value) : void (dom.checked = !!value);
  }
  if (!svg && name !== "className" && name in dom && !ATTR_ONLY.test(name)) {
    try {
      dom[name] = value == null ? "" : value;
      if (value == null || value === false) dom.removeAttribute?.(name);
      return;
    } catch {}
  }
  if (name === "className" && !svg) return void (dom.className = value ?? "");
  const attr = attrName(name, svg);
  if (typeof value === "function" || typeof value === "symbol") return;
  if (value == null || (value === false && attr[4] !== "-" && !BOOLEANISH.test(name))) dom.removeAttribute(attr);
  else dom.setAttribute(attr, value === true && !BOOLEANISH.test(name) && attr[4] !== "-" ? "" : String(value));
}

function setStyle(style: any, value: any, old: any) {
  if (typeof value === "string") return void (style.cssText = value);
  if (typeof old === "string") (style.cssText = ""), (old = null);
  for (const k in old) if (!value || !(k in value)) setStyleProp(style, k, null);
  for (const k in value) if (!old || value[k] !== old[k]) setStyleProp(style, k, value[k]);
}

const setStyleProp = (style: any, k: string, v: unknown) =>
  k[0] === "-" ? style.setProperty(k, v == null ? "" : String(v)) : (style[k] = styleValue(k, v));

export function setValue(dom: any, value: unknown): void {
  const next = value == null ? "" : String(value);
  if (dom.value === next) return;
  const focused = dom.ownerDocument?.activeElement === dom;
  const start = focused ? dom.selectionStart : null;
  const end = focused ? dom.selectionEnd : null;
  dom.value = next;
  if (start != null) dom.setSelectionRange?.(Math.min(start, next.length), Math.min(end, next.length));
}

export function setSelect(dom: any, value: unknown, multiple: boolean): void {
  const wanted = new Set((multiple && Array.isArray(value) ? value : [value]).map(String));
  const walk = (node: any) => {
    for (let c = node.firstChild; c; c = c.nextSibling) c.nodeName === "OPTION" ? (c.selected = wanted.has(c.value)) : walk(c);
  };
  walk(dom);
}

function restore(dom: any) {
  const props = dom.__f?.props;
  if (!props) return;
  if (dom.nodeName === "SELECT") props.value !== undefined && setSelect(dom, props.value, props.multiple);
  else if (props.checked != null) dom.checked = !!props.checked;
  else if (props.value != null) setValue(dom, props.value);
}
// Runs after every handler for the event has committed, so a controlled field shows exactly its state.
function restoreSoon(this: any) {
  queueMicrotask(() => restore(this));
}

function setEvent(dom: any, type: string, name: string, value: any, props: any) {
  const capture = name.endsWith("Capture") && name !== "onGotPointerCapture" && name !== "onLostPointerCapture";
  const base = capture ? name.slice(2, -7) : name.slice(2);
  const event =
    EVENTS[base] ??
    (base === "Change" && (type === "textarea" || (type === "input" && !/^(?:checkbox|radio|file)$/i.test(props.type))) ? "input" : base.toLowerCase());
  const slot = capture ? `${event}C` : event;
  const listeners = (dom.__l ??= {});
  if (!listeners[slot] && value) dom.addEventListener(event, capture ? proxyCapture : proxy, { capture, passive: PASSIVE.has(event) });
  else if (listeners[slot] && !value) dom.removeEventListener(event, capture ? proxyCapture : proxy, { capture });
  listeners[slot] = value || undefined;
}

function isDefaultPrevented(this: Event) {
  return this.defaultPrevented;
}
function isPropagationStopped(this: Event) {
  return this.cancelBubble;
}
const noop = () => {};

function dispatch(el: any, e: any, slot: string) {
  const handler = el.__l?.[slot];
  if (!handler) return;
  if (!e.nativeEvent) Object.assign(e, { nativeEvent: e, persist: noop, isDefaultPrevented, isPropagationStopped });
  batchedUpdates(handler, e);
}
function proxy(this: any, e: Event) {
  dispatch(this, e, e.type);
}
function proxyCapture(this: any, e: Event) {
  dispatch(this, e, `${e.type}C`);
}
