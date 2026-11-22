import * as RL from "node:readline";
import * as I from "../internal.ts";
import * as Layer from "../Layer.ts";
import { QuitError, Terminal } from "../Terminal.ts";
import { fromNodeError } from "../PlatformError.ts";

export const layer = Layer.succeed(Terminal, {
  columns: I.make(() => process.stdout.columns ?? 80),
  rows: I.make(() => process.stdout.rows ?? 24),
  isTTY: I.make(() => process.stdout.isTTY === true),
  readInput: I.make(() => undefined),
  readLine: I.make((f) => I.interruptibleWait<string>(f, (res, rej) => {
    const rl = RL.createInterface({ input: process.stdin, output: process.stdout });
    rl.once("line", (l) => (rl.close(), res(l)));
    rl.once("SIGINT", () => (rl.close(), rej(new I.Failure(I.causeFail(new QuitError())))));
    return () => rl.close();
  })),
  display: (text: string) => I.make((f) => I.interruptibleWait<void>(f, (res, rej) => {
    process.stdout.write(text, (e) => (e ? rej(new I.Failure(I.causeFail(fromNodeError("Terminal", "display")(e)))) : res()));
  })),
});
