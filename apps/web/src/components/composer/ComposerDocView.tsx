import { Fragment, type ReactNode } from "react";

import type { RichTextMark } from "~/composer-rich-text";
import { previewMarkdownSourceSpans } from "~/composer-markdown-source";
import { composerTextDirections } from "~/composer-text-direction";
import type { TextDirection } from "~/textDirection";
import { ComposerCodeBlockNodeView } from "../chat/ComposerCodeBlockNodeView";
import type { CodeBlockHighlightSpan } from "../composerCodeBlockHighlight";
import { ComposerInlineChip } from "./ComposerChips";
import {
  type ComposerBlock,
  type ComposerDoc,
  type ComposerInline,
  type ComposerSelection,
  type FlatBlockSpan,
  type LinePrefix,
  MARK_ORDER,
  computeFlatBlockSpans,
  inlineFlatLength,
  isChipInline,
  isListPrefix,
  selectionFrom,
  selectionTo,
} from "./types";

function wrapMarks(node: ReactNode, marks: readonly RichTextMark[], key: string): ReactNode {
  let out = node;
  for (let i = MARK_ORDER.length - 1; i >= 0; i -= 1) {
    const m = MARK_ORDER[i]!;
    if (!marks.includes(m)) continue;
    out =
      m === "code" ? <code key={`${key}-c`} dir="ltr">{out}</code>
      : m === "italic" ? <em key={`${key}-i`}>{out}</em>
      : m === "bold" ? <strong key={`${key}-b`}>{out}</strong>
      : <s key={`${key}-s`}>{out}</s>;
  }
  return out;
}

function renderMarkdownSource(text: string, keyPrefix: string): ReactNode {
  const segs = previewMarkdownSourceSpans(text);
  const nodes: ReactNode[] = [];
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i]!;
    if (seg.isMarker && seg.text === "`" && segs[i + 1]?.marks.includes("code") && segs[i + 2]?.isMarker && segs[i + 2]?.text === "`") {
      const mid = segs[i + 1]!;
      const close = segs[i + 2]!;
      const other = mid.marks.filter((m) => m !== "code");
      const codeEl = (
        <code key={`${keyPrefix}-code-${i}`} dir="ltr">
          <span className={seg.hidden ? "composer-rich-marker-hidden" : "composer-rich-marker"}>{seg.text}</span>
          {mid.text}
          <span className={close.hidden ? "composer-rich-marker-hidden" : "composer-rich-marker"}>{close.text}</span>
        </code>
      );
      nodes.push(other.length ? wrapMarks(codeEl, other, `${keyPrefix}-${i}`) : codeEl);
      i += 2;
      continue;
    }
    nodes.push(
      seg.isMarker
        ? <span key={`${keyPrefix}-m-${i}`} className={seg.hidden ? "composer-rich-marker-hidden" : "composer-rich-marker"}>{seg.text}</span>
        : <Fragment key={`${keyPrefix}-s-${i}`}>{wrapMarks(seg.text, seg.marks, `${keyPrefix}-${i}`)}</Fragment>,
    );
  }
  return <span className="composer-markdown-source">{nodes}</span>;
}

function renderCode(code: string, spans: ReadonlyArray<CodeBlockHighlightSpan>): ReactNode {
  if (!code) return <br data-composer-sentinel="true" />;
  const nodes: ReactNode[] = [];
  if (spans.length === 0) nodes.push(code);
  else {
    let cur = 0;
    for (let i = 0; i < spans.length; i += 1) {
      const s = spans[i]!;
      const from = Math.max(cur, Math.min(s.from, code.length));
      const to = Math.max(from, Math.min(s.to, code.length));
      if (from > cur) nodes.push(code.slice(cur, from));
      if (to > from) nodes.push(<span key={`h-${i}-${from}`} style={{ color: s.color }}>{code.slice(from, to)}</span>);
      cur = to;
    }
    if (cur < code.length) nodes.push(code.slice(cur));
  }
  if (code.endsWith("\n")) nodes.push(<br key="trail" data-composer-sentinel="true" />);
  return nodes;
}

type ListPrefix = Extract<LinePrefix, { kind: "bullet" | "ordered" | "task" }>;
interface ListItemEntry { block: Extract<ComposerBlock, { kind: "line" }>; prefix: ListPrefix; blockIndex: number; span: FlatBlockSpan; dir: TextDirection | null; children: ListGroup[] }
interface ListGroup { kind: ListPrefix["kind"]; key: string; start?: number; items: ListItemEntry[] }

