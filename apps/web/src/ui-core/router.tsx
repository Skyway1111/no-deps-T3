import {
  Component,
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type ComponentType,
  type ErrorInfo,
  type MouseEvent,
  type ReactNode,
} from "react";

/** Per-entry history state; features declare their own fields by augmentation. */
export interface HistoryState {
  __TSR_index: number;
  __TSR_key?: string;
  key?: string;
  __hashScrollIntoView?: boolean | undefined;
}
type StateInput = Partial<HistoryState>;
export interface HistoryLocation {
  pathname: string;
  search: string;
  hash: string;
  href: string;
  state: HistoryState;
}
export type HistoryAction = { type: "PUSH" | "REPLACE" | "BACK" | "FORWARD" | "GO" | "POP" };
type HistoryListener = (event: { location: HistoryLocation; action: HistoryAction }) => void;
export interface NavigationBlocker {
  blockerFn: (args: {
    currentLocation: HistoryLocation;
    nextLocation: HistoryLocation;
    action: HistoryAction["type"];
  }) => boolean | Promise<boolean>;
  enableBeforeUnload?: boolean | (() => boolean);
}
export interface RouterHistory {
  readonly location: HistoryLocation;
  readonly length: number;
  readonly listeners: Set<HistoryListener>;
  subscribe(listener: HistoryListener): () => void;
  push(path: string, state?: StateInput): void;
  replace(path: string, state?: StateInput): void;
  go(delta: number): void;
  back(): void;
  forward(): void;
  canGoBack(): boolean;
  createHref(path: string): string;
  block(blocker: NavigationBlocker): () => void;
  flush(): void;
  destroy(): void;
}

const newKey = () => Math.random().toString(36).slice(2, 10);
function parsePath(path: string, state: HistoryState): HistoryLocation {
  const hashIndex = path.indexOf("#");
  const beforeHash = hashIndex === -1 ? path : path.slice(0, hashIndex);
  const searchIndex = beforeHash.indexOf("?");
  const pathname = (searchIndex === -1 ? beforeHash : beforeHash.slice(0, searchIndex)) || "/";
  return {
    pathname,
    search: searchIndex === -1 ? "" : beforeHash.slice(searchIndex),
    hash: hashIndex === -1 ? "" : path.slice(hashIndex),
    href: path || "/",
    state,
  };
}

/** Shared push/replace/go plumbing over an entry store; blockers gate every transition. */
function createHistory(driver: {
  read: () => HistoryLocation;
  length: () => number;
  index: () => number;
  write: (kind: "push" | "replace", path: string, state: HistoryState) => void;
  /** Returns true when the move happened synchronously (memory); window moves arrive as popstate. */
  go: (delta: number) => boolean;
  createHref: (path: string) => string;
  listenPop?: (onPop: () => void, onExternal: (type: "PUSH" | "REPLACE") => void) => () => void;
}): RouterHistory {
  const listeners = new Set<HistoryListener>();
  const blockers = new Set<NavigationBlocker>();
  let location = driver.read();
  let ignorePop = 0;
  const notify = (type: HistoryAction["type"]) => {
    location = driver.read();
    for (const listener of listeners) listener({ location, action: { type } });
  };
  const blocked = (nextLocation: HistoryLocation, action: HistoryAction["type"]) => {
    if (blockers.size === 0) return false;
    const results = [...blockers].map((b) =>
      b.blockerFn({ currentLocation: location, nextLocation, action }),
    );
    return results.some((r) => r instanceof Promise)
      ? Promise.all(results).then((all) => all.some(Boolean))
      : results.some(Boolean);
  };
  const transition = (kind: "push" | "replace", path: string, state: StateInput = {}) => {
    const key = newKey();
    const next: HistoryState = {
      ...state,
      key,
      __TSR_key: key,
      __TSR_index: driver.index() + (kind === "push" ? 1 : 0),
    };
    const action = kind === "push" ? "PUSH" : "REPLACE";
    const run = () => {
      driver.write(kind, path, next);
      notify(action);
    };
    const isBlocked = blocked(parsePath(path, next), action);
    if (isBlocked instanceof Promise) void isBlocked.then((b) => b || run());
    else if (!isBlocked) run();
  };
  const go = (delta: number, type: HistoryAction["type"]) => {
    const target = parsePath(location.href, location.state);
    const run = () => driver.go(delta) && notify(type);
    const isBlocked = blocked(target, type);
    if (isBlocked instanceof Promise) void isBlocked.then((b) => b || run());
    else if (!isBlocked) run();
  };
  const stopPop = driver.listenPop?.(() => {
    if (ignorePop > 0) {
      ignorePop--;
      return;
    }
    const previousIndex = location.state.__TSR_index ?? 0;
    const next = driver.read();
    const delta = (next.state.__TSR_index ?? 0) - previousIndex;
    const isBlocked = blocked(next, "POP");
    const undo = () => {
      ignorePop++;
      driver.go(-delta);
    };
    if (isBlocked instanceof Promise) void isBlocked.then((b) => (b ? undo() : notify("POP")));
    else if (isBlocked && delta !== 0) undo();
    else notify("POP");
  }, notify);
  const beforeUnload = (event: BeforeUnloadEvent) => {
    for (const blocker of blockers) {
      const enabled =
        typeof blocker.enableBeforeUnload === "function"
          ? blocker.enableBeforeUnload()
          : (blocker.enableBeforeUnload ?? true);
      if (enabled) {
        event.preventDefault();
        return;
      }
    }
  };
  return {
    get location() {
      return location;
    },
    get length() {
      return driver.length();
    },
    listeners,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    push: (path, state) => transition("push", path, state),
    replace: (path, state) => transition("replace", path, state),
    go: (delta) => go(delta, "GO"),
    back: () => go(-1, "BACK"),
    forward: () => go(1, "FORWARD"),
    canGoBack: () => driver.index() > 0,
    createHref: driver.createHref,
    block: (blocker) => {
      blockers.add(blocker);
      if (blockers.size === 1 && typeof window !== "undefined")
        window.addEventListener("beforeunload", beforeUnload);
      return () => {
        blockers.delete(blocker);
        if (blockers.size === 0 && typeof window !== "undefined")
          window.removeEventListener("beforeunload", beforeUnload);
      };
    },
    flush: () => {},
    destroy: () => {
      listeners.clear();
      stopPop?.();
    },
  };
}

