// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  codeToHast,
  codeToHtml,
  codeToTokens,
  compileTextMateTheme,
  contrastOnLightCode,
  createEditorTokenizer,
  createStreamTokenizer,
  DEFAULT_THEMES,
  disposeHighlighter,
  getFiletypeFromFileName,
  getInitialState,
  getResolvedOrResolveTheme,
  getSharedHighlighter,
  isKnownLanguage,
  LINE_END,
  preloadHighlighter,
  readableOnLightCode,
  readableSyntaxColor,
  registerCustomTheme,
  renderTokenLines,
  resolveLanguage,
  resolveTheme,
  setCustomExtension,
  stateEquals,
  tokenizeCompact,
  tokenizeLine,
  tokenizeRecords,
  TOKEN_NAMES,
  type ThemedToken,
} from "./index.ts";

/** `[text, tokenName]` runs for a document, one array per line. */
function runs(language: string, code: string): Array<Array<[string, string]>> {
  const records = tokenizeRecords(code, language);
  const lines: Array<Array<[string, string]>> = [[]];
  let start = 0;
  for (let i = 0; i < records.length; i += 2) {
    if (records[i + 1] === LINE_END) {
      lines.push([]);
      start = records[i]!;
      continue;
    }
    lines[lines.length - 1]!.push([code.slice(start, records[i]), TOKEN_NAMES[records[i + 1]!]!]);
    start = records[i]!;
  }
  return lines;
}

/** The token covering the first character of `needle` (after `from`). */
function tokenOf(language: string, code: string, needle: string): string {
  const at = code.indexOf(needle);
  if (at < 0) throw new Error(`missing ${needle}`);
  const records = tokenizeRecords(code, language);
  for (let i = 0; i < records.length; i += 2) {
    if (records[i + 1] !== LINE_END && records[i]! > at) return TOKEN_NAMES[records[i + 1]!]!;
  }
  return "none";
}

