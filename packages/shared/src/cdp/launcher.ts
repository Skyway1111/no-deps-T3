// Chromium binary discovery, headless launch argument construction, and process lifecycle.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { CdpTimeoutError } from "./protocol.ts";

const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;
const MAX_STDERR_BYTES = 64 * 1024;
const CLOSE_GRACE_MS = 3_000;

const ENV_EXECUTABLE_KEYS = [
  "T3CODE_CHROME_PATH",
  "CHROME_PATH",
  "CHROMIUM_PATH",
  "BROWSER_PATH",
] as const;

const LINUX_CANDIDATES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "brave-browser",
  "microsoft-edge",
  "microsoft-edge-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/opt/google/chrome/chrome",
  "/usr/bin/brave-browser",
  "/usr/bin/microsoft-edge",
];

const MACOS_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

const WINDOWS_SUBPATHS = [
  "Google\\Chrome\\Application\\chrome.exe",
  "Chromium\\Application\\chrome.exe",
  "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "Microsoft\\Edge\\Application\\msedge.exe",
];

const isExecutable = async (candidate: string): Promise<boolean> => {
  try {
    await NodeFSP.access(
      candidate,
      process.platform === "win32" ? NodeFS.constants.F_OK : NodeFS.constants.X_OK,
    );
    const stat = await NodeFSP.stat(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
};

const resolveOnPath = async (
  binary: string,
  pathEnv: string | undefined,
): Promise<string | null> => {
  if (!pathEnv) return null;
  for (const dir of pathEnv.split(NodePath.delimiter)) {
    if (!dir) continue;
    const full = NodePath.join(dir, binary);
    if (await isExecutable(full)) return full;
  }
  return null;
};

export async function discoverChromiumExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  for (const key of ENV_EXECUTABLE_KEYS) {
    const configured = env[key]?.trim();
    if (configured && (await isExecutable(configured))) return configured;
  }

  if (platform === "darwin") {
    for (const candidate of MACOS_CANDIDATES) {
      if (await isExecutable(candidate)) return candidate;
    }
    return null;
  }

  if (platform === "win32") {
    const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env["PROGRAMFILES(X86)"]].filter(
      (value): value is string => Boolean(value),
    );
    for (const root of roots) {
      for (const subpath of WINDOWS_SUBPATHS) {
        const candidate = NodePath.win32.join(root, subpath);
        if (await isExecutable(candidate)) return candidate;
      }
    }
    return null;
  }

  for (const candidate of LINUX_CANDIDATES) {
    if (candidate.includes("/")) {
      if (await isExecutable(candidate)) return candidate;
    } else {
      const resolved = await resolveOnPath(candidate, env.PATH);
      if (resolved) return resolved;
    }
  }
  return null;
}

export const DEFAULT_CHROMIUM_ARGS: ReadonlyArray<string> = [
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-breakpad",
  "--disable-client-side-phishing-detection",
  "--disable-component-extensions-with-background-pages",
  "--disable-default-apps",
  "--disable-dev-shm-usage",
  "--disable-extensions",
  "--disable-hang-monitor",
  "--disable-ipc-flooding-protection",
  "--disable-popup-blocking",
  "--disable-prompt-on-repost",
  "--disable-renderer-backgrounding",
  "--disable-sync",
  "--metrics-recording-only",
  "--mute-audio",
  "--no-default-browser-check",
  "--no-first-run",
  "--password-store=basic",
  "--use-mock-keychain",
];

export interface BuildChromiumArgsOptions {
  readonly userDataDir: string;
  readonly headless?: boolean;
  readonly chromiumSandbox?: boolean;
  readonly args?: ReadonlyArray<string>;
  readonly ignoreDefaultArgs?: boolean | ReadonlyArray<string>;
}

export function buildChromiumArgs(options: BuildChromiumArgsOptions): Array<string> {
  const ignored = Array.isArray(options.ignoreDefaultArgs)
    ? new Set(options.ignoreDefaultArgs)
    : undefined;
  const args: Array<string> = [];

  if (options.ignoreDefaultArgs !== true) {
    for (const flag of DEFAULT_CHROMIUM_ARGS) {
      if (!ignored?.has(flag)) args.push(flag);
    }
  }

  if (options.headless !== false && !ignored?.has("--headless")) {
    args.push("--headless");
  }
  if (options.chromiumSandbox === false) {
    args.push("--no-sandbox", "--disable-setuid-sandbox");
  }

  args.push("--remote-debugging-port=0", `--user-data-dir=${options.userDataDir}`);

  if (options.args) {
    for (const extra of options.args) args.push(extra);
  }
  return args;
}