interface HistoryWindow {
  location: Pick<Location, "pathname" | "search" | "hash">;
  history: Pick<History, "state" | "replaceState"> &
    Partial<Pick<History, "pushState" | "go" | "length">>;
  addEventListener(type: "popstate", listener: () => void): void;
  removeEventListener(type: "popstate", listener: () => void): void;
}

function createWindowHistory(
  win: HistoryWindow,
  toPath: () => string,
  createHref: (path: string) => string,
): RouterHistory {
  const read = () =>
    parsePath(toPath(), (win.history.state as HistoryState | null) ?? { __TSR_index: 0 });
  if ((win.history.state as HistoryState | null)?.__TSR_index === undefined) {
    const key = newKey();
    win.history.replaceState({ ...win.history.state, __TSR_index: 0, key, __TSR_key: key }, "");
  }
  const original = { pushState: win.history.pushState, replaceState: win.history.replaceState };
  let writing = false;
  return createHistory({
    read,
    length: () => win.history.length ?? 1,
    index: () => (win.history.state as HistoryState | null)?.__TSR_index ?? 0,
    write: (kind, path, state) => {
      writing = true;
      try {
        if (kind === "push") win.history.pushState?.(state, "", createHref(path));
        else win.history.replaceState(state, "", createHref(path));
      } finally {
        writing = false;
      }
    },
    go: (delta) => {
      win.history.go?.(delta);
      return false;
    },
    createHref,
    listenPop: (onPop, onExternal) => {
      // Code outside the router edits the address directly (e.g. stripping a pairing token).
      const patch = (name: "pushState" | "replaceState", type: "PUSH" | "REPLACE") => {
        const write = original[name];
        if (!write) return;
        win.history[name] = (...args: Parameters<History["pushState"]>) => {
          write.apply(win.history, args);
          if (!writing) onExternal(type);
        };
      };
      patch("pushState", "PUSH");
      patch("replaceState", "REPLACE");
      win.addEventListener("popstate", onPop);
      return () => {
        if (original.pushState) win.history.pushState = original.pushState;
        win.history.replaceState = original.replaceState;
        win.removeEventListener("popstate", onPop);
      };
    },
  });
}

export const createBrowserHistory = ({ window: win = window }: { window?: HistoryWindow } = {}) =>
  createWindowHistory(
    win,
    () => win.location.pathname + win.location.search + win.location.hash,
    (path) => path,
  );
export const createHashHistory = ({ window: win = window }: { window?: HistoryWindow } = {}) =>
  createWindowHistory(
    win,
    () => win.location.hash.slice(1) || "/",
    (path) => `${win.location.pathname}${win.location.search}#${path}`,
  );

export function createMemoryHistory({
  initialEntries = ["/"],
  initialIndex,
}: { initialEntries?: string[]; initialIndex?: number } = {}): RouterHistory {
  const entries = initialEntries.map((path, i): { path: string; state: HistoryState } => {
    const key = newKey();
    return { path, state: { __TSR_index: i, key, __TSR_key: key } };
  });
  let index = initialIndex ?? entries.length - 1;
  const history: RouterHistory = createHistory({
    read: () => parsePath(entries[index]!.path, entries[index]!.state),
    length: () => entries.length,
    index: () => index,
    write: (kind, path, state) => {
      if (kind === "push") {
        entries.splice(index + 1, entries.length, { path, state });
        index++;
      } else entries[index] = { path, state };
    },
    go: (delta) => {
      const next = Math.max(0, Math.min(entries.length - 1, index + delta));
      if (next === index) return false;
      index = next;
      return true;
    },
    createHref: (path) => path,
  });
  return history;
}

// Route search is open-ended: each route validates its own keys.
export type AnySearch = Record<string, any>;

export function parseSearch(searchStr: string): AnySearch {
  const result: AnySearch = {};
  for (const [key, raw] of new URLSearchParams(searchStr)) {
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {}
    result[key] =
      key in result
        ? [...(Array.isArray(result[key]) ? result[key] : [result[key]]), value]
        : value;
  }
  return result;
}

