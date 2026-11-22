// Unified/git patch parsing and hydration, behaviorally matching @pierre/diffs
// 1.7.0-beta.4 (with T3's filename-whitespace patch) so its renderers can take
// this output directly.
import { formatPatch, structuredPatch, type DiffOptions } from "./histogram.ts";

/** `change`: same name; `rename-pure`: moved unchanged; `rename-changed`: moved and edited. */
export type ChangeTypes = "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
export type AnnotationSide = "deletions" | "additions";
export type SelectionSide = "deletions" | "additions";
export type LineDiffTypes = "word-alt" | "word-line" | "word" | "char" | "none";
export type HunkSeparators = "simple" | "metadata" | "line-info" | "line-info-basic" | "custom";
export type ExpansionDirections = "up" | "down" | "both";
export type PostRenderPhase = "mount" | "update" | "unmount";

export interface FileContents {
  name: string;
  contents: string;
  lang?: string | undefined;
  header?: string | undefined;
  cacheKey?: string | undefined;
}

export type FileDiffLoadedFiles =
  | { oldFile: FileContents; newFile: FileContents }
  | { oldFile: null; newFile: FileContents };

export type FileDiffContentsLoader = (fileDiff: FileDiffMetadata) => Promise<FileDiffLoadedFiles>;

export interface ParsedPatch {
  /** Text before the first file, such as commit metadata. */
  patchMetadata?: string | undefined;
  files: FileDiffMetadata[];
}

export interface ContextContent {
  type: "context";
  lines: number;
  /** Index into `additionLines` where the block starts. */
  additionLineIndex: number;
  /** Index into `deletionLines` where the block starts. */
  deletionLineIndex: number;
}

export interface ChangeContent {
  type: "change";
  deletions: number;
  deletionLineIndex: number;
  additions: number;
  additionLineIndex: number;
}

export interface Hunk {
  /** Unchanged lines between the previous hunk (or file start) and this one. */
  collapsedBefore: number;
  additionStart: number;
  additionCount: number;
  /** `+` lines in the hunk. */
  additionLines: number;
  additionLineIndex: number;
  deletionStart: number;
  deletionCount: number;
  /** `-` lines in the hunk. */
  deletionLines: number;
  deletionLineIndex: number;
  hunkContent: Array<ContextContent | ChangeContent>;
  hunkContext?: string | undefined;
  hunkSpecs?: string | undefined;
  splitLineStart: number;
  splitLineCount: number;
  unifiedLineStart: number;
  unifiedLineCount: number;
  noEOFCRDeletions: boolean;
  noEOFCRAdditions: boolean;
}

export interface FileDiffMetadata {
  name: string;
  /** Present only for renames. */
  prevName?: string | undefined;
  lang?: string | undefined;
  newObjectId?: string | undefined;
  prevObjectId?: string | undefined;
  mode?: string | undefined;
  prevMode?: string | undefined;
  type: ChangeTypes;
  hunks: Hunk[];
  splitLineCount: number;
  unifiedLineCount: number;
  /** True when the line arrays hold only patch lines rather than whole files. */
  isPartial: boolean;
  /** Lines keep their trailing `\n` unless the file ends without one. */
  deletionLines: string[];
  additionLines: string[];
  deletionCharacterCount: number;
  additionCharacterCount: number;
  editSessionDirty?: boolean | undefined;
  cacheKey?: string | undefined;
}

export interface SelectedLineRange {
  start: number;
  side?: SelectionSide;
  end: number;
  endSide?: SelectionSide;
}

type OptionalMetadata<T> = T extends undefined ? { metadata?: undefined } : { metadata: T };

/** `lineNumber: 0` annotates the file above its first line. */
export type LineAnnotation<T = undefined> = { lineNumber: number } & OptionalMetadata<T>;
export type DiffLineAnnotation<T = undefined> = {
  side: AnnotationSide;
  lineNumber: number;
} & OptionalMetadata<T>;

export interface ParsePatchOptions {
  readonly cacheKeyPrefix?: string;
  /** Skip re-pairing mismatched change blocks by line similarity. */
  readonly disableLineMatching?: boolean;
  readonly throwOnError?: boolean;
}

export interface ParseDiffOptions extends DiffOptions {
  readonly context?: number;
  readonly disableLineMatching?: boolean;
}

const GIT_HEADER_NAMES =
  /^diff --git ("a\/(?:[^"\\]|\\.)*"|a\/.+?) ("b\/(?:[^"\\]|\\.)*"|b\/.+?)$/u;
const FILENAME_HEADER = /^(---|\+\+\+)\s+([^\t\r\n]+)/u;
const INDEX_LINE = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: (\d+))?$/iu;
const COMMIT_START = /^From [a-f0-9]+ .+$/u;

/** Collision-free cache key from caller-controlled segments. */
function composeCacheKey(scope: string, ...segments: string[]): string {
  return `ck1:${JSON.stringify([scope, ...segments])}`;
}

function sideStart(start: number, count: number): number {
  return start - (count === 0 ? 0 : 1);
}

function sideEnd(start: number, count: number): number {
  return sideStart(start, count) + count;
}

