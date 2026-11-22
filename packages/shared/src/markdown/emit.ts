import { resolveCodexArtifactTemplate } from "../codexArtifactTemplates.ts";
import { resolveCodexFileCitationLink } from "../codexFileCitations.ts";
import { absoluteFilePathMatches } from "../markdownLinks.ts";
import { isWindowsAbsolutePath } from "../path.ts";
import { decodeHtmlEntities, escapeHtmlAttr, escapeHtmlText } from "./entities.ts";
import { renderMathSvg, wrapMathSvg } from "./mathSvg.ts";
import { parseMarkdown, plainTextOf } from "./parser.ts";
import {
  BOOLEAN_PROPS,
  createRawHtmlBuilder,
  normalizeLocalEditorLinksOnTree,
  preserveImageSourceMetaOnTree,
  sanitizeElTree,
  VOID_HTML_TAGS,
} from "./sanitize.ts";
import type {
  ElContent,
  ElElement,
  ElNode,
  ElProperties,
  ElRoot,
  EmitOptions,
  MdDirective,
  MdList,
  MdListItem,
  MdNode,
  MdRoot,
  ParseOptions,
} from "./types.ts";

// --- Direct IR -> Element Tree compiler ---

const UNSAFE_URL_CHARS = /[\\[\]`{}|^"<> ]/g;
const normalizeUri = (value: string) =>
  value.replace(UNSAFE_URL_CHARS, (ch) => encodeURIComponent(ch));

const windowsDrivePath = (url: string): string | undefined => {
  const path = url.replace(/%5C/gi, "\\");
  return /^[A-Za-z]:[\\/]/.test(path) ? path : undefined;
};

interface EmitContext {
  readonly root: MdRoot;
  readonly opts: EmitOptions;
  readonly footnoteOrder: string[];
  readonly footnoteCounts: Map<string, number>;
  readonly mathPlaceholders: Map<string, ElElement>;
  readonly mathKey: string;
  hasRawHtml: boolean;
}

function isImageMdNode(node: MdNode | undefined): boolean {
  if (!node) return false;
  if (node.type === "image" || node.type === "imageReference") return true;
  if (node.type === "link" && node.children.length === 1) return isImageMdNode(node.children[0]);
  return false;
}

function endsWithLineBreak(node: MdNode | undefined): boolean {
  return (
    node === undefined ||
    node.type === "break" ||
    (node.type === "text" && /\n[ \t]*$/.test(node.value))
  );
}

function startsWithLineBreak(node: MdNode | undefined): boolean {
  return (
    node === undefined ||
    node.type === "break" ||
    (node.type === "text" && /^[ \t]*\n/.test(node.value))
  );
}

function startsBlankMd(node: MdNode): boolean {
  if (node.type === "text" || node.type === "inlineCode") {
    return /^[ \t\r\n]/.test(node.value);
  }
  if ("children" in node && Array.isArray(node.children) && node.children.length > 0) {
    return startsBlankMd(node.children[0]!);
  }
  return false;
}

function emitTextWithLinks(text: string, ctx: EmitContext, inLink: boolean): ElContent[] {
  const transformed = ctx.opts.transformText ? ctx.opts.transformText(text) : text;
  if (inLink) return [{ type: "text", value: transformed }];

  let parts: ElContent[] = [];
  if (ctx.opts.linkFilePaths) {
    let offset = 0;
    for (const { index, path } of absoluteFilePathMatches(transformed)) {
      if (index > offset) parts.push({ type: "text", value: transformed.slice(offset, index) });
      parts.push({
        type: "element",
        tagName: "a",
        properties: { href: path },
        children: [{ type: "text", value: path }],
      });
      offset = index + path.length;
    }
    if (offset < transformed.length) {
      parts.push({ type: "text", value: transformed.slice(offset) });
    }
  } else {
    parts.push({ type: "text", value: transformed });
  }

  const autolinks = ctx.opts.textAutolinks;
  if (autolinks) {
    parts = parts.flatMap((part) => {
      if (part.type !== "text") return [part];
      const found = autolinks(part.value);
      if (found.length === 0) return [part];
      const linked: ElContent[] = [];
      let start = 0;
      for (const ref of found) {
        if (start < ref.index) {
          linked.push({ type: "text", value: part.value.slice(start, ref.index) });
        }
        linked.push({
          type: "element",
          tagName: "a",
          properties: { href: ref.url, dataPullRequestAutolink: ref.kind },
          children: [{ type: "text", value: ref.label }],
        });
        start = ref.index + ref.text.length;
      }
      if (start < part.value.length) {
        linked.push({ type: "text", value: part.value.slice(start) });
      }
      return linked;
    });
  }

  return parts;
}

function emitInlineTextWithBreaks(
  value: string,
  ctx: EmitContext,
  inLink: boolean,
  afterOwnLineImage: boolean,
  beforeOwnLineImage: boolean,
): ElContent[] {
  const breaks = ctx.opts.breaks === true;
  if (!value.includes("\n") || (!breaks && !afterOwnLineImage && !beforeOwnLineImage)) {
    return emitTextWithLinks(value, ctx, inLink);
  }
  const lines = value.split("\n");
  const out: ElContent[] = [];
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!;
    if (idx === 0) {
      if (line) out.push(...emitTextWithLinks(line, ctx, inLink));
      continue;
    }
    const shouldBreak =
      breaks ||
      (idx === 1 && afterOwnLineImage) ||
      (idx === lines.length - 1 && beforeOwnLineImage);
    if (shouldBreak) {
      const prev = out.at(-1);
      if (prev?.type === "text") prev.value = prev.value.replace(/[ \t]+$/, "");
      out.push({ type: "element", tagName: "br", properties: {}, children: [] });
    }
    out.push(...emitTextWithLinks(`\n${line}`, ctx, inLink));
  }
  return out;
}

function emitDirective(node: MdDirective, ctx: EmitContext, inLink: boolean): ElContent[] {
  const sourceSlice =
    node.position && ctx.opts.source !== undefined
      ? ctx.opts.source.slice(node.position.start.offset, node.position.end.offset)
      : "";

  const fallbackText = (): ElContent[] => {
    const t: ElContent = { type: "text", value: sourceSlice };
    return node.kind === "leaf"
      ? [{ type: "element", tagName: "p", properties: {}, children: [t] }]
      : [t];
  };

  if (node.name === "codex-file-citation") {
    const citation = resolveCodexFileCitationLink(node.attributes);
    if (!citation || inLink) return fallbackText();
    return [
      {
        type: "element",
        tagName: "a",
        properties: { href: citation.href },
        children: [{ type: "text", value: citation.label }],
        ...(node.position ? { position: node.position } : {}),
      },
    ];
  }

  if (node.name === "codex-followup") {
    if (!node.attributes.prompt?.trim() || !plainTextOf(node.children).trim()) {
      return fallbackText();
    }
    return [
      {
        type: "element",
        tagName: "span",
        properties: {},
        children: emitInlineNodes(node.children, ctx, inLink, false),
        ...(node.position ? { position: node.position } : {}),
      },
    ];
  }

  if (node.name === "artifact-template") {
    const template = node.template ?? resolveCodexArtifactTemplate(node.attributes);
    if (!template) return fallbackText();
    return [
      {
        type: "element",
        tagName: "div",
        properties: {
          dataCodexArtifactTemplate: "true",
          dataArtifactKind: template.artifactKind,
          dataDisplayName: template.displayName,
          ...(template.galleryKind !== undefined ? { dataGalleryKind: template.galleryKind } : {}),
          dataSkillDirectory: template.skillDirectory,
          dataSkillName: template.skillName,
        },
        children: [],
        ...(node.position ? { position: node.position } : {}),
      },
    ];
  }

  return fallbackText();
}

function emitMathPlaceholder(
  tex: string,
  display: boolean,
  ctx: EmitContext,
  node: MdNode,
): ElElement {
  const svg = renderMathSvg(tex, display);
  const wrapped = wrapMathSvg(svg, tex, display);
  if (node.position) wrapped.position = node.position;
  if (!ctx.opts.sanitize) return wrapped;
  const key = `${ctx.mathKey}-${ctx.mathPlaceholders.size}`;
  ctx.mathPlaceholders.set(key, wrapped);
  return {
    type: "element",
    tagName: "span",
    properties: { id: key },
    children: [],
    ...(node.position ? { position: node.position } : {}),
  };
}

function emitInlineNodes(
  nodes: readonly MdNode[],
  ctx: EmitContext,
  inLink: boolean,
  checkImageLines: boolean,
): ElContent[] {
  const hasImage = checkImageLines && ctx.opts.breakAroundImageLines && nodes.some(isImageMdNode);
  const ownsLine = (idx: number) =>
    hasImage &&
    isImageMdNode(nodes[idx]) &&
    endsWithLineBreak(nodes[idx - 1]) &&
    startsWithLineBreak(nodes[idx + 1]);

  const out: ElContent[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    switch (node.type) {
      case "text": {
        const afterImg = ownsLine(i - 1);
        const beforeImg = ownsLine(i + 1);
        out.push(...emitInlineTextWithBreaks(node.value, ctx, inLink, afterImg, beforeImg));
        break;
      }
      case "leadingWhitespace": {
        // Drop leading whitespace right before a line break or whitespace-starting sibling
        // (matching markdownLeadingWhitespace's settle rule).
        const next = nodes[i + 1];
        if (next && next.type !== "break" && !startsBlankMd(next)) {
          out.push({
            type: "element",
            tagName: "span",
            properties: { dataLeadingWhitespace: "" },
            children: [{ type: "text", value: node.value }],
          });
        }
        break;
      }
      case "break": {
        out.push({ type: "element", tagName: "br", properties: {}, children: [] });
        out.push({ type: "text", value: "\n" });
        break;
      }
      case "inlineCode": {
        const props: ElProperties = {};
        if (ctx.opts.tagInlineCode && !inLink) props.dataInlineCode = "";
        out.push({
          type: "element",
          tagName: "code",
          properties: props,
          children: [{ type: "text", value: node.value }],
          ...(node.position ? { position: node.position } : {}),
        });
        break;
      }
      case "inlineMath": {
        if (ctx.opts.math) {
          out.push(emitMathPlaceholder(node.value, node.display === true, ctx, node));
        } else {
          out.push({ type: "text", value: node.value });
        }
        break;
      }
      case "emphasis":
      case "strong":
      case "delete": {
        const tag = node.type === "emphasis" ? "em" : node.type === "strong" ? "strong" : "del";
        out.push({
          type: "element",
          tagName: tag,
          properties: {},
          children: emitInlineNodes(node.children, ctx, inLink, false),
          ...(node.position ? { position: node.position } : {}),
        });
        break;
      }
      case "link": {
        let href = node.url;
        if (ctx.opts.normalizeWindowsLinks) {
          const wp = windowsDrivePath(href);
          href = wp ? `file:///${wp.replaceAll("\\", "/")}` : normalizeUri(href);
        }
        const props: ElProperties = { href };
        if (node.title) props.title = node.title;
        out.push({
          type: "element",
          tagName: "a",
          properties: props,
          children: emitInlineNodes(node.children, ctx, true, false),
          ...(node.position ? { position: node.position } : {}),
        });
        break;
      }
      case "image":
      case "imageReference": {
        let src =
          node.type === "image"
            ? node.url
            : (ctx.root.definitions?.get(node.identifier)?.url ?? "");
        const title =
          node.type === "image"
            ? node.title
            : (ctx.root.definitions?.get(node.identifier)?.title ?? null);
        if (ctx.opts.resolveMediaUrl) src = ctx.opts.resolveMediaUrl(src);
        if (ctx.opts.normalizeWindowsLinks) {
          src = windowsDrivePath(src) ?? normalizeUri(src);
        }
        const props: ElProperties = { src, alt: node.alt };
        if (title) props.title = title;
        out.push({
          type: "element",
          tagName: "img",
          properties: props,
          children: [],
          ...(node.position ? { position: node.position } : {}),
        });
        break;
      }
      case "footnoteReference": {
        const id = node.identifier;
        if (!ctx.footnoteCounts.has(id)) {
          ctx.footnoteOrder.push(id);
        }
        const count = (ctx.footnoteCounts.get(id) ?? 0) + 1;
        ctx.footnoteCounts.set(id, count);
        const orderIndex = ctx.footnoteOrder.indexOf(id) + 1;
        const refId =
          count === 1 ? `user-content-fnref-${id}` : `user-content-fnref-${id}-${count}`;
        out.push({
          type: "element",
          tagName: "sup",
          properties: {},
          children: [
            {
              type: "element",
              tagName: "a",
              properties: {
                href: `#user-content-fn-${id}`,
                id: refId,
                dataFootnoteRef: "",
                ariaDescribedBy: ["footnote-label"],
              },
              children: [{ type: "text", value: String(orderIndex) }],
            },
          ],
        });
        break;
      }
      case "directive": {
        out.push(...emitDirective(node, ctx, inLink));
        break;
      }
      case "html": {
        if (ctx.opts.skipHtml) break;
        if (ctx.opts.escapeHtml || ctx.opts.rawHtmlAsText) {
          out.push({ type: "text", value: node.value });
        } else {
          ctx.hasRawHtml = true;
          out.push({
            type: "element",
            tagName: "__t3_raw_html__",
            properties: { value: node.value },
            children: [],
          });
        }
        break;
      }
      default:
        break;
    }
  }

  return mergeAdjacentText(out);
}

