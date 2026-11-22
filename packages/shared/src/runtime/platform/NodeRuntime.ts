import * as I from "../internal.ts";
import { makeRunMain, type Teardown } from "../Runtime.ts";

/** Run the main effect; SIGINT/SIGTERM interrupt it and the process exits with its code. */
export const runMain: <A, E>(effect: I.Effect<A, E>, options?: { readonly disableErrorReporting?: boolean; readonly teardown?: Teardown }) => void = makeRunMain(({ fiber, teardown }) => {
  const keepAlive = setInterval(() => {}, 2 ** 31 - 1);
  const onSignal = () => fiber.interruptAsFork(undefined);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  fiber.addObserver((exit) => {
    clearInterval(keepAlive);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    teardown(exit, (code) => {
      if (code !== 0 || exit._tag === "Failure") process.exit(code);
    });
  });
});
