import { describe, expect, it } from "vite-plus/test";

import {
  deleteBackward,
  insertLineBreak,
  insertPastedBlocks,
  insertText,
} from "./components/composer/edits";
import { ComposerHistory } from "./components/composer/history";
import {
  type ComposerEditResult,
  type ComposerEditorState,
  collapsedSelection,
  isListPrefix,
  resolveFlatOffset,
} from "./components/composer/types";
import { listIndentForTab, listOutdentForTab } from "./composer-list-continuation";
import { normalizeMarkdownSource } from "./composer-markdown-source";
import {
  buildComposerBlocks,
  buildComposerDoc,
  flatToMarkdown,
  markdownToFlat,
  serializeEditorDoc,
  stepCaretAcrossStyledEdge,
} from "./composer-rich-text-doc";

/** Drives the model as ComposerPromptEditor's beforeinput, keydown, and paste handlers do. `|` marks the caret. */
function composer(initial = "") {
  const caret = initial.indexOf("|");
  const value = initial.replace("|", "");
  const doc = buildComposerDoc(value, () => null, { styling: true });
  let state: ComposerEditorState = {
    doc,
    selection: collapsedSelection(
      markdownToFlat(serializeEditorDoc(doc), caret < 0 ? value.length : caret),
    ),
  };
  const history = new ComposerHistory();
  let clock = 0;
  const commit = (next: ComposerEditResult | null) => {
    if (!next) return;
    const docChanged = next.doc !== state.doc;
    if (docChanged)
      history.record(
        state,
        { docChanged, changeKind: next.changeKind ?? "other" },
        (clock += 10),
        next.inputRuleUndo,
      );
    else history.clearInputRuleUndo();
    const plain = { doc: next.doc, selection: next.selection };
    state = normalizeMarkdownSource(plain, docChanged) ?? plain;
  };
  const api = {
    type(text: string) {
      for (const ch of text)
        commit(
          ch === "\n"
            ? insertLineBreak(state, true)
            : insertText(state, ch, { richText: true, literalText: false }),
        );
      return api;
    },
    backspace() {
      const undoRule = history.consumeInputRuleUndo();
      commit(undoRule ? { ...undoRule, changeKind: "delete" } : deleteBackward(state));
      return api;
    },
    tab(shift = false) {
      const map = serializeEditorDoc(state.doc);
      const at = flatToMarkdown(map, state.selection.head);
      const edit = (shift ? listOutdentForTab : listIndentForTab)(map.value, at, at);
      if (!edit) return api;
      const next = buildComposerDoc(
        map.value.slice(0, edit.start) + edit.replacement + map.value.slice(edit.end),
        () => null,
        { styling: true },
      );
      commit({
        doc: next,
        selection: collapsedSelection(markdownToFlat(serializeEditorDoc(next), edit.cursorAfter)),
        changeKind: "other",
      });
      return api;
    },
    paste(text: string) {
      const res = resolveFlatOffset(state.doc, state.selection.head);
      const nested =
        res.block.kind === "line" &&
        (isListPrefix(res.block.prefix) || res.block.prefix?.kind === "quote");
      commit(
        insertPastedBlocks(
          state,
          buildComposerBlocks(text, () => null, { styling: true, blocks: !nested }),
        ),
      );
      return api;
    },
    arrow(dir: -1 | 1) {
      commit(
        stepCaretAcrossStyledEdge(state, dir) ?? {
          doc: state.doc,
          selection: collapsedSelection(Math.max(0, state.selection.head + dir)),
        },
      );
      return api;
    },
    undo() {
      state = history.undo(state) ?? state;
      return api;
    },
    md() {
      const map = serializeEditorDoc(state.doc);
      const at = flatToMarkdown(map, state.selection.head);
      return `${map.value.slice(0, at)}|${map.value.slice(at)}`;
    },
    /** Markdown with caret, block kinds, and collapsed marks. */
    snap() {
      const blocks = state.doc.blocks.map((b) =>
        b.kind === "line" ? (b.prefix?.kind ?? "p") : b.kind,
      );
      const marks = state.doc.blocks.flatMap((b) =>
        b.kind === "line"
          ? b.inlines.flatMap((i) =>
              i.kind === "text" && i.marks.length > 0 ? [`${i.marks.join("+")}:${i.text}`] : [],
            )
          : [],
      );
      return [api.md(), blocks.join(","), ...marks].join("  ");
    },
  };
  return api;
}

type Composer = ReturnType<typeof composer>;

