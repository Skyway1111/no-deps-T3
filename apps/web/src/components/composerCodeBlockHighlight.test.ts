import { describe, expect, it, vi } from "vite-plus/test";

import type { DiffThemeName } from "~/lib/diffRendering";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";

import { createCodeBlockHighlighter, tokenizeBlock } from "./composerCodeBlockHighlight";

vi.mock("~/lib/syntaxHighlighting", () => ({ getSyntaxHighlighterPromise: vi.fn() }));

const THEME = "pierre-dark" as DiffThemeName;

function fakeHighlighter(colorFor: (content: string) => string | undefined) {
  return {
    codeToTokens(code: string) {
      return {
        tokens: code.split(/\r?\n/).map((line) =>
          line
            .split(/(\s+)/)
            .filter((part) => part.length > 0)
            .map((content) => ({ content, color: colorFor(content) })),
        ),
      };
    },
  } as unknown as Parameters<typeof tokenizeBlock>[0];
}

describe("composer code block highlighting", () => {
  it("accounts for both characters of a CRLF line break", () => {
    const highlighter = fakeHighlighter((content) => (content === "two" ? "#00ff00" : undefined));

    const decorations = tokenizeBlock(highlighter, "one\r\ntwo", "ts", THEME);

    expect(decorations).toEqual([{ from: 5, to: 8, color: "#00ff00" }]);
  });
});

describe("highlighting composer code blocks", () => {
  it("highlights a gitignore fence with the ini grammar, as chat does", async () => {
    vi.mocked(getSyntaxHighlighterPromise).mockResolvedValue(fakeHighlighter(() => "#ff0000"));
    const updated = Promise.withResolvers<void>();
    const highlighter = createCodeBlockHighlighter({
      resolveTheme: () => THEME,
      onUpdate: () => updated.resolve(),
    });
    const code = "*.log\n!keep.log";
    const language = 'gitignore title=".gitignore"';
    expect(highlighter.getSpans(language, code)).toBe(highlighter.getSpans("ts", "other"));

    highlighter.syncDoc({ blocks: [{ kind: "codeBlock", language, fence: "```", close: "\n```", code }] });
    await updated.promise;

    expect(vi.mocked(getSyntaxHighlighterPromise)).toHaveBeenLastCalledWith("ini");
    expect(highlighter.getSpans(language, code)).toEqual([
      { from: 0, to: 5, color: "#ff0000" },
      { from: 6, to: 15, color: "#ff0000" },
    ]);
    highlighter.dispose();
  });
});
