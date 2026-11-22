import { isLocalEditorFileUrl, LOCAL_FILE_LINK_SCHEMES } from "@t3tools/contracts";

import { CODEX_ARTIFACT_TEMPLATE_HAST_PROPERTIES } from "../codexArtifactTemplates.ts";
import { isWindowsDrivePathHref } from "../markdownLinks.ts";
import { THREAD_LINK_PROTOCOL } from "../threadLinks.ts";
import { decodeHtmlEntities } from "./entities.ts";
import type { ElContent, ElElement, ElProperties, ElRoot } from "./types.ts";

// GitHub / defaultSchema safe HTML tags.
export const SAFE_HTML_TAGS = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "br",
  "b",
  "i",
  "strong",
  "em",
  "a",
  "pre",
  "code",
  "img",
  "tt",
  "div",
  "ins",
  "del",
  "sup",
  "sub",
  "p",
  "ol",
  "ul",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "blockquote",
  "dl",
  "dt",
  "dd",
  "kbd",
  "q",
  "samp",
  "var",
  "hr",
  "ruby",
  "rt",
  "rp",
  "li",
  "tr",
  "td",
  "th",
  "s",
  "strike",
  "summary",
  "details",
  "caption",
  "figure",
  "figcaption",
  "abbr",
  "bdo",
  "cite",
  "dfn",
  "mark",
  "small",
  "span",
  "time",
  "wbr",
  "input",
  "picture",
  "section",
  "hgroup",
  "center",
  "bdi",
  "u",
]);

// Elements whose contents are completely dropped by the sanitizer (never unwrapped as text).
export const STRIP_CONTENT_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
  "textarea",
  "title",
  "xmp",
  "svg",
  "math",
  "template",
]);

export const VOID_HTML_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

export const CLOSES_PARAGRAPH_TAGS = new Set(
  "address article aside blockquote center details dialog dir div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr li listing main menu nav ol p plaintext pre search section summary table ul xmp dd dt".split(
    " ",
  ),
);

const PARAGRAPH_SCOPE_TAGS = new Set([
  "applet",
  "caption",
  "table",
  "td",
  "th",
  "marquee",
  "object",
  "template",
  "button",
]);

const RAW_TEXT_TAGS = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "plaintext",
]);

const GLOBAL_ATTRS = new Set([
  "abbr",
  "accept",
  "acceptCharset",
  "accessKey",
  "action",
  "align",
  "alt",
  "ariaDescribedBy",
  "ariaHidden",
  "ariaLabel",
  "ariaLabelledBy",
  "axis",
  "border",
  "cellPadding",
  "cellSpacing",
  "char",
  "charOff",
  "charSet",
  "checked",
  "clear",
  "cols",
  "colSpan",
  "color",
  "compact",
  "coords",
  "dateTime",
  "dir",
  "disabled",
  "encType",
  "htmlFor",
  "frame",
  "headers",
  "height",
  "hrefLang",
  "hSpace",
  "id",
  "isMap",
  "label",
  "lang",
  "maxLength",
  "media",
  "method",
  "multiple",
  "name",
  "noHref",
  "noShade",
  "noWrap",
  "open",
  "prompt",
  "readOnly",
  "rel",
  "rev",
  "rows",
  "rowSpan",
  "rules",
  "scope",
  "selected",
  "shape",
  "size",
  "span",
  "start",
  "summary",
  "tabIndex",
  "useMap",
  "vAlign",
  "value",
  "vSpace",
  "width",
  "itemProp",
]);

const TAG_EXTRA_ATTRS: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(["href", "dataFootnoteRef", "dataFootnoteBackref", "dataPullRequestAutolink"]),
  blockquote: new Set(["cite", "dataAlert"]),
  code: new Set(["className", "dataCodeMeta", "dataInlineCode"]),
  del: new Set(["cite"]),
  div: new Set(["itemScope", "itemType", ...CODEX_ARTIFACT_TEMPLATE_HAST_PROPERTIES]),
  h2: new Set(["className"]),
  img: new Set([
    "src",
    "longDesc",
    "dataDarkSrc",
    "dataLightSrc",
    "dataLocalSrc",
    "dataMarkdownTitle",
    "dataStandalone",
  ]),
  input: new Set(["type", "disabled", "checked"]),
  ins: new Set(["cite"]),
  li: new Set(["className", "value"]),
  ol: new Set(["className", "start"]),
  q: new Set(["cite"]),
  section: new Set(["dataFootnotes", "className"]),
  span: new Set(["dataLeadingWhitespace"]),
  ul: new Set(["className"]),
};

