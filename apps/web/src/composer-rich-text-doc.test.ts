import { describe, expect, it } from "vite-plus/test";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";

import { expandCollapsedComposerCursor } from "./composer-logic";

import {
  buildComposerDoc,
  flatToMarkdown,
  markdownToFlat,
  serializeEditorDoc,
  serializedMarkdownOffset,
  skillChipReplacements,
} from "./composer-rich-text-doc";

function roundTrip(value: string) {
  return serializeEditorDoc(
    buildComposerDoc(value, (name) => ({ label: name, description: null })),
  );
}

describe("editable math source", () => {
  it.each(["app/routes/posts.$postId.tsx", "pages/posts/[id].tsx"])(
    "keeps a mentioned file whose name looks like TeX as a chip: %s",
    (path) => {
      const source = `fix ${serializeComposerFileLink(path)} please`;
      const map = roundTrip(source);
      expect(map.value).toBe(source);
      expect(
        map.runs.filter((run) => run.kind === "token" && run.nodeName === "composer-mention"),
      ).toHaveLength(1);
    },
  );

  it.each([
    "before $x + @README.md$ after",
    "before \\(x + @README.md\\) after",
    "\\[x + @README.md\\] after",
  ])("keeps a mention that ends a formula inside the formula: %s", (source) => {
    const map = roundTrip(source);
    expect(map.value).toBe(source);
    expect(map.runs.some((run) => run.kind === "token")).toBe(false);
  });
});

// Plain mode: the same engine with the mark extensions off. Markers stay
// literal characters and task lines stay paragraphs.
function roundTripPlain(value: string) {
  const json = buildComposerDoc(value, (name) => ({ label: name, description: null }), {
    styling: false,
  });
  return serializeEditorDoc(json);
}

