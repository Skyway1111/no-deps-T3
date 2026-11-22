import { describe, expect, it, vi } from "vite-plus/test";

import {
  cloneFileDiffMetadata,
  hydratePartialDiff,
  parseDiffFromFile,
  parsePatchFiles,
  type FileDiffMetadata,
} from "./patch.ts";

const GIT_PATCH = [
  "From 0123456789abcdef0123456789abcdef01234567 Mon Sep 17 00:00:00 2001",
  "Subject: [PATCH] first",
  "",
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,4 @@ export function app() {",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  " const c = 4;",
  " const d = 5;",
  "@@ -10,2 +10,3 @@",
  " x",
  " y",
  "+z",
  "diff --git a/old name.txt b/new name.txt",
  "similarity index 100%",
  "rename from old name.txt",
  "rename to new name.txt",
  "diff --git a/run.sh b/run.sh",
  "old mode 100644",
  "new mode 100755",
  "diff --git a/added.md b/added.md",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/added.md",
  "@@ -0,0 +1,2 @@",
  "+# Title",
  "+body",
  "\\ No newline at end of file",
  "From fedcba9876543210fedcba9876543210fedcba98 Mon Sep 17 00:00:00 2001",
  "Subject: [PATCH] second",
  "",
  "diff --git a/gone.txt b/gone.txt",
  "deleted file mode 100644",
  "index 4444444..0000000",
  "--- a/gone.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "",
].join("\n");

describe("parsePatchFiles", () => {
  it("parses multi-commit git patches", () => {
    const [first, second] = parsePatchFiles(GIT_PATCH, { cacheKeyPrefix: "pr" });
    expect(first!.patchMetadata).toContain("Subject: [PATCH] first");
    const [app, renamed, mode, added] = first!.files;
    expect(app).toMatchObject({
      name: "src/app.ts",
      type: "change",
      prevObjectId: "1111111",
      newObjectId: "2222222",
      mode: "100644",
      isPartial: true,
      cacheKey: 'ck1:["patch-file","pr","0","0"]',
      deletionLines: [
        "const a = 1;\n",
        "const b = 2;\n",
        "const c = 4;\n",
        "const d = 5;\n",
        "x\n",
        "y\n",
      ],
      additionLines: [
        "const a = 1;\n",
        "const b = 3;\n",
        "const c = 4;\n",
        "const d = 5;\n",
        "x\n",
        "y\n",
        "z\n",
      ],
      splitLineCount: 12,
      unifiedLineCount: 13,
    });
    expect(
      app!.hunks.map((hunk) => [
        hunk.hunkContext,
        hunk.collapsedBefore,
        hunk.splitLineStart,
        hunk.unifiedLineStart,
      ]),
    ).toEqual([
      ["export function app() {", 0, 0, 0],
      [undefined, 5, 9, 10],
    ]);
    expect(app!.hunks[0]!.hunkContent).toEqual([
      { type: "context", lines: 1, additionLineIndex: 0, deletionLineIndex: 0 },
      { type: "change", additions: 1, deletions: 1, additionLineIndex: 1, deletionLineIndex: 1 },
      { type: "context", lines: 2, additionLineIndex: 2, deletionLineIndex: 2 },
    ]);
    expect(renamed).toMatchObject({
      name: "new name.txt",
      prevName: "old name.txt",
      type: "rename-pure",
      hunks: [],
    });
    expect(mode).toMatchObject({
      name: "run.sh",
      prevMode: "100644",
      mode: "100755",
      type: "change",
    });
    expect(added).toMatchObject({
      name: "added.md",
      type: "new",
      additionLines: ["# Title\n", "body"],
      additionCharacterCount: 12,
    });
    expect(added!.hunks[0]!.noEOFCRAdditions).toBe(true);
    expect(second!.files[0]).toMatchObject({
      name: "gone.txt",
      type: "deleted",
      deletionLines: ["bye\n"],
      cacheKey: 'ck1:["patch-file","pr","1","0"]',
    });
  });

  it("splits plain unified diffs and keeps spaces and quoted bytes in names", () => {
    const patch = [
      "--- a/ lead.txt \t2024-01-01",
      "+++ b/ lead.txt \t2024-01-02",
      "@@ -1 +1 @@",
      "--- not a header",
      "+++ also content",
      "--- other.txt",
      "+++ other.txt",
      "@@ -1,2 +1,2 @@",
      " same",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
    ].join("\n");
    const files = parsePatchFiles(patch)[0]!.files;
    expect(files.map((file) => [file.prevName, file.name])).toEqual([
      ["a/ lead.txt ", "b/ lead.txt "],
      [undefined, "other.txt"],
    ]);
    expect(files[0]!.deletionLines).toEqual(["-- not a header\n"]);
    const other = files[1]!;
    expect([other.deletionLines, other.additionLines]).toEqual([
      ["same\n", "old"],
      ["same\n", "new"],
    ]);
    expect([other.hunks[0]!.noEOFCRDeletions, other.hunks[0]!.noEOFCRAdditions]).toEqual([
      true,
      true,
    ]);

    const quoted = parsePatchFiles(
      'diff --git "a/caf\\303\\251 \\"x\\".txt" "b/caf\\303\\251 \\"x\\".txt"\n',
    )[0]!.files[0]!;
    expect(quoted.name).toBe('café "x".txt');
  });

  it("repairs truncated hunks unless asked to throw", () => {
    const truncated = "--- a/t\n+++ b/t\n@@ -3,5 +3,6 @@\n a\n-b\n+c\n";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const hunk = parsePatchFiles(truncated)[0]!.files[0]!.hunks[0]!;
    errors.mockRestore();
    expect([
      hunk.deletionStart,
      hunk.deletionCount,
      hunk.additionStart,
      hunk.additionCount,
    ]).toEqual([3, 2, 3, 2]);
    expect(() => parsePatchFiles(truncated, { throwOnError: true })).toThrow(
      "hunk line count mismatch",
    );
  });

  it("re-pairs mismatched change blocks by similarity", () => {
    const patch =
      "--- a/x\n+++ b/x\n@@ -1,2 +1,5 @@\n-call(a)\n+one\n+two\n+call(a, b)\n+three\n ctx\n";
    const [matched] = parsePatchFiles(patch)[0]!.files;
    const [raw] = parsePatchFiles(patch, { disableLineMatching: true })[0]!.files;
    expect(raw!.hunks[0]!.hunkContent[0]).toMatchObject({ deletions: 1, additions: 4 });
    expect(matched!.hunks[0]!.hunkContent.slice(0, 3)).toEqual([
      { type: "change", deletions: 0, additions: 2, deletionLineIndex: 0, additionLineIndex: 0 },
      { type: "change", deletions: 1, additions: 1, deletionLineIndex: 0, additionLineIndex: 2 },
      { type: "change", deletions: 0, additions: 1, deletionLineIndex: 1, additionLineIndex: 3 },
    ]);
  });
});

const OLD = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\n";
const NEW = "a\nb\nC\nd\ne\nf\ng\nh\nI\nj\nk\nl";

describe("parseDiffFromFile", () => {
  it("builds whole-file metadata", () => {
    const diff = parseDiffFromFile(
      { name: "a.ts", contents: OLD, cacheKey: "o" },
      { name: "a.ts", contents: NEW, cacheKey: "n", lang: "ts" },
    );
    expect(diff).toMatchObject({
      name: "a.ts",
      type: "change",
      isPartial: false,
      lang: "ts",
      cacheKey: 'ck1:["diff","o","n"]',
      deletionLines: OLD.split(/(?<=\n)/u),
      additionLines: NEW.split(/(?<=\n)/u),
      deletionCharacterCount: OLD.length,
      additionCharacterCount: NEW.length,
    });
    expect(
      diff.hunks.map((hunk) => [hunk.deletionStart, hunk.additionStart, hunk.noEOFCRAdditions]),
    ).toEqual([[1, 1, true]]);
    expect(parseDiffFromFile(null, { name: "n.txt", contents: "x\n" }).type).toBe("new");
    expect(parseDiffFromFile({ name: "o.txt", contents: "x\n" }, null).type).toBe("deleted");
  });
});

describe("hydratePartialDiff", () => {
  const partial = () =>
    parsePatchFiles(
      "--- a/a.ts\n+++ b/a.ts\n@@ -2,3 +2,3 @@\n b\n-c\n+C\n d\n@@ -8,4 +8,5 @@\n h\n-i\n+I\n j\n k\n+l\n\\ No newline at end of file\n",
      { cacheKeyPrefix: "p" },
    )[0]!.files[0]!;

  it("remaps a partial change onto whole files", () => {
    const source = partial();
    const before = cloneFileDiffMetadata(source);
    const hydrated = hydratePartialDiff("clone", source, {
      oldFile: { name: "a.ts", contents: OLD },
      newFile: { name: "a.ts", contents: NEW },
    });
    expect(source).toEqual(before);
    expect(hydrated).toMatchObject({
      isPartial: false,
      cacheKey: `${source.cacheKey}:hydrated`,
      splitLineCount: 12,
      unifiedLineCount: 14,
    });
    expect(
      hydrated.hunks.map((hunk) => [
        hunk.collapsedBefore,
        hunk.additionLineIndex,
        hunk.splitLineStart,
        hunk.unifiedLineStart,
      ]),
    ).toEqual([
      [1, 1, 1, 1],
      [3, 7, 7, 8],
    ]);
    expect(hydrated.hunks[1]!.hunkContent.map((content) => content.additionLineIndex)).toEqual([
      7, 8, 9, 11,
    ]);
    expect(hydrated.additionLines[hydrated.hunks[1]!.hunkContent[1]!.additionLineIndex]).toBe(
      "I\n",
    );

    const merged = partial();
    expect(
      hydratePartialDiff("merge", merged, {
        oldFile: { name: "a.ts", contents: OLD },
        newFile: { name: "a.ts", contents: NEW },
      }),
    ).toBe(merged);
    expect(() =>
      hydratePartialDiff("merge", merged, {
        oldFile: null,
        newFile: { name: "a.ts", contents: NEW },
      }),
    ).toThrow("must be partial");
  });

  it("hydrates pure renames from the new file and rejects one-sided diffs", () => {
    const [rename, added] = parsePatchFiles(
      "diff --git a/x b/y\nsimilarity index 100%\nrename from x\nrename to y\ndiff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1 @@\n+n\n",
    )[0]!.files as [FileDiffMetadata, FileDiffMetadata];
    const hydrated = hydratePartialDiff("clone", rename, {
      oldFile: null,
      newFile: { name: "y", contents: "1\n2", cacheKey: "y" },
    });
    expect(hydrated).toMatchObject({
      isPartial: false,
      deletionLines: ["1\n", "2"],
      additionLines: ["1\n", "2"],
      cacheKey: "y",
    });
    expect(() =>
      hydratePartialDiff("clone", rename, {
        oldFile: { name: "x", contents: "" },
        newFile: { name: "y", contents: "" },
      }),
    ).toThrow("requires oldFile to be null");
    expect(() =>
      hydratePartialDiff("clone", added, { oldFile: null, newFile: { name: "n", contents: "n" } }),
    ).toThrow("cannot be hydrated");
  });
});
