import * as HostProcess from "@t3tools/shared/HostProcess";
import { ClonefileError, clonefile } from "@t3tools/shared/sys/clonefile";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class CheckoutCloneError extends Schema.TaggedError<CheckoutCloneError>()(
  "CheckoutCloneError",
  {
    source: Schema.String,
    destination: Schema.String,
    errno: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not clone ${this.source} to ${this.destination}${this.errno === undefined ? "" : ` (errno ${this.errno})`}.`;
  }
}

/**
 * Copies a file or a whole folder copy-on-write in one call, sharing data blocks until either
 * copy changes. The destination must not exist. Undefined where the platform has no such call.
 */
export const CheckoutCloner = Context.Reference<
  ((source: string, destination: string) => Effect.Effect<void, CheckoutCloneError>) | undefined
>("t3/vcs/CheckoutCloner", { defaultValue: () => undefined });

/** macOS `clonefile(2)`, which clones a folder hierarchy in the kernel; elsewhere nothing. */
export const layer = Layer.effect(
  CheckoutCloner,
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "darwin") return undefined;
    return Effect.fn("CheckoutCloner.clonefile")(function* (source: string, destination: string) {
      yield* Effect.tryPromise({
        try: () => clonefile(source, destination),
        catch: (cause) =>
          new CheckoutCloneError({
            source,
            destination,
            ...(cause instanceof ClonefileError && cause.errno !== undefined
              ? { errno: cause.errno }
              : {}),
            cause,
          }),
      });
    });
  }),
);
