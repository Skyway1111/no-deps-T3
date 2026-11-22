import * as I from "./internal.ts";
import * as Ctx from "./Context.ts";
import * as Layer from "./Layer.ts";
import * as O from "./Option.ts";
import type * as ByteSize from "./ByteSize.ts";
import type * as Stream from "./Stream.ts";
import type * as Sink from "./Sink.ts";
import type { Scope } from "./Scope.ts";
import { systemError, type PlatformError } from "./PlatformError.ts";

export const TypeId: unique symbol = Symbol.for("effect/FileSystem") as never;
export const FileTypeId: unique symbol = Symbol.for("effect/FileSystem/File") as never;
export type OpenFlag = "r" | "r+" | "w" | "wx" | "w+" | "wx+" | "a" | "ax" | "a+" | "ax+";
export type SeekMode = "start" | "current";
export interface DirectoryEntry {
  readonly name: string;
  readonly type: File.Type;
}
export interface File {
  readonly [FileTypeId]: typeof FileTypeId;
  readonly fd: File.Descriptor;
  readonly stat: I.Effect<File.Info, PlatformError>;
  readonly seek: (offset: bigint | number, from: SeekMode) => I.Effect<bigint, PlatformError>;
  readonly sync: I.Effect<void, PlatformError>;
  readonly read: (buffer: Uint8Array) => I.Effect<number, PlatformError>;
  readonly readAlloc: (size: ByteSize.Input) => I.Effect<O.Option<Uint8Array>, PlatformError>;
  readonly truncate: (length?: number) => I.Effect<void, PlatformError>;
  readonly write: (buffer: Uint8Array) => I.Effect<number, PlatformError>;
  readonly writeAll: (buffer: Uint8Array) => I.Effect<void, PlatformError>;
}
export declare namespace File {
  type Descriptor = number;
  type Type = "File" | "Directory" | "SymbolicLink" | "BlockDevice" | "CharacterDevice" | "FIFO" | "Socket" | "Unknown";
  interface Info {
    readonly type: Type;
    readonly mtime: O.Option<Date>;
    readonly atime: O.Option<Date>;
    readonly birthtime: O.Option<Date>;
    readonly dev: number;
    readonly ino: O.Option<number>;
    readonly mode: number;
    readonly nlink: O.Option<number>;
    readonly uid: O.Option<number>;
    readonly gid: O.Option<number>;
    readonly rdev: O.Option<number>;
    readonly size: ByteSize.ByteSize;
    readonly blksize: O.Option<ByteSize.ByteSize>;
    readonly blocks: O.Option<number>;
  }
}
export interface WatchOptions {
  readonly recursive?: boolean;
  readonly onReady?: () => void;
}
export type WatchEvent = WatchEvent.Create | WatchEvent.Update | WatchEvent.Remove;
export declare namespace WatchEvent {
  interface Create { readonly _tag: "Create"; readonly path: string }
  interface Update { readonly _tag: "Update"; readonly path: string }
  interface Remove { readonly _tag: "Remove"; readonly path: string }
}
export const WatchEvent = {
  Create: (o: { path: string }): WatchEvent.Create => ({ _tag: "Create", path: o.path }),
  Update: (o: { path: string }): WatchEvent.Update => ({ _tag: "Update", path: o.path }),
  Remove: (o: { path: string }): WatchEvent.Remove => ({ _tag: "Remove", path: o.path }),
};
type Eff<A, R = never> = I.Effect<A, PlatformError, R>;
export interface FileSystemService {
  readonly [TypeId]?: typeof TypeId;
  readonly access: (path: string, options?: { readonly ok?: boolean; readonly readable?: boolean; readonly writable?: boolean }) => Eff<void>;
  readonly copy: (fromPath: string, toPath: string, options?: { readonly overwrite?: boolean; readonly preserveTimestamps?: boolean }) => Eff<void>;
  readonly copyFile: (fromPath: string, toPath: string) => Eff<void>;
  readonly chmod: (path: string, mode: number) => Eff<void>;
  readonly chown: (path: string, uid: number, gid: number) => Eff<void>;
  readonly glob: (pattern: string, options?: { readonly root?: string; readonly exclude?: ReadonlyArray<string>; readonly dot?: boolean }) => Eff<Array<string>>;
  readonly exists: (path: string) => Eff<boolean>;
  readonly link: (fromPath: string, toPath: string) => Eff<void>;
  readonly lstat: (path: string) => Eff<File.Info>;
  readonly makeDirectory: (path: string, options?: { readonly recursive?: boolean; readonly mode?: number }) => Eff<void>;
  readonly makeTempDirectory: (options?: { readonly directory?: string; readonly prefix?: string }) => Eff<string>;
  readonly makeTempDirectoryScoped: (options?: { readonly directory?: string; readonly prefix?: string }) => Eff<string, Scope>;
  readonly makeTempFile: (options?: { readonly directory?: string; readonly prefix?: string; readonly suffix?: string }) => Eff<string>;
  readonly makeTempFileScoped: (options?: { readonly directory?: string; readonly prefix?: string; readonly suffix?: string }) => Eff<string, Scope>;
  readonly open: (path: string, options?: { readonly flag?: OpenFlag; readonly mode?: number; readonly noFollow?: boolean }) => Eff<File, Scope>;
  readonly readDirectory: (path: string, options?: { readonly recursive?: boolean }) => Eff<Array<string>>;
  readonly readDirectoryEntries: (path: string) => Eff<ReadonlyArray<DirectoryEntry>>;
  readonly readFile: (path: string) => Eff<Uint8Array>;
  readonly readFileString: (path: string, encoding?: string) => Eff<string>;
  readonly readLink: (path: string) => Eff<string>;
  readonly realPath: (path: string) => Eff<string>;
  readonly remove: (path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }) => Eff<void>;
  readonly rename: (oldPath: string, newPath: string) => Eff<void>;
  readonly sink: (path: string, options?: { readonly flag?: OpenFlag; readonly mode?: number }) => Sink.Sink<void, Uint8Array, never, PlatformError>;
  readonly stat: (path: string) => Eff<File.Info>;
  readonly stream: (path: string, options?: { readonly bytesToRead?: ByteSize.Input; readonly chunkSize?: number; readonly offset?: ByteSize.Input }) => Stream.Stream<Uint8Array, PlatformError>;
  readonly symlink: (fromPath: string, toPath: string) => Eff<void>;
  readonly truncate: (path: string, length?: number) => Eff<void>;
  readonly utimes: (path: string, atime: Date | number, mtime: Date | number) => Eff<void>;
  readonly watch: (path: string, options?: WatchOptions) => Stream.Stream<WatchEvent, PlatformError>;
  readonly writeFile: (path: string, data: Uint8Array, options?: { readonly flag?: OpenFlag; readonly mode?: number }) => Eff<void>;
  readonly writeFileString: (path: string, data: string, options?: { readonly flag?: OpenFlag; readonly mode?: number }) => Eff<void>;
}
export class FileSystem extends Ctx.Service<FileSystem, FileSystemService>()("effect/FileSystem") {}
export const make = (impl: Omit<FileSystemService, typeof TypeId>): FileSystemService => ({ [TypeId]: TypeId, ...impl });
/** A filesystem where every operation fails NotFound unless overridden. */
export const makeNoop = (overrides: Partial<FileSystemService>): FileSystemService => {
  const notFound = (method: string) => () => I.make(() => I.failWith(I.causeFail(systemError({ _tag: "NotFound", module: "FileSystem", method, description: "noop file system" }))));
  return new Proxy({ [TypeId]: TypeId, exists: () => I.make(() => false), ...overrides } as FileSystemService, {
    get: (t, k) => (k in t ? (t as never)[k] : typeof k === "string" ? notFound(k) : undefined),
  });
};
export const layerNoop = (overrides: Partial<FileSystemService>): Layer.Layer<FileSystem> => Layer.succeed(FileSystem, makeNoop(overrides));
export const isFile = (u: unknown): u is File => typeof u === "object" && u !== null && FileTypeId in u;
export const FileDescriptor = (n: number): File.Descriptor => n;
const use = <A>(f: (fs: FileSystemService) => I.Effect<A, PlatformError>): I.Effect<A, PlatformError, FileSystem> => FileSystem.use(f);
export const access = (path: string, options?: Parameters<FileSystemService["access"]>[1]) => use((fs) => fs.access(path, options));
export const copyFile = (from: string, to: string) => use((fs) => fs.copyFile(from, to));
export const realPath = (path: string) => use((fs) => fs.realPath(path));
export const remove = (path: string, options?: Parameters<FileSystemService["remove"]>[1]) => use((fs) => fs.remove(path, options));
export const exists = (path: string) => use((fs) => fs.exists(path));
export const readFileString = (path: string, encoding?: string) => use((fs) => fs.readFileString(path, encoding));
export const writeFileString = (path: string, data: string) => use((fs) => fs.writeFileString(path, data));
export const makeDirectory = (path: string, options?: Parameters<FileSystemService["makeDirectory"]>[1]) => use((fs) => fs.makeDirectory(path, options));