const CLOBBER_ATTRS = new Set(["id", "name"]);

export const HREF_PROTOCOLS = new Set([
  "http",
  "https",
  "mailto",
  "irc",
  "ircs",
  "xmpp",
  "file",
  "t3-citation",
  "t3-context",
  THREAD_LINK_PROTOCOL,
  ...LOCAL_FILE_LINK_SCHEMES,
]);

export const SRC_PROTOCOLS = new Set(["http", "https", "file", "t3-context"]);
const CITE_PROTOCOLS = new Set(["http", "https"]);

const PROTOCOL_BY_ATTR: Readonly<Record<string, ReadonlySet<string>>> = {
  href: HREF_PROTOCOLS,
  src: SRC_PROTOCOLS,
  dataDarkSrc: SRC_PROTOCOLS,
  dataLightSrc: SRC_PROTOCOLS,
  cite: CITE_PROTOCOLS,
  longDesc: CITE_PROTOCOLS,
};

const HTML_ATTR_TO_PROP: Readonly<Record<string, string>> = {
  class: "className",
  for: "htmlFor",
  colspan: "colSpan",
  rowspan: "rowSpan",
  tabindex: "tabIndex",
  readonly: "readOnly",
  maxlength: "maxLength",
  cellpadding: "cellPadding",
  cellspacing: "cellSpacing",
  hreflang: "hrefLang",
  datetime: "dateTime",
  usemap: "useMap",
  ismap: "isMap",
  longdesc: "longDesc",
  srcset: "srcSet",
  itemprop: "itemProp",
  itemscope: "itemScope",
  itemtype: "itemType",
  valign: "vAlign",
  hspace: "hSpace",
  vspace: "vSpace",
  enctype: "encType",
  charset: "charSet",
  "accept-charset": "acceptCharset",
  accesskey: "accessKey",
  charoff: "charOff",
  nohref: "noHref",
  noshade: "noShade",
  nowrap: "noWrap",
  "aria-label": "ariaLabel",
  "aria-describedby": "ariaDescribedBy",
  "aria-labelledby": "ariaLabelledBy",
  "aria-hidden": "ariaHidden",
};

export const BOOLEAN_PROPS = new Set([
  "checked",
  "disabled",
  "open",
  "readOnly",
  "multiple",
  "selected",
  "isMap",
  "compact",
  "noHref",
  "noShade",
  "noWrap",
  "itemScope",
  "dataStandalone",
]);

const SPACE_SEPARATED_PROPS = new Set(["className", "ariaDescribedBy", "ariaLabelledBy", "rel"]);

export function htmlAttrToProp(attrName: string): string {
  const lower = attrName.toLowerCase();
  const mapped = HTML_ATTR_TO_PROP[lower];
  if (mapped) return mapped;
  if (lower.startsWith("data-") || lower.startsWith("aria-")) {
    return lower.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  }
  return lower;
}

export function isAllowedProtocol(value: string, allowed: ReadonlySet<string>): boolean {
  // Strip ASCII whitespace/control characters before checking protocol, matching browser/hast-util-sanitize.
  let colon = -1;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 58 /* : */) {
      colon = i;
      break;
    }
    if (c === 47 /* / */ || c === 63 /* ? */ || c === 35 /* # */) {
      return true;
    }
  }
  if (colon === -1) return true;
  const scheme = value
    .slice(0, colon)
    .replace(/[\x00-\x20]/g, "")
    .toLowerCase();
  return allowed.has(scheme);
}

function isAllowedClassValue(tagName: string, token: string): boolean {
  if (tagName === "code") {
    return (
      (token.startsWith("language-") && token.length > 9) ||
      token === "math-inline" ||
      token === "math-display"
    );
  }
  if (tagName === "a") return token === "data-footnote-backref";
  if (tagName === "h2") return token === "sr-only";
  if (tagName === "li") return token === "task-list-item";
  if (tagName === "ul" || tagName === "ol") return token === "contains-task-list";
  if (tagName === "section") return token === "footnotes";
  return false;
}

