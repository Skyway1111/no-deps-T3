import {
  absoluteFilePathMatches,
  inlineCodeFilePathCandidate,
  parseMarkdownFileLink,
} from "@t3tools/shared/markdownLinks";
import {
  decodeHtmlEntities as sharedDecodeHtmlEntities,
  parseMarkdown,
  type MdNode,
  type MdRoot,
} from "@t3tools/shared/markdownPipeline";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import { hasRightToLeftLetter, textDirection } from "@t3tools/shared/textDirection";

export type MarkdownNode = MdNode;

const parseGfmProse = (markdown: string): MdRoot =>
  parseMarkdown(markdown, {
    gfm: true,
    windowsPaths: true,
    windowsProsePathsOnly: true,
    autolinkBoundaries: false,
  });

interface MarkdownEdit {
  readonly start: number;
  readonly end: number;
  readonly content: string;
}

function applyMarkdownEdits(markdown: string, edits: MarkdownEdit[]): string {
  if (edits.length === 0) return markdown;
  const parts: string[] = [];
  let offset = 0;
  // AST traversal emits disjoint edits in source order.
  for (const edit of edits) {
    parts.push(markdown.slice(offset, edit.start), edit.content);
    offset = edit.end;
  }
  parts.push(markdown.slice(offset));
  return parts.join("");
}

export function decodeHtmlEntities(value: string): string {
  return sharedDecodeHtmlEntities(value, { strict: true });
}

const HTML_TAG = /<!--[\s\S]*?-->|<\/?[a-z](?:[^>"']|"[^"]*"|'[^']*')*>/gi;

function attribute(tag: string, name: string): string | null {
  const attributes = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of tag.matchAll(attributes)) {
    if (match[1]?.toLowerCase() === name) {
      return decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "");
    }
  }
  return null;
}

function markdownDestination(url: string): string {
  return `<${url.replace(/&/g, "\\&").replace(/</g, "%3C").replace(/>/g, "%3E").replace(/\|/g, "%7C").replace(/\n/g, "")}>`;
}

const ANCHOR_TAG = /^<\/?a[\s/>]/i;

/** Replacements for the anchor tags still ahead, and how many emitted links are open. */
type AnchorState = { readonly pending: string[]; open: number };

