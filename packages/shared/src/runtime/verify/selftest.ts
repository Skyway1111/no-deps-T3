// Semantics both runtimes must agree on: `[RUNTIME=effect] node --experimental-strip-types --import ./alias.mjs selftest.ts`.
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";

let passed = 0;
const test = async (name: string, f: () => unknown) => {
  try {
    await f();
    passed++;
  } catch (e) {
    console.error(`FAIL ${name}`);
    throw e;
  }
};
const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e);

class Cfg extends Context.Service<Cfg, { readonly port: number }>()("selftest/Cfg") {}
class Boom extends Schema.TaggedError<Boom>()("Boom", { n: Schema.Number }) {}

await test("gen + services + layers", async () => {
  const prog = Effect.gen(function* () {
    const c = yield* Cfg;
    const o = yield* Effect.fromOption(Option.some(2));
    yield* Effect.sleep(1);
    return c.port + o;
  });
  assert.equal(await run(prog.pipe(Effect.provide(Layer.succeed(Cfg, { port: 40 })))), 42);
  assert.equal(Effect.runSync(Effect.provideService(Effect.map(Cfg, (c) => c.port), Cfg, { port: 1 })), 1);
});
await test("typed errors", async () => {
  assert.equal(await run(Effect.fail(new Boom({ n: 3 })).pipe(Effect.catchTag("Boom", (b) => Effect.succeed(b.n)))), 3);
  assert.equal((await run(Effect.flip(new Boom({ n: 4 })))).n, 4);
  const exit = await Effect.runPromiseExit(Effect.die("x"));
  assert.ok(Exit.isFailure(exit) && Exit.hasDies(exit));
  assert.equal(await run(Effect.fail(1).pipe(Effect.orElseSucceed(() => 2))), 2);
});
await test("stack safety (100k nested flatMap)", async () => {
  const loop = (n: number): Effect.Effect<number> => (n === 0 ? Effect.succeed(0) : Effect.flatMap(Effect.succeed(n), () => loop(n - 1)));
  assert.equal(await run(loop(100_000)), 0);
});
await test("interruption runs finalizers", async () => {
  let finalized = 0;
  await run(Effect.gen(function* () {
    const f = yield* Effect.forkChild(Effect.never.pipe(Effect.ensuring(Effect.sync(() => finalized++))));
    yield* Effect.sleep(1);
    yield* Fiber.interrupt(f);
  }));
  assert.equal(finalized, 1);
});
await test("scoped resources release in reverse", async () => {
  const log: Array<string> = [];
  const res = (n: string) => Effect.acquireRelease(Effect.sync(() => (log.push(`+${n}`), n)), () => Effect.sync(() => log.push(`-${n}`)));
  await run(Effect.scoped(Effect.all([res("a"), res("b")])));
  assert.deepEqual(log, ["+a", "+b", "-b", "-a"]);
});
await test("timeout / race / retry / repeat", async () => {
  const t = await Effect.runPromiseExit(Effect.sleep(1000).pipe(Effect.timeout(5)));
  assert.ok(Exit.isFailure(t));
  assert.equal(await run(Effect.raceFirst(Effect.sleep(20).pipe(Effect.as("slow")), Effect.sleep(1).pipe(Effect.as("fast")))), "fast");
  let tries = 0;
  assert.equal(await run(Effect.suspend(() => (++tries < 3 ? Effect.fail("x") : Effect.succeed(tries))).pipe(Effect.retry(Schedule.spaced(1)))), 3);
  let runs = 0;
  await run(Effect.sync(() => runs++).pipe(Effect.repeat(Schedule.recurs(3))));
  assert.equal(runs, 4);
});
await test("concurrency: all, semaphore, deferred, queue", async () => {
  assert.deepEqual(await run(Effect.all([Effect.succeed(1), Effect.sleep(2).pipe(Effect.as(2))], { concurrency: "unbounded" })), [1, 2]);
  let active = 0, max = 0;
  await run(Effect.gen(function* () {
    const sem = yield* Semaphore.make(2);
    yield* Effect.forEach([1, 2, 3, 4, 5], () => sem.withPermits(1)(Effect.gen(function* () {
      max = Math.max(max, ++active);
      yield* Effect.sleep(2);
      active--;
    })), { concurrency: "unbounded" });
  }));
  assert.equal(max, 2);
  assert.equal(await run(Effect.gen(function* () {
    const d = yield* Deferred.make<number>();
    yield* Effect.forkChild(Effect.delay(Deferred.succeed(d, 7), 1));
    return yield* Deferred.await(d);
  })), 7);
  assert.deepEqual(await run(Effect.gen(function* () {
    const q = yield* Queue.unbounded<number, any>();
    yield* Effect.forkChild(Effect.gen(function* () {
      for (let i = 0; i < 3; i++) yield* Queue.offer(q, i);
      yield* Queue.end(q);
    }));
    return yield* Stream.runCollect(Stream.fromQueue(q));
  })), [0, 1, 2]);
});
await test("streams", async () => {
  assert.deepEqual(await run(Stream.runCollect(Stream.make(1, 2, 3, 4, 5, 6).pipe(Stream.map((n) => n * 2), Stream.filter((n) => n % 3 !== 0), Stream.take(3)))), [2, 4, 8]);
  assert.deepEqual(await run(Stream.runCollect(Stream.make(1, 2).pipe(Stream.flatMap((n) => Stream.make(n, n * 10))))), [1, 10, 2, 20]);
  assert.deepEqual(await run(Stream.runCollect(Stream.make("ab\ncd", "e\nf").pipe(Stream.splitLines))), ["ab", "cde", "f"]);
  assert.deepEqual(await run(Stream.runCollect(Stream.fail("bad").pipe(Stream.catch((e) => Stream.make(e))))), ["bad"]);
  assert.deepEqual((await run(Stream.runCollect(Stream.merge(Stream.make(1, 2), Stream.make(3, 4))))).sort(), [1, 2, 3, 4]);
});
await test("SubscriptionRef.changes", async () => {
  assert.deepEqual(await run(Effect.gen(function* () {
    const ref = yield* SubscriptionRef.make(0);
    const f = yield* Effect.forkChild(Stream.runCollect(Stream.take(SubscriptionRef.changes(ref), 3)));
    yield* Effect.sleep(1);
    yield* SubscriptionRef.set(ref, 1);
    yield* SubscriptionRef.update(ref, (n) => n + 1);
    return yield* Fiber.join(f);
  })), [0, 1, 2]);
  assert.equal(await run(Effect.gen(function* () {
    const r = yield* Ref.make(1);
    yield* Ref.update(r, (n) => n + 1);
    return yield* Ref.get(r);
  })), 2);
});
await test("schema decode/encode/defaults", () => {
  const User = Schema.Struct({
    id: Schema.String,
    age: Schema.Number.check(Schema.isInt()),
    nick: Schema.optionalKey(Schema.String),
    mode: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("auto"))),
    at: Schema.DateTimeUtcFromString,
  });
  const u = Schema.decodeUnknownSync(User)({ id: "u", age: 3, at: "2024-01-01T00:00:00.000Z", extra: 1 });
  assert.deepEqual(Object.keys(u), ["id", "age", "mode", "at"]);
  assert.equal(u.mode, "auto");
  assert.deepEqual(Schema.encodeSync(User)(u), { id: "u", age: 3, mode: "auto", at: "2024-01-01T00:00:00.000Z" });
  assert.throws(() => Schema.decodeUnknownSync(User)({ id: "u", age: 1.5, at: "x" }), /Expected an integer/);
  const e = new Boom({ n: 1 });
  assert.ok(e instanceof Error && e._tag === "Boom");
  const back = Schema.decodeUnknownSync(Boom)(Schema.encodeSync(Boom)(e));
  assert.ok(back instanceof Boom && back.n === 1);
  const T = Schema.String.pipe(Schema.decodeTo(Schema.Number, SchemaTransformation.transformEffect({
    decode: (s: string) => (s === "x" ? Effect.fail(new SchemaIssue.InvalidValue({ message: "no x" })) : Effect.succeed(s.length)),
    encode: (n: number) => Effect.succeed("a".repeat(n)),
  })));
  assert.equal(Schema.decodeUnknownSync(T)("abc"), 3);
  assert.throws(() => Schema.decodeUnknownSync(T)("x"), /no x/);
  const J = Schema.toCodecJson(Schema.Struct({ o: Schema.Option(Schema.Number) }));
  assert.deepEqual(Schema.encodeSync(J)({ o: Option.some(1) }), { o: { _tag: "Some", value: 1 } });
});
await test("atoms", async () => {
  const reg = AtomRegistry.make();
  const count = Atom.make(1);
  const doubled = Atom.make((get) => get(count) * 2);
  const seen: Array<number> = [];
  const un = reg.subscribe(doubled, (v) => seen.push(v));
  reg.set(count, 2);
  reg.set(count, 3);
  assert.deepEqual(seen, [4, 6]);
  const eff = Atom.make(Effect.sleep(2).pipe(Effect.as("done")));
  const unE = reg.mount(eff);
  assert.equal(reg.get(eff)._tag, "Initial");
  assert.equal(await run(AtomRegistry.getResult(reg, eff)), "done");
  const rt = Atom.runtime(Layer.succeed(Cfg, { port: 6 }));
  const ra = rt.atom(Effect.map(Cfg, (c) => c.port * 7));
  const unR = reg.mount(ra);
  assert.equal(AsyncResult.getOrElse(reg.get(ra), () => 0), 42);
  un();
  unE();
  unR();
});
console.log(`selftest: ${passed} groups passed`);
