import type * as Sdk from "@anthropic-ai/claude-agent-sdk";

// The SDK is 1.4 MB of eagerly evaluated code; load it on first use, not at server start.
let sdk: Promise<typeof Sdk> | undefined;
export const loadClaudeAgentSdk = () => (sdk ??= import("@anthropic-ai/claude-agent-sdk"));

export const forkSession: typeof Sdk.forkSession = async (...args) =>
  (await loadClaudeAgentSdk()).forkSession(...args);
export const getSessionMessages: typeof Sdk.getSessionMessages = async (...args) =>
  (await loadClaudeAgentSdk()).getSessionMessages(...args);
export const getSubagentMessages: typeof Sdk.getSubagentMessages = async (...args) =>
  (await loadClaudeAgentSdk()).getSubagentMessages(...args);
export const resolveSettings: typeof Sdk.resolveSettings = async (...args) =>
  (await loadClaudeAgentSdk()).resolveSettings(...args);
