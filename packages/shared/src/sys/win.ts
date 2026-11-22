import * as NodeChildProcess from "node:child_process";

import { runT3Sys, t3SysPath } from "./binary.ts";

export interface ForegroundWindow {
  readonly hwnd: bigint;
  readonly className: string;
  readonly pid: number;
  readonly tid: number;
  readonly title: string;
  readonly rect: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  } | null;
  /** The owning executable; empty when the process cannot be queried. */
  readonly imagePath: string;
}

async function win(args: ReadonlyArray<string>): Promise<string> {
  const { code, stdout, stderr } = await runT3Sys(["win", ...args]);
  if (code !== 0) throw new Error(stderr.trim() || `t3-sys win ${args[0]} failed (${code})`);
  return stdout;
}

/** The Windows foreground window; undefined when there is none. */
export async function foregroundWindow(): Promise<ForegroundWindow | undefined> {
  const window = JSON.parse(await win(["foreground"])) as
    | (Omit<ForegroundWindow, "hwnd"> & { readonly hwnd: string })
    | null;
  return window === null ? undefined : { ...window, hwnd: BigInt(window.hwnd) };
}

/** Moves the Windows foreground to `hwnd`; resolves whether Windows allowed it. */
export async function activateWindow(hwnd: bigint): Promise<boolean> {
  return (JSON.parse(await win(["activate", `0x${hwnd.toString(16)}`])) as { activated: boolean })
    .activated;
}

/**
 * A helper that polls two virtual keys, printing `ready` once and then `trigger` each time both
 * go down together. Ending its stdin stops it.
 */
export function spawnKeyChordWatcher(first: number, second: number) {
  return NodeChildProcess.spawn(t3SysPath(), ["win", "watch-keys", String(first), String(second)], {
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
}
