import type {
  DiffLineAnnotation,
  SelectedLineRange,
  SelectionSide,
} from "@t3tools/shared/diff/patch";
import { useImperativeHandle, useLayoutEffect, useReducer, useRef, useState } from "react";

import {
  buildDiffRows,
  EXPANSION_LINE_COUNT,
  growRegion,
  hydratedDiff,
  loadHydratedDiff,
  revealRegion,
  type Expansion,
} from "./diffLayout";
import {
  buildDiffModel,
  diffSectionSpec,
  DiffBody,
  DiffHeader,
  lineText,
  selectedRows,
  syncSplitAnnotations,
  type DiffModel,
} from "./DiffBody";
import { alignOffset, PROBE_LENGTH, ViewEngine, type SectionSpec } from "./engine";
import { useGutter, type LinePoint } from "./gutter";
import { findAll, isFindShortcut, SearchWidget, setSearchHighlights, textRange } from "./search";
import { ensureThemeStyles } from "./tokens";
import type {
  CodeViewHandle,
  CodeViewInstance,
  CodeViewItem,
  CodeViewLineSelection,
  CodeViewProps,
  CodeViewScrollTarget,
  FileDiffInstance,
} from "./types";
import "./codeView.css";

const NO_EXPANSION: Expansion = new Map();
/** Every unchanged line, for searching a whole diff. */
const FULL_EXPANSION: Expansion = {
  get: () => ({ fromStart: Number.MAX_SAFE_INTEGER, fromEnd: 0 }),
} as unknown as Expansion;
const STICKY_HEADER = 32;

interface Entry<L> {
  item: CodeViewItem<L>;
  readonly unsubscribe: () => void;
  readonly model: DiffModel;
  readonly spec: SectionSpec;
  readonly inputs: ReadonlyArray<unknown>;
}

interface SearchMatch {
  readonly id: string;
  readonly side: SelectionSide;
  readonly lineNumber: number;
  readonly start: number;
  readonly end: number;
}

