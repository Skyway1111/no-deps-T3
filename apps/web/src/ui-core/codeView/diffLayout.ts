import { diffWordsWithSpace } from "@t3tools/shared/diff";
import {
  hydratePartialDiff,
  type DiffLineAnnotation,
  type FileDiffContentsLoader,
  type FileDiffMetadata,
  type Hunk,
  type SelectionSide,
} from "@t3tools/shared/diff/patch";

export type LineType = "context" | "change-addition" | "change-deletion";

export interface LineRef {
  readonly side: SelectionSide;
  /** Index into the side's line array. */
  readonly index: number;
  readonly lineNumber: number;
  readonly type: LineType;
  /** A context line's number on the other side. */
  readonly altLineNumber?: number;
  /** The changed line this one pairs with for word emphasis. */
  readonly partner?: number;
}

export type DiffRow =
  | {
      readonly kind: "line";
      readonly key: string;
      readonly left: LineRef | null;
      readonly right: LineRef | null;
    }
  | {
      readonly kind: "separator";
      readonly key: string;
      readonly hunkIndex: number;
      readonly hidden: number;
      readonly position: "leading" | "middle" | "trailing";
      readonly expandable: boolean;
    }
  | {
      readonly kind: "annotation";
      readonly key: string;
      readonly left: ReadonlyArray<DiffLineAnnotation<unknown>>;
      readonly right: ReadonlyArray<DiffLineAnnotation<unknown>>;
    };

export interface Region {
  readonly fromStart: number;
  readonly fromEnd: number;
}

export type Expansion = ReadonlyMap<number, Region>;

export const EXPANSION_LINE_COUNT = 100;
const COLLAPSED_CONTEXT_THRESHOLD = 1;

/** 0-based count of lines before a hunk side's first line. */
function sideStart(start: number, count: number) {
  return start - (count === 0 ? 0 : 1);
}

function gapRegion(size: number, isPartial: boolean, expansion: Expansion, index: number) {
  if (size <= 0 || isPartial) return { fromStart: 0, fromEnd: 0, hidden: Math.max(size, 0) };
  if (size <= COLLAPSED_CONTEXT_THRESHOLD) return { fromStart: size, fromEnd: 0, hidden: 0 };
  const region = expansion.get(index);
  const fromStart = Math.min(region?.fromStart ?? 0, size);
  const fromEnd = Math.min(region?.fromEnd ?? 0, size - fromStart);
  return { fromStart, fromEnd, hidden: size - fromStart - fromEnd };
}

function trailingSize(diff: FileDiffMetadata) {
  const last = diff.hunks.at(-1);
  if (!last || diff.isPartial) return 0;
  const additions =
    diff.additionLines.length -
    sideStart(last.additionStart, last.additionCount) -
    last.additionCount;
  const deletions =
    diff.deletionLines.length -
    sideStart(last.deletionStart, last.deletionCount) -
    last.deletionCount;
  return Math.max(0, Math.min(additions, deletions));
}

export function growRegion(
  region: Region | undefined,
  direction: "up" | "down" | "both",
  count: number,
): Region {
  return {
    fromStart: (region?.fromStart ?? 0) + (direction === "down" ? 0 : count),
    fromEnd: (region?.fromEnd ?? 0) + (direction === "up" ? 0 : count),
  };
}

export interface DiffLayoutInput {
  readonly diff: FileDiffMetadata;
  readonly split: boolean;
  readonly expansion: Expansion;
  readonly separators: "simple" | "line-info" | "line-info-basic";
  readonly annotations: ReadonlyArray<DiffLineAnnotation<unknown>>;
  readonly canLoad: boolean;
}

