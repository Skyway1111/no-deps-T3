// ODF, EPUB, notebook and RTF previews. Word, Excel and PowerPoint open in office/office.worker.ts.
import { checkZipDirectory } from "@t3tools/client-runtime/zip/directory";
import { MemoryZipArchive, openZip } from "@t3tools/client-runtime/zip/native-zip";
import { PREVIEW_PAGE_ROWS } from "./largeTextProtocol";
import {
  OFFICE_PREVIEW_MAX_BYTES,
  type OfficeWorkerRequest,
  type OfficeWorkerResult,
} from "./officePreviewProtocol";
import { PreviewError, previewFailure } from "./previewFailure";

const MIB = 1024 * 1024;

/** Repacked XML is UTF-8, whatever the part's declared or detected encoding. */
function utf8Xml(bytes: Uint8Array) {
  const encoding =
    (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0)
      ? "utf-16le"
      : (bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c)
        ? "utf-16be"
        : /^<\?xml\s[^?]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(
            new TextDecoder().decode(bytes.subarray(0, 256)),
          )?.[1];
  return new TextDecoder(encoding)
    .decode(bytes)
    .replace(/^(<\?xml\s[^?]*\bencoding\s*=\s*)["'][^"']+["']/i, '$1"UTF-8"');
}

// Stream each entry before handing it to an engine: a tiny compressed archive must not
// turn into an unbounded allocation.
async function boundedArchive(bytes: ArrayBuffer) {
  if (bytes.byteLength > OFFICE_PREVIEW_MAX_BYTES)
    throw new PreviewError({ code: "document-too-large" });
  checkZipDirectory(bytes);
  let source: ReturnType<typeof openZip>;
  try {
    source = openZip(bytes);
  } catch {
    throw new PreviewError({ code: "office-invalid" });
  }
  if (source.entries.length > 2048) throw new PreviewError({ code: "office-too-many-entries" });
  const archive = new MemoryZipArchive();
  let total = 0;
  for (const entry of source.entries) {
    if (entry.directory) continue;
    const xml = /\.(?:xml|rels)$/i.test(entry.name);
    const chunks: Uint8Array[] = [];
    let length = 0;
    await source.streamEntry(entry, {
      onChunk(chunk) {
        total += chunk.length;
        length += chunk.length;
        if (total > OFFICE_PREVIEW_MAX_BYTES || (entry.name.endsWith(".xml") && length > 8 * MIB))
          throw new PreviewError({ code: "office-too-large-expanded" });
        chunks.push(chunk);
      },
    });
    const content = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      content.set(chunk, offset);
      offset += chunk.length;
    }
    archive.file(entry.name, xml ? utf8Xml(content) : content);
  }
  return archive;
}

let workbook: string[][][] = [];
function reply(result: OfficeWorkerResult) {
  self.postMessage(result, { transfer: [] });
}
async function handle(input: OfficeWorkerRequest) {
  if (input.type === "sheet-page") {
    const rows = workbook[input.sheet];
    if (!rows) throw new PreviewError({ code: "sheet-unavailable" });
    reply({
      type: "sheet-page",
      sheet: input.sheet,
      index: input.index,
      rows: rows.slice(input.index * PREVIEW_PAGE_ROWS, (input.index + 1) * PREVIEW_PAGE_ROWS),
    });
    return;
  }
  const { openDocument, openEpub, openNotebook, openRtf } =
    await import("./extendedDocumentPreview");
  if (input.kind === "ipynb" || input.kind === "rtf") {
    reply(input.kind === "ipynb" ? openNotebook(input.bytes) : openRtf(input.bytes));
    return;
  }
  const archive = await boundedArchive(input.bytes);
  const result =
    input.kind === "epub" ? await openEpub(archive) : await openDocument(archive, input.kind);
  if (result.type === "ods") {
    workbook = result.sheets.map((sheet) => sheet.rows);
    reply({
      ...result,
      sheets: result.sheets.map((sheet) => ({
        ...sheet,
        rows: sheet.rows.slice(0, PREVIEW_PAGE_ROWS),
      })),
    });
  } else reply(result);
}
self.addEventListener("message", (event: MessageEvent<OfficeWorkerRequest>) => {
  void handle(event.data).catch((cause: unknown) =>
    reply({ type: "error", ...previewFailure(cause, "parse-failed") }),
  );
});