function mergeAdjacentText(nodes: ElContent[]): ElContent[] {
  const out: ElContent[] = [];
  for (const n of nodes) {
    const prev = out.at(-1);
    if (n.type === "text" && prev?.type === "text") {
      prev.value += n.value;
    } else {
      out.push(n);
    }
  }
  return out;
}

function emitListItem(item: MdListItem, list: MdList, ctx: EmitContext): ElElement {
  const props: ElProperties = {};
  const isTask = item.checked === true || item.checked === false;
  if (isTask) props.className = ["task-list-item"];
  if (item.value !== undefined) props.value = String(item.value);

  const checkbox: ElElement | null = isTask
    ? {
        type: "element",
        tagName: "input",
        properties: {
          type: "checkbox",
          ...(item.checked ? { checked: true } : {}),
          disabled: true,
        },
        children: [],
      }
    : null;

  const children: ElContent[] = [];
  const tight = !list.spread;

  for (let i = 0; i < item.children.length; i++) {
    const block = item.children[i]!;
    if (tight && block.type === "paragraph") {
      if (i > 0) children.push({ type: "text", value: "\n" });
      const inlines = emitInlineNodes(block.children, ctx, false, true);
      if (i === 0 && checkbox) {
        children.push(checkbox);
        if (inlines.length > 0) children.push({ type: "text", value: " " });
      }
      children.push(...inlines);
    } else {
      if (!tight || i > 0) children.push({ type: "text", value: "\n" });
      const emitted = emitBlock(block, ctx);
      if (i === 0 && checkbox && emitted[0]?.type === "element" && emitted[0].tagName === "p") {
        emitted[0].children.unshift(checkbox, { type: "text", value: " " });
      } else if (i === 0 && checkbox) {
        children.push(checkbox);
      }
      children.push(...emitted);
    }
  }
  if (!tight && children.length > 0) {
    children.push({ type: "text", value: "\n" });
  } else if (tight && item.children.length > 1) {
    children.push({ type: "text", value: "\n" });
  }

  return {
    type: "element",
    tagName: "li",
    properties: props,
    children: mergeAdjacentText(children),
    ...(item.position ? { position: item.position } : {}),
  };
}

