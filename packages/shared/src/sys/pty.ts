import * as NodeChildProcess from "node:child_process";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodeReadline from "node:readline";
import * as NodeStringDecoder from "node:string_decoder";

import { t3SysPath } from "./binary.ts";

/** Characters of output held for a first data listener; older output is dropped past this. */
const HELD_LIMIT = 1024 * 1024;

export interface PtyExit {
  readonly exitCode: number;
  readonly signal: number | null;
}

export interface PtyOptions {
  readonly cols: number;
  readonly rows: number;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface Pty {
  readonly pid: number;
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** Sends a POSIX signal (default SIGHUP); Windows terminates the process. */
  kill(signal?: string): void;
  onData(listener: (data: string) => void): () => void;
  onExit(listener: (event: PtyExit) => void): () => void;
}

/**
 * Spawns `file` on a new pseudo-terminal through `t3-sys pty`. Resolves once the program is
 * running, and rejects with the helper's reason when it cannot start. Up to `HELD_LIMIT` of the
 * latest output arriving before the first data listener is held for it, and exit fires only
 * after all output.
 */
export function spawnPty(
  file: string,
  args: ReadonlyArray<string>,
  options: PtyOptions,
): Promise<Pty> {
  const child = NodeChildProcess.spawn(
    t3SysPath(),
    [
      "pty",
      "--cols",
      String(options.cols),
      "--rows",
      String(options.rows),
      "--cwd",
      options.cwd,
      "--",
      file,
      ...args,
    ],
    { env: options.env, stdio: ["pipe", "pipe", "ignore", "pipe"], windowsHide: true },
  );
  const { stdin, stdout } = child;
  const control = child.stdio[3] as NodeNet.Socket;
  if (!stdin || !stdout) throw new Error("t3-sys pty stdio is unavailable.");
  const decoder = new NodeStringDecoder.StringDecoder("utf8");
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: PtyExit) => void>();
  let held: string[] = [];
  let heldLength = 0;
  let exit: PtyExit | undefined;
  let reportedExit: PtyExit | undefined;
  let outputEnded = false;
  let pid = 0;
  const started = Promise.withResolvers<Pty>();

  const emitData = (text: string) => {
    if (!text) return;
    if (dataListeners.size === 0) {
      held.push(text);
      heldLength += text.length;
      while (heldLength > HELD_LIMIT && held.length > 1) heldLength -= held.shift()!.length;
      if (heldLength > HELD_LIMIT) {
        held[0] = held[0]!.slice(-HELD_LIMIT);
        heldLength = HELD_LIMIT;
      }
    } else for (const listener of dataListeners) listener(text);
  };
  const finish = () => {
    if (exit || !reportedExit || !outputEnded) return;
    emitData(decoder.end());
    exit = reportedExit;
    for (const listener of exitListeners) listener(exit);
    exitListeners.clear();
  };
  stdin.on("error", () => undefined);
  control.on("error", () => undefined);
  stdout.on("data", (chunk: Buffer) => emitData(decoder.write(chunk)));
  stdout.on("end", () => {
    outputEnded = true;
    finish();
  });
  child.on("error", (error) => started.reject(error));
  child.on("exit", (code, signal) => {
    // A helper that dies without reporting still ends the terminal.
    reportedExit ??= {
      exitCode: code ?? 0,
      signal: signal ? NodeOS.constants.signals[signal] : null,
    };
    started.reject(new Error(`t3-sys pty exited before ${file} started (${signal ?? code}).`));
  });
  // "exit" can precede the last stdout data; "close" waits for the streams too.
  child.on("close", () => {
    outputEnded = true;
    finish();
  });
  NodeReadline.createInterface({ input: control }).on("line", (line) => {
    const message = JSON.parse(line) as {
      pid?: number;
      error?: string;
      exit?: number;
      signal?: number | null;
    };
    if (message.error !== undefined) started.reject(new Error(message.error));
    if (message.exit !== undefined) {
      reportedExit = { exitCode: message.exit, signal: message.signal ?? null };
      finish();
    }
    if (message.pid !== undefined) {
      pid = message.pid;
      started.resolve(pty);
    }
  });
  const send = (message: object) => {
    if (!exit && control.writable) control.write(`${JSON.stringify(message)}\n`);
  };

  const pty: Pty = {
    get pid() {
      return pid;
    },
    write: (data) => {
      if (!exit) stdin.write(data);
    },
    resize: (cols, rows) => send({ resize: [cols, rows] }),
    kill: (signal) => send({ kill: signal ?? "SIGHUP" }),
    onData: (listener) => {
      dataListeners.add(listener);
      if (held.length > 0) {
        const pending = held;
        held = [];
        heldLength = 0;
        for (const text of pending) listener(text);
      }
      return () => dataListeners.delete(listener);
    },
    onExit: (listener) => {
      if (exit) {
        listener(exit);
        return () => undefined;
      }
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
  };
  return started.promise;
}
