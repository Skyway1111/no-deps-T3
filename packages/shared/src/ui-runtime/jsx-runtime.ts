// Elements use React 19's shape and symbols so libraries that inspect `$$typeof`/`props.ref` keep working.
export const ELEMENT = Symbol.for("react.transitional.element");
export const Fragment = Symbol.for("react.fragment");
export const PORTAL = Symbol.for("react.portal");
export const Suspense = Symbol.for("react.suspense");
export const StrictMode = Symbol.for("react.strict_mode");
export const Profiler = Symbol.for("react.profiler");
export const CONTEXT = Symbol.for("react.context");
export const CONSUMER = Symbol.for("react.consumer");
export const MEMO = Symbol.for("react.memo");
export const FORWARD_REF = Symbol.for("react.forward_ref");

export type Key = string | number | bigint | null;
export interface VNode {
  $$typeof: symbol;
  type: any;
  key: string | null;
  props: any;
}

const make = (type: any, key: unknown, props: any): VNode => {
  const defaults = type?.defaultProps;
  if (defaults) for (const k in defaults) if (props[k] === undefined) props[k] = defaults[k];
  return { $$typeof: ELEMENT, type, key: key == null ? null : String(key), props };
};

export function jsx(type: any, config: any, maybeKey?: Key): VNode {
  let props = config;
  let key = maybeKey;
  if ("key" in config) {
    props = {};
    for (const k in config) if (k === "key") key = config.key;
    else props[k] = config[k];
  }
  return make(type, key, props);
}
export { jsx as jsxs, jsx as jsxDEV };

export function createElement(type: any, config?: any, ...children: any[]): VNode {
  const props: any = {};
  let key: unknown = null;
  for (const k in config) if (k === "key") key = config.key;
  else if (k !== "__self" && k !== "__source") props[k] = config[k];
  if (children.length) props.children = children.length === 1 ? children[0] : children;
  return make(type, key, props);
}

export function cloneElement(element: VNode, config?: any, ...children: any[]): VNode {
  const props = { ...element.props };
  let key: unknown = element.key;
  for (const k in config) if (k === "key") key = config.key;
  else if (config[k] !== undefined || k === "ref") props[k] = config[k];
  if (children.length) props.children = children.length === 1 ? children[0] : children;
  return { $$typeof: ELEMENT, type: element.type, key: key == null ? null : String(key), props };
}

export const isValidElement = (value: unknown): value is VNode => (value as VNode | null)?.$$typeof === ELEMENT;

function each(children: any, fn: (child: any, key: string) => void, prefix = "") {
  if (Array.isArray(children)) children.forEach((c, i) => each(c, fn, `${prefix}${isValidElement(c) && c.key != null ? `$${c.key}` : i}:`));
  else fn(children == null || typeof children === "boolean" ? null : children, prefix.slice(0, -1) || "0");
}

export const Children = {
  map<T>(children: any, fn: (child: any, index: number) => T): T[] {
    if (children == null) return children;
    const out: any[] = [];
    let i = 0;
    each(children, (child, key) => {
      const r = fn(child, i++);
      if (r == null || typeof r === "boolean") return;
      out.push(isValidElement(r) ? { ...r, key: r.key != null && r.key !== child?.key ? `${key}/${r.key}` : `.${key}` } : r);
    });
    return out;
  },
  forEach(children: any, fn: (child: any, index: number) => void): void {
    let i = 0;
    each(children, (child) => fn(child, i++));
  },
  count(children: any): number {
    let n = 0;
    each(children, () => n++);
    return children == null ? 0 : n;
  },
  toArray: (children: any): any[] => Children.map(children, (c) => c) ?? [],
  only(children: any): VNode {
    if (!isValidElement(children)) throw new Error("React.Children.only expected to receive a single React element child.");
    return children;
  },
};