function sanitizeProperties(tagName: string, rawProps: ElProperties): ElProperties {
  const out: ElProperties = {};
  const extra = TAG_EXTRA_ATTRS[tagName];

  if (tagName === "input") {
    if (rawProps.type !== "checkbox") return out;
  }

  for (const key of Object.keys(rawProps)) {
    const rawValue = rawProps[key];
    if (
      rawValue === null ||
      rawValue === undefined ||
      rawValue === false ||
      Number.isNaN(rawValue)
    ) {
      continue;
    }
    if (!GLOBAL_ATTRS.has(key) && !extra?.has(key)) continue;

    if (key === "className") {
      const tokens = Array.isArray(rawValue)
        ? rawValue.map(String)
        : String(rawValue).split(/\s+/).filter(Boolean);
      const filtered = tokens.filter((token) => isAllowedClassValue(tagName, token));
      if (filtered.length > 0) out.className = filtered;
      continue;
    }

    if (tagName === "input") {
      if (key === "type" && rawValue === "checkbox") {
        out.type = "checkbox";
      } else if (key === "checked" && rawValue) {
        out.checked = true;
      } else if (key === "disabled" && rawValue) {
        out.disabled = true;
      }
      continue;
    }

    const protocols = PROTOCOL_BY_ATTR[key];
    if (protocols) {
      const str = String(rawValue);
      if (!isAllowedProtocol(str, protocols)) continue;
      out[key] = str;
      continue;
    }

    if (CLOBBER_ATTRS.has(key)) {
      const str = String(rawValue);
      out[key] = `user-content-${str}`;
      continue;
    }

    if (key === "ariaDescribedBy" && Array.isArray(rawValue)) {
      out[key] = rawValue.map((token) => `user-content-${String(token)}`);
      continue;
    }

    if (BOOLEAN_PROPS.has(key)) {
      if (rawValue) out[key] = true;
      continue;
    }

    out[key] = rawValue === true ? "" : rawValue;
  }

  return out;
}

function sanitizeNode(node: ElContent): ElContent[] {
  if (node.type === "text") return [node];
  const tagName = node.tagName.toLowerCase();
  if (STRIP_CONTENT_TAGS.has(tagName)) return [];

  const sanitizedChildren: ElContent[] = [];
  for (const child of node.children) {
    sanitizedChildren.push(...sanitizeNode(child));
  }

  if (!SAFE_HTML_TAGS.has(tagName)) {
    return sanitizedChildren;
  }

  if (tagName === "input" && node.properties.type !== "checkbox") {
    return [];
  }

  const element: ElElement = {
    type: "element",
    tagName,
    properties: sanitizeProperties(tagName, node.properties),
    children: VOID_HTML_TAGS.has(tagName) ? [] : sanitizedChildren,
    ...(node.position ? { position: node.position } : {}),
  };
  return [element];
}

/** Strict allowlist sanitizer matching T3 Code's `CHAT_MARKDOWN_SANITIZE_SCHEMA`. */
export function sanitizeElTree(root: ElRoot): ElRoot {
  const children: ElContent[] = [];
  for (const child of root.children) {
    children.push(...sanitizeNode(child));
  }
  return {
    type: "root",
    children,
    ...(root.position ? { position: root.position } : {}),
  };
}

// --- Raw HTML parsing & T3 post-processing ---

const TAG_REGEX =
  /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|<!--(?:-?>|[\s\S]*?(?:-->|$))|<![^>]*>|<\?[\s\S]*?\?>/g;
const ATTR_REGEX = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

export interface RawHtmlToken {
  readonly kind: "open" | "close" | "comment" | "text";
  readonly tagName?: string;
  readonly raw: string;
  readonly properties?: ElProperties;
  readonly selfClosing?: boolean;
}

export function parseRawHtmlAttributes(attrSource: string | undefined): ElProperties {
  const result: ElProperties = {};
  if (!attrSource) return result;
  ATTR_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_REGEX.exec(attrSource)) !== null) {
    const rawName = match[1]!;
    const prop = htmlAttrToProp(rawName);
    const rawVal = match[2] ?? match[3] ?? match[4];
    if (rawVal === undefined) {
      result[prop] = BOOLEAN_PROPS.has(prop) ? true : "";
      continue;
    }
    const decoded = rawVal.includes("&") ? decodeHtmlEntities(rawVal, { attribute: true }) : rawVal;
    if (SPACE_SEPARATED_PROPS.has(prop)) {
      result[prop] = decoded.split(/\s+/).filter(Boolean);
    } else if (BOOLEAN_PROPS.has(prop)) {
      result[prop] = true;
    } else {
      result[prop] = decoded;
    }
  }
  return result;
}

export interface RawHtmlBuilder {
  readonly root: ElRoot;
  readonly pushNode: (node: ElContent) => void;
  readonly pushRawHtml: (raw: string) => void;
  readonly finish: () => ElRoot;
}

