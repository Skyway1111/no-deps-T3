// Decode/encode real contracts schemas and format errors; run under both runtimes and diff the JSON:
//   node --experimental-strip-types --import ./alias.mjs differential.ts > ours.json
//   RUNTIME=effect node --experimental-strip-types --import ./alias.mjs differential.ts > effect.json
import * as Schema from "effect/Schema";
import { DEFAULT_SERVER_SETTINGS, ServerSettings } from "../../../../contracts/src/settings.ts";

const message = (s: Schema.Top, v: unknown) => {
  try {
    Schema.decodeUnknownSync(s)(v);
    return "OK";
  } catch (e) {
    return (e as Error).message;
  }
};
const cases: Record<string, [Schema.Top, unknown]> = {
  string: [Schema.String, 1],
  missing: [Schema.Struct({ a: Schema.String }), {}],
  nested: [Schema.Struct({ a: Schema.Struct({ b: Schema.Number }) }), { a: { b: "x" } }],
  literals: [Schema.Literals(["a", "b"]), "c"],
  filter: [Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)), -1],
  union: [Schema.Union([Schema.String, Schema.Number]), true],
  tagged: [Schema.Union([Schema.Struct({ t: Schema.Literal("a") }), Schema.Struct({ t: Schema.Literal("b") })]), { t: "c" }],
  array: [Schema.Array(Schema.Number), [1, "x"]],
  notArray: [Schema.Array(Schema.Number), 5],
  tuple: [Schema.Tuple([Schema.String, Schema.Number]), ["a"]],
  int: [Schema.Int, 1.5],
  json: [Schema.fromJsonString(Schema.Struct({ a: Schema.Number })), "{bad"],
  date: [Schema.DateTimeUtcFromString, "nope"],
  makeFilter: [Schema.Number.check(Schema.makeFilter((n: number) => n > 5 || "too small")), 1],
  settings: [ServerSettings, { automaticGitFetchInterval: "nope" }],
};
console.log(JSON.stringify({
  defaults: DEFAULT_SERVER_SETTINGS,
  encoded: Schema.encodeSync(ServerSettings)(DEFAULT_SERVER_SETTINGS),
  messages: Object.fromEntries(Object.entries(cases).map(([k, [s, v]]) => [k, message(s, v)])),
}));
