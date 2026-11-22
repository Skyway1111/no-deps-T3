import {
  type ComposerBlock,
  type ComposerChip,
  type ComposerDoc,
  type ComposerInline,
  type ComposerSelection,
  collapsedSelection,
  computeFlatBlockSpans,
  docFlatLength,
  inlineFlatLength,
  isChipInline,
  normalizeInlines,
  resolveFlatOffset,
} from "./types";

// Line elements carry only their block index; flat offsets come from the doc, so edits leave other lines' DOM untouched.
const LINE = "[data-composer-block-index]";
const blockIndexOf = (el: HTMLElement): number => Number(el.dataset.composerBlockIndex ?? "-1");

const isUiOrSentinel = (node: Node): boolean =>
  node instanceof Element &&
  (node.hasAttribute("data-composer-sentinel") ||
    node.hasAttribute("data-composer-ui") ||
    node.closest("[data-composer-ui]") !== null);

const isChipEl = (node: Node): node is HTMLElement =>
  node instanceof HTMLElement && node.hasAttribute("data-composer-chip-offset");

function measureDomLength(node: Node): number {
  if (isUiOrSentinel(node)) return 0;
  if (isChipEl(node)) return 1;
  if (node.nodeType === Node.TEXT_NODE) return (node as Text).data.length;
  if (node instanceof HTMLElement && node.getAttribute("contenteditable") === "false") return 0;
  let total = 0;
  for (const child of Array.from(node.childNodes)) total += measureDomLength(child);
  return total;
}

function domPointToLineOffset(lineEl: HTMLElement, targetNode: Node, targetOffset: number): number {
  let offset = 0;
  let found = false;
  const walk = (node: Node): void => {
    if (found) return;
    if (node === targetNode) {
      if (node.nodeType === Node.TEXT_NODE) {
        offset += Math.min(targetOffset, (node as Text).data.length);
      } else {
        const limit = Math.min(targetOffset, node.childNodes.length);
        for (let i = 0; i < limit; i += 1) offset += measureDomLength(node.childNodes[i]!);
      }
      found = true;
      return;
    }
    if (isUiOrSentinel(node)) return;
    if (isChipEl(node)) {
      if (node.contains(targetNode)) { found = true; return; }
      offset += 1;
      return;
    }
    if (node instanceof HTMLElement && node.getAttribute("contenteditable") === "false") return;
    if (node.nodeType === Node.TEXT_NODE) { offset += (node as Text).data.length; return; }
    for (const child of Array.from(node.childNodes)) { walk(child); if (found) return; }
  };
  walk(lineEl);
  return offset;
}

export function domPointToFlatOffset(rootEl: HTMLElement, doc: ComposerDoc, node: Node, offset: number): number {
  const spans = computeFlatBlockSpans(doc);
  const total = docFlatLength(doc);
  if (node === rootEl) {
    if (offset === 0) return 0;
    const child = rootEl.childNodes[Math.min(offset, rootEl.childNodes.length - 1)];
    const line = child instanceof HTMLElement ? (child.matches(LINE) ? child : child.querySelector<HTMLElement>(LINE)) : null;
    if (line) return Math.max(0, Math.min(spans[blockIndexOf(line)]?.start ?? 0, total));
    return offset >= rootEl.childNodes.length ? total : 0;
  }
  const lineEl = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(LINE);
  const span = lineEl && rootEl.contains(lineEl) ? spans[blockIndexOf(lineEl)] : undefined;
  if (!lineEl || !span) return total;
  return Math.max(span.start, Math.min(span.start + domPointToLineOffset(lineEl, node, offset), Math.max(span.end, total)));
}

export function domSelectionToFlat(rootEl: HTMLElement, doc: ComposerDoc): ComposerSelection | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !sel.focusNode) return null;
  if (!rootEl.contains(sel.anchorNode) || !rootEl.contains(sel.focusNode)) return null;
  return {
    anchor: domPointToFlatOffset(rootEl, doc, sel.anchorNode, sel.anchorOffset),
    head: domPointToFlatOffset(rootEl, doc, sel.focusNode, sel.focusOffset),
  };
}