export function stringifySearch(search: AnySearch): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      let ambiguous = true;
      try {
        JSON.parse(value);
      } catch {
        ambiguous = false;
      }
      params.append(key, ambiguous ? JSON.stringify(value) : value);
    } else {
      params.append(key, JSON.stringify(value));
    }
  }
  const str = params.toString();
  return str ? `?${str}` : "";
}

/** Context every route's beforeLoad builds on; the app declares its fields by augmentation. */
export interface RouteContext {}

type ParamsOf<P extends string> = P extends `${string}$${infer Param}/${infer Rest}`
  ? { [K in Param]: string } & ParamsOf<`/${Rest}`>
  : P extends `${string}$${infer Param}`
    ? { [K in Param]: string }
    : {};

export interface ParsedLocation {
  pathname: string;
  search: AnySearch;
  searchStr: string;
  hash: string;
  href: string;
  publicHref: string;
  state: HistoryState;
}

export interface RouteMatch {
  id: string;
  routeId: string;
  pathname: string;
  fullPath: string;
  params: Record<string, string>;
  search: AnySearch;
  context: RouteContext;
}

class Redirect {
  constructor(readonly options: NavigateOptions) {}
}
export const redirect = (options: NavigateOptions) => new Redirect(options);
export const isRedirect = (value: unknown): value is Redirect => value instanceof Redirect;

export type SearchMiddleware<T = AnySearch> = (ctx: { search: T; next: (search: T) => T }) => T;
export interface ErrorComponentProps {
  error: Error;
  reset: () => void;
  info?: ErrorInfo;
}

interface BeforeLoadArgs<TParams> {
  context: RouteContext;
  location: ParsedLocation;
  params: TParams;
  search: AnySearch;
  cause: "enter" | "stay";
}
type LifecycleArgs<TParams> = {
  context: RouteContext;
  params: TParams;
  search: AnySearch;
  pathname: string;
};

// Routes differ in params, search and context; trees hold any of them.
export type AnyRoute = Route<any, any, any>;

export interface RouteOptions<
  TParams = Record<string, string>,
  TSearch = AnySearch,
  TCtx = unknown,
> {
  path?: string;
  id?: string;
  getParentRoute?: () => AnyRoute;
  component?: ComponentType;
  pendingComponent?: ComponentType;
  errorComponent?: ComponentType<ErrorComponentProps>;
  notFoundComponent?: ComponentType;
  validateSearch?: ((raw: AnySearch) => TSearch) | undefined;
  search?: { middlewares?: SearchMiddleware<TSearch>[] };
  beforeLoad?: (args: BeforeLoadArgs<TParams>) => TCtx | Promise<TCtx>;
  onEnter?: (match: LifecycleArgs<TParams>) => void;
  onStay?: (match: LifecycleArgs<TParams>) => void;
  onLeave?: (match: LifecycleArgs<TParams>) => void;
}

export class Route<TParams = Record<string, string>, TSearch = AnySearch, TCtx = unknown> {
  id: string;
  parentRoute: AnyRoute | undefined;
  children: AnyRoute[] = [];
  /** Full path pattern used for matching, e.g. `/settings/general` or `/$environmentId/$threadId`. */
  fullPath = "/";
  constructor(
    readonly options: RouteOptions<TParams, TSearch, TCtx>,
    id?: string,
  ) {
    this.id = id ?? options.id ?? options.path ?? "__root__";
  }
  addChildren(children: AnyRoute[]) {
    this.children = children;
    for (const child of children) child.parentRoute = this;
    return this;
  }
  useMatch = (): RouteMatch | undefined => {
    const matches = useRouterSelect((s) => s.matches);
    return matches.find((m) => m.routeId === this.id) ?? matches.at(-1);
  };
  useParams = (): TParams => (this.useMatch()?.params ?? {}) as TParams;
  useSearch = (): TSearch => (this.useMatch()?.search ?? {}) as TSearch;
  useRouteContext = (): RouteContext & Awaited<TCtx> =>
    (this.useMatch()?.context ?? {}) as RouteContext & Awaited<TCtx>;
  useNavigate = () => useNavigate();
}

export const createRootRoute = <TCtx,>(options: RouteOptions<{}, AnySearch, TCtx> = {}) =>
  new Route<{}, AnySearch, TCtx>(options, "__root__");
export const createRoute = <TPath extends string, TSearch = AnySearch, TCtx = unknown>(
  options: RouteOptions<ParamsOf<TPath>, TSearch, TCtx> & { path?: TPath },
) => new Route<ParamsOf<TPath>, TSearch, TCtx>(options);
/** A route defined by a file in `routes/`; its id (`/_chat/settings`) places it in the tree. */
export const createFileRoute =
  <TId extends string>(id: TId) =>
  <TSearch = AnySearch, TCtx = unknown>(options: RouteOptions<ParamsOf<TId>, TSearch, TCtx> = {}) =>
    new Route<ParamsOf<TId>, TSearch, TCtx>(options, id);

// Route tree nodes resolve their Route lazily, so each file route loads as its own chunk.
interface RouteNode {
  id: string;
  fullPath: string;
  pathless: boolean;
  parent: RouteNode | undefined;
  children: RouteNode[];
  route: AnyRoute | undefined;
  load: (() => Promise<AnyRoute>) | undefined;
  score: number[];
}
export interface LazyRouteTree {
  root: () => Promise<AnyRoute>;
  routes: Record<string, () => Promise<AnyRoute>>;
}