function groupListItems(entries: Omit<ListItemEntry, "children">[]): ListGroup[] {
  const roots: ListGroup[] = [];
  const stack: Array<{ indent: string; group: ListGroup; container: ListGroup[] }> = [];
  const groupKey = (p: ListPrefix) => (p.kind === "task" ? "task" : p.kind === "ordered" ? `ordered:${p.marker.slice(-1)}` : `bullet:${p.marker}`);
  const open = (container: ListGroup[], p: ListPrefix): ListGroup => {
    const g: ListGroup = { kind: p.kind, key: groupKey(p), ...(p.kind === "ordered" ? { start: Number.parseInt(p.marker, 10) || 1 } : {}), items: [] };
    container.push(g);
    return g;
  };
  for (const raw of entries) {
    const item: ListItemEntry = { ...raw, children: [] };
    const key = groupKey(raw.prefix);
    const { indent } = raw.prefix;
    for (;;) {
      const top = stack.at(-1);
      if (!top) { stack.push({ indent, group: open(roots, raw.prefix), container: roots }); continue; }
      if (top.indent === indent) {
        if (top.group.key !== key) top.group = open(top.container, raw.prefix);
        top.group.items.push(item);
        break;
      }
      if (top.indent !== "" && !indent.startsWith(top.indent)) {
        if (stack.length > 1) { stack.pop(); continue; }
        top.indent = indent;
        if (top.group.key !== key) top.group = open(top.container, raw.prefix);
        top.group.items.push(item);
        break;
      }
      const parent = top.group.items.at(-1);
      if (!parent) { top.group.items.push(item); break; }
      const nested = open(parent.children, raw.prefix);
      stack.push({ indent, group: nested, container: parent.children });
      nested.items.push(item);
      break;
    }
  }
  return roots;
}

export interface ComposerDocViewProps {
  readonly doc: ComposerDoc;
  readonly selection: ComposerSelection;
  readonly isEditable: boolean;
  readonly getCodeHighlightSpans: (language: string, code: string) => ReadonlyArray<CodeBlockHighlightSpan>;
  readonly onChangeCodeLanguage: (blockIndex: number, languageInfo: string) => void;
  readonly onToggleTaskItem: (blockIndex: number) => void;
  readonly onDeleteReadOnlyChip: (flatOffset: number) => void;
}