// Code spans keep their text; an odd trailing backslash would escape the closing "]".
function escapeLinkLabel(text: string): string {
  return text
    .replace(/(`+)[\s\S]*?\1|\\*[[\]]/g, (match) =>
      match.startsWith("`") || match.length % 2 === 0
        ? match
        : `${match.slice(0, -1)}\\${match.slice(-1)}`,
    )
    .replace(/\\+$/, (slashes) => (slashes.length % 2 ? `${slashes}\\` : slashes));
}

// An unescaped "!" before the inserted "[" would turn the link into an image.
function bangBefore(text: string, index: number): boolean {
  if (text[index - 1] !== "!") return false;
  let backslashes = 0;
  while (text[index - 2 - backslashes] === "\\") backslashes += 1;
  return backslashes % 2 === 0;
}

/**
 * Pairs `<a>` tags in order. Only a closed anchor with an http(s) or mailto href becomes a
 * Markdown link; any other anchor keeps its text unlinked.
 */
function anchorMarkdown(tags: readonly string[]): AnchorState {
  const replacements = tags.map(() => "");
  const open: Array<{ index: number; href: string | undefined }> = [];
  tags.forEach((tag, index) => {
    if (tag[1] !== "/") {
      const href = attribute(tag, "href")?.trim();
      open.push({ index, href: href && /^(?:https?|mailto):/i.test(href) ? href : undefined });
      return;
    }
    const opening = open.pop();
    if (!opening?.href) return;
    replacements[opening.index] = "[";
    replacements[index] = `](${markdownDestination(opening.href)})`;
  });
  return { pending: replacements, open: 0 };
}

export function markdownHtmlTags(content: string): RegExpExecArray[] {
  // An HTML block such as <details> can also contain Markdown fences and code spans.
  const codeRanges: Array<{ start: number; end: number }> = [];
  const tags = [...content.matchAll(HTML_TAG)];
  let tagIndex = 0;
  const delimiters = [...content.matchAll(/`+|~{3,}/g)].filter((delimiter) => {
    while (tags[tagIndex] && tags[tagIndex]!.index + tags[tagIndex]![0].length <= delimiter.index)
      tagIndex += 1;
    const tag = tags[tagIndex];
    return !tag || delimiter.index < tag.index;
  });
  for (let index = 0; index < delimiters.length; index += 1) {
    const opening = delimiters[index]!;
    const lineStart = content.lastIndexOf("\n", opening.index - 1) + 1;
    const fenced =
      opening[0].length >= 3 && /^ {0,3}$/.test(content.slice(lineStart, opening.index));
    if (opening[0][0] === "~" && !fenced) continue;
    let closingIndex = -1;
    for (let candidate = index + 1; candidate < delimiters.length; candidate += 1) {
      const closing = delimiters[candidate]!;
      if (!fenced && closing[0] === opening[0]) {
        closingIndex = candidate;
        break;
      }
      if (!fenced || closing[0][0] !== opening[0][0] || closing[0].length < opening[0].length)
        continue;
      const start = content.lastIndexOf("\n", closing.index - 1) + 1;
      const nextLine = content.indexOf("\n", closing.index);
      const end = nextLine === -1 ? content.length : nextLine;
      if (
        /^ {0,3}$/.test(content.slice(start, closing.index)) &&
        /^\s*$/.test(content.slice(closing.index + closing[0].length, end))
      ) {
        closingIndex = candidate;
        break;
      }
    }
    if (closingIndex === -1) {
      if (!fenced) continue;
      // An unclosed fence runs to the end of the content, so no later opener matters.
      codeRanges.push({ start: opening.index, end: content.length });
      break;
    }
    const closing = delimiters[closingIndex]!;
    codeRanges.push({ start: opening.index, end: closing.index + closing[0].length });
    index = closingIndex;
  }
  return tags.filter(
    (tag) => !codeRanges.some((range) => tag.index >= range.start && tag.index < range.end),
  );
}

/**
 * Called only for parsed HTML nodes, so Markdown code examples keep their literal tags.
 * `anchors` is shared across sibling inline HTML nodes because each of those carries a single tag.
 */
export function markdownHtmlContent(
  content: string,
  options: { readonly anchors?: AnchorState; readonly inTableCell?: boolean } = {},
): string {
  const tags = markdownHtmlTags(content);
  const anchors =
    options.anchors ??
    anchorMarkdown(tags.map((tag) => tag[0]).filter((tag) => ANCHOR_TAG.test(tag)));
  let result = "";
  let end = 0;
  for (const match of tags) {
    const text = content.slice(end, match.index);
    result += anchors.open > 0 ? escapeLinkLabel(text) : text;
    const replacement = htmlTagMarkdown(match[0], anchors, options);
    if (replacement === "[" && bangBefore(result, result.length))
      result = `${result.slice(0, -1)}\\!`;
    result +=
      anchors.open > 0 && /[\s[]/.test(result.at(-1) ?? "")
        ? replacement.replace(/^ /, "")
        : replacement;
    end = match.index + match[0].length;
  }
  const text = content.slice(end);
  return result + (anchors.open > 0 ? escapeLinkLabel(text) : text);
}

function htmlTagMarkdown(
  tag: string,
  anchors: AnchorState,
  options: { readonly inTableCell?: boolean },
): string {
  if (tag.startsWith("<!--")) return "";
  if (ANCHOR_TAG.test(tag)) {
    const replacement = anchors.pending.shift() ?? "";
    if (replacement === "[") anchors.open += 1;
    else if (replacement) anchors.open -= 1;
    return replacement;
  }
  if (/^<img\b/i.test(tag)) {
    const src = attribute(tag, "src");
    if (!src) return "";
    const alt = (attribute(tag, "alt") ?? "").replace(/[\\[\]&]/g, "\\$&");
    return `![${alt}](${markdownDestination(src)})`;
  }
  const cellBreak = "&#10;";
  const blockBreak = anchors.open > 0 ? " " : options.inTableCell ? cellBreak : "\n\n";
  if (/^<summary\b/i.test(tag)) return `${blockBreak}**`;
  if (/^<\/summary\s*>/i.test(tag)) return `**${blockBreak}`;
  if (/^<br\b/i.test(tag)) return options.inTableCell ? cellBreak : "  \n";
  if (/^<\/?(?:p|div|details)\b/i.test(tag)) return blockBreak;
  return "";
}

export function markdownWithHtml(markdown: string): string {
  if (!/<(?:!--|\/?[a-z])/i.test(markdown)) return markdown;
  const edits: Array<{ start: number; end: number; content: string }> = [];
  const visit = (node: MarkdownNode, inTableCell: boolean, inLink: boolean) => {
    if (!("children" in node)) return;
    inTableCell ||= node.type === "tableCell";
    const children: readonly MarkdownNode[] = node.children;
    const anchors =
      node.type === "root" || node.type === "blockquote" || node.type === "listItem"
        ? undefined
        : anchorMarkdown(
            children.flatMap((child) =>
              child.type === "html"
                ? markdownHtmlTags(child.value)
                    .map((tag) => tag[0])
                    .filter((tag) => ANCHOR_TAG.test(tag))
                : [],
            ),
          );
    for (const child of children) {
      const start = child.position?.start.offset;
      const end = child.position?.end.offset;
      const linkLabel = inLink || (anchors?.open ?? 0) > 0;
      if (child.type === "text") {
        if (linkLabel && start !== undefined && end !== undefined) {
          const content = escapeLinkLabel(markdown.slice(start, end));
          if (content !== markdown.slice(start, end)) edits.push({ start, end, content });
        }
        continue;
      }
      if (child.type !== "html") {
        visit(child, inTableCell, linkLabel);
        continue;
      }
      const content = markdownHtmlContent(child.value, { anchors, inTableCell });
      if (start === undefined || end === undefined) continue;
      if (content.startsWith("[") && !linkLabel && bangBefore(markdown, start))
        edits.push({ start: start - 1, end: start, content: "\\!" });
      edits.push({ start, end, content });
    }
  };
  visit(parseGfmProse(markdown), false, false);
  return applyMarkdownEdits(markdown, edits);
}

/** Reference definitions as authored, one line each, so a Windows destination keeps its backslashes. */
export function markdownReferenceDefinitions(markdown: string): string[] {
  if (!markdown.includes("]:")) return [];
  const flattened = markdownWithHtml(markdown);
  const definitions: string[] = [];
  const visit = (node: MarkdownNode, quotes: number) => {
    if (node.type === "definition" && node.position) {
      const wrap = new RegExp(`(?:\\r\\n|\\r|\\n)(?:[ \\t]*>){0,${quotes}}[ \\t]*`, "g");
      definitions.push(
        flattened.slice(node.position.start.offset, node.position.end.offset).replace(wrap, " "),
      );
    }
    if (!("children" in node)) return;
    for (const child of node.children) visit(child, quotes + (node.type === "blockquote" ? 1 : 0));
  };
  visit(parseGfmProse(flattened), 0);
  return definitions;
}

export function withReferenceDefinitions(
  fragment: string,
  replyDefinitions: ReadonlyArray<string>,
): string {
  if (replyDefinitions.length === 0 || !fragment.includes("[")) return fragment;
  const definitions = new Set([...markdownReferenceDefinitions(fragment), ...replyDefinitions]);
  return `${[...definitions].join("\n")}\n\n${fragment}`;
}

const INLINE_CODE_SPAN = /(?<!`)`+([^`\r\n]+)`+/g;

function isInlineCodeFileLink(code: string, fileLink: RegExp): boolean {
  return fileLink.test(code) || (/\s/.test(code) && inlineCodeFilePathCandidate(code) !== null);
}

export function markdownWithInlineFileLinks(markdown: string, fileLink: RegExp): string {
  return transformNativeMarkdown(markdown, fileLink, false);
}

function transformNativeMarkdown(
  markdown: string,
  fileLink: RegExp | undefined,
  tableBreaks: boolean,
): string {
  const breakTables = tableBreaks && mayHaveTableUnderText(markdown);
  let linkFiles = false;
  if (fileLink) {
    for (const [, code] of markdown.matchAll(INLINE_CODE_SPAN)) {
      if (isInlineCodeFileLink(code!.trim(), fileLink)) {
        linkFiles = true;
        break;
      }
    }
  }
  const linkProseFiles = fileLink !== undefined && absoluteFilePathMatches(markdown).length > 0;
  if (!linkFiles && !linkProseFiles && !breakTables) return markdown;
  const edits: MarkdownEdit[] = [];
  const fileEdits: MarkdownEdit[] = [];
  let rewritesPipe = false;
  const visit = (node: MarkdownNode) => {
    if (linkFiles && node.type === "inlineCode") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const escaped = node.value.replace(/[\\[\]&]/g, "\\$&");
      if (
        start !== undefined &&
        end !== undefined &&
        fileLink !== undefined &&
        isInlineCodeFileLink(node.value, fileLink) &&
        parseMarkdownFileLink(node.value) !== null &&
        !/[<>]/.test(node.value)
      ) {
        const edit = {
          start,
          end,
          content: `[${escaped}](<${escaped}>)`,
        };
        edits.push(edit);
        fileEdits.push(edit);
        if (node.value.includes("|")) rewritesPipe = true;
      }
    } else if (
      linkProseFiles &&
      node.type === "text" &&
      node.position?.start.offset !== undefined
    ) {
      const start = node.position.start.offset;
      const raw = markdown.slice(start, node.position.end.offset);
      for (const { index, path } of absoluteFilePathMatches(raw)) {
        if (raw !== node.value && /[\\&]/.test(path)) continue;
        const escaped = path.replace(/[\\[\]&]/g, "\\$&");
        const edit = {
          start: start + index,
          end: start + index + path.length,
          content: `[${escaped}](<${escaped}>)`,
        };
        edits.push(edit);
        fileEdits.push(edit);
      }
    } else if (node.type !== "link" && node.type !== "linkReference" && "children" in node)
      node.children.forEach((child, index) => {
        const previous = node.children[index - 1];
        const start = child.position?.start;
        if (
          breakTables &&
          child.type === "table" &&
          previous?.type === "paragraph" &&
          start?.offset !== undefined &&
          previous.position?.end.line === start.line - 1
        ) {
          let lineStart = start.offset;
          while (lineStart > 0 && !/[\r\n]/.test(markdown[lineStart - 1]!)) lineStart -= 1;
          const [, header = "", , ending = "\n", markers = ""] =
            /^([ \t>]*)([^\r\n]*)(\r\n|\r|\n)([ \t>]*)/.exec(markdown.slice(lineStart)) ?? [];
          edits.push({
            start: lineStart,
            end: lineStart + header.length,
            content: `${markers.trimEnd()}${ending}${markers}`,
          });
        }
        visit(child);
      });
  };
  visit(parseGfmProse(markdown));
  if (breakTables && rewritesPipe)
    return markdownWithTableBreaks(applyMarkdownEdits(markdown, fileEdits));
  return applyMarkdownEdits(markdown, edits);
}

function isTableDelimiterRow(line: string): boolean {
  if (!line.includes("-")) return false;
  const row = line.replace(/^[ \t>]+/, "").trim();
  return row
    .replace(/^\||\|$/g, "")
    .split("|")
    .every((cell) => /^:?-+:?$/.test(cell.trim()));
}

function mayHaveTableUnderText(markdown: string): boolean {
  if (!markdown.includes("|")) return false;
  const lines = markdown.split(/\r\n|\r|\n/);
  for (let index = 2; index < lines.length; index += 1) {
    if (isTableDelimiterRow(lines[index]!) && /[^\s>]/.test(lines[index - 2]!)) return true;
  }
  return false;
}

/** md4c starts tables only at paragraph starts; insert breaks to match GFM. */
export function markdownWithTableBreaks(markdown: string): string {
  return transformNativeMarkdown(markdown, undefined, true);
}

const WINDOWS_DESTINATION = /\](?:\(|:)[\s>]*<?(?:[A-Za-z]:[\\/]|\\\\)/;

function findDestinationSpanInNode(
  markdown: string,
  nodeStart: number,
  nodeEnd: number,
  isDefinition: boolean,
): { start: number; end: number; angled: boolean } | null {
  const slice = markdown.slice(nodeStart, nodeEnd);
  const sep = isDefinition ? "]:" : "](";
  const sepIdx = slice.lastIndexOf(sep);
  if (sepIdx < 0) return null;
  let pos = nodeStart + sepIdx + 2;
  while (pos < nodeEnd && /[\s>]/.test(markdown[pos]!)) pos++;
  if (pos >= nodeEnd) return null;
  if (markdown[pos] === "<") {
    const start = pos + 1;
    let end = start;
    while (end < nodeEnd && markdown[end] !== ">") {
      if (markdown[end] === "\\") end += 2;
      else end++;
    }
    return end < nodeEnd ? { start, end, angled: true } : null;
  }
  const start = pos;
  let end = start;
  let parens = 0;
  while (end < nodeEnd) {
    const ch = markdown[end]!;
    if (/\s/.test(ch)) break;
    if (ch === "(") parens++;
    else if (ch === ")") {
      if (parens === 0) break;
      parens--;
    }
    end++;
  }
  return end > start ? { start, end, angled: false } : null;
}

/**
 * Escapes backslashes in authored Windows destinations so both md4c and the shared parser read the
 * same literal path.
 */
function markdownWithWindowsPathDestinations(markdown: string): string {
  if (!WINDOWS_DESTINATION.test(markdown)) return markdown;
  const edits: MarkdownEdit[] = [];
  const root = parseMarkdown(markdown, { gfm: true, windowsPaths: true, autolinkBoundaries: false });
  const visit = (node: MarkdownNode) => {
    if (
      (node.type === "link" || node.type === "image" || node.type === "definition") &&
      node.position &&
      !(node.type === "link" && node.autolink)
    ) {
      const span = findDestinationSpanInNode(
        markdown,
        node.position.start.offset,
        node.position.end.offset,
        node.type === "definition",
      );
      if (span) {
        const authored = markdown.slice(span.start, span.end);
        if (isWindowsAbsolutePath(authored) && authored.includes("\\") && !/[<>]/.test(authored)) {
          const escaped = authored.replace(/\\(?!&)/g, "\\\\");
          edits.push({
            start: span.start,
            end: span.end,
            content: span.angled ? escaped : `<${escaped}>`,
          });
        }
      }
    }
    if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  };
  visit(root);
  edits.sort((a, b) => a.start - b.start);
  return applyMarkdownEdits(markdown, edits);
}

export function markdownForNativeParsing(markdown: string): string {
  return markdownWithWindowsPathDestinations(markdownWithHtml(markdown));
}

export function parseMarkdownDocument(markdown: string): MdRoot {
  return parseGfmProse(markdownForNativeParsing(markdown));
}

export function markdownForNativeRendering(markdown: string, fileLink: RegExp): string {
  return transformNativeMarkdown(markdownForNativeParsing(markdown), fileLink, true);
}

/** Native media slots only cover standalone images; nested file embeds must become links. */
export function markdownWithFileEmbeds(
  markdown: string,
  label: (href: string, standalone: boolean) => string | null,
): { markdown: string; fileHrefs: ReadonlySet<string> } {
  const fileHrefs = new Set<string>();
  if (!markdown.includes("![")) return { markdown, fileHrefs };
  const root = parseGfmProse(markdown);
  const topLevelBlocks = new Set<MarkdownNode>(root.children);
  const definitions = new Map<string, string>();
  const collect = (node: MarkdownNode) => {
    if (node.type === "definition") {
      const identifier = node.identifier.toUpperCase();
      if (!definitions.has(identifier)) definitions.set(identifier, node.url);
    }
    if ("children" in node) node.children.forEach(collect);
  };
  collect(root);
  const edits: Array<{ start: number; end: number; content: string }> = [];
  const visit = (node: MarkdownNode, standalone = false, insideLink = false) => {
    if (node.type === "image" || node.type === "imageReference") {
      const href =
        node.type === "image" ? node.url : definitions.get(node.identifier.toUpperCase());
      const name = href === undefined ? null : label(href, standalone);
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (href !== undefined && name !== null && start !== undefined && end !== undefined) {
        const text = name.replace(/[\\[\]`*_~|&<>]/g, "\\$&");
        const url = href.replace(/[\\&]/g, "\\$&").replace(/</g, "%3C").replace(/>/g, "%3E");
        edits.push({ start, end, content: insideLink ? text : `[${text}](<${url}>)` });
        fileHrefs.add(href);
      }
    }
    if ("children" in node)
      node.children.forEach((child) =>
        visit(
          child,
          node.type === "paragraph" && node.children.length === 1 && topLevelBlocks.has(node),
          insideLink || node.type === "link" || node.type === "linkReference",
        ),
      );
  };
  visit(root);
  return { markdown: applyMarkdownEdits(markdown, edits), fileHrefs };
}