function cleanLastNewline(text: string): string {
  let end = text.length;
  if (text.charCodeAt(end - 1) === 10) {
    end--;
    if (text.charCodeAt(end - 1) === 13) end--;
  }
  return text.slice(0, end);
}

/** Lines with their `\n` kept; a missing final break leaves the last line bare. */
function splitWithNewlines(text: string): string[] {
  if (text.length === 0) return [""];
  const lines: string[] = [];
  let start = 0;
  for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", start)) {
    lines.push(text.slice(start, newline + 1));
    start = newline + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** Whole-file lines as `parseDiffFromFile` and hydration store them. */
function splitFileContents(contents: string): string[] {
  return contents === "" ? [] : splitWithNewlines(contents);
}

const NAMED_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  a: "\x07",
  b: "\b",
  t: "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
};

function utf8Decode(bytes: number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i]!;
    const extra = b >= 0xf0 ? 3 : b >= 0xe0 ? 2 : b >= 0xc0 ? 1 : 0;
    let code = extra === 0 ? b : b & (0x3f >> extra);
    let valid = extra === 0 ? b < 0x80 : i + extra < bytes.length + 0;
    for (let k = 1; k <= extra && valid; k++) {
      const next = bytes[i + k];
      if (next === undefined || (next & 0xc0) !== 0x80) valid = false;
      else code = (code << 6) | (next & 0x3f);
    }
    if (!valid) {
      out += "�";
      i++;
      continue;
    }
    out += String.fromCodePoint(code);
    i += extra + 1;
  }
  return out;
}

/** Decodes git's C-style quoted path (`"a\\303\\251"`). */
function parseQuotedDiffFileName(
  input: string,
): { fileName: string; rawLength: number } | undefined {
  if (input[0] !== '"') return undefined;
  let fileName = "";
  let index = 1;
  while (index < input.length) {
    const char = input[index]!;
    if (char === '"') return { fileName, rawLength: index + 1 };
    if (char !== "\\") {
      fileName += char;
      index++;
      continue;
    }
    const escaped = NAMED_ESCAPES[input[index + 1] ?? ""];
    if (escaped !== undefined) {
      fileName += escaped;
      index += 2;
      continue;
    }
    const bytes: number[] = [];
    do {
      const first = input.charCodeAt(index + 1) - 48;
      const second = input.charCodeAt(index + 2) - 48;
      const third = input.charCodeAt(index + 3) - 48;
      if (!(first >= 0 && first <= 3 && second >= 0 && second <= 7 && third >= 0 && third <= 7))
        return undefined;
      bytes.push(first * 64 + second * 8 + third);
      index += 4;
    } while (input[index] === "\\" && input[index + 1]! >= "0" && input[index + 1]! <= "7");
    fileName += utf8Decode(bytes);
  }
  return undefined;
}

/** Strips only trailing tabs and line breaks so names keep their spaces. */
function decodeDiffFileName(value: string, stripGitPrefix = false): string {
  let end = value.length;
  while (end > 0) {
    const c = value.charCodeAt(end - 1);
    if (c !== 9 && c !== 10 && c !== 13) break;
    end--;
  }
  const raw = value.slice(0, end);
  const name = raw.startsWith('"') ? (parseQuotedDiffFileName(raw)?.fileName ?? raw) : raw;
  return stripGitPrefix && (name.startsWith("a/") || name.startsWith("b/")) ? name.slice(2) : name;
}

function readPositiveInteger(
  value: string,
  start: number,
): { value: number; end: number } | undefined {
  let index = start;
  let parsed = 0;
  for (; index < value.length; index++) {
    const digit = value.charCodeAt(index) - 48;
    if (digit < 0 || digit > 9) break;
    parsed = parsed * 10 + digit;
  }
  return index === start ? undefined : { value: parsed, end: index };
}

interface HunkHeader {
  additionCount: number;
  additionStart: number;
  deletionCount: number;
  deletionStart: number;
  hunkContext?: string | undefined;
}

function parseHunkHeader(line: string): HunkHeader | undefined {
  if (!line.startsWith("@@ -")) return undefined;
  const deletionStart = readPositiveInteger(line, 4);
  if (!deletionStart) return undefined;
  let index = deletionStart.end;
  let deletionCount = 1;
  if (line[index] === ",") {
    const count = readPositiveInteger(line, index + 1);
    if (!count) return undefined;
    deletionCount = count.value;
    index = count.end;
  }
  if (line[index] !== " " || line[index + 1] !== "+") return undefined;
  const additionStart = readPositiveInteger(line, index + 2);
  if (!additionStart) return undefined;
  index = additionStart.end;
  let additionCount = 1;
  if (line[index] === ",") {
    const count = readPositiveInteger(line, index + 1);
    if (!count) return undefined;
    additionCount = count.value;
    index = count.end;
  }
  if (line[index] !== " " || line[index + 1] !== "@" || line[index + 2] !== "@") return undefined;
  const header: HunkHeader = {
    additionCount,
    additionStart: additionStart.value,
    deletionCount,
    deletionStart: deletionStart.value,
  };
  if (line[index + 3] === " ") header.hunkContext = cleanLastNewline(line.slice(index + 4));
  return header;
}