describe("composer editing", () => {
  it.each<[string, () => Composer, string]>([
    [
      "styles marks once the caret leaves them",
      () => composer().type("Refactor **histogram** and `computeScore()` now"),
      "Refactor **histogram** and `computeScore()` now|  p  bold:histogram  code:computeScore()",
    ],
    [
      "styles italic, __bold__, and strike",
      () => composer().type("*a* __b__ ~~c~~ "),
      "*a* **b** ~~c~~ |  p  italic:a  bold:b  strike:c",
    ],
    [
      "wraps inline code in emphasis",
      () => composer().type("**`x`** z"),
      "**`x`** z|  p  bold+code:x",
    ],
    [
      "keeps delimiters inside an open code span literal",
      () => composer().type("`a **b** c` d"),
      "`a **b** c` d|  p  code:a **b** c",
    ],
    [
      "does not reuse a closed code span's delimiter",
      () => composer().type("`*foo` bar `*x"),
      "`*foo` bar `*x|  p  code:*foo",
    ],
    [
      "converts headings, quotes, and lists as typed",
      () => composer().type("# T\n> q\n\n- a\n\n1. b"),
      "# T\n> q\n- a\n1. b|  heading,quote,bullet,ordered",
    ],
    [
      "continues and leaves lists on Enter",
      () => composer().type("- one\ntwo\n\nafter"),
      "- one\n- two\n\nafter|  bullet,bullet,p",
    ],
    [
      "builds task items",
      () => composer().type("- [x] done\nnext"),
      "- [x] done\n- [ ] next|  task,task",
    ],
    [
      "opens and closes a fence",
      () => composer().type("```ts\nconst a = 1;\n```\nafter"),
      "```ts\nconst a = 1;\n```\nafter|  codeBlock,p",
    ],
    [
      "leaves a code block after two blank lines",
      () => composer("```\ncode|").type("\n\n\nafter"),
      "```\ncode\n```\nafter|  codeBlock,p",
    ],
    [
      "carries code indentation onto the next line",
      () => composer("```\n  foo|\n```").type("\nbar"),
      "```\n  foo\n  bar|\n```  codeBlock",
    ],
    [
      "keeps typing in order after a rule",
      () => composer().type("---abc"),
      "---\nabc|  horizontalRule,p",
    ],
    [
      "moves below a rule on Enter",
      () => composer().type("---\nx"),
      "---\n\nx|  horizontalRule,p,p",
    ],
    [
      "converts a marker typed in front of text",
      () => composer("|existing").type("- [ ] "),
      "- [ ] |existing  task",
    ],
    [
      "converts a heading typed in front of styled text",
      () => composer("|**text**").type("# "),
      "# |**text**  heading",
    ],
    [
      "keeps the marker Backspace restores literal",
      () => composer("|existing").type("* ").backspace().type("x"),
      "* x|existing  p",
    ],
    [
      "leaves a dash inside inline code alone",
      () => composer("`-|text`").type(" "),
      "`- |text`  p",
    ],
    [
      "lifts a nested item on Backspace",
      () => composer("1. a\n   - |b\n2. c").backspace(),
      "1. a\n2. |b\n3. c  ordered,ordered,ordered",
    ],
    [
      "joins a task with no task parent onto the line above",
      () => composer("- a\n  - [ ] x\n  - [ ] |y").backspace(),
      "- a\n  - [ ] x|y  bullet,task",
    ],
    [
      "unwraps a code block on Backspace at its start",
      () => composer("p\n```ts\n|l1\n```").backspace(),
      "p\n|l1  p,p",
    ],
    [
      "lifts an empty nested item on Enter and renumbers",
      () => composer("1. a\n   1. b\n   1. |\n2. z").type("\n"),
      "1. a\n   1. b\n2. |\n3. z  ordered,ordered,ordered,ordered",
    ],
    [
      "indents a list item on Tab",
      () => composer().type("1. a\nb").tab().type("c"),
      "1. a\n   1. bc|  ordered,ordered",
    ],
    ["undoes a list indent", () => composer("- a\n- b|").tab().undo(), "- a\n- b|  bullet,bullet"],
    [
      "pastes lines after a list item",
      () => composer("- a|").paste("one\ntwo"),
      "- a\n\none\ntwo|  bullet,p,p",
    ],
  ])("%s", (_, run, expected) => {
    expect(run().snap()).toBe(expected);
  });

  it("groups typing and deleting into separate undo steps", () => {
    const editor = composer().type("hello world");
    for (let i = 0; i < 5; i += 1) editor.backspace();
    editor.type("there");
    expect(editor.md()).toBe("hello there|");
    expect([editor.undo().md(), editor.undo().md(), editor.undo().md()]).toEqual([
      "hello |",
      "hello world|",
      "|",
    ]);
  });

  it("walks the caret through revealed source one character at a time", () => {
    const editor = composer("a **b** c|");
    const left = Array.from({ length: 10 }, () => editor.arrow(-1).md());
    expect(left).toEqual([
      "a **b** |c",
      "a **b**| c",
      "a **b*|* c",
      "a **b|** c",
      "a **|b** c",
      "a *|*b** c",
      "a |**b** c",
      "a| **b** c",
      "|a **b** c",
      "|a **b** c",
    ]);
  });
});
