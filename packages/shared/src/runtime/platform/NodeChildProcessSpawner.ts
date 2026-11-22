import * as CP from "node:child_process";
import * as OS from "node:os";
import { Readable, Writable } from "node:stream";
import * as I from "../internal.ts";
import * as Layer from "../Layer.ts";
import * as Stream from "../Stream.ts";
import * as Sink from "../Sink.ts";
import * as Q from "../Queue.ts";
import * as ScopeM from "../Scope.ts";
import * as D from "../Duration.ts";
import * as Red from "../Redacted.ts";
import { Done } from "../errors.ts";
import { fromNodeError, type PlatformError } from "../PlatformError.ts";
import type { Command, KillOptions, StandardCommand } from "../process/ChildProcess.ts";
import { ChildProcessSpawner, ExitCode, makeHandle, make as makeSpawner, ProcessId, type ChildProcessHandle } from "../process/ChildProcessSpawner.ts";

const plain = (w: string | Red.Redacted<string>) => (Red.isRedacted(w) ? Red.value(w) : w);
/** Node Readable → Stream of chunks (backpressured through a bounded queue). */
export const fromReadable = <E = PlatformError>(r: Readable | null | undefined, onError: (e: unknown) => E = fromNodeError("ChildProcess", "stdout") as never): Stream.Stream<Uint8Array, E> =>
  Stream.fromOpen((fib, scope) => {
    if (!r) return () => I.failWith(I.causeFail(Done()));
    const q = Q.makeUnsafe<Uint8Array, E | Done>({ capacity: Infinity });
    r.on("data", (c: Buffer | string) => q.tryOffer(typeof c === "string" ? Buffer.from(c) : new Uint8Array(c.buffer, c.byteOffset, c.byteLength)));
    r.once("end", () => q.close(I.causeFail(Done())));
    r.once("close", () => q.close(I.causeFail(Done())));
    r.once("error", (e) => q.close(I.causeFail(onError(e))));
    return Stream.fromQueue(q).open(fib, scope);
  });
const toSink = (w: Writable | null | undefined): Sink.Sink<void, Uint8Array, never, PlatformError> =>
  Sink.make((pull, f) => {
    if (!w) return undefined;
    const loop = (): I.Step<void> =>
      I.settle(() => pull(f), (chunk) => {
        let ok = true;
        for (const c of chunk) ok = w.write(c) && ok;
        return ok ? loop() : I.chain(I.interruptibleWait<void>(f, (res) => void w.once("drain", res)), loop);
      }, (e) => {
        w.end();
        const c = I.toCause(e);
        return c.reasons.length === 1 && c.reasons[0]!._tag === "Fail" && ((c.reasons[0] as I.Fail<unknown>).error as Done)?._tag === "Done" ? undefined : I.failWith(c);
      });
    return loop();
  });
