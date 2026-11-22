import { getSharedHighlighter } from "@t3tools/shared/highlight";
import { elToHtml } from "@t3tools/shared/markdown";
import { describe, expect, it } from "vite-plus/test";

import { createIncrementalHighlightedDocument } from "./incrementalHighlighting";

// The `<code>` body of a document, with equivalent entity spellings unified.
const codeHtml = (html: string) =>
  html
    .slice(html.indexOf("<code>"))
    .replace(/&(gt|#x3E);/g, ">")
    .replace(/&(quot|#x22);/g, '"')
    .replace(/&(#39|#x27);/g, "'")
    .replaceAll("&#x3C;", "&lt;")
    .replaceAll("&#x26;", "&amp;");

const samples = {
  typescript: "/* multi\nline comment */\nconst x = `template\n${1 + 2}`;\nconst re = /abc/;\n",
  python: '#!/usr/bin/python\nx = """multi\nline"""\nprint(x)\n',
  bash: "#!/bin/bash\ncat <<EOF\nhello\nEOF\necho hi\n",
  html: "<script>\nconst x = 1;\n</script>\n<style>\np {color:red;}\n</style>\n",
  markdown: "# heading\n\n```ts\nconst a = 1;\n```\n\ntext\n",
  rust: 'fn main() {\n let x = r#"multi\nline"#;\n}\n',
  tsx: 'const element = <div\n className="x">\n{value}\n</div>;\n',
  json: '{\n "value": [1,\n 2, 3]\n}\n',
  yaml: "key: |\n  multiline\n  value\nnext: true\n",
  css: '/* comment\n continued */\np::before {\n content: "text";\n}\n',
  sql: "SELECT 'multi\nline'\nFROM table_name;\n",
} as const;

const highlighter = await getSharedHighlighter({ themes: ["pierre-dark", "pierre-light"] });

function expectWholeSourceHtml(
  highlight: ReturnType<typeof createIncrementalHighlightedDocument>,
  text: string,
  language: string,
  theme: string,
  message?: string,
) {
  expect(codeHtml(elToHtml(highlight(text))), message).toBe(
    codeHtml(highlighter.codeToHtml(text, { lang: language, theme })),
  );
}

describe("incremental code highlighting", () => {
  it.each(Object.entries(samples))(
    "matches full HTML at every streaming prefix in %s",
    (language, code) => {
      for (const theme of ["pierre-dark", "pierre-light"] as const) {
        const highlight = createIncrementalHighlightedDocument(highlighter, language, theme);
        for (let end = 0; end <= code.length; end++) {
          expectWholeSourceHtml(
            highlight,
            code.slice(0, end),
            language,
            theme,
            `${theme}, prefix ${end}`,
          );
        }
        highlight.dispose();
      }
    },
  );

  it("resets after edits and truncation, including edits to a completed line", () => {
    const highlight = createIncrementalHighlightedDocument(
      highlighter,
      "typescript",
      "pierre-dark",
    );
    for (const text of [
      "/* open\ncomment\n",
      "/* open\ncomment\n*/\nconst x = 1;",
      "const edited = 2;\nconst x = 1;",
      "const edited = 2;\nconst x = 10;",
      "const edited = 2;\n",
      "",
      "\n\n\nconst fresh = true;\n",
    ]) {
      expectWholeSourceHtml(highlight, text, "typescript", "pierre-dark");
    }
    highlight.dispose();
  });

  // MarkdownCodeBlock creates the document outside its plain-text fallback.
  it("highlights a language without a lexer as plain text", () => {
    const highlight = createIncrementalHighlightedDocument(highlighter, "cobol", "pierre-dark");
    expectWholeSourceHtml(highlight, "MOVE 1 TO X.\n", "cobol", "pierre-dark");
    highlight.dispose();
  });

  it("preserves partial CRLF and CR line endings", () => {
    const highlight = createIncrementalHighlightedDocument(
      highlighter,
      "typescript",
      "pierre-dark",
    );
    const code = "/* multi\r\nline */\r\nconst x = 1;\r\n";
    for (let end = 0; end <= code.length; end++) {
      expectWholeSourceHtml(highlight, code.slice(0, end), "typescript", "pierre-dark");
    }
  });
});
