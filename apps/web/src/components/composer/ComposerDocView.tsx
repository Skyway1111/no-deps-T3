import { Fragment, memo, type ReactNode } from "react";

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
interface ListItemEntry { block: Extract<ComposerBlock, { kind: "line" }>; prefix: ListPrefix; blockIndex: number; dir: TextDirection | null; children: ListGroup[] }
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

type LineBlock = Extract<ComposerBlock, { kind: "line" }>;

interface ComposerLineProps {
  readonly as: "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
  readonly blockIndex: number;
  readonly inlines: readonly ComposerInline[];
  readonly dir?: TextDirection | undefined;
  readonly isEditable: boolean;
  /** Block-relative selected range; only blocks holding chips receive one. */
  readonly selFrom: number;
  readonly selTo: number;
  readonly onDeleteReadOnlyChip: (blockIndex: number, offset: number) => void;
}

// DOM offsets are block-relative (domSync resolves `data-composer-block-index` against the doc), so an edit re-renders only its own line.
const ComposerLine = memo(function ComposerLine({ as: Tag, blockIndex, inlines, dir, isEditable, selFrom, selTo, onDeleteReadOnlyChip }: ComposerLineProps) {
  let content: ReactNode;
  if (inlines.length === 0) content = <br data-composer-sentinel="true" />;
  else {
    let pos = 0;
    const deleteChip = (offset: number) => onDeleteReadOnlyChip(blockIndex, offset);
    content = inlines.map((item, idx) => {
      const start = pos;
      pos += inlineFlatLength(item);
      if (isChipInline(item)) {
        const el = (
          <ComposerInlineChip
            key={item.kind === "composer-citation" ? item.citeKey : `c-${idx}-${start}`}
            chip={item}
            offset={start}
            rangeSelected={selFrom < selTo && start >= selFrom && start + 1 <= selTo}
            isEditable={isEditable}
            onDeleteReadOnlyChip={deleteChip}
          />
        );
        return item.marks?.length ? wrapMarks(el, item.marks, `cm-${idx}`) : el;
      }
      if (item.isMarkdownSource) return <Fragment key={`src-${idx}`}>{renderMarkdownSource(item.text, `src-${idx}`)}</Fragment>;
      return <Fragment key={`t-${idx}`}>{wrapMarks(item.text, item.marks, `tm-${idx}`)}</Fragment>;
    });
  }
  return <Tag dir={dir} data-composer-block-index={blockIndex}>{content}</Tag>;
});

const ComposerCodeBlock = memo(function ComposerCodeBlock({ blockIndex, language, code, spans, isEditable, onChangeCodeLanguage }: {
  readonly blockIndex: number;
  readonly language: string;
  readonly code: string;
  readonly spans: ReadonlyArray<CodeBlockHighlightSpan>;
  readonly isEditable: boolean;
  readonly onChangeCodeLanguage: (blockIndex: number, languageInfo: string) => void;
}) {
  return (
    <ComposerCodeBlockNodeView
      languageInfo={language}
      disabled={!isEditable}
      onChangeLanguage={(next) => onChangeCodeLanguage(blockIndex, next)}
      codeProps={{ "data-composer-block-index": blockIndex }}
    >
      {renderCode(code, spans)}
    </ComposerCodeBlockNodeView>
  );
});

export interface ComposerDocViewProps {
  readonly doc: ComposerDoc;
  readonly selection: ComposerSelection;
  readonly isEditable: boolean;
  /** Must return the same array for unchanged input, so memoized code blocks skip re-rendering. */
  readonly getCodeHighlightSpans: (language: string, code: string) => ReadonlyArray<CodeBlockHighlightSpan>;
  readonly onChangeCodeLanguage: (blockIndex: number, languageInfo: string) => void;
  readonly onToggleTaskItem: (blockIndex: number) => void;
  readonly onDeleteReadOnlyChip: (blockIndex: number, offset: number) => void;
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

  const line = (as: ComposerLineProps["as"], bi: number, block: LineBlock, dir?: TextDirection) => {
    const span: FlatBlockSpan = spans[bi]!;
    const selected = selFrom < selTo && selFrom < span.end && selTo > span.start && block.inlines.some(isChipInline);
    return (
      <ComposerLine
        key={`${as}-${bi}`}
        as={as}
        blockIndex={bi}
        inlines={block.inlines}
        dir={dir}
        isEditable={isEditable}
        selFrom={selected ? Math.max(0, selFrom - span.start) : 0}
        selTo={selected ? Math.min(span.end, selTo) - span.start : 0}
        onDeleteReadOnlyChip={onDeleteReadOnlyChip}
      />
    );
  };

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
                  {line("p", item.blockIndex, item.block)}
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
              {line("p", item.blockIndex, item.block)}
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
    const dir = dirs[i] ?? undefined;

    if (block.kind === "codeBlock") {
      rendered.push(
        <ComposerCodeBlock
          key={`code-${i}`}
          blockIndex={i}
          language={block.language}
          code={block.code}
          spans={getCodeHighlightSpans(block.language, block.code)}
          isEditable={isEditable}
          onChangeCodeLanguage={onChangeCodeLanguage}
        />,
      );
      continue;
    }
    if (block.kind === "horizontalRule") {
      rendered.push(<hr key={`hr-${i}`} contentEditable={false} data-composer-ui="true" />);
      continue;
    }
    if (block.prefix?.kind === "quote") {
      const qPrefix = block.prefix.prefix;
      const lines: ReactNode[] = [];
      let j = i;
      while (j < doc.blocks.length) {
        const cand = doc.blocks[j]!;
        if (cand.kind !== "line" || cand.prefix?.kind !== "quote" || cand.prefix.prefix !== qPrefix) break;
        lines.push(line("p", j, cand));
        j += 1;
      }
      rendered.push(<blockquote key={`bq-${i}`} dir={dir}>{lines}</blockquote>);
      i = j - 1;
      continue;
    }
    if (isListPrefix(block.prefix)) {
      const entries: Omit<ListItemEntry, "children">[] = [];
      let j = i;
      while (j < doc.blocks.length) {
        const cand = doc.blocks[j]!;
        if (cand.kind !== "line" || !isListPrefix(cand.prefix)) break;
        entries.push({ block: cand, prefix: cand.prefix, blockIndex: j, dir: dirs[j] ?? null });
        j += 1;
      }
      groupListItems(entries).forEach((g, gi) => rendered.push(renderListGroup(g, `list-${i}-${gi}`)));
      i = j - 1;
      continue;
    }
    if (block.prefix?.kind === "heading") {
      rendered.push(line(`h${Math.max(1, Math.min(6, block.prefix.level))}` as ComposerLineProps["as"], i, block, dir));
      continue;
    }
    rendered.push(line("p", i, block, dir));
  }
  return <>{rendered}</>;
}