function resolveRelative(base: string, to: string) {
  const segments: string[] = [];
  for (const segment of joinPaths(base, to).split("/")) {
    if (segment === "..") segments.pop();
    else if (segment && segment !== ".") segments.push(segment);
  }
  return `/${segments.join("/")}`;
}
const joinPaths = (a: string, b: string) =>
  `/${[...a.split("/"), ...b.split("/")].filter(Boolean).join("/")}`;
const scoreOf = (fullPath: string) =>
  fullPath
    .split("/")
    .filter(Boolean)
    .map((s) => (s.startsWith("$") ? 1 : 2));

function nodeFromRoute(route: AnyRoute, parent: RouteNode | undefined): RouteNode {
  const path = route.options.path;
  const pathless = parent !== undefined && path === undefined;
  const fullPath = parent
    ? pathless
      ? parent.fullPath
      : joinPaths(parent.fullPath, path ?? "")
    : "/";
  route.fullPath = fullPath;
  const node: RouteNode = {
    id: route.id,
    fullPath,
    pathless,
    parent,
    children: [],
    route,
    load: undefined,
    score: scoreOf(fullPath),
  };
  node.children = route.children.map((child) => nodeFromRoute(child, node));
  return node;
}

/** Builds the tree from file-route ids: `_x` segments are pathless layouts, a trailing `/` is an index. */
function nodesFromFiles(tree: LazyRouteTree): RouteNode {
  const root: RouteNode = {
    id: "__root__",
    fullPath: "/",
    pathless: false,
    parent: undefined,
    children: [],
    route: undefined,
    load: tree.root,
    score: [],
  };
  const byId = new Map<string, RouteNode>([["", root]]);
  for (const id of Object.keys(tree.routes).sort((a, b) => a.length - b.length)) {
    const trimmed = id.replace(/\/$/, "");
    let parentId = trimmed;
    let parent: RouteNode | undefined;
    while (!parent) {
      parentId = parentId.slice(0, Math.max(0, parentId.lastIndexOf("/")));
      parent = byId.get(parentId);
    }
    const ownSegments = (
      id.endsWith("/") ? id.slice(parentId.length) : trimmed.slice(parentId.length)
    ).split("/");
    const pathless =
      !id.endsWith("/") && ownSegments.filter(Boolean).every((s) => s.startsWith("_"));
    const fullPath = joinPaths(
      parent.fullPath,
      ownSegments.filter((s) => !s.startsWith("_")).join("/"),
    );
    const node: RouteNode = {
      id,
      fullPath,
      pathless,
      parent,
      children: [],
      route: undefined,
      load: tree.routes[id],
      score: scoreOf(fullPath),
    };
    parent.children.push(node);
    if (!id.endsWith("/")) byId.set(trimmed, node);
  }
  return root;
}

function matchPattern(pattern: string, pathname: string): Record<string, string> | null {
  const want = pattern.split("/").filter(Boolean);
  const have = pathname.split("/").filter(Boolean);
  if (want.length !== have.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const segment = want[i]!;
    if (segment.startsWith("$")) {
      try {
        params[segment.slice(1)] = decodeURIComponent(have[i]!);
      } catch {
        params[segment.slice(1)] = have[i]!;
      }
    } else if (segment !== have[i]) return null;
  }
  return params;
}

function interpolate(pattern: string, params: Record<string, unknown>) {
  return (
    pattern
      .split("/")
      .map((segment) =>
        segment.startsWith("$")
          ? encodeURIComponent(String(params[segment.slice(1)] ?? ""))
          : segment,
      )
      .join("/") || "/"
  );
}

export interface NavigateOptions {
  to?: string;
  from?: string;
  href?: string;
  params?:
    | Record<string, unknown>
    | true
    | ((previous: Record<string, string>) => Record<string, unknown>);
  search?: true | AnySearch | ((previous: any) => AnySearch);
  hash?: string | true | ((previous: string) => string);
  state?: StateInput | true | ((previous: HistoryState) => StateInput);
  replace?: boolean;
  resetScroll?: boolean;
  hashScrollIntoView?: boolean;
  ignoreBlocker?: boolean;
}
export const linkOptions = <T extends NavigateOptions>(options: T) => options;

export interface RouterState {
  status: "pending" | "idle";
  location: ParsedLocation;
  resolvedLocation: ParsedLocation | undefined;
  matches: RouteMatch[];
  /** Set when no route matched; the deepest match renders its notFoundComponent. */
  notFound: boolean;
  redirect: Redirect | undefined;
  error: unknown;
}
type RouterEventName = "onBeforeLoad" | "onResolved" | "onRendered";
type RouterEvent = {
  type: RouterEventName;
  fromLocation: ParsedLocation | undefined;
  toLocation: ParsedLocation;
  pathChanged: boolean;
  hrefChanged: boolean;
};

export interface RouterOptions {
  routeTree: AnyRoute | LazyRouteTree;
  history?: RouterHistory;
  context?: Partial<RouteContext>;
  defaultPreload?: "intent" | false;
  disableGlobalCatchBoundary?: boolean;
}

const isPromise = (value: unknown): value is Promise<unknown> => value instanceof Promise;
/** Runs `steps` in order, staying synchronous until one returns a promise. */
function chain(steps: Array<() => unknown>, index = 0): void | Promise<void> {
  for (let i = index; i < steps.length; i++) {
    const result = steps[i]!();
    if (isPromise(result)) return result.then(() => chain(steps, i + 1));
  }
}