export function ComposerDocView({
  doc,
  selection,
  isEditable,
  getCodeHighlightSpans,
  onChangeCodeLanguage,
  onToggleTaskItem,
  onDeleteReadOnlyChip,
}: ComposerDocViewProps) {
  const spans = computeFlatBlockSpans(doc);
  const dirs = composerTextDirections(doc).blocks;
  const selFrom = selectionFrom(selection);
  const selTo = selectionTo(selection);

  const renderInlines = (inlines: readonly ComposerInline[], lineStart: number, kp: string): ReactNode => {
    if (inlines.length === 0) return <br data-composer-sentinel="true" />;
    let pos = lineStart;
    return inlines.map((item, idx) => {
      const start = pos;
      pos += inlineFlatLength(item);
      if (isChipInline(item)) {
        const el = (
          <ComposerInlineChip
            key={item.kind === "composer-citation" ? item.citeKey : `${kp}-c-${idx}-${start}`}
            chip={item}
            flatOffset={start}
            rangeSelected={selFrom < selTo && start >= selFrom && start + 1 <= selTo}
            isEditable={isEditable}
            onDeleteReadOnlyChip={onDeleteReadOnlyChip}
          />
        );
        return item.marks?.length ? wrapMarks(el, item.marks, `${kp}-cm-${idx}`) : el;
      }
      if (item.isMarkdownSource) return <Fragment key={`${kp}-src-${idx}`}>{renderMarkdownSource(item.text, `${kp}-src-${idx}`)}</Fragment>;
      return <Fragment key={`${kp}-t-${idx}`}>{wrapMarks(item.text, item.marks, `${kp}-tm-${idx}`)}</Fragment>;
    });
  };

  const lineAttrs = (bi: number, span: FlatBlockSpan) => ({
    "data-composer-line-start": span.start,
    "data-composer-line-end": span.end,
    "data-composer-block-index": bi,
  });

  const renderListGroup = (group: ListGroup, gk: string): ReactNode => {
    const listDir = group.items[0]?.dir ?? undefined;
    if (group.kind === "task") {
      return (
        <ul key={gk} data-type="taskList" dir={listDir}>
          {group.items.map((item) => {
            const checked = item.prefix.kind === "task" && item.prefix.checked;
            return (
              <li key={`li-${item.blockIndex}`} data-checked={checked ? "true" : "false"} dir={item.dir ?? undefined}>
                <label contentEditable={false} data-composer-ui="true">
                  <input type="checkbox" checked={checked} disabled={!isEditable} onChange={() => onToggleTaskItem(item.blockIndex)} />
                </label>
                <div>
                  <p {...lineAttrs(item.blockIndex, item.span)}>{renderInlines(item.block.inlines, item.span.start, `b-${item.blockIndex}`)}</p>
                  {item.children.map((c, ci) => renderListGroup(c, `${gk}-${item.blockIndex}-${ci}`))}
                </div>
              </li>
            );
          })}
        </ul>
      );
    }
    const Tag = group.kind === "ordered" ? "ol" : "ul";
    return (
      <Tag key={gk} start={group.start} dir={listDir}>
        {group.items.map((item) => {
          const marker = item.prefix.kind === "task" ? "-" : item.prefix.marker;
          return (
            <li key={`li-${item.blockIndex}`} data-marker={marker} data-marker-width={Math.min(marker.length, 10)} dir={item.dir ?? undefined}>
              <p {...lineAttrs(item.blockIndex, item.span)}>{renderInlines(item.block.inlines, item.span.start, `b-${item.blockIndex}`)}</p>
              {item.children.map((c, ci) => renderListGroup(c, `${gk}-${item.blockIndex}-${ci}`))}
            </li>
          );
        })}
      </Tag>
    );
  };

  const rendered: ReactNode[] = [];
  for (let i = 0; i < doc.blocks.length; i += 1) {
    const block = doc.blocks[i]!;
    const span = spans[i]!;
    const dir = dirs[i] ?? undefined;

    if (block.kind === "codeBlock") {
      rendered.push(
        <ComposerCodeBlockNodeView
          key={`code-${i}`}
          languageInfo={block.language}
          disabled={!isEditable}
          onChangeLanguage={(next) => onChangeCodeLanguage(i, next)}
          codeProps={lineAttrs(i, span)}
        >
          {renderCode(block.code, getCodeHighlightSpans(block.language, block.code))}
        </ComposerCodeBlockNodeView>,
      );
      continue;
    }
    if (block.kind === "horizontalRule") {
      rendered.push(<hr key={`hr-${i}`} contentEditable={false} data-composer-ui="true" />);
      continue;
    }
    if (block.prefix?.kind === "quote") {
      const qPrefix = block.prefix.prefix;
      const lines: Array<{ bi: number; b: Extract<ComposerBlock, { kind: "line" }>; s: FlatBlockSpan }> = [];
      let j = i;
      while (j < doc.blocks.length) {
        const cand = doc.blocks[j]!;
        if (cand.kind !== "line" || cand.prefix?.kind !== "quote" || cand.prefix.prefix !== qPrefix) break;
        lines.push({ bi: j, b: cand, s: spans[j]! });
        j += 1;
      }
      rendered.push(
        <blockquote key={`bq-${i}`} dir={dir}>
          {lines.map((l) => (
            <p key={`bq-${l.bi}`} {...lineAttrs(l.bi, l.s)}>{renderInlines(l.b.inlines, l.s.start, `bq-${l.bi}`)}</p>
          ))}
        </blockquote>,
      );
      i = j - 1;
      continue;
    }
    if (isListPrefix(block.prefix)) {
      const entries: Omit<ListItemEntry, "children">[] = [];
      let j = i;
      while (j < doc.blocks.length) {
        const cand = doc.blocks[j]!;
        if (cand.kind !== "line" || !isListPrefix(cand.prefix)) break;
        entries.push({ block: cand, prefix: cand.prefix, blockIndex: j, span: spans[j]!, dir: dirs[j] ?? null });
        j += 1;
      }
      groupListItems(entries).forEach((g, gi) => rendered.push(renderListGroup(g, `list-${i}-${gi}`)));
      i = j - 1;
      continue;
    }
    if (block.prefix?.kind === "heading") {
      const H = `h${Math.max(1, Math.min(6, block.prefix.level))}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      rendered.push(<H key={`h-${i}`} dir={dir} {...lineAttrs(i, span)}>{renderInlines(block.inlines, span.start, `h-${i}`)}</H>);
      continue;
    }
    rendered.push(<p key={`p-${i}`} dir={dir} {...lineAttrs(i, span)}>{renderInlines(block.inlines, span.start, `p-${i}`)}</p>);
  }
  return <>{rendered}</>;
}
