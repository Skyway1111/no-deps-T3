// @effect-diagnostics nodeBuiltinImport:off - A separate Node process stands in for another server.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import { once } from "node:events";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { t3SysPath } from "@t3tools/shared/sys/binary";
import {
  machineLockFile,
  makeProviderMaintenanceCommandCoordinator,
} from "./providerMaintenanceCommandCoordinator.ts";

const probe = (file: string) =>
  Effect.promise(async () => {
    const child = NodeChildProcess.spawn(t3SysPath(), ["flock", `${file}.flock`], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    const [code] = await once(child, "close");
    return code === 0 && stdout.startsWith("locked") ? "acquired" : code === 3 ? "blocked" : `failed (${code})`;
  });

it.live("holds the update's lock key against other server processes while it runs", () =>
  Effect.gen(function* () {
    const lockKey = `test:${NodeCrypto.randomUUID()}`;
    const coordinator = yield* makeProviderMaintenanceCommandCoordinator({
      makeAlreadyRunningError: () => "already running",
    });
    const duringUpdate = yield* coordinator.withCommandLock({
      targetKey: "instance:test",
      lockKey,
      run: probe(machineLockFile(lockKey)),
    });
    assert.strictEqual(duringUpdate, "blocked");
    assert.strictEqual(yield* probe(machineLockFile(lockKey)), "acquired");
  }),
);