export class Router {
  readonly history: RouterHistory;
  readonly root: RouteNode;
  private readonly nodes: RouteNode[] = [];
  private readonly events = new Map<RouterEventName, Set<(event: RouterEvent) => void>>();
  private readonly stateListeners = new Set<() => void>();
  private loadId = 0;
  private redirecting = false;
  private loadPromise: Promise<void> = Promise.resolve();
  latestLocation: ParsedLocation;
  state: RouterState;

  constructor(readonly options: RouterOptions) {
    latestRouter = this;
    this.history =
      options.history ??
      (typeof window === "undefined" ? createMemoryHistory() : createBrowserHistory());
    this.root =
      options.routeTree instanceof Route
        ? nodeFromRoute(options.routeTree, undefined)
        : nodesFromFiles(options.routeTree);
    const visit = (node: RouteNode) => {
      this.nodes.push(node);
      node.children.forEach(visit);
    };
    visit(this.root);
    this.latestLocation = this.parseLocation(this.history.location);
    this.state = {
      status: "pending",
      location: this.latestLocation,
      resolvedLocation: undefined,
      matches: [],
      notFound: false,
      redirect: undefined,
      error: undefined,
    };
    this.history.subscribe(() => {
      this.latestLocation = this.parseLocation(this.history.location);
      void this.load();
    });
  }

  get routesById() {
    return new Map(this.nodes.flatMap((n) => (n.route ? [[n.id, n.route] as const] : [])));
  }

  parseLocation(location: HistoryLocation): ParsedLocation {
    return {
      pathname:
        location.pathname.length > 1 ? location.pathname.replace(/\/+$/, "") : location.pathname,
      searchStr: location.search,
      search: parseSearch(location.search),
      hash: location.hash.replace(/^#/, ""),
      href: location.href,
      publicHref: this.history.createHref(location.href),
      state: location.state,
    };
  }

  subscribeState = (listener: () => void) => {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  };
  private setState(patch: Partial<RouterState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.stateListeners) listener();
  }
  subscribe(event: RouterEventName, listener: (event: RouterEvent) => void) {
    const set = this.events.get(event) ?? new Set();
    this.events.set(event, set);
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }
  emit(
    type: RouterEventName,
    fromLocation: ParsedLocation | undefined,
    toLocation: ParsedLocation,
  ) {
    const event = {
      type,
      fromLocation,
      toLocation,
      pathChanged: fromLocation?.pathname !== toLocation.pathname,
      hrefChanged: fromLocation?.href !== toLocation.href,
    };
    for (const listener of this.events.get(type) ?? []) listener(event);
  }

  private matchNodes(
    pathname: string,
  ): { chain: RouteNode[]; params: Record<string, string> } | null {
    let best: { node: RouteNode; params: Record<string, string> } | null = null;
    for (const node of this.nodes) {
      if (
        node.pathless ||
        (node.parent === undefined && node.children.length > 0 && pathname !== "/")
      )
        continue;
      const params = matchPattern(node.fullPath, pathname);
      if (!params) continue;
      if (!best || compareScore(node, best.node) > 0) best = { node, params };
    }
    if (!best) return null;
    const nodes: RouteNode[] = [];
    for (let n: RouteNode | undefined = best.node; n; n = n.parent) nodes.unshift(n);
    return { chain: nodes, params: best.params };
  }

  matchRoutes(input: string | ParsedLocation): RouteMatch[] {
    const location =
      typeof input === "string" ? this.parseLocation(parsePath(input, { __TSR_index: 0 })) : input;
    const matched = this.matchNodes(location.pathname);
    const nodes = matched?.chain ?? [this.root];
    const params = matched?.params ?? {};
    let search = location.search;
    return nodes.map((node) => {
      const validate = node.route?.options.validateSearch;
      if (validate) {
        try {
          search = { ...search, ...validate(search) };
        } catch {}
      }
      return {
        id: `${node.id}:${location.pathname}`,
        routeId: node.id,
        pathname: interpolate(node.fullPath, params),
        fullPath: node.fullPath,
        params,
        search,
        context: {} as RouteContext,
      };
    });
  }

