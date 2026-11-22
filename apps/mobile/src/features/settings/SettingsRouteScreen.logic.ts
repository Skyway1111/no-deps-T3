import { msg } from "@t3tools/shared/i18n/react";

import { m, type MessageResolver } from "../../i18n/messages";

export function resolveAgentAwarenessPlatformPresentation(
  platform: string,
  resolve: MessageResolver = m,
): {
  readonly supported: boolean;
  readonly subtitle: string | undefined;
} {
  return platform === "ios" || platform === "android"
    ? { supported: true, subtitle: undefined }
    : { supported: false, subtitle: resolve(msg("Unavailable on this platform")) };
}
