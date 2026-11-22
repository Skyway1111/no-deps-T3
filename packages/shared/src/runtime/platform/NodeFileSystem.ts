import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as NodePath from "node:path";
import * as I from "../internal.ts";
import * as O from "../Option.ts";
import * as Layer from "../Layer.ts";
import * as Stream from "../Stream.ts";
import * as Sink from "../Sink.ts";
import * as Q from "../Queue.ts";
import * as ScopeM from "../Scope.ts";
import * as BS from "../ByteSize.ts";
import { Done } from "../errors.ts";
import { fromNodeError, type PlatformError } from "../PlatformError.ts";
import { FileSystem, FileTypeId, make, WatchEvent, type File, type FileSystemService } from "../FileSystem.ts";

/** Await a node promise as an interruptible Effect, mapping errors to PlatformError. */
const p = <A>(method: string, path: string | number | undefined, f: () => Promise<A>): I.Effect<A, PlatformError> =>
  I.make((fib) => I.interruptibleWait<A>(fib, (res, rej) => {
    f().then(res, (e) => rej(new I.Failure(I.causeFail(fromNodeError("FileSystem", method, path)(e)))));
  }));
const typeOf = (s: FS.Stats): File.Type =>
  s.isFile() ? "File" : s.isDirectory() ? "Directory" : s.isSymbolicLink() ? "SymbolicLink" : s.isBlockDevice() ? "BlockDevice" : s.isCharacterDevice() ? "CharacterDevice" : s.isFIFO() ? "FIFO" : s.isSocket() ? "Socket" : "Unknown";
const info = (s: FS.Stats): File.Info => ({
  type: typeOf(s), mtime: O.fromNullishOr(s.mtime), atime: O.fromNullishOr(s.atime), birthtime: O.fromNullishOr(s.birthtime),
  dev: s.dev, ino: O.some(s.ino), mode: s.mode, nlink: O.some(s.nlink), uid: O.some(s.uid), gid: O.some(s.gid), rdev: O.some(s.rdev),
  size: BS.bytes(s.size), blksize: O.some(BS.bytes(s.blksize)), blocks: O.some(s.blocks),
});
const scopeOf = (f: I.Fiber) => f.context.map.get(ScopeM.Scope.key) as ScopeM.ScopeImpl;
const makeFile = (h: FSP.FileHandle, append: boolean): File => {
  let pos = 0;
  return {
    [FileTypeId]: FileTypeId,
    fd: h.fd,
    stat: p("stat", h.fd, async () => info(await h.stat())),
    seek: (offset, from) => I.make(() => BigInt((pos = from === "start" ? Number(offset) : pos + Number(offset)))),
    sync: p("sync", h.fd, () => h.sync()),
    read: (buffer) => p("read", h.fd, async () => {
      const { bytesRead } = await h.read(buffer, 0, buffer.length, pos);
      pos += bytesRead;
      return bytesRead;
    }),
    readAlloc: (size) => p("readAlloc", h.fd, async () => {
      const buf = new Uint8Array(BS.toNumber(size));
      const { bytesRead } = await h.read(buf, 0, buf.length, pos);
      pos += bytesRead;
      return bytesRead === 0 ? O.none() : O.some(buf.subarray(0, bytesRead));
    }),
    truncate: (len) => p("truncate", h.fd, () => h.truncate(len)),
    write: (buffer) => p("write", h.fd, async () => {
      const { bytesWritten } = await h.write(buffer, 0, buffer.length, append ? null : pos);
      if (!append) pos += bytesWritten;
      return bytesWritten;
    }),
    writeAll: (buffer) => p("writeAll", h.fd, async () => {
      let off = 0;
      while (off < buffer.length) {
        const { bytesWritten } = await h.write(buffer, off, buffer.length - off, append ? null : pos);
        off += bytesWritten;
        if (!append) pos += bytesWritten;
      }
    }),
  };
};
const tmpName = (o?: { directory?: string; prefix?: string; suffix?: string }) =>
  NodePath.join(o?.directory ?? OS.tmpdir(), `${o?.prefix ?? ""}${Math.random().toString(36).slice(2)}${o?.suffix ?? ""}`);