function findLinePrefix(contents: string, newlinePrefix: string, from: number): number {
  const index = contents.indexOf(newlinePrefix, from);
  return index === -1 ? -1 : index + 1;
}

function splitAtLinePrefix(contents: string, prefix: string): string[] {
  if (contents.length === 0) return [""];
  const newlinePrefix = `\n${prefix}`;
  const first = contents.startsWith(prefix) ? 0 : findLinePrefix(contents, newlinePrefix, 0);
  if (first === -1) return [contents];
  const parts: string[] = [];
  if (first > 0) parts.push(contents.slice(0, first));
  let start = first;
  for (
    let next = findLinePrefix(contents, newlinePrefix, start + 1);
    next !== -1;
    next = findLinePrefix(contents, newlinePrefix, start + 1)
  ) {
    parts.push(contents.slice(start, next));
    start = next;
  }
  parts.push(contents.slice(start));
  return parts;
}

function nextLineStart(contents: string, start: number): number {
  const newline = contents.indexOf("\n", start);
  return newline === -1 ? contents.length : newline + 1;
}

function isUnifiedHeaderLineAt(contents: string, start: number, prefix: string): boolean {
  if (!contents.startsWith(prefix, start)) return false;
  const separator = contents[start + prefix.length];
  if (separator !== " " && separator !== "\t") return false;
  for (let index = start + prefix.length + 1; index < contents.length; index++) {
    const char = contents[index];
    if (char === "\n" || char === "\r") break;
    if (char !== " " && char !== "\t") return true;
  }
  return false;
}

function isUnifiedFileHeaderAt(contents: string, start: number): boolean {
  return (
    isUnifiedHeaderLineAt(contents, start, "---") &&
    isUnifiedHeaderLineAt(contents, nextLineStart(contents, start), "+++")
  );
}

/** Splits plain unified diffs at `---`/`+++` pairs, skipping lines that hunks consume. */
function splitUnifiedDiffFiles(contents: string): string[] {
  if (contents.length === 0) return [""];
  const parts: string[] = [];
  let partStart = 0;
  let lineStart = 0;
  let remainingDeletions = 0;
  let remainingAdditions = 0;
  let opened = false;
  while (lineStart < contents.length) {
    const next = nextLineStart(contents, lineStart);
    if (remainingDeletions <= 0 && remainingAdditions <= 0) {
      if (isUnifiedFileHeaderAt(contents, lineStart)) {
        if (lineStart > partStart) parts.push(contents.slice(partStart, lineStart));
        partStart = lineStart;
        opened = true;
        lineStart = nextLineStart(contents, next);
        continue;
      }
      if (opened && contents.startsWith("@@ -", lineStart)) {
        const header = parseHunkHeader(contents.slice(lineStart, next));
        if (header) {
          remainingDeletions = header.deletionCount;
          remainingAdditions = header.additionCount;
        }
      }
      lineStart = next;
      continue;
    }
    const first = contents[lineStart];
    if (first === " ") {
      remainingDeletions = Math.max(remainingDeletions - 1, 0);
      remainingAdditions = Math.max(remainingAdditions - 1, 0);
    } else if (first === "-") remainingDeletions = Math.max(remainingDeletions - 1, 0);
    else if (first === "+") remainingAdditions = Math.max(remainingAdditions - 1, 0);
    lineStart = next;
  }
  parts.push(contents.slice(partStart));
  return parts;
}

function isGitDiff(data: string): boolean {
  return data.startsWith("diff --git") || data.includes("\ndiff --git");
}

function hasGitFileBreak(blob: string): boolean {
  return blob.startsWith("diff --git") || blob.includes("\ndiff --git");
}

function isFormatPatchVersionSeparator(line: string): boolean {
  if (!line.startsWith("--")) return false;
  for (let index = 2; index < line.length; index++) {
    const char = line[index];
    if (char !== " " && char !== "\t" && char !== "\n" && char !== "\r") return false;
  }
  return true;
}

function contentGroup(
  type: "change" | "context",
  deletionLineIndex: number,
  additionLineIndex: number,
): ContextContent | ChangeContent {
  return type === "change"
    ? { type, additions: 0, deletions: 0, additionLineIndex, deletionLineIndex }
    : { type, lines: 0, additionLineIndex, deletionLineIndex };
}

/** Malformed input throws when asked to; otherwise the parser skips it, as upstream does. */
function report(throwOnError: boolean, message: string): void {
  if (throwOnError) throw new Error(`parsePatchContent: ${message}`);
}

interface ProcessFileOptions {
  readonly cacheKey?: string | undefined;
  readonly disableLineMatching?: boolean | undefined;
  readonly isGitDiff?: boolean | undefined;
  readonly oldFile?: FileContents | undefined;
  readonly newFile?: FileContents | undefined;
  readonly throwOnError?: boolean | undefined;
}