function emitBlock(node: MdNode, ctx: EmitContext): ElContent[] {
  switch (node.type) {
    case "paragraph": {
      return [
        {
          type: "element",
          tagName: "p",
          properties: {},
          children: emitInlineNodes(node.children, ctx, false, true),
          ...(node.position ? { position: node.position } : {}),
        },
      ];
    }
    case "heading": {
      return [
        {
          type: "element",
          tagName: `h${node.depth}`,
          properties: {},
          children: emitInlineNodes(node.children, ctx, false, false),
          ...(node.position ? { position: node.position } : {}),
        },
      ];
    }
    case "blockquote": {
      const children: ElContent[] = [];
      for (const child of node.children) {
        const emitted = emitBlock(child, ctx);
        if (emitted.length > 0) {
          children.push({ type: "text", value: "\n" }, ...emitted);
        }
      }
      if (children.length > 0) children.push({ type: "text", value: "\n" });
      const props: ElProperties = {};
      if (node.alert) props.dataAlert = node.alert;
      return [
        {
          type: "element",
          tagName: "blockquote",
          properties: props,
          children,
          ...(node.position ? { position: node.position } : {}),
        },
      ];
    }
    case "list": {
      const props: ElProperties = {};
      if (node.ordered && node.start != null && node.start !== 1) {
        props.start = node.start;
      }
      const hasTasks = node.children.some((it) => it.checked === true || it.checked === false);
      if (hasTasks) props.className = ["contains-task-list"];
      const children: ElContent[] = [];
      for (const item of node.children) {
        children.push({ type: "text", value: "\n" }, emitListItem(item, node, ctx));
      }
      if (children.length > 0) children.push({ type: "text", value: "\n" });
      return [
        {
          type: "element",
          tagName: node.ordered ? "ol" : "ul",
          properties: props,
          children,
          ...(node.position ? { position: node.position } : {}),
        },
      ];
    }
    case "code": {
      if (ctx.opts.math && node.lang === "math" && node.closed === true) {
        return [emitMathPlaceholder(node.value, true, ctx, node)];
      }
      const codeProps: ElProperties = {};
      if (node.lang) codeProps.className = [`language-${node.lang}`];
      if (node.meta) codeProps.dataCodeMeta = node.meta;
      const value = node.value.length > 0 ? `${node.value}\n` : "";
      return [
        {
          type: "element",
          tagName: "pre",
          properties: {},
          children: [
            {
              type: "element",
              tagName: "code",
              properties: codeProps,
              children: value ? [{ type: "text", value }] : [],
            },
          ],
          ...(node.position ? { position: node.position } : {}),
        },
      ];
    }
    case "math": {
      if (ctx.opts.math) {
        return [emitMathPlaceholder(node.value, true, ctx, node)];
      }
      return [
        {
          type: "element",
          tagName: "pre",
          properties: {},
          children: [
            {
              type: "element",
              tagName: "code",
              properties: { className: ["language-math", "math-display"] },
              children: [{ type: "text", value: node.value }],
            },
          ],
          ...(node.position ? { position: node.position } : {}),
        },
      ];
    }
    case "thematicBreak": {
      return [
        {
          type: "element",
          tagName: "hr",
          properties: {},
          children: [],
          ...(node.position ? { position: node.position } : {}),
        },
      ];
    }
    case "table": {
      const [headerRow, ...bodyRows] = node.children;
      const buildRow = (row: (typeof node.children)[number], cellTag: "th" | "td"): ElElement => {
        const rowChildren: ElContent[] = [];
        for (let c = 0; c < node.align.length; c++) {
          const cell = row.children[c];
          const align = node.align[c];
          const props: ElProperties = align ? { align } : {};
          rowChildren.push(
            { type: "text", value: "\n" },
            {
              type: "element",
              tagName: cellTag,
              properties: props,
              children: cell ? emitInlineNodes(cell.children, ctx, false, false) : [],
            },
          );
        }
        rowChildren.push({ type: "text", value: "\n" });
        return { type: "element", tagName: "tr", properties: {}, children: rowChildren };
      };

      const tableChildren: ElContent[] = [];
      if (headerRow) {
        tableChildren.push(
          { type: "text", value: "\n" },
          {
            type: "element",
            tagName: "thead",
            properties: {},
            children: [
              { type: "text", value: "\n" },
              buildRow(headerRow, "th"),
              { type: "text", value: "\n" },
            ],
          },
        );
      }
      if (bodyRows.length > 0) {
        const tbodyChildren: ElContent[] = [];
        for (const r of bodyRows) {
          tbodyChildren.push({ type: "text", value: "\n" }, buildRow(r, "td"));
        }
        tbodyChildren.push({ type: "text", value: "\n" });
        tableChildren.push(
          { type: "text", value: "\n" },
          { type: "element", tagName: "tbody", properties: {}, children: tbodyChildren },
        );
      }
      tableChildren.push({ type: "text", value: "\n" });
      return [
        {
          type: "element",
          tagName: "table",
          properties: {},
          children: tableChildren,
          ...(node.position ? { position: node.position } : {}),
        },
      ];
    }
    case "directive": {
      return emitDirective(node, ctx, false);
    }
    case "html": {
      if (ctx.opts.skipHtml) return [];
      if (ctx.opts.escapeHtml || ctx.opts.rawHtmlAsText) {
        return [{ type: "text", value: node.value }];
      }
      ctx.hasRawHtml = true;
      return [
        {
          type: "element",
          tagName: "__t3_raw_html__",
          properties: { value: node.value },
          children: [],
        },
      ];
    }
    case "definition":
    case "footnoteDefinition":
      return [];
    default:
      return [];
  }
}

