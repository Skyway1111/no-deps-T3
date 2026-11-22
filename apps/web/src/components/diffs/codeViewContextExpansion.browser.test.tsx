import { parsePatchFiles } from "@t3tools/shared/diff/patch";
import { expect, it, vi } from "vite-plus/test";

import { CodeView } from "~/ui-core/codeView/CodeView";
import type { CodeViewItem } from "~/ui-core/codeView/types";

import { render } from "../../../test/render";

const OLD_LINES = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`);
const NEW_LINES = OLD_LINES.with(0, "changed 1").with(59, "changed 60");
const PATCH = `diff --git a/notes.txt b/notes.txt
--- a/notes.txt
+++ b/notes.txt
@@ -1,4 +1,4 @@
-line 1
+changed 1
 line 2
 line 3
 line 4
@@ -57,4 +57,4 @@
 line 57
 line 58
 line 59
-line 60
+changed 60
`;

function parsePartialDiff() {
  return parsePatchFiles(PATCH, { cacheKeyPrefix: "notes" })[0]!.files[0]!;
}

function view(version: number) {
  const items: CodeViewItem[] = [
    { id: "notes", type: "diff", fileDiff: parsePartialDiff(), version },
  ];
  return (
    <CodeView
      items={items}
      style={{ width: 800, height: 600 }}
      options={{
        diffStyle: "unified",
        loadDiffFiles: async () => ({
          oldFile: { name: "notes.txt", contents: `${OLD_LINES.join("\n")}\n` },
          newFile: { name: "notes.txt", contents: `${NEW_LINES.join("\n")}\n` },
        }),
      }}
    />
  );
}

// A diff refresh re-parses an unchanged patch into a new object with the same cacheKey.
it("expands hidden context after the host re-supplies an unchanged partial diff", async () => {
  // This viewer fixture does not navigate or read router state.
  await using screen = await render(view(1), { router: false });
  const lines = () =>
    Array.from(screen.container.querySelectorAll("[data-line]"), (line) => line.textContent);
  await vi.waitFor(() => expect(lines()).toContain("line 57"));
  await screen.rerender(view(2));

  screen.container.querySelector<HTMLElement>("[data-expand-button]")!.click();

  await vi.waitFor(() => expect(lines()).toContain("line 30"));
});