const DIRECTION_MARK = { ltr: "‎", rtl: "‏" } as const;

function proseText(node: MarkdownNode): string {
  if (node.type === "text") return node.value;
  if (node.type === "inlineCode" || node.type === "code") return " ";
  if (!("children" in node)) return "";
  const text = node.children.map(proseText).join("");
  return node.type === "paragraph" || node.type === "heading" || node.type === "tableCell"
    ? ` ${text} `
    : text;
}

function renderedText(node: MarkdownNode): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if (!("children" in node)) return "";
  return node.children.map(renderedText).join("");
}

function firstLeafOffset(node: MarkdownNode): number | undefined {
  if (
    !("children" in node) ||
    node.children.length === 0 ||
    node.type === "link" ||
    node.type === "linkReference"
  ) {
    return node.position?.start.offset;
  }
  return firstLeafOffset(node.children[0]!);
}

export function markdownWithTextDirection(markdown: string): string {
  if (!hasRightToLeftLetter(markdown)) return markdown;
  const edits: MarkdownEdit[] = [];
  for (const block of parseGfmProse(markdown).children) {
    if (block.type === "code" || block.type === "html") continue;
    const direction = textDirection(proseText(block));
    if (!direction) continue;
    const mark = (node: MarkdownNode) => {
      if (node.type === "paragraph" || node.type === "heading" || node.type === "tableCell") {
        const offset = firstLeafOffset(node);
        const first = renderedText(node).match(/\p{L}/u)?.[0];
        if (offset !== undefined && first && textDirection(first) !== direction) {
          edits.push({ start: offset, end: offset, content: DIRECTION_MARK[direction] });
        }
        return;
      }
      if ("children" in node) node.children.forEach(mark);
    };
    mark(block);
  }
  return applyMarkdownEdits(markdown, edits);
}
