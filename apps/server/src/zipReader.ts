// @effect-diagnostics nodeBuiltinImport:off -- Effect-free so the document text worker can share it.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeStream from "node:stream";
import * as NodeZlib from "node:zlib";

export interface ZipEntry {
  readonly fileName: string;
  readonly compressionMethod: number;
  readonly generalPurposeBitFlag: number;
  readonly externalFileAttributes: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_U32 = 0xffffffff;

async function readAt(file: NodeFSP.FileHandle, position: number, length: number) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error("Truncated ZIP archive.");
  return buffer;
}

/** Random-access ZIP reader: the central directory is read once and members stream from disk. */
export class ZipReader {
  readonly entries: ReadonlyArray<ZipEntry>;
  private readonly file: NodeFSP.FileHandle;

  private constructor(file: NodeFSP.FileHandle, entries: ZipEntry[]) {
    this.file = file;
    this.entries = entries;
  }

  static async open(path: string): Promise<ZipReader> {
    const file = await NodeFSP.open(path, "r");
    try {
      const { size } = await file.stat();
      const tailLength = Math.min(size, 22 + 0xffff);
      const tail = await readAt(file, size - tailLength, tailLength);
      let eocd = tail.length - 22;
      while (
        eocd >= 0 &&
        !(
          tail.readUInt32LE(eocd) === EOCD &&
          eocd + 22 + tail.readUInt16LE(eocd + 20) === tail.length
        )
      )
        eocd--;
      if (eocd < 0) throw new Error("Not a ZIP archive.");
      let count = tail.readUInt16LE(eocd + 10);
      let directorySize = tail.readUInt32LE(eocd + 12);
      let directoryOffset = tail.readUInt32LE(eocd + 16);
      if (count === 0xffff || directorySize === MAX_U32 || directoryOffset === MAX_U32) {
        if (eocd < 20 || tail.readUInt32LE(eocd - 20) !== ZIP64_LOCATOR)
          throw new Error("Invalid ZIP64 archive.");
        const record = await readAt(file, Number(tail.readBigUInt64LE(eocd - 12)), 56);
        if (record.readUInt32LE(0) !== ZIP64_EOCD) throw new Error("Invalid ZIP64 archive.");
        count = Number(record.readBigUInt64LE(32));
        directorySize = Number(record.readBigUInt64LE(40));
        directoryOffset = Number(record.readBigUInt64LE(48));
      }
      if (directoryOffset + directorySize > size) throw new Error("Invalid ZIP central directory.");
      const directory = await readAt(file, directoryOffset, directorySize);
      const entries: ZipEntry[] = [];
      for (let at = 0; entries.length < count;) {
        if (at + 46 > directory.length || directory.readUInt32LE(at) !== CENTRAL)
          throw new Error("Invalid ZIP central directory entry.");
        const nameLength = directory.readUInt16LE(at + 28);
        const extraLength = directory.readUInt16LE(at + 30);
        const next = at + 46 + nameLength + extraLength + directory.readUInt16LE(at + 32);
        if (next > directory.length) throw new Error("Invalid ZIP central directory entry.");
        const fileName = directory.toString("utf8", at + 46, at + 46 + nameLength);
        if (
          fileName.includes("\\") ||
          /^(?:\/|[A-Za-z]:)/.test(fileName) ||
          fileName.split("/").includes("..")
        )
          throw new Error("Unsafe ZIP member path.");
        const sizes = [
          directory.readUInt32LE(at + 24),
          directory.readUInt32LE(at + 20),
          directory.readUInt32LE(at + 42),
        ];
        // ZIP64 extra field: 8-byte values only for the fields saturated above, in this order.
        for (let extra = at + 46 + nameLength; extra + 4 <= at + 46 + nameLength + extraLength;) {
          const length = directory.readUInt16LE(extra + 2);
          if (directory.readUInt16LE(extra) === 1) {
            let value = extra + 4;
            for (const [index, size] of sizes.entries()) {
              if (size !== MAX_U32 || value + 8 > extra + 4 + length) continue;
              sizes[index] = Number(directory.readBigUInt64LE(value));
              value += 8;
            }
          }
          extra += 4 + length;
        }
        entries.push({
          fileName,
          generalPurposeBitFlag: directory.readUInt16LE(at + 8),
          compressionMethod: directory.readUInt16LE(at + 10),
          externalFileAttributes: directory.readUInt32LE(at + 38),
          uncompressedSize: sizes[0]!,
          compressedSize: sizes[1]!,
          localHeaderOffset: sizes[2]!,
        });
        at = next;
      }
      return new ZipReader(file, entries);
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  /** Streams a member's bytes, failing unless they total its declared uncompressed size. */
  async openReadStream(entry: ZipEntry): Promise<NodeStream.Readable> {
    if (entry.generalPurposeBitFlag & 1) throw new Error("Encrypted ZIP member.");
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)
      throw new Error("Unsupported ZIP compression method.");
    const header = await readAt(this.file, entry.localHeaderOffset, 30);
    if (header.readUInt32LE(0) !== LOCAL) throw new Error("Invalid ZIP local header.");
    const start = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    let seen = 0;
    const counted = new NodeStream.Transform({
      transform(chunk: Buffer, _encoding, done) {
        seen += chunk.length;
        done(
          seen > entry.uncompressedSize ? new Error("ZIP member exceeds its declared size.") : null,
          chunk,
        );
      },
      flush(done) {
        done(
          seen === entry.uncompressedSize
            ? null
            : new Error("ZIP member is shorter than its declared size."),
        );
      },
    });
    if (entry.compressedSize === 0) return NodeStream.Readable.from([]).pipe(counted);
    // A numeric fd: FileHandle.createReadStream adds a close listener to the handle per member.
    const raw = NodeFS.createReadStream("", {
      fd: this.file.fd,
      start,
      end: start + entry.compressedSize - 1,
      autoClose: false,
    });
    const noop = () => {};
    return entry.compressionMethod === 8
      ? NodeStream.pipeline(raw, NodeZlib.createInflateRaw(), counted, noop)
      : NodeStream.pipeline(raw, counted, noop);
  }

  close(): Promise<void> {
    return this.file.close();
  }
}