const CASES: ReadonlyArray<readonly [string, string, ReadonlyArray<readonly [string, string]>]> = [
  [
    "typescript",
    "import { a } from 'b';\nexport async function f<T>(x: number): Promise<void> {}",
    [
      ["import", "keyword.import"],
      ["'b'", "string"],
      ["f<", "function.definition"],
      ["x:", "variable.parameter"],
      ["number", "type.builtin"],
      ["Promise", "type"],
    ],
  ],
  [
    "typescript",
    "const re = /a[/]b/g; const d = a / b / c;\n/** @param {string} name the name */",
    [
      ["/a[", "string.regex"],
      ["/ b", "operator"],
      ["@param", "keyword.jsdoc"],
      ["{string}", "type.jsdoc"],
      ["name the", "variable.jsdoc"],
    ],
  ],
  [
    "tsx",
    "const el = <Foo.Bar on={x}>hi <b>{y}</b></Foo.Bar>;\nconst g = <T,>(v: T) => v;",
    [
      ["Foo.Bar on", "tag.component.jsx"],
      ["on=", "attribute.jsx"],
      ["hi", "text.jsx"],
      ["b>{", "tag.jsx"],
      ["y}", "variable"],
      ["<T,", "operator"],
    ],
  ],
  [
    "python",
    "@cache\ndef f(self, x=1):\n    return f\"{x!r} {{lit}}\" if x is None else b'\\x00'",
    [
      ["@cache", "attribute"],
      ["f(", "function.definition"],
      ["self", "variable.special"],
      ["x=", "variable.parameter"],
      ["{x", "punctuation.special"],
      ["{{", "string.escape"],
      ["is", "keyword.operator"],
      ["None", "constant.builtin"],
      ["\\x00", "string.escape"],
    ],
  ],
  [
    "rust",
    '#[derive(Debug)]\nfn f<\'a>(s: &\'a str) -> String { println!("{}", r#"raw "x""#); }',
    [
      ["#[", "attribute"],
      ["derive", "attribute"],
      ["f<", "function.definition"],
      ["'a>", "label"],
      ["str", "type.builtin"],
      ["println", "function"],
      ["r#", "string"],
    ],
  ],
  [
    "go",
    "package main\nfunc (s *S) Run(ctx context.Context) error { return nil }",
    [
      ["main", "namespace"],
      ["s *", "variable.parameter"],
      ["S)", "type"],
      ["Run", "function.definition"],
      ["nil", "constant.builtin"],
    ],
  ],
  [
    "c",
    '#include <stdio.h>\nint main(void) { printf("%d\\n", NULL); }',
    [
      ["#include", "preproc"],
      ["<stdio.h>", "string"],
      ["int", "type.builtin"],
      ["printf", "function"],
      ["\\n", "string.escape"],
      ["NULL", "constant.builtin"],
    ],
  ],
  [
    "cpp",
    'namespace app { auto s = R"x(a " b)x"; std::vector<int> v; }',
    [
      ["app", "namespace"],
      ['R"x(', "string"],
      ["std", "namespace"],
    ],
  ],
  [
    "csharp",
    'public record P(int X) { string S => $"v={X}"; }',
    [
      ["record", "keyword.declaration"],
      ["P(", "type.class"],
      ['$"v', "string"],
      ["{X", "punctuation.special"],
    ],
  ],
  [
    "java",
    "@Override public String f() { return this.x; }",
    [
      ["@Override", "attribute"],
      ["String", "type"],
      ["this", "variable.special"],
      ["x;", "property"],
    ],
  ],
  [
    "kotlin",
    'fun f(name: String) = "hi $name ${name.length}"',
    [
      ["f(", "function.definition"],
      ["$name ", "variable"],
      ["${", "punctuation.special"],
    ],
  ],
  [
    "swift",
    'func f() -> String { return "\\(x) y" }',
    [
      ["f(", "function.definition"],
      ["\\(", "punctuation.special"],
    ],
  ],
  [
    "bash",
    'export A=1\nfor f in *.ts; do echo "$f" $(wc -l < "$f"); done # end',
    [
      ["A", "variable"],
      ["1", "number"],
      ["for", "keyword.control"],
      ["f in", "variable"],
      ["echo", "function"],
      ["$f", "variable"],
      ["$(", "punctuation.special"],
      ["wc", "function"],
      ["-l", "variable.parameter"],
      ["# end", "comment"],
    ],
  ],
  [
    "powershell",
    "$x = Get-Item -Path $env:HOME\nif ($x -eq $null) { Write-Host 'n' } # c",
    [
      ["$x", "variable"],
      ["-eq", "keyword.operator"],
      ["$null", "constant.builtin"],
      ["'n'", "string"],
      ["# c", "comment"],
    ],
  ],
  [
    "html",
    '<!doctype html><a href="x">&amp;</a><script>let a = 1 < 2;</script><style>p { color: red }</style>',
    [
      ["<!doctype", "tag.doctype"],
      ["href", "attribute"],
      ['"x"', "string"],
      ["&amp;", "string.special"],
      ["let", "keyword.declaration"],
      ["</script", "punctuation.bracket.html"],
      ["color", "property"],
    ],
  ],
  [
    "vue",
    '<template><p :id="a.b">{{ msg }}</p></template>',
    [
      [":id", "attribute"],
      ["a.b", "variable"],
      ["{{", "punctuation.special"],
      ["msg", "variable"],
    ],
  ],
  [
    "svelte",
    '<script lang="ts">let n: number = 1;</script>\n{#if n}<p>{n}</p>{/if}',
    [
      ["number", "type.builtin"],
      ["{#if", "punctuation.special"],
    ],
  ],
  [
    "astro",
    "---\nconst title = 'x';\n---\n<h1>{title}</h1>",
    [
      ["const", "keyword.declaration"],
      ["h1", "tag"],
      ["title}", "variable"],
    ],
  ],
  [
    "css",
    "@media (min-width: 4px) { .a:hover > #b::after { --c: var(--d) !important; margin: -1.5em 0 } }",
    [
      ["@media", "keyword"],
      ["min-width", "property"],
      [".a", "selector.class"],
      [":hover", "selector.pseudo"],
      ["#b", "selector.id"],
      ["--c", "variable"],
      ["var", "function"],
      ["!important", "keyword"],
      ["-1.5em", "number"],
    ],
  ],
  [
    "scss",
    "$w: 2px; .a { &:hover { width: $w; } // c\n}",
    [
      ["$w:", "variable"],
      ["&", "variable.special"],
      ["width", "property"],
      ["// c", "comment"],
    ],
  ],
  [
    "json",
    '{"k": [1, -2.5e3, true, null, "s\\n"]}',
    [
      ['"k"', "property.json_key"],
      ["-2.5e3", "number"],
      ["true", "boolean"],
      ["null", "constant.builtin"],
      ["\\n", "string.escape"],
    ],
  ],
  [
    "yaml",
    'a: 1\nb: |\n  text: not a key\nc: [x, "y"] # c\nd: &x *y',
    [
      ["a", "property"],
      ["1", "number"],
      ["text:", "string"],
      ["c:", "property"],
      ['"y"', "string"],
      ["# c", "comment"],
      ["&x", "type"],
    ],
  ],
  [
    "toml",
    '[tool.x]\nname = "n" # c\nlist = [1, 2.5, true]\ns = """\nmulti\n"""',
    [
      ["tool.x", "type"],
      ["name", "property"],
      ['"n"', "string"],
      ["# c", "comment"],
      ["2.5", "number"],
      ["true", "boolean"],
      ["multi", "string"],
    ],
  ],
  [
    "ini",
    "[core]\neditor = vim ; c\n# comment",
    [
      ["core", "type"],
      ["editor", "property"],
      ["vim", "string"],
      ["; c", "comment"],
      ["# comment", "comment"],
    ],
  ],
  [
    "dotenv",
    "export KEY=${HOME}/x",
    [
      ["export", "keyword"],
      ["KEY", "property"],
      ["${HOME}", "variable"],
    ],
  ],
  [
    "markdown",
    "# Title\nSome **bold** and `code` and [link](http://x).\n- item\n> quote",
    [
      ["# Title", "title"],
      ["**bold**", "emphasis.strong"],
      ["`code`", "text.literal"],
      ["link", "link_text"],
      ["http://x", "link_uri"],
      ["- ", "punctuation.list_marker"],
      ["> ", "punctuation.markup"],
    ],
  ],
  [
    "sql",
    "SELECT id, count(*) FROM t WHERE name = 'o''k' AND x IS NULL -- c",
    [
      ["SELECT", "keyword"],
      ["count", "function"],
      ["'o''k'", "string"],
      ["AND", "keyword.operator"],
      ["NULL", "constant.builtin"],
      ["-- c", "comment"],
    ],
  ],
  [
    "diff",
    "@@ -1 +1 @@\n-old\n+new\n same",
    [
      ["@@", "attribute"],
      ["old", "diff.minus"],
      ["new", "diff.plus"],
    ],
  ],
  [
    "dockerfile",
    'FROM node:22 AS build\nRUN npm ci && \\\n    echo "$X"\nENV A=1',
    [
      ["FROM", "keyword"],
      ["AS", "keyword"],
      ["npm", "function"],
      ["echo", "function"],
      ["$X", "variable"],
      ["ENV", "keyword"],
      ["A=", "variable"],
    ],
  ],
  [
    "makefile",
    "CC := gcc\nall: main.o\n\t$(CC) -o app main.o # build",
    [
      ["CC", "variable"],
      [":=", "operator"],
      ["all", "function"],
      ["$(", "punctuation.special"],
      ["-o", "variable.parameter"],
      ["# build", "comment"],
    ],
  ],
  [
    "graphql",
    "query Q($id: ID!) { user(id: $id) @include(if: true) { name } }",
    [
      ["query", "keyword.declaration"],
      ["$id", "variable"],
      ["ID", "type.builtin"],
      ["@include", "attribute"],
    ],
  ],
  [
    "ruby",
    'def go?(x) = "#{x}" if x\nputs :sym, key: 1, @ivar',
    [
      ["go?", "function.definition"],
      ["#{", "punctuation.special"],
      [":sym", "string.special.symbol"],
      ["key:", "string.special.symbol"],
      ["@ivar", "variable"],
    ],
  ],
  [
    "php",
    '<?php\nnamespace App;\n$this->name = "hi {$x}"; # c',
    [
      ["<?php", "preproc"],
      ["App", "namespace"],
      ["$this", "variable.special"],
      ["name =", "property"],
      ["{$", "punctuation.special"],
      ["# c", "comment"],
    ],
  ],
  [
    "lua",
    "local function f(a) return a end --[[ long\ncomment ]] print([==[raw]==])",
    [
      ["local", "keyword.declaration"],
      ["f(", "function.definition"],
      ["--[[", "comment"],
      ["comment", "comment"],
      ["[==[", "string"],
    ],
  ],
  [
    "zig",
    'const std = @import("std");\npub fn main() !void {}',
    [
      ["@import", "attribute"],
      ["main", "function.definition"],
      ["void", "type.builtin"],
    ],
  ],
  [
    "haskell",
    "{- a {- nested -} still -}\nmain :: IO ()",
    [
      ["still", "comment"],
      ["IO", "type"],
    ],
  ],
  [
    "elixir",
    'defmodule M do\n  def f(x), do: "#{x}" <> :ok\nend',
    [
      ["M", "type.class"],
      ["f(", "function.definition"],
      ["#{", "punctuation.special"],
      [":ok", "string.special.symbol"],
    ],
  ],
  [
    "nix",
    '{ pkgs ? import <nixpkgs> {} }: let x = "${pkgs.hello}"; in x',
    [
      ["import", "keyword"],
      ["${", "punctuation.special"],
    ],
  ],
  [
    "hcl",
    'resource "aws_instance" "web" {\n  ami = "${var.ami}"\n}',
    [
      ["resource", "keyword"],
      ["ami", "property"],
      ["${", "punctuation.special"],
    ],
  ],
  [
    "verilog",
    "module top(input wire clk);\n  always @(posedge clk) q <= 1; // c\nendmodule",
    [
      ["module", "keyword"],
      ["posedge", "keyword"],
      ["// c", "comment"],
    ],
  ],
  [
    "asm",
    "start:\n  mov eax, 42 ; answer\n  .section .text",
    [
      ["start", "label"],
      ["mov", "keyword"],
      ["eax", "variable.special"],
      ["42", "number"],
      ["; answer", "comment"],
      [".section", "preproc"],
    ],
  ],
  [
    "lisp",
    '(defn greet [name] (str "hi " name :k))',
    [
      ["defn", "keyword.declaration"],
      ["str", "function"],
      ['"hi "', "string"],
      [":k", "string.special.symbol"],
    ],
  ],
  [
    "wasm",
    "(module (func $add (param i32) (result i32) local.get 0))",
    [
      ["module", "keyword"],
      ["$add", "variable"],
      ["i32", "type.builtin"],
    ],
  ],
  [
    "regex",
    "^(?:a|b)+\\d{2,3}[a-z]$",
    [
      ["^", "keyword"],
      ["(?:", "punctuation.bracket"],
      ["|", "operator"],
      ["\\d", "string.escape"],
      ["{2,3}", "operator"],
      ["[a-z]", "string.special"],
    ],
  ],
];

