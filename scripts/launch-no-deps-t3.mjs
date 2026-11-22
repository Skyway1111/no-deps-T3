#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_BIN = path.join(REPO_ROOT, "apps/server/dist/bin.mjs");
const DESKTOP_BIN = path.join(REPO_ROOT, "native/t3-desktop/target/release/t3-desktop");
const STATE_DIR = process.env.NO_DEPS_T3_HOME || path.join(os.homedir(), ".no-deps-t3");
const ICON_PATH = [
  path.join(os.homedir(), ".local/share/icons/no-deps-t3.png"),
  path.join(REPO_ROOT, "apps/web/public/icon-512x512.png"),
].find((p) => fs.existsSync(p));

const args = process.argv.slice(2);
const browserMode = args.includes("--browser");
const devtools = args.includes("--devtools");
const extraCwd = args.find((a) => !a.startsWith("-"));

function findFreePort(preferred) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", () => {
      const srv2 = net.createServer();
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

const server = spawn(process.execPath, serverArgs, {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, T3CODE_HOME: STATE_DIR },
});

let pairingUrl = null;
let baseUrl = null;
let exited = false;

const onChunk = (stream) => (buf) => {
  const text = buf.toString();
  if (process.env.NO_DEPS_T3_VERBOSE === "1") stream.write(text);
  const pairMatch = text.match(/Pairing URL:\s*(https?:\/\/\S+)/);
  if (pairMatch && !pairingUrl) pairingUrl = pairMatch[1];
  const listenMatch = text.match(/Listening on\s*(https?:\/\/\S+)/);
  if (listenMatch && !baseUrl) baseUrl = listenMatch[1];
};
server.stdout.on("data", onChunk(process.stdout));
server.stderr.on("data", onChunk(process.stderr));
server.on("exit", () => {
  exited = true;
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

const deadline = Date.now() + 20_000;
while (!pairingUrl && !exited && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 80));
}

const launchUrl = pairingUrl || baseUrl;
if (!launchUrl) {
  shutdown();
  console.error("no-deps-T3 server failed to start within 20s.");
  process.exit(1);
}

if (browserMode || !fs.existsSync(DESKTOP_BIN)) {
  console.log(`no-deps-T3 running at ${launchUrl}`);
  if (browserMode) {
    spawn("xdg-open", [launchUrl], { stdio: "ignore", detached: true }).unref();
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
];

const desktop = spawn(DESKTOP_BIN, desktopArgs, { stdio: "inherit" });
desktop.on("exit", (code) => {
  shutdown();
  setTimeout(() => process.exit(code ?? 0), 300).unref();
});
