import { attrName, isEventProp, styleValue } from "./dom.ts";
import { CONSUMER, CONTEXT, FORWARD_REF, Fragment, MEMO, PORTAL, Profiler, StrictMode, Suspense } from "./jsx-runtime.ts";
import { renderServerComponent, serverContextFiber, withoutRef } from "./reconciler.ts";

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const ESCAPE = /["&'<>]/;
const ENTITIES: Record<string, string> = { '"': "&quot;", "&": "&amp;", "'": "&#x27;", "<": "&lt;", ">": "&gt;" };
const escape = (s: string) => (ESCAPE.test(s) ? s.replace(/["&'<>]/g, (c) => ENTITIES[c]!) : s);
const SKIP = new Set(["children", "key", "ref", "dangerouslySetInnerHTML", "suppressHydrationWarning", "suppressContentEditableWarning", "defaultValue", "defaultChecked", "autoFocus"]);

const CSS_NAMES = new Map<string, string>();
const HTML_ATTRS = new Map<string, string>();
const cache = (map: Map<string, string>, k: string, v: string) => (map.set(k, v), v);
const cssName = (k: string) =>
  CSS_NAMES.get(k) ?? cache(CSS_NAMES, k, k[0] === "-" ? k : k.replace(/[A-Z]/g, "-$&").toLowerCase().replace(/^ms-/, "-ms-"));

export const renderToString = (node: unknown): string => render(node, Object.create(null), false, undefined);
export const renderToStaticMarkup = renderToString;

function render(node: any, ctx: any, svg: boolean, selectValue: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string") return escape(node);
  if (typeof node === "number" || typeof node === "bigint") return String(node);
  if (Array.isArray(node)) {
    let out = "";
    for (const child of node) out += render(child, ctx, svg, selectValue);
    return out;
  }
  const { type, props } = node;
  if (typeof type === "string") return renderHost(type, props, ctx, svg || type === "svg", selectValue);
  if (type === Fragment || type === StrictMode || type === Profiler) return render(props.children, ctx, svg, selectValue);
  if (type === PORTAL) return "";
  if (type === Suspense) {
    try {
      return render(props.children, ctx, svg, selectValue);
    } catch (e: any) {
      if (typeof e?.then !== "function") throw e;
      return render(props.fallback, ctx, svg, selectValue);
    }
  }
  let inner = type;
  if (inner.$$typeof === MEMO) inner = inner.type;
  if (inner.$$typeof === CONTEXT) {
    const next = Object.create(ctx);
    next[inner._id] = serverContextFiber(props.value);
    return render(props.children, next, svg, selectValue);
  }
  if (inner.$$typeof === CONSUMER) {
    const c = inner._context;
    return render(props.children(c._id in ctx ? ctx[c._id].props.value : c._currentValue), ctx, svg, selectValue);
  }
  if (inner.$$typeof === FORWARD_REF) {
    const fn = inner.render;
    return render(renderServerComponent((p) => fn(withoutRef(p), p.ref ?? null), props, ctx), ctx, svg, selectValue);
  }
  if (inner.prototype?.isReactComponent) {
    const p = withoutRef(props);
    const c = inner.contextType;
    const inst = new inner(p, c && (c._id in ctx ? ctx[c._id].props.value : c._currentValue));
    inst.props = p;
    const derived = inner.getDerivedStateFromProps?.(p, inst.state);
    if (derived != null) inst.state = { ...inst.state, ...derived };
    return render(inst.render(), ctx, svg, selectValue);
  }
  return render(renderServerComponent(inner, props, ctx), ctx, svg, selectValue);
}

function renderHost(type: string, props: any, ctx: any, svg: boolean, selectValue: unknown): string {
  let out = `<${type}`;
  for (const k in props) {
    let v = props[k];
    if (SKIP.has(k) || isEventProp(k) || v == null || typeof v === "function") continue;
    if (k === "value" && (type === "textarea" || type === "select")) continue;
    if (k === "style" && typeof v === "object") {
      let css = "";
      for (const s in v) {
        const value = styleValue(s, v[s]);
        if (value) css += `${css ? ";" : ""}${cssName(s)}:${value}`;
      }
      if (!css) continue;
      v = css;
    }
    const name = svg ? attrName(k, true) : (HTML_ATTRS.get(k) ?? cache(HTML_ATTRS, k, attrName(k, false)));
    if (v === false && name[4] !== "-" && !/^(?:spellCheck|draggable|contentEditable)$/.test(k)) continue;
    out += v === true && name[4] !== "-" ? ` ${name}=""` : ` ${name}="${escape(String(v))}"`;
  }
  if (type === "input" && props.value == null && props.defaultValue != null) out += ` value="${escape(String(props.defaultValue))}"`;
  if (type === "input" && props.checked == null && props.defaultChecked) out += ` checked=""`;
  if (type === "option" && selectValue !== undefined) {
    const value = props.value ?? (typeof props.children === "string" ? props.children : "");
    const selected = Array.isArray(selectValue) ? selectValue.map(String).includes(String(value)) : String(selectValue) === String(value);
    if (selected) out += ` selected=""`;
  }
  if (VOID.has(type)) return `${out}/>`;
  out += ">";
  const html = props.dangerouslySetInnerHTML?.__html;
  if (html != null) out += html;
  else if (type === "textarea") out += escape(String(props.value ?? props.defaultValue ?? props.children ?? ""));
  else {
    const nextSelect = type === "select" ? (props.value ?? props.defaultValue) : type === "option" ? undefined : selectValue;
    out += render(props.children, ctx, svg && type !== "foreignObject", nextSelect);
  }
  return `${out}</${type}>`;
}
