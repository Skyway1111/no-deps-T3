// Shadow-DOM-piercing selector engine, aria-ref resolution, element handles, and auto-waiting locators.

import { CdpTimeoutError, type CdpExceptionDetails } from "./protocol.ts";
import type { CdpFrame, CdpPage } from "./page.ts";

const POLL_INTERVAL_MS = 50;

const exceptionMessage = (details: CdpExceptionDetails): string =>
  details.exception?.description ?? details.text;

// Runs in the page to query CSS (piercing open shadow roots), text=, xpath=, role=, and >> chains.
const QUERY_SELECTOR_FN = `function(selector) {
  const splitChain = (input) => {
    const parts = [];
    let current = "";
    let quote = null;
    let depth = 0;
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (quote) {
        current += ch;
        if (ch === "\\\\" && i + 1 < input.length) { current += input[++i]; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "\`") { quote = ch; current += ch; continue; }
      if (ch === "[" || ch === "(") { depth++; current += ch; continue; }
      if (ch === "]" || ch === ")") { depth = Math.max(0, depth - 1); current += ch; continue; }
      if (depth === 0 && ch === ">" && input[i + 1] === ">") {
        parts.push(current.trim());
        current = "";
        i++;
        continue;
      }
      current += ch;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  };

  const walkRoots = (root, visit) => {
    visit(root);
    const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (const el of all) {
      if (el.shadowRoot) walkRoots(el.shadowRoot, visit);
    }
  };

  const queryCssDeep = (roots, css) => {
    const found = [];
    const seen = new Set();
    for (const root of roots) {
      walkRoots(root, (scope) => {
        let matches;
        try {
          matches = scope.querySelectorAll(css);
        } catch (err) {
          throw new SyntaxError("Unexpected token while parsing selector " + JSON.stringify(css) + ": " + err.message);
        }
        for (const el of matches) {
          if (!seen.has(el)) { seen.add(el); found.push(el); }
        }
      });
    }
    return found;
  };

  const queryText = (roots, raw) => {
    const exact = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"));
    const needle = exact ? raw.slice(1, -1) : raw.toLowerCase();
    const found = [];
    const seen = new Set();
    for (const root of roots) {
      walkRoots(root, (scope) => {
        const all = scope.querySelectorAll ? scope.querySelectorAll("*") : [];
        for (const el of all) {
          if (seen.has(el)) continue;
          const text = (el.innerText ?? el.textContent ?? "").trim();
          const matched = exact ? text === needle : text.toLowerCase().includes(needle);
          if (!matched) continue;
          // Prefer leaf-most matching elements.
          const childMatches = Array.from(el.children).some((child) => {
            const ct = (child.innerText ?? child.textContent ?? "").trim();
            return exact ? ct === needle : ct.toLowerCase().includes(needle);
          });
          if (!childMatches) { seen.add(el); found.push(el); }
        }
      });
    }
    return found;
  };

  const queryXPath = (roots, expr) => {
    const found = [];
    const seen = new Set();
    for (const root of roots) {
      let snap;
      try {
        snap = document.evaluate(expr, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      } catch (err) {
        throw new SyntaxError("Unexpected token while parsing selector xpath=" + expr + ": " + err.message);
      }
      for (let i = 0; i < snap.snapshotLength; i++) {
        const node = snap.snapshotItem(i);
        if (node && node.nodeType === 1 && !seen.has(node)) { seen.add(node); found.push(node); }
      }
    }
    return found;
  };

  const queryRole = (roots, raw) => {
    const match = /^([a-z]+)(?:\\[name=(?:"([^"]*)"|'([^']*)')\\])?$/i.exec(raw.trim());
    if (!match) throw new SyntaxError("Unexpected token while parsing selector role=" + raw);
    const wantedRole = match[1].toLowerCase();
    const wantedName = match[2] ?? match[3];
    const implicitRole = (el) => {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit.toLowerCase();
      switch (el.tagName) {
        case "BUTTON": return "button";
        case "A": return el.hasAttribute("href") ? "link" : "";
        case "TEXTAREA": return "textbox";
        case "SELECT": return "combobox";
        case "IMG": return "img";
        case "INPUT": {
          const t = (el.type || "text").toLowerCase();
          if (t === "checkbox") return "checkbox";
          if (t === "radio") return "radio";
          if (t === "button" || t === "submit" || t === "reset") return "button";
          if (t === "search") return "searchbox";
          return "textbox";
        }
        default: return /^H[1-6]$/.test(el.tagName) ? "heading" : "";
      }
    };
    const accessibleName = (el) =>
      (el.getAttribute("aria-label") || el.innerText || el.textContent || el.getAttribute("title") || el.value || "").trim();
    const found = [];
    const seen = new Set();
    for (const root of roots) {
      walkRoots(root, (scope) => {
        for (const el of scope.querySelectorAll ? scope.querySelectorAll("*") : []) {
          if (seen.has(el) || implicitRole(el) !== wantedRole) continue;
          if (wantedName !== undefined && accessibleName(el) !== wantedName) continue;
          seen.add(el);
          found.push(el);
        }
      });
    }
    return found;
  };

  const parts = splitChain(selector);
  if (parts.length === 0) throw new SyntaxError("Unexpected token while parsing selector: empty selector");
  let roots = [document];
  for (const part of parts) {
    const engineMatch = /^([a-z][a-z0-9-]*)=(.*)$/is.exec(part);
    if (engineMatch) {
      const engine = engineMatch[1].toLowerCase();
      const body = engineMatch[2];
      if (engine === "css") roots = queryCssDeep(roots, body);
      else if (engine === "text") roots = queryText(roots, body);
      else if (engine === "xpath") roots = queryXPath(roots, body);
      else if (engine === "role") roots = queryRole(roots, body);
      else throw new SyntaxError("Unknown engine " + JSON.stringify(engine) + " while parsing selector " + JSON.stringify(selector));
    } else {
      roots = queryCssDeep(roots, part);
    }
    if (roots.length === 0) return [];
  }
  return roots;
}`;

