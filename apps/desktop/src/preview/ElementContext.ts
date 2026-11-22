import type { PickedElementPayload, PickedElementStackFrame } from "@t3tools/contracts";

export type ElementContext = Pick<
  PickedElementPayload,
  "selector" | "htmlPreview" | "componentName" | "source" | "stack" | "styles"
>;

/** The React fiber fields read here; React 18 records `_debugSource`, React 19 `_debugStack`. */
interface Fiber {
  readonly type?: unknown;
  readonly return?: Fiber | null;
  readonly _debugOwner?: Fiber | null;
  readonly _debugSource?: { fileName?: string; lineNumber?: number; columnNumber?: number } | null;
  readonly _debugStack?: { stack?: unknown } | null;
  /** Server component owners in React 19 are plain `{ name }` records. */
  readonly name?: string;
}

const HTML_PREVIEW_MAX_CHARS = 500;
const MAX_FRAMES = 50;
const SEMANTIC_ATTRIBUTES = [
  "data-testid",
  "data-test-id",
  "data-test",
  "data-cy",
  "data-qa",
  "aria-label",
  "role",
  "name",
  "title",
  "alt",
];
const STYLE_PROPERTIES =
  `display position top right bottom left z-index overflow-x overflow-y width height
min-width min-height max-width max-height margin-top margin-right margin-bottom margin-left padding-top
padding-right padding-bottom padding-left flex-direction flex-wrap justify-content align-items align-self
align-content flex-grow flex-shrink flex-basis order row-gap column-gap grid-template-columns
grid-template-rows grid-template-areas font-family font-size font-weight font-style line-height
letter-spacing text-align text-decoration-line text-transform text-overflow text-shadow white-space
word-break overflow-wrap vertical-align color background-color background-image background-position
background-size background-repeat border-top-width border-right-width border-bottom-width
border-left-width border-top-style border-right-style border-bottom-style border-left-style
border-top-color border-right-color border-bottom-color border-left-color border-top-left-radius
border-top-right-radius border-bottom-left-radius border-bottom-right-radius box-shadow opacity transform
filter backdrop-filter object-fit object-position`.split(/\s+/);
// Frames React itself adds around the JSX call site.
const REACT_INTERNAL_FRAME = /node_modules|react-stack-|\bjsx(?:DEV|s)?\b|\bcreateElement\b/;

function fiberOf(element: Element): Fiber | null {
  const hook = (
    globalThis as {
      __REACT_DEVTOOLS_GLOBAL_HOOK__?: {
        renderers?: Map<unknown, { findFiberByHostInstance?: (node: Element) => Fiber | null }>;
      };
    }
  ).__REACT_DEVTOOLS_GLOBAL_HOOK__;
  for (let node: Element | null = element; node; node = node.parentElement) {
    const key = Object.keys(node).find(
      (name) => name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$"),
    );
    if (key) return (node as unknown as Record<string, Fiber>)[key] ?? null;
    for (const renderer of hook?.renderers?.values() ?? []) {
      const fiber = renderer.findFiberByHostInstance?.(node);
      if (fiber) return fiber;
    }
  }
  return null;
}

/** A component's name, looking through ForwardRef (`render`) and Memo (`type`) wrappers. */
function nameOf(type: unknown): string | null {
  for (let depth = 0; depth < 5 && type; depth++) {
    if (typeof type === "function") {
      return (type as { displayName?: string }).displayName || type.name || null;
    }
    if (typeof type !== "object") return null;
    const wrapper = type as { displayName?: string; render?: unknown; type?: unknown };
    if (wrapper.displayName) return wrapper.displayName;
    type = wrapper.render ?? wrapper.type;
  }
  return null;
}

