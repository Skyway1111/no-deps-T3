// Accessibility tree builder via CDP Accessibility.getFullAXTree.
// Formats Playwright-AI-compatible YAML snapshots and registers aria-ref targets.

import type { CdpAxNode, CdpAxProperty } from "./protocol.ts";
import type { CdpFrame } from "./page.ts";
import type { CdpSession } from "./transport.ts";

export interface AriaRefTarget {
  readonly frame: CdpFrame;
  readonly backendNodeId: number;
}

export interface AriaSnapshotOptions {
  readonly mode?: "ai" | "default";
  readonly boxes?: boolean;
  readonly timeout?: number;
}

export interface AriaSnapshotResult {
  readonly yaml: string;
  readonly refs: Map<string, AriaRefTarget>;
}

const ROLE_MAP: Readonly<Record<string, string>> = {
  RootWebArea: "document",
  WebArea: "document",
  StaticText: "text",
  InlineTextBox: "inline",
  LineBreak: "linebreak",
  GenericContainer: "generic",
  generic: "generic",
  none: "none",
  presentation: "none",
  Iframe: "iframe",
  IframePresentational: "iframe",
  image: "img",
  Image: "img",
  Paragraph: "paragraph",
  Heading: "heading",
  Link: "link",
  Button: "button",
  CheckBox: "checkbox",
  RadioButton: "radio",
  TextField: "textbox",
  SearchBox: "searchbox",
  ComboBoxGrouping: "combobox",
  ComboBoxMenuButton: "combobox",
  TextFieldWithComboBox: "combobox",
  ListBox: "listbox",
  ListBoxOption: "option",
  List: "list",
  ListItem: "listitem",
  Menu: "menu",
  MenuBar: "menubar",
  MenuItem: "menuitem",
  MenuItemCheckBox: "menuitemcheckbox",
  MenuItemRadio: "menuitemradio",
  Tab: "tab",
  TabList: "tablist",
  TabPanel: "tabpanel",
  Table: "table",
  Row: "row",
  Cell: "cell",
  ColumnHeader: "columnheader",
  RowHeader: "rowheader",
  Navigation: "navigation",
  Main: "main",
  Banner: "banner",
  ContentInfo: "contentinfo",
  Complementary: "complementary",
  Region: "region",
  Dialog: "dialog",
  AlertDialog: "alertdialog",
  Alert: "alert",
  Status: "status",
  Form: "form",
  Group: "group",
  Slider: "slider",
  SpinButton: "spinbutton",
  Switch: "switch",
  ProgressIndicator: "progressbar",
  Separator: "separator",
  Splitter: "separator",
  Toolbar: "toolbar",
  Tooltip: "tooltip",
  Tree: "tree",
  TreeItem: "treeitem",
  Article: "article",
  Section: "region",
  Strong: "strong",
  Emphasis: "emphasis",
  Code: "code",
  Blockquote: "blockquote",
};

const SKIP_ROLES = new Set(["inline", "linebreak", "none", "Ignored"]);
const COLLAPSE_ROLES = new Set(["generic", "document", "Section"]);
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "iframe",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

const normalizeRole = (raw: string | undefined): string => {
  if (!raw) return "generic";
  return ROLE_MAP[raw] ?? raw.charAt(0).toLowerCase() + raw.slice(1);
};

const propOf = (properties: ReadonlyArray<CdpAxProperty> | undefined, name: string): unknown =>
  properties?.find((prop) => prop.name === name)?.value?.value;

const cleanText = (value: unknown): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

const quoteName = (name: string): string => JSON.stringify(name);

const formatYamlScalar = (text: string): string => {
  if (text.length === 0) return '""';
  if (/^[\w./+-][\w ./+-]*$/.test(text) && !text.includes(": ")) return text;
  return JSON.stringify(text);
};

