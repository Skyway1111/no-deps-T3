// @effect-diagnostics nodeBuiltinImport:off -- The Clerk bridge must lock the token file down before startup can yield to the desktop event loop.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const CLERK_TOKEN_DIRECTORY_MODE = 0o700;
const CLERK_TOKEN_FILE_MODE = 0o600;
const CLERK_TOKEN_DIRECTORY_NAME = "clerk";
const CLERK_TOKEN_FILE_NAME = "clerk-tokens.json";

type Awaitable<T> = T | Promise<T>;

export interface ClerkTokenStorage {
  readonly getItem: (key: string) => Awaitable<string | null>;
  readonly setItem: (key: string, value: string) => Awaitable<void>;
  readonly removeItem: (key: string) => Awaitable<void>;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function lstatIfExists(path: string): NodeFS.Stats | undefined {
  try {
    return NodeFS.lstatSync(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

function assertRegularFile(path: string, stat: NodeFS.Stats): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Clerk token file "${path}" must be a regular file.`);
  }
}

function restrictClerkTokenFile(path: string): void {
  const stat = lstatIfExists(path);
  if (stat === undefined) return;
  assertRegularFile(path, stat);
  if ((stat.mode & 0o777) === CLERK_TOKEN_FILE_MODE) return;
  NodeFS.chmodSync(path, CLERK_TOKEN_FILE_MODE);
}

function readTokenRecord(tokenPath: string): Record<string, string> {
  const stat = lstatIfExists(tokenPath);
  if (stat === undefined) return {};
  assertRegularFile(tokenPath, stat);
  try {
    const raw = NodeFS.readFileSync(tokenPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const record: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        record[key] = value;
      }
    }
    return record;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return {};
    return {};
  }
}

function writeTokenRecordAtomically(
  tokenPath: string,
  record: Record<string, string>,
): Promise<void> {
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  return Effect.runPromise(
    writeFileStringAtomically({ filePath: tokenPath, contents }).pipe(
      Effect.provide(NodeServices.layer),
    ),
  );
}

/**
 * Atomic, owner-only (`0600`) Clerk token storage backed by `@t3tools/shared/atomicWrite`
 * instead of `electron-store`.
 */
export function createAtomicClerkTokenStorage(directory: string): ClerkTokenStorage {
  const tokenPath = NodePath.join(directory, CLERK_TOKEN_FILE_NAME);
  let writeQueue: Promise<void> = Promise.resolve();

  const enqueueWrite = (mutate: (record: Record<string, string>) => boolean): Promise<void> => {
    const next = writeQueue.then(async () => {
      const record = readTokenRecord(tokenPath);
      if (!mutate(record)) return;
      await writeTokenRecordAtomically(tokenPath, record);
      restrictClerkTokenFile(tokenPath);
    });
    writeQueue = next.catch(() => undefined);
    return next;
  };

  return {
    getItem: async (key) => {
      await writeQueue;
      const record = readTokenRecord(tokenPath);
      return Object.prototype.hasOwnProperty.call(record, key) ? (record[key] ?? null) : null;
    },
    setItem: (key, value) =>
      enqueueWrite((record) => {
        if (record[key] === value) return false;
        record[key] = value;
        return true;
      }),
    removeItem: (key) =>
      enqueueWrite((record) => {
        if (!Object.prototype.hasOwnProperty.call(record, key)) return false;
        delete record[key];
        return true;
      }),
  };
}

function migrateLegacyClerkTokenFile(stateDir: string, directory: string): void {
  const legacyPath = NodePath.join(stateDir, CLERK_TOKEN_FILE_NAME);
  const tokenPath = NodePath.join(directory, CLERK_TOKEN_FILE_NAME);
  const legacy = lstatIfExists(legacyPath);
  if (legacy !== undefined) {
    assertRegularFile(legacyPath, legacy);
    NodeFS.chmodSync(legacyPath, CLERK_TOKEN_FILE_MODE);
  }

  const destination = lstatIfExists(tokenPath);
  if (destination === undefined) {
    if (legacy === undefined) return;
    try {
      NodeFS.copyFileSync(legacyPath, tokenPath, NodeFS.constants.COPYFILE_EXCL);
      NodeFS.chmodSync(tokenPath, CLERK_TOKEN_FILE_MODE);
      NodeFS.unlinkSync(legacyPath);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    return;
  }

  assertRegularFile(tokenPath, destination);
  NodeFS.chmodSync(tokenPath, CLERK_TOKEN_FILE_MODE);
  if (legacy === undefined) return;
  try {
    NodeFS.unlinkSync(legacyPath);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

function restrictAfter<T>(run: () => Awaitable<T>, tighten: () => void): Awaitable<T> {
  let result: Awaitable<T>;
  try {
    result = run();
  } catch (error) {
    tighten();
    throw error;
  }
  if (result instanceof Promise) return result.finally(tighten);
  tighten();
  return result;
}

/** Opens Clerk token storage in a private directory and keeps the file at `0600`. */
export function openClerkTokenStorage(
  stateDir: string,
  createStorage: (directory: string) => ClerkTokenStorage = createAtomicClerkTokenStorage,
  userDataPath = ".",
): ClerkTokenStorage {
  const absoluteStateDir = NodePath.resolve(stateDir);
  const directory = NodePath.join(absoluteStateDir, CLERK_TOKEN_DIRECTORY_NAME);
  NodeFS.mkdirSync(directory, { recursive: true, mode: CLERK_TOKEN_DIRECTORY_MODE });
  const stat = NodeFS.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Clerk token directory "${directory}" must be a real directory.`);
  }
  NodeFS.chmodSync(directory, CLERK_TOKEN_DIRECTORY_MODE);
  // Migrate any legacy token file stored relative to an older Electron userData directory.
  migrateLegacyClerkTokenFile(NodePath.resolve(userDataPath, stateDir), directory);
  const tokenPath = NodePath.join(directory, CLERK_TOKEN_FILE_NAME);
  restrictClerkTokenFile(tokenPath);

  const storage = createStorage(directory);
  const tighten = () => restrictClerkTokenFile(tokenPath);
  return {
    getItem: (key) => restrictAfter(() => storage.getItem(key), tighten),
    setItem: (key, value) => restrictAfter(() => storage.setItem(key, value), tighten),
    removeItem: (key) => restrictAfter(() => storage.removeItem(key), tighten),
  };
}