/** Rows a diff renders, in order: lines, hunk separators, and annotation rows below their lines. */
export function buildDiffRows({
  diff,
  split,
  expansion,
  separators,
  annotations,
  canLoad,
}: DiffLayoutInput): DiffRow[] {
  const rows: DiffRow[] = [];
  const byLine = new Map<string, DiffLineAnnotation<unknown>[]>();
  for (const annotation of annotations) {
    const key = `${annotation.side}:${annotation.lineNumber}`;
    const list = byLine.get(key);
    if (list) list.push(annotation);
    else byLine.set(key, [annotation]);
  }
  const annotationsOf = (line: LineRef | null): DiffLineAnnotation<unknown>[] => {
    if (!line) return [];
    const own = byLine.get(`${line.side}:${line.lineNumber}`) ?? [];
    if (line.type !== "context" || line.altLineNumber === undefined) return own;
    const other = byLine.get(
      `${line.side === "additions" ? "deletions" : "additions"}:${line.altLineNumber}`,
    );
    return other ? [...other, ...own] : own;
  };
  const leading = byLine.get("additions:0") ?? byLine.get("deletions:0");
  if (leading) rows.push({ kind: "annotation", key: "n:top", left: [], right: leading });

  const pushLine = (left: LineRef | null, right: LineRef | null) => {
    const key = `${left ? `${left.type === "context" ? "x" : "d"}${left.lineNumber}` : ""}:${right ? `${right.type === "context" ? "x" : "a"}${right.lineNumber}` : ""}`;
    rows.push({ kind: "line", key, left, right });
    if (annotations.length === 0) return;
    if (split) {
      const leftNotes = left ? (byLine.get(`deletions:${left.lineNumber}`) ?? []) : [];
      const rightNotes = right ? (byLine.get(`additions:${right.lineNumber}`) ?? []) : [];
      if (leftNotes.length + rightNotes.length > 0)
        rows.push({ kind: "annotation", key: `n${key}`, left: leftNotes, right: rightNotes });
    } else {
      const notes = annotationsOf(left ?? right);
      if (notes.length > 0)
        rows.push({ kind: "annotation", key: `n${key}`, left: [], right: notes });
    }
  };
  const context = (
    deletionIndex: number,
    additionIndex: number,
    deletionLine: number,
    additionLine: number,
  ) => {
    if (split) {
      pushLine(
        { side: "deletions", index: deletionIndex, lineNumber: deletionLine, type: "context" },
        { side: "additions", index: additionIndex, lineNumber: additionLine, type: "context" },
      );
    } else {
      pushLine(null, {
        side: "additions",
        index: additionIndex,
        lineNumber: additionLine,
        type: "context",
        altLineNumber: deletionLine,
      });
    }
  };
  const gapLines = (deletionStart: number, additionStart: number, from: number, to: number) => {
    for (let k = from; k < to; k++)
      context(deletionStart + k, additionStart + k, deletionStart + k + 1, additionStart + k + 1);
  };
  const separator = (
    hunkIndex: number,
    hidden: number,
    position: "leading" | "middle" | "trailing",
  ) => {
    if (hidden <= 0 || (separators === "simple" && position !== "middle")) return;
    rows.push({
      kind: "separator",
      key: `s${hunkIndex}`,
      hunkIndex,
      hidden,
      position,
      expandable: canLoad || !diff.isPartial,
    });
  };

  diff.hunks.forEach((hunk: Hunk, hunkIndex) => {
    const additionStart = sideStart(hunk.additionStart, hunk.additionCount);
    const deletionStart = sideStart(hunk.deletionStart, hunk.deletionCount);
    const size = hunk.collapsedBefore;
    const region = gapRegion(size, diff.isPartial, expansion, hunkIndex);
    if (!diff.isPartial) {
      gapLines(deletionStart - size, additionStart - size, 0, region.fromStart);
      separator(hunkIndex, region.hidden, hunkIndex === 0 ? "leading" : "middle");
      gapLines(deletionStart - size, additionStart - size, size - region.fromEnd, size);
    } else {
      separator(hunkIndex, region.hidden, hunkIndex === 0 ? "leading" : "middle");
    }
    let additionLine = additionStart + 1;
    let deletionLine = deletionStart + 1;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let k = 0; k < content.lines; k++)
          context(
            content.deletionLineIndex + k,
            content.additionLineIndex + k,
            deletionLine + k,
            additionLine + k,
          );
        additionLine += content.lines;
        deletionLine += content.lines;
        continue;
      }
      const deletion = (k: number): LineRef => ({
        side: "deletions",
        index: content.deletionLineIndex + k,
        lineNumber: deletionLine + k,
        type: "change-deletion",
        ...(k < content.additions ? { partner: content.additionLineIndex + k } : {}),
      });
      const addition = (k: number): LineRef => ({
        side: "additions",
        index: content.additionLineIndex + k,
        lineNumber: additionLine + k,
        type: "change-addition",
        ...(k < content.deletions ? { partner: content.deletionLineIndex + k } : {}),
      });
      if (split) {
        for (let k = 0; k < Math.max(content.deletions, content.additions); k++)
          pushLine(
            k < content.deletions ? deletion(k) : null,
            k < content.additions ? addition(k) : null,
          );
      } else {
        for (let k = 0; k < content.deletions; k++) pushLine(deletion(k), null);
        for (let k = 0; k < content.additions; k++) pushLine(null, addition(k));
      }
      additionLine += content.additions;
      deletionLine += content.deletions;
    }
  });
  const last = diff.hunks.at(-1);
  const size = trailingSize(diff);
  if (last && size > 0) {
    const region = gapRegion(size, false, expansion, diff.hunks.length);
    const fromStart = region.fromStart + region.fromEnd;
    gapLines(
      sideStart(last.deletionStart, last.deletionCount) + last.deletionCount,
      sideStart(last.additionStart, last.additionCount) + last.additionCount,
      0,
      fromStart,
    );
    separator(diff.hunks.length, size - fromStart, "trailing");
  }
  return rows;
}