describe("lexers", () => {
  it.each(CASES)("%s: %s", (language, code, expectations) => {
    const lines = runs(language, code);
    expect(lines.map((line) => line.map(([text]) => text).join("")).join("\n")).toBe(code);
    for (const [needle, token] of expectations)
      expect([needle, tokenOf(language, code, needle)]).toEqual([needle, token]);
  });

  it("carries multi-line constructs across lines", () => {
    const cases: ReadonlyArray<readonly [string, string, string, string]> = [
      ["typescript", "/* a\n /* b\n*/ x", " /* b", "comment"],
      ["typescript", "const s = `a ${\n  `in ${x}`\n} b\nc` + 1", "c`", "string"],
      ["tsx", 'return (\n  <div\n    id="a"\n  >\n    text\n  </div>\n);', "text", "text.jsx"],
      ["python", "s = '''one\ntwo\n'''\nx = 1", "two", "string"],
      ["python", 's = f"""{\nx\n}"""', "x", "variable"],
      ["rust", 'let s = r##"a\n"# still\n"##; let y = 1;', "still", "string"],
      ["rust", "/* a /* b */\n c */ fn", " c */", "comment"],
      ["go", "x := `line\nsecond`\ny := 1", "second`", "string"],
      ["cpp", 'auto s = R"d(\n)" not end\n)d";', ')" not', "string"],
      ["toml", "a = '''\nraw \\n\n'''", "raw", "string"],
      ["bash", "cat <<-EOF\n\tbody $X\n\tEOF\necho done", "body", "string"],
      ["bash", "cat <<'EOF'\n$NOT_VAR\nEOF", "$NOT", "string"],
      ["ruby", "x = <<~SQL\n  SELECT #{col}\nSQL\nputs x", "col", "variable"],
      ["html", "<script>\nconst a =\n  1;\n</script>\n<p>", "const", "keyword.declaration"],
      ["html", "<!--\ncomment\n-->", "comment\n", "comment"],
      ["markdown", "```rust\nfn main() {}\n```\nafter", "fn", "keyword.declaration"],
      ["markdown", "---\ntitle: x\n---\n# H", "title", "property"],
      ["yaml", "k: >-\n  folded\n  more\nn: 1", "more", "string"],
      ["haskell", "{- a\n{- b -}\nc -} x", "c -}", "comment"],
      ["lua", "--[==[\n]] still\n]==] x", "still", "comment"],
      ["powershell", "<#\nhelp\n#> $x", "help", "comment"],
      ["php", "<?php\n$s = <<<EOT\n  hi $name\n  EOT;\n$y = 1;", "$name", "variable"],
    ];
    for (const [language, code, needle, token] of cases) {
      expect([language, needle, tokenOf(language, code, needle)]).toEqual([
        language,
        needle,
        token,
      ]);
    }
  });

  it("keeps an over-long line plain while its state still advances", () => {
    const code = `${" ".repeat(1_001)}/*\nstill comment\n*/ x`;
    const [long] = runs("typescript", code);
    expect(long).toEqual([[`${" ".repeat(1_001)}/*`, "none"]]);
    expect(tokenOf("typescript", code, "still")).toBe("comment");
    const { pairs, endState } = tokenizeLine(
      "x".repeat(2_000),
      getInitialState("typescript"),
      1_000,
    );
    expect(Array.from(pairs)).toEqual([2_000, 0]);
    expect(stateEquals(endState, getInitialState("typescript"))).toBe(true);
  });
});

