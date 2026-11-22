import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const NAME = process.platform === "win32" ? "t3-sys.exe" : "t3-sys";
let resolved: string | undefined;

/** Candidate locations: override, packaged app resources, beside the executable, then a cargo build in an ancestor (source or bundled dist). */
export function t3SysCandidates(): string[] {
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  const executableDir = NodePath.dirname(process.execPath);
  const ancestors = Array.from({ length: 7 }, (_, up) =>
    NodePath.resolve(import.meta.dirname, "../".repeat(up)),
  );
  return [
    process.env.T3CODE_SYS_PATH,
    resources && NodePath.join(resources, "t3-sys", NAME),
    NodePath.join(import.meta.dirname, "t3-sys", NAME),
    NodePath.join(executableDir, "t3-sys", NAME),
    ...["release", "debug"].flatMap((profile) =>
      ancestors.map((dir) => NodePath.join(dir, "native/t3-sys/target", profile, NAME)),
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

export function t3SysPath(): string {
  if (resolved) return resolved;
  const candidates = t3SysCandidates();
  // Packaged Electron apps unpack native binaries next to the ASAR archive.
  const found = candidates
    .map((candidate) => candidate.replace(/\.asar([\\/])/, ".asar.unpacked$1"))
    .find((candidate) => NodeFS.statSync(candidate, { throwIfNoEntry: false })?.isFile());
  if (!found) throw new Error(`The t3-sys helper is missing. Looked in: ${candidates.join(", ")}`);
  return (resolved = found);
}