/** Parses one file's section of a patch. */
function processFile(
  fileDiff: string,
  options: ProcessFileOptions = {},
): FileDiffMetadata | undefined {
  const { cacheKey, disableLineMatching = false, oldFile, newFile, throwOnError = false } = options;
  const gitDiff = options.isGitDiff ?? hasGitFileBreak(fileDiff);
  const isPartial = oldFile == null || newFile == null;
  let lastHunkEnd = 0;
  let deletionLineIndex = 0;
  let additionLineIndex = 0;
  let file: FileDiffMetadata | undefined;
  for (const hunk of splitAtLinePrefix(fileDiff, "@@ ")) {
    const lines = splitWithNewlines(hunk);
    const firstLine = lines[0];
    if (firstLine == null) {
      report(throwOnError, "invalid hunk");
      continue;
    }
    const header = parseHunkHeader(firstLine);
    if (header == null || file == null) {
      if (file != null) {
        report(throwOnError, "Invalid hunk");
        continue;
      }
      const additionLines = !isPartial ? splitWithNewlines(newFile.contents) : [];
      const deletionLines = !isPartial ? splitWithNewlines(oldFile.contents) : [];
      if (additionLines.length === 1 && newFile?.contents === "") additionLines.length = 0;
      if (deletionLines.length === 1 && oldFile?.contents === "") deletionLines.length = 0;
      const created: FileDiffMetadata = {
        name: "",
        type: "change",
        hunks: [],
        splitLineCount: 0,
        unifiedLineCount: 0,
        isPartial,
        additionLines,
        deletionLines,
        additionCharacterCount: !isPartial ? newFile.contents.length : 0,
        deletionCharacterCount: !isPartial ? oldFile.contents.length : 0,
        cacheKey,
      };
      for (const line of lines) parseFileHeaderLine(created, line, gitDiff, throwOnError);
      file = created;
      continue;
    }
    while (lines.length > 0) {
      const last = lines[lines.length - 1];
      if (last !== "\n" && last !== "\r" && last !== "\r\n" && last !== "") break;
      lines.pop();
    }
    const { additionStart, deletionStart } = header;
    deletionLineIndex = isPartial ? deletionLineIndex : deletionStart - 1;
    additionLineIndex = isPartial ? additionLineIndex : additionStart - 1;
    const data: Hunk = {
      collapsedBefore: 0,
      splitLineCount: 0,
      splitLineStart: 0,
      unifiedLineCount: 0,
      unifiedLineStart: 0,
      additionCount: header.additionCount,
      additionStart,
      additionLines: 0,
      deletionCount: header.deletionCount,
      deletionStart,
      deletionLines: 0,
      deletionLineIndex,
      additionLineIndex,
      hunkContent: [],
      hunkContext: header.hunkContext,
      hunkSpecs: firstLine,
      noEOFCRAdditions: false,
      noEOFCRDeletions: false,
    };
    let content: ContextContent | ChangeContent | undefined;
    let lastType: "addition" | "deletion" | "context" | undefined;
    let parsedAdditions = 0;
    let parsedDeletions = 0;
    for (let index = 1; index < lines.length; index++) {
      const rawLine = lines[index]!;
      if (
        parsedAdditions >= data.additionCount &&
        parsedDeletions >= data.deletionCount &&
        !rawLine.startsWith("\\")
      ) {
        const first = rawLine[0];
        if (
          !(
            (first === "+" || first === "-" || first === " ") &&
            !isFormatPatchVersionSeparator(rawLine)
          )
        )
          break;
        if (throwOnError) throw new Error("parsePatchContent: hunk has more lines than expected");
      }
      const first = rawLine[0];
      if (first !== "+" && first !== "-" && first !== " " && first !== "\\") {
        report(throwOnError, "invalid hunk line");
        continue;
      }
      if (first === "\\") {
        if (content == null) continue;
        if (content.type === "context") {
          data.noEOFCRAdditions = true;
          data.noEOFCRDeletions = true;
        } else if (lastType === "deletion") data.noEOFCRDeletions = true;
        else if (lastType === "addition") data.noEOFCRAdditions = true;
        if (isPartial && (lastType === "addition" || lastType === "context"))
          trimLast(file, "addition");
        if (isPartial && (lastType === "deletion" || lastType === "context"))
          trimLast(file, "deletion");
        continue;
      }
      const text = rawLine.length === 1 ? "\n" : rawLine.slice(1);
      if (first === " ") {
        if (
          throwOnError &&
          (parsedDeletions >= data.deletionCount || parsedAdditions >= data.additionCount)
        ) {
          throw new Error("parsePatchContent: hunk has too many context lines");
        }
        if (content?.type !== "context") {
          content = contentGroup("context", deletionLineIndex, additionLineIndex);
          data.hunkContent.push(content);
        }
        additionLineIndex++;
        deletionLineIndex++;
        parsedAdditions++;
        parsedDeletions++;
        if (isPartial) {
          file.deletionLines.push(text);
          file.additionLines.push(text);
          file.deletionCharacterCount += text.length;
          file.additionCharacterCount += text.length;
        }
        (content as ContextContent).lines++;
        lastType = "context";
        continue;
      }
      const addition = first === "+";
      if (
        throwOnError &&
        (addition ? parsedAdditions >= data.additionCount : parsedDeletions >= data.deletionCount)
      ) {
        throw new Error(
          `parsePatchContent: hunk has too many ${addition ? "addition" : "deletion"} lines`,
        );
      }
      if (content?.type !== "change") {
        content = contentGroup("change", deletionLineIndex, additionLineIndex);
        data.hunkContent.push(content);
      }
      if (addition) {
        additionLineIndex++;
        parsedAdditions++;
        data.additionLines++;
        (content as ChangeContent).additions++;
        if (isPartial) {
          file.additionLines.push(text);
          file.additionCharacterCount += text.length;
        }
      } else {
        deletionLineIndex++;
        parsedDeletions++;
        data.deletionLines++;
        (content as ChangeContent).deletions++;
        if (isPartial) {
          file.deletionLines.push(text);
          file.deletionCharacterCount += text.length;
        }
      }
      lastType = addition ? "addition" : "deletion";
    }
    if (parsedAdditions !== data.additionCount || parsedDeletions !== data.deletionCount) {
      if (throwOnError) throw new Error("parsePatchContent: hunk line count mismatch");
      const repairedAdditionStart =
        sideStart(data.additionStart, data.additionCount) + (parsedAdditions === 0 ? 0 : 1);
      const repairedDeletionStart =
        sideStart(data.deletionStart, data.deletionCount) + (parsedDeletions === 0 ? 0 : 1);
      if (!isPartial) {
        const additionDelta = repairedAdditionStart - data.additionStart;
        const deletionDelta = repairedDeletionStart - data.deletionStart;
        data.additionLineIndex += additionDelta;
        data.deletionLineIndex += deletionDelta;
        for (const block of data.hunkContent) {
          block.additionLineIndex += additionDelta;
          block.deletionLineIndex += deletionDelta;
        }
      }
      data.additionStart = repairedAdditionStart;
      data.deletionStart = repairedDeletionStart;
      data.additionCount = parsedAdditions;
      data.deletionCount = parsedDeletions;
    }
    data.collapsedBefore = Math.max(
      sideStart(data.additionStart, data.additionCount) - lastHunkEnd,
      0,
    );
    file.hunks.push(data);
    lastHunkEnd = sideEnd(data.additionStart, data.additionCount);
    for (const block of data.hunkContent) {
      if (block.type === "context") {
        data.splitLineCount += block.lines;
        data.unifiedLineCount += block.lines;
      } else {
        data.splitLineCount += Math.max(block.additions, block.deletions);
        data.unifiedLineCount += block.deletions + block.additions;
      }
    }
    data.splitLineStart = file.splitLineCount + data.collapsedBefore;
    data.unifiedLineStart = file.unifiedLineCount + data.collapsedBefore;
    file.splitLineCount += data.collapsedBefore + data.splitLineCount;
    file.unifiedLineCount += data.collapsedBefore + data.unifiedLineCount;
  }
  if (file == null) return undefined;
  if (throwOnError && isPartial && !gitDiff && file.hunks.length === 0) {
    throw new Error("parsePatchContent: unified file has no hunks");
  }
  if (
    file.hunks.length > 0 &&
    !isPartial &&
    file.additionLines.length > 0 &&
    file.deletionLines.length > 0
  ) {
    const last = file.hunks[file.hunks.length - 1]!;
    const collapsedAfter = Math.max(
      file.additionLines.length - sideEnd(last.additionStart, last.additionCount),
      0,
    );
    file.splitLineCount += collapsedAfter;
    file.unifiedLineCount += collapsedAfter;
  }
  if (!gitDiff) {
    if (file.prevName != null && file.name !== file.prevName)
      file.type = file.hunks.length > 0 ? "rename-changed" : "rename-pure";
    else if (
      (oldFile == null || oldFile.contents === "") &&
      newFile != null &&
      newFile.contents !== ""
    )
      file.type = "new";
    else if (
      oldFile != null &&
      oldFile.contents !== "" &&
      (newFile == null || newFile.contents === "")
    )
      file.type = "deleted";
  }
  if (file.type !== "rename-pure" && file.type !== "rename-changed") file.prevName = undefined;
  if (!disableLineMatching) realignChangeContentBySimilarity(file);
  return file;
}