interface BoxInfo {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const quadToBox = (quad: ReadonlyArray<number>): BoxInfo | null => {
  if (quad.length < 8) return null;
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
  const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = Math.round(maxX - minX);
  const height = Math.round(maxY - minY);
  if (width <= 0 || height <= 0) return null;
  return { x: Math.round(minX), y: Math.round(minY), width, height };
};

interface LayoutSnapshot {
  readonly documents?: ReadonlyArray<{
    readonly frameId?: number;
    readonly scrollOffsetX?: number;
    readonly scrollOffsetY?: number;
    readonly nodes?: {
      readonly backendNodeId?: ReadonlyArray<number>;
      readonly contentDocumentIndex?: {
        readonly index?: ReadonlyArray<number>;
        readonly value?: ReadonlyArray<number>;
      };
    };
    readonly layout?: {
      readonly nodeIndex?: ReadonlyArray<number>;
      readonly bounds?: ReadonlyArray<ReadonlyArray<number>>;
    };
  }>;
  readonly strings?: ReadonlyArray<string>;
}

interface Layout {
  readonly boxes: Map<number, BoxInfo>;
  /** Frame id of each same-process iframe element's document. */
  readonly frames: Map<number, string>;
}

/**
 * The root document's border boxes (shifted from document to viewport coordinates, as
 * getContentQuads reports them) and its iframes' frames, in one round trip. Requested before
 * the AX tree: right after one, Chromium takes seconds to answer any DOM command.
 */
async function captureLayout(session: CdpSession, frameId: string): Promise<Layout> {
  const layout: Layout = { boxes: new Map(), frames: new Map() };
  const snapshot = (await session
    .send("DOMSnapshot.captureSnapshot", { computedStyles: [] })
    .catch(() => null)) as LayoutSnapshot | null;
  const strings = snapshot?.strings ?? [];
  const documents = snapshot?.documents ?? [];
  const doc = documents.find((candidate) => strings[candidate.frameId ?? -1] === frameId);
  const ids = doc?.nodes?.backendNodeId;
  if (!doc || !ids) return layout;
  const content = doc.nodes?.contentDocumentIndex;
  for (let k = 0; k < (content?.index?.length ?? 0); k++) {
    const id = ids[content!.index![k]!];
    const child = strings[documents[content!.value![k]!]?.frameId ?? -1];
    if (id !== undefined && child) layout.frames.set(id, child);
  }
  const nodeIndex = doc.layout?.nodeIndex ?? [];
  const bounds = doc.layout?.bounds ?? [];
  const scrollX = doc.scrollOffsetX ?? 0;
  const scrollY = doc.scrollOffsetY ?? 0;
  for (let k = 0; k < nodeIndex.length; k++) {
    const id = ids[nodeIndex[k]!];
    const rect = bounds[k];
    if (id === undefined || !rect || rect.length < 4 || layout.boxes.has(id)) continue;
    const width = Math.round(rect[2]!);
    const height = Math.round(rect[3]!);
    if (width > 0 && height > 0) {
      layout.boxes.set(id, {
        x: Math.round(rect[0]! - scrollX),
        y: Math.round(rect[1]! - scrollY),
        width,
        height,
      });
    }
  }
  return layout;
}

async function fetchBoxes(
  session: CdpSession,
  backendNodeIds: ReadonlyArray<number>,
  deadline: number,
  boxes = new Map<number, BoxInfo>(),
): Promise<Map<number, BoxInfo>> {
  if (backendNodeIds.length === 0) return boxes;
  // Cap concurrent CDP quad queries so large DOMs stay fast and responsive.
  const CONCURRENCY = 24;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, backendNodeIds.length) }, async () => {
    while (cursor < backendNodeIds.length && Date.now() < deadline) {
      const id = backendNodeIds[cursor++]!;
      const result = await session
        .send("DOM.getContentQuads", { backendNodeId: id })
        .catch(() => null);
      const quad = result?.quads?.[0];
      if (!quad) continue;
      const box = quadToBox(quad);
      if (box) boxes.set(id, box);
    }
  });
  await Promise.all(workers);
  return boxes;
}

