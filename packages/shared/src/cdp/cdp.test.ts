// Zero-dependency Node v22 tests for packages/shared/src/cdp using a local RFC 6455 mock CDP server.

import * as assert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, it } from "node:test";

import {
  buildChromiumArgs,
  CdpProtocolError,
  CdpTransport,
  connectOverCdp,
  discoverChromiumExecutable,
  fitsCdpPayloadBudget,
  isCdpCommand,
  parseDevToolsUrl,
  type CdpCommand,
  type CdpDialog,
  type CdpDownload,
  type CdpFileChooser,
  type CdpScreencastFrameEvent,
} from "./index.ts";

// Minimal RFC 6455 WebSocket server over node:http for testing CdpTransport & high-level flows.
interface MockWsClient {
  send(message: Record<string, unknown>): void;
  close(): void;
}

class MockCdpServer {
  private readonly server: NodeHttp.Server;
  private readonly sockets = new Set<NodeNet.Socket>();
  private readonly handler: (cmd: CdpCommand, client: MockWsClient) => void | Promise<void>;
  readonly received: Array<CdpCommand> = [];
  port = 0;

  constructor(handler: (cmd: CdpCommand, client: MockWsClient) => void | Promise<void>) {
    this.handler = handler;
    this.server = NodeHttp.createServer((req, res) => {
      if (req.url === "/json/version") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            Browser: "HeadlessChrome/158.0.0.0",
            webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/devtools/browser/mock`,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    this.server.on("upgrade", (req, socket) => {
      const key = req.headers["sec-websocket-key"];
      if (typeof key !== "string") {
        socket.destroy();
        return;
      }
      const accept = NodeCrypto.createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));

      const client: MockWsClient = {
        send: (msg) => {
          if (socket.destroyed) return;
          socket.write(encodeWsTextFrame(JSON.stringify(msg)));
        },
        close: () => {
          if (!socket.destroyed) socket.end(Buffer.from([0x88, 0x00]));
        },
      };

      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const parsed = decodeWsFrame(buffer);
          if (!parsed) break;
          buffer = buffer.subarray(parsed.consumed);
          if (parsed.opcode === 0x8) {
            socket.end(Buffer.from([0x88, 0x00]));
            return;
          }
          if (parsed.opcode === 0x9) {
            // Pong
            socket.write(Buffer.from([0x8a, 0x00]));
            continue;
          }
          if (parsed.opcode === 0x1) {
            const raw = JSON.parse(parsed.payload.toString("utf8")) as unknown;
            if (isCdpCommand(raw)) {
              this.received.push(raw);
              void this.handler(raw, client);
            }
          }
        }
      });
    });
  }

  async start(): Promise<{ wsUrl: string; httpUrl: string }> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = this.server.address();
    if (!addr || typeof addr === "string") throw new Error("Failed to bind mock CDP server");
    this.port = addr.port;
    return {
      wsUrl: `ws://127.0.0.1:${this.port}/devtools/browser/mock`,
      httpUrl: `http://127.0.0.1:${this.port}`,
    };
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function encodeWsTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  if (payload.length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

function decodeWsFrame(
  buf: Buffer,
): { readonly opcode: number; readonly payload: Buffer; readonly consumed: number } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  let length = buf[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buf.length < 4) return null;
    length = buf.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buf.length < 10) return null;
    length = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + length) return null;
  const payload = Buffer.alloc(length);
  if (masked) {
    const mask = buf.subarray(offset, offset + 4);
    const data = buf.subarray(offset + 4, offset + 4 + length);
    for (let i = 0; i < length; i += 1) {
      payload[i] = data[i]! ^ mask[i % 4]!;
    }
  } else {
    buf.copy(payload, 0, offset, offset + length);
  }
  return { opcode, payload, consumed: offset + maskLen + length };
}

describe("CDP protocol helpers", () => {
  it("validates commands and payload budgets", () => {
    assert.equal(isCdpCommand({ id: 1, method: "Page.enable" }), true);
    assert.equal(isCdpCommand({ method: "Page.loadEventFired" }), false);
    assert.equal(fitsCdpPayloadBudget({ ok: "hello" }, 1024), true);
    assert.equal(fitsCdpPayloadBudget({ big: "a".repeat(2000) }, 1024), false);
  });
});

describe("CDP launcher", () => {
  it("constructs headless Chromium args with sandbox control and ignoreDefaultArgs", () => {
    const args = buildChromiumArgs({
      userDataDir: "/tmp/profile-1",
      headless: true,
      chromiumSandbox: true,
      args: ["--disable-gpu", "--force-device-scale-factor=2"],
      ignoreDefaultArgs: ["--mute-audio"],
    });
    assert.ok(args.includes("--headless"));
    assert.ok(args.includes("--remote-debugging-port=0"));
    assert.ok(args.includes("--user-data-dir=/tmp/profile-1"));
    assert.ok(args.includes("--disable-gpu"));
    assert.ok(!args.includes("--mute-audio"));
    assert.ok(!args.includes("--no-sandbox"));

    const unsandboxed = buildChromiumArgs({
      userDataDir: "/tmp/profile-2",
      chromiumSandbox: false,
    });
    assert.ok(unsandboxed.includes("--no-sandbox"));
  });

  it("parses DevTools WebSocket URLs from stderr", () => {
    const sample =
      "[1234:1234] INFO: Starting\nDevTools listening on ws://127.0.0.1:41235/devtools/browser/abc-123\n";
    assert.equal(parseDevToolsUrl(sample), "ws://127.0.0.1:41235/devtools/browser/abc-123");
    assert.equal(parseDevToolsUrl("No usable sandbox!"), null);
  });

  it("discovers configured executable via env var", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cdp-bin-"));
    const fakeBin = NodePath.join(dir, "fake-chrome");
    try {
      await NodeFSP.writeFile(fakeBin, "#!/bin/sh\n", { mode: 0o755 });
      const found = await discoverChromiumExecutable({ T3CODE_CHROME_PATH: fakeBin });
      assert.equal(found, fakeBin);
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("CDP transport multiplexing & session routing", () => {
  it("multiplexes out-of-order responses, routes flat sessions, and discovers /json/version", async () => {
    const deferred: Array<() => void> = [];
    const server = new MockCdpServer((cmd, client) => {
      const route = cmd.sessionId ? { sessionId: cmd.sessionId } : {};
      if (cmd.method === "Slow.call") {
        deferred.push(() => client.send({ id: cmd.id, result: { ok: "slow" }, ...route }));
        return;
      }
      if (cmd.method === "Fast.call") {
        client.send({ id: cmd.id, result: { ok: "fast" }, ...route });
        for (const fn of deferred.splice(0)) fn();
        return;
      }
      if (cmd.method === "Fail.call") {
        client.send({ id: cmd.id, error: { code: -32000, message: "boom" }, ...route });
        return;
      }
      if (cmd.method === "Emit.events") {
        client.send({ id: cmd.id, result: {}, ...route });
        client.send({ method: "Custom.event", params: { target: "A" }, sessionId: "sess-A" });
        client.send({ method: "Custom.event", params: { target: "B" }, sessionId: "sess-B" });
        client.send({ method: "Target.detachedFromTarget", params: { sessionId: "sess-B" } });
        return;
      }
      client.send({ id: cmd.id, result: {}, ...route });
    });

    const { httpUrl } = await server.start();
    const transport = await CdpTransport.connect(httpUrl);
    try {
      const sessionA = transport.createSession("sess-A");
      const sessionB = transport.createSession("sess-B");

      const slow = sessionA.send("Slow.call");
      const fast = sessionB.send("Fast.call");
      assert.deepEqual(await fast, { ok: "fast" });
      assert.deepEqual(await slow, { ok: "slow" });

      await assert.rejects(sessionA.send("Fail.call"), (err: unknown) => {
        assert.ok(err instanceof CdpProtocolError);
        assert.equal(err.code, -32000);
        assert.equal(err.method, "Fail.call");
        return true;
      });

      const eventsA: Array<unknown> = [];
      const eventsB: Array<unknown> = [];
      let closedB = false;
      sessionA.on("Custom.event", (p) => eventsA.push(p));
      sessionB.on("Custom.event", (p) => eventsB.push(p));
      sessionB.on("close", () => {
        closedB = true;
      });

      await transport.root.send("Emit.events");
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(eventsA, [{ target: "A" }]);
      assert.deepEqual(eventsB, [{ target: "B" }]);
      assert.equal(closedB, true);
      assert.equal(sessionB.isClosed(), true);
    } finally {
      await transport.close();
      await server.stop();
    }
  });
});

describe("CDP page flows: accessibility + aria-ref, input, dialog, file chooser, screencast, download", () => {
  it("drives end-to-end CDP flows over a mock CdpRelay-compatible server", async () => {
    let clientRef: MockWsClient | null = null;
    let extraSeq = 0;
    let downloadPath = "";
    const resolvedNodes: Array<{ sessionId?: string; backendNodeId: number }> = [];
    const uploadedFiles: Array<ReadonlyArray<string>> = [];
    const dialogActions: Array<Record<string, unknown>> = [];
    const keyEvents: Array<Record<string, unknown>> = [];
    const screencastAcks: Array<number> = [];
    const interceptToggles: Array<boolean> = [];

    const server = new MockCdpServer((cmd, client) => {
      clientRef = client;
      const route = cmd.sessionId ? { sessionId: cmd.sessionId } : {};

      if (cmd.method === "Target.setAutoAttach" && !cmd.sessionId) {
        client.send({ id: cmd.id, result: {} });
        client.send({
          method: "Target.attachedToTarget",
          params: {
            sessionId: "page-sess-1",
            targetInfo: {
              targetId: "MAIN-TARGET",
              type: "page",
              title: "Mock App",
              url: "https://example.test/",
              browserContextId: "t3-preview",
            },
            waitingForDebugger: false,
          },
        });
        return;
      }
      if (cmd.method === "Target.getTargets") {
        client.send({
          id: cmd.id,
          result: {
            targetInfos: [
              {
                targetId: "MAIN-TARGET",
                type: "page",
                title: "Mock App",
                url: "https://example.test/",
                browserContextId: "t3-preview",
              },
            ],
          },
        });
        return;
      }
      if (cmd.method === "Target.attachToTarget") {
        const sessionId = `extra-sess-${++extraSeq}`;
        client.send({ id: cmd.id, result: { sessionId } });
        return;
      }
      if (cmd.method === "Browser.setDownloadBehavior") {
        downloadPath = String(cmd.params?.["downloadPath"] ?? "");
        client.send({ id: cmd.id, result: {} });
        return;
      }
      if (cmd.method === "Page.getFrameTree") {
        client.send({
          id: cmd.id,
          result: {
            frameTree: {
              frame: { id: "MAIN-TARGET", url: "https://example.test/" },
              childFrames: [
                { frame: { id: "CHILD-FRAME", parentId: "MAIN-TARGET", url: "https://child.test/" } },
              ],
            },
          },
          ...route,
        });
        return;
      }
      if (cmd.method === "Accessibility.getFullAXTree") {
        const frameId = cmd.params?.["frameId"];
        if (frameId === "CHILD-FRAME") {
          client.send({
            id: cmd.id,
            result: {
              nodes: [
                { nodeId: "c1", role: { type: "role", value: "RootWebArea" }, childIds: ["c2"] },
                {
                  nodeId: "c2",
                  parentId: "c1",
                  role: { type: "role", value: "button" },
                  name: { type: "computedString", value: "Inner Action" },
                  backendDOMNodeId: 201,
                },
              ],
            },
            ...route,
          });
          return;
        }
        client.send({
          id: cmd.id,
          result: {
            nodes: [
              { nodeId: "n1", role: { type: "role", value: "RootWebArea" }, childIds: ["n2", "n3", "n4"] },
              {
                nodeId: "n2",
                parentId: "n1",
                role: { type: "role", value: "heading" },
                name: { type: "computedString", value: "Welcome" },
                properties: [{ name: "level", value: { type: "integer", value: 1 } }],
                backendDOMNodeId: 101,
              },
              {
                nodeId: "n3",
                parentId: "n1",
                role: { type: "role", value: "link" },
                name: { type: "computedString", value: "Docs" },
                properties: [
                  { name: "focused", value: { type: "boolean", value: true } },
                  { name: "url", value: { type: "string", value: "https://example.test/docs" } },
                ],
                backendDOMNodeId: 102,
              },
              {
                nodeId: "n4",
                parentId: "n1",
                role: { type: "role", value: "Iframe" },
                backendDOMNodeId: 103,
              },
            ],
          },
          ...route,
        });
        return;
      }
      if (cmd.method === "DOM.describeNode") {
        const backendNodeId = cmd.params?.["backendNodeId"];
        client.send({
          id: cmd.id,
          result: {
            node: {
              nodeId: 1,
              backendNodeId: typeof backendNodeId === "number" ? backendNodeId : 103,
              nodeName: "IFRAME",
              frameId: backendNodeId === 103 ? "CHILD-FRAME" : undefined,
            },
          },
          ...route,
        });
        return;
      }
      if (cmd.method === "DOM.getContentQuads") {
        const id = Number(cmd.params?.["backendNodeId"] ?? 0);
        const y = id === 101 ? 10 : id === 102 ? 60 : 120;
        client.send({
          id: cmd.id,
          result: { quads: [[10, y, 110, y, 110, y + 30, 10, y + 30]] },
          ...route,
        });
        return;
      }
      if (cmd.method === "DOM.resolveNode") {
        const backendNodeId = Number(cmd.params?.["backendNodeId"]);
        resolvedNodes.push({
          ...(cmd.sessionId === undefined ? {} : { sessionId: cmd.sessionId }),
          backendNodeId,
        });
        client.send({
          id: cmd.id,
          result: { object: { type: "object", objectId: `obj-${backendNodeId}` } },
          ...route,
        });
        return;
      }
      if (cmd.method === "Runtime.callFunctionOn") {
        const fn = String(cmd.params?.["functionDeclaration"] ?? "");
        const value = fn.includes("getBoundingClientRect")
          ? fn.includes("getComputedStyle")
            ? null
            : { x: 10, y: 60, width: 100, height: 30 }
          : fn.includes("getAttribute")
            ? ".png,.jpg"
            : true;
        client.send({ id: cmd.id, result: { result: { type: "object", value } }, ...route });
        return;
      }
      if (cmd.method === "Page.setInterceptFileChooserDialog") {
        interceptToggles.push(Boolean(cmd.params?.["enabled"]));
        client.send({ id: cmd.id, result: {}, ...route });
        return;
      }
      if (cmd.method === "DOM.setFileInputFiles") {
        uploadedFiles.push(cmd.params?.["files"] as ReadonlyArray<string>);
        client.send({ id: cmd.id, result: {}, ...route });
        return;
      }
      if (cmd.method === "Page.handleJavaScriptDialog") {
        dialogActions.push(cmd.params ?? {});
        client.send({ id: cmd.id, result: {}, ...route });
        return;
      }
      if (cmd.method === "Input.dispatchKeyEvent") {
        keyEvents.push(cmd.params ?? {});
        client.send({ id: cmd.id, result: {}, ...route });
        return;
      }
      if (cmd.method === "Page.startScreencast") {
        client.send({ id: cmd.id, result: {}, ...route });
        client.send({
          method: "Page.screencastFrame",
          params: {
            data: Buffer.from("fake-jpeg").toString("base64"),
            metadata: { deviceWidth: 1280, deviceHeight: 800 },
            sessionId: 42,
          },
          ...route,
        });
        return;
      }
      if (cmd.method === "Page.screencastFrameAck") {
        screencastAcks.push(Number(cmd.params?.["sessionId"]));
        client.send({ id: cmd.id, result: {}, ...route });
        return;
      }
      client.send({ id: cmd.id, result: {}, ...route });
    });

    const { wsUrl } = await server.start();
    const browser = await connectOverCdp(wsUrl, { timeout: 5_000 });
    try {
      const pages = browser.contexts().flatMap((c) => c.pages());
      assert.equal(pages.length, 1);
      const page = pages[0]!;
      assert.equal(page.url(), "https://example.test/");

      // 1. Accessibility snapshot + aria-ref= resolution across main frame & child iframe
      const tree = await page.ariaSnapshot({ mode: "ai", boxes: true });
      assert.match(tree, /- heading "Welcome" \[level=1\] \[ref=e1\] \[box=10,10,100,30\]/);
      assert.match(tree, /- link "Docs" \[active\] \[ref=e2\] \[cursor=pointer\] \[box=10,60,100,30\]:/);
      assert.match(tree, /- \/url: https:\/\/example\.test\/docs/);
      assert.match(tree, /- iframe \[ref=e3\] \[box=10,120,100,30\]:/);
      assert.match(tree, /- button "Inner Action" \[ref=f1e1\] \[box=10,120,100,30\]/);

      await page.locator("aria-ref=e2").click({ timeout: 2_000 });
      await page.locator("aria-ref=f1e1").click({ timeout: 2_000 });
      assert.deepEqual(
        resolvedNodes.map((n) => n.backendNodeId),
        [102, 201],
      );

      // 2. Keyboard chords (ControlOrMeta+A includes selectAll command)
      await page.keyboard.press("ControlOrMeta+A");
      assert.ok(
        keyEvents.some(
          (evt) =>
            evt["key"] === "A" &&
            Array.isArray(evt["commands"]) &&
            evt["commands"].includes("selectAll"),
        ),
      );

      // 3. Dialog flow
      const dialogPromise = new Promise<CdpDialog>((resolve) => page.once("dialog", resolve));
      clientRef!.send({
        method: "Page.javascriptDialogOpening",
        params: { type: "prompt", message: "Name?", defaultPrompt: "Alice" },
        sessionId: "page-sess-1",
      });
      const dialog = await dialogPromise;
      assert.equal(dialog.type(), "prompt");
      assert.equal(dialog.message(), "Name?");
      assert.equal(dialog.defaultValue(), "Alice");
      await dialog.accept("Bob");
      assert.deepEqual(dialogActions, [{ accept: true, promptText: "Bob" }]);

      // 4. File chooser interception toggle + buffer upload
      const chooserPromise = new Promise<CdpFileChooser>((resolve) => {
        const handler = (chooser: CdpFileChooser) => {
          page.off("filechooser", handler);
          resolve(chooser);
        };
        page.on("filechooser", handler);
      });
      clientRef!.send({
        method: "Page.fileChooserOpened",
        params: { mode: "selectMultiple", backendNodeId: 505 },
        sessionId: "page-sess-1",
      });
      const chooser = await chooserPromise;
      assert.equal(chooser.isMultiple(), true);
      assert.equal(await chooser.element().getAttribute("accept"), ".png,.jpg");
      await chooser.setFiles([
        { name: "photo.png", mimeType: "image/png", buffer: Buffer.from("png-bytes") },
      ]);
      assert.equal(uploadedFiles.length, 1);
      assert.equal(await NodeFSP.readFile(uploadedFiles[0]![0]!, "utf8"), "png-bytes");
      assert.deepEqual(interceptToggles, [true, false]);

      // 5. Screencast on extra CDP session
      const extraSession = await page.context().newCDPSession(page);
      const framePromise = new Promise<CdpScreencastFrameEvent>((resolve) =>
        extraSession.once("Page.screencastFrame", resolve),
      );
      await extraSession.send("Page.startScreencast", { format: "jpeg", quality: 80 });
      const frame = await framePromise;
      assert.equal(frame.sessionId, 42);
      await extraSession.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
      await extraSession.send("Page.stopScreencast");
      await extraSession.detach();
      assert.deepEqual(screencastAcks, [42]);

      // 6. Emulation (viewport + color scheme)
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: "dark" });
      assert.ok(server.received.some((c) => c.method === "Emulation.setDeviceMetricsOverride"));
      assert.ok(server.received.some((c) => c.method === "Emulation.setEmulatedMedia"));

      // 7. Download flow
      const downloadPromise = new Promise<CdpDownload>((resolve) => page.once("download", resolve));
      const guid = "dl-guid-1";
      await NodeFSP.writeFile(NodePath.join(downloadPath, guid), "csv,data\n");
      clientRef!.send({
        method: "Browser.downloadWillBegin",
        params: { frameId: "MAIN-TARGET", guid, url: "https://example.test/r.csv", suggestedFilename: "r.csv" },
      });
      clientRef!.send({
        method: "Browser.downloadProgress",
        params: { guid, state: "completed" },
      });
      const download = await downloadPromise;
      assert.equal(download.suggestedFilename(), "r.csv");
      assert.equal(await download.failure(), null);
      const savedTo = NodePath.join(downloadPath, "saved.csv");
      await download.saveAs(savedTo);
      assert.equal(await NodeFSP.readFile(savedTo, "utf8"), "csv,data\n");
      await download.delete();

      // 8. Remote browser.close() does NOT send Browser.close to the relay
      await browser.close();
      assert.equal(
        server.received.some((c) => c.method === "Browser.close"),
        false,
      );
    } finally {
      await browser.close();
      await server.stop();
    }
  });
});
