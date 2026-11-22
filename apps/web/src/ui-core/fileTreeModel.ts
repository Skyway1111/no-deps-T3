import { useState, useSyncExternalStore } from "react";

// Paths are canonical: directories end with "/", files do not, so `a` and `a/` can coexist.

export type GitStatus = "added" | "deleted" | "ignored" | "modified" | "renamed" | "untracked";

export interface GitStatusEntry {
  readonly path: string;
  readonly status: GitStatus;
}

export interface FileTreeSortEntry {
  readonly path: string;
  readonly basename: string;
  readonly depth: number;
  readonly isDirectory: boolean;
}

export type FileTreeSortComparator = (left: FileTreeSortEntry, right: FileTreeSortEntry) => number;

export interface FileTreeItemHandle {
  readonly path: string;
  isDirectory(): boolean;
  isExpanded(): boolean;
  expand(): void;
  collapse(): void;
  select(): void;
  deselect(): void;
}

/** One visible row; a flattened directory chain shows as one row for its deepest directory. */
export interface FileTreeRow {
  readonly path: string;
  readonly name: string;
  readonly kind: "directory" | "file";
  readonly depth: number;
  readonly expanded: boolean;
}

/** Everything a render reads, replaced rather than mutated whenever the model changes. */
export interface FileTreeSnapshot {
  readonly rows: readonly FileTreeRow[];
  readonly selected: ReadonlySet<string>;
  readonly focusedPath: string | null;
  readonly gitStatus: ReadonlyMap<string, GitStatus>;
  readonly ignoredDirectories: ReadonlySet<string>;
  readonly changedDirectories: ReadonlySet<string>;
}

const rowIndexes = new WeakMap<readonly FileTreeRow[], Map<string, number>>();

export function rowIndexOf(rows: readonly FileTreeRow[], path: string): number {
  let indexes = rowIndexes.get(rows);
  if (!indexes)
    rowIndexes.set(rows, (indexes = new Map(rows.map((row, index) => [row.path, index]))));
  return indexes.get(path) ?? -1;
}

export function gitStatusOf(snapshot: FileTreeSnapshot, path: string): GitStatus | null {
  const own = snapshot.gitStatus.get(path);
  if (own) return own;
  if (snapshot.ignoredDirectories.size === 0) return null;
  return ancestorDirectories(path).some((ancestor) => snapshot.ignoredDirectories.has(ancestor))
    ? "ignored"
    : null;
}

export interface FileTreeOptions {
  readonly flattenEmptyDirectories?: boolean;
  readonly initialExpansion?: "open" | "closed";
  readonly sort?: FileTreeSortComparator;
  readonly onSelectionChange?: (selectedPaths: readonly string[]) => void;
  readonly onSearchChange?: (value: string | null) => void;
}

export interface FileTreeScrollOptions {
  readonly focus?: boolean;
  readonly offset?: "center" | "nearest";
}

interface FileTreeView {
  scrollToIndex(index: number, offset: "center" | "nearest"): boolean;
}

class TreeNode implements FileTreeItemHandle {
  readonly model: FileTreeModel;
  readonly path: string;
  readonly parent: TreeNode | null;
  readonly basename: string;
  readonly depth: number;
  readonly isDir: boolean;
  readonly children: Set<TreeNode> | null;
  sorted: TreeNode[] | null = null;
  sortedVersion = 0;
  expanded = false;
  /** Listed by the caller rather than only implied by a descendant. */
  listed = false;
  #lowerPath: string | null = null;
  #sortKey: SortKey | null = null;

  constructor(model: FileTreeModel, path: string, parent: TreeNode | null) {
    this.model = model;
    this.path = path;
    this.parent = parent;
    this.isDir = path === "" || path.endsWith("/");
    const end = this.isDir ? path.length - 1 : path.length;
    this.basename = path.slice(path.lastIndexOf("/", end - 1) + 1, end);
    this.depth = parent === null ? -1 : parent.depth + 1;
    this.children = this.isDir ? new Set() : null;
  }

