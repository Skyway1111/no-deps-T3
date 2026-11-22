import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { spawnPty } from "@t3tools/shared/sys/pty";

const make = Effect.fn("SysPtyAdapter.make")(function* () {
  const platform = yield* HostProcess.Platform;
  return PtyAdapter.PtyAdapter.of({
    spawn: Effect.fn("SysPtyAdapter.spawn")(function* (input) {
      // ConPTY sets no TERM, so keep any the caller chose there; POSIX terminals are always xterm-256color.
      const env =
        platform === "win32"
          ? { ...input.env, TERM: input.env["TERM"] ?? "xterm-256color" }
          : { ...input.env, TERM: "xterm-256color", PWD: input.cwd };
      return yield* Effect.tryPromise({
        try: () => spawnPty(input.shell, input.args ?? [], { cols: input.cols, rows: input.rows, cwd: input.cwd, env }),
        catch: (cause) => new PtyAdapter.PtySpawnError({ adapter: "t3-sys", shell: input.shell, cause }),
      });
    }),
  });
});

export const layer = Layer.effect(PtyAdapter.PtyAdapter, make());