function findDomPointInLine(lineEl: HTMLElement, targetLocal: number): { node: Node; offset: number } {
  let rem = targetLocal;
  let lastText: Text | null = null;
  const walk = (parent: Node): { node: Node; offset: number } | null => {
    for (let i = 0; i < parent.childNodes.length; i += 1) {
      const child = parent.childNodes[i]!;
      if (isUiOrSentinel(child)) continue;
      if (isChipEl(child)) {
        if (rem === 0) return { node: parent, offset: i };
        rem -= 1;
        if (rem === 0) return { node: parent, offset: i + 1 };
        continue;
      }
      if (child instanceof HTMLElement && child.getAttribute("contenteditable") === "false") continue;
      if (child.nodeType === Node.TEXT_NODE) {
        const textNode = child as Text;
        lastText = textNode;
        if (rem <= textNode.data.length) return { node: textNode, offset: rem };
        rem -= textNode.data.length;
        continue;
      }
      const nested = walk(child);
      if (nested) return nested;
    }
    return null;
  };
  return walk(lineEl) ?? (lastText ? { node: lastText, offset: (lastText as Text).data.length } : { node: lineEl, offset: 0 });
}

export function flatOffsetToDomPoint(rootEl: HTMLElement, doc: ComposerDoc, flatOffset: number): { node: Node; offset: number } {
  const res = resolveFlatOffset(doc, flatOffset);
  const line = rootEl.querySelector<HTMLElement>(`[data-composer-block-index="${res.blockIndex}"]`);
  return line ? findDomPointInLine(line, res.offsetInBlock) : { node: rootEl, offset: 0 };
}

export function applyFlatSelectionToDom(rootEl: HTMLElement, doc: ComposerDoc, selection: ComposerSelection): boolean {
  const domSel = window.getSelection();
  if (!domSel) return false;
  const a = flatOffsetToDomPoint(rootEl, doc, selection.anchor);
  const h = selection.anchor === selection.head ? a : flatOffsetToDomPoint(rootEl, doc, selection.head);
  if (domSel.anchorNode === a.node && domSel.anchorOffset === a.offset && domSel.focusNode === h.node && domSel.focusOffset === h.offset) {
    return false;
  }
  try {
    domSel.setBaseAndExtent(a.node, a.offset, h.node, h.offset);
  } catch {
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.collapse(true);
    domSel.removeAllRanges();
    domSel.addRange(range);
  }
  return true;
}

/** Fallback DOM reader for browser-driven mutations (IME compositionend, dictation, spellcheck). */
export function readDocFromDom(rootEl: HTMLElement, prevDoc: ComposerDoc): { doc: ComposerDoc; selection: ComposerSelection } {
  const readInlines = (el: HTMLElement, block: ComposerBlock): ComposerInline[] => {
    const chips = new Map<number, ComposerChip>();
    if (block.kind === "line") {
      let pos = 0;
      for (const item of block.inlines) {
        if (isChipInline(item)) chips.set(pos, item);
        pos += inlineFlatLength(item);
      }
    }
    const out: ComposerInline[] = [];
    const walk = (n: Node) => {
      if (isUiOrSentinel(n)) return;
      if (isChipEl(n)) { const c = chips.get(Number(n.dataset.composerChipOffset)); if (c) out.push(c); return; }
      if (n instanceof HTMLElement && n.getAttribute("contenteditable") === "false") return;
      if (n.nodeType === Node.TEXT_NODE) { if ((n as Text).data) out.push({ kind: "text", text: (n as Text).data, marks: [] }); return; }
      for (const ch of Array.from(n.childNodes)) walk(ch);
    };
    walk(el);
    return normalizeInlines(out);
  };
  const byBlock = new Map<number, HTMLElement>();
  for (const el of rootEl.querySelectorAll<HTMLElement>(LINE)) byBlock.set(blockIndexOf(el), el);
  const plainSig = (items: readonly ComposerInline[]) => items.map((i) => (i.kind === "text" ? i.text : `\uFFFC${i.kind}`)).join("");

  const blocks: ComposerBlock[] = prevDoc.blocks.map((block, bi) => {
    const el = byBlock.get(bi);
    if (!el || block.kind === "horizontalRule") return block;
    if (block.kind === "codeBlock") {
      return { ...block, code: readInlines(el, block).map((i) => (i.kind === "text" ? i.text : "")).join("") };
    }
    const next = readInlines(el, block);
    return { ...block, inlines: plainSig(block.inlines) === plainSig(next) ? block.inlines : next };
  });

  const nextDoc: ComposerDoc = { blocks };
  const domSel = window.getSelection();
  let selection = collapsedSelection(docFlatLength(nextDoc));
  if (domSel?.anchorNode && domSel.focusNode && rootEl.contains(domSel.anchorNode)) {
    const nextSpans = computeFlatBlockSpans(nextDoc);
    const mapPt = (n: Node, off: number) => {
      const lineEl = (n instanceof Element ? n : n.parentElement)?.closest<HTMLElement>(LINE);
      const span = lineEl ? nextSpans[blockIndexOf(lineEl)] : undefined;
      if (!lineEl || !span) return docFlatLength(nextDoc);
      return Math.max(span.start, Math.min(span.start + domPointToLineOffset(lineEl, n, off), span.end));
    };
    selection = { anchor: mapPt(domSel.anchorNode, domSel.anchorOffset), head: mapPt(domSel.focusNode, domSel.focusOffset) };
  }
  return { doc: nextDoc, selection };
}

