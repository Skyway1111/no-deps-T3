import { fileIconColors } from "@t3tools/shared/file-icons";
import {
  type CSSProperties,
  type DragEvent,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { observeResize } from "~/lib/observeResize";
import { ensurePierreIconSprite, resolvePierreIconForEntry } from "~/pierre-icons";

import {
  gitStatusOf,
  rowIndexOf,
  type FileTreeModel,
  type FileTreeRow,
  type GitStatus,
} from "./fileTreeModel";
import "./fileTree.css";

const ITEM_HEIGHT = 24;
const OVERSCAN = 10;

export interface ContextMenuItem {
  readonly kind: "directory" | "file";
  readonly name: string;
  readonly path: string;
}

export interface ContextMenuOpenContext {
  readonly anchorElement: HTMLElement;
  /** The pointer for right-clicks, otherwise the row. */
  readonly anchorRect: DOMRect;
}

export type FileTreeRowDecoration =
  | { readonly icon: string; readonly label?: string }
  | { readonly text: string; readonly label?: string };

interface FileTreeProps extends Omit<HTMLAttributes<HTMLDivElement>, "aria-label"> {
  readonly model: FileTreeModel;
  readonly "aria-label": string;
  readonly dragRows?: boolean;
  readonly onOpenContextMenu?: (item: ContextMenuItem, context: ContextMenuOpenContext) => void;
  readonly renderRowDecoration?: (row: FileTreeRow) => FileTreeRowDecoration | null;
}

const GIT_STATUS_LABELS: Partial<Record<GitStatus, string>> = {
  added: "A",
  deleted: "D",
  modified: "M",
  renamed: "R",
  untracked: "U",
};

const iconColor = (token: string | undefined) => {
  const [light, dark] = fileIconColors(token);
  return { "--trees-icon-color": `light-dark(${light}, ${dark})` } as CSSProperties;
};

function SpriteIcon(props: { name: string; token?: string | undefined; size?: number }) {
  const size = props.size ?? 16;
  return (
    <svg
      aria-hidden="true"
      data-icon-name={props.name}
      data-icon-token={props.token}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={props.token === undefined ? undefined : iconColor(props.token)}
    >
      <use href={`#${props.name}`} />
    </svg>
  );
}

function RowLabel({ row }: { row: FileTreeRow }) {
  const dot = row.kind === "file" ? row.name.lastIndexOf(".") : -1;
  if (dot <= 0) return <span data-truncate-content="visible">{row.name}</span>;
  // The stem truncates first so the extension stays readable.
  return (
    <>
      <span data-truncate-content="visible">{row.name.slice(0, dot)}</span>
      <span>{row.name.slice(dot)}</span>
    </>
  );
}

function Decoration({ decoration }: { decoration: FileTreeRowDecoration }) {
  return (
    <span aria-label={decoration.label} role={decoration.label ? "img" : undefined}>
      {"icon" in decoration ? <SpriteIcon name={decoration.icon} /> : decoration.text}
    </span>
  );
}

export function FileTree({
  model,
  "aria-label": ariaLabel,
  dragRows = false,
  onOpenContextMenu,
  renderRowDecoration,
  ...hostProps
}: FileTreeProps) {
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const { rows, selected, focusedPath } = snapshot;
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ first: 0, height: 0 });
  const start = Math.max(0, viewport.first - OVERSCAN);
  const end = Math.min(
    rows.length,
    viewport.first + Math.ceil(viewport.height / ITEM_HEIGHT) + OVERSCAN + 1,
  );
  const tabStop =
    focusedPath !== null && rowIndexOf(rows, focusedPath) !== -1 ? focusedPath : rows[0]?.path;
  const gitLane = snapshot.gitStatus.size > 0;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks the scroller's size and scroll offset and registers it as the model's scroll target
  useLayoutEffect(() => {
    ensurePierreIconSprite();
    const scroller = scrollRef.current!;
    const sync = () => {
      const first = Math.floor(scroller.scrollTop / ITEM_HEIGHT);
      const height = scroller.clientHeight;
      setViewport((previous) =>
        previous.first === first && previous.height === height ? previous : { first, height },
      );
    };
    scroller.addEventListener("scroll", sync, { passive: true });
    const stopObserving = observeResize(scroller, () => {
      sync();
      model.flushPendingScroll();
    });
    const detach = model.attachView({
      scrollToIndex(index, offset) {
        const height = scroller.clientHeight;
        if (height === 0) return false;
        // The list may not have re-rendered since rows changed; size it now so the scroll isn't clamped.
        listRef.current!.style.height = `${model.getRows().length * ITEM_HEIGHT}px`;
        const rowTop = index * ITEM_HEIGHT;
        let top = scroller.scrollTop;
        if (offset === "center") top = rowTop - (height - ITEM_HEIGHT) / 2;
        else if (rowTop < top) top = rowTop;
        else if (rowTop + ITEM_HEIGHT > top + height) top = rowTop + ITEM_HEIGHT - height;
        scroller.scrollTop = Math.max(0, top);
        sync();
        return true;
      },
    });
    sync();
    return () => {
      scroller.removeEventListener("scroll", sync);
      stopObserving();
      detach();
    };
  }, [model]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies scroll and DOM focus the model requested before these rows were rendered
  useLayoutEffect(() => {
    model.flushPendingScroll();
    const findRow = (path: string) =>
      [...(windowRef.current?.children ?? [])].find(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && element.dataset.itemPath === path,
      );
    const path = model.takePendingDomFocus((candidate) => findRow(candidate) !== undefined);
    if (path !== null) findRow(path)!.focus({ preventScroll: true });
  });

  const rowFromEvent = (event: { target: EventTarget }) => {
    const element =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-type='item']")
        : null;
    const path = element?.dataset.itemPath;
    const row = path === undefined ? undefined : model.getRows()[model.getRowIndex(path)];
    return element && row ? { element, row } : null;
  };

  const openContextMenu = (row: FileTreeRow, element: HTMLElement, anchorRect: DOMRect) =>
    onOpenContextMenu?.(
      { kind: row.kind, name: row.name, path: row.path },
      { anchorElement: element, anchorRect },
    );

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const hit = rowFromEvent(event);
    if (!hit) return;
    const { row, element } = hit;
    const additive = event.ctrlKey || event.metaKey;
    if (event.shiftKey) model.selectRange(row.path, additive);
    else if (additive) model.toggleSelected(row.path);
    else model.selectOnly(row.path);
    model.focusPath(row.path);
    element.focus({ preventScroll: true });
    if (!event.shiftKey && !additive && row.kind === "directory") {
      model.setExpanded([row.path], !row.expanded);
    }
    if (model.isSearchOpen()) {
      model.closeSearch();
      model.scrollToPath(row.path);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const rows = model.getRows();
    if (rows.length === 0) return;
    const hit = rowFromEvent(event);
    const current = hit?.row.path ?? model.getFocusedPath();
    const index = current === null ? -1 : model.getRowIndex(current);
    const row = rows[index];
    const moveTo = (target: number) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, target))]!;
      model.scrollToPath(next.path, { focus: true });
      return next;
    };
    const modifier = event.ctrlKey || event.metaKey;
    if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
      if (!hit || !onOpenContextMenu) return;
      openContextMenu(hit.row, hit.element, hit.element.getBoundingClientRect());
    } else if (modifier && event.code === "Space") {
      if (!row) return;
      model.toggleSelected(row.path);
    } else if (modifier && event.key.toLowerCase() === "a") {
      model.selectAllVisible();
    } else {
      switch (event.key) {
        case "ArrowDown":
        case "ArrowUp": {
          const next = moveTo(index + (event.key === "ArrowDown" ? 1 : -1));
          if (event.shiftKey) model.selectRange(next.path, false);
          break;
        }
        case "ArrowRight":
          if (row?.kind === "directory" && !row.expanded) model.setExpanded([row.path], true);
          else moveTo(index + 1);
          break;
        case "ArrowLeft": {
          if (row?.kind === "directory" && row.expanded) {
            model.setExpanded([row.path], false);
            break;
          }
          const parent = row ? model.getParentRowPath(row.path) : null;
          if (parent !== null) moveTo(model.getRowIndex(parent));
          break;
        }
        case "Home":
          moveTo(0);
          break;
        case "End":
          moveTo(rows.length - 1);
          break;
        default:
          return;
      }
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const hit = onOpenContextMenu ? rowFromEvent(event) : null;
    if (!hit) return;
    event.preventDefault();
    openContextMenu(hit.row, hit.element, new DOMRect(event.clientX, event.clientY));
  };

  const onDragStart = (event: DragEvent<HTMLDivElement>) => {
    const hit = rowFromEvent(event);
    if (hit && !model.isSelected(hit.row.path)) model.selectOnly(hit.row.path);
  };

  // The tree can't scroll sideways, so a clipped row gets its full name as a native tooltip.
  const onPointerOver = (event: PointerEvent<HTMLDivElement>) => {
    const element = rowFromEvent(event)?.element;
    if (!element) return;
    const clipped = [...element.querySelectorAll<HTMLElement>("[data-truncate-content]")].some(
      (label) => label.scrollWidth > label.clientWidth,
    );
    if (clipped) element.title = element.getAttribute("aria-label") ?? "";
    else element.removeAttribute("title");
  };

  return (
    <div data-file-tree="" {...hostProps}>
      <div ref={scrollRef} data-file-tree-virtualized-scroll="">
        <div
          ref={listRef}
          role="tree"
          aria-label={ariaLabel}
          aria-multiselectable="true"
          style={{ height: rows.length * ITEM_HEIGHT }}
          onClick={onClick}
          onKeyDown={onKeyDown}
          onContextMenu={onContextMenu}
          onDragStart={onDragStart}
          onPointerOver={onPointerOver}
        >
          <div
            ref={windowRef}
            role="presentation"
            style={{ transform: `translateY(${start * ITEM_HEIGHT}px)` }}
          >
            {rows.slice(start, end).map((row) => {
              const isDirectory = row.kind === "directory";
              const isSelected = selected.has(row.path);
              const status = gitStatusOf(snapshot, row.path);
              const containsChange =
                isDirectory && status === null && snapshot.changedDirectories.has(row.path);
              const decoration = renderRowDecoration?.(row) ?? null;
              const label = status ? GIT_STATUS_LABELS[status] : undefined;
              const icon = isDirectory ? null : resolvePierreIconForEntry(row.path, "file");
              return (
                <button
                  key={row.path}
                  type="button"
                  role="treeitem"
                  data-type="item"
                  data-item-path={row.path}
                  data-item-type={isDirectory ? "folder" : "file"}
                  data-item-selected={isSelected || undefined}
                  data-item-git-status={status ?? undefined}
                  data-item-contains-git-change={containsChange || undefined}
                  aria-label={row.name}
                  aria-level={row.depth + 1}
                  aria-selected={isSelected}
                  aria-expanded={isDirectory ? row.expanded : undefined}
                  tabIndex={row.path === tabStop ? 0 : -1}
                  draggable={dragRows || undefined}
                >
                  {row.depth > 0 ? (
                    <span data-item-section="spacing">
                      {Array.from({ length: row.depth }, (_, depth) => (
                        <span key={depth} data-item-section="spacing-item" />
                      ))}
                    </span>
                  ) : null}
                  <span data-item-section="icon">
                    {icon ? (
                      <SpriteIcon name={icon.name} token={icon.token} />
                    ) : (
                      <SpriteIcon name="file-tree-icon-chevron" />
                    )}
                  </span>
                  <span data-item-section="content">
                    <RowLabel row={row} />
                  </span>
                  {decoration || gitLane ? (
                    <span data-item-section="decoration">
                      {decoration ? <Decoration decoration={decoration} /> : null}
                    </span>
                  ) : null}
                  {gitLane ? (
                    <span data-item-section="git">
                      {label ? (
                        <span>{label}</span>
                      ) : containsChange ? (
                        <SpriteIcon name="file-tree-icon-dot" size={6} />
                      ) : null}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
