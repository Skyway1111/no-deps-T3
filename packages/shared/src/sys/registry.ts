import { runT3Sys } from "./binary.ts";

/** A registry value; REG_EXPAND_SZ and every other type read as `other`. */
export type RegistryValue =
  | { readonly name: string; readonly type: "REG_SZ"; readonly data: string }
  | { readonly name: string; readonly type: "REG_DWORD"; readonly data: number }
  | { readonly name: string; readonly type: "other" };

export interface RegistryTree {
  readonly values: ReadonlyArray<RegistryValue>;
  readonly subkeys: Readonly<Record<string, RegistryTree>>;
}

export class RegistryReadError extends Error {
  /** The Win32 error, such as 5 for access denied; absent when the helper cannot run. */
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

/**
 * HKLM\\`subkey` in the 64-bit view and its subkeys up to `depth` levels down, read through the
 * Win32 API in one helper run; undefined when the key is absent.
 */
export async function readWindowsRegistryTree(
  subkey: string,
  depth = 16,
): Promise<RegistryTree | undefined> {
  const { code, stdout, stderr } = await runT3Sys(["reg-read", subkey, String(depth)]);
  if (code === 0) return JSON.parse(stdout) as RegistryTree;
  if (code === 2) return undefined;
  if (code === 3) throw new RegistryReadError("the registry exists only on Windows");
  const error = /"error":(\d+)/.exec(stderr)?.[1];
  throw new RegistryReadError(
    error === undefined ? `the registry reader failed (${code})` : `Windows error ${error}`,
    error === undefined ? undefined : Number(error),
  );
}