function setRef<T>(ref: React.Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

function sameInputs(a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

class CodeViewController<L> {
  readonly engine = new ViewEngine();
  constructor() {
    this.engine.beforeMeasure = syncSplitAnnotations;
  }
  props!: ViewProps<L>;
  rerender: () => void = () => {};
  private entries = new Map<string, Entry<L>>();
  private expansions = new Map<string, Expansion>();
  private instances = new Map<string, FileDiffInstance>();
  private posted = new Map<string, HTMLElement>();
  /** Items just expanded, whose bodies fade in. */
  entering = new Set<string>();
  ownSelection: CodeViewLineSelection | null = null;
  search = { open: false, query: "", matches: [] as SearchMatch[], current: -1 };
  private searchInput: HTMLInputElement | null = null;

  readonly instance: CodeViewInstance = {
    getHeight: () => this.engine.scroller?.clientHeight ?? 0,
    getScrollHeight: () => this.engine.scroller?.scrollHeight ?? 0,
    getRenderedItems: () =>
      [...this.engine.window.keys()].flatMap((index) => {
        const item = this.props.items[index];
        return item ? [{ id: item.id, instance: this.instanceFor(item.id) }] : [];
      }),
    render: () => this.rerender(),
  };

  readonly handle: CodeViewHandle<L> = {
    getInstance: () => this.instance,
    getItem: (id) => this.props.items.find((item) => item.id === id),
    scrollTo: (target) => this.scrollTo(target),
    openSearch: (query) => this.openSearch(query),
    closeSearch: () => this.closeSearch(),
    isSearchOpen: () => this.search.open,
    navigateSearch: (direction) => this.navigateSearch(direction),
  };

  get items() {
    return this.props.items;
  }

  /** `version` is the render counter: snapshots must change when internal state does. */
  sync(props: ViewProps<L>, rerender: () => void, _version: number): Snapshot<L> {
    this.props = props;
    this.rerender = rerender;
    this.engine.rerender = rerender;
    this.engine.onScroll = () =>
      props.onScroll?.(this.engine.scroller?.scrollTop ?? 0, this.instance);
    this.engine.wrap = props.options?.overflow === "wrap";
    const live = new Set<string>();
    const specs = props.items.map((item) => {
      live.add(item.id);
      return this.entryFor(item).spec;
    });
    for (const id of this.entries.keys()) {
      if (live.has(id)) continue;
      this.entries.get(id)?.unsubscribe();
      this.entries.delete(id);
      this.instances.delete(id);
      this.posted.delete(id);
    }
    this.engine.setSections(specs);
    return this.snapshot();
  }

  private snapshot(): Snapshot<L> {
    const { engine } = this;
    const blocks: Array<Snapshot<L>["blocks"][number]> = [];
    const selection = this.selection();
    let cursor = 0;
    const gap = (to: number) => {
      if (to > cursor)
        blocks.push({
          kind: "gap",
          key: `gap-${cursor}`,
          height: engine.sectionTop(to) - engine.sectionTop(cursor),
        });
    };
    for (const [index, [start, end]] of engine.window) {
      const item = this.props.items[index];
      const entry = item && this.entries.get(item.id);
      if (!entry) continue;
      gap(index);
      const { before, after } = engine.gaps(index, start, end);
      blocks.push({
        kind: "section",
        key: item.id,
        entry,
        index,
        start,
        end,
        before,
        after,
        entering: this.entering.has(item.id),
        range: selection?.id === item.id ? selection.range : null,
        tokensVersion: entry.model.deletions.version + entry.model.additions.version,
      });
      cursor = index + 1;
    }
    gap(this.props.items.length);
    return { props: this.props, blocks, search: this.search };
  }

  entry(id: string) {
    return this.entries.get(id);
  }

  private entryFor(item: CodeViewItem<L>): Entry<L> {
    const options = this.props.options ?? {};
    const diff = hydratedDiff(item.fileDiff);
    const expansion = this.expansions.get(item.id) ?? NO_EXPANSION;
    const inputs = [
      item.version ?? item.annotations,
      item.fileDiff,
      diff,
      expansion,
      options.diffStyle === "split",
      options.hunkSeparators ?? "line-info",
      (options.lineDiffType ?? "word-alt") !== "none",
      options.loadDiffFiles !== undefined,
      item.collapsed === true,
    ];
    const cached = this.entries.get(item.id);
    if (cached?.item.collapsed && !item.collapsed) {
      this.entering.add(item.id);
      setTimeout(() => this.entering.delete(item.id), 300);
    }
    if (cached && sameInputs(cached.inputs, inputs)) {
      cached.item = item;
      return cached;
    }
    const model =
      cached && sameInputs(cached.inputs.slice(0, -1), inputs.slice(0, -1))
        ? cached.model
        : buildDiffModel({
            diff,
            split: options.diffStyle === "split",
            expansion,
            separators: options.hunkSeparators ?? "line-info",
            annotations: (item.annotations ?? []) as ReadonlyArray<DiffLineAnnotation<unknown>>,
            canLoad: options.loadDiffFiles !== undefined,
            emphasis: (options.lineDiffType ?? "word-alt") !== "none",
          });
    if (cached && cached.model !== model) cached.unsubscribe();
    const entry: Entry<L> = {
      item,
      unsubscribe:
        cached?.model === model
          ? cached.unsubscribe
          : (() => {
              // Idle tokenizing of a long file finishes after the render that asked for it.
              const stops = [model.deletions, model.additions].map((tokens) =>
                tokens.subscribe(() => this.rerender()),
              );
              return () => stops.forEach((stop) => stop());
            })(),
      model,
      spec: diffSectionSpec(item.id, model, {
        hasHeader: true,
        collapsed: item.collapsed === true,
      }),
      inputs,
    };
    this.entries.set(item.id, entry);
    return entry;
  }

  instanceFor(id: string): FileDiffInstance {
    let instance = this.instances.get(id);
    if (instance) return instance;
    const controller = this;
    instance = {
      get fileDiff() {
        return controller.entries.get(id)!.item.fileDiff;
      },
      getDiffForSearch: () => this.entries.get(id)!.model.diff,
      revealLine: (lineNumber, side = "additions") => {
        const entry = this.entries.get(id);
        if (!entry) return false;
        const region = revealRegion(
          entry.model.diff,
          this.expansions.get(id) ?? NO_EXPANSION,
          lineNumber,
          side,
        );
        if (!region) return false;
        this.expand(id, region.hunkIndex, region.direction, region.count);
        return true;
      },
      expandHunk: (hunkIndex, direction, count) => this.expand(id, hunkIndex, direction, count),
      getLinePosition: (lineNumber, side = "additions") => {
        const entry = this.entries.get(id);
        const section = this.engine.indexOf(id);
        const row = entry?.model.rowOf.get(`${side}:${lineNumber}`);
        if (section === undefined || row === undefined) return undefined;
        return {
          top: this.engine.rowTop(section, row),
          height: this.engine.rowHeight(section, row),
        };
      },
    };
    this.instances.set(id, instance);
    return instance;
  }

  expand(
    id: string,
    hunkIndex: number,
    direction: "up" | "down" | "both",
    count = EXPANSION_LINE_COUNT,
  ) {
    const entry = this.entries.get(id);
    if (!entry) return;
    const apply = () => {
      const current = this.expansions.get(id) ?? NO_EXPANSION;
      this.expansions.set(
        id,
        new Map(current).set(hunkIndex, growRegion(current.get(hunkIndex), direction, count)),
      );
      this.rerender();
    };
    const load = this.props.options?.loadDiffFiles;
    if (!entry.model.diff.isPartial) return apply();
    if (!load) return;
    loadHydratedDiff(entry.model.diff, load).then(apply, (error: unknown) => {
      console.error(error);
    });
  }

  selection(): CodeViewLineSelection | null {
    return this.props.selectedLines !== undefined ? this.props.selectedLines : this.ownSelection;
  }

  setSelection(selection: CodeViewLineSelection | null) {
    if (this.props.selectedLines === undefined) {
      this.ownSelection = selection;
      this.rerender();
    }
    this.props.onSelectedLinesChange?.(selection);
  }

  private viewport() {
    return this.engine.scroller?.clientHeight ?? 0;
  }

  scrollTo(target: CodeViewScrollTarget) {
    if (target.type === "position") {
      this.engine.scrollToContent(() => target.position);
      return;
    }
    const sticky = this.props.options?.stickyHeaders === false ? 0 : STICKY_HEADER;
    this.engine.scrollToContent(() => {
      const section = this.engine.indexOf(target.id);
      const entry = this.entries.get(target.id);
      if (section === undefined || !entry) return null;
      const sectionTop = this.engine.sectionTop(section);
      const current = this.engine.contentScrollTop;
      if (target.type === "item" || entry.item.collapsed) {
        return alignOffset(
          sectionTop,
          STICKY_HEADER,
          this.viewport(),
          target.align ?? "start",
          current,
          0,
        );
      }
      const rowFor = (lineNumber: number, side: SelectionSide | undefined) =>
        entry.model.rowOf.get(`${side ?? "additions"}:${lineNumber}`);
      const [first, last] =
        target.type === "line"
          ? [rowFor(target.lineNumber, target.side), rowFor(target.lineNumber, target.side)]
          : [
              rowFor(target.range.start, target.range.side),
              rowFor(target.range.end, target.range.endSide ?? target.range.side),
            ];
      if (first === undefined || last === undefined) return sectionTop;
      const [from, to] = first <= last ? [first, last] : [last, first];
      const top = sectionTop + this.engine.rowTop(section, from);
      const bottom =
        sectionTop + this.engine.rowTop(section, to) + this.engine.rowHeight(section, to);
      return alignOffset(
        top,
        bottom - top,
        this.viewport(),
        target.align ?? "center",
        current,
        sticky,
      );
    });
  }

  attachSearchInput(input: HTMLInputElement | null) {
    this.searchInput = input;
  }

  openSearch(query?: string) {
    this.search = { ...this.search, open: true };
    if (query !== undefined) this.setQuery(query);
    this.rerender();
    queueMicrotask(() => {
      this.searchInput?.focus();
      this.searchInput?.select();
    });
  }

  closeSearch() {
    this.search = { open: false, query: this.search.query, matches: [], current: -1 };
    setSearchHighlights(this, [], []);
    this.rerender();
  }

  setQuery(query: string) {
    const matches: SearchMatch[] = [];
    if (query !== "") {
      for (const item of this.props.items) {
        const model = this.entries.get(item.id)?.model;
        if (!model) continue;
        const rows = buildDiffRows({
          diff: model.diff,
          split: false,
          expansion: FULL_EXPANSION,
          separators: "line-info",
          annotations: [],
          canLoad: false,
        });
        for (const row of rows) {
          const line = row.kind === "line" ? (row.left ?? row.right) : null;
          if (!line) continue;
          for (const start of findAll(lineText(model, line), query))
            matches.push({
              id: item.id,
              side: line.side,
              lineNumber: line.lineNumber,
              start,
              end: start + query.length,
            });
        }
      }
    }
    this.search = { ...this.search, query, matches, current: matches.length > 0 ? 0 : -1 };
    if (matches.length > 0) this.revealMatch();
    this.rerender();
  }

  navigateSearch(direction: 1 | -1) {
    const { matches, current } = this.search;
    if (matches.length === 0) return;
    this.search = {
      ...this.search,
      current: (current + direction + matches.length) % matches.length,
    };
    this.revealMatch();
    this.rerender();
  }

  private revealMatch() {
    const match = this.search.matches[this.search.current];
    const item = match && this.props.items.find((candidate) => candidate.id === match.id);
    if (!match || !item) return;
    if (item.collapsed)
      this.props.options?.onItemCollapsedChange?.(item, { ...item, collapsed: false });
    this.instanceFor(item.id).revealLine(match.lineNumber, match.side);
    this.scrollTo({
      type: "line",
      id: item.id,
      lineNumber: match.lineNumber,
      side: match.side,
      align: "center",
    });
  }

  /** Draws find matches onto the rows now mounted. */
  private paintSearch() {
    const root = this.engine.root;
    if (!this.search.open || !root || this.search.matches.length === 0) {
      setSearchHighlights(this, [], []);
      return;
    }
    const matches: Range[] = [];
    const current: Range[] = [];
    const active = this.search.matches[this.search.current];
    for (const [index, [start, end]] of this.engine.window) {
      const item = this.props.items[index];
      const entry = item && this.entries.get(item.id);
      if (!entry || item.collapsed) continue;
      const section = root.querySelector(`:scope > [data-section="${index}"]`);
      for (const match of this.search.matches) {
        if (match.id !== item.id) continue;
        const row = entry.model.rowOf.get(`${match.side}:${match.lineNumber}`);
        if (row === undefined || row < start || row >= end) continue;
        const code = entry.model.split
          ? section?.querySelector(
              match.side === "deletions" ? "[data-deletions]" : "[data-additions]",
            )
          : section;
        const cell = code?.querySelector(`[data-content] > [data-row="${row}"]`);
        const range = cell && textRange(cell, match.start, match.end);
        if (!range) continue;
        (match === active ? current : matches).push(range);
      }
    }
    setSearchHighlights(this, matches, current);
  }

  commit() {
    this.engine.commit();
    this.paintSearch();
    const post = this.props.options?.onPostRender;
    const root = this.engine.root;
    if (!post || !root) return;
    const seen = new Set<string>();
    for (const index of this.engine.window.keys()) {
      const item = this.props.items[index];
      const node = root.querySelector<HTMLElement>(`:scope > [data-section="${index}"]`);
      if (!item || !node) continue;
      seen.add(item.id);
      post(node, this.instanceFor(item.id), this.posted.has(item.id) ? "update" : "mount");
      this.posted.set(item.id, node);
    }
    for (const [id, node] of this.posted) {
      if (seen.has(id)) continue;
      this.posted.delete(id);
      post(node, this.instanceFor(id), "unmount");
    }
  }

  dispose() {
    for (const entry of this.entries.values()) entry.unsubscribe();
    setSearchHighlights(this, [], []);
    this.engine.dispose();
  }
}

type ViewProps<L> = Omit<CodeViewProps<L>, "ref" | "containerRef">;

/** Everything one render reads, so compiled components re-render when any of it changes. */
interface Snapshot<L> {
  readonly props: ViewProps<L>;
  readonly blocks: ReadonlyArray<
    | { readonly kind: "gap"; readonly key: string; readonly height: number }
    | {
        readonly kind: "section";
        readonly key: string;
        readonly entry: Entry<L>;
        readonly index: number;
        readonly start: number;
        readonly end: number;
        readonly before: number;
        readonly after: number;
        readonly entering: boolean;
        readonly range: SelectedLineRange | null;
        readonly tokensVersion: number;
      }
  >;
  readonly search: CodeViewController<L>["search"];
}

function DiffSection<L>(props: {
  readonly controller: CodeViewController<L>;
  readonly view: ViewProps<L>;
  readonly entry: Entry<L>;
  readonly index: number;
  readonly start: number;
  readonly end: number;
  readonly before: number;
  readonly after: number;
  readonly entering: boolean;
  readonly range: SelectedLineRange | null;
  readonly tokensVersion: number;
}) {
  const { controller, view, entry, index, start, end, range } = props;
  const { item, model } = entry;
  const options = view.options ?? {};
  const pointFor = (lineNumber: number, side: SelectionSide | undefined): LinePoint | null => {
    const row = model.rowOf.get(`${side ?? "additions"}:${lineNumber}`);
    return row === undefined ? null : { row, lineNumber, side: side ?? "additions" };
  };
  const gutter = useGutter({
    lineSelection: options.enableLineSelection === true,
    gutterUtility: options.enableGutterUtility === true,
    selection: range,
    pointAt: (cell) => {
      const row = Number(cell.dataset.row);
      const entryRow = model.rows[row];
      if (entryRow?.kind !== "line") return null;
      const left = cell.closest("[data-deletions]") !== null;
      const line = model.split
        ? ((left ? entryRow.left : entryRow.right) ?? (left ? entryRow.right : entryRow.left))
        : (entryRow.left ?? entryRow.right);
      return line ? { row, lineNumber: line.lineNumber, side: line.side } : null;
    },
    pointFor,
    onChange: (next) => controller.setSelection(next ? { id: item.id, range: next } : null),
    onEnd: (next) => options.onLineSelectionEnd?.(next, { item }),
    onUtility: (next: SelectedLineRange) => options.onGutterUtilityClick?.(next, { item }),
  });
  return (
    <diffs-file
      data-section={index}
      data-hl-theme={ensureThemeStyles(options.theme ?? "pierre-dark")}
      style={options.themeType ? { colorScheme: options.themeType } : undefined}
    >
      <DiffHeader
        diff={item.fileDiff}
        sticky={options.stickyHeaders !== false}
        prefix={view.renderHeaderPrefix?.(item)}
        suffix={view.renderHeaderFilenameSuffix?.(item)}
        metadata={view.renderHeaderMetadata?.(item)}
      />
      {item.collapsed ? null : (
        <>
          {props.before > 0 ? (
            <div data-virtualizer-buffer="before" style={{ height: props.before }} />
          ) : null}
          <DiffBody
            model={model}
            start={start}
            end={end}
            overflow={options.overflow ?? "scroll"}
            entering={props.entering}
            tokensVersion={props.tokensVersion}
            selected={selectedRows(model, range)}
            hovered={gutter.hovered}
            interactive={options.enableLineSelection === true}
            utility={gutter.utility}
            renderAnnotation={(annotation) =>
              view.renderAnnotation?.(
                annotation as Parameters<NonNullable<typeof view.renderAnnotation>>[0],
                item.fileDiff,
                item,
              )
            }
            onExpand={(hunkIndex, direction, count) =>
              controller.expand(item.id, hunkIndex, direction, count)
            }
            handlers={gutter.handlers}
          />
          {props.after > 0 ? (
            <div data-virtualizer-buffer="after" style={{ height: props.after }} />
          ) : null}
        </>
      )}
    </diffs-file>
  );
}

/** A virtualized list of file diffs with sticky headers and a find widget. */
export function CodeView<L = undefined>({ ref, containerRef, ...props }: CodeViewProps<L>) {
  const [controller] = useState(() => new CodeViewController<L>());
  const [version, rerender] = useReducer((count: number) => count + 1, 0);
  const snapshot = controller.sync(props, rerender, version);
  useImperativeHandle(ref, () => controller.handle, [controller]);
  const scroller = useRef<HTMLDivElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const probe = useRef<HTMLDivElement | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the committed rows and keeps the viewport's top row in place before paint.
  useLayoutEffect(() => {
    controller.engine.attach(scroller.current, root.current, probe.current);
    controller.commit();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases scroll and resize listeners.
  useLayoutEffect(() => () => controller.dispose(), [controller]);

  const { search } = snapshot;
  return (
    <div
      ref={(node) => {
        scroller.current = node;
        setRef(containerRef, node);
      }}
      className={props.className}
      style={{ overflowY: "auto", overflowAnchor: "none", position: "relative", ...props.style }}
      tabIndex={-1}
      data-code-view=""
      onKeyDown={(event) => {
        if (!isFindShortcut(event)) return;
        event.preventDefault();
        controller.openSearch();
      }}
    >
      {search.open ? (
        <SearchWidget
          inputRef={(node) => controller.attachSearchInput(node)}
          query={search.query}
          total={search.matches.length}
          current={search.current}
          onQueryChange={(query) => controller.setQuery(query)}
          onNavigate={(direction) => controller.navigateSearch(direction)}
          onClose={() => {
            controller.closeSearch();
            scroller.current?.focus({ preventScroll: true });
          }}
        />
      ) : null}
      <div ref={root} data-code-view-items="">
        {snapshot.blocks.map((block) =>
          block.kind === "gap" ? (
            <div key={block.key} aria-hidden style={{ height: block.height }} />
          ) : (
            <DiffSection
              key={block.key}
              controller={controller}
              view={snapshot.props}
              entry={block.entry}
              index={block.index}
              start={block.start}
              end={block.end}
              before={block.before}
              after={block.after}
              entering={block.entering}
              range={block.range}
              tokensVersion={block.tokensVersion}
            />
          ),
        )}
      </div>
      {props.renderCodeViewFooter?.()}
      <div ref={probe} data-font-probe="" aria-hidden>
        {"0".repeat(PROBE_LENGTH)}
      </div>
    </div>
  );
}
