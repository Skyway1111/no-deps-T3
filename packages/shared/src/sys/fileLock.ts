import * as NodeChildProcess from "node:child_process";

import { t3SysPath } from "./binary.ts";

class FileLockedError extends Error {
  readonly code = "ELOCKED";
  readonly path: string;
  constructor(path: string) {
    super(`${path} is locked by another process.`);
    this.path = path;
  }
}

export interface LockOptions {
  /** How long to wait for another holder to let go; 0 fails at once. Defaults to forever. */
  readonly waitMs?: number;
  /** Called when the lock is lost before release, which only happens if its helper dies. */
  readonly onCompromised?: (error: Error) => void;
  readonly signal?: AbortSignal;
}

/**
 * Takes an exclusive OS advisory lock (`flock` / `LockFileEx`) on `${path}.flock`, held by a
 * `t3-sys flock` child that the kernel unlocks if this process dies. Resolves to its release.
 */
export function lockFile(path: string, options: LockOptions = {}): Promise<() => Promise<void>> {
  const lockPath = `${path}.flock`;
  const waitMs = options.waitMs ?? 2 ** 31;
  const child = NodeChildProcess.spawn(
    t3SysPath(),
    ["flock", lockPath, "--wait-ms", String(waitMs)],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let stderr = "";
  let stdout = "";
  let state: "waiting" | "held" | "released" = "waiting";
  const abort = () => child.kill();
  options.signal?.addEventListener("abort", abort, { once: true });
  child.stdin.on("error", () => undefined);
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
      if (state !== "waiting" || !stdout.includes("\n")) return;
      if (!stdout.startsWith("locked")) return;
      state = "held";
      options.signal?.removeEventListener("abort", abort);
      resolve(async () => {
        if (state !== "held") return;
        state = "released";
        child.stdin.end();
        await exited;
      });
    });
    child.once("exit", (code) => {
      options.signal?.removeEventListener("abort", abort);
      if (state === "held") {
        state = "released";
        options.onCompromised?.(new Error(`The lock helper for ${lockPath} exited (${code}).`));
      } else if (state === "waiting") {
        reject(
          code === 3
            ? new FileLockedError(path)
            : (options.signal?.reason ??
                new Error(stderr.trim() || `Could not lock ${lockPath} (${code}).`)),
        );
      }
    });
  });
}