const DEVTOOLS_URL_PATTERN = /DevTools listening on (wss?:\/\/\S+)/;

export function parseDevToolsUrl(output: string): string | null {
  const match = DEVTOOLS_URL_PATTERN.exec(output);
  return match?.[1] ?? null;
}

export interface LaunchChromiumOptions {
  readonly executablePath?: string;
  readonly userDataDir?: string;
  readonly headless?: boolean;
  readonly chromiumSandbox?: boolean;
  readonly args?: ReadonlyArray<string>;
  readonly ignoreDefaultArgs?: boolean | ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

export interface LaunchedChromium {
  readonly wsEndpoint: string;
  readonly pid: number | undefined;
  readonly userDataDir: string;
  readonly process: NodeChildProcess.ChildProcess;
  readonly close: () => Promise<void>;
}

export async function launchChromium(options: LaunchChromiumOptions = {}): Promise<LaunchedChromium> {
  const env = options.env ?? process.env;
  const executablePath = options.executablePath ?? (await discoverChromiumExecutable(env));
  if (!executablePath) {
    throw new Error(
      "Could not find a Chromium/Chrome executable. Configure executablePath or CHROME_PATH.",
    );
  }

  const ownsUserDataDir = options.userDataDir === undefined;
  const userDataDir =
    options.userDataDir ??
    (await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cdp-profile-")));
  const args = buildChromiumArgs({
    userDataDir,
    ...(options.headless === undefined ? {} : { headless: options.headless }),
    ...(options.chromiumSandbox === undefined ? {} : { chromiumSandbox: options.chromiumSandbox }),
    ...(options.args === undefined ? {} : { args: options.args }),
    ...(options.ignoreDefaultArgs === undefined
      ? {}
      : { ignoreDefaultArgs: options.ignoreDefaultArgs }),
  });

  const child = NodeChildProcess.spawn(executablePath, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const exitResolvers = Promise.withResolvers<void>();
  child.once("exit", (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
    exitResolvers.resolve();
  });

  const cleanupDir = async () => {
    if (ownsUserDataDir) {
      await NodeFSP.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      if (!exited) {
        try {
          child.kill("SIGTERM");
        } catch {
          // Process already exited.
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          exitResolvers.promise,
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              if (!exited) {
                try {
                  child.kill("SIGKILL");
                } catch {
                  // Ignore.
                }
              }
              resolve();
            }, CLOSE_GRACE_MS);
          }),
        ]).finally(() => clearTimeout(timer));
      }
      await cleanupDir();
    })();
    return closing;
  };

  const timeoutMs = options.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
  let stderr = "";

  try {
    const wsEndpoint = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new CdpTimeoutError(
            `Chromium did not report a DevTools URL within ${timeoutMs}ms.\n${stderr.trim()}`,
          ),
        );
      }, timeoutMs);

      const finish = (fn: () => void) => {
        clearTimeout(timer);
        child.stderr?.off("data", onData);
        child.off("error", onError);
        child.off("exit", onExit);
        fn();
      };

      const onData = (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (stderr.length < MAX_STDERR_BYTES) {
          stderr += text.slice(0, MAX_STDERR_BYTES - stderr.length);
        }
        const url = parseDevToolsUrl(stderr);
        if (url) finish(() => resolve(url));
      };

      const onError = (error: Error) => {
        finish(() => reject(error));
      };

      const onExit = () => {
        const detail = stderr.trim();
        const reason =
          exitSignal !== null
            ? `signal ${exitSignal}`
            : `exit code ${exitCode ?? "unknown"}`;
        finish(() =>
          reject(
            new Error(
              `Chromium exited before DevTools started (${reason})${detail ? `:\n${detail}` : "."}`,
            ),
          ),
        );
      };

      child.stderr?.on("data", onData);
      child.once("error", onError);
      child.once("exit", onExit);
    });

    return {
      wsEndpoint,
      pid: child.pid,
      userDataDir,
      process: child,
      close,
    };
  } catch (cause) {
    await close().catch(() => {});
    throw cause;
  }
}
