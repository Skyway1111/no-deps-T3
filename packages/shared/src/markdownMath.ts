import { parseMarkdown, type MdNode, type MdRoot } from "./markdown/index.ts";

export function parseMarkdownWithMath(source: string): MdRoot {
  return parseMarkdown(source, {
    gfm: true,
    math: true,
    windowsPaths: false,
    autolinkBoundaries: false,
  });
}

/** Closed, parser-owned formulas with authored source for editors. */
export function markdownMathRanges(source: string, tree?: MdRoot) {
  const ranges: Array<{
    start: number;
    end: number;
    source: string;
    tex: string;
    display: boolean;
    inTable: boolean;
  }> = [];
  if (!mayContainMath(source)) return ranges;
  const visit = (node: MdNode, inTable = false) => {
    const table = inTable || node.type === "tableCell";
    if (
      node.type === "math" ||
      node.type === "inlineMath" ||
      (node.type === "code" && node.lang === "math")
    ) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      const authored = source.slice(start, end);
      if (node.type === "code") {
        if (node.closed !== true) return;
        const open = /^[ \t]*(`{3,}|~{3,})/.exec(authored)?.[1];
        const close = /\n[ \t>]*(`{3,}|~{3,})[ \t\r]*$/.exec(authored)?.[1];
        if (!open || !close || open[0] !== close[0] || close.length < open.length) return;
      }
      const display = node.type !== "inlineMath" || node.display === true || /^(?:\$\$|\\\[)/.test(authored);
      ranges.push({ start, end, source: authored, tex: node.value, display, inTable: table });
    } else if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children) visit(child, table);
    }
  };
  visit(tree ?? parseMarkdownWithMath(source));
  return ranges;
}

/** Messages without these characters skip math parsing entirely. */
function mayContainMath(text: string): boolean {
  return (
    mayContainDollarMath(text) ||
    text.includes("\\(") ||
    text.includes("\\[") ||
    /(?:`{3,}|~{3,})[ \t]*math\b/.test(text)
  );
}

function mayContainDollarMath(text: string): boolean {
  let opened = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n" || char === "\r") {
      opened = false;
    } else if (char === "$") {
      if (opened && text[index - 1] !== " ") return true;
      opened = true;
    }
  }
  return false;
}

export function mathKind(className: string | undefined): "inline" | "display" | null {
  if (!className?.includes("language-math")) return null;
  if (className.includes("math-display")) return "display";
  return className.includes("math-inline") ? "inline" : null;
}
