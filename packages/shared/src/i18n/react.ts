import {
  Children,
  Fragment,
  cloneElement,
  createContext,
  createElement,
  isValidElement,
  useContext,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";

import {
  DEFAULT_LOCALE,
  catalogKey,
  getI18nState,
  pluralCategory,
  subscribeI18n,
  type Catalog,
  type GTFunctionType,
  type I18nState,
  type MFunctionType,
} from "./core.ts";

export * from "./core.ts";

// No provider means English, so tests and isolated renders need no setup.
const I18nContext = createContext<I18nState>(getI18nState());

/** Re-renders translated content on `setLocale()`. Mount once near the root. */
export function LocaleProvider({ children }: { readonly children?: ReactNode }) {
  const value = useSyncExternalStore(subscribeI18n, getI18nState, getI18nState);
  return createElement(I18nContext.Provider, { value }, children);
}

export const useGT = (): GTFunctionType => useContext(I18nContext).gt;
export const useMessages = (): MFunctionType => useContext(I18nContext).m;
export const useLocale = (): string => useContext(I18nContext).locale;

export function Var({ children }: { readonly children?: ReactNode; readonly name?: string }) {
  return children;
}

const PLURAL_FORMS = new Set(["singular", "plural", "dual", "zero", "one", "two", "few", "many", "other"]);
type PluralForm = "singular" | "plural" | "dual" | "zero" | "one" | "two" | "few" | "many" | "other";

// GT's getPluralForm: exact 0/1/2 forms win over the locale's category.
function pluralBranch(n: number, locale: string, branches: Readonly<Record<string, unknown>>) {
  const has = (form: string) => PLURAL_FORMS.has(form) && branches[form] !== undefined;
  const category = pluralCategory(locale, n);
  const abs = Math.abs(n);
  const form =
    abs === 0 && has("zero")
      ? "zero"
      : (abs === 1 || category === "one") && has("singular")
        ? "singular"
        : abs === 1 && has("one")
          ? "one"
          : (abs === 2 || category === "two") && has("dual")
            ? "dual"
            : abs === 2 && has("two")
              ? "two"
              : [category, "plural", "other"].find(has);
  return form === undefined ? undefined : branches[form];
}

/** Source branches are English, so they always take English plural rules. */
export function Plural({
  n,
  children,
  ...branches
}: { readonly n: number; readonly children?: ReactNode } & Partial<Record<PluralForm, ReactNode>>) {
  return ((typeof n === "number" ? pluralBranch(n, DEFAULT_LOCALE, branches) : undefined) ??
    children ??
    null) as ReactNode;
}

export function Branch({
  branch,
  children,
  ...branches
}: {
  readonly branch?: string | number | boolean | null;
  readonly children?: ReactNode;
  readonly [key: string]: unknown;
}) {
  const key = branch?.toString();
  return (key && !key.startsWith("data-") && branches[key] !== undefined
    ? branches[key]
    : children) as ReactNode;
}

/** Renders its children in English; in other locales, the catalog's translation of them. */
export function T({ children, context }: { readonly children?: ReactNode; readonly context?: string }) {
  const { locale, catalog } = useContext(I18nContext);
  return catalog ? translateJsx(children, context, locale, catalog) : children;
}

// ---- <T> trees, mirroring GT's addGTIdentifier → writeChildrenAsObjects → hashSource ----

type Props = { readonly children?: ReactNode } & Readonly<Record<string, unknown>>;
type Kind = "element" | "fragment" | "variable" | "plural" | "branch";

class Tagged {
  readonly el: ReactElement<Props>;
  readonly id: number;
  readonly kind: Kind;
  children: unknown;
  branches: Record<string, unknown> | undefined;
  constructor(el: ReactElement<Props>, id: number, kind: Kind) {
    this.el = el;
    this.id = id;
    this.kind = kind;
  }
  get variableName(): string {
    const name = this.el.props.name;
    return typeof name === "string" ? name : `_gt_value_${this.id}`;
  }
}

const kindOf = (type: unknown): Kind =>
  type === Var
    ? "variable"
    : type === Plural
      ? "plural"
      : type === Branch
        ? "branch"
        : type === Fragment || type === T
          ? "fragment"
          : "element";

// Elements number depth-first; each branch restarts numbering from its owner's id.
function tag(children: unknown, start: number): unknown {
  let id = start;
  const one = (child: unknown): unknown => {
    if (!isValidElement<Props>(child)) return child;
    const node = new Tagged(child, ++id, kindOf(child.type));
    if (node.kind === "variable") return node;
    const { props } = child;
    if (node.kind === "plural" || node.kind === "branch") {
      const branches: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(props)) {
        const isBranch =
          node.kind === "plural"
            ? PLURAL_FORMS.has(key)
            : key !== "children" && key !== "branch" && !key.startsWith("data-");
        if (isBranch) branches[key] = tag(value, node.id);
      }
      if (Object.keys(branches).length > 0) node.branches = branches;
    }
    if (props.children) node.children = many(props.children);
    return node;
  };
  const many = (value: unknown) => (Array.isArray(value) ? Children.toArray(value).map(one) : one(value));
  return many(children);
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!(value instanceof Tagged)) return typeof value === "number" ? String(value) : value;
  if (value.kind === "variable") return { k: value.variableName, v: "v" };
  const out: Record<string, unknown> = {};
  const c = value.children === undefined ? undefined : sanitize(value.children);
  if (c) out.c = c;
  if (value.branches) {
    out.b = Object.fromEntries(Object.entries(value.branches).map(([k, b]) => [k, sanitize(b)]));
    out.t = value.kind === "plural" ? "p" : "b";
  }
  return out;
}