export class CdpElementHandle {
  readonly frame: CdpFrame;
  private objectId: string | undefined;
  private backendNodeId: number | undefined;

  constructor(
    frame: CdpFrame,
    ref: { readonly objectId?: string; readonly backendNodeId?: number },
  ) {
    this.frame = frame;
    this.objectId = ref.objectId;
    this.backendNodeId = ref.backendNodeId;
  }

  async resolveObjectId(): Promise<string> {
    if (this.objectId !== undefined) return this.objectId;
    if (this.backendNodeId === undefined) {
      throw new Error("Element is not attached to the DOM");
    }
    const { object } = await this.frame
      .session()
      .send("DOM.resolveNode", { backendNodeId: this.backendNodeId });
    if (!object.objectId) throw new Error("Element is not attached to the DOM");
    this.objectId = object.objectId;
    return this.objectId;
  }

  async resolveBackendNodeId(): Promise<number> {
    if (this.backendNodeId !== undefined) return this.backendNodeId;
    const objectId = await this.resolveObjectId();
    const { node } = await this.frame.session().send("DOM.describeNode", { objectId });
    this.backendNodeId = node.backendNodeId;
    return this.backendNodeId;
  }

  async evaluate<R = unknown, A = unknown>(
    fn: (element: any, arg: A) => R | Promise<R>,
    arg?: A,
  ): Promise<R> {
    const objectId = await this.resolveObjectId();
    const args = arg === undefined ? [] : [{ value: arg }];
    const response = await this.frame.session().send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function(arg) { return (${fn.toString()})(this, arg); }`,
      arguments: args,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(exceptionMessage(response.exceptionDetails));
    }
    return response.result.value as R;
  }

  async getAttribute(name: string): Promise<string | null> {
    return this.evaluate(
      (element: { getAttribute?: (attr: string) => string | null }, attr: string) =>
        element.getAttribute?.(attr) ?? null,
      name,
    );
  }

  async contentFrame(): Promise<CdpFrame | null> {
    const session = this.frame.session();
    const described =
      this.backendNodeId !== undefined
        ? await session.send("DOM.describeNode", { backendNodeId: this.backendNodeId }).catch(() => null)
        : await session
            .send("DOM.describeNode", { objectId: await this.resolveObjectId() })
            .catch(() => null);
    const frameId = described?.node.frameId;
    if (!frameId) return null;
    return this.frame.page.frames().find((candidate) => candidate.id === frameId) ?? null;
  }

  async dispose(): Promise<void> {
    if (this.objectId === undefined) return;
    const id = this.objectId;
    this.objectId = undefined;
    await this.frame.session().send("Runtime.releaseObject", { objectId: id }).catch(() => {});
  }
}

interface BoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const isSelectorSyntaxError = (cause: unknown): boolean =>
  cause instanceof Error &&
  /while parsing selector|Unknown engine|Unexpected token/i.test(cause.message);

const parseAriaRefSelector = (selector: string): string | null => {
  const match = /^\s*aria-ref\s*=\s*(\S+)\s*$/.exec(selector);
  return match?.[1] ?? null;
};

export class CdpLocator {
  private readonly page: CdpPage;
  private readonly selector: string;

  constructor(page: CdpPage, selector: string) {
    this.page = page;
    this.selector = selector;
  }

  private defaultTimeout(override?: number): number {
    return override ?? this.page.defaultTimeout();
  }

  private async queryMatches(): Promise<{
    readonly count: number;
    readonly handle: CdpElementHandle | null;
  }> {
    const ariaRef = parseAriaRefSelector(this.selector);
    if (ariaRef !== null) {
      const target = this.page.resolveAriaRef(ariaRef);
      if (!target || target.frame.isDetached()) return { count: 0, handle: null };
      const resolved = await target.frame
        .session()
        .send("DOM.resolveNode", { backendNodeId: target.backendNodeId })
        .catch(() => null);
      if (!resolved?.object.objectId) return { count: 0, handle: null };
      return {
        count: 1,
        handle: new CdpElementHandle(target.frame, {
          objectId: resolved.object.objectId,
          backendNodeId: target.backendNodeId,
        }),
      };
    }

    const frame = this.page.mainFrame();
    const session = frame.session();
    const contextId = frame.defaultContextId();
    const evalResult = await session.send("Runtime.evaluate", {
      expression: `(${QUERY_SELECTOR_FN})(${JSON.stringify(this.selector)})`,
      ...(contextId === undefined ? {} : { contextId }),
      returnByValue: false,
    });
    if (evalResult.exceptionDetails) {
      throw new Error(exceptionMessage(evalResult.exceptionDetails));
    }
    const listObjectId = evalResult.result.objectId;
    if (!listObjectId) return { count: 0, handle: null };
    try {
      const lengthRes = await session.send("Runtime.callFunctionOn", {
        objectId: listObjectId,
        functionDeclaration: "function() { return this.length; }",
        returnByValue: true,
      });
      const count = typeof lengthRes.result.value === "number" ? lengthRes.result.value : 0;
      if (count !== 1) return { count, handle: null };
      const firstRes = await session.send("Runtime.callFunctionOn", {
        objectId: listObjectId,
        functionDeclaration: "function() { return this[0]; }",
        returnByValue: false,
      });
      if (!firstRes.result.objectId) return { count: 0, handle: null };
      return {
        count: 1,
        handle: new CdpElementHandle(frame, { objectId: firstRes.result.objectId }),
      };
    } finally {
      await session.send("Runtime.releaseObject", { objectId: listObjectId }).catch(() => {});
    }
  }

  private async waitForHandle(
    action: string,
    timeoutMs: number,
    predicate?: (handle: CdpElementHandle) => Promise<string | null>,
  ): Promise<CdpElementHandle> {
    const deadline = Date.now() + timeoutMs;
    let lastReason = "not found";
    for (;;) {
      let handle: CdpElementHandle | null = null;
      try {
        const result = await this.queryMatches();
        if (result.count > 1) {
          throw new Error(
            `strict mode violation: locator(${JSON.stringify(this.selector)}) resolved to ${result.count} elements`,
          );
        }
        if (result.count === 1 && result.handle) {
          handle = result.handle;
          const failure = predicate ? await predicate(handle) : null;
          if (failure === null) return handle;
          lastReason = failure;
          await handle.dispose();
          handle = null;
        } else {
          lastReason = "not attached to the DOM";
        }
      } catch (cause) {
        if (handle) await handle.dispose();
        if (
          isSelectorSyntaxError(cause) ||
          (cause instanceof Error && cause.message.startsWith("strict mode violation:"))
        ) {
          throw cause;
        }
        lastReason = "detached during lookup";
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new CdpTimeoutError(
          `locator.${action}: Timeout ${timeoutMs}ms exceeded.\nCall log:\n  - element is ${lastReason}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
    }
  }

  async count(): Promise<number> {
    const result = await this.queryMatches();
    if (result.handle) await result.handle.dispose();
    return result.count;
  }

  async elementHandle(options?: { readonly timeout?: number }): Promise<CdpElementHandle | null> {
    return this.waitForHandle("elementHandle", this.defaultTimeout(options?.timeout));
  }

  async boundingBox(options?: { readonly timeout?: number }): Promise<BoundingBox | null> {
    const handle = await this.waitForHandle("boundingBox", this.defaultTimeout(options?.timeout));
    try {
      return await this.readBox(handle);
    } finally {
      await handle.dispose();
    }
  }

  private async readBox(handle: CdpElementHandle): Promise<BoundingBox | null> {
    const box = await handle.evaluate(
      (element: {
        getBoundingClientRect?: () => { x: number; y: number; width: number; height: number };
      }) => {
        const rect = element.getBoundingClientRect?.();
        if (!rect || (rect.width === 0 && rect.height === 0)) return null;
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      },
    );
    if (!box) return null;
    // Offset coordinates when the element lives inside an iframe.
    const offset = await this.frameOffset(handle.frame);
    return {
      x: box.x + offset.x,
      y: box.y + offset.y,
      width: box.width,
      height: box.height,
    };
  }

  private async frameOffset(frame: CdpFrame): Promise<{ readonly x: number; readonly y: number }> {
    let x = 0;
    let y = 0;
    let current: CdpFrame | null = frame;
    while (current && current.parentFrame()) {
      const parent = current.parentFrame()!;
      const frameId = current.id;
      const rect = await parent
        .evaluate((targetId: string) => {
          const doc = (globalThis as unknown as { document: { querySelectorAll: (s: string) => ArrayLike<any> } }).document;
          for (const el of Array.from(doc.querySelectorAll("iframe, frame"))) {
            const box = el.getBoundingClientRect();
            if (el.id === targetId || el.name === targetId) {
              return { x: box.x, y: box.y };
            }
          }
          return null;
        }, frameId)
        .catch(() => null);
      if (rect) {
        x += rect.x;
        y += rect.y;
      }
      current = parent;
    }
    return { x, y };
  }

  async scrollIntoViewIfNeeded(options?: { readonly timeout?: number }): Promise<void> {
    const handle = await this.waitForHandle(
      "scrollIntoViewIfNeeded",
      this.defaultTimeout(options?.timeout),
    );
    try {
      const connected = await handle.evaluate((el: { isConnected?: boolean }) => el.isConnected === true);
      if (!connected) {
        throw new Error("locator.scrollIntoViewIfNeeded: Element is not attached to the DOM");
      }
      const objectId = await handle.resolveObjectId();
      await handle.frame
        .session()
        .send("DOM.scrollIntoViewIfNeeded", { objectId })
        .catch(() =>
          handle.evaluate((el: { scrollIntoView?: (opts: object) => void }) => {
            el.scrollIntoView?.({ block: "center", inline: "center" });
          }),
        );
    } finally {
      await handle.dispose();
    }
  }

  private async requireVisibleBox(
    handle: CdpElementHandle,
    requireEnabled = false,
  ): Promise<string | null> {
    const state = await handle.evaluate(
      (
        el: {
          isConnected?: boolean;
          disabled?: boolean;
          getBoundingClientRect?: () => { width: number; height: number };
        },
        checkEnabled: boolean,
      ) => {
        if (!el.isConnected) return "not attached to the DOM";
        const style = (
          globalThis as unknown as {
            getComputedStyle: (node: unknown) => { visibility: string; display: string };
          }
        ).getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return "not visible";
        const rect = el.getBoundingClientRect?.();
        if (!rect || rect.width === 0 || rect.height === 0) return "not visible";
        if (checkEnabled && el.disabled === true) return "not enabled";
        return null;
      },
      requireEnabled,
    );
    return state;
  }

  async click(options?: {
    readonly button?: "left" | "middle" | "right";
    readonly clickCount?: number;
    readonly timeout?: number;
  }): Promise<void> {
    const timeout = this.defaultTimeout(options?.timeout);
    const handle = await this.waitForHandle("click", timeout, (candidate) =>
      this.requireVisibleBox(candidate, true),
    );
    try {
      const objectId = await handle.resolveObjectId();
      await handle.frame
        .session()
        .send("DOM.scrollIntoViewIfNeeded", { objectId })
        .catch(() => {});
      const box = await this.readBox(handle);
      if (!box) throw new CdpTimeoutError("locator.click: Timeout exceeded.\nCall log:\n  - element is not visible");
      await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {
        ...(options?.button === undefined ? {} : { button: options.button }),
        ...(options?.clickCount === undefined ? {} : { clickCount: options.clickCount }),
      });
    } finally {
      await handle.dispose();
    }
  }

  async hover(options?: { readonly timeout?: number }): Promise<void> {
    const handle = await this.waitForHandle(
      "hover",
      this.defaultTimeout(options?.timeout),
      (candidate) => this.requireVisibleBox(candidate, false),
    );
    try {
      const objectId = await handle.resolveObjectId();
      await handle.frame
        .session()
        .send("DOM.scrollIntoViewIfNeeded", { objectId })
        .catch(() => {});
      const box = await this.readBox(handle);
      if (!box) throw new CdpTimeoutError("locator.hover: Timeout exceeded.\nCall log:\n  - element is not visible");
      await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    } finally {
      await handle.dispose();
    }
  }

  async fill(value: string, options?: { readonly timeout?: number }): Promise<void> {
    const handle = await this.waitForHandle(
      "fill",
      this.defaultTimeout(options?.timeout),
      (candidate) => this.requireVisibleBox(candidate, true),
    );
    try {
      const check = await handle.evaluate((el: any) => {
        const nonText = [
          "button",
          "checkbox",
          "color",
          "file",
          "hidden",
          "image",
          "radio",
          "range",
          "reset",
          "submit",
        ];
        const isInput = el.tagName === "INPUT" && !nonText.includes(el.type || "text");
        const isTextArea = el.tagName === "TEXTAREA";
        const editable = isInput || isTextArea || Boolean(el.isContentEditable);
        if (!editable) return "not-editable";
        if (el.disabled || el.readOnly) return "readonly";
        el.focus?.();
        if (isInput || isTextArea) {
          el.select?.();
          el.value = "";
          el.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          el.textContent = "";
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
        return "ok";
      });
      if (check === "not-editable") {
        throw new Error("Element is not an <input>, <textarea> or [contenteditable] element");
      }
      if (check === "readonly") {
        throw new Error("Element is not editable");
      }
      if (value.length > 0) {
        await this.page.keyboard.insertText(value);
      }
      await handle.evaluate((el: any) => {
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
    } finally {
      await handle.dispose();
    }
  }

  async selectOption(
    values: ReadonlyArray<string>,
    options?: { readonly timeout?: number },
  ): Promise<Array<string>> {
    const handle = await this.waitForHandle(
      "selectOption",
      this.defaultTimeout(options?.timeout),
      (candidate) => this.requireVisibleBox(candidate, true),
    );
    try {
      const selected = await handle.evaluate((el: any, wanted: ReadonlyArray<string>) => {
        if (el.tagName !== "SELECT") {
          throw new Error("Element is not a <select> element");
        }
        const wantedSet = new Set(wanted);
        const result: Array<string> = [];
        for (const option of Array.from(el.options) as Array<{
          value: string;
          label: string;
          selected: boolean;
        }>) {
          const match = wantedSet.has(option.value) || wantedSet.has(option.label.trim());
          option.selected = match && (el.multiple || result.length === 0);
          if (option.selected) result.push(option.value);
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return result;
      }, values);
      return selected;
    } finally {
      await handle.dispose();
    }
  }

  async dragTo(
    target: CdpLocator,
    options?: { readonly timeout?: number; readonly steps?: number },
  ): Promise<void> {
    const timeout = this.defaultTimeout(options?.timeout);
    const deadline = Date.now() + timeout;
    const remaining = () => Math.max(1, deadline - Date.now());
    const sourceHandle = await this.waitForHandle("dragTo", remaining(), (candidate) =>
      this.requireVisibleBox(candidate, false),
    );
    let targetHandle: CdpElementHandle | null = null;
    try {
      targetHandle = await target.waitForHandle("dragTo", remaining(), (candidate) =>
        target.requireVisibleBox(candidate, false),
      );
      const sourceBox = await this.readBox(sourceHandle);
      const targetBox = await target.readBox(targetHandle);
      if (!sourceBox || !targetBox) {
        throw new CdpTimeoutError("locator.dragTo: Timeout exceeded.\nCall log:\n  - element is not visible");
      }
      const startX = sourceBox.x + sourceBox.width / 2;
      const startY = sourceBox.y + sourceBox.height / 2;
      const endX = targetBox.x + targetBox.width / 2;
      const endY = targetBox.y + targetBox.height / 2;
      await this.page.mouse.move(startX, startY);
      await this.page.mouse.down({ button: "left" });
      await this.page.mouse.move(endX, endY, { steps: options?.steps ?? 5 });
      await this.page.mouse.up({ button: "left" });
    } finally {
      await sourceHandle.dispose();
      if (targetHandle) await targetHandle.dispose();
    }
  }

  async setInputFiles(
    files: ReadonlyArray<string>,
    options?: { readonly timeout?: number },
  ): Promise<void> {
    const handle = await this.waitForHandle("setInputFiles", this.defaultTimeout(options?.timeout));
    try {
      const isFileInput = await handle.evaluate(
        (el: { tagName?: string; type?: string }) =>
          el.tagName === "INPUT" && el.type?.toLowerCase() === "file",
      );
      if (!isFileInput) {
        throw new Error("Node is not an <input type='file'> element");
      }
      const backendNodeId = await handle.resolveBackendNodeId();
      await handle.frame.session().send("DOM.setFileInputFiles", {
        backendNodeId,
        files: [...files],
      });
    } finally {
      await handle.dispose();
    }
  }

  evaluate<R, A>(
    fn: (element: any, arg: A) => R | Promise<R>,
    arg: A,
    options?: { readonly timeout?: number },
  ): Promise<R>;
  evaluate<R>(
    fn: (element: any) => R | Promise<R>,
    arg?: undefined,
    options?: { readonly timeout?: number },
  ): Promise<R>;
  async evaluate<R = unknown, A = unknown>(
    fn: (element: any, arg: A) => R | Promise<R>,
    arg?: A,
    options?: { readonly timeout?: number },
  ): Promise<R> {
    const handle = await this.waitForHandle("evaluate", this.defaultTimeout(options?.timeout));
    try {
      return await handle.evaluate(fn, arg);
    } finally {
      await handle.dispose();
    }
  }
}