function buildFootnotesSection(ctx: EmitContext): ElElement | null {
  if (ctx.footnoteOrder.length === 0) return null;
  const items: ElContent[] = [];
  for (let i = 0; i < ctx.footnoteOrder.length; i++) {
    const id = ctx.footnoteOrder[i]!;
    const def = ctx.root.footnotes?.get(id);
    if (!def) continue;
    const refCount = ctx.footnoteCounts.get(id) ?? 1;
    const backrefs: ElContent[] = [];
    for (let r = 1; r <= refCount; r++) {
      const refHref = r === 1 ? `#user-content-fnref-${id}` : `#user-content-fnref-${id}-${r}`;
      const labelNum = r === 1 ? String(i + 1) : `${i + 1}-${r}`;
      const linkChildren: ElContent[] =
        r === 1
          ? [{ type: "text", value: "\u21a9" }]
          : [
              { type: "text", value: "\u21a9" },
              {
                type: "element",
                tagName: "sup",
                properties: {},
                children: [{ type: "text", value: String(r) }],
              },
            ];
      backrefs.push(
        { type: "text", value: " " },
        {
          type: "element",
          tagName: "a",
          properties: {
            href: refHref,
            dataFootnoteBackref: "",
            ariaLabel: `Back to reference ${labelNum}`,
            className: ["data-footnote-backref"],
          },
          children: linkChildren,
        },
      );
    }

    const liChildren: ElContent[] = [];
    for (const block of def.children) {
      const emitted = emitBlock(block, ctx);
      if (emitted.length > 0) liChildren.push({ type: "text", value: "\n" }, ...emitted);
    }
    const lastEl = [...liChildren].reverse().find((c): c is ElElement => c.type === "element");
    if (lastEl?.tagName === "p") {
      lastEl.children.push(...backrefs);
    } else {
      liChildren.push({ type: "text", value: "\n" }, ...backrefs);
    }
    liChildren.push({ type: "text", value: "\n" });

    items.push(
      { type: "text", value: "\n" },
      {
        type: "element",
        tagName: "li",
        properties: { id: `user-content-fn-${id}` },
        children: liChildren,
      },
    );
  }
  if (items.length === 0) return null;
  items.push({ type: "text", value: "\n" });

  return {
    type: "element",
    tagName: "section",
    properties: { dataFootnotes: "", className: ["footnotes"] },
    children: [
      {
        type: "element",
        tagName: "h2",
        properties: { className: ["sr-only"], id: "footnote-label" },
        children: [{ type: "text", value: "Footnotes" }],
      },
      { type: "text", value: "\n" },
      { type: "element", tagName: "ol", properties: {}, children: items },
      { type: "text", value: "\n" },
    ],
  };
}

