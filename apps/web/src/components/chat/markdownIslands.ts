import {
  elToHtml,
  elToReact,
  elToReactProps,
  VOID_HTML_TAGS,
  type ElContent,
  type ElElement,
  type ElProperties,
  type ElRoot,
} from "@t3tools/shared/markdownHast";
import { createElement, Fragment as ReactFragment, type ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

type MarkdownComponentMap = Readonly<Record<string, unknown>>;

export interface MarkdownIslandOptions {
  readonly components: MarkdownComponentMap;
  /** Elements that need their React component; everything else renders as static HTML. */
  readonly isIsland: (node: ElElement) => boolean;
  /** What a static element's component would have added, or the node itself when nothing. */
  readonly staticElement: (node: ElElement) => ElElement;
  /** Separates static HTML that `staticElement` renders differently, such as a heading offset. */
  readonly variant: string;
}

const jsxRuntime = { Fragment, jsx, jsxs };

// Static HTML depends only on the cached, immutable tree and the variant.
const innerHtmlCache = new WeakMap<ElElement, { variant: string; html: string }>();

function transformStatic(
  node: ElContent,
  staticElement: MarkdownIslandOptions["staticElement"],
): ElContent {
  if (node.type !== "element") return node;
  const element = staticElement(node);
  let children: ElContent[] | undefined;
  for (let index = 0; index < element.children.length; index++) {
    const child = element.children[index]!;
    const next = transformStatic(child, staticElement);
    if (next !== child) {
      children ??= element.children.slice();
      children[index] = next;
    }
  }
  return children ? { ...element, children } : element;
}

function innerHtml(node: ElElement, options: MarkdownIslandOptions): string {
  const cached = innerHtmlCache.get(node);
  if (cached?.variant === options.variant) return cached.html;
  let html = "";
  for (const child of node.children) {
    html += elToHtml(transformStatic(child, options.staticElement));
  }
  innerHtmlCache.set(node, { variant: options.variant, html });
  return html;
}

interface Plan {
  readonly islands: Set<ElElement>;
  /** Elements with an island somewhere below them. */
  readonly ancestors: Set<ElElement>;
}

function renderContent(
  node: ElContent,
  key: number,
  options: MarkdownIslandOptions,
  plan: Plan,
): ReactNode {
  if (node.type === "text") return node.value;
  if (plan.islands.has(node)) {
    return createElement(
      ReactFragment,
      { key },
      elToReact<ReactNode>(node, jsxRuntime, {
        components: options.components,
        passNode: true,
      }),
    );
  }
  const element = options.staticElement(node);
  const props: Record<string, unknown> = { ...elToReactProps(element), key };
  if (plan.ancestors.has(node)) {
    return createElement(
      element.tagName,
      props,
      ...element.children.map((child, index) => renderContent(child, index, options, plan)),
    );
  }
  if (element.children.length > 0 && !VOID_HTML_TAGS.has(element.tagName)) {
    props.dangerouslySetInnerHTML = { __html: innerHtml(node, options) };
  }
  return createElement(element.tagName, props);
}

/**
 * Renders an Element tree with React only on the path to elements that need a component: subtrees
 * without one become static HTML, which the browser builds without React reconciling each node.
 */
export function renderHastWithIslands(tree: ElRoot, options: MarkdownIslandOptions): ReactNode {
  // The same elements again let React skip the block; islands still follow their context.
  let signature = options.variant;
  const plan: Plan = { islands: new Set(), ancestors: new Set() };
  const visit = (node: ElRoot | ElElement): boolean => {
    let below = false;
    for (const child of node.children) {
      if (child.type !== "element") continue;
      const island = options.isIsland(child);
      signature += island ? "1" : "0";
      if (island) {
        plan.islands.add(child);
        below = true;
        continue;
      }
      if (visit(child)) {
        plan.ancestors.add(child);
        below = true;
      }
    }
    return below;
  };
  visit(tree);
  const cached = renderedTrees.get(tree);
  if (cached?.signature === signature && cached.components === options.components) {
    return cached.node;
  }
  const node = tree.children.map((child, index) => renderContent(child, index, options, plan));
  renderedTrees.set(tree, { signature, components: options.components, node });
  return node;
}

const renderedTrees = new WeakMap<
  ElRoot,
  { signature: string; components: MarkdownComponentMap; node: ReactNode }
>();

export function withProperties(node: ElElement, properties: ElProperties): ElElement {
  return { ...node, properties: { ...node.properties, ...properties } };
}