function findOpenParagraph(stack: ReadonlyArray<ElRoot | ElElement>): number {
  for (let i = stack.length - 1; i > 0; i--) {
    const tag = (stack[i] as ElElement).tagName;
    if (tag === "p") return i;
    if (PARAGRAPH_SCOPE_TAGS.has(tag)) return -1;
  }
  return -1;
}

function appendText(parent: ElRoot | ElElement, value: string) {
  if (!value) return;
  const prev = parent.children.at(-1);
  if (prev?.type === "text") prev.value += value;
  else parent.children.push({ type: "text", value });
}

/**
 * Incremental HTML tree builder that interleaves structured Markdown elements with raw HTML
 * fragments without ever serializing Markdown to HTML strings or invoking parse5.
 */
export function createRawHtmlBuilder(root: ElRoot): RawHtmlBuilder {
  const stack: Array<ElRoot | ElElement> = [root];
  const bareAnchors: Array<{ element: ElElement; parent: ElRoot | ElElement; tag: string } | null> =
    [];
  let rawTextTag: string | undefined;

  const pushNode = (node: ElContent) => {
    const parent = stack.at(-1)!;
    if (node.type === "element" && CLOSES_PARAGRAPH_TAGS.has(node.tagName)) {
      const pIdx = findOpenParagraph(stack);
      if (pIdx > 0) stack.length = pIdx;
    }
    const target = stack.at(-1)!;
    if (node.type === "text") {
      appendText(target, node.value);
    } else {
      target.children.push(node);
    }
  };

  const pushRawHtml = (raw: string) => {
    let offset = 0;
    while (offset < raw.length) {
      if (rawTextTag) {
        if (rawTextTag === "plaintext") {
          appendText(stack.at(-1)!, raw.slice(offset));
          return;
        }
        const closeRe = new RegExp(`</${rawTextTag}\\s*>`, "gi");
        closeRe.lastIndex = offset;
        const m = closeRe.exec(raw);
        if (!m) {
          appendText(stack.at(-1)!, raw.slice(offset));
          return;
        }
        appendText(stack.at(-1)!, raw.slice(offset, m.index));
        offset = closeRe.lastIndex;
        const closingTag = rawTextTag;
        rawTextTag = undefined;
        const at = stack.findLastIndex((n) => n.type === "element" && n.tagName === closingTag);
        if (at > 0) stack.length = at;
        continue;
      }

      TAG_REGEX.lastIndex = offset;
      const match = TAG_REGEX.exec(raw);
      if (!match) {
        appendText(stack.at(-1)!, decodeHtmlEntities(raw.slice(offset)));
        break;
      }
      if (match.index > offset) {
        appendText(stack.at(-1)!, decodeHtmlEntities(raw.slice(offset, match.index)));
      }
      offset = match.index + match[0].length;

      const isClose = match[1] === "/";
      const tagName = match[2]?.toLowerCase();
      if (!tagName) continue; // comment, doctype, PI

      if (isClose) {
        if (tagName === "a") bareAnchors.pop();
        if (tagName === "p" && findOpenParagraph(stack) < 0) {
          stack.at(-1)!.children.push({
            type: "element",
            tagName: "p",
            properties: {},
            children: [],
          });
          continue;
        }
        const at = stack.findLastIndex((n) => n.type === "element" && n.tagName === tagName);
        if (at > 0) stack.length = at;
        continue;
      }

      if (CLOSES_PARAGRAPH_TAGS.has(tagName)) {
        const pIdx = findOpenParagraph(stack);
        if (pIdx > 0) stack.length = pIdx;
      }

      const props = parseRawHtmlAttributes(match[3]);
      const element: ElElement = {
        type: "element",
        tagName,
        properties: props,
        children: [],
      };
      const parent = stack.at(-1)!;
      parent.children.push(element);

      if (tagName === "a") {
        const isBare = !match[3]?.trim() && /^<a\s*\/?>$/i.test(match[0]);
        bareAnchors.push(isBare ? { element, parent, tag: match[0] } : null);
      }

      if (RAW_TEXT_TAGS.has(tagName)) {
        stack.push(element);
        rawTextTag = tagName;
      } else if (!VOID_HTML_TAGS.has(tagName)) {
        stack.push(element);
      }
    }
  };

  const finish = () => {
    for (const anchor of bareAnchors) {
      if (!anchor) continue;
      const siblings = anchor.parent.children;
      const idx = siblings.indexOf(anchor.element);
      if (idx >= 0) {
        siblings.splice(idx, 1, { type: "text", value: anchor.tag }, ...anchor.element.children);
      }
    }
    normalizeRawTables(root);
    return root;
  };

  return { root, pushNode, pushRawHtml, finish };
}