function sourceOf(fiber: Fiber): Omit<PickedElementStackFrame, "functionName"> | null {
  const source = fiber._debugSource;
  if (source?.fileName) {
    return {
      fileName: source.fileName,
      lineNumber: source.lineNumber ?? null,
      columnNumber: source.columnNumber ?? null,
    };
  }
  const stack = fiber._debugStack?.stack;
  if (typeof stack !== "string") return null;
  for (const line of stack.split("\n").slice(1)) {
    const frame = /^\s*at (?:.*? \()?(.+?):(\d+):(\d+)\)?$|^.*@(.+?):(\d+):(\d+)$/.exec(
      line.trim(),
    );
    if (!frame || REACT_INTERNAL_FRAME.test(line)) continue;
    const [file = "", lineNumber, columnNumber] = frame[1] ? frame.slice(1, 4) : frame.slice(4, 7);
    return {
      fileName: file.replace(/[?#].*$/, "").replace(location.origin, ""),
      lineNumber: Number(lineNumber),
      columnNumber: Number(columnNumber),
    };
  }
  return null;
}

/** Each JSX call site from the element up its owners: where it was written and in which component. */
function stackOf(host: Fiber): PickedElementStackFrame[] {
  const frames: PickedElementStackFrame[] = [];
  const seen = new Set<Fiber>();
  for (let fiber: Fiber | null = host; fiber && !seen.has(fiber) && frames.length < MAX_FRAMES;) {
    seen.add(fiber);
    const owner: Fiber | null = fiber._debugOwner ?? null;
    const source = sourceOf(fiber);
    const functionName = owner ? (nameOf(owner.type) ?? owner.name ?? null) : null;
    if (source || functionName) {
      frames.push({
        functionName,
        fileName: null,
        lineNumber: null,
        columnNumber: null,
        ...source,
      });
    }
    fiber = owner;
  }
  return frames;
}

function componentNameOf(host: Fiber): string | null {
  const seen = new Set<Fiber>();
  for (let fiber = host.return; fiber && !seen.has(fiber); fiber = fiber.return) {
    seen.add(fiber);
    const name = nameOf(fiber.type);
    if (name) return name;
  }
  return null;
}

const escapeCss = (value: string) =>
  globalThis.CSS?.escape?.(value) ?? value.replace(/[^\w-]/g, (char) => `\\${char}`);

function isUnique(element: Element, selector: string): boolean {
  try {
    const matches = element.ownerDocument.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === element;
  } catch {
    return false;
  }
}

function anchorOf(element: Element): string | null {
  if (element.id) {
    const selector = `#${escapeCss(element.id)}`;
    if (isUnique(element, selector)) return selector;
  }
  const tag = element.tagName.toLowerCase();
  for (const attribute of SEMANTIC_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (!value || value.length > 120) continue;
    const selector = `${tag}[${attribute}=${JSON.stringify(value)}]`;
    if (isUnique(element, selector)) return selector;
  }
  return null;
}

/** The shortest `>` path from the element or a uniquely identified ancestor down to it. */
function uniqueSelector(element: Element): string | null {
  const parts: string[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    const tagName = node.tagName;
    const siblings = Array.from(node.parentElement?.children ?? []).filter(
      (sibling) => sibling.tagName === tagName,
    );
    parts.unshift(
      anchorOf(node) ??
        (siblings.length > 1
          ? `${tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`
          : tagName.toLowerCase()),
    );
    const selector = parts.join(" > ");
    if (isUnique(element, selector)) return selector;
  }
  return null;
}

const baselines = new Map<string, ReadonlyMap<string, string>>();

/** User-agent defaults for `tag`, computed in a throwaway frame the page's CSS does not reach. */
function baselineOf(tag: string): ReadonlyMap<string, string> | undefined {
  const cached = baselines.get(tag);
  if (cached) return cached;
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;left:-9999px;width:0;height:0;border:0;visibility:hidden";
  document.documentElement.append(frame);
  try {
    const body = frame.contentDocument?.body;
    const view = frame.contentWindow;
    if (!body || !view) return undefined;
    const probe = body.appendChild(body.ownerDocument.createElement(tag));
    const computed = view.getComputedStyle(probe);
    const baseline = new Map(
      STYLE_PROPERTIES.map((name) => [name, computed.getPropertyValue(name)]),
    );
    baselines.set(tag, baseline);
    return baseline;
  } finally {
    frame.remove();
  }
}

/** The class list, then every summarized property whose computed value differs from the default. */
function stylesOf(element: Element): string {
  const baseline = baselineOf(element.tagName.toLowerCase());
  const computed = getComputedStyle(element);
  const lines = baseline
    ? STYLE_PROPERTIES.flatMap((name) => {
        const value = computed.getPropertyValue(name);
        if (!value || value === baseline.get(name)) return [];
        // A side's border style and color say nothing while its width is zero.
        const side = /^border-(top|right|bottom|left)-(?:style|color)$/.exec(name)?.[1];
        const width = side && computed.getPropertyValue(`border-${side}-width`);
        return width === "0px" || width === "0" ? [] : [`${name}: ${value};`];
      })
    : [];
  const className = element.getAttribute("class")?.trim();
  const declarations = lines.join("\n");
  if (!className) return declarations;
  return declarations ? `className: ${className}\n\n${declarations}` : `className: ${className}`;
}

export function getElementContext(element: Element): ElementContext {
  const fiber = fiberOf(element);
  const stack = fiber ? stackOf(fiber) : [];
  return {
    selector: uniqueSelector(element),
    htmlPreview: element.outerHTML.slice(0, HTML_PREVIEW_MAX_CHARS),
    componentName: fiber ? componentNameOf(fiber) : null,
    source: stack[0] ?? null,
    stack,
    styles: stylesOf(element),
  };
}