  get lowerPath() {
    return (this.#lowerPath ??= this.path.toLowerCase());
  }
  get sortKey() {
    return (this.#sortKey ??= sortKey(this.basename));
  }
  isDirectory(): boolean {
    return this.isDir;
  }
  isExpanded() {
    return this.isDir && this.expanded;
  }
  expand() {
    this.model.setExpanded([this.path], true);
  }
  collapse() {
    this.model.setExpanded([this.path], false);
  }
  select() {
    this.model.select(this.path);
  }
  deselect() {
    this.model.deselect(this.path);
  }
}

interface SortKey {
  readonly lower: string;
  readonly tokens: readonly (string | number)[] | null;
}

function sortKey(name: string): SortKey {
  const lower = name.toLowerCase();
  if (!/\d/.test(lower)) return { lower, tokens: null };
  return { lower, tokens: lower.split(/(\d+)/).map((part, i) => (i % 2 ? Number(part) : part)) };
}

function compareNatural(left: SortKey, right: SortKey): number {
  if (left.tokens !== null && right.tokens !== null) {
    const count = Math.min(left.tokens.length, right.tokens.length);
    for (let index = 0; index < count; index++) {
      const a = left.tokens[index]!;
      const b = right.tokens[index]!;
      if (a !== b) return a < b ? -1 : 1;
    }
  }
  return left.lower === right.lower ? 0 : left.lower < right.lower ? -1 : 1;
}

const defaultCompare = (left: TreeNode, right: TreeNode) =>
  Number(right.isDir) - Number(left.isDir) ||
  compareNatural(left.sortKey, right.sortKey) ||
  (left.basename < right.basename ? -1 : left.basename > right.basename ? 1 : 0);

const sortEntry = (node: TreeNode): FileTreeSortEntry => ({
  path: node.path,
  basename: node.basename,
  depth: node.depth,
  isDirectory: node.isDir,
});

const NO_PATHS: readonly string[] = [];

const soleChild = (directory: TreeNode) =>
  directory.children!.size === 1 ? directory.children!.values().next().value! : null;

export function ancestorDirectories(path: string): string[] {
  const ancestors: string[] = [];
  for (let slash = path.indexOf("/"); slash !== -1 && slash < path.length - 1;) {
    ancestors.push(path.slice(0, slash + 1));
    slash = path.indexOf("/", slash + 1);
  }
  return ancestors;
}

export class FileTreeModel {
  readonly #options: FileTreeOptions;
  readonly #listeners = new Set<() => void>();
  readonly #root: TreeNode;
  #nodes = new Map<string, TreeNode>();
  #listed = new Set<string>();
  #sortVersion = 0;
  #rows: FileTreeRow[] | null = [];
  #selected: string[] = [];
  #selectedSet = new Set<string>();
  #anchor: string | null = null;
  #focused: string | null = null;
  #search: string | null = null;
  #searchMatches: string[] | null = null;
  #searchVisible: Set<string> | null = null;
  #gitStatus = new Map<string, GitStatus>();
  #ignoredDirectories = new Set<string>();
  #changedDirectories = new Set<string>();
  #view: FileTreeView | null = null;
  #pendingScroll: { path: string; offset: "center" | "nearest" } | null = null;
  #pendingDomFocus: string | null = null;
  #snapshot: FileTreeSnapshot | null = null;

  constructor(options: FileTreeOptions = {}) {
    this.#options = options;
    this.#root = new TreeNode(this, "", null);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): FileTreeSnapshot =>
    (this.#snapshot ??= {
      rows: this.getRows(),
      selected: this.#selectedSet,
      focusedPath: this.#focused,
      gitStatus: this.#gitStatus,
      ignoredDirectories: this.#ignoredDirectories,
      changedDirectories: this.#changedDirectories,
    });

  #emit() {
    this.#snapshot = null;
    for (const listener of this.#listeners) listener();
  }

  #invalidateRows() {
    this.#rows = null;
  }

  #invalidateStructure() {
    this.#invalidateRows();
    this.#searchMatches = null;
    this.#searchVisible = null;
  }

  getItem(path: string): FileTreeItemHandle | null {
    return this.#nodes.get(path) ?? null;
  }