function spawnStandard(cmd: StandardCommand, fib: I.Fiber, scope: ScopeM.ScopeImpl): I.Step<ChildProcessHandle> {
  const o = cmd.options;
  const env = o.env ? Object.fromEntries(Object.entries({ ...(o.extendEnv === false ? {} : process.env), ...o.env }).filter(([, v]) => v !== undefined).map(([k, v]) => [k, plain(v as string)])) : undefined;
  const ioOf = (x: unknown, dflt: "pipe"): "pipe" | "inherit" | "ignore" => (x === "inherit" || x === "ignore" ? x : typeof x === "object" && x !== null && "stream" in x ? ioOf((x as { stream: unknown }).stream, dflt) : dflt);
  let child: CP.ChildProcess;
  try {
    child = CP.spawn(cmd.command, cmd.args.map(plain), {
      cwd: o.cwd, env, shell: o.shell, detached: o.detached ?? process.platform !== "win32", windowsHide: o.windowsHide ?? true,
      stdio: [ioOf(o.stdin, "pipe"), ioOf(o.stdout, "pipe"), ioOf(o.stderr, "pipe")],
    });
  } catch (e) {
    return I.failWith(I.causeFail(fromNodeError("ChildProcess", "spawn", cmd.command)(e)));
  }
  let exit: { code: number } | { error: unknown } | undefined;
  const waiters = new Set<() => void>();
  const settle = (x: typeof exit) => {
    if (exit) return;
    exit = x;
    for (const w of [...waiters]) w();
  };
  child.once("exit", (code, signal) => settle({ code: code ?? (signal ? 128 + (signalNumber(signal) ?? 1) : 0) }));
  child.once("error", (e) => settle({ error: e }));
  const exitCode: I.Effect<ExitCode, PlatformError> = I.make((f) => {
    const done = (): I.Step<ExitCode> => ("code" in exit! ? ExitCode(exit!.code) : I.failWith(I.causeFail(fromNodeError("ChildProcess", "exitCode", cmd.command)((exit as { error: unknown }).error))));
    if (exit) return done();
    return I.chain(I.interruptibleWait<void>(f, (res) => {
      waiters.add(res);
      return () => waiters.delete(res);
    }), done);
  });
  const killWith = (k?: KillOptions): I.Effect<void, PlatformError> => I.make((f) => {
    if (exit) return undefined;
    const sig = (k?.killSignal ?? o.killSignal ?? "SIGTERM") as NodeJS.Signals;
    const send = (s: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined && process.platform !== "win32" && (o.detached ?? true)) process.kill(-child.pid, s);
        else child.kill(s);
      } catch {
        child.kill(s);
      }
    };
    send(sig);
    const force = k?.forceKillAfter ?? o.forceKillAfter;
    const timer = force === undefined ? undefined : setTimeout(() => !exit && send("SIGKILL"), D.toMillis(force));
    return I.chain(I.exec(exitCode, f), () => void clearTimeout(timer));
  });
  scope.add(() => I.make((f) => (exit ? undefined : I.settle(() => I.exec(killWith({ forceKillAfter: o.forceKillAfter ?? 3000 }), f), () => undefined, () => undefined))));
  const stdout = fromReadable(child.stdout);
  const stderr = fromReadable(child.stderr, fromNodeError("ChildProcess", "stderr"));
  if (o.stdin && typeof o.stdin === "object" && Stream.isStream(o.stdin)) I.runFiber(Stream.run(o.stdin, toSink(child.stdin)), fib.context);
  return makeHandle({
    pid: ProcessId(child.pid ?? -1),
    exitCode,
    isRunning: I.make(() => exit === undefined),
    kill: killWith,
    stdin: toSink(child.stdin),
    stdout,
    stderr,
    all: Stream.merge(stdout, stderr),
    getInputFd: (fd) => toSink(child.stdio[fd] as Writable),
    getOutputFd: (fd) => fromReadable(child.stdio[fd] as Readable),
    unref: I.make(() => {
      child.unref();
      return I.make(() => void child.ref());
    }),
  });
}
const signalNumber = (s: string): number | undefined => (OS.constants.signals as Record<string, number>)[s];
function spawnCommand(cmd: Command, fib: I.Fiber, scope: ScopeM.ScopeImpl): I.Step<ChildProcessHandle> {
  if (cmd._tag === "StandardCommand") return spawnStandard(cmd, fib, scope);
  return I.chain(spawnCommand(cmd.left, fib, scope), (left) => {
    const from = cmd.options.from === "stderr" ? left.stderr : cmd.options.from === "all" ? left.all : left.stdout;
    const right = cmd.right._tag === "StandardCommand" ? { ...cmd.right, options: { ...cmd.right.options, stdin: from } } as StandardCommand : cmd.right;
    return spawnCommand(Object.assign(Object.create(Object.getPrototypeOf(cmd.right)), right), fib, scope);
  });
}
export const spawn = (cmd: Command) => I.make<ChildProcessHandle, PlatformError, ScopeM.Scope>((f) => {
  const scope = f.context.map.get(ScopeM.Scope.key) as ScopeM.ScopeImpl | undefined;
  if (!scope) return I.serviceNotFound(ScopeM.Scope.key);
  return spawnCommand(cmd, f, scope);
});
export const layer: Layer.Layer<ChildProcessSpawner> = Layer.succeed(ChildProcessSpawner, makeSpawner(spawn));
export const layerWithSpawn = (_spawn: typeof CP.spawn): Layer.Layer<ChildProcessSpawner> => layer;