const STREAM_SAMPLES: ReadonlyArray<readonly [string, string]> = [
  ["typescript", "const a = `x ${b /* c */}\r\ny`;\n// done\n"],
  ["tsx", "<A b={1}>\n  t {c}\n</A>"],
  ["python", "def f():\n    '''d\n    oc'''\n    return f\"{x}\"\n"],
  ["rust", 'fn a<\'b>() { r#"x\n"# }'],
  ["go", "s := `a\nb`\n"],
  ["bash", "cat <<EOF\n$a\nEOF\nls -la | wc"],
  ["html", '<p a="1">\n<script>x()</script>\n'],
  ["css", "a { color: red; }\n/* c\n*/"],
  ["markdown", "# h\n```js\nlet x\n```\n*e*"],
  ["yaml", "a: |\n  b\nc: 1"],
  ["json", '{"a": [1,\n2]}'],
  ["sql", "select 'a\n' from t -- x"],
  ["ansi", "\x1b[31mred\x1b[0m plain\n\x1b[1mbold"],
];

describe("stream tokenizer", () => {
  it.each(STREAM_SAMPLES)("%s matches codeToTokens at every prefix", (language, code) => {
    const stream = createStreamTokenizer({ lang: language, theme: "pierre-dark" });
    const committed: ThemedToken[] = [];
    let provisional: ThemedToken[] = [];
    for (let at = 0; at < code.length; at++) {
      const update = stream.enqueue(code[at]!);
      expect(update.recall).toBe(provisional.length);
      committed.push(...update.stable);
      provisional = update.unstable;
      // Line-break tokens are the only uncolored ones.
      const shown = [...committed, ...provisional].filter(
        (token) => token.color !== undefined || !/^[\r\n]$/u.test(token.content),
      );
      const prefix = code.slice(0, at + 1);
      const expected = codeToTokens(prefix, { lang: language, theme: "pierre-dark" }).tokens.flat();
      expect(shown).toEqual(expected);
    }
    expect(stream.close().stable).toEqual(provisional);
  });

  it("clones and clears", () => {
    const stream = createStreamTokenizer({ lang: "typescript", theme: "pierre-dark" });
    stream.enqueue("/* open\n");
    const copy = stream.clone();
    expect(copy.enqueue("x */ y").unstable.map((token) => token.type)).toContain(1);
    stream.clear();
    expect(stream.enqueue("x */ y").unstable.some((token) => token.type === 1)).toBe(false);
  });
});