export function caretLineRect(range: Range, edge: "start" | "end"): DOMRect | null {
  const rects = Array.from(range.getClientRects()).filter((r) => r.height > 0);
  const direct = edge === "start" ? rects.at(-1) : rects[0];
  if (direct) return direct;
  const c = range.startContainer;
  const probeChar = (textNode: Text, idx: number): DOMRect | null => {
    const r = document.createRange();
    r.setStart(textNode, idx);
    r.setEnd(textNode, idx + 1);
    return Array.from(r.getClientRects()).find((x) => x.height > 0) ?? (r.getBoundingClientRect().height > 0 ? r.getBoundingClientRect() : null);
  };
  if (c.nodeType === Node.TEXT_NODE) {
    const t = c as Text;
    return t.data.length ? probeChar(t, Math.max(0, Math.min(edge === "start" ? range.startOffset : range.startOffset - 1, t.data.length - 1))) : null;
  }
  if (!(c instanceof HTMLElement)) return null;
  const nb = c.childNodes[Math.max(0, range.startOffset - 1)] ?? c.childNodes[range.startOffset];
  if (nb instanceof HTMLElement && nb.getBoundingClientRect().height > 0) return nb.getBoundingClientRect();
  if (nb instanceof Text && nb.data.length > 0) {
    const r = probeChar(nb, nb === c.childNodes[range.startOffset - 1] ? nb.data.length - 1 : 0);
    if (r) return r;
  }
  const cr = c.getBoundingClientRect();
  return cr.height > 0 ? cr : null;
}

const pendingReveals = new Set<HTMLElement>();

/** Scrolls the caret into view before the next paint; calls within a frame share one layout read. */
export function revealCaretInScroller(scroller: HTMLElement): void {
  if (pendingReveals.has(scroller)) return;
  pendingReveals.add(scroller);
  requestAnimationFrame(() => {
    pendingReveals.delete(scroller);
    if (scroller.isConnected && scroller.scrollHeight > scroller.clientHeight) revealNow(scroller);
  });
}

function revealNow(scroller: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !scroller.contains(sel.anchorNode)) return;
  const caret = caretLineRect(sel.getRangeAt(0), "end");
  if (!caret) return;
  const box = scroller.getBoundingClientRect();
  const style = getComputedStyle(scroller);
  const bottom = box.bottom - parseFloat(style.paddingBottom);
  const top = box.top + parseFloat(style.paddingTop);
  if (caret.bottom > bottom) scroller.scrollTop += caret.bottom - bottom;
  else if (caret.top < top) scroller.scrollTop -= top - caret.top;
}

export function isCaretOnVisualEdge(rootEl: HTMLElement | null, value: string, expandedCursor: number, edge: "start" | "end"): boolean {
  if (value.length === 0) return true;
  if (edge === "start" ? value.slice(0, expandedCursor).includes("\n") : value.slice(expandedCursor).includes("\n")) return false;
  const sel = window.getSelection();
  if (!rootEl || !sel || !sel.isCollapsed || sel.rangeCount === 0 || !sel.anchorNode || !rootEl.contains(sel.anchorNode)) return false;
  const caret = caretLineRect(sel.getRangeAt(0), edge);
  if (!caret) return false;
  const edgeRect = ((edge === "start" ? rootEl.firstElementChild : rootEl.lastElementChild) ?? rootEl).getBoundingClientRect();
  const threshold = caret.height / 2;
  return edge === "start" ? caret.top - edgeRect.top < threshold : edgeRect.bottom - caret.bottom < threshold;
}
