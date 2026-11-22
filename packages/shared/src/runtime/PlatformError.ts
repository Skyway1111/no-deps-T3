import { TaggedError } from "./errors.ts";

export type SystemErrorTag = "AlreadyExists" | "BadResource" | "Busy" | "InvalidData" | "NotFound" | "PermissionDenied" | "TimedOut" | "UnexpectedEof" | "Unknown" | "WouldBlock" | "WriteZero";
export const SystemErrorTag = (tag: SystemErrorTag) => tag;
export class BadArgument extends TaggedError("BadArgument")<{ module: string; method: string; description?: string | undefined; cause?: unknown }> {
  override get message() {
    return `${this.module}.${this.method}${this.description ? `: ${this.description}` : ""}`;
  }
}
export class SystemError extends TaggedError("SystemError")<{ module: string; method: string; description?: string | undefined; syscall?: string | undefined; pathOrDescriptor?: string | number | undefined; cause?: unknown }> {
  declare readonly reasonTag: SystemErrorTag;
  override get message() {
    return `${this.reasonTag}: ${this.module}.${this.method}${this.pathOrDescriptor !== undefined ? ` (${this.pathOrDescriptor})` : ""}${this.description ? `: ${this.description}` : ""}`;
  }
}
/** `reason._tag` is the SystemErrorTag (e.g. "NotFound") or "BadArgument". */
export class PlatformError extends TaggedError("PlatformError")<{ reason: (SystemError & { readonly _tag: SystemErrorTag }) | BadArgument }> {
  constructor(reason: SystemError | BadArgument) {
    super({ reason } as never);
  }
  override get message() {
    return this.reason.message;
  }
}
export const isPlatformError = (u: unknown): u is PlatformError => u instanceof PlatformError;
export const systemError = (o: { readonly _tag: SystemErrorTag; readonly module: string; readonly method: string; readonly description?: string | undefined; readonly syscall?: string | undefined; readonly pathOrDescriptor?: string | number | undefined; readonly cause?: unknown }): PlatformError => {
  const e = new SystemError({ module: o.module, method: o.method, description: o.description, syscall: o.syscall, pathOrDescriptor: o.pathOrDescriptor, cause: o.cause });
  Object.defineProperty(e, "_tag", { value: o._tag, enumerable: true });
  Object.defineProperty(e, "reasonTag", { value: o._tag });
  return new PlatformError(e);
};
export const badArgument = (o: { readonly module: string; readonly method: string; readonly description?: string | undefined; readonly cause?: unknown }): PlatformError =>
  new PlatformError(new BadArgument(o));
const codeTags: Record<string, SystemErrorTag> = {
  ENOENT: "NotFound", EEXIST: "AlreadyExists", EACCES: "PermissionDenied", EPERM: "PermissionDenied", EBUSY: "Busy",
  ETIMEDOUT: "TimedOut", EBADF: "BadResource", EAGAIN: "WouldBlock", EISDIR: "InvalidData", ENOTDIR: "InvalidData", ENOTEMPTY: "Busy",
};
/** Map a Node error (with `code`) to a PlatformError. */
export const fromNodeError = (module: string, method: string, path?: string | number) => (err: unknown): PlatformError => {
  const e = err as NodeJS.ErrnoException;
  return systemError({ _tag: codeTags[e?.code ?? ""] ?? "Unknown", module, method, description: e?.message, syscall: e?.syscall, pathOrDescriptor: path ?? e?.path, cause: err });
};