describe("editor tokenizer", () => {
  it("re-tokenizes until states converge and matches a fresh tokenizer", () => {
    const text = "const a = 1;\nconst b = `x\ny`;\n// c\nfunction f() {\n  return a;\n}";
    const editor = createEditorTokenizer({ lang: "typescript", theme: "pierre-dark", text });
    const lines = text.split("\n");
    const check = () => {
      const fresh = createEditorTokenizer({
        lang: "typescript",
        theme: "pierre-dark",
        text: lines.join("\n"),
      });
      for (let line = 0; line < lines.length; line++)
        expect(editor.getLineTokens(line)).toEqual(fresh.getLineTokens(line));
    };
    check();
    expect(editor.edit(0, 1, ["const a = 2;"])).toEqual([0, 1]);
    lines[0] = "const a = 2;";
    check();
    const opened = editor.edit(2, 1, ["/* c"]);
    lines[2] = "/* c";
    expect(opened).toEqual([2, lines.length]);
    check();
    editor.edit(4, 0, ["*/"]);
    lines.splice(4, 0, "*/");
    check();
    editor.edit(1, 2, []);
    lines.splice(1, 2);
    check();
    expect(editor.getStringCommentRegexpRangesInLine(1)).toEqual([[0, 4]]);
    expect(editor.getHighlightedTokens(0)[0]).toEqual([0, "#ff678d", "const "]);
  });
});

