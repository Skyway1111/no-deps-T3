#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const REPO_ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const SERVER_BIN = NodePath.join(REPO_ROOT, "apps/server/dist/bin.mjs");
const DESKTOP_BIN = NodePath.join(REPO_ROOT, "native/t3-desktop/target/release/t3-desktop");
const STATE_DIR = process.env.NO_DEPS_T3_HOME || NodePath.join(NodeOS.homedir(), ".no-deps-t3");
const ICON_PATH = [
  NodePath.join(NodeOS.homedir(), ".local/share/icons/no-deps-t3.png"),
  NodePath.join(REPO_ROOT, "apps/web/public/icon-512x512.png"),
].find((p) => NodeFS.existsSync(p));

const args = process.argv.slice(2);
const browserMode = args.includes("--browser");
const devtools = args.includes("--devtools");
const isDeepLink = (a) => /^(t3code|https?):\/\//.test(a);
const deepLinks = args.filter(isDeepLink);
const extraCwd = args.find((a) => !a.startsWith("-") && !isDeepLink(a));

function findFreePort(preferred) {
  return new Promise((resolve, reject) => {
    const srv = NodeNet.createServer();
    srv.unref();
    srv.on("error", () => {
      const srv2 = NodeNet.createServer();
      srv2.unref();
      srv2.on("error", reject);
      srv2.listen(0, "127.0.0.1", () => {
        const addr = srv2.address();
        const port = typeof addr === "object" && addr ? addr.port : 3789;
        srv2.close(() => resolve(port));
      });
    });
    srv.listen(preferred, "127.0.0.1", () => {
      srv.close(() => resolve(preferred));
    });
  });
}

const port = Number(process.env.NO_DEPS_T3_PORT) || (await findFreePort(3789));
const serverArgs = [
  SERVER_BIN,
  "serve",
  "--mode",
  "desktop",
  "--host",
  "127.0.0.1",
  "--port",
  String(port),
  "--base-dir",
  STATE_DIR,
  ...(extraCwd ? [extraCwd] : []),
];

const server = NodeChildProcess.spawn(process.execPath, serverArgs, {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, T3CODE_HOME: STATE_DIR },
});

let pairingUrl = null;
let baseUrl = null;
let exited = false;
let resolveReady;
const readyPromise = new Promise((resolve) => {
  resolveReady = resolve;
});

const onChunk = (stream) => (buf) => {
  const text = buf.toString();
  if (process.env.NO_DEPS_T3_VERBOSE === "1") stream.write(text);
  const pairMatch = text.match(/Pairing URL:\s*(https?:\/\/\S+)/);
  if (pairMatch && !pairingUrl) {
    pairingUrl = pairMatch[1];
    resolveReady();
  }
  const listenMatch = text.match(/Listening on\s*(https?:\/\/\S+)/);
  if (listenMatch && !baseUrl) baseUrl = listenMatch[1];
};
server.stdout.on("data", onChunk(process.stdout));
server.stderr.on("data", onChunk(process.stderr));
server.on("exit", () => {
  exited = true;
  resolveReady();
});

const shutdown = () => {
  if (!exited) {
    try {
      server.kill("SIGTERM");
    } catch {}
  }
};
process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

const timeout = setTimeout(resolveReady, 20_000);
await readyPromise;
clearTimeout(timeout);

const launchUrl = pairingUrl || baseUrl;
if (!launchUrl) {
  shutdown();
  console.error("no-deps-T3 server failed to start within 20s.");
  process.exit(1);
}

if (browserMode || !NodeFS.existsSync(DESKTOP_BIN)) {
  console.log(`no-deps-T3 running at ${launchUrl}`);
  if (browserMode) {
    NodeChildProcess.spawn("xdg-open", [launchUrl], { stdio: "ignore", detached: true }).unref();
  }
  await new Promise((resolve) => server.on("exit", resolve));
  process.exit(0);
}

const desktopArgs = [
  "--url",
  launchUrl,
  "--title",
  "no-deps-T3",
  "--state-dir",
  STATE_DIR,
  ...(ICON_PATH ? ["--icon", ICON_PATH] : []),
  ...(devtools ? ["--devtools"] : []),
  ...deepLinks,
];

const desktop = NodeChildProcess.spawn(DESKTOP_BIN, desktopArgs, { stdio: "inherit" });
desktop.on("exit", (code) => {
  shutdown();
  setTimeout(() => process.exit(code ?? 0), 300).unref();
});
