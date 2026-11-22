// @effect-diagnostics nodeBuiltinImport:off - A separate Node process proves filesystem exclusion.
import * as NodeChildProcess from "node:child_process";
import { once } from "node:events";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { t3SysPath } from "@t3tools/shared/sys/binary";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import { withChatGptSessionLock } from "./CodexChatGptSessionLock.ts";

const instanceId = ProviderInstanceId.make("cross-process-test");
const probe = (directory: string) =>
  Effect.promise(async () => {
    const child = NodeChildProcess.spawn(t3SysPath(), ["flock", `${NodePath.join(directory, "session.bin")}.flock`], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    const [code] = await once(child, "close");
    return code === 0 && stdout.startsWith("locked") ? "acquired" : code === 3 ? "blocked" : `failed (${code})`;
  });

it.live("excludes another process and releases after the credential update", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const blocked = yield* withChatGptSessionLock(
        directory,
        "session",
        instanceId,
        probe(directory),
      );
      assert.strictEqual(blocked, "blocked");
      assert.strictEqual(yield* probe(directory), "acquired");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("releases the cross-process lease when the operation is interrupted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const entered = yield* Deferred.make<void>();
      const operation = yield* withChatGptSessionLock(
        directory,
        "session",
        instanceId,
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          return yield* Effect.never;
        }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      assert.strictEqual(yield* probe(directory), "blocked");
      yield* Fiber.interrupt(operation);
      assert.strictEqual(yield* probe(directory), "acquired");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