describe("themes", () => {
  it("resolves the built-in palettes", () => {
    const dark = resolveTheme(DEFAULT_THEMES.dark);
    const light = resolveTheme(DEFAULT_THEMES.light);
    expect([dark.fg, dark.bg, light.fg, light.bg]).toEqual([
      "#fafafa",
      "#0a0a0a",
      "#0a0a0a",
      "#ffffff",
    ]);
    expect(dark.styles).toHaveLength(73);
    expect(dark.styles[TOKEN_NAMES.indexOf("comment")]).toEqual(["#737373", 0]);
    expect(dark.styles[TOKEN_NAMES.indexOf("title")]).toEqual(["#ff855e", 2]);
    expect(dark.styles[TOKEN_NAMES.indexOf("emphasis")]).toEqual(["#fafafa", 1]);
    expect(dark.ansi[1]).toBe("#ff2e3f");
  });

  it("keeps every t3-light syntax color readable on light code", () => {
    const light = resolveTheme("pierre-light");
    const readable = resolveTheme("t3-light");
    readable.styles.forEach(([color], id) => {
      expect(color).toBe(
        id === 0 || id >= 71 ? light.fg : readableSyntaxColor(light.styles[id]![0]),
      );
      const further = ["#1ca1c7", "#636363", "#1a85d4"].includes(light.styles[id]![0]);
      expect([TOKEN_NAMES[id], contrastOnLightCode(color) >= (further ? 6 : 4.5)]).toEqual([
        TOKEN_NAMES[id],
        true,
      ]);
    });
  });

  it("compiles TextMate and registered Zed themes", async () => {
    const textMate = compileTextMateTheme({
      name: "tm",
      type: "dark",
      colors: {
        "editor.foreground": "#ccc",
        "editor.background": "#111",
        "terminal.ansiBrightRed": "#f00",
      },
      tokenColors: [
        { scope: "comment", settings: { foreground: "#888888", fontStyle: "italic" } },
        { scope: ["keyword", "storage.type"], settings: { foreground: "#ff0000" } },
        { scope: "keyword.control", settings: { foreground: "#00ff00", fontStyle: "bold" } },
        { scope: "source entity.name.function", settings: { foreground: "#0000ff" } },
      ],
    });
    const style = (name: string) => textMate.styles[TOKEN_NAMES.indexOf(name as never)];
    expect(textMate.fg).toBe("#cccccc");
    expect(style("comment.doc")).toEqual(["#888888", 1]);
    expect(style("keyword.control")).toEqual(["#00ff00", 2]);
    expect(style("keyword.import")).toEqual(["#00ff00", 2]);
    expect(style("keyword.declaration")).toEqual(["#ff0000", 0]);
    expect(style("function.method")).toEqual(["#0000ff", 0]);
    expect(style("string")).toEqual(["#cccccc", 0]);
    expect(textMate.ansi[9]).toBe("#ff0000");

    registerCustomTheme("zed-test", async () => ({
      name: "Zed Test",
      appearance: "light",
      style: {
        "editor.foreground": "#123456",
        syntax: { keyword: { color: "#abcdef", font_style: "italic" } },
      },
    }));
    const pending = getResolvedOrResolveTheme("zed-test");
    expect(pending).toBeInstanceOf(Promise);
    const zed = await pending;
    expect(zed.styles[TOKEN_NAMES.indexOf("keyword.control")]).toEqual(["#abcdef", 1]);
    expect(getResolvedOrResolveTheme("zed-test")).toBe(zed);
    expect(codeToTokens("if", { lang: "typescript", theme: "zed-test" }).tokens[0]![0]!.color).toBe(
      "#abcdef",
    );
  });
});