  /** Resolves the latest location: loads route modules, runs beforeLoad, commits the matches. */
  load(): Promise<void> {
    const id = ++this.loadId;
    const location = this.latestLocation;
    const matched = this.matchNodes(location.pathname);
    const nodes = matched?.chain ?? [this.root];
    const previous = this.state.matches;
    const fromLocation = this.state.resolvedLocation;
    this.emit("onBeforeLoad", fromLocation, location);
    let context = { ...this.options.context } as RouteContext;
    let matches: RouteMatch[] = [];
    const followsRedirect = this.redirecting;
    this.redirecting = false;
    const fail = (error: unknown): void | Promise<void> => {
      if (id !== this.loadId) return;
      if (isRedirect(error)) {
        this.setState({ redirect: error });
        this.redirecting = true;
        return this.navigate({ replace: true, ...error.options });
      }
      this.commit(location, matches, !matched, error, previous, fromLocation, followsRedirect);
    };
    const steps: Array<() => unknown> = [
      () => {
        const pending = nodes
          .filter((n) => !n.route && n.load)
          .map((n) => n.load!().then((route) => this.attach(n, route)));
        if (pending.length) return Promise.all(pending);
      },
      () => {
        matches = this.matchRoutes(location).slice(0, nodes.length);
      },
      ...nodes.map((node, i) => () => {
        if (id !== this.loadId) return;
        const match = matches[i]!;
        const beforeLoad = node.route?.options.beforeLoad;
        const apply = (result: unknown) => {
          if (result && typeof result === "object") context = { ...context, ...result };
          match.context = context;
        };
        if (!beforeLoad) return apply(undefined);
        const cause = previous.some((m) => m.routeId === node.id) ? "stay" : "enter";
        const result = beforeLoad({
          context,
          location,
          params: match.params,
          search: match.search,
          cause,
        });
        return isPromise(result) ? result.then(apply) : apply(result);
      }),
    ];
    try {
      const run = chain(steps);
      if (isPromise(run)) {
        if (this.state.status !== "pending") this.setState({ status: "pending" });
        this.loadPromise = run.then(
          () =>
            id === this.loadId
              ? this.commit(
                  location,
                  matches,
                  !matched,
                  undefined,
                  previous,
                  fromLocation,
                  followsRedirect,
                )
              : undefined,
          fail,
        );
      } else {
        this.commit(
          location,
          matches,
          !matched,
          undefined,
          previous,
          fromLocation,
          followsRedirect,
        );
        this.loadPromise = Promise.resolve();
      }
    } catch (error) {
      this.loadPromise = Promise.resolve(fail(error));
    }
    return this.loadPromise;
  }

  private attach(node: RouteNode, route: AnyRoute) {
    node.route = route;
    route.fullPath = node.fullPath;
    route.id = node.id;
  }

  private commit(
    location: ParsedLocation,
    matches: RouteMatch[],
    notFound: boolean,
    error: unknown,
    previous: RouteMatch[],
    fromLocation: ParsedLocation | undefined,
    followsRedirect: boolean,
  ) {
    // A redirect stays visible on the state of the location it led to.
    const redirect = followsRedirect ? this.state.redirect : undefined;
    this.setState({
      status: "idle",
      location,
      resolvedLocation: location,
      matches,
      notFound,
      error,
      redirect,
    });
    const lifecycle = (match: RouteMatch) => ({
      context: match.context,
      params: match.params,
      search: match.search,
      pathname: match.pathname,
    });
    const routeOf = (match: RouteMatch) =>
      this.nodes.find((n) => n.id === match.routeId)?.route?.options;
    for (const match of previous)
      if (!matches.some((m) => m.routeId === match.routeId))
        routeOf(match)?.onLeave?.(lifecycle(match));
    for (const match of matches) {
      const stayed = previous.some((m) => m.routeId === match.routeId);
      (stayed ? routeOf(match)?.onStay : routeOf(match)?.onEnter)?.(lifecycle(match));
    }
    this.emit("onResolved", fromLocation, location);
  }

  invalidate() {
    return this.load();
  }

  /** Loads a destination's route modules ahead of navigation (hover intent). */
  preloadRoute(options: NavigateOptions) {
    const matched = this.matchNodes(this.buildLocation(options).pathname);
    for (const node of matched?.chain ?? [])
      if (!node.route && node.load) void node.load().then((r) => this.attach(node, r));
  }

  buildLocation(options: NavigateOptions): ParsedLocation {
    const current = this.latestLocation;
    if (options.href)
      return this.parseLocation(
        parsePath(options.href, { __TSR_index: current.state.__TSR_index }),
      );
    const currentParams = this.matchNodes(current.pathname)?.params ?? {};
    const base = options.from ?? current.pathname;
    let to = options.to ?? base;
    if (to.startsWith(".")) to = resolveRelative(base, to);
    const params =
      options.params === true || options.params === undefined
        ? currentParams
        : typeof options.params === "function"
          ? options.params(currentParams)
          : options.params;
    const pathname = interpolate(to, { ...currentParams, ...params });
    const applySearch = (search: AnySearch): AnySearch =>
      options.search === true
        ? search
        : typeof options.search === "function"
          ? options.search(search)
          : (options.search ?? {});
    const destination = this.matchNodes(pathname)?.chain ?? [];
    // Each destination route's middlewares, then its validation of what the rest of the chain returns.
    const middlewares = destination.flatMap((n): SearchMiddleware[] => {
      const options = n.route?.options;
      const validate = options?.validateSearch;
      return [
        ...(options?.search?.middlewares ?? []),
        ...(validate
          ? [
              ({ search, next }: { search: AnySearch; next: (s: AnySearch) => AnySearch }) => {
                const result = next(search);
                try {
                  return { ...result, ...validate(result) };
                } catch {
                  return result;
                }
              },
            ]
          : []),
      ];
    });
    const fromSearch =
      (current === this.state.location ? this.state.matches.at(-1)?.search : undefined) ??
      current.search;
    const search = middlewares.reduceRight<(s: AnySearch) => AnySearch>(
      (next, mw) => (s) => mw({ search: s, next }),
      applySearch,
    )(fromSearch);
    const hash =
      options.hash === true
        ? current.hash
        : typeof options.hash === "function"
          ? options.hash(current.hash)
          : (options.hash ?? "");
    const stateInput =
      options.state === true
        ? current.state
        : typeof options.state === "function"
          ? options.state(current.state)
          : (options.state ?? {});
    const state: HistoryState = { ...stateInput, __TSR_index: current.state.__TSR_index };
    const searchStr = stringifySearch(search);
    const href = `${pathname}${searchStr}${hash ? `#${hash}` : ""}`;
    return {
      pathname,
      search,
      searchStr,
      hash,
      href,
      publicHref: this.history.createHref(href),
      state,
    };
  }

