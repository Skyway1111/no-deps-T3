import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

import { t3SysPath } from "./binary.ts";

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export interface FileItem {
  readonly relativePath: string;
  readonly fileName: string;
  readonly size: number;
  /** Seconds since the epoch. */
  readonly modified: number;
}
export interface DirItem {
  readonly relativePath: string;
  readonly dirName: string;
}
export type MixedItem =
  | { readonly type: "file"; readonly item: FileItem }
  | { readonly type: "directory"; readonly item: DirItem };

interface Page<I> {
  readonly items: ReadonlyArray<I>;
  readonly scores: ReadonlyArray<number>;
  readonly totalMatched: number;
  readonly totalFiles: number;
  readonly totalDirs: number;
}
export type FileSearchResult = Page<FileItem>;
export type DirectorySearchResult = Page<DirItem>;
export type MixedSearchResult = Page<MixedItem>;

export interface SearchOptions {
  /** An offset into the ranked results. */
  readonly pageIndex?: number;
  readonly pageSize?: number;
}

export interface ScanProgress {
  readonly isScanning: boolean;
  readonly isWarmupComplete: boolean;
  readonly scannedFilesCount: number;
}

export interface GrepCursor {
  readonly file: number;
}
export interface GrepOptions {
  readonly mode?: "plain" | "regex";
  /** Plain mode only: case-insensitive unless the query has an uppercase letter. */
  readonly smartCase?: boolean;
  readonly maxMatchesPerFile?: number;
  readonly pageSize?: number;
  readonly cursor?: GrepCursor | null;
  readonly timeBudgetMs?: number;
}
export interface GrepMatch {
  readonly relativePath: string;
  readonly lineNumber: number;
  /** At most 512 bytes; ranges past that are left out. */
  readonly lineContent: string;
  /** UTF-8 byte offsets into `lineContent`. */
  readonly matchRanges: ReadonlyArray<readonly [number, number]>;
}
export interface GrepResult {
  readonly items: ReadonlyArray<GrepMatch>;
  readonly nextCursor: GrepCursor | null;
  readonly totalFilesSearched: number;
  readonly totalFiles: number;
  /** Set when a regex did not parse and was searched as a literal instead. */
  readonly regexFallbackError?: string;
}

export interface WatchEvent {
  readonly kind: "created" | "modified" | "removed";
  /** Absolute path. */
  readonly path: string;
}
export type WatchUnsubscribe = () => void;

export interface FileFinderOptions {
  readonly basePath: string;
}

/**
 * A workspace path index served by a `t3-sys fuzzy serve` process: a `.gitignore`-aware walk,
 * fzy-ranked path search with glob, `!exclude`, `/prefix` and `folder/` words, live grep, and
 * a native watcher that rescans on change. Searches answer from the last finished scan.
 */
export class FileFinder {
  private readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, (result: Result<unknown>) => void>();
  private readonly watchers = new Set<(events: ReadonlyArray<WatchEvent>) => void>();
  private nextId = 1;
  private failure: string | undefined;

  private constructor(basePath: string) {
    this.child = NodeChildProcess.spawn(t3SysPath(), ["fuzzy", "serve", basePath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdin.on("error", () => undefined);
    this.child.stderr.resume();
    const fail = (error: string) => {
      this.failure ??= error;
      for (const resolve of this.pending.values()) resolve({ ok: false, error });
      this.pending.clear();
    };
    this.child.on("error", (error) => fail(error.message));
    this.child.on("exit", (code, signal) =>
      fail(`The search index process exited (${signal ?? code}).`),
    );
    NodeReadline.createInterface({ input: this.child.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as {
        id?: number;
        ok?: boolean;
        value?: unknown;
        error?: string;
        event?: string;
        events?: WatchEvent[];
      };
      if (message.event === "watch" && message.events) {
        for (const watcher of this.watchers) watcher(message.events);
      } else if (message.event === "error") {
        fail(message.error ?? "The search index failed.");
      } else if (message.id !== undefined) {
        const resolve = this.pending.get(message.id);
        this.pending.delete(message.id);
        resolve?.(
          message.ok
            ? { ok: true, value: message.value }
            : { ok: false, error: message.error ?? "Search failed." },
        );
      }
    });
  }

  static create(options: FileFinderOptions): Result<FileFinder> {
    try {
      return { ok: true, value: new FileFinder(options.basePath) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private request<T>(method: string, params: object = {}): Promise<Result<T>> {
    if (this.failure) return Promise.resolve({ ok: false, error: this.failure });
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve as (result: Result<unknown>) => void);
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  /** Resolves `false` when the scan outlasts `timeoutMs`. */
  waitForIndexReady(timeoutMs: number): Promise<Result<boolean>> {
    return this.request("waitForIndexReady", { timeoutMs });
  }
  getScanProgressAsync(): Promise<Result<ScanProgress>> {
    return this.request("scanProgress");
  }
  /** Starts a rescan; searches keep answering from the previous index until it finishes. */
  scanFilesAsync(): Promise<Result<null>> {
    return this.request("scanFiles");
  }
  fileSearchAsync(query: string, options: SearchOptions = {}): Promise<Result<FileSearchResult>> {
    return this.request("fileSearch", { query, ...options });
  }
  directorySearchAsync(
    query: string,
    options: SearchOptions = {},
  ): Promise<Result<DirectorySearchResult>> {
    return this.request("directorySearch", { query, ...options });
  }
  mixedSearchAsync(query: string, options: SearchOptions = {}): Promise<Result<MixedSearchResult>> {
    return this.request("mixedSearch", { query, ...options });
  }
  /** Every indexed folder, in path order. */
  listDirsAsync(): Promise<Result<ReadonlyArray<string>>> {
    return this.request("listDirs");
  }
  grepAsync(query: string, options: GrepOptions = {}): Promise<Result<GrepResult>> {
    return this.request("grep", { query, ...options });
  }

  /** Subscribes to changes found by rescans; fails where the platform watcher is unavailable. */
  async watchAsync(
    onEvents: (events: ReadonlyArray<WatchEvent>) => void,
  ): Promise<Result<WatchUnsubscribe>> {
    const started = await this.request<boolean>("watch");
    if (!started.ok) return started;
    if (!started.value) return { ok: false, error: "File watching is unavailable here." };
    this.watchers.add(onEvents);
    return {
      ok: true,
      value: () => {
        this.watchers.delete(onEvents);
        if (this.watchers.size === 0) void this.request("unwatch");
      },
    };
  }

  destroy(): void {
    this.failure ??= "The search index was destroyed.";
    this.watchers.clear();
    this.child.stdin.end();
    this.child.kill();
  }
}
