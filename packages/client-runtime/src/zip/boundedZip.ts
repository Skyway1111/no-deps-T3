import { openZip } from "./nativeZip.ts";
import { checkZipDirectory } from "./zipDirectory.ts";
import { ZipError } from "./zipError.ts";

export const ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
export const ARCHIVE_ENTRY_MAX_BYTES = 10 * 1024 * 1024;
export const ARCHIVE_MAX_ENTRIES = 2048;
export const ARCHIVE_MAX_RATIO = 200;

export async function boundedZip(
  bytes: ArrayBuffer,
  entryLimit = ARCHIVE_MAX_BYTES,
  limits: {
    totalLimit?: number;
    xmlLimit?: number;
    ratioFloor?: number;
    markupLimit?: number;
  } = {},
) {
  if (bytes.byteLength > ARCHIVE_MAX_BYTES) throw new ZipError({ code: "file-too-large" });
  checkZipDirectory(bytes, ARCHIVE_MAX_ENTRIES);
  const zip = openZip(bytes, { maxEntries: ARCHIVE_MAX_ENTRIES });
  if (zip.entries.length > ARCHIVE_MAX_ENTRIES) {
    throw new ZipError({ code: "archive-too-many-entries" });
  }
  const files = new Map<
    string,
    { bytes: Uint8Array<ArrayBuffer>; date: Date; directory: boolean }
  >();
  const totalLimit = limits.totalLimit ?? ARCHIVE_MAX_BYTES;
  const ratioLimit = Math.max(
    limits.ratioFloor ?? 0,
    Math.max(1, bytes.byteLength) * ARCHIVE_MAX_RATIO,
  );
  const xmlLimit = limits.xmlLimit ?? 8 * 1024 * 1024;
  const markupLimit = limits.markupLimit ?? Infinity;

  let total = 0;
  let markup = 0;
  for (const entry of zip.entries) {
    if (entry.name.length > 1024) throw new ZipError({ code: "archive-path-too-long" });
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let length = 0;
    await zip.streamEntry(entry, {
      onChunk(chunk) {
        total += chunk.length;
        length += chunk.length;
        // Word relationship targets can use arbitrary extensions, so count every part.
        if (limits.markupLimit !== undefined) {
          for (const byte of chunk) if (byte === 0x3c) markup++;
        }
        if (
          markup > markupLimit ||
          total > totalLimit ||
          total > ratioLimit ||
          length > entryLimit ||
          (entry.name.endsWith(".xml") && length > xmlLimit)
        ) {
          throw new ZipError({ code: "archive-expanded-too-large" });
        }
        chunks.push(chunk);
      },
    });
    const content = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      content.set(chunk, offset);
      offset += chunk.length;
    }
    files.set(entry.name, { bytes: content, date: entry.date, directory: entry.directory });
  }
  return files;
}
