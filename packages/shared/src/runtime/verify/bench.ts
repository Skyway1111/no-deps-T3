// Same source on either runtime: `[RUNTIME=effect] node --experimental-strip-types --import ./alias.mjs bench.ts <label>`.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Fiber from "effect/Fiber";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Ref from "effect/Ref";
import { Atom, AtomRegistry } from "effect/reactivity";
import * as FileSystem from "effect/FileSystem";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HttpClient, FetchHttpClient } from "effect/http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as http from "node:http";
import * as fsSync from "node:fs";

const label = process.argv[2] ?? "?";
const results: Record<string, number> = {};
async function bench(name: string, ops: number, run: () => unknown | Promise<unknown>) {
  for (let i = 0; i < 2; i++) await run();
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    await run();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  results[name] = (ops / times[2]!) * 1000;
}

// --- Effect core ---
const genProgram = Effect.gen(function* () {
  let acc = 0;
  for (let i = 0; i < 10; i++) acc += yield* Effect.succeed(i);
  const r = yield* Effect.sync(() => acc * 2);
  return yield* Effect.map(Effect.succeed(r), (x) => x + 1);
});
await bench("Effect.gen sync (10 yields) runSync", 20000, () => {
  for (let i = 0; i < 20000; i++) Effect.runSync(genProgram);
});
const fnProgram = Effect.fn("bench.fn")(function* (n: number) {
  const a = yield* Effect.succeed(n);
  return a + 1;
});
await bench("Effect.fn (named span) runSync", 20000, () => {
  for (let i = 0; i < 20000; i++) Effect.runSync(fnProgram(i));
});
const pipeline = Effect.succeed(1).pipe(
  Effect.map((n) => n + 1),
  Effect.flatMap((n) => Effect.succeed(n * 2)),
  Effect.tap(() => Effect.void),
  Effect.catch(() => Effect.succeed(0)),
  Effect.ensuring(Effect.void),
);
await bench("map/flatMap/tap/catch/ensuring runSync", 20000, () => {
  for (let i = 0; i < 20000; i++) Effect.runSync(pipeline);
});
class Tagged extends Schema.TaggedError<Tagged>()("Tagged", { n: Schema.Number }) {}
const failing = Effect.fail(new Tagged({ n: 1 })).pipe(Effect.catchTag("Tagged", (e) => Effect.succeed(e.n)));
await bench("fail + catchTag runSync", 20000, () => {
  for (let i = 0; i < 20000; i++) Effect.runSync(failing);
});
const asyncChain = Effect.gen(function* () {
  let acc = 0;
  for (let i = 0; i < 10; i++) acc += yield* Effect.promise(() => Promise.resolve(i));
  return acc;
});
await bench("Effect.promise x10 runPromise", 2000, async () => {
  for (let i = 0; i < 2000; i++) await Effect.runPromise(asyncChain);
});
await bench("Effect.all 100 concurrent (sync children)", 1000, () => {
  const effs = Array.from({ length: 100 }, (_, i) => Effect.succeed(i));
  return Effect.runPromise(Effect.forEach(Array.from({ length: 1000 }), () => Effect.all(effs, { concurrency: "unbounded" }), { discard: true }));
});
await bench("forkChild + join x1000", 1000, () =>
  Effect.runPromise(Effect.forEach(Array.from({ length: 1000 }), () => Effect.flatMap(Effect.forkChild(Effect.succeed(1)), Fiber.join), { discard: true })),
);

// --- Schema ---
const User = Schema.Struct({
  id: Schema.String,
  name: Schema.String.check(Schema.isMaxLength(100)),
  age: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  email: Schema.optionalKey(Schema.String),
  tags: Schema.Array(Schema.String),
  role: Schema.Literals(["admin", "user", "guest"]),
  address: Schema.NullOr(Schema.Struct({ street: Schema.String, city: Schema.String, zip: Schema.String })),
  createdAt: Schema.String,
});
const userData = { id: "u1", name: "Ada", age: 36, email: "a@b.c", tags: ["x", "y", "z"], role: "admin", address: { street: "1 Main", city: "X", zip: "00000" }, createdAt: "2024-01-01" };
const decodeUser = Schema.decodeUnknownSync(User);
await bench("Schema.decodeUnknownSync struct (8 fields, nested)", 100000, () => {
  for (let i = 0; i < 100000; i++) decodeUser(userData);
});
const encodeUser = Schema.encodeSync(User);
const decodedUser = decodeUser(userData);
await bench("Schema.encodeSync struct", 100000, () => {
  for (let i = 0; i < 100000; i++) encodeUser(decodedUser);
});
const Event = Schema.Union(
  Array.from({ length: 20 }, (_, i) => Schema.Struct({ type: Schema.Literal(`event.${i}`), payload: Schema.Struct({ id: Schema.String, n: Schema.Number }) })),
);
const decodeEvent = Schema.decodeUnknownSync(Event);
const ev = { type: "event.17", payload: { id: "x", n: 1 } };
await bench("Schema tagged union (20 members) decode", 100000, () => {
  for (let i = 0; i < 100000; i++) decodeEvent(ev);
});
const isUser = Schema.is(User);
await bench("Schema.is struct", 100000, () => {
  for (let i = 0; i < 100000; i++) isUser(decodedUser);
});
const Json = Schema.fromJsonString(User);
const userJson = JSON.stringify(userData);
const decodeJson = Schema.decodeUnknownSync(Json);
await bench("Schema.fromJsonString decode", 50000, () => {
  for (let i = 0; i < 50000; i++) decodeJson(userJson);
});
const Settings = (await import("../../../../contracts/src/settings.ts")).ServerSettings;
const decodeSettings = Schema.decodeUnknownSync(Settings);
await bench("contracts ServerSettings decode (real T3 schema)", 2000, () => {
  for (let i = 0; i < 2000; i++) decodeSettings({});
});
await bench("TaggedError construct (validated)", 50000, () => {
  for (let i = 0; i < 50000; i++) new Tagged({ n: i });
});