function trimLast(file: FileDiffMetadata, side: "addition" | "deletion"): void {
  const lines = side === "addition" ? file.additionLines : file.deletionLines;
  const lastIndex = lines.length - 1;
  if (lastIndex < 0) return;
  const line = lines[lastIndex]!;
  const cleaned = cleanLastNewline(line);
  lines[lastIndex] = cleaned;
  if (side === "addition") file.additionCharacterCount += cleaned.length - line.length;
  else file.deletionCharacterCount += cleaned.length - line.length;
}

function parseFileHeaderLine(
  file: FileDiffMetadata,
  line: string,
  gitDiff: boolean,
  throwOnError: boolean,
): void {
  if (line.startsWith("diff --git")) {
    const match = GIT_HEADER_NAMES.exec(line.trim());
    if (match == null) {
      report(throwOnError, "invalid git diff header");
      return;
    }
    const prevName = decodeDiffFileName(match[1]!, true);
    const name = decodeDiffFileName(match[2]!, true);
    file.name = name;
    if (prevName !== name) file.prevName = prevName;
    return;
  }
  const filename =
    line.startsWith("---") || line.startsWith("+++") ? FILENAME_HEADER.exec(line) : null;
  if (filename != null) {
    const name = decodeDiffFileName(filename[2]!, gitDiff);
    if (filename[1] === "---" && name !== "/dev/null") {
      file.prevName = name;
      file.name = name;
    } else if (filename[1] === "+++" && name !== "/dev/null") file.name = name;
    return;
  }
  if (!gitDiff) return;
  if (line.startsWith("new mode ")) file.mode = line.slice(8).trim();
  if (line.startsWith("old mode ")) file.prevMode = line.slice(8).trim();
  if (line.startsWith("new file mode")) {
    file.type = "new";
    file.mode = line.slice(13).trim();
  }
  if (line.startsWith("deleted file mode")) {
    file.type = "deleted";
    file.mode = line.slice(17).trim();
  }
  if (line.startsWith("similarity index"))
    file.type = line.startsWith("similarity index 100%") ? "rename-pure" : "rename-changed";
  if (line.startsWith("index ")) {
    const [, prevObjectId, newObjectId, mode] = INDEX_LINE.exec(line.trim()) ?? [];
    if (prevObjectId != null) file.prevObjectId = prevObjectId;
    if (newObjectId != null) file.newObjectId = newObjectId;
    if (mode != null) file.mode = mode;
  }
  if (line.startsWith("rename from ") || line.startsWith("copy from ")) {
    file.prevName = decodeDiffFileName(line.slice(line.startsWith("rename") ? 12 : 10));
  }
  if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
    file.name = decodeDiffFileName(line.slice(line.startsWith("rename") ? 10 : 8));
  }
}

