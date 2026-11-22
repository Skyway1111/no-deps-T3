import {
  elToReact,
  URL_ATTRIBUTES,
  type ElElement,
  type ElNode,
  type ElRoot,
} from "@t3tools/shared/markdownHast";
import type { ReactElement } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

import { wordsHast, type WordsHastOptions } from "../../markdown/wordsHast";

export type MarkdownUrlTransform = (url: string, key: string, node: ElElement) => string;

type MarkdownComponentMap = Readonly<Record<string, unknown>>;

interface MarkdownRendererOptions {
  readonly markdown: WordsHastOptions;
  readonly components: MarkdownComponentMap;
  readonly urlTransform: MarkdownUrlTransform;
}

// Elements are immutable, so a remount (a thread switch, a row scrolled back into view)
// reuses one instead of parsing again. Parsing is most of the cost of rendering markdown.
// An element and the tree it keeps hold about 20 bytes per source character, so ~10 MB.
const MAX_CACHED_CHARS = 500_000;
interface Rendered {
  readonly tree: ElRoot;
  element?: ReactElement;
}
const rendered = new Map<string, Rendered>();
let cachedChars = 0;
let nextRendererId = 0;

// A short block still holds a whole element tree.
const ENTRY_OVERHEAD_CHARS = 200;
const entrySize = (key: string) => key.length + ENTRY_OVERHEAD_CHARS;

function remember(key: string, entry: Rendered) {
  // One huge message would otherwise evict everything else.
  if (entrySize(key) > MAX_CACHED_CHARS / 4) return;
  rendered.set(key, entry);
  cachedChars += entrySize(key);
  for (const oldest of rendered.keys()) {
    if (cachedChars <= MAX_CACHED_CHARS) break;
    rendered.delete(oldest);
    cachedChars -= entrySize(oldest);
  }
}

const jsxRuntime = { Fragment, jsx, jsxs };

/** Renders markdown with the unified parser, keeping one parse cache per option set. */
export function createMarkdownRenderer({
  markdown,
  components,
  urlTransform,
}: MarkdownRendererOptions) {
  const keyPrefix = `${nextRendererId++}\u0000`;

  const prepare = (node: ElNode) => {
    if (!("children" in node)) return;
    for (const child of node.children) {
      if (child.type !== "element") continue;
      const { properties } = child;
      for (const key in properties) {
        if (!Object.hasOwn(URL_ATTRIBUTES, key)) continue;
        const tags = URL_ATTRIBUTES[key];
        if (tags === null || tags?.includes(child.tagName)) {
          properties[key] = urlTransform(String(properties[key] || ""), key, child);
        }
      }
      prepare(child);
    }
  };

  const parse = (text: string): Rendered => {
    const key = keyPrefix + text;
    const cached = rendered.get(key);
    if (cached !== undefined) {
      // Refresh its place in the eviction order.
      rendered.delete(key);
      rendered.set(key, cached);
      return cached;
    }
    const tree = wordsHast(text, markdown);
    prepare(tree);
    return { tree };
  };

  return {
    /** A cached entry, or a fresh one that `remember` can keep. Cached trees are shared, so callers must not change them. */
    parse,
    element: (entry: Rendered): ReactElement =>
      (entry.element ??= elToReact<ReactElement>(entry.tree, jsxRuntime, {
        components,
        passNode: true,
      })),
    remember(text: string, entry: Rendered) {
      const key = keyPrefix + text;
      if (!rendered.has(key)) remember(key, entry);
    },
  };
}