  navigate = (options: NavigateOptions): Promise<void> => {
    const next = this.buildLocation(options);
    const loadId = this.loadId;
    const { __TSR_index: _i, key: _k, __TSR_key: _tk, ...nextState } = next.state;
    const {
      __TSR_index: _ci,
      key: _ck,
      __TSR_key: _ctk,
      ...currentState
    } = this.latestLocation.state;
    // Revisiting the same address with the same state reloads in place instead of adding an entry.
    if (next.href === this.latestLocation.href && shallowEqual(nextState, currentState))
      return this.load();
    const state = {
      ...nextState,
      ...(options.hashScrollIntoView === undefined
        ? {}
        : { __hashScrollIntoView: options.hashScrollIntoView }),
    };
    if (options.replace) this.history.replace(next.href, state);
    else this.history.push(next.href, state);
    return this.loadId === loadId ? Promise.resolve() : this.loadPromise;
  };
}

function compareScore(a: RouteNode, b: RouteNode) {
  const n = Math.max(a.score.length, b.score.length);
  for (let i = 0; i < n; i++) {
    const diff = (a.score[i] ?? 0) - (b.score[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // Prefer a leaf over a layout with the same path.
  return b.children.length - a.children.length;
}

// Hooks outside a RouterProvider (portals, detached roots) use the latest router.
let latestRouter: Router | null = null;
export const createRouter = (options: RouterOptions) => new Router(options);
export type AnyRouter = Router;

const RouterCtx = createContext<Router | null>(null);
const MatchIndexCtx = createContext(0);

export function useRouter(): Router {
  const router = use(RouterCtx) ?? latestRouter;
  if (!router) throw new Error("useRouter must be used inside RouterProvider");
  return router;
}

const shallowEqual = (a: unknown, b: unknown) => {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  const ka = Object.keys(a);
  return (
    ka.length === Object.keys(b).length &&
    ka.every((k) => Object.is((a as AnySearch)[k], (b as AnySearch)[k]))
  );
};

function useRouterSelect<T>(select: (state: RouterState) => T): T {
  const router = useRouter();
  const cache = useRef<{ state: RouterState; value: T } | null>(null);
  const get = () => {
    const prev = cache.current;
    if (prev?.state === router.state) return prev.value;
    const value = select(router.state);
    cache.current = {
      state: router.state,
      value: prev && shallowEqual(prev.value, value) ? prev.value : value,
    };
    return cache.current.value;
  };
  return useSyncExternalStore(router.subscribeState, get, get);
}

export const useLocation = <T = ParsedLocation,>(opts?: {
  select?: (location: ParsedLocation) => T;
  structuralSharing?: boolean;
}) => useRouterSelect((s) => (opts?.select ? opts.select(s.location) : (s.location as T)));
export const useMatches = <T = RouteMatch[],>(opts?: { select?: (matches: RouteMatch[]) => T }) =>
  useRouterSelect((s) => (opts?.select ? opts.select(s.matches) : (s.matches as T)));
export const useParams = <T = Record<string, string | undefined>,>(opts?: {
  strict?: boolean;
  from?: string;
  select?: (params: Record<string, string>) => T;
}) =>
  useRouterSelect((s) => {
    const params = s.matches.at(-1)?.params ?? {};
    return opts?.select ? opts.select(params) : (params as T);
  });
/** The location's validated search; name the route's search type, as hooks cannot see route ids. */
export const useSearch = <T = AnySearch, S = T>(opts?: {
  strict?: boolean;
  from?: string;
  select?: (search: T) => S;
}): S =>
  useRouterSelect((s) => {
    const search = (s.matches.at(-1)?.search ?? {}) as T;
    return opts?.select ? opts.select(search) : (search as unknown as S);
  });
export function useNavigate(_opts?: { from?: string }) {
  return useRouter().navigate;
}

export function Navigate(props: NavigateOptions) {
  const router = useRouter();
  const done = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- navigation is a side effect of rendering this element.
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    void router.navigate(props);
  });
  return null;
}

export function useBlocker({
  shouldBlockFn,
  enableBeforeUnload = true,
  disabled = false,
}: {
  shouldBlockFn: (args: {
    current: ParsedLocation;
    next: ParsedLocation;
    action: HistoryAction["type"];
  }) => boolean | Promise<boolean>;
  enableBeforeUnload?: boolean | (() => boolean);
  disabled?: boolean;
}) {
  const router = useRouter();
  const fn = useRef(shouldBlockFn);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the history blocker reads the latest callback.
  useLayoutEffect(() => {
    fn.current = shouldBlockFn;
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the blocker with the history.
  useEffect(() => {
    if (disabled) return;
    return router.history.block({
      blockerFn: ({ currentLocation, nextLocation, action }) =>
        fn.current({
          current: router.parseLocation(currentLocation),
          next: router.parseLocation(nextLocation),
          action,
        }),
      enableBeforeUnload,
    });
  }, [router, disabled, enableBeforeUnload]);
}

export type LinkProps = NavigateOptions & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">;

export function Link({
  to,
  from,
  params,
  search,
  hash,
  state,
  replace,
  resetScroll,
  hashScrollIntoView,
  ignoreBlocker,
  onClick,
  onMouseEnter,
  onFocus,
  target,
  ...rest
}: LinkProps) {
  const router = useRouter();
  const options = {
    to,
    from,
    params,
    search,
    hash,
    state,
    replace,
    resetScroll,
    hashScrollIntoView,
    ignoreBlocker,
  } as NavigateOptions;
  // Re-render on navigation so relative and param-filled hrefs stay current.
  useRouterSelect((s) => s.location.href);
  const location = router.buildLocation(options);
  const preload = () => router.options.defaultPreload === "intent" && router.preloadRoute(options);
  return (
    <a
      {...rest}
      href={location.publicHref}
      target={target}
      onMouseEnter={(event) => {
        preload();
        onMouseEnter?.(event);
      }}
      onFocus={(event) => {
        preload();
        onFocus?.(event);
      }}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          (target && target !== "_self")
        )
          return;
        event.preventDefault();
        void router.navigate(options);
      }}
    />
  );
}

