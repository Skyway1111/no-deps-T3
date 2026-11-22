import { useGT } from "@t3tools/shared/i18n/react";
import type { Ref } from "react";

import { ArrowDownIcon, ArrowUpIcon, XIcon } from "../icons";

const owners = new Map<object, { readonly matches: Range[]; readonly current: Range[] }>();

function publish(name: string, ranges: Range[]) {
  if (ranges.length > 0) CSS.highlights.set(name, new Highlight(...ranges));
  else CSS.highlights.delete(name);
}

/** Find matches share two document-wide highlights, so every view adds its own ranges to them. */
export function setSearchHighlights(owner: object, matches: Range[], current: Range[]) {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  const previous = owners.get(owner);
  if (matches.length === 0 && current.length === 0) {
    if (!previous) return;
    owners.delete(owner);
  } else owners.set(owner, { matches, current });
  const all = [...owners.values()];
  publish(
    "diffs-search-match",
    all.flatMap((entry) => entry.matches),
  );
  publish(
    "diffs-search-current",
    all.flatMap((entry) => entry.current),
  );
}

/** Start offsets of case-insensitive occurrences of `query`. */
export function findAll(text: string, query: string): number[] {
  if (query === "") return [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const found: number[] = [];
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + needle.length)
  )
    found.push(at);
  return found;
}

/** A DOM range over `[start, end)` of a row's text. */
export function textRange(row: Element, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.nodeValue?.length ?? 0;
    if (!started && start <= offset + length) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= offset + length) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset += length;
  }
  return null;
}

export function SearchWidget({
  inputRef,
  ...props
}: {
  readonly query: string;
  readonly total: number;
  readonly current: number;
  readonly inputRef?: Ref<HTMLInputElement>;
  readonly onQueryChange: (query: string) => void;
  readonly onNavigate: (direction: 1 | -1) => void;
  readonly onClose: () => void;
  readonly replace?: {
    readonly value: string;
    readonly onChange: (value: string) => void;
    readonly onReplace: () => void;
    readonly onReplaceAll: () => void;
  };
}) {
  const gt = useGT();
  return (
    <div data-search-panel="">
      <div data-editor-widget="" role="search">
        <div data-search-row="">
          <input
            ref={inputRef}
            type="text"
            data-search-input=""
            aria-label={gt("Find")}
            placeholder={gt("Find")}
            value={props.query}
            spellCheck={false}
            onChange={(event) => props.onQueryChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                props.onNavigate(event.shiftKey ? -1 : 1);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                props.onClose();
              }
            }}
          />
          <span data-search-count="" aria-live="polite">
            {props.query === ""
              ? null
              : props.total === 0
                ? gt("No results")
                : gt("{current} of {total}", { current: props.current + 1, total: props.total })}
          </span>
          <button
            type="button"
            aria-label={gt("Previous match")}
            disabled={props.total === 0}
            onClick={() => props.onNavigate(-1)}
          >
            <ArrowUpIcon size={14} />
          </button>
          <button
            type="button"
            aria-label={gt("Next match")}
            disabled={props.total === 0}
            onClick={() => props.onNavigate(1)}
          >
            <ArrowDownIcon size={14} />
          </button>
          <button type="button" aria-label={gt("Close search")} onClick={props.onClose}>
            <XIcon size={14} />
          </button>
        </div>
        {props.replace ? (
          <div data-search-row="">
            <input
              type="text"
              data-search-input=""
              aria-label={gt("Replace")}
              placeholder={gt("Replace")}
              value={props.replace.value}
              spellCheck={false}
              onChange={(event) => props.replace?.onChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  props.replace?.onReplace();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  props.onClose();
                }
              }}
            />
            <button type="button" disabled={props.total === 0} onClick={props.replace.onReplace}>
              {gt("Replace")}
            </button>
            <button type="button" disabled={props.total === 0} onClick={props.replace.onReplaceAll}>
              {gt("Replace all")}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Mod+F, the key every code view opens its find widget with. */
export function isFindShortcut(event: KeyboardEvent | React.KeyboardEvent) {
  return (
    event.key.toLowerCase() === "f" &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}
