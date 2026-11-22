import type { ProjectScript } from "@t3tools/contracts";
import { mFallback, msg, type MFunctionType } from "@t3tools/shared/i18n";

/** @public */
export function projectScriptMenuLabel(
  script: ProjectScript,
  resolve: MFunctionType = mFallback,
): string {
  const name = script.name;
  if (script.runOnWorktreeCreate && script.runOnSettle) {
    return resolve(msg("{name} (setup, on settle)", { name }));
  }
  if (script.runOnWorktreeCreate) return resolve(msg("{name} (setup)", { name }));
  if (script.runOnSettle) return resolve(msg("{name} (on settle)", { name }));
  return name;
}