function processPatch(
  data: string,
  options: ParsePatchOptions,
  patchIndex: number | undefined,
): ParsedPatch {
  const { cacheKeyPrefix, disableLineMatching, throwOnError = false } = options;
  const gitDiff = isGitDiff(data);
  const scope = disableLineMatching === true ? "patch-file-raw" : "patch-file";
  let patchMetadata: string | undefined;
  const files: FileDiffMetadata[] = [];
  for (const blob of gitDiff
    ? splitAtLinePrefix(data, "diff --git")
    : splitUnifiedDiffFiles(data)) {
    if (gitDiff ? !hasGitFileBreak(blob) : !isUnifiedFileHeaderAt(blob, 0)) {
      if (patchMetadata == null) patchMetadata = blob;
      else report(throwOnError, "unknown file blob");
      continue;
    }
    const cacheKey =
      cacheKeyPrefix == null
        ? undefined
        : patchIndex == null
          ? composeCacheKey(scope, cacheKeyPrefix, String(files.length))
          : composeCacheKey(scope, cacheKeyPrefix, String(patchIndex), String(files.length));
    const file = processFile(blob, {
      cacheKey,
      isGitDiff: gitDiff,
      disableLineMatching,
      throwOnError,
    });
    if (file != null) files.push(file);
  }
  return { patchMetadata, files };
}

/** Splits `git format-patch` output before each `From <sha> ` line. */
function splitCommits(data: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let lineStart = 0; lineStart < data.length;) {
    const next = nextLineStart(data, lineStart);
    if (lineStart > start && data.startsWith("From ", lineStart)) {
      const line = data.slice(lineStart, data.charCodeAt(next - 1) === 10 ? next - 1 : next);
      if (COMMIT_START.test(line)) {
        parts.push(data.slice(start, lineStart));
        start = lineStart;
      }
    }
    lineStart = next;
  }
  parts.push(data.slice(start));
  return parts;
}

/** Parses patch text (multi-commit, git, or plain unified) into per-commit file diffs. */
export function parsePatchFiles(data: string, options: ParsePatchOptions = {}): ParsedPatch[] {
  const { cacheKeyPrefix, throwOnError = false } = options;
  const patches: ParsedPatch[] = [];
  const raw = data.startsWith("From ") || data.includes("\nFrom ") ? splitCommits(data) : [data];
  for (const patch of raw) {
    try {
      patches.push(
        processPatch(patch, options, cacheKeyPrefix != null ? patches.length : undefined),
      );
    } catch (error) {
      if (throwOnError) throw error;
    }
  }
  return patches;
}

/** Full-file metadata (`isPartial: false`) from two file versions. */
export function parseDiffFromFile(
  oldFile: FileContents | null,
  newFile: FileContents | null,
  options: ParseDiffOptions = {},
  throwOnError = false,
): FileDiffMetadata {
  if (oldFile === null && newFile === null)
    throw new Error("parseDiffFromFile: You must pass oldFile, newFile, or both");
  const { disableLineMatching, ...diffOptions } = options;
  const before = oldFile ?? { name: "/dev/null", contents: "" };
  const after = newFile ?? { name: "/dev/null", contents: "" };
  const structured = structuredPatch(
    before.name,
    after.name,
    before.contents,
    after.contents,
    before.header,
    after.header,
    diffOptions,
  );
  if (structured === undefined)
    throw new Error("parseDiffFromFile: diff exceeded its edit or time limit");
  const cacheKey =
    oldFile?.cacheKey != null && newFile?.cacheKey != null
      ? composeCacheKey(
          disableLineMatching === true ? "diff-raw" : "diff",
          oldFile.cacheKey,
          newFile.cacheKey,
        )
      : undefined;
  const file = processFile(formatPatch(structured), {
    cacheKey,
    oldFile: before,
    newFile: after,
    disableLineMatching,
    throwOnError,
  });
  if (file == null) throw new Error("parseDiffFromFile: invalid diff");
  if (oldFile === null) {
    file.type = "new";
    file.prevName = undefined;
  } else if (newFile === null) {
    file.type = "deleted";
    file.prevName = undefined;
  }
  const language = newFile?.lang ?? (newFile === null ? oldFile?.lang : undefined);
  if (language != null) file.lang = language;
  return file;
}