function expandRawHtmlMarkers(root: ElRoot): ElRoot {
  const builder = createRawHtmlBuilder({ type: "root", children: [] });

  const walk = (
    node: ElRoot | ElElement,
    targetBuilder: ReturnType<typeof createRawHtmlBuilder>,
  ) => {
    for (const child of node.children) {
      if (child.type === "element" && child.tagName === "__t3_raw_html__") {
        targetBuilder.pushRawHtml(String(child.properties.value ?? ""));
        continue;
      }
      if (child.type === "text") {
        targetBuilder.pushNode(child);
        continue;
      }
      // If a child element contains raw HTML markers inside it, expand inside a local builder
      if (containsRawHtmlMarker(child)) {
        const innerRoot: ElRoot = { type: "root", children: [] };
        const innerBuilder = createRawHtmlBuilder(innerRoot);
        walk(child, innerBuilder);
        innerBuilder.finish();
        // If raw HTML inside `<p>` produced block elements that close `<p>`, lift them to parent
        if (child.tagName === "p" && hasBlockChild(innerRoot)) {
          const pBuilder = createRawHtmlBuilder({ type: "root", children: [] });
          pBuilder.pushRawHtml("<p>");
          for (const c of child.children) {
            if (c.type === "element" && c.tagName === "__t3_raw_html__") {
              pBuilder.pushRawHtml(String(c.properties.value ?? ""));
            } else {
              pBuilder.pushNode(c);
            }
          }
          pBuilder.pushRawHtml("</p>");
          for (const lifted of pBuilder.finish().children) {
            targetBuilder.pushNode(lifted);
          }
        } else {
          targetBuilder.pushNode({ ...child, children: innerRoot.children });
        }
      } else {
        targetBuilder.pushNode(child);
      }
    }
  };

  walk(root, builder);
  return builder.finish();
}