export async function buildAriaSnapshot(
  mainFrame: CdpFrame,
  allFrames: ReadonlyArray<CdpFrame>,
  options: AriaSnapshotOptions = {},
): Promise<AriaSnapshotResult> {
  const refs = new Map<string, AriaRefTarget>();
  const includeBoxes = options.boxes === true;
  const deadline = Date.now() + (options.timeout ?? 10_000);
  const frameById = new Map<string, CdpFrame>(allFrames.map((frame) => [frame.id, frame]));
  let frameCounter = 0;

  const renderFrame = async (frame: CdpFrame, refPrefix: string): Promise<Array<string>> => {
    const session = frame.session();
    const isSessionRoot = frame.parentFrame() === null || frame.targetId !== undefined;
    const layout: Promise<Layout> =
      includeBoxes && isSessionRoot
        ? captureLayout(session, frame.id)
        : Promise.resolve({ boxes: new Map(), frames: new Map() });
    const treeResult = await session.send(
      "Accessibility.getFullAXTree",
      isSessionRoot ? {} : { frameId: frame.id },
    );
    const nodes = treeResult.nodes ?? [];
    if (nodes.length === 0) return [];

    const byId = new Map<string, CdpAxNode>();
    for (const node of nodes) byId.set(node.nodeId, node);
    const root = nodes.find((node) => !node.parentId) ?? nodes[0]!;

    // First pass: assign refs and collect backendNodeIds that need bounding boxes.
    let refIndex = 0;
    const nodeRefs = new Map<string, string>();
    const backendIds: Array<number> = [];
    const iframeTargets = new Map<string, CdpFrame>();

    const iframeNodes: Array<{ readonly nodeId: string; readonly backendNodeId: number }> = [];
    const assignRefs = (node: CdpAxNode): void => {
      const role = normalizeRole(
        typeof node.role?.value === "string" ? node.role.value : undefined,
      );
      const name = cleanText(node.name?.value);
      const skipped = node.ignored === true || SKIP_ROLES.has(role);
      const collapsed = COLLAPSE_ROLES.has(role) && name.length === 0;

      if (!skipped && !collapsed && role !== "text" && node.backendDOMNodeId !== undefined) {
        const ref = `${refPrefix}e${++refIndex}`;
        nodeRefs.set(node.nodeId, ref);
        refs.set(ref, { frame, backendNodeId: node.backendDOMNodeId });
        if (includeBoxes) backendIds.push(node.backendDOMNodeId);

        if (role === "iframe")
          iframeNodes.push({ nodeId: node.nodeId, backendNodeId: node.backendDOMNodeId });
      }

      if (role !== "iframe") {
        for (const childId of node.childIds ?? []) {
          const child = byId.get(childId);
          if (child) assignRefs(child);
        }
      }
    };

    assignRefs(root);
    const known = await layout;
    const [, boxes] = await Promise.all([
      Promise.all(
        iframeNodes.map(async ({ nodeId, backendNodeId }) => {
          const childFrameId =
            known.frames.get(backendNodeId) ??
            (await session.send("DOM.describeNode", { backendNodeId }).catch(() => null))?.node
              .frameId;
          const childFrame = childFrameId ? frameById.get(childFrameId) : undefined;
          if (childFrame && childFrame !== frame) iframeTargets.set(nodeId, childFrame);
        }),
      ),
      fetchBoxes(
        session,
        backendIds.filter((id) => !known.boxes.has(id)),
        deadline,
        known.boxes,
      ),
    ]);

    // Child frames render in document order so their ref prefixes number the same way.
    const childFrameLines = new Map<string, Array<string>>();
    for (const { nodeId } of iframeNodes) {
      const childFrame = iframeTargets.get(nodeId);
      if (!childFrame) continue;
      childFrameLines.set(
        nodeId,
        await renderFrame(childFrame, `f${++frameCounter}`).catch(() => []),
      );
    }

    const lines: Array<string> = [];

    const emit = (node: CdpAxNode, depth: number): void => {
      const role = normalizeRole(
        typeof node.role?.value === "string" ? node.role.value : undefined,
      );
      const name = cleanText(node.name?.value);
      const value = cleanText(node.value?.value);
      const skipped = node.ignored === true || SKIP_ROLES.has(role);
      const collapsed = COLLAPSE_ROLES.has(role) && name.length === 0;

      if (skipped || collapsed) {
        for (const childId of node.childIds ?? []) {
          const child = byId.get(childId);
          if (child) emit(child, depth);
        }
        return;
      }

      const pad = "  ".repeat(depth);

      if (role === "text") {
        if (name.length > 0) lines.push(`${pad}- text: ${formatYamlScalar(name)}`);
        return;
      }

      const attrs: Array<string> = [];
      if (propOf(node.properties, "focused") === true) attrs.push("[active]");

      const checked = propOf(node.properties, "checked");
      if (checked === "true" || checked === true) attrs.push("[checked]");
      else if (checked === "mixed") attrs.push("[checked=mixed]");

      if (propOf(node.properties, "disabled") === true) attrs.push("[disabled]");
      if (propOf(node.properties, "expanded") === true) attrs.push("[expanded]");

      const level = propOf(node.properties, "level");
      if (typeof level === "number" && Number.isInteger(level) && level > 0) {
        attrs.push(`[level=${level}]`);
      }

      const pressed = propOf(node.properties, "pressed");
      if (pressed === "true" || pressed === true) attrs.push("[pressed]");
      else if (pressed === "mixed") attrs.push("[pressed=mixed]");

      if (propOf(node.properties, "selected") === true) attrs.push("[selected]");

      const ref = nodeRefs.get(node.nodeId);
      if (ref !== undefined) attrs.push(`[ref=${ref}]`);

      if (INTERACTIVE_ROLES.has(role) && role === "link") {
        attrs.push("[cursor=pointer]");
      }

      if (includeBoxes && node.backendDOMNodeId !== undefined) {
        const box = boxes.get(node.backendDOMNodeId);
        if (box) attrs.push(`[box=${box.x},${box.y},${box.width},${box.height}]`);
      }

      const header = `${role}${name.length > 0 ? ` ${quoteName(name)}` : ""}${attrs.length > 0 ? ` ${attrs.join(" ")}` : ""}`;
      const url = cleanText(propOf(node.properties, "url"));

      if (role === "iframe") {
        const childLines = childFrameLines.get(node.nodeId);
        if (childLines && childLines.length > 0) {
          lines.push(`${pad}- ${header}:`);
          const indent = `${pad}  `;
          for (const line of childLines) lines.push(indent + line);
          return;
        }
        lines.push(`${pad}- ${header}`);
        return;
      }

      // Collect non-trivial child lines to decide whether this node needs a trailing colon.
      const childLines: Array<string> = [];
      if (url.length > 0) {
        childLines.push(`${"  ".repeat(depth + 1)}- /url: ${url}`);
      }

      const childNodes = (node.childIds ?? [])
        .map((id) => byId.get(id))
        .filter((child): child is CdpAxNode => child !== undefined);

      // Avoid repeating a StaticText child when its text equals the element's accessible name.
      const singleTextChild =
        childNodes.length === 1 &&
        normalizeRole(
          typeof childNodes[0]!.role?.value === "string" ? childNodes[0]!.role.value : undefined,
        ) === "text" &&
        cleanText(childNodes[0]!.name?.value) === name;

      if (!singleTextChild) {
        const beforeCount = lines.length;
        for (const child of childNodes) emit(child, depth + 1);
        childLines.push(...lines.splice(beforeCount));
      }

      if (childLines.length > 0) {
        lines.push(`${pad}- ${header}:`);
        lines.push(...childLines);
      } else if (value.length > 0 && value !== name) {
        lines.push(`${pad}- ${header}: ${formatYamlScalar(value)}`);
      } else {
        lines.push(`${pad}- ${header}`);
      }
    };

    emit(root, 0);
    return lines;
  };

  const lines = await renderFrame(mainFrame, "");
  return { yaml: lines.join("\n"), refs };
}