function cloneHunks(hunks: ReadonlyArray<Hunk>): Hunk[] {
  return hunks.map((hunk) => ({
    ...hunk,
    hunkContent: hunk.hunkContent.map((content) => ({ ...content })),
  }));
}

export function cloneFileDiffMetadata(fileDiff: FileDiffMetadata): FileDiffMetadata {
  return {
    ...fileDiff,
    hunks: cloneHunks(fileDiff.hunks),
    deletionLines: [...fileDiff.deletionLines],
    additionLines: [...fileDiff.additionLines],
  };
}

/**
 * Upgrades a partial diff with whole-file line arrays, keeping its hunks.
 * `clone` leaves the input untouched; `merge` mutates it in place.
 */
export function hydratePartialDiff(
  type: "clone" | "merge",
  fileDiff: FileDiffMetadata,
  files: { readonly oldFile: FileContents | null; readonly newFile: FileContents | null },
  options: { readonly disableLineMatching?: boolean } = {},
): FileDiffMetadata {
  const target = type === "clone" ? cloneFileDiffMetadata(fileDiff) : fileDiff;
  if (!target.isPartial) throw new Error("hydratePartialDiff: fileDiff must be partial");
  const requireFile = (file: FileContents | null, side: "oldFile" | "newFile") => {
    if (file == null)
      throw new Error(
        `hydratePartialDiff: ${target.type} diff for ${target.name} requires ${side}`,
      );
    return file;
  };
  if (target.type === "change" || target.type === "rename-changed") {
    const oldFile = requireFile(files.oldFile, "oldFile");
    const newFile = requireFile(files.newFile, "newFile");
    const additionLines = splitFileContents(newFile.contents);
    const hydrated = hydrateHunks(target.hunks, additionLines.length);
    target.hunks = hydrated.hunks;
    target.splitLineCount = hydrated.splitLineCount;
    target.unifiedLineCount = hydrated.unifiedLineCount;
    target.isPartial = false;
    target.deletionLines = splitFileContents(oldFile.contents);
    target.additionLines = additionLines;
    target.deletionCharacterCount = oldFile.contents.length;
    target.additionCharacterCount = newFile.contents.length;
    setHydratedCacheKey(target, oldFile, newFile, options);
    return target;
  }
  if (target.type === "rename-pure") {
    const newFile = requireFile(files.newFile, "newFile");
    if (files.oldFile !== null) {
      throw new Error(
        `hydratePartialDiff: ${target.type} diff for ${target.name} requires oldFile to be null`,
      );
    }
    const lines = splitFileContents(newFile.contents);
    target.isPartial = false;
    target.deletionLines = lines;
    target.additionLines = lines;
    target.deletionCharacterCount = newFile.contents.length;
    target.additionCharacterCount = newFile.contents.length;
    setHydratedCacheKey(target, null, newFile, options);
    return target;
  }
  throw new Error(`hydratePartialDiff: ${target.type} diffs cannot be hydrated from loaded files`);
}

function hydrateHunks(hunks: ReadonlyArray<Hunk>, totalAdditionLines: number) {
  let splitLineCount = 0;
  let unifiedLineCount = 0;
  let lastAdditionEnd = 0;
  const hydrated: Hunk[] = [];
  for (const hunk of hunks) {
    const additionLineIndex = Math.max(hunk.additionStart - 1, 0);
    const deletionLineIndex = Math.max(hunk.deletionStart - 1, 0);
    let additionAt = additionLineIndex;
    let deletionAt = deletionLineIndex;
    let additions = 0;
    let deletions = 0;
    let split = 0;
    let unified = 0;
    const hunkContent: Array<ContextContent | ChangeContent> = [];
    for (const content of hunk.hunkContent) {
      hunkContent.push({
        ...content,
        additionLineIndex: additionAt,
        deletionLineIndex: deletionAt,
      });
      if (content.type === "context") {
        additionAt += content.lines;
        deletionAt += content.lines;
        split += content.lines;
        unified += content.lines;
        continue;
      }
      additionAt += content.additions;
      deletionAt += content.deletions;
      additions += content.additions;
      deletions += content.deletions;
      split += Math.max(content.additions, content.deletions);
      unified += content.additions + content.deletions;
    }
    const collapsedBefore = Math.max(
      sideStart(hunk.additionStart, hunk.additionCount) - lastAdditionEnd,
      0,
    );
    hydrated.push({
      ...hunk,
      collapsedBefore,
      additionLineIndex,
      deletionLineIndex,
      additionLines: additions,
      deletionLines: deletions,
      hunkContent,
      splitLineStart: splitLineCount + collapsedBefore,
      unifiedLineStart: unifiedLineCount + collapsedBefore,
      splitLineCount: split,
      unifiedLineCount: unified,
    });
    splitLineCount += collapsedBefore + split;
    unifiedLineCount += collapsedBefore + unified;
    lastAdditionEnd = sideEnd(hunk.additionStart, hunk.additionCount);
  }
  const last = hydrated[hydrated.length - 1];
  if (last) {
    const collapsedAfter = Math.max(
      totalAdditionLines - sideEnd(last.additionStart, last.additionCount),
      0,
    );
    splitLineCount += collapsedAfter;
    unifiedLineCount += collapsedAfter;
  }
  return { hunks: hydrated, splitLineCount, unifiedLineCount };
}