describe("ansi", () => {
  it("strips SGR escapes and carries styles across lines", () => {
    const code =
      "\x1b[1;31mbold red\x1b[0m \x1b[38;5;196mx\x1b[48;2;1;2;3my\n\x1b[3;4;9mz\x1b[39;49m\x1b]8;;http://a\x07w";
    const { tokens } = codeToTokens(code, { lang: "ansi", theme: "pierre-dark" });
    const plain = tokens.map((line) =>
      line.map((token) => [
        token.content,
        token.offset,
        token.color,
        token.bgColor,
        token.fontStyle,
      ]),
    );
    expect(plain).toEqual([
      [
        ["bold red", 7, "#ff2e3f", undefined, 2],
        [" ", 19, "#fafafa", undefined, 0],
        ["x", 31, "#ff0000", undefined, 0],
        ["y", 45, "#ff0000", "#010203", 0],
      ],
      [
        ["z", 55, "#ff0000", "#010203", 13],
        ["w", 78, "#fafafa", undefined, 13],
      ],
    ]);
    expect(tokenizeCompact(code, "ansi").highlightLine(1, "pierre-dark")).toEqual([
      { content: "z", color: "#ff0000", fontStyle: 13 },
      { content: "w", color: null, fontStyle: 13 },
    ]);
  });
});