function containsRawHtmlMarker(node: ElElement): boolean {
  if (node.tagName === "__t3_raw_html__") return true;
  for (const c of node.children) {
    if (c.type === "element" && containsRawHtmlMarker(c)) return true;
  }
  return false;
}

const BLOCK_LIFT_TAGS = new Set([
  "div",
  "details",
  "summary",
  "blockquote",
  "table",
  "ul",
  "ol",
  "pre",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "section",
  "article",
  "aside",
  "header",
  "footer",
  "figure",
  "center",
]);

function hasBlockChild(root: ElRoot): boolean {
  return root.children.some((c) => c.type === "element" && BLOCK_LIFT_TAGS.has(c.tagName));
}

function restoreMathPlaceholders(node: ElRoot | ElElement, map: Map<string, ElElement>): void {
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]!;
    if (child.type !== "element") continue;
    const id = child.properties.id;
    if (typeof id === "string") {
      const stripped = id.startsWith("user-content-") ? id.slice(13) : id;
      const replacement = map.get(stripped);
      if (replacement) {
        node.children[i] = replacement;
        continue;
      }
    }
    restoreMathPlaceholders(child, map);
  }
}

/** Compiles a parsed Markdown IR directly into an Element Tree (HAST-compatible). */
export function mdToElements(root: MdRoot, options: EmitOptions = {}): ElRoot {
  const ctx: EmitContext = {
    root,
    opts: options,
    footnoteOrder: [],
    footnoteCounts: new Map(),
    mathPlaceholders: new Map(),
    mathKey: `t3-math-${Math.random().toString(36).slice(2)}`,
    hasRawHtml: false,
  };

  const children: ElContent[] = [];
  for (const block of root.children) {
    const emitted = emitBlock(block, ctx);
    if (emitted.length === 0) continue;
    if (children.length > 0) children.push({ type: "text", value: "\n" });
    children.push(...emitted);
  }

  const footnotes = buildFootnotesSection(ctx);
  if (footnotes) {
    if (children.length > 0) children.push({ type: "text", value: "\n" });
    children.push(footnotes);
  }

  let elRoot: ElRoot = { type: "root", children };

  if (ctx.hasRawHtml) {
    elRoot = expandRawHtmlMarkers(elRoot);
  }
  if (options.preserveImageMeta) {
    preserveImageSourceMetaOnTree(elRoot);
  }
  if (options.normalizeLocalEditorLinks) {
    normalizeLocalEditorLinksOnTree(elRoot);
  }
  if (options.sanitize) {
    elRoot = sanitizeElTree(elRoot);
  }
  if (ctx.mathPlaceholders.size > 0) {
    restoreMathPlaceholders(elRoot, ctx.mathPlaceholders);
  }

  return elRoot;
}

/** One-shot Markdown -> Element Tree helper. */
export function renderMarkdownToElements(
  markdown: string,
  parseOptions?: ParseOptions,
  emitOptions?: EmitOptions,
): ElRoot {
  const md = parseMarkdown(markdown, parseOptions);
  return mdToElements(md, { ...emitOptions, source: markdown });
}

// --- Direct Element Tree -> HTML string serializer (replaces hast-util-to-html & property-information) ---

const PROP_TO_HTML_ATTR: Readonly<Record<string, string>> = {
  className: "class",
  class: "class",
  htmlFor: "for",
  colSpan: "colspan",
  rowSpan: "rowspan",
  tabIndex: "tabindex",
  readOnly: "readonly",
  maxLength: "maxlength",
  cellPadding: "cellpadding",
  cellSpacing: "cellspacing",
  hrefLang: "hreflang",
  dateTime: "datetime",
  useMap: "usemap",
  isMap: "ismap",
  longDesc: "longdesc",
  srcSet: "srcset",
  itemProp: "itemprop",
  itemScope: "itemscope",
  itemType: "itemtype",
  vAlign: "valign",
  hSpace: "hspace",
  vSpace: "vspace",
  encType: "enctype",
  charSet: "charset",
  acceptCharset: "accept-charset",
  accessKey: "accesskey",
  charOff: "charoff",
  noHref: "nohref",
  noShade: "noshade",
  noWrap: "nowrap",
  ariaLabel: "aria-label",
  ariaDescribedBy: "aria-describedby",
  ariaLabelledBy: "aria-labelledby",
  ariaHidden: "aria-hidden",
  ariaLevel: "aria-level",
};

const SVG_PRESERVE_CASE_ATTRS = new Set([
  "viewBox",
  "preserveAspectRatio",
  "gradientUnits",
  "gradientTransform",
  "patternUnits",
  "clipPathUnits",
  "spreadMethod",
  "stdDeviation",
  "baseFrequency",
  "numOctaves",
  "markerWidth",
  "markerHeight",
  "refX",
  "refY",
]);

export function htmlAttributeName(prop: string, inSvg: boolean): string {
  if (inSvg) {
    if (SVG_PRESERVE_CASE_ATTRS.has(prop)) return prop;
    if (prop === "className") return "class";
    return prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
  }
  const mapped = PROP_TO_HTML_ATTR[prop];
  if (mapped) return mapped;
  if (
    prop.startsWith("data") &&
    prop.length > 4 &&
    prop.charCodeAt(4) >= 65 &&
    prop.charCodeAt(4) <= 90
  ) {
    return prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
  }
  if (
    prop.startsWith("aria") &&
    prop.length > 4 &&
    prop.charCodeAt(4) >= 65 &&
    prop.charCodeAt(4) <= 90
  ) {
    return prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
  }
  return prop.toLowerCase();
}