function setHydratedCacheKey(
  fileDiff: FileDiffMetadata,
  oldFile: FileContents | null,
  newFile: FileContents,
  options: { readonly disableLineMatching?: boolean },
): void {
  const key =
    fileDiff.cacheKey != null
      ? `${fileDiff.cacheKey}:hydrated`
      : oldFile != null
        ? oldFile.cacheKey != null && newFile.cacheKey != null
          ? composeCacheKey(
              options.disableLineMatching === true ? "hydrated-files-raw" : "hydrated-files",
              oldFile.cacheKey,
              newFile.cacheKey,
            )
          : undefined
        : newFile.cacheKey;
  if (key == null) delete fileDiff.cacheKey;
  else fileDiff.cacheKey = key;
}

const MAX_ALIGNMENT_COMPARISONS = 4096;
const MIN_IMPROVEMENT_PER_PAIR = 0.5;

/**
 * Re-splits count-mismatched change blocks so paired lines are chosen by
 * similarity rather than position. Rendered row counts are unchanged.
 */
function realignChangeContentBySimilarity(diff: FileDiffMetadata): void {
  for (const hunk of diff.hunks) {
    for (let index = 0; index < hunk.hunkContent.length; index++) {
      const content = hunk.hunkContent[index]!;
      if (content.type !== "change") continue;
      const replacement = realignChangeBlock(diff, content);
      if (replacement != null) {
        hunk.hunkContent.splice(index, 1, ...replacement);
        index += replacement.length - 1;
      }
    }
  }
}

function realignChangeBlock(
  diff: FileDiffMetadata,
  content: ChangeContent,
): ChangeContent[] | null {
  const { deletions, additions, deletionLineIndex, additionLineIndex } = content;
  const pairCount = Math.min(deletions, additions);
  const surplus = Math.abs(additions - deletions);
  if (pairCount === 0 || surplus === 0 || pairCount * (surplus + 1) > MAX_ALIGNMENT_COMPARISONS)
    return null;
  const strippedDeletions = Array.from({ length: deletions }, (_, line) =>
    stripWhitespace(diff.deletionLines[deletionLineIndex + line] ?? ""),
  );
  const strippedAdditions = Array.from({ length: additions }, (_, line) =>
    stripWhitespace(diff.additionLines[additionLineIndex + line] ?? ""),
  );
  const additionsLonger = additions > deletions;
  let bestOffset = 0;
  let bestScore = -1;
  for (let offset = 0; offset <= surplus; offset++) {
    let score = 0;
    for (let pair = 0; pair < pairCount; pair++) {
      score += lineSimilarity(
        strippedDeletions[pair + (additionsLonger ? 0 : offset)]!,
        strippedAdditions[pair + (additionsLonger ? offset : 0)]!,
      );
    }
    if (offset === 0) bestScore = score + pairCount * MIN_IMPROVEMENT_PER_PAIR;
    else if (score > bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }
  if (bestOffset === 0) return null;
  const blocks: ChangeContent[] = [];
  const pushBlock = (
    blockDeletions: number,
    blockAdditions: number,
    deletionAt: number,
    additionAt: number,
  ) => {
    if (blockDeletions > 0 || blockAdditions > 0) {
      blocks.push({
        type: "change",
        deletions: blockDeletions,
        additions: blockAdditions,
        deletionLineIndex: deletionAt,
        additionLineIndex: additionAt,
      });
    }
  };
  if (additionsLonger) {
    pushBlock(0, bestOffset, deletionLineIndex, additionLineIndex);
    pushBlock(pairCount, pairCount, deletionLineIndex, additionLineIndex + bestOffset);
    pushBlock(
      0,
      additions - pairCount - bestOffset,
      deletionLineIndex + pairCount,
      additionLineIndex + bestOffset + pairCount,
    );
  } else {
    pushBlock(bestOffset, 0, deletionLineIndex, additionLineIndex);
    pushBlock(pairCount, pairCount, deletionLineIndex + bestOffset, additionLineIndex);
    pushBlock(
      deletions - pairCount - bestOffset,
      0,
      deletionLineIndex + bestOffset + pairCount,
      additionLineIndex + pairCount,
    );
  }
  return blocks;
}

function stripWhitespace(line: string): string {
  return line.replace(/\s+/gu, "");
}

function lineSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLength = Math.max(a.length, b.length);
  const minLength = Math.min(a.length, b.length);
  if (minLength === 0) return 0;
  let prefix = 0;
  while (prefix < minLength && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < minLength - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix])
    suffix++;
  return (prefix + suffix) / maxLength;
}