/** The expansion that shows a one-based line, or null when it already has a row. */
export function revealRegion(
  diff: FileDiffMetadata,
  expansion: Expansion,
  lineNumber: number,
  side: SelectionSide,
) {
  if (diff.isPartial) return null;
  for (const [hunkIndex, hunk] of diff.hunks.entries()) {
    const start =
      (side === "additions"
        ? sideStart(hunk.additionStart, hunk.additionCount)
        : sideStart(hunk.deletionStart, hunk.deletionCount)) + 1;
    const end = start + (side === "additions" ? hunk.additionCount : hunk.deletionCount);
    if (lineNumber < start) {
      const region = gapRegion(hunk.collapsedBefore, false, expansion, hunkIndex);
      const gapStart = start - hunk.collapsedBefore;
      if (
        region.hidden === 0 ||
        lineNumber < gapStart + region.fromStart ||
        lineNumber >= start - region.fromEnd
      )
        return null;
      const fromStart = lineNumber - (gapStart + region.fromStart) + 1;
      const fromEnd = start - region.fromEnd - lineNumber;
      return fromStart <= fromEnd
        ? { hunkIndex, direction: "up" as const, count: fromStart + EXPANSION_LINE_COUNT }
        : { hunkIndex, direction: "down" as const, count: fromEnd + EXPANSION_LINE_COUNT };
    }
    if (lineNumber < end) return null;
  }
  const last = diff.hunks.at(-1);
  const size = trailingSize(diff);
  if (!last || size === 0) return null;
  const region = gapRegion(size, false, expansion, diff.hunks.length);
  const shown = region.fromStart + region.fromEnd;
  const trailingStart =
    (side === "additions"
      ? sideStart(last.additionStart, last.additionCount) + last.additionCount
      : sideStart(last.deletionStart, last.deletionCount) + last.deletionCount) + 1;
  if (lineNumber < trailingStart + shown || lineNumber >= trailingStart + size) return null;
  return {
    hunkIndex: diff.hunks.length,
    direction: "up" as const,
    count: lineNumber - (trailingStart + shown) + 1 + EXPANSION_LINE_COUNT,
  };
}

const hydrated = new Map<string, FileDiffMetadata>();
const loading = new Map<string, Promise<FileDiffMetadata>>();
const HYDRATED_CACHE_SIZE = 64;

/**
 * The whole-file version of a patch-only diff once loaded. Keyed by `cacheKey`, so a host that
 * re-parses an unchanged patch into a new object still expands against the loaded files.
 */
export function hydratedDiff(diff: FileDiffMetadata): FileDiffMetadata {
  if (!diff.isPartial || diff.cacheKey === undefined) return diff;
  return hydrated.get(diff.cacheKey) ?? diff;
}

export function loadHydratedDiff(
  diff: FileDiffMetadata,
  load: FileDiffContentsLoader,
): Promise<FileDiffMetadata> {
  const key = diff.cacheKey;
  const existing = key === undefined ? undefined : (hydrated.get(key) ?? loading.get(key));
  if (existing) return Promise.resolve(existing);
  const pending = load(diff).then((files) => {
    const result = hydratePartialDiff("merge", diff, files);
    if (key !== undefined) {
      if (hydrated.size >= HYDRATED_CACHE_SIZE) hydrated.delete(hydrated.keys().next().value!);
      hydrated.set(key, result);
    }
    return result;
  });
  if (key !== undefined) {
    loading.set(key, pending);
    void pending.finally(() => loading.delete(key)).catch(() => {});
  }
  return pending;
}

const MAX_EMPHASIS_LENGTH = 1_000;

/**
 * Changed-word ranges for a paired line, as flat `[start, end)` pairs. Ranges separated only by
 * whitespace merge; a line that changed entirely gets none.
 */
export function wordEmphasis(
  line: string,
  partner: string,
  isAddition: boolean,
): number[] | undefined {
  if (line.length > MAX_EMPHASIS_LENGTH || partner.length > MAX_EMPHASIS_LENGTH) return undefined;
  const changes = isAddition
    ? diffWordsWithSpace(partner, line)
    : diffWordsWithSpace(line, partner);
  const ranges: number[] = [];
  let offset = 0;
  let common = 0;
  for (const change of changes) {
    const mine = isAddition ? change.added : change.removed;
    const theirs = isAddition ? change.removed : change.added;
    if (theirs) continue;
    const end = offset + change.value.length;
    if (mine) {
      const previousEnd = ranges.at(-1);
      if (previousEnd !== undefined && line.slice(previousEnd, offset).trim() === "")
        ranges[ranges.length - 1] = end;
      else ranges.push(offset, end);
    } else common += change.value.length;
    offset = end;
  }
  return ranges.length === 0 || common === 0 ? undefined : ranges;
}
