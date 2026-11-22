import * as I from "./internal.ts";

/** Marks a defect as already reported so top-level runners don't log it twice. */
const reported = new WeakSet<object>();
export const errorReported = <E>(error: E): E => {
  if (typeof error === "object" && error !== null) reported.add(error);
  return error;
};
export const isErrorReported = (u: unknown): boolean => typeof u === "object" && u !== null && reported.has(u);
const exitCodes = new WeakMap<object, number>();
export const errorExitCode = <E>(error: E, code: number): E => {
  if (typeof error === "object" && error !== null) exitCodes.set(error, code);
  return error;
};
export const getErrorExitCode = (u: unknown): number | undefined => (typeof u === "object" && u !== null ? exitCodes.get(u) : undefined);
export type Teardown = (exit: I.Exit<unknown, unknown>, onExit: (code: number) => void) => void;
export const defaultTeardown: Teardown = (exit, onExit) => {
  if (exit._tag === "Success") return onExit(0);
  const e = exit.cause.reasons.find((r) => r._tag !== "Interrupt");
  const v = e ? (e._tag === "Fail" ? e.error : e.defect) : undefined;
  onExit(getErrorExitCode(v) ?? (e ? 1 : 0));
};
/** Run `effect` as the program main: SIGINT/SIGTERM interrupt it; exit code follows the result. */
export const makeRunMain = (
  f: (o: { readonly fiber: I.Fiber<unknown, unknown>; readonly teardown: Teardown }) => void,
) => <A, E>(effect: I.Effect<A, E>, options?: { readonly disableErrorReporting?: boolean; readonly teardown?: Teardown }): void => {
  const fiber = I.runFiber(effect, I.emptyContext) as I.Fiber<unknown, unknown>;
  if (!options?.disableErrorReporting)
    fiber.addObserver((exit) => {
      if (exit._tag === "Failure" && !exit.cause.reasons.every((r) => r._tag === "Interrupt")) {
        const v = exit.cause.reasons.map((r) => (r._tag === "Fail" ? r.error : r._tag === "Die" ? r.defect : undefined)).find((x) => x !== undefined);
        if (!isErrorReported(v)) console.error(I.prettyCause(exit.cause));
      }
    });
  f({ fiber, teardown: options?.teardown ?? defaultTeardown });
};
