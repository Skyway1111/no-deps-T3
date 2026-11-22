// @effect-diagnostics globalTimers:off -- The child-process shutdown watchdog runs at a child callback boundary outside any Effect fiber.

import type { SnapShotModifier } from "@t3tools/contracts";
import { spawnKeyChordWatcher } from "@t3tools/shared/sys/win";

import { WINDOWS_MODIFIER_PAIR_VIRTUAL_KEYS } from "./snapShot.ts";

/** Polls the Windows modifier pair in a `t3-sys` helper; resolves to its stop once it runs. */
export function startGlobalShiftShortcutProcess(
  modifier: SnapShotModifier,
  onTrigger: () => void,
  onFailure: (error: Error) => void,
): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const watcher = spawnKeyChordWatcher(...WINDOWS_MODIFIER_PAIR_VIRTUAL_KEYS[modifier]);
    let settled = false;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      watcher.stdin.end();
      const forceKill = setTimeout(() => watcher.kill(), 1_000);
      forceKill.unref?.();
      watcher.once("exit", () => clearTimeout(forceKill));
    };
    const fail = (error: Error) => {
      if (stopped) return;
      stop();
      if (settled) return onFailure(error);
      settled = true;
      reject(error);
    };

    watcher.stdin.on("error", () => undefined);
    let pending = "";
    watcher.stdout.on("data", (chunk: Buffer) => {
      const lines = (pending + chunk.toString()).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "ready" && !settled) {
          settled = true;
          resolve(stop);
        } else if (line === "trigger" && settled && !stopped) {
          try {
            onTrigger();
          } catch {}
        }
      }
    });
    watcher.once("error", fail);
    watcher.once("exit", (code) => {
      fail(new Error(`Snapshot shortcut helper exited with code ${code}`));
    });
  });
}
