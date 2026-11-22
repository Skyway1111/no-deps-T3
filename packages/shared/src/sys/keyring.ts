import * as NodeChildProcess from "node:child_process";

import { t3SysPath } from "./binary.ts";
import { Message, type MessageBus, Variant, sessionBus } from "./dbus.ts";

export type KeyringFailure = "needsApproval" | "unavailable";

export class KeyringError extends Error {
  readonly reason: KeyringFailure;
  constructor(reason: KeyringFailure, message: string, options?: ErrorOptions) {
    super(message, options);
    this.reason = reason;
  }
}

/**
 * The OS secret store, keyed like go-keyring so other tools' items are found: the macOS login
 * keychain (generic password SERVICE/ACCOUNT), Windows Credential Manager (`SERVICE:ACCOUNT`),
 * and elsewhere the Secret Service (attributes `service`, `username`). Never prompts on Linux.
 */
export async function getSecret(service: string, account: string): Promise<Buffer | undefined> {
  if (usesSecretService()) return withSecretService((s) => s.get(service, account));
  const result = await runHelper(["get", service, account]);
  return result.code === 2 ? undefined : result.stdout;
}

export async function setSecret(service: string, account: string, secret: string | Uint8Array): Promise<void> {
  const bytes = typeof secret === "string" ? Buffer.from(secret) : Buffer.from(secret);
  if (usesSecretService()) return withSecretService((s) => s.set(service, account, bytes));
  await runHelper(["set", service, account], bytes);
}

/** Resolves whether an item existed. */
export async function deleteSecret(service: string, account: string): Promise<boolean> {
  if (usesSecretService()) return withSecretService((s) => s.delete(service, account));
  return (await runHelper(["delete", service, account])).code === 0;
}

const usesSecretService = () => process.platform !== "darwin" && process.platform !== "win32";

function runHelper(args: string[], input?: Buffer): Promise<{ code: number; stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    let helper: string;
    try {
      helper = t3SysPath();
    } catch (cause) {
      return reject(new KeyringError("unavailable", "The keyring helper is missing.", { cause }));
    }
    const child = NodeChildProcess.execFile(
      helper,
      ["keyring", ...args],
      { encoding: "buffer", windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = typeof error?.code === "number" ? error.code : error ? -1 : 0;
        if (code === 0 || code === 2) return resolve({ code, stdout });
        const message = stderr.toString().trim() || `keyring ${args[0]} failed (${code})`;
        reject(new KeyringError(code === 3 ? "needsApproval" : "unavailable", message, { cause: error }));
      },
    );
    child.stdin?.end(input);
  });
}

const SECRETS = "org.freedesktop.secrets";
const SERVICE_PATH = "/org/freedesktop/secrets";

async function withSecretService<A>(use: (s: SecretService) => Promise<A>): Promise<A> {
  let bus: MessageBus | undefined;
  try {
    bus = sessionBus();
    bus.on("error", () => undefined);
    return await use(await SecretService.open(bus));
  } catch (cause) {
    if (cause instanceof KeyringError) throw cause;
    throw new KeyringError("unavailable", `The Secret Service is unavailable: ${String(cause)}`, { cause });
  } finally {
    bus?.disconnect();
  }
}

class SecretService {
  private readonly bus: MessageBus;
  private readonly session: string;
  private constructor(bus: MessageBus, session: string) {
    this.bus = bus;
    this.session = session;
  }

  static async open(bus: MessageBus): Promise<SecretService> {
    const reply = await call(bus, SERVICE_PATH, "Service", "OpenSession", "sv", ["plain", new Variant("s", "")]);
    return new SecretService(bus, String(reply[1]));
  }

  private async unlocked(service: string, account: string): Promise<string[]> {
    const [unlocked, locked] = (await call(this.bus, SERVICE_PATH, "Service", "SearchItems", "a{ss}", [
      { service, username: account },
    ])) as [string[], string[]];
    if (unlocked.length > 0 || locked.length === 0) return unlocked;
    const [opened, prompt] = (await call(this.bus, SERVICE_PATH, "Service", "Unlock", "ao", [locked])) as [string[], string];
    if (opened.length === 0 && prompt !== "/") throw new KeyringError("needsApproval", "The keyring is locked.");
    return opened;
  }

  async get(service: string, account: string): Promise<Buffer | undefined> {
    const [item] = await this.unlocked(service, account);
    if (!item) return undefined;
    const [secrets] = (await call(this.bus, SERVICE_PATH, "Service", "GetSecrets", "aoo", [[item], this.session])) as [
      Record<string, [string, Buffer, Buffer, string]>,
    ];
    return secrets[item]?.[2];
  }

  async set(service: string, account: string, secret: Buffer): Promise<void> {
    const [collection] = await call(this.bus, SERVICE_PATH, "Service", "ReadAlias", "s", ["default"]);
    if (!collection || collection === "/") throw new KeyringError("unavailable", "The keyring has no default collection.");
    const [, prompt] = await call(this.bus, String(collection), "Collection", "CreateItem", "a{sv}(oayays)b", [
      {
        "org.freedesktop.Secret.Item.Label": new Variant("s", `${service} (${account})`),
        "org.freedesktop.Secret.Item.Attributes": new Variant("a{ss}", { service, username: account }),
      },
      [this.session, Buffer.alloc(0), secret, "text/plain"],
      true,
    ]);
    if (prompt !== "/") throw new KeyringError("needsApproval", "The keyring is locked.");
  }

  async delete(service: string, account: string): Promise<boolean> {
    const items = await this.unlocked(service, account);
    for (const item of items) await call(this.bus, item, "Item", "Delete", "", []);
    return items.length > 0;
  }
}

async function call(bus: MessageBus, path: string, iface: string, member: string, signature: string, body: unknown[]) {
  const reply = await bus.call(
    new Message({ destination: SECRETS, path, interface: `org.freedesktop.Secret.${iface}`, member, signature, body }),
  );
  return reply?.body ?? [];
}