export function elToHtml(node: ElNode, inSvg = false): string {
  if (node.type === "text") return escapeHtmlText(node.value);
  if (node.type === "root") {
    let out = "";
    for (const child of node.children) out += elToHtml(child, inSvg);
    return out;
  }
  const svg = inSvg || node.tagName === "svg";
  let html = `<${node.tagName}`;
  const props = node.properties;
  for (const key in props) {
    const value = props[key];
    if (value === null || value === undefined || value === false || Number.isNaN(value)) continue;
    const attrName = htmlAttributeName(key, svg);
    if (BOOLEAN_PROPS.has(key) && value === true) {
      html += ` ${attrName}`;
      continue;
    }
    const text = Array.isArray(value)
      ? value.join(key === "accept" || key === "srcSet" ? ", " : " ")
      : value === true
        ? ""
        : String(value);
    html += ` ${attrName}="${escapeHtmlAttr(text)}"`;
  }
  html += ">";
  if (!svg && VOID_HTML_TAGS.has(node.tagName)) return html;
  for (const child of node.children) html += elToHtml(child, svg);
  return `${html}</${node.tagName}>`;
}

/** One-shot Markdown -> sanitized HTML string helper. */
export function renderMarkdownToHtml(
  markdown: string,
  parseOptions?: ParseOptions,
  emitOptions?: EmitOptions,
): string {
  return elToHtml(
    renderMarkdownToElements(markdown, parseOptions, { sanitize: true, ...emitOptions }),
  );
}

// --- Direct Element Tree -> React element renderer (replaces hast-util-to-jsx-runtime & html-url-attributes) ---

export const URL_ATTRIBUTES: Readonly<Record<string, ReadonlyArray<string> | null>> = {
  action: ["form"],
  cite: ["blockquote", "del", "ins", "q"],
  data: ["object"],
  formAction: ["button", "input"],
  href: ["a", "area", "base", "link"],
  icon: ["menuitem"],
  itemId: null,
  longDesc: ["frame", "iframe", "img"],
  manifest: ["html"],
  ping: ["a", "area"],
  poster: ["video"],
  src: ["audio", "embed", "frame", "iframe", "img", "input", "script", "source", "track", "video"],
  srcSet: ["img", "source"],
};

function parseCssStyleString(css: string): Record<string, string> {
  const style: Record<string, string> = {};
  for (const decl of css.split(";")) {
    const colon = decl.indexOf(":");
    if (colon <= 0) continue;
    const rawProp = decl.slice(0, colon).trim();
    const rawVal = decl.slice(colon + 1).trim();
    if (!rawProp || !rawVal) continue;
    const prop = rawProp.startsWith("--")
      ? rawProp
      : rawProp.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
    style[prop] = rawVal;
  }
  return style;
}

const REACT_PROP_MAP: Readonly<Record<string, string>> = {
  class: "className",
  for: "htmlFor",
  tabindex: "tabIndex",
  readonly: "readOnly",
  colspan: "colSpan",
  rowspan: "rowSpan",
  maxlength: "maxLength",
  cellpadding: "cellPadding",
  cellspacing: "cellSpacing",
  hreflang: "hrefLang",
  datetime: "dateTime",
  srcset: "srcSet",
  usemap: "useMap",
  ismap: "isMap",
  longdesc: "longDesc",
  enctype: "encType",
  charset: "charSet",
  accesskey: "accessKey",
  itemprop: "itemProp",
  itemscope: "itemScope",
  itemtype: "itemType",
};

export function elToReactProps(node: ElElement, inSvg = false): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const raw = node.properties;
  for (const key in raw) {
    const value = raw[key];
    if (value === null || value === undefined || value === false || Number.isNaN(value)) continue;
    if (key === "style") {
      if (typeof value === "string") {
        const parsed = parseCssStyleString(value);
        if (Object.keys(parsed).length > 0) props.style = parsed;
      } else if (typeof value === "object") {
        props.style = value;
      }
      continue;
    }
    if (key === "className" || key === "class") {
      props.className = Array.isArray(value) ? value.join(" ") : String(value);
      continue;
    }
    if (
      key.startsWith("data") &&
      key.length > 4 &&
      key.charCodeAt(4) >= 65 &&
      key.charCodeAt(4) <= 90
    ) {
      const attr = key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
      props[attr] = value === true ? "" : Array.isArray(value) ? value.join(" ") : value;
      continue;
    }
    if (
      key.startsWith("aria") &&
      key.length > 4 &&
      key.charCodeAt(4) >= 65 &&
      key.charCodeAt(4) <= 90
    ) {
      const attr = key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
      props[attr] = Array.isArray(value) ? value.join(" ") : value;
      continue;
    }
    const reactKey = inSvg
      ? key.includes("-")
        ? key.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase())
        : key
      : (REACT_PROP_MAP[key] ?? key);
    if (BOOLEAN_PROPS.has(key)) {
      props[reactKey] = Boolean(value);
    } else {
      props[reactKey] = Array.isArray(value) ? value.join(" ") : value;
    }
  }
  return props;
}