interface BoundaryState {
  error: Error | null;
  info: ErrorInfo | undefined;
  key: string;
}
class CatchBoundary extends Component<
  {
    fallback: ComponentType<ErrorComponentProps>;
    onReset: () => void;
    resetKey: string;
    children: ReactNode;
  },
  BoundaryState
> {
  override state: BoundaryState = { error: null, info: undefined, key: this.props.resetKey };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  static getDerivedStateFromProps(props: { resetKey: string }, state: { key: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }
  override componentDidCatch(_error: Error, info: ErrorInfo) {
    this.setState({ info });
  }
  override render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    const Fallback = this.props.fallback;
    return (
      <Fallback
        error={error}
        {...(info ? { info } : {})}
        reset={() => {
          this.setState({ error: null });
          this.props.onReset();
        }}
      />
    );
  }
}

function RouteSlot({
  router,
  routeId,
  slot,
}: {
  router: Router;
  routeId: string;
  slot: "notFoundComponent" | "pendingComponent";
}) {
  const Slot = router.routesById.get(routeId)?.options[slot];
  return Slot ? <Slot /> : null;
}

function MatchView({ index }: { index: number }) {
  const router = useRouter();
  const matches = useRouterSelect((s) => s.matches);
  const notFound = useRouterSelect((s) => s.notFound);
  const error = useRouterSelect((s) => s.error);
  const href = useRouterSelect((s) => s.location.href);
  const match = matches[index];
  if (!match) {
    if (!notFound || index !== matches.length) return null;
    const owner = matches.findLast(
      (m) => router.routesById.get(m.routeId)?.options.notFoundComponent,
    );
    return owner ? (
      <RouteSlot router={router} routeId={owner.routeId} slot="notFoundComponent" />
    ) : null;
  }
  const options = router.routesById.get(match.routeId)?.options ?? {};
  const Component = options.component;
  const body = Component ? <Component /> : <Outlet />;
  const ErrorView = options.errorComponent;
  if (error && index === matches.length - 1 && ErrorView) {
    return <ErrorView error={error as Error} reset={() => void router.invalidate()} />;
  }
  const content = <MatchIndexCtx.Provider value={index}>{body}</MatchIndexCtx.Provider>;
  return ErrorView && !router.options.disableGlobalCatchBoundary ? (
    <CatchBoundary fallback={ErrorView} onReset={() => void router.invalidate()} resetKey={href}>
      {content}
    </CatchBoundary>
  ) : (
    content
  );
}

export function Outlet() {
  return <MatchView index={use(MatchIndexCtx) + 1} />;
}

export function RouterProvider({ router }: { router: Router }) {
  const location = useSyncExternalStore(router.subscribeState, () => router.state.location);
  const status = useSyncExternalStore(router.subscribeState, () => router.state.status);
  const hasMatches = useSyncExternalStore(
    router.subscribeState,
    () => router.state.matches.length > 0,
  );
  const rendered = useRef<ParsedLocation | undefined>(undefined);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the first load once the provider mounts.
  useLayoutEffect(() => {
    if (router.state.status === "pending" && router.state.matches.length === 0) void router.load();
  }, [router]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports each committed location to onRendered listeners.
  useLayoutEffect(() => {
    if (!hasMatches || rendered.current === location) return;
    const from = rendered.current;
    rendered.current = location;
    router.emit("onRendered", from, location);
  }, [router, location, hasMatches]);
  let body: ReactNode = <MatchView index={0} />;
  if (!hasMatches && status === "pending") {
    const owner = router
      .matchRoutes(router.latestLocation)
      .findLast((m) => router.routesById.get(m.routeId)?.options.pendingComponent);
    body = owner ? (
      <RouteSlot router={router} routeId={owner.routeId} slot="pendingComponent" />
    ) : null;
  }
  return (
    <RouterCtx.Provider value={router}>
      <MatchIndexCtx.Provider value={0}>{body}</MatchIndexCtx.Provider>
    </RouterCtx.Provider>
  );
}
