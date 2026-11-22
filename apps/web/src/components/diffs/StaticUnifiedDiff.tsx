import type { FileDiffMetadata } from "@t3tools/shared/diff/patch";
import { codeToTokens, getFiletypeFromFileName, type ThemedToken } from "@t3tools/shared/highlight";

import { resolveDiffThemeName } from "~/lib/diffTheme";
import { cn } from "~/lib/utils";

type Row =
  | { readonly kind: "hunk"; readonly text: string }
  | {
      readonly kind: "context" | "addition" | "deletion";
      readonly line: number;
      readonly tokens: ReadonlyArray<ThemedToken>;
    };

function diffRows(fileDiff: FileDiffMetadata, theme: "light" | "dark"): Row[] {
  const lang = fileDiff.lang ?? getFiletypeFromFileName(fileDiff.name);
  const highlight = (lines: ReadonlyArray<string>) =>
    codeToTokens(lines.join(""), { lang, theme: resolveDiffThemeName(theme) }).tokens;
  const oldTokens = highlight(fileDiff.deletionLines);
  const newTokens = highlight(fileDiff.additionLines);
  const rows: Row[] = [];
  for (const hunk of fileDiff.hunks) {
    rows.push({
      kind: "hunk",
      text: `@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@${hunk.hunkContext ? ` ${hunk.hunkContext}` : ""}`,
    });
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let i = 0; i < content.lines; i++, oldLine++) {
          const tokens = newTokens[content.additionLineIndex + i] ?? [];
          rows.push({ kind: "context", line: newLine++, tokens });
        }
        continue;
      }
      for (let i = 0; i < content.deletions; i++) {
        const tokens = oldTokens[content.deletionLineIndex + i] ?? [];
        rows.push({ kind: "deletion", line: oldLine++, tokens });
      }
      for (let i = 0; i < content.additions; i++) {
        const tokens = newTokens[content.additionLineIndex + i] ?? [];
        rows.push({ kind: "addition", line: newLine++, tokens });
      }
    }
  }
  return rows;
}

function tokenStyle(token: ThemedToken) {
  const font = token.fontStyle ?? 0;
  return {
    color: token.color,
    ...(font & 1 ? { fontStyle: "italic" } : {}),
    ...(font & 2 ? { fontWeight: 700 } : {}),
  };
}

const ROW_CLASS = {
  context: "border-transparent",
  addition: "border-diff-addition bg-diff-addition/12",
  deletion: "border-diff-deletion bg-diff-deletion/12",
} as const;

const GUTTER_CLASS = {
  context: "text-muted-foreground/70",
  addition: "text-diff-addition-foreground",
  deletion: "text-diff-deletion-foreground",
} as const;

/** A read-only, syntax-highlighted unified diff for small previews. */
export function StaticUnifiedDiff({
  fileDiff,
  theme,
  wrap = false,
}: {
  fileDiff: FileDiffMetadata;
  theme: "light" | "dark";
  wrap?: boolean;
}) {
  const rows = diffRows(fileDiff, theme);
  const gutter = `${String(rows.reduce((max, row) => (row.kind === "hunk" ? max : Math.max(max, row.line)), 0)).length}ch`;
  return (
    <div className="bg-(--code-background) text-(--code-foreground)">
      <div className="border-b px-3 py-1.5 font-sans text-xs">{fileDiff.name}</div>
      <div
        className={cn(
          "py-1 font-mono text-(length:--diffs-font-size,var(--text-xs)) leading-normal",
          wrap ? "whitespace-pre-wrap break-all" : "overflow-x-auto whitespace-pre",
        )}
      >
        <div className={wrap ? undefined : "w-max min-w-full"}>
          {rows.map((row) =>
            row.kind === "hunk" ? (
              <div key={row.text} className="px-3 text-muted-foreground">
                {row.text}
              </div>
            ) : (
              // Deletions number the old side, other rows the new side.
              <div
                key={`${row.kind === "deletion" ? "-" : "+"}${row.line}`}
                className={cn("flex border-l-2", ROW_CLASS[row.kind])}
              >
                <span
                  className={cn("shrink-0 px-2 text-right select-none", GUTTER_CLASS[row.kind])}
                  style={{ minWidth: `calc(${gutter} + 1rem)` }}
                >
                  {row.line}
                </span>
                <span className="min-w-0 flex-1 pr-3">
                  {row.tokens.length === 0
                    ? " "
                    : row.tokens.map((token) => (
                        <span key={token.offset} style={tokenStyle(token)}>
                          {token.content}
                        </span>
                      ))}
                </span>
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
