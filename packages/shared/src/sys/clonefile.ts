import { runT3Sys } from "./binary.ts";

export class ClonefileError extends Error {
  /** The failed call's errno; absent when the platform has no clonefile. */
  readonly errno: number | undefined;
  constructor(message: string, errno?: number) {
    super(message);
    this.errno = errno;
  }
}

/**
 * macOS clonefile(2): copies a file or a whole folder copy-on-write in one kernel call, sharing
 * data blocks until either copy changes. The destination must not exist.
 */
export async function clonefile(source: string, destination: string): Promise<void> {
  const { code, stderr } = await runT3Sys(["clonefile", source, destination]);
  if (code === 0) return;
  if (code === 2) throw new ClonefileError("clonefile is not supported on this platform");
  const errno = /"errno":(-?\d+)/.exec(stderr)?.[1];
  throw new ClonefileError(
    `clonefile failed: ${stderr.trim()}`,
    errno === undefined ? undefined : Number(errno),
  );
}