// --- Layer ---
const services = Array.from({ length: 20 }, (_, i) => Context.Service<any>(`Svc${i}`));
const layers = services.map((s, i) => (i === 0 ? Layer.succeed(s, { i }) : Layer.effect(s, Effect.map(services[i - 1] as never, (prev: any) => ({ i: prev.i + 1 }))).pipe(Layer.provide(Layer.succeed(services[i - 1] as never, { i: i - 1 })))));
const all = Layer.mergeAll(...(layers as [any, ...any[]]));
const useLast = Effect.map(services[19] as never, (s: any) => s.i);
await bench("Layer build+provide (20 services)", 2000, async () => {
  for (let i = 0; i < 2000; i++) await Effect.runPromise(Effect.provide(useLast, all) as never);
});

// --- Stream ---
const rangeStream = Stream.fromIterable(Array.from({ length: 100000 }, (_, i) => i)).pipe(
  Stream.map((n) => n * 2),
  Stream.filter((n) => n % 3 === 0),
  Stream.take(20000),
);
await bench("Stream map/filter/take runCollect (100k)", 100000, () => Effect.runPromise(Stream.runCollect(rangeStream)));
await bench("Stream mapEffect runDrain (10k)", 10000, () =>
  Effect.runPromise(Stream.runDrain(Stream.fromIterable(Array.from({ length: 10000 }, (_, i) => i)).pipe(Stream.mapEffect((n) => Effect.succeed(n + 1))))),
);

// --- Queue / Semaphore ---
await bench("Queue producer/consumer (50k)", 50000, () =>
  Effect.runPromise(Effect.gen(function* () {
    const q = yield* Queue.bounded<number>(64);
    const consumer = yield* Effect.forkChild(Effect.gen(function* () {
      let sum = 0;
      for (let i = 0; i < 50000; i++) sum += yield* Queue.take(q);
      return sum;
    }));
    for (let i = 0; i < 50000; i++) yield* Queue.offer(q, i);
    return yield* Fiber.join(consumer);
  })),
);
await bench("Semaphore.withPermits (20k, uncontended)", 20000, () =>
  Effect.runPromise(Effect.gen(function* () {
    const sem = yield* Semaphore.make(1);
    for (let i = 0; i < 20000; i++) yield* sem.withPermits(1)(Effect.void);
  })),
);
await bench("Ref update (100k)", 100000, () =>
  Effect.runPromise(Effect.gen(function* () {
    const r = yield* Ref.make(0);
    for (let i = 0; i < 100000; i++) yield* Ref.update(r, (n) => n + 1);
  })),
);

// --- Atom / SubscriptionRef ---
await bench("Atom set + derived get (50k)", 50000, () => {
  const reg = AtomRegistry.make();
  const a = Atom.make(0);
  const b = Atom.make((get) => get(a) * 2);
  const un = reg.mount(b);
  for (let i = 0; i < 50000; i++) {
    reg.set(a, i);
    reg.get(b);
  }
  un();
});
await bench("SubscriptionRef.update + changes (10k)", 10000, () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const ref = yield* SubscriptionRef.make(0);
    const f = yield* Effect.forkChild(Stream.runDrain(Stream.take(SubscriptionRef.changes(ref), 10001)));
    yield* Effect.yieldNow;
    for (let i = 0; i < 10000; i++) yield* SubscriptionRef.update(ref, (n) => n + 1);
    yield* Fiber.join(f);
  }))),
);

// --- Platform ---
fsSync.writeFileSync(`${process.env.TMPDIR ?? "/tmp"}/runtime-bench.txt`, "hello world\n".repeat(100));
const readMany = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  for (let i = 0; i < 1000; i++) yield* fs.readFileString(`${process.env.TMPDIR ?? "/tmp"}/runtime-bench.txt`);
}).pipe(Effect.provide(NodeServices.layer));
await bench("FileSystem.readFileString (1k)", 1000, () => Effect.runPromise(readMany as never));
const spawnMany = Effect.gen(function* () {
  const sp = yield* ChildProcessSpawner.ChildProcessSpawner;
  for (let i = 0; i < 30; i++) yield* sp.string(ChildProcess.make("true", []));
}).pipe(Effect.provide(NodeServices.layer));
await bench("ChildProcess spawn+wait `true` (30)", 30, () => Effect.runPromise(spawnMany as never));
const server = http.createServer((_, res) => res.end('{"ok":true}'));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const httpMany = Effect.gen(function* () {
  const c = yield* HttpClient.HttpClient;
  for (let i = 0; i < 300; i++) {
    const r = yield* c.get(`http://127.0.0.1:${port}/`);
    yield* r.json;
  }
}).pipe(Effect.provide(FetchHttpClient.layer));
await bench("HttpClient GET + json (300)", 300, () => Effect.runPromise(httpMany as never));
server.close();

console.log(JSON.stringify({ label, results }));