describe("emitters", () => {
  it("renders escaped HTML and HAST", async () => {
    const html = codeToHtml("a < b && '\"'", { lang: "typescript", theme: "pierre-dark" });
    expect(html).toContain("&lt;");
    expect(html).toContain("&amp;&amp;");
    expect(html).toContain("&#39;&quot;&#39;");
    expect(
      html.startsWith('<pre class="highlights" style="background-color:#0a0a0a;color:#fafafa"'),
    ).toBe(true);
    const hast = codeToHast("a\nb", { lang: "text", theme: "pierre-light" });
    expect(hast.children[0]!.children[0]).toMatchObject({
      tagName: "code",
      children: [{ tagName: "span" }, { type: "text", value: "\n" }, { tagName: "span" }],
    });
    await preloadHighlighter({ themes: ["t3-light"] });
    const highlighter = await getSharedHighlighter({ themes: ["t3-light", "pierre-dark"] });
    expect(highlighter.codeToTokens("x", { lang: "text", theme: "t3-light" }).tokens).toHaveLength(
      1,
    );
    await disposeHighlighter();
    expect(highlighter.isDisposed).toBe(true);
    const [line] = renderTokenLines([[{ content: "a", offset: 0, color: "#fff", fontStyle: 2 }]]);
    expect(line!.children[0]).toMatchObject({
      properties: { style: "color:#fff;font-weight:bold" },
    });
    expect(readableOnLightCode("#ffffff80")).toMatch(/^#[0-9a-f]{6}80$/u);
  });

  it("styles multiple themes with CSS variables", () => {
    const [token] = codeToTokens("if", {
      lang: "typescript",
      themes: { light: "t3-light", dark: "pierre-dark" },
    }).tokens[0]!;
    expect(token!.htmlStyle).toEqual({
      color: resolveTheme("t3-light").styles[18]![0],
      "--hls-dark": "#ff678d",
    });
  });
});

describe("languages", () => {
  it.each([
    ["Dockerfile", "dockerfile"],
    ["src/Makefile", "makefile"],
    ["CMakeLists.txt", "cmake"],
    ["Justfile", "just"],
    ["Gemfile", "ruby"],
    ["Rakefile", "ruby"],
    ["CODEOWNERS", "codeowners"],
    ["Cargo.lock", "toml"],
    ["go.mod", "go"],
    [".bashrc", "bash"],
    [".env", "dotenv"],
    [".env.local", "dotenv"],
    [".gitignore", "ini"],
    ["a/b.component.ts", "angular-ts"],
    ["x.S", "asm"],
    ["x.sv", "systemverilog"],
    ["x.vhd", "vhdl"],
    ["x.luau", "lua"],
    ["x.xslt", "xml"],
    ["x.unknownext", "text"],
  ])("%s is %s", (path, language) => {
    expect(getFiletypeFromFileName(path)).toBe(language);
  });

  it("resolves hints, paths, and custom extensions", () => {
    expect(resolveLanguage({ language: "TS", path: "a.py" })).toBe("typescript");
    expect(resolveLanguage({ language: "nope", path: "a.py" })).toBe("python");
    expect(resolveLanguage("src/a.svh")).toBe("verilog");
    expect(isKnownLanguage("shellscript")).toBe(true);
    expect(isKnownLanguage("text")).toBe(false);
    setCustomExtension("weird", "rust");
    expect(getFiletypeFromFileName("a.weird")).toBe("rust");
  });
});

it("uses no RegExp lookbehind, which Hermes lacks", () => {
  const roots = [NodePath.join(import.meta.dirname), NodePath.join(import.meta.dirname, "../diff")];
  for (const root of roots) {
    for (const file of NodeFS.readdirSync(root).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    )) {
      const source = NodeFS.readFileSync(NodePath.join(root, file), "utf8");
      expect([file, /\(\?<[=!]/u.test(source)]).toEqual([file, false]);
    }
  }
});