function normalizeRawTables(node: ElRoot | ElElement): void {
  for (const child of node.children) {
    if (child.type === "element") normalizeRawTables(child);
  }
  if (node.type !== "element" || node.tagName !== "table") return;
  const firstTr = node.children.findIndex(
    (child) => child.type === "element" && child.tagName === "tr",
  );
  if (firstTr < 0) return;
  node.children = [
    ...node.children.slice(0, firstTr),
    {
      type: "element",
      tagName: "tbody",
      properties: {},
      children: node.children.slice(firstTr),
    },
  ];
}

// --- Image source meta & local editor links (replaces markdownHast rehype passes) ---

const STANDALONE_IMAGE_BLOCKS = new Set([
  "p",
  "div",
  "li",
  "td",
  "th",
  "figure",
  "center",
  "blockquote",
]);

const COLOR_SCHEME_MEDIA = /^\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)$/i;

function meaningfulChildren(node: ElRoot | ElElement): ElContent[] {
  return node.children.filter((c) => !(c.type === "text" && c.value.trim() === ""));
}

function soleImageDescendant(node: ElRoot | ElElement): ElElement | undefined {
  const children = meaningfulChildren(node);
  if (children.length !== 1) return undefined;
  const only = children[0];
  if (only?.type !== "element") return undefined;
  if (only.tagName === "img") return only;
  return only.tagName === "a" || only.tagName === "strong" || only.tagName === "em"
    ? soleImageDescendant(only)
    : undefined;
}

function markStandaloneImages(node: ElRoot | ElElement): void {
  if (node.type === "root" || STANDALONE_IMAGE_BLOCKS.has(node.tagName)) {
    const img = soleImageDescendant(node);
    if (img) img.properties = { ...img.properties, dataStandalone: true };
  }
  for (const child of node.children) {
    if (child.type === "element") markStandaloneImages(child);
  }
}

function moveColorSchemeSourcesToImage(picture: ElElement): void {
  const image = picture.children.find(
    (child): child is ElElement => child.type === "element" && child.tagName === "img",
  );
  for (const source of picture.children) {
    if (source.type !== "element" || source.tagName !== "source" || !image) continue;
    const media = source.properties.media;
    const scheme = typeof media === "string" ? COLOR_SCHEME_MEDIA.exec(media)?.[1] : undefined;
    const srcSet = source.properties.srcSet;
    const candidate = Array.isArray(srcSet) ? srcSet[0] : srcSet;
    const url =
      typeof candidate === "string" ? candidate.trim().split(/\s/, 1)[0]?.replace(/,+$/, "") : "";
    const key = scheme?.toLowerCase() === "dark" ? "dataDarkSrc" : "dataLightSrc";
    if (scheme && url && image.properties[key] === undefined) {
      const value = isWindowsDrivePathHref(url) ? `file:///${url.replaceAll("\\", "/")}` : url;
      image.properties = { ...image.properties, [key]: value };
    }
  }
  picture.children = picture.children.filter(
    (child) => !(child.type === "element" && child.tagName === "source"),
  );
}

export function preserveImageSourceMetaOnTree(root: ElRoot): void {
  const visit = (node: ElRoot | ElElement) => {
    if (node.type === "element" && node.tagName === "picture") {
      moveColorSchemeSourcesToImage(node);
    }
    if (node.type === "element" && node.tagName === "img") {
      const src = node.properties.src;
      const title = node.properties.title;
      node.properties = {
        ...node.properties,
        ...(typeof src === "string" && isWindowsDrivePathHref(src) ? { dataLocalSrc: src } : {}),
        ...(typeof title === "string" ? { dataMarkdownTitle: title } : {}),
      };
    }
    for (const child of node.children) {
      if (child.type === "element") visit(child);
    }
  };
  visit(root);
  markStandaloneImages(root);
}

function normalizeLocalEditorHref(href: string): string {
  try {
    const url = new URL(href);
    return isLocalEditorFileUrl(url) ? url.href : href;
  } catch {
    return href;
  }
}

export function normalizeLocalEditorLinksOnTree(root: ElRoot): void {
  const visit = (node: ElRoot | ElElement) => {
    if (node.type === "element" && node.tagName === "a") {
      const href = node.properties.href;
      if (typeof href === "string") {
        const normalized = normalizeLocalEditorHref(href);
        if (normalized !== href) node.properties = { ...node.properties, href: normalized };
      }
    }
    for (const child of node.children) {
      if (child.type === "element") visit(child);
    }
  };
  visit(root);
}
