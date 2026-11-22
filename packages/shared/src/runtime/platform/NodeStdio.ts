import * as I from "../internal.ts";
import * as Layer from "../Layer.ts";
import * as Stream from "../Stream.ts";
import * as Sink from "../Sink.ts";
import { Stdio } from "../Stdio.ts";
import { fromReadable } from "./NodeChildProcessSpawner.ts";

const enc = new TextEncoder();
const writer = (out: NodeJS.WriteStream) => () =>
  Sink.forEach((chunk: Uint8Array | string) => I.make((f) => I.interruptibleWait<void>(f, (res) => void out.write(typeof chunk === "string" ? enc.encode(chunk) : chunk, () => res()))));
export const layer = Layer.succeed(Stdio, {
  args: I.make(() => process.argv.slice(2)),
  stdin: Stream.suspend(() => fromReadable(process.stdin)),
  stdout: writer(process.stdout),
  stderr: writer(process.stderr),
});
