import type { TerminalSummary } from "@t3tools/contracts";
import { mFallback, msg, type MFunctionType } from "@t3tools/shared/i18n";

import { getTerminalLabel as getServerTerminalLabel, terminalNumber } from "./terminalLabels.ts";

/** @public */
export function getTerminalLabel(terminalId: string, resolve: MFunctionType = mFallback): string {
  const numericSuffix = terminalNumber(terminalId);
  return numericSuffix ? resolve(msg("Terminal {number}", { number: numericSuffix })) : terminalId;
}

/**
 * The server sends the running process name, or its English idle default, which is shown translated.
 * @public
 */
export function resolveTerminalSessionLabel(
  terminalId: string,
  summary: Pick<TerminalSummary, "label" | "hasRunningSubprocess"> | null | undefined,
  resolve: MFunctionType = mFallback,
): string {
  const trimmed = summary?.label.trim();
  const isIdleDefault =
    !summary?.hasRunningSubprocess && trimmed === getServerTerminalLabel(terminalId);
  return trimmed && !isIdleDefault ? trimmed : getTerminalLabel(terminalId, resolve);
}