export interface ReactRuntimeLike {
  readonly Fragment: unknown;
  readonly jsx: (type: unknown, props: Record<string, unknown>, key?: string | number) => unknown;
  readonly jsxs: (type: unknown, props: Record<string, unknown>, key?: string | number) => unknown;
}

export function elToReact<T = unknown>(
  node: ElNode,
  runtime: ReactRuntimeLike,
  options?: {
    readonly components?: Readonly<Record<string, unknown>>;
    readonly passNode?: boolean;
  },
): T {
  const components = options?.components;
  const passNode = options?.passNode ?? false;

  const render = (n: ElNode, key: number | undefined, inSvg: boolean): unknown => {
    if (n.type === "text") return n.value;
    if (n.type === "root") {
      const kids = n.children.map((c, idx) => render(c, idx, inSvg));
      const children = kids.length === 0 ? undefined : kids.length === 1 ? kids[0] : kids;
      return kids.length > 1
        ? runtime.jsxs(runtime.Fragment, { children }, key)
        : runtime.jsx(runtime.Fragment, children !== undefined ? { children } : {}, key);
    }
    const svg = inSvg || n.tagName === "svg";
    const props = elToReactProps(n, svg);
    const custom =
      components && Object.hasOwn(components, n.tagName) ? components[n.tagName] : undefined;
    const type = custom ?? n.tagName;
    if (passNode && custom !== undefined) {
      props.node = n;
    }
    if (!VOID_HTML_TAGS.has(n.tagName) && n.children.length > 0) {
      const kids = n.children.map((c, idx) => render(c, idx, svg));
      if (kids.length === 1) {
        props.children = kids[0];
        return runtime.jsx(type, props, key);
      }
      props.children = kids;
      return runtime.jsxs(type, props, key);
    }
    return runtime.jsx(type, props, key);
  };

  return render(node, undefined, false) as T;
}

// --- Extractors (zero-dependency replacements for unified/words helpers) ---

export function decodeMarkdownLinkEscapes(href: string): string {
  const decoded = href.includes("&") ? decodeHtmlEntities(href, { strict: true }) : href;
  return isWindowsAbsolutePath(decoded) ? decoded : decoded.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

/** Extracts real HTML comment ranges (outside code blocks/spans) directly from the Markdown IR. */
export function extractHtmlComments(markdown: string): Array<{ start: number; end: number }> {
  if (!markdown.includes("<!--")) return [];
  const root = parseMarkdown(markdown, { gfm: true, windowsPaths: true });
  const comments: Array<{ start: number; end: number }> = [];
  const commentRe = /<!--(?!-?>)[\s\S]*?(?:-->|$)/g;

  const visit = (node: MdNode) => {
    if (node.type === "html" && node.position) {
      const base = node.position.start.offset;
      const raw = markdown.slice(base, node.position.end.offset);
      commentRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = commentRe.exec(raw)) !== null) {
        comments.push({ start: base + m.index, end: base + m.index + m[0].length });
      }
      return;
    }
    if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children) visit(child);
    }
  };
  visit(root);
  return comments;
}

/** Extracts the first reference definition for each label as a single normalized Markdown line. */
export function extractReferenceDefinitions(markdown: string): string[] {
  if (!markdown.includes("]:")) return [];
  const root = parseMarkdown(markdown, { gfm: true, windowsPaths: true });
  const defs: string[] = [];
  if (!root.definitions) return defs;
  for (const def of root.definitions.values()) {
    const href = def.url.replace(/[<>\\\n]/g, encodeURIComponent);
    const titlePart =
      typeof def.title === "string"
        ? ` "${def.title.replace(/\s+/g, " ").replace(/["\\]/g, "\\$&")}"`
        : "";
    defs.push(`[${def.label}]: <${href}>${titlePart}`);
  }
  return defs;
}

export interface ExtractedCodexDirective {
  readonly name: string;
  readonly attributes: Record<string, string>;
  readonly start: number;
  readonly end: number;
  readonly label: string;
  readonly inLink: boolean;
}

/** Extracts all Codex directives with exact source offsets directly from the Markdown IR. */
export function extractCodexDirectives(markdown: string): ExtractedCodexDirective[] {
  if (
    !markdown.includes(":codex-file-citation") &&
    !markdown.includes(":codex-followup") &&
    !markdown.includes("::artifact-template")
  ) {
    return [];
  }
  const root = parseMarkdown(markdown, { gfm: true, directives: true, windowsPaths: true });
  const found: ExtractedCodexDirective[] = [];

  const visit = (node: MdNode, inLink: boolean) => {
    if (node.type === "directive" && node.position) {
      found.push({
        name: node.name,
        attributes: { ...node.attributes },
        start: node.position.start.offset,
        end: node.position.end.offset,
        label: node.label,
        inLink,
      });
      return;
    }
    if ("children" in node && Array.isArray(node.children)) {
      const nextInLink = inLink || node.type === "link" || node.type === "linkReference";
      for (const child of node.children) visit(child, nextInLink);
    }
  };
  visit(root, false);
  return found;
}