describe("composer rich text document model", () => {
  it.each(["€", "£", "¥", "₹", "₩", "₿", "𑿝"])(
    "canonicalizes %s skill aliases while preserving amounts",
    (prefix) => {
      const value = `Use ${prefix}my-skill for ${prefix}20 please`;
      const expected = `Use $my-skill for ${prefix}20 please`;
      expect(roundTrip(value).value).toBe(expected);
      expect(roundTripPlain(value).value).toBe(expected);
    },
  );

  it.each([
    "",
    "\n\n",
    "plain text",
    "hello **bold** world",
    "a *italic* word and `code` here",
    "struck ~~out~~ now",
    "**`x`**",
    "*`x`*",
    "~~`x`~~",
    "**a `code` c**",
    "***bold italic*** keeps nesting",
    "line one\nline two",
    "trailing newline\n",
    "1. foo\n2. asdf\n",
    "- [ ] buy milk",
    "-   [ ]  buy milk",
    "\t-\t[x]\t\titem",
    "- [ ]  ",
    "- [ ]\n  - [ ] child",
    "  - [ ] first\n - [ ] second\n  - [ ] child",
    "**before @README.md after**",
    "*a **b** c*",
    "*a**b***",
    "**a*b***",
    "**a *b* c**",
    "literal \uFFFC **before @README.md after**",
    "- [x] done\n- [ ] next",
    "- [ ] parent\n  - [ ] child\n  - [ ] sibling\n- [ ] uncle",
    "- [ ] empty task follows\n- [ ]",
    "- [ ] **bold** task with @README.md",
    "para\n- [ ] task\n\npara",
    "- [ ]No space stays literal",
    "-[ ] also literal",
    "@README.md explain this",
    '@"docs/My File.md" and $my-skill please',
    "snake_case stays literal",
    "unmatched ** stays literal",
    "**bold** then @README.md then *italic*",
  ])("round-trips %s ", (value) => {
    expect(roundTrip(value).value).toBe(value);
  });

  it.each([
    "plain text",
    "hello **bold** stays literal",
    "a *italic* stays literal",
    "some `code` stays literal",
    "struck ~~out~~ stays literal",
    "- [ ] stays a paragraph",
    "- [x] stays a paragraph",
    "line one\nline two",
    "@README.md explain this",
    "**bold** then @README.md then *italic*",
  ])("round-trips %s byte-identically in plain mode", (value) => {
    expect(roundTripPlain(value).value).toBe(value);
  });

  it.each([
    "- one\n- two",
    "* star\n* star two",
    "+ plus",
    "* star\n+ plus",
    "1. first\n2. second",
    "1) paren\n2) paren",
    "3. starts at three\n4. four",
    "01. zero padded\n02. two",
    "- parent\n  - child\n  - sibling\n- uncle",
    "1. ordered\n   - bullet child\n2. next",
    "- outer\n  1. inner ordered\n  2. more\n- outer again",
    "-   wide space item",
    "-",
    "1.",
    "- \n- second",
    "- **bold** item with @README.md",
    "- [ ] task\n- bullet after",
    "- bullet\n- [x] task after",
    "para\n- item\n\npara",
    "\t- tab indented\n\t- again",
    "  - leading indent only",
    "- item\n\n- after a blank",
    "- item one\n```ts\ncode\n```\n- item two",
    "-no space stays literal",
    "1.no space stays literal",
    "10. ten\n11. eleven",
  ])("round-trips the list %s ", (value) => {
    expect(roundTrip(value).value).toBe(value);
  });

  it("clamps offsets inside a list marker to the start of the item text", () => {
    const value = "- item";
    const map = roundTrip(value);
    for (let markdown = 0; markdown <= "- ".length; markdown += 1) {
      expect(markdownToFlat(map, markdown)).toBe(0);
    }
    expect(markdownToFlat(map, "- it".length)).toBe(2);
    expect(flatToMarkdown(map, 0)).toBe("- ".length);
  });

  it.each([
    "> quoted",
    "> line one\n> line two",
    ">no space",
    ">  two spaces",
    "> a\n>b",
    ">",
    "> **bold** and @README.md inside",
    "> - looks like a list but stays quote text",
    "> > nested stays literal inside the quote",
    "before\n> quoted",
    "> quote\n\n> another",
    "- item\n> quote after list",
    "> quoted\n\ncomment",
    "> line one\n> line two\n\ncomment",
  ])("round-trips the quote %s", (value) => {
    expect(roundTrip(value).value).toBe(value);
  });

  describe("a paragraph after a quote", () => {
    it("settles on the blank line when a draft glued it to the quote", () => {
      const settled = "before\n> quoted\n\nafter";
      expect(roundTrip("before\n> quoted\nafter").value).toBe(settled);
      expect(roundTrip(settled).value).toBe(settled);
    });

    it.each(["# Heading", "- item", "3. item", "---", "```\ncode\n```"])(
      "leaves %s on the next line, since it opens its own block",
      (next) => {
        const value = `> quoted\n${next}`;
        expect(roundTrip(value).value).toBe(value);
      },
    );
  });

  describe("a dash rule after a paragraph", () => {
    it("is written after a blank line, or Markdown reads the paragraph as a heading", () => {
      const settled = "text\n\n---\nmore";
      expect(roundTrip("text\n---\nmore").value).toBe(settled);
      expect(roundTrip(settled).value).toBe(settled);
    });
  });

  it.each([
    ["text\n---\nmore", "text\n---\nm".length, "text\n\n---\nm".length],
    ["before\n> quoted\nafter", "before\n> quoted\na".length, "before\n> quoted\n\na".length],
    ["__x__\n---\nmore", "__x__\n---\nm".length, "**x**\n\n---\nm".length],
    [
      "*a*_b_\n> q\nx\n> q\nabcde",
      "*a*_b_\n> q\nx\n> q\na".length,
      "*a*_b_\n> q\nx\n> q\na".length,
    ],
    ["a\n---\n", "a".length, "a".length],
  ])("restores a caret in the glued draft %j on the same character", (value, caret, settled) => {
    const map = roundTrip(value);
    const restore = (offset: number) =>
      markdownToFlat(map, serializedMarkdownOffset(value, map.value, offset));
    expect(restore(value.length)).toBe(map.docLength);
    expect(restore(caret)).toBe(markdownToFlat(map, settled));
  });

  it.each([
    "---",
    "***",
    "___",
    "- - -",
    "* * *",
    "-----",
    "---   ",
    "text\n***\nmore",
    "text\n- - -\nmore",
    "- item\n---\n- item two",
    "```\n---\n```",
    "--",
    "-- -",
    "---text",
  ])("round-trips the rule %s ", (value) => {
    expect(roundTrip(value).value).toBe(value);
  });

  it.each([
    "# Heading",
    "## Two",
    "###### Six",
    "####### seven hashes stays a paragraph",
    "#  two spaces",
    "#\tTab",
    "# Trailing hashes stay literal #",
    "#1234",
    "#1234 is a pull request, not a heading",
    "# Heading with **bold** and @README.md",
    "#",
    "# ",
    "text\n# Heading\ntext",
    "# Heading\n- item\n> quote\n---",
  ])("round-trips the heading %s ", (value) => {
    expect(roundTrip(value).value).toBe(value);
  });

  it.each([
    "```\ncode\n```",
    "```ts\nconst a = 1;\n```",
    "```ts\nconst a = 1;\n```\n",
    "before\n```ts\nconst a = 1;\n```\nafter",
    "```\n```",
    "```ts\nline one\nline two\nline three\n```",
    "```ts\n  indented\n    deeper\n```",
    "```js title=example\ncode\n```",
    "~~~py\ncode\n~~~",
    "````\n```\n````",
    "```ts\ncode without a closing fence",
    "```",
    "```ts\n**not bold** and @README.md stay literal\n```",
    "```ts\ncode\n````",
    "- [ ] task\n```ts\ncode\n```\n- [ ] after",
    "  ```ts\nindented fence stays a paragraph\n  ```",
  ])("round-trips the fenced block %s", (value) => {
    expect(roundTrip(value).value).toBe(value);
  });

  it("keeps the caret inside an empty fence", () => {
    const value = "before\n```\n```";
    const map = roundTrip(value);
    const inside = "before\n".length;
    expect(flatToMarkdown(map, inside)).toBe("before\n```".length);
    expect(markdownToFlat(map, flatToMarkdown(map, inside))).toBe(inside);
  });

  it("clamps offsets inside a fence to the edge of the code", () => {
    const value = "```ts\nab\n```";
    const map = roundTrip(value);
    expect(map.value).toBe(value);
    for (let markdown = 0; markdown <= "```ts\n".length; markdown += 1) {
      expect(markdownToFlat(map, markdown)).toBe(0);
    }
    expect(markdownToFlat(map, "```ts\na".length)).toBe(1);
    for (let markdown = "```ts\nab".length; markdown <= value.length; markdown += 1) {
      expect(markdownToFlat(map, markdown)).toBe(2);
    }
  });

  it("keeps a chip's source in a fence as literal text", () => {
    const value = "```\nsee @b.md and $babysit now model:codex/gpt-6.1 ok\n```\nafter";
    const known = () => ({ label: "Babysit", description: null });
    const anyModel = () => true;
    const doc = buildComposerDoc(value, known, { isKnownModel: anyModel });
    const map = serializeEditorDoc(doc);
    expect(map.value).toBe(value);
    expect(map.runs.filter((run) => run.kind === "token")).toEqual([]);
    for (let flat = 0; flat <= map.docLength; flat += 1) {
      expect(markdownToFlat(map, flatToMarkdown(map, flat))).toBe(flat);
    }
    // Reconciling against the provider's skills and models leaves the code alone too.
    expect(skillChipReplacements(doc, known, anyModel)).toEqual([]);
  });

  it.each([
    "plain prose with no styling at all",
    "a chip @README.md counts one character in both modes",
    "$my-skill leads the line",
    "trailing newline\n",
  ])("resolves a collapsed cursor identically in both modes for %s", (value) => {
    const rich = roundTrip(value);
    const plain = roundTripPlain(value);
    expect(rich.value).toBe(value);
    expect(plain.value).toBe(value);
    for (let collapsed = 0; collapsed <= value.length; collapsed += 1) {
      const markdown = expandCollapsedComposerCursor(value, collapsed);
      expect(flatToMarkdown(rich, markdownToFlat(rich, markdown))).toBe(
        flatToMarkdown(plain, markdownToFlat(plain, markdown)),
      );
    }
  });

  it("clamps a cursor that was sitting inside a marker onto the styled text", () => {
    const value = "a **bold** c";
    const plain = roundTripPlain(value);
    const rich = roundTrip(value);
    expect(flatToMarkdown(plain, markdownToFlat(plain, 3))).toBe(3);
    expect(flatToMarkdown(rich, markdownToFlat(rich, 3))).toBe(4);
  });
});
