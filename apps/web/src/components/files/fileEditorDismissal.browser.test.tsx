import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

import { isMacPlatform } from "~/lib/utils";
import type { Editor } from "~/ui-core/codeView/Editor";
import { File } from "~/ui-core/codeView/File";
import { installFileEditorDismissal } from "./fileEditorDismissal";

function pressFind(content: HTMLElement) {
  const isMac = isMacPlatform(navigator.platform);
  content.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "f",
      code: "KeyF",
      metaKey: isMac,
      ctrlKey: !isMac,
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe("installFileEditorDismissal", () => {
  it("keeps a text selection made outside the file while its search is open", async () => {
    let editor: Editor | undefined;
    await using screen = await render(
      <>
        <p>Assistant reply</p>
        <div data-testid="file-surface">
          <File
            file={{ name: "server.ts", contents: "const server = 1;\n" }}
            edit
            editorOptions={{ onAttach: (attached) => (editor = attached) }}
          />
        </div>
      </>,
    );
    const content = screen.container.querySelector<HTMLElement>("diffs-file [data-content]");
    expect(content).toBeTruthy();

    editor!.setSelections([
      { start: { line: 0, character: 8 }, end: { line: 0, character: 8 }, direction: "none" },
    ]);
    pressFind(content!);
    await vi.waitFor(() => expect(CSS.highlights.get("diffs-search-current")?.size).toBe(1));

    using _dismissal = {
      [Symbol.dispose]: installFileEditorDismissal({
        root: screen.getByTestId("file-surface").element() as HTMLElement,
        editor: editor!,
        isBlocked: () => false,
        onDismiss: () => {},
      }),
    };
    const reply = screen.getByText("Assistant reply").element();
    const range = document.createRange();
    range.selectNodeContents(reply);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    reply.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

    expect(window.getSelection()?.toString()).toBe("Assistant reply");
  });

  it("lets clicks beside the open search panel reach the file's code", async () => {
    let editor: Editor | undefined;
    const contents = Array.from(
      { length: 12 },
      (_, index) => `const server${index} = "a line long enough to run under the find bar";\n`,
    ).join("");
    await using screen = await render(
      <div style={{ width: 600 }}>
        <File
          file={{ name: "server.ts", contents }}
          edit
          editorOptions={{ onAttach: (attached) => (editor = attached) }}
        />
      </div>,
    );
    const content = screen.container.querySelector<HTMLElement>("diffs-file [data-content]");
    expect(content).toBeTruthy();

    editor!.setSelections([
      { start: { line: 0, character: 8 }, end: { line: 0, character: 8 }, direction: "none" },
    ]);
    pressFind(content!);
    const widget = await vi.waitFor(() => {
      const found = screen.container.querySelector("[data-search-panel] [data-editor-widget]");
      expect(found).toBeTruthy();
      return found!;
    });
    const widgetBox = widget.getBoundingClientRect();
    const beside = document.elementFromPoint(
      widgetBox.left - 100,
      widgetBox.top + widgetBox.height / 2,
    );

    expect(content!.contains(beside)).toBe(true);
  });
});