const globToRe = (g: string) =>
  new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, "(?:.*/)?")}$`);
export const fileSystem: FileSystemService = make({
  access: (path, o) => p("access", path, () => FSP.access(path, (o?.readable ? FS.constants.R_OK : 0) | (o?.writable ? FS.constants.W_OK : 0) | (o?.ok || (!o?.readable && !o?.writable) ? FS.constants.F_OK : 0))),
  copy: (from, to, o) => p("copy", from, () => FSP.cp(from, to, { recursive: true, force: o?.overwrite ?? false, preserveTimestamps: o?.preserveTimestamps, errorOnExist: !o?.overwrite })),
  copyFile: (from, to) => p("copyFile", from, () => FSP.copyFile(from, to)),
  chmod: (path, mode) => p("chmod", path, () => FSP.chmod(path, mode)),
  chown: (path, uid, gid) => p("chown", path, () => FSP.chown(path, uid, gid)),
  glob: (pattern, o) => p("glob", pattern, async () => {
    const root = o?.root ?? process.cwd();
    const re = globToRe(pattern);
    const ex = (o?.exclude ?? []).map(globToRe);
    const all = (await FSP.readdir(root, { recursive: true })) as Array<string>;
    return all.filter((f) => re.test(f) && !ex.some((x) => x.test(f)) && (o?.dot || !f.split("/").some((s) => s.startsWith("."))));
  }),
  exists: (path) => I.make((fib) => I.interruptibleWait<boolean>(fib, (res) => void FSP.access(path).then(() => res(true), () => res(false)))),
  link: (from, to) => p("link", from, () => FSP.link(from, to)),
  lstat: (path) => p("lstat", path, async () => info(await FSP.lstat(path))),
  makeDirectory: (path, o) => p("makeDirectory", path, async () => void (await FSP.mkdir(path, { recursive: o?.recursive, mode: o?.mode }))),
  makeTempDirectory: (o) => p("makeTempDirectory", o?.directory, () => FSP.mkdtemp(NodePath.join(o?.directory ?? OS.tmpdir(), o?.prefix ?? ""))),
  makeTempDirectoryScoped: (o) => I.make((f) => I.chain(I.exec(fileSystem.makeTempDirectory(o), f), (dir) => {
    scopeOf(f).add(() => p("remove", dir, () => FSP.rm(dir, { recursive: true, force: true })) as I.Effect<void>);
    return dir;
  })),
  makeTempFile: (o) => p("makeTempFile", o?.directory, async () => {
    const name = tmpName(o);
    await FSP.writeFile(name, "");
    return name;
  }),
  makeTempFileScoped: (o) => I.make((f) => I.chain(I.exec(fileSystem.makeTempFile(o), f), (file) => {
    scopeOf(f).add(() => p("remove", file, () => FSP.rm(file, { force: true })) as I.Effect<void>);
    return file;
  })),
  open: (path, o) => I.make((f) => I.chain(I.exec(p("open", path, () => FSP.open(path, o?.flag ?? "r", o?.mode)), f), (h) => {
    scopeOf(f).add(() => I.make((fib) => I.interruptibleWait<void>(fib, (res) => void h.close().then(res, res))));
    return makeFile(h, (o?.flag ?? "r").startsWith("a"));
  })),
  readDirectory: (path, o) => p("readDirectory", path, async () => (await FSP.readdir(path, { recursive: o?.recursive })) as Array<string>),
  readDirectoryEntries: (path) => p("readDirectoryEntries", path, async () =>
    (await FSP.readdir(path, { withFileTypes: true })).map((d) => ({ name: d.name, type: d.isFile() ? "File" : d.isDirectory() ? "Directory" : d.isSymbolicLink() ? "SymbolicLink" : "Unknown" as File.Type }))),
  readFile: (path) => p("readFile", path, async () => new Uint8Array(await FSP.readFile(path))),
  readFileString: (path, enc) => p("readFileString", path, () => FSP.readFile(path, { encoding: (enc ?? "utf-8") as BufferEncoding })),
  readLink: (path) => p("readLink", path, () => FSP.readlink(path)),
  realPath: (path) => p("realPath", path, () => FSP.realpath(path)),
  remove: (path, o) => p("remove", path, () => FSP.rm(path, { recursive: o?.recursive, force: o?.force })),
  rename: (from, to) => p("rename", from, () => FSP.rename(from, to)),
  sink: (path, o) => Sink.make((pull, f) => {
    const ws = FS.createWriteStream(path, { flags: o?.flag ?? "w", mode: o?.mode });
    const loop = (): I.Step<void> => I.settle(() => pull(f), (c) => {
      let ok = true;
      for (const b of c) ok = ws.write(b) && ok;
      return ok ? loop() : I.chain(I.interruptibleWait<void>(f, (res) => void ws.once("drain", res)), loop);
    }, (e) => {
      const c = I.toCause(e);
      const isDone = c.reasons.length === 1 && c.reasons[0]!._tag === "Fail" && ((c.reasons[0] as I.Fail<unknown>).error as Done)?._tag === "Done";
      return I.chain(I.interruptibleWait<void>(f, (res) => void ws.end(res)), () => (isDone ? undefined : I.failWith(c)));
    });
    return loop();
  }),
  stat: (path) => p("stat", path, async () => info(await FSP.stat(path))),
  stream: (path, o) => Stream.suspend(() => Stream.map(Stream.fromAsyncIterable(FS.createReadStream(path, {
    highWaterMark: o?.chunkSize ?? 64 * 1024,
    start: o?.offset === undefined ? undefined : BS.toNumber(o.offset),
    end: o?.bytesToRead === undefined ? undefined : (o?.offset === undefined ? 0 : BS.toNumber(o.offset)) + BS.toNumber(o.bytesToRead) - 1,
  }) as AsyncIterable<Buffer>, fromNodeError("FileSystem", "stream", path)), (b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength))),
  symlink: (from, to) => p("symlink", from, () => FSP.symlink(from, to)),
  truncate: (path, len) => p("truncate", path, () => FSP.truncate(path, len)),
  utimes: (path, atime, mtime) => p("utimes", path, () => FSP.utimes(path, atime, mtime)),
  watch: (path, o) => Stream.callback<WatchEvent>((q) => {
    const w = FS.watch(path, { recursive: o?.recursive }, (event, file) => {
      const full = file ? NodePath.join(path, file.toString()) : path;
      if (event === "rename") Q.offerUnsafe(q, FS.existsSync(full) ? WatchEvent.Create({ path: full }) : WatchEvent.Remove({ path: full }));
      else Q.offerUnsafe(q, WatchEvent.Update({ path: full }));
    });
    w.on("error", (e) => Q.failCauseUnsafe(q, I.causeFail(fromNodeError("FileSystem", "watch", path)(e)) as never));
    o?.onReady?.();
    return I.make((f) => void scopeOf(f).add(() => I.make(() => w.close())));
  }) as never,
  writeFile: (path, data, o) => p("writeFile", path, () => FSP.writeFile(path, data, { flag: o?.flag, mode: o?.mode })),
  writeFileString: (path, data, o) => p("writeFileString", path, () => FSP.writeFile(path, data, { flag: o?.flag, mode: o?.mode, encoding: "utf-8" })),
});
export const layer: Layer.Layer<FileSystem> = Layer.succeed(FileSystem, fileSystem);
