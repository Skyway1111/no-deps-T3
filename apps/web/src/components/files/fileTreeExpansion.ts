import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import type { FileTreeModel } from "~/ui-core/fileTreeModel";

export function areAllDirectoriesExpanded(
  model: FileTreeModel,
  directoryPaths: readonly string[],
): boolean {
  return (
    directoryPaths.length > 0 &&
    directoryPaths.every((path) => model.getItem(path)?.isExpanded() === true)
  );
}

/** Calls made while `run` is running rerun it once it returns, instead of nesting. */
export function coalesceReentrantCalls(run: () => void): () => void {
  let running = false;
  let calledAgain = false;
  return () => {
    if (running) {
      calledAgain = true;
      return;
    }
    running = true;
    try {
      do {
        calledAgain = false;
        run();
      } while (calledAgain);
    } finally {
      running = false;
    }
  };
}

const EXPANDED_DIRECTORIES_STORAGE_KEY = "t3code.fileTreeExpandedDirectories";
// Roots are kept most recent first and capped so worktrees that come and go do not grow storage.
const MAX_STORED_ROOTS = 20;
const StoredExpandedDirectories = Schema.Array(
  Schema.Struct({ root: Schema.String, paths: Schema.Array(Schema.String) }),
);

function readStoredExpandedDirectories() {
  try {
    return getLocalStorageItem(EXPANDED_DIRECTORIES_STORAGE_KEY, StoredExpandedDirectories) ?? [];
  } catch (error) {
    console.error(error);
    return [];
  }
}

export function readExpandedDirectories(root: string): readonly string[] {
  return readStoredExpandedDirectories().find((entry) => entry.root === root)?.paths ?? [];
}

export function writeExpandedDirectories(root: string, paths: readonly string[]): void {
  const others = readStoredExpandedDirectories().filter((entry) => entry.root !== root);
  const next = paths.length > 0 ? [{ root, paths }, ...others] : others;
  try {
    setLocalStorageItem(
      EXPANDED_DIRECTORIES_STORAGE_KEY,
      next.slice(0, MAX_STORED_ROOTS),
      StoredExpandedDirectories,
    );
  } catch (error) {
    console.error(error);
  }
}