interface Target {
  readonly c?: unknown;
  readonly i?: number;
  readonly k?: string;
  readonly d?: { readonly b?: Readonly<Record<string, unknown>> };
}

const isVariableTarget = (t: Target) => typeof t.k === "string";
const untag = (source: unknown): ReactNode =>
  (Array.isArray(source) ? source.map(untag) : source instanceof Tagged ? source.el : source) as ReactNode;

function renderTarget(source: unknown, target: unknown, locale: string): ReactNode {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    const sources = Array.isArray(source) ? source : source ? [source] : null;
    if (sources) {
      const values = new Map<string, ReactNode>();
      const elements: Tagged[] = [];
      for (const s of sources) {
        if (!(s instanceof Tagged)) continue;
        if (s.kind === "variable") values.set(s.variableName, s.el.props.children);
        else elements.push(s);
      }
      return (target as ReadonlyArray<string | Target>).map((t, i) => {
        if (typeof t === "string") return t;
        if (isVariableTarget(t)) return createElement(Fragment, { key: `var_${i}` }, values.get(t.k!));
        const match = elements.find((e) => e.id === t.i) ?? elements.shift();
        return match
          ? createElement(Fragment, { key: `element_${i}` }, renderElement(match, t, locale))
          : null;
      });
    }
  } else if (target && typeof target === "object" && source instanceof Tagged) {
    const t = target as Target;
    if (isVariableTarget(t)) {
      if (source.kind === "variable") return source.el.props.children;
    } else return renderElement(source, t, locale);
  }
  return untag(source);
}

function renderElement(node: Tagged, target: Target, locale: string): ReactNode {
  const { props } = node.el;
  const targetBranches = target.d?.b ?? {};
  if (node.kind === "plural") {
    if (typeof props.n !== "number") return node.el;
    return renderTarget(
      pluralBranch(props.n, locale, node.branches ?? {}) ?? node.children,
      pluralBranch(props.n, locale, targetBranches) ?? target.c,
      locale,
    );
  }
  if (node.kind === "branch") {
    const key = props.branch == null || props.branch === "" ? undefined : String(props.branch);
    return renderTarget(
      key !== undefined && node.branches?.[key] !== undefined ? node.branches[key] : node.children,
      key !== undefined && targetBranches[key] !== undefined ? targetBranches[key] : target.c,
      locale,
    );
  }
  if (!target.c || (node.kind !== "fragment" && !props.children)) return node.el;
  const children = renderTarget(node.children, target.c, locale);
  return node.kind === "fragment"
    ? createElement(Fragment, null, children)
    : cloneElement(node.el, undefined, children);
}

function translateJsx(
  children: ReactNode,
  context: string | undefined,
  locale: string,
  catalog: Catalog,
): ReactNode {
  const source = tag(children, 0);
  const target = catalog[catalogKey(sanitize(source), "JSX", context)];
  return target == null ? children : renderTarget(source, target, locale);
}