  #ensure(path: string): TreeNode {
    const existing = this.#nodes.get(path);
    if (existing) return existing;
    const end = path.endsWith("/") ? path.length - 1 : path.length;
    const slash = path.lastIndexOf("/", end - 1);
    const parent = slash === -1 ? this.#root : this.#ensure(path.slice(0, slash + 1));
    const node = new TreeNode(this, path, parent);
    if (node.isDir) node.expanded = this.#options.initialExpansion === "open";
    parent.children!.add(node);
    parent.sorted = null;
    this.#nodes.set(path, node);
    return node;
  }

  #remove(path: string) {
    const node = this.#nodes.get(path);
    if (!node) return;
    node.listed = false;
    // A folder still holding listed paths stays as their implied ancestor.
    for (let current: TreeNode | null = node; current?.parent; current = current.parent) {
      if (current.listed || current.children?.size) return;
      this.#nodes.delete(current.path);
      current.parent.children!.delete(current);
      current.parent.sorted = null;
    }
  }

  /**
   * Makes the tree exactly `paths` plus their ancestor folders. Selection, focus and expansion
   * survive for paths that remain, and only changed folders are re-sorted.
   */
  setPaths(paths: readonly string[]): boolean {
    const next = new Set(paths);
    let changed = false;
    for (const path of this.#listed) {
      if (next.has(path)) continue;
      this.#remove(path);
      changed = true;
    }
    for (const path of next) {
      if (this.#listed.has(path)) continue;
      this.#ensure(path).listed = true;
      changed = true;
    }
    this.#listed = next;
    if (!changed) return false;
    // A custom order can depend on every path, so it re-sorts everything.
    if (this.#options.sort) this.#sortVersion++;
    this.#invalidateStructure();
    if (this.#focused !== null && !this.#nodes.has(this.#focused)) this.#focused = null;
    if (this.#anchor !== null && !this.#nodes.has(this.#anchor)) this.#anchor = null;
    const kept = this.#selected.filter((path) => this.#nodes.has(path));
    if (kept.length !== this.#selected.length) this.#setSelection(kept, false);
    this.#emit();
    return true;
  }

  setExpanded(paths: Iterable<string>, expanded: boolean) {
    let changed = false;
    for (const path of paths) {
      const node = this.#nodes.get(path);
      if (!node?.isDir || node.expanded === expanded) continue;
      node.expanded = expanded;
      changed = true;
    }
    if (!changed) return;
    this.#invalidateRows();
    this.#emit();
  }

  #sortedChildren(directory: TreeNode): TreeNode[] {
    if (directory.sorted && directory.sortedVersion === this.#sortVersion) return directory.sorted;
    directory.sortedVersion = this.#sortVersion;
    const children = [...directory.children!];
    const sort = this.#options.sort;
    if (sort) {
      const entries = new Map(children.map((node) => [node, sortEntry(node)]));
      children.sort((left, right) => sort(entries.get(left)!, entries.get(right)!));
    } else children.sort(defaultCompare);
    return (directory.sorted = children);
  }

  getRows(): readonly FileTreeRow[] {
    if (this.#rows) return this.#rows;
    const rows: FileTreeRow[] = [];
    const visible = this.#getSearchVisible();
    const flatten = this.#options.flattenEmptyDirectories === true;
    const visit = (directory: TreeNode, depth: number) => {
      for (const child of this.#sortedChildren(directory)) {
        if (visible && !visible.has(child.path)) continue;
        if (!child.isDir) {
          rows.push({
            path: child.path,
            name: child.basename,
            kind: "file",
            depth,
            expanded: false,
          });
          continue;
        }
        let terminal = child;
        let name = child.basename;
        for (let only = flatten ? soleChild(terminal) : null; only; only = soleChild(terminal)) {
          if (!only.isDir || (visible && !visible.has(only.path))) break;
          terminal = only;
          name += ` / ${only.basename}`;
        }
        const expanded = visible !== null || terminal.expanded;
        rows.push({ path: terminal.path, name, kind: "directory", depth, expanded });
        if (expanded) visit(terminal, depth + 1);
      }
    };
    visit(this.#root, 0);
    this.#rows = rows;
    return rows;
  }

  getRowIndex(path: string): number {
    return rowIndexOf(this.getRows(), path);
  }

  /** Closest visible row at or above `path`, for rows hidden in a collapsed or flattened folder. */
  getParentRowPath(path: string): string | null {
    for (let node = this.#nodes.get(path)?.parent; node && node.path; node = node.parent) {
      if (this.getRowIndex(node.path) !== -1) return node.path;
    }
    return null;
  }

  isSelected(path: string) {
    return this.#selectedSet.has(path);
  }

  getSelectedPaths(): readonly string[] {
    return this.#selected;
  }

  #setSelection(paths: readonly string[], emit = true) {
    const next = [...new Set(paths)];
    if (next.length === this.#selected.length && next.every((path) => this.#selectedSet.has(path)))
      return;
    this.#selected = next;
    this.#selectedSet = new Set(next);
    this.#options.onSelectionChange?.(next);
    if (emit) this.#emit();
  }

  select(path: string) {
    if (!this.#nodes.has(path) || this.#selectedSet.has(path)) return;
    this.#anchor = path;
    this.#setSelection([...this.#selected, path]);
  }

  deselect(path: string) {
    if (this.#selectedSet.has(path)) this.#setSelection(this.#selected.filter((p) => p !== path));
  }

  selectOnly(path: string) {
    this.#anchor = path;
    this.#setSelection([path]);
  }

  toggleSelected(path: string) {
    this.#anchor = path;
    if (this.#selectedSet.has(path)) this.deselect(path);
    else this.#setSelection([...this.#selected, path]);
  }

  selectRange(path: string, additive: boolean) {
    const anchorIndex = this.#anchor === null ? -1 : this.getRowIndex(this.#anchor);
    const index = this.getRowIndex(path);
    if (index === -1) return;
    if (anchorIndex === -1) return this.selectOnly(path);
    const rows = this.getRows();
    const range = rows
      .slice(Math.min(anchorIndex, index), Math.max(anchorIndex, index) + 1)
      .map((row) => row.path);
    this.#setSelection(additive ? [...this.#selected, ...range] : range);
  }

  selectAllVisible() {
    this.#setSelection(this.getRows().map((row) => row.path));
  }

  getFocusedPath() {
    return this.#focused;
  }

  focusPath(path: string) {
    if (this.#focused === path || !this.#nodes.has(path)) return;
    this.#focused = path;
    this.#emit();
  }

  /** Scrolls now when the tree is mounted and measured, otherwise once it is. */
  scrollToPath(path: string, options: FileTreeScrollOptions = {}) {
    if (!this.#nodes.has(path)) return;
    const offset = options.offset ?? "nearest";
    if (options.focus) {
      this.#focused = path;
      this.#pendingDomFocus = path;
    }
    const index = this.getRowIndex(path);
    this.#pendingScroll =
      index !== -1 && this.#view?.scrollToIndex(index, offset) ? null : { path, offset };
    this.#emit();
  }

  /** Called by the mounted tree; returns the view's detach. */
  attachView(view: FileTreeView): () => void {
    this.#view = view;
    return () => {
      if (this.#view === view) this.#view = null;
    };
  }

  flushPendingScroll() {
    const pending = this.#pendingScroll;
    if (!pending || !this.#view) return;
    const index = this.getRowIndex(pending.path);
    if (index !== -1 && this.#view.scrollToIndex(index, pending.offset)) this.#pendingScroll = null;
  }

  takePendingDomFocus(isRendered: (path: string) => boolean): string | null {
    const path = this.#pendingDomFocus;
    if (path === null || !isRendered(path)) return null;
    this.#pendingDomFocus = null;
    return path;
  }

  isSearchOpen() {
    return this.#search !== null;
  }

  getSearchValue() {
    return this.#search ?? "";
  }

  #query() {
    return this.#search?.trim().replaceAll("\\", "/").toLowerCase() ?? "";
  }

  getSearchMatchingPaths(): readonly string[] {
    const query = this.#query();
    if (!query) return NO_PATHS;
    if (this.#searchMatches) return this.#searchMatches;
    const matches: string[] = [];
    for (const node of this.#nodes.values())
      if (node.lowerPath.includes(query)) matches.push(node.path);
    return (this.#searchMatches = matches);
  }

  #getSearchVisible(): Set<string> | null {
    if (!this.#query()) return null;
    if (this.#searchVisible) return this.#searchVisible;
    const visible = new Set<string>();
    for (const path of this.getSearchMatchingPaths()) {
      visible.add(path);
      for (const ancestor of ancestorDirectories(path)) visible.add(ancestor);
    }
    return (this.#searchVisible = visible);
  }

  setSearch(value: string | null) {
    if (value === null) return this.closeSearch();
    if (value === this.#search) return;
    this.#search = value;
    this.#invalidateStructure();
    this.#options.onSearchChange?.(value);
    this.#emit();
  }

  /** Closes search, reopening the folders around the selection so it stays in view. */
  closeSearch() {
    if (this.#search === null) return;
    this.#search = null;
    this.#invalidateStructure();
    for (const path of this.#selected) {
      for (const ancestor of ancestorDirectories(path)) {
        const node = this.#nodes.get(ancestor);
        if (node) node.expanded = true;
      }
    }
    this.#options.onSearchChange?.(null);
    this.#emit();
  }

  setGitStatus(entries: readonly GitStatusEntry[]) {
    this.#gitStatus = new Map(entries.map((entry) => [entry.path, entry.status]));
    this.#ignoredDirectories = new Set();
    this.#changedDirectories = new Set();
    for (const { path, status } of entries) {
      if (status === "ignored") {
        if (path.endsWith("/")) this.#ignoredDirectories.add(path);
      } else
        for (const ancestor of ancestorDirectories(path)) this.#changedDirectories.add(ancestor);
    }
    this.#emit();
  }
}

export function useFileTree(options: FileTreeOptions): FileTreeModel {
  return useState(() => new FileTreeModel(options))[0];
}

export function useFileTreeSelector<T>(
  model: FileTreeModel,
  selector: (model: FileTreeModel) => T,
): T {
  return useSyncExternalStore(model.subscribe, () => selector(model));
}

export function useFileTreeSearch(model: FileTreeModel) {
  const value = useSyncExternalStore(model.subscribe, () => model.getSearchValue());
  const matchingPaths = useSyncExternalStore(model.subscribe, () => model.getSearchMatchingPaths());
  return {
    value,
    matchingPaths,
    setValue: (next: string) => model.setSearch(next),
    close: () => model.closeSearch(),
  };
}
