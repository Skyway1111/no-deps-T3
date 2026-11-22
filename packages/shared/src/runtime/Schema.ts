/**
 * Compiled codecs. Every schema is a node with `dec`/`enc`/`test`; decoding is a direct
 * recursive walk that returns synchronously unless a transform's Effect suspends, and
 * failures are thrown Issue objects (no Result allocation on the hot path).
 */
import * as I from "./internal.ts";
import { Async, chain, type Step } from "./internal.ts";
import * as O from "./Option.ts";
import * as R from "./Result.ts";
import * as Iss from "./SchemaIssue.ts";
import * as DT from "./DateTime.ts";
import * as Dur from "./Duration.ts";
import * as Red from "./Redacted.ts";
import { YieldableError } from "./errors.ts";
import type { Brand } from "./Brand.ts";

// ---------- type layer ----------
type Opt = "required" | "optional";
type Mut = "readonly" | "mutable";
type Simplify<A> = { [K in keyof A]: A[K] } & {};
export declare namespace Annotations {
  interface Annotations {
    readonly title?: string | undefined;
    readonly description?: string | undefined;
    readonly identifier?: string | undefined;
    readonly examples?: ReadonlyArray<unknown> | undefined;
    readonly default?: unknown;
    readonly message?: string | undefined;
    readonly expected?: string | undefined;
    readonly [k: string]: unknown;
  }
  interface Key<_T = unknown> extends Annotations {}
  interface Filter extends Annotations {}
  type Issue = Iss.IssueAnnotations;
}
export interface Annotations extends Annotations.Annotations {}
export interface Bottom<out T, out E, out RD, out RE, out TO extends Opt = "required", out EO extends Opt = TO, out M extends Mut = "readonly", out CD extends boolean = false> extends I.Pipeable {
  readonly Type: T;
  readonly Encoded: E;
  readonly DecodingServices: RD;
  readonly EncodingServices: RE;
  readonly "~type.optionality": TO;
  readonly "~encoded.optionality": EO;
  readonly "~type.mutability": M;
  readonly "~type.constructor.default": CD;
  readonly ast: Node;
  readonly "~node": Node;
  annotate(annotations: Annotations): this;
  annotateKey(annotations: Annotations): this;
  check(...checks: ReadonlyArray<Check<T>>): this;
  makeUnsafe(input: unknown, options?: MakeOptions): T;
  make(input: unknown, options?: MakeOptions): T;
  readonly Rebuild: this;
}
export type Top = Bottom<any, any, any, any, Opt, Opt, Mut, boolean>;
export interface Schema<out T> extends Bottom<T, unknown, unknown, unknown, Opt, Opt, Mut, boolean> {}
export interface Codec<out T, out E = T, out RD = never, out RE = never> extends Bottom<T, E, RD, RE> {}
export interface Decoder<out T, out RD = never> extends Bottom<T, unknown, RD, unknown, Opt, Opt, Mut, boolean> {}
export interface Encoder<out E, out RE = never> extends Bottom<unknown, E, unknown, RE, Opt, Opt, Mut, boolean> {}
export type Constraint = Top;
export type ConstraintCodec<T, E> = Bottom<T, E, unknown, unknown, Opt, Opt, Mut, boolean>;
export type ConstraintDecoder<T> = Bottom<T, unknown, unknown, unknown, Opt, Opt, Mut, boolean>;
export type Type<S> = S extends { readonly Type: infer T } ? T : never;
export type Encoded<S> = S extends { readonly Encoded: infer E } ? E : never;
export type DecodingServices<S> = S extends { readonly DecodingServices: infer R } ? R : never;
export type EncodingServices<S> = S extends { readonly EncodingServices: infer R } ? R : never;
export declare namespace Schema {
  type Type<S> = import("./Schema.ts").Type<S>;
  type Encoded<S> = import("./Schema.ts").Encoded<S>;
  type Any = Top;
  type All = Top;
}
export declare namespace Codec {
  type Type<S> = import("./Schema.ts").Type<S>;
  type Encoded<S> = import("./Schema.ts").Encoded<S>;
  type DecodingServices<S> = import("./Schema.ts").DecodingServices<S>;
  type EncodingServices<S> = import("./Schema.ts").EncodingServices<S>;
}
type Rebuild<S extends Top, TO extends Opt, EO extends Opt, M extends Mut, CD extends boolean> = Bottom<S["Type"], S["Encoded"], S["DecodingServices"], S["EncodingServices"], TO, EO, M, CD> & Omit<S, keyof Top>;
export type optionalKey<S extends Top> = Rebuild<S, "optional", "optional", S["~type.mutability"], S["~type.constructor.default"]>;
export type optional<S extends Top> = optionalKey<UndefinedOr<S>>;
export type mutableKey<S extends Top> = Rebuild<S, S["~type.optionality"], S["~encoded.optionality"], "mutable", S["~type.constructor.default"]>;
export type withDecodingDefault<S extends Top, RD = never> = Bottom<S["Type"], S["Encoded"] | undefined, S["DecodingServices"] | RD, S["EncodingServices"], "required", "optional", S["~type.mutability"], S["~type.constructor.default"]> & Omit<S, keyof Top>;
export type withDecodingDefaultKey<S extends Top, RD = never> = Bottom<S["Type"], S["Encoded"], S["DecodingServices"] | RD, S["EncodingServices"], "required", "optional", S["~type.mutability"], S["~type.constructor.default"]> & Omit<S, keyof Top>;
export type withConstructorDefault<S extends Top> = Rebuild<S, S["~type.optionality"], S["~encoded.optionality"], S["~type.mutability"], true>;
export type middlewareDecoding<S extends Top, _R = never> = S;

export type Fields = { readonly [k: PropertyKey]: Top };
type KeysWhere<F, P extends string, V> = { [K in keyof F]: F[K] extends { readonly [k in P]: V } ? K : never }[keyof F];
type OptT<F> = KeysWhere<F, "~type.optionality", "optional">;
type OptE<F> = KeysWhere<F, "~encoded.optionality", "optional">;
type MutK<F> = KeysWhere<F, "~type.mutability", "mutable">;
type CDK<F> = KeysWhere<F, "~type.constructor.default", true>;
export type StructType<F extends Fields> = Simplify<
  { readonly [K in Exclude<keyof F, OptT<F> | MutK<F>>]: F[K]["Type"] } &
  { readonly [K in Exclude<OptT<F>, MutK<F>>]?: F[K]["Type"] } &
  { -readonly [K in Exclude<MutK<F>, OptT<F>>]: F[K]["Type"] } &
  { -readonly [K in OptT<F> & MutK<F> & keyof F]?: F[K]["Type"] }
>;
export type StructEncoded<F extends Fields> = Simplify<
  { readonly [K in Exclude<keyof F, OptE<F> | MutK<F>>]: F[K]["Encoded"] } &
  { readonly [K in Exclude<OptE<F>, MutK<F>>]?: F[K]["Encoded"] } &
  { -readonly [K in Exclude<MutK<F>, OptE<F>>]: F[K]["Encoded"] } &
  { -readonly [K in OptE<F> & MutK<F> & keyof F]?: F[K]["Encoded"] }
>;
export type StructMakeIn<F extends Fields> = Simplify<
  { readonly [K in Exclude<keyof F, OptT<F> | CDK<F>>]: F[K]["Type"] } & { readonly [K in OptT<F> | CDK<F>]?: F[K]["Type"] }
>;
type FieldsRD<F extends Fields> = { [K in keyof F]: F[K]["DecodingServices"] }[keyof F];
type FieldsRE<F extends Fields> = { [K in keyof F]: F[K]["EncodingServices"] }[keyof F];
export interface Struct<F extends Fields> extends Bottom<StructType<F>, StructEncoded<F>, FieldsRD<F>, FieldsRE<F>> {
  readonly fields: F;
  mapFields<To extends Fields>(f: (fields: F) => To, options?: { readonly unsafePreserveChecks?: boolean }): Struct<To>;
  make(input: StructMakeIn<F>, options?: MakeOptions): StructType<F>;
  makeUnsafe(input: StructMakeIn<F>, options?: MakeOptions): StructType<F>;
}
export declare namespace Struct {
  type Fields = import("./Schema.ts").Fields;
  type Type<F extends Fields> = StructType<F>;
  type Encoded<F extends Fields> = StructEncoded<F>;
  type MakeIn<F extends Fields> = StructMakeIn<F>;
}
export interface MakeOptions {
  readonly disableValidation?: boolean;
  readonly disableChecks?: boolean;
}
type LiteralValue = string | number | boolean | bigint | null | undefined;
export interface Literal<L extends LiteralValue> extends Bottom<L, L, never, never> {
  readonly literal: L;
  transform<const L2 extends LiteralValue>(to: L2): decodeTo<Literal<L2>, Literal<L>>;
}
export interface Literals<Ls extends ReadonlyArray<LiteralValue>> extends Bottom<Ls[number], Ls[number], never, never> {
  readonly literals: Ls;
  readonly members: { readonly [K in keyof Ls]: Literal<Ls[K]> };
  pick<const P extends ReadonlyArray<Ls[number]>>(literals: P): Literals<P>;
}
export interface Union<Ms extends ReadonlyArray<Top>> extends Bottom<Ms[number]["Type"], Ms[number]["Encoded"], Ms[number]["DecodingServices"], Ms[number]["EncodingServices"]> {
  readonly members: Ms;
}
export interface NullOr<S extends Top> extends Union<readonly [S, Null]> {}
export interface UndefinedOr<S extends Top> extends Union<readonly [S, Undefined]> {}
export interface NullishOr<S extends Top> extends Union<readonly [S, Null, Undefined]> {}
export interface Array$<S extends Top> extends Bottom<ReadonlyArray<S["Type"]>, ReadonlyArray<S["Encoded"]>, S["DecodingServices"], S["EncodingServices"]> {
  readonly schema: S;
}
export interface NonEmptyArray<S extends Top> extends Bottom<readonly [S["Type"], ...Array<S["Type"]>], readonly [S["Encoded"], ...Array<S["Encoded"]>], S["DecodingServices"], S["EncodingServices"]> {
  readonly schema: S;
}
export interface mutable<S extends Top> extends Bottom<Mutable<S["Type"]>, Mutable<S["Encoded"]>, S["DecodingServices"], S["EncodingServices"], S["~type.optionality"], S["~encoded.optionality"], S["~type.mutability"]> {}
type Mutable<T> = T extends ReadonlyArray<infer A> ? Array<A> : { -readonly [K in keyof T]: T[K] };
export interface Record$<K extends Top, V extends Top> extends Bottom<{ readonly [P in K["Type"] & PropertyKey]: V["Type"] }, { readonly [P in K["Encoded"] & PropertyKey]: V["Encoded"] }, K["DecodingServices"] | V["DecodingServices"], K["EncodingServices"] | V["EncodingServices"]> {
  readonly key: K;
  readonly value: V;
}
export interface Tuple<Els extends ReadonlyArray<Top>> extends Bottom<{ readonly [K in keyof Els]: Els[K]["Type"] }, { readonly [K in keyof Els]: Els[K]["Encoded"] }, Els[number]["DecodingServices"], Els[number]["EncodingServices"]> {
  readonly elements: Els;
}
export interface Prim<T> extends Bottom<T, T, never, never> {}
export interface String extends Prim<string> {}
export interface Number extends Prim<number> {}
export interface Boolean extends Prim<boolean> {}
export interface BigInt extends Prim<bigint> {}
export interface Symbol extends Prim<symbol> {}
export interface Null extends Prim<null> {}
export interface Undefined extends Prim<undefined> {}
export interface Void extends Prim<void> {}
export interface Unknown extends Prim<unknown> {}
export interface Any extends Prim<any> {}
export interface Never extends Prim<never> {}
export interface Object$ extends Prim<object> {}
export type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [k: string]: Json };
export type MutableJson = null | boolean | number | string | Array<MutableJson> | { [k: string]: MutableJson };
export interface decodeTo<To extends Top, From extends Top, RD = never, RE = never> extends Bottom<To["Type"], From["Encoded"], To["DecodingServices"] | From["DecodingServices"] | RD, To["EncodingServices"] | From["EncodingServices"] | RE, To["~type.optionality"], From["~encoded.optionality"]> {
  readonly from: From;
  readonly to: To;
}
export interface brand<S extends Top, B extends string | symbol> extends Bottom<S["Type"] & Brand<B>, S["Encoded"], S["DecodingServices"], S["EncodingServices"], S["~type.optionality"], S["~encoded.optionality"], S["~type.mutability"], S["~type.constructor.default"]> {}
export interface suspend<S extends Top> extends Bottom<S["Type"], S["Encoded"], S["DecodingServices"], S["EncodingServices"]> {}
export interface toType<S extends Top> extends Bottom<S["Type"], S["Type"], never, never> {}
export interface toEncoded<S extends Top> extends Bottom<S["Encoded"], S["Encoded"], never, never> {}
export interface fromJsonString<S extends Top> extends Bottom<S["Type"], string, S["DecodingServices"], S["EncodingServices"]> {}
export interface toCodecJson<S extends Top> extends Bottom<S["Type"], Json, S["DecodingServices"], S["EncodingServices"]> {}
export interface Option$<S extends Top> extends Bottom<O.Option<S["Type"]>, O.Option<S["Encoded"]>, S["DecodingServices"], S["EncodingServices"]> {}
export interface declare<T> extends Bottom<T, T, never, never> {}
export interface instanceOf<T> extends Bottom<T, T, never, never> {}

// ---------- runtime ----------
/** Decoding context: options plus a lazily created fiber for effectful transforms. */
class Ctx {
  json = false;
  all = false;
  excess: "ignore" | "error" | "preserve" = "ignore";
  private f: I.Fiber | undefined;
  constructor(f?: I.Fiber) {
    this.f = f;
  }
  get fiber(): I.Fiber {
    return (this.f ??= new I.Fiber(I.emptyContext));
  }
  withJson(): Ctx {
    if (this.json) return this;
    const c = new Ctx(this.f);
    c.json = true;
    c.all = this.all;
    c.excess = this.excess;
    return c;
  }
}
const OMIT: unique symbol = globalThis.Symbol("omit") as never;
export interface Check<in T> {
  readonly _tag: "Filter";
  readonly run: (input: T) => Iss.Issue | undefined;
  readonly annotations: Annotations | undefined;
  readonly abort?: boolean;
  annotate(a: Annotations): Check<T>;
}
export type Filter<T> = Check<T>;
export type FilterGroup<T> = Check<T>;
type Getter = (value: any, ctx: Ctx) => Step<any>;

/** Run an Effect inside a decode; failures become Issues. */
function runEff(eff: I.Effect<any, any, any>, ctx: Ctx, input?: unknown): Step<any> {
  return I.settle(() => I.exec(eff, ctx.fiber), (a) => a, (e) => {
    const c = I.toCause(e);
    const fl = c.reasons.find((r) => r._tag === "Fail") as I.Fail<unknown> | undefined;
    if (fl && Iss.isIssue(fl.error)) throw fl.error;
    if (fl && fl.error instanceof SchemaError) throw fl.error.issue;
    throw new Iss.InvalidValue({ message: I.prettyCause(c) }, input);
  });
}
const pointer = (key: PropertyKey, e: unknown): never => {
  throw Iss.isIssue(e) ? new Iss.Pointer([key], e) : e;
};

export abstract class Node implements I.Pipeable {
  abstract readonly _tag: string;
  annotations: Annotations | undefined = undefined;
  keyAnnotations: Annotations | undefined = undefined;
  checks: ReadonlyArray<Check<any>> | undefined = undefined;
  typeOpt: Opt = "required";
  encOpt: Opt = "required";
  mutKey = false;
  decDefault: I.Effect<any, any, any> | undefined = undefined;
  decDefaultUndefined = false;
  ctorDefault: I.Effect<any, any, any> | (() => any) | undefined = undefined;
  catchDec: ((issue: Iss.Issue) => I.Effect<O.Option<any>, any, any>) | undefined = undefined;
  catchEnc: ((issue: Iss.Issue) => I.Effect<O.Option<any>, any, any>) | undefined = undefined;
  declare readonly Type: any;
  declare readonly Encoded: any;
  get "~node"(): Node {
    return this;
  }
  get ast(): Node {
    return this;
  }
  /** AST property-signature context (key annotations, optionality). */
  get context(): { readonly annotations: Annotations | undefined; readonly isOptional: boolean } | undefined {
    return this.keyAnnotations || this.encOpt === "optional" ? { annotations: this.keyAnnotations, isOptional: this.encOpt === "optional" } : undefined;
  }
  abstract decodeBase(u: unknown, ctx: Ctx): Step<any>;
  abstract encodeBase(a: any, ctx: Ctx): Step<any>;
  abstract testBase(u: unknown): boolean;
  describe(): string {
    return this._tag;
  }
  runChecks(a: unknown, ctx: Ctx | undefined): void {
    const cs = this.checks!;
    let issues: Array<Iss.Issue> | undefined;
    for (const c of cs) {
      const issue = c.run(a);
      if (!issue) continue;
      const f = new Iss.Filter(c, issue, a);
      if (!ctx?.all || c.abort) throw f;
      (issues ??= []).push(f);
    }
    if (issues) throw issues.length === 1 ? issues[0] : new Iss.Composite(this, issues as [Iss.Issue, ...Array<Iss.Issue>], a);
  }
  dec(u: unknown, ctx: Ctx): Step<any> {
    let r: Step<any>;
    if (this.catchDec) {
      try {
        r = this.decodeBase(u, ctx);
      } catch (e) {
        if (!Iss.isIssue(e)) throw e;
        return chain(runEff(this.catchDec(e), ctx, u), (o: O.Option<any>) => (o._tag === "Some" ? o.value : OMIT));
      }
    } else r = this.decodeBase(u, ctx);
    if (!this.checks) return r;
    if (r instanceof Async) return chain(r, (a) => (this.runChecks(a, ctx), a));
    this.runChecks(r, ctx);
    return r;
  }
  enc(a: unknown, ctx: Ctx): Step<any> {
    if (this.checks) this.runChecks(a, ctx);
    if (!this.catchEnc) return this.encodeBase(a, ctx);
    try {
      return this.encodeBase(a, ctx);
    } catch (e) {
      if (!Iss.isIssue(e)) throw e;
      return chain(runEff(this.catchEnc(e), ctx, a), (o: O.Option<any>) => (o._tag === "Some" ? o.value : OMIT));
    }
  }
  test(u: unknown): boolean {
    if (!this.testBase(u)) return false;
    if (this.checks) for (const c of this.checks) if (c.run(u)) return false;
    return true;
  }
  clone(patch: Partial<Node> & Record<string, unknown>): this {
    return Object.assign(Object.create(Object.getPrototypeOf(this)), this, patch);
  }
  annotate(a: Annotations): this {
    return this.clone({ annotations: { ...this.annotations, ...a } });
  }
  annotateKey(a: Annotations): this {
    return this.clone({ keyAnnotations: { ...this.keyAnnotations, ...a } });
  }
  check(...cs: ReadonlyArray<Check<any>>): this {
    return this.clone({ checks: [...(this.checks ?? []), ...cs] });
  }
  makeUnsafe(input: unknown, options?: MakeOptions): any {
    const v = this.applyCtorDefaults(input);
    if (options?.disableValidation) return v;
    if (!this.test(v)) {
      const r = decodeWith(this, v, new Ctx(), true);
      throw new SchemaError(r as Iss.Issue);
    }
    return v;
  }
  make(input: unknown, options?: MakeOptions): any {
    return this.makeUnsafe(input, options);
  }
  applyCtorDefaults(input: unknown): unknown {
    return input;
  }
  pipe() {
    return I.pipeArgs(this, arguments);
  }
  toString() {
    return this.describe();
  }
  toJSON() {
    return { _tag: this._tag, annotations: this.annotations };
  }
}
export const nodeOf = (s: unknown): Node => (s as { "~node": Node })["~node"];

// ---------- primitives ----------
class Primitive extends Node {
  readonly _tag: string;
  readonly guard: (u: unknown) => boolean;
  readonly name: string;
  readonly jsonEnc: ((a: any) => unknown) | undefined;
  readonly jsonDec: ((u: unknown) => unknown) | undefined;
  constructor(tag: string, name: string, guard: (u: unknown) => boolean, json?: { enc: (a: any) => unknown; dec: (u: unknown) => unknown }) {
    super();
    this._tag = tag;
    this.name = name;
    this.guard = guard;
    this.jsonEnc = json?.enc;
    this.jsonDec = json?.dec;
  }
  decodeBase(u: unknown, ctx: Ctx) {
    if (ctx.json && this.jsonDec) {
      const v = this.jsonDec(u);
      if (this.guard(v)) return v;
    }
    if (this.guard(u)) return u;
    throw new Iss.InvalidType(this, u);
  }
  encodeBase(a: unknown, ctx: Ctx) {
    if (!this.guard(a)) throw new Iss.InvalidType(this, a);
    return ctx.json && this.jsonEnc ? this.jsonEnc(a) : a;
  }
  testBase(u: unknown) {
    return this.guard(u);
  }
  override describe() {
    return this.name;
  }
}
const prim = <T>(tag: string, name: string, guard: (u: unknown) => boolean, json?: { enc: (a: any) => unknown; dec: (u: unknown) => unknown }): Prim<T> =>
  new Primitive(tag, name, guard, json) as never;
export const String: String = prim("String", "string", (u) => typeof u === "string");
export const Number: Number = prim("Number", "number", (u) => typeof u === "number", {
  enc: (n: number) => (globalThis.Number.isFinite(n) ? n : globalThis.String(n)),
  dec: (u) => (u === "NaN" ? NaN : u === "Infinity" ? Infinity : u === "-Infinity" ? -Infinity : u),
});
export const Boolean: Boolean = prim("Boolean", "boolean", (u) => typeof u === "boolean");
export const BigInt: BigInt = prim("BigInt", "bigint", (u) => typeof u === "bigint", {
  enc: (b: bigint) => b.toString(),
  dec: (u) => {
    try {
      return typeof u === "string" ? globalThis.BigInt(u) : u;
    } catch {
      return u;
    }
  },
});
export const Symbol: Symbol = prim("Symbol", "symbol", (u) => typeof u === "symbol");
export const Null: Null = prim("Null", "null", (u) => u === null);
export const Undefined: Undefined = prim("Undefined", "undefined", (u) => u === undefined, { enc: () => null, dec: (u) => (u === null ? undefined : u) });
export const Void: Void = prim("Void", "void", () => true, { enc: () => null, dec: () => undefined });
export const Unknown: Unknown = prim("Unknown", "unknown", () => true);
export const Any: Any = prim("Any", "any", () => true);
export const Never: Never = prim("Never", "never", () => false);
export const ObjectKeyword: Object$ = prim("ObjectKeyword", "object", (u) => (typeof u === "object" && u !== null) || typeof u === "function");
export { ObjectKeyword as Object };
export const Json: Prim<Json> = prim("Json", "Json", () => true);
export const MutableJson: Prim<MutableJson> = Json as never;

// ---------- literals ----------
class LiteralNode extends Node {
  readonly _tag = "Literal";
  readonly literal: LiteralValue;
  constructor(literal: LiteralValue) {
    super();
    this.literal = literal;
  }
  decodeBase(u: unknown, ctx: Ctx) {
    if (u === this.literal) return u;
    if (ctx.json && typeof this.literal === "bigint" && u === this.literal.toString()) return this.literal;
    throw new Iss.InvalidType(this, u);
  }
  encodeBase(a: unknown, ctx: Ctx) {
    if (a !== this.literal) throw new Iss.InvalidType(this, a);
    return ctx.json && typeof a === "bigint" ? a.toString() : a;
  }
  testBase(u: unknown) {
    return u === this.literal;
  }
  override describe() {
    return typeof this.literal === "bigint" ? `${this.literal}n` : JSON.stringify(this.literal) ?? "undefined";
  }
  /** Decode this literal as another literal (and encode back). */
  transform(to: LiteralValue) {
    const from = this.literal;
    return new TransformNode(this as never, new LiteralNode(to) as never, { decode: makeGetter(() => to), encode: makeGetter(() => from) });
  }
}
export const Literal = <const L extends LiteralValue>(literal: L): Literal<L> => new LiteralNode(literal) as never;
class LiteralsNode extends Node {
  readonly _tag = "Literals";
  readonly literals: ReadonlyArray<LiteralValue>;
  readonly set: Set<unknown>;
  constructor(literals: ReadonlyArray<LiteralValue>) {
    super();
    this.literals = literals;
    this.set = new Set(literals);
  }
  get members() {
    return this.literals.map((l) => Literal(l));
  }
  pick(ls: ReadonlyArray<LiteralValue>) {
    return new LiteralsNode(ls);
  }
  decodeBase(u: unknown) {
    if (this.set.has(u)) return u;
    throw new Iss.InvalidType(this, u);
  }
  encodeBase(a: unknown) {
    if (this.set.has(a)) return a;
    throw new Iss.InvalidType(this, a);
  }
  testBase(u: unknown) {
    return this.set.has(u);
  }
  override describe() {
    return this.literals.map((l) => JSON.stringify(l)).join(" | ");
  }
}
export const Literals = <const Ls extends ReadonlyArray<LiteralValue>>(literals: Ls): Literals<Ls> => new LiteralsNode(literals) as never;
export const Enum = <E extends Record<string, string | number>>(e: E): Bottom<E[keyof E], E[keyof E], never, never> =>
  new LiteralsNode(Object.values(e).filter((v) => typeof v !== "number" || !(globalThis.String(v) in e) || typeof e[globalThis.String(v)] !== "string")) as never;
export const Enums = Enum;
class TemplateLiteralNode extends Node {
  readonly _tag = "TemplateLiteral";
  readonly re: RegExp;
  readonly parts: ReadonlyArray<unknown>;
  constructor(parts: ReadonlyArray<unknown>) {
    super();
    this.parts = parts;
    const src = parts.map((p) => {
      if (typeof p === "string" || typeof p === "number" || typeof p === "boolean") return globalThis.String(p).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const n = nodeOf(p);
      if (n instanceof LiteralNode) return globalThis.String(n.literal).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (n instanceof LiteralsNode) return `(?:${n.literals.map((l) => globalThis.String(l).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
      if (n._tag === "Number") return "[+-]?\\d*\\.?\\d+(?:[Ee][+-]?\\d+)?";
      return "[\\s\\S]*?";
    }).join("");
    this.re = new RegExp(`^${src}$`);
  }
  decodeBase(u: unknown) {
    if (typeof u === "string" && this.re.test(u)) return u;
    throw new Iss.InvalidType(this, u);
  }
  encodeBase(a: unknown) {
    return this.decodeBase(a);
  }
  testBase(u: unknown) {
    return typeof u === "string" && this.re.test(u);
  }
  override describe() {
    return `\`${this.re.source}\``;
  }
}
export const TemplateLiteral = <const Parts extends ReadonlyArray<unknown>>(parts: Parts): Bottom<string, string, never, never> => new TemplateLiteralNode(parts) as never;

// ---------- declare ----------
class DeclareNode extends Node {
  readonly _tag = "Declaration";
  readonly guard: (u: unknown) => boolean;
  readonly decodeInner: ((u: any, ctx: Ctx) => Step<any>) | undefined;
  readonly encodeInner: ((a: any, ctx: Ctx) => Step<any>) | undefined;
  readonly jsonDec: ((u: unknown, ctx: Ctx) => Step<any>) | undefined;
  readonly jsonEnc: ((a: any, ctx: Ctx) => Step<any>) | undefined;
  constructor(guard: (u: unknown) => boolean, o?: {
    annotations?: Annotations | undefined; decode?: (u: any, ctx: Ctx) => Step<any>; encode?: (a: any, ctx: Ctx) => Step<any>;
    jsonDecode?: (u: unknown, ctx: Ctx) => Step<any>; jsonEncode?: (a: any, ctx: Ctx) => Step<any>;
  }) {
    super();
    this.guard = guard;
    this.annotations = o?.annotations;
    this.decodeInner = o?.decode;
    this.encodeInner = o?.encode;
    this.jsonDec = o?.jsonDecode;
    this.jsonEnc = o?.jsonEncode;
  }
  decodeBase(u: unknown, ctx: Ctx): Step<any> {
    if (ctx.json && this.jsonDec) return this.jsonDec(u, ctx);
    if (!this.guard(u)) throw new Iss.InvalidType(this, u);
    return this.decodeInner ? this.decodeInner(u, ctx) : u;
  }
  encodeBase(a: unknown, ctx: Ctx): Step<any> {
    if (!this.guard(a)) throw new Iss.InvalidType(this, a);
    if (ctx.json && this.jsonEnc) return this.jsonEnc(a, ctx);
    return this.encodeInner ? this.encodeInner(a, ctx) : a;
  }
  testBase(u: unknown) {
    return this.guard(u);
  }
  override describe() {
    return (this.annotations?.identifier as string | undefined) ?? (this.annotations?.title as string | undefined) ?? "<declaration>";
  }
}
export const declare = <T>(is: (u: unknown) => u is T, annotations?: Annotations): declare<T> => new DeclareNode(is, { annotations }) as never;
export const instanceOf = <C extends abstract new (...args: any) => any>(ctor: C, annotations?: Annotations): instanceOf<InstanceType<C>> =>
  new DeclareNode((u) => u instanceof ctor, { annotations: { identifier: ctor.name, ...annotations } }) as never;

// ---------- struct ----------
const objectAst = { _tag: "ObjectKeyword", describe: () => "object" };
/** withDecodingDefault's encoded side is `T | undefined`; describe it that way like effect does. */
const undefinedOrIssue = (e: Iss.InvalidType) =>
  new Iss.InvalidType({ _tag: "Union", annotations: undefined, describe: () => `${e.ast.describe?.() ?? e.ast._tag} | undefined` }, e.input);
const arrayAst = { _tag: "Arrays", describe: () => "array" };
interface Prop {
  readonly key: PropertyKey;
  readonly encKey: PropertyKey;
  readonly node: Node;
  readonly encOpt: boolean;
  readonly typeOpt: boolean;
}
class StructNode extends Node {
  readonly _tag = "Objects";
  readonly fields: Fields;
  readonly encodeKeyMap: Readonly<Record<PropertyKey, PropertyKey>> | undefined;
  readonly rest: ReadonlyArray<RecordNode>;
  private _props: ReadonlyArray<Prop> | undefined;
  constructor(fields: Fields, rest: ReadonlyArray<RecordNode> = [], encodeKeyMap?: Record<PropertyKey, PropertyKey>) {
    super();
    this.fields = fields;
    this.rest = rest;
    this.encodeKeyMap = encodeKeyMap;
  }
  get props(): ReadonlyArray<Prop> {
    return (this._props ??= Reflect.ownKeys(this.fields).map((key) => {
      const node = nodeOf(this.fields[key as string]);
      return { key, encKey: this.encodeKeyMap?.[key as string] ?? key, node, encOpt: node.encOpt === "optional", typeOpt: node.typeOpt === "optional" };
    }));
  }
  mapFields(f: (fields: Fields) => Fields, options?: { readonly unsafePreserveChecks?: boolean }) {
    const n = new StructNode(f(this.fields));
    if (options?.unsafePreserveChecks) n.checks = this.checks;
    return n;
  }
  /** AST view: property signatures as in SchemaAST.Objects. */
  get propertySignatures(): ReadonlyArray<{ readonly name: PropertyKey; readonly type: Node }> {
    return this.props.map((p) => ({ name: p.key, type: p.node }));
  }
  get indexSignatures(): ReadonlyArray<{ readonly parameter: Node; readonly type: Node }> {
    return this.rest.map((r) => ({ parameter: r.keyNode, type: r.valueNode }));
  }
  decodeBase(u: unknown, ctx: Ctx): Step<any> {
    if (typeof u !== "object" || u === null || globalThis.Array.isArray(u)) throw new Iss.InvalidType(objectAst, u);
    const input = u as Record<PropertyKey, unknown>;
    const out: Record<PropertyKey, unknown> = {};
    const props = this.props;
    let issues: Array<Iss.Issue> | undefined;
    for (let i = 0; i < props.length; i++) {
      const p = props[i]!;
      const v = input[p.encKey];
      let r: Step<any>;
      try {
        if (v === undefined && (p.node.decDefaultUndefined || !(p.encKey in input))) {
          if (p.node.decDefault) r = chain(runEff(p.node.decDefault, ctx), (d) => p.node.dec(d, ctx));
          else if (p.node instanceof TransformNode && p.node.decodesMissing && !(p.encKey in input)) r = p.node.decodeMissing(ctx);
          else if (p.encOpt) continue;
          else throw new Iss.MissingKey(p.node.keyAnnotations);
        } else r = p.node.dec(v, ctx);
      } catch (e0) {
        const e = p.node.decDefaultUndefined && e0 instanceof Iss.InvalidType ? undefinedOrIssue(e0) : e0;
        if (!ctx.all || !Iss.isIssue(e)) pointer(p.key, e);
        (issues ??= []).push(new Iss.Pointer([p.key], e as Iss.Issue));
        continue;
      }
      if (r instanceof Async) return this.finishAsync(r, i, input, out, ctx);
      if (r !== OMIT) out[p.key] = r;
    }
    if (this.rest.length) this.decodeRest(input, out, ctx);
    else if (ctx.excess === "error") this.checkExcess(input);
    else if (ctx.excess === "preserve") for (const k of Reflect.ownKeys(input)) if (!(k in out) && !this.isKnownEnc(k)) out[k] = input[k];
    if (issues) throw issues.length === 1 ? issues[0] : new Iss.Composite(this, issues as [Iss.Issue, ...Array<Iss.Issue>], u);
    return out;
  }
  private isKnownEnc(k: PropertyKey) {
    return this.props.some((p) => p.encKey === k);
  }
  private checkExcess(input: Record<PropertyKey, unknown>) {
    for (const k of Reflect.ownKeys(input)) if (!this.isKnownEnc(k)) throw new Iss.Pointer([k], new Iss.UnexpectedKey(this, input[k]));
  }
  private decodeRest(input: Record<PropertyKey, unknown>, out: Record<PropertyKey, unknown>, ctx: Ctx) {
    for (const k of Reflect.ownKeys(input)) {
      if (this.isKnownEnc(k)) continue;
      for (const rec of this.rest) {
        if (!rec.keyNode.test(k)) continue;
        try {
          const r = rec.valueNode.dec(input[k], ctx);
          if (r instanceof Async) throw new Iss.InvalidValue({ message: "async rest decoding is not supported" });
          out[k] = r;
        } catch (e) {
          pointer(k, e);
        }
        break;
      }
    }
  }
  private finishAsync(first: Async<any>, index: number, input: Record<PropertyKey, unknown>, out: Record<PropertyKey, unknown>, ctx: Ctx): Step<any> {
    const props = this.props;
    let i = index;
    const step = (v: unknown): Step<any> => {
      if (v !== OMIT) out[props[i]!.key] = v;
      while (++i < props.length) {
        const p = props[i]!;
        const raw = input[p.encKey];
        let r: Step<any>;
        try {
          if (raw === undefined && (p.node.decDefaultUndefined || !(p.encKey in input))) {
            if (p.node.decDefault) r = chain(runEff(p.node.decDefault, ctx), (d) => p.node.dec(d, ctx));
            else if (p.encOpt) continue;
            else throw new Iss.MissingKey(p.node.keyAnnotations);
          } else r = p.node.dec(raw, ctx);
        } catch (e) {
          return pointer(p.key, e);
        }
        if (r instanceof Async) {
          const key = p.key;
          return new Async(r.p.then((x) => I.toThen(step(I.unbox(x))), (e) => pointer(key, e)));
        }
        if (r !== OMIT) out[p.key] = r;
      }
      if (this.rest.length) this.decodeRest(input, out, ctx);
      return out;
    };
    const key = props[index]!.key;
    return new Async(first.p.then((x) => I.toThen(step(I.unbox(x))), (e) => pointer(key, e)));
  }
  encodeBase(a: unknown, ctx: Ctx): Step<any> {
    if (typeof a !== "object" || a === null) throw new Iss.InvalidType(this, a);
    const input = a as Record<PropertyKey, unknown>;
    const out: Record<PropertyKey, unknown> = {};
    for (const p of this.props) {
      const v = input[p.key];
      if (v === undefined && !(p.key in input)) {
        if (p.typeOpt) continue;
        if (p.node.decDefault && p.encOpt) continue;
        throw new Iss.Pointer([p.key], new Iss.MissingKey(p.node.keyAnnotations));
      }
      let r: Step<any>;
      try {
        r = p.node.enc(v, ctx);
      } catch (e) {
        return pointer(p.key, e);
      }
      if (r instanceof Async) throw new Iss.InvalidValue({ message: "async encoding is not supported" });
      if (r !== OMIT) out[p.encKey] = r;
    }
    for (const rec of this.rest) for (const k of Reflect.ownKeys(input)) if (!(k in this.fields) && rec.keyNode.test(k)) out[k] = rec.valueNode.enc(input[k], ctx);
    return out;
  }
  testBase(u: unknown) {
    if (typeof u !== "object" || u === null) return false;
    const input = u as Record<PropertyKey, unknown>;
    for (const p of this.props) {
      const v = input[p.key];
      if (v === undefined && !(p.key in input)) {
        if (p.typeOpt) continue;
        return false;
      }
      if (!p.node.test(v)) return false;
    }
    return true;
  }
  override applyCtorDefaults(input: unknown): unknown {
    if (typeof input !== "object" || input === null) return input;
    let out: Record<PropertyKey, unknown> | undefined;
    for (const p of this.props) {
      const d = p.node.ctorDefault;
      if (!d || (input as Record<PropertyKey, unknown>)[p.key] !== undefined) continue;
      out ??= { ...(input as object) };
      if (typeof d === "function") out[p.key] = d();
      else {
        const exit = I.runFiber(d, I.emptyContext).exit;
        if (exit?._tag !== "Success") throw new globalThis.Error(`constructor default for ${globalThis.String(p.key)} must be synchronous and succeed`);
        out[p.key] = exit.value;
      }
    }
    return out ?? input;
  }
  override describe() {
    const p = this.props[0];
    return p ? `{ readonly ${JSON.stringify(globalThis.String(p.key))}${p.typeOpt ? "?" : ""}: ${p.node.describe()}, ... }` : "{}";
  }
}
export const Struct = <const F extends Fields>(fields: F): Struct<F> => new StructNode(fields) as never;
export const TaggedStruct = <const Tag extends string, const F extends Fields>(tag: Tag, fields: F): Struct<Simplify<{ readonly _tag: withConstructorDefault<Literal<Tag>> } & F>> =>
  new StructNode({ _tag: withConstructorDefault(() => tag)(Literal(tag)), ...fields }) as never;
export const StructWithRest = <S extends Struct<any>, const Rs extends ReadonlyArray<Record$<any, any>>>(
  struct: S,
  records: Rs,
): Bottom<S["Type"] & Rs[number]["Type"], S["Encoded"] & Rs[number]["Encoded"], S["DecodingServices"], S["EncodingServices"]> & { readonly fields: S["fields"] } => {
  const s = nodeOf(struct) as StructNode;
  return new StructNode(s.fields, records.map((r) => nodeOf(r) as RecordNode), s.encodeKeyMap).clone({ checks: s.checks, annotations: s.annotations }) as never;
};
export const fieldsAssign = <const F2 extends Fields>(fields: F2) => <F extends Fields>(self: Struct<F>): Struct<Simplify<Omit<F, keyof F2> & F2>> =>
  new StructNode({ ...(nodeOf(self) as StructNode).fields, ...fields }) as never;
export const encodeKeys = <S extends Struct<any>, const M extends { readonly [K in keyof S["fields"]]?: PropertyKey }>(mapping: M) => (self: S): S =>
  (nodeOf(self) as StructNode).clone({ encodeKeyMap: mapping as Record<PropertyKey, PropertyKey>, _props: undefined }) as never;

// ---------- property modifiers ----------
export const optionalKey = <S extends Top>(self: S): optionalKey<S> => nodeOf(self).clone({ typeOpt: "optional", encOpt: "optional" }) as never;
export const optional = <S extends Top>(self: S): optional<S> => optionalKey(UndefinedOr(self)) as never;
export const mutableKey = <S extends Top>(self: S): mutableKey<S> => nodeOf(self).clone({ mutKey: true }) as never;
export const mutable = <S extends Top>(self: S): mutable<S> => self as never;
export const withDecodingDefault = <S extends Top, RD = never>(defaultValue: I.Effect<S["Encoded"], any, RD> | (() => S["Encoded"])) => (self: S): withDecodingDefault<S, RD> =>
  nodeOf(self).clone({ encOpt: "optional", decDefault: I.isEffect(defaultValue) ? defaultValue : I.make(defaultValue as () => unknown), decDefaultUndefined: true }) as never;
export const withDecodingDefaultKey = <S extends Top, RD = never>(defaultValue: I.Effect<S["Encoded"], any, RD> | (() => S["Encoded"])) => (self: S): withDecodingDefaultKey<S, RD> =>
  nodeOf(self).clone({ encOpt: "optional", decDefault: I.isEffect(defaultValue) ? defaultValue : I.make(defaultValue as () => unknown), decDefaultUndefined: false }) as never;
export const withConstructorDefault = <S extends Top>(defaultValue: I.Effect<S["Type"], any, any> | (() => S["Type"])) => (self: S): withConstructorDefault<S> =>
  nodeOf(self).clone({ ctorDefault: defaultValue }) as never;
export const annotateKey = <S extends Top>(annotations: Annotations) => (self: S): S => nodeOf(self).annotateKey(annotations) as never;
export const annotate = <S extends Top>(annotations: Annotations) => (self: S): S => nodeOf(self).annotate(annotations) as never;
export const catchDecoding = <S extends Top>(f: (issue: Iss.Issue) => I.Effect<O.Option<S["Type"]>, any, any>) => (self: S): middlewareDecoding<S> =>
  nodeOf(self).clone({ catchDec: f }) as never;
export const catchEncoding = <S extends Top>(f: (issue: Iss.Issue) => I.Effect<O.Option<S["Encoded"]>, any, any>) => (self: S): S =>
  nodeOf(self).clone({ catchEnc: f }) as never;
export const resolveAnnotations = (s: Top): Annotations | undefined => nodeOf(s).annotations;
export const resolveAnnotationsKey = (s: Top): Annotations | undefined => nodeOf(s).keyAnnotations;
export const resolveTitle = (s: Top): string | undefined => nodeOf(s).annotations?.title;
export const resolveDescription = (s: Top): string | undefined => nodeOf(s).annotations?.description;
export const resolveIdentifier = (s: Top): string | undefined => nodeOf(s).annotations?.identifier;

// ---------- collections ----------
class ArrayNode extends Node {
  readonly _tag = "Arrays";
  readonly item: Node;
  readonly schema: Top;
  readonly nonEmpty: boolean;
  constructor(schema: Top, nonEmpty: boolean) {
    super();
    this.schema = schema;
    this.item = nodeOf(schema);
    this.nonEmpty = nonEmpty;
  }
  decodeBase(u: unknown, ctx: Ctx): Step<any> {
    if (!globalThis.Array.isArray(u)) throw new Iss.InvalidType(arrayAst, u);
    if (this.nonEmpty && u.length === 0) throw new Iss.InvalidType(this, u);
    return mapItems(u, ctx, (x, c) => this.item.dec(x, c));
  }
  encodeBase(a: unknown, ctx: Ctx): Step<any> {
    if (!globalThis.Array.isArray(a)) throw new Iss.InvalidType(this, a);
    return mapItems(a, ctx, (x, c) => this.item.enc(x, c));
  }
  testBase(u: unknown) {
    if (!globalThis.Array.isArray(u) || (this.nonEmpty && u.length === 0)) return false;
    for (const x of u) if (!this.item.test(x)) return false;
    return true;
  }
  override describe() {
    return `ReadonlyArray<${this.item.describe()}>`;
  }
}
function mapItems(arr: ReadonlyArray<unknown>, ctx: Ctx, f: (x: unknown, ctx: Ctx) => Step<any>): Step<Array<unknown>> {
  const out = new globalThis.Array(arr.length);
  let issues: Array<Iss.Issue> | undefined;
  for (let i = 0; i < arr.length; i++) {
    let r: Step<any>;
    try {
      r = f(arr[i], ctx);
    } catch (e) {
      if (!ctx.all || !Iss.isIssue(e)) pointer(i, e);
      (issues ??= []).push(new Iss.Pointer([i], e as Iss.Issue));
      continue;
    }
    if (r instanceof Async) {
      let j = i;
      const rest = (v: unknown): Step<Array<unknown>> => {
        out[j] = v;
        while (++j < arr.length) {
          let r2: Step<any>;
          try {
            r2 = f(arr[j], ctx);
          } catch (e) {
            return pointer(j, e);
          }
          if (r2 instanceof Async) {
            const k = j;
            return new Async(r2.p.then((x) => I.toThen(rest(I.unbox(x))), (e) => pointer(k, e))) as Async<Array<unknown>>;
          }
          out[j] = r2;
        }
        return out;
      };
      return new Async(r.p.then((x) => I.toThen(rest(I.unbox(x))), (e) => pointer(i, e))) as Async<Array<unknown>>;
    }
    out[i] = r;
  }
  if (issues) throw issues.length === 1 ? issues[0] : new Iss.Composite({ _tag: "Arrays" }, issues as [Iss.Issue, ...Array<Iss.Issue>], arr);
  return out;
}
export const Array = <S extends Top>(item: S): Array$<S> => new ArrayNode(item, false) as never;
export const NonEmptyArray = <S extends Top>(item: S): NonEmptyArray<S> => new ArrayNode(item, true) as never;
export { Array as ReadonlyArray };
class TupleNode extends Node {
  readonly _tag = "Tuple";
  readonly elements: ReadonlyArray<Top>;
  readonly nodes: ReadonlyArray<Node>;
  readonly restNode: Node | undefined;
  constructor(elements: ReadonlyArray<Top>, rest?: Top) {
    super();
    this.elements = elements;
    this.nodes = elements.map(nodeOf);
    this.restNode = rest ? nodeOf(rest) : undefined;
  }
  decodeBase(u: unknown, ctx: Ctx) {
    if (!globalThis.Array.isArray(u)) throw new Iss.InvalidType(arrayAst, u);
    this.check2(u);
    return this.walkIdx(u, ctx, false);
  }
  private check2(u: ReadonlyArray<unknown>) {
    for (let i = u.length; i < this.nodes.length; i++) if (this.nodes[i]!.typeOpt !== "optional") throw new Iss.Pointer([i], new Iss.MissingKey());
    if (!this.restNode && u.length > this.nodes.length) throw new Iss.Pointer([this.nodes.length], new Iss.UnexpectedKey(this, u[this.nodes.length]));
    return true;
  }
  private walkIdx(u: ReadonlyArray<unknown>, ctx: Ctx, enc: boolean): Step<any> {
    const out: Array<unknown> = [];
    for (let i = 0; i < u.length; i++) {
      const n = this.nodes[i] ?? this.restNode!;
      try {
        const r = enc ? n.enc(u[i], ctx) : n.dec(u[i], ctx);
        if (r instanceof Async) throw new Iss.InvalidValue({ message: "async tuple elements are not supported" });
        out.push(r);
      } catch (e) {
        pointer(i, e);
      }
    }
    return out;
  }
  encodeBase(a: unknown, ctx: Ctx) {
    if (!globalThis.Array.isArray(a)) throw new Iss.InvalidType(this, a);
    this.check2(a);
    return this.walkIdx(a, ctx, true);
  }
  testBase(u: unknown) {
    if (!globalThis.Array.isArray(u)) return false;
    const required = this.nodes.filter((n) => n.typeOpt !== "optional").length;
    if (u.length < required || (!this.restNode && u.length > this.nodes.length)) return false;
    return u.every((x, i) => (this.nodes[i] ?? this.restNode!).test(x));
  }
  override describe() {
    return `readonly [${this.nodes.map((n) => n.describe()).join(", ")}${this.restNode ? `, ...${this.restNode.describe()}[]` : ""}]`;
  }
}
export const Tuple = <const Els extends ReadonlyArray<Top>>(elements: Els): Tuple<Els> => new TupleNode(elements) as never;
export const TupleWithRest = <T extends Tuple<any>, const Rest extends ReadonlyArray<Top>>(tuple: T, rest: Rest): Bottom<[...T["Type"], ...Array<Rest[number]["Type"]>], [...T["Encoded"], ...Array<Rest[number]["Encoded"]>], never, never> =>
  new TupleNode((nodeOf(tuple) as TupleNode).elements, rest[0]) as never;
class RecordNode extends Node {
  readonly _tag = "Objects";
  readonly propertySignatures: ReadonlyArray<never> = [];
  get indexSignatures(): ReadonlyArray<{ readonly parameter: Node; readonly type: Node }> {
    return [{ parameter: this.keyNode, type: this.valueNode }];
  }
  readonly key: Top;
  readonly value: Top;
  readonly keyNode: Node;
  readonly valueNode: Node;
  constructor(key: Top, value: Top) {
    super();
    this.key = key;
    this.value = value;
    this.keyNode = nodeOf(key);
    this.valueNode = nodeOf(value);
  }
  private requiredKeys(): ReadonlyArray<LiteralValue> | undefined {
    const k = this.keyNode;
    return k instanceof LiteralsNode ? k.literals : k instanceof LiteralNode ? [k.literal] : undefined;
  }
  private walk(u: unknown, ctx: Ctx, enc: boolean): Step<any> {
    if (typeof u !== "object" || u === null || globalThis.Array.isArray(u)) throw new Iss.InvalidType(this, u);
    const input = u as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const req = this.requiredKeys();
    if (req) for (const k of req) if (!(globalThis.String(k) in input) && this.valueNode.typeOpt !== "optional") throw new Iss.Pointer([globalThis.String(k)], new Iss.MissingKey());
    for (const k of Object.keys(input)) {
      let nk: unknown = k;
      try {
        if (!this.keyNode.test(k)) {
          if (enc) throw new Iss.InvalidType(this.keyNode, k);
          nk = this.keyNode.dec(k, ctx);
        }
      } catch (e) {
        if (req || this.keyNode._tag !== "String") continue;
        pointer(k, e);
      }
      try {
        const r = enc ? this.valueNode.enc(input[k], ctx) : this.valueNode.dec(input[k], ctx);
        if (r instanceof Async) throw new Iss.InvalidValue({ message: "async record values are not supported" });
        if (r !== OMIT) out[nk as string] = r;
      } catch (e) {
        pointer(k, e);
      }
    }
    return out;
  }
  decodeBase(u: unknown, ctx: Ctx) {
    return this.walk(u, ctx, false);
  }
  encodeBase(a: unknown, ctx: Ctx) {
    return this.walk(a, ctx, true);
  }
  testBase(u: unknown) {
    if (typeof u !== "object" || u === null || globalThis.Array.isArray(u)) return false;
    for (const k of Object.keys(u)) if (this.keyNode.test(k) && !this.valueNode.test((u as Record<string, unknown>)[k])) return false;
    return true;
  }
  override describe() {
    return `{ readonly [x: ${this.keyNode.describe()}]: ${this.valueNode.describe()} }`;
  }
}
export const Record = <K extends Top, V extends Top>(key: K, value: V): Record$<K, V> => new RecordNode(key, value) as never;

// ---------- unions ----------
class UnionNode extends Node {
  readonly _tag = "Union";
  readonly members: ReadonlyArray<Top>;
  readonly nodes: ReadonlyArray<Node>;
  private index: { key: PropertyKey; map: Map<unknown, ReadonlyArray<Node>> } | null | undefined;
  constructor(members: ReadonlyArray<Top>) {
    super();
    this.members = members;
    this.nodes = members.map(nodeOf);
  }
  /** Find a key whose literal value picks the candidate members (O(1) dispatch). */
  private getIndex() {
    if (this.index !== undefined) return this.index;
    const structs = this.nodes.map((n) => (n instanceof StructNode ? n : n instanceof ClassNode ? n.struct : undefined));
    if (structs.some((s) => !s) || structs.length < 2) return (this.index = null);
    for (const key of Reflect.ownKeys((structs[0] as StructNode).fields)) {
      const map = new Map<unknown, Array<Node>>();
      let ok = true;
      structs.forEach((s, i) => {
        const p = s!.props.find((x) => x.key === key);
        const n = p?.node;
        const lits = n instanceof LiteralNode ? [n.literal] : n instanceof LiteralsNode ? n.literals : undefined;
        if (!lits || !p || p.encKey !== key) return void (ok = false);
        for (const l of lits) {
          const arr = map.get(l) ?? [];
          arr.push(this.nodes[i]!);
          map.set(l, arr);
        }
      });
      if (ok) return (this.index = { key, map });
    }
    return (this.index = null);
  }
  private candidates(u: unknown): ReadonlyArray<Node> {
    const idx = this.getIndex();
    if (idx && typeof u === "object" && u !== null) return idx.map.get((u as Record<PropertyKey, unknown>)[idx.key]) ?? [];
    return this.nodes;
  }
  decodeBase(u: unknown, ctx: Ctx): Step<any> {
    const cands = this.candidates(u);
    let issues: Array<Iss.Issue> | undefined;
    for (const n of cands) {
      try {
        return n.dec(u, ctx);
      } catch (e) {
        if (!Iss.isIssue(e)) throw e;
        (issues ??= []).push(e);
      }
    }
    throw new Iss.AnyOf(this, cands.length === 1 && issues ? issues : [], u);
  }
  encodeBase(a: unknown, ctx: Ctx): Step<any> {
    const cands = this.nodes;
    for (const n of cands) if (n.test(a)) return n.enc(a, ctx);
    let issues: Array<Iss.Issue> | undefined;
    for (const n of cands) {
      try {
        return n.enc(a, ctx);
      } catch (e) {
        if (!Iss.isIssue(e)) throw e;
        (issues ??= []).push(e);
      }
    }
    throw new Iss.AnyOf(this, [], a);
  }
  testBase(u: unknown) {
    for (const n of this.candidates(u)) if (n.test(u)) return true;
    return false;
  }
  override describe() {
    return this.nodes.map((n) => n.describe()).join(" | ");
  }
}
export const Union = <const Ms extends ReadonlyArray<Top>>(members: Ms, _options?: { readonly mode?: "anyOf" | "oneOf" }): Union<Ms> => new UnionNode(members) as never;
export const NullOr = <S extends Top>(self: S): NullOr<S> => new UnionNode([self, Null]) as never;
export const UndefinedOr = <S extends Top>(self: S): UndefinedOr<S> => new UnionNode([self, Undefined]) as never;
export const NullishOr = <S extends Top>(self: S): NullishOr<S> => new UnionNode([self, Null, Undefined]) as never;

// ---------- suspend / transforms ----------
class SuspendNode extends Node {
  readonly _tag = "Suspend";
  readonly thunk: () => Top;
  private n: Node | undefined;
  constructor(thunk: () => Top) {
    super();
    this.thunk = thunk;
  }
  get inner(): Node {
    return (this.n ??= nodeOf(this.thunk()));
  }
  decodeBase(u: unknown, ctx: Ctx) {
    return this.inner.dec(u, ctx);
  }
  encodeBase(a: unknown, ctx: Ctx) {
    return this.inner.enc(a, ctx);
  }
  testBase(u: unknown) {
    return this.inner.test(u);
  }
  override describe() {
    return "<suspended>";
  }
}
export const suspend = <S extends Top>(f: () => S): suspend<S> => new SuspendNode(f) as never;

export interface Transformation<T = any, E = any, RD = never, RE = never> {
  readonly decode: Getter | SchemaGetterLike<T, E, RD>;
  readonly encode: Getter | SchemaGetterLike<E, T, RE>;
}
/** A getter maps one present value; Effects are run through the kernel. */
export interface SchemaGetterLike<T, E, R = never> {
  "~getter"(value: E, ctx: Ctx): Step<T>;
  /** Present only for getters that also run when the key is missing (transformOptional). */
  "~missing"?(ctx: Ctx): Step<O.Option<T>>;
  readonly _R?: R;
}
const runGetter = (g: Getter | SchemaGetterLike<any, any, any>, v: unknown, ctx: Ctx): Step<any> => {
  const fn = typeof g === "function" ? g : g["~getter"];
  return fn(v, ctx);
};
export const makeGetter = <T, E, R = never>(f: (value: E, ctx: Ctx) => Step<T>, missing?: (ctx: Ctx) => Step<O.Option<T>>): SchemaGetterLike<T, E, R> =>
  missing ? { "~getter": f, "~missing": missing } : { "~getter": f };
/** Returned by a getter to drop the key from the output struct. */
export const OMIT_KEY = OMIT;
export const getterFromFn = <T, E>(f: (e: E) => T): SchemaGetterLike<T, E> => makeGetter((v: E) => f(v));
export const getterFromEffect = <T, E, R>(f: (e: E) => I.Effect<T, any, R>): SchemaGetterLike<T, E, R> => makeGetter((v: E, ctx) => runEff(f(v), ctx, v));
export const runEffectInDecode = runEff;
class TransformNode extends Node {
  readonly _tag = "Transformation";
  readonly from: Top;
  readonly to: Top;
  readonly fromN: Node;
  readonly toN: Node;
  readonly t: Transformation | undefined;
  constructor(from: Top, to: Top, t?: Transformation) {
    super();
    this.from = from;
    this.to = to;
    this.fromN = nodeOf(from);
    this.toN = nodeOf(to);
    this.t = t;
    this.typeOpt = this.toN.typeOpt;
    this.encOpt = this.fromN.encOpt;
  }
  decodeBase(u: unknown, ctx: Ctx): Step<any> {
    return chain(this.fromN.dec(u, ctx), (a) => {
      const mid = this.t ? runGetter(this.t.decode, a, ctx) : a;
      return chain(mid, (m) => (this.t ? decodeTo$toTypeSide(this.toN, m, ctx) : this.toN.dec(m, ctx)));
    });
  }
  encodeBase(a: unknown, ctx: Ctx): Step<any> {
    return chain(this.t ? encodeTo$fromTypeSide(this.toN, a, ctx) : this.toN.enc(a, ctx), (m) => {
      const mid = this.t ? runGetter(this.t.encode, m, ctx) : m;
      return chain(mid, (x) => this.fromN.enc(x, ctx));
    });
  }
  testBase(u: unknown) {
    return this.toN.test(u);
  }
  override describe() {
    return this.toN.describe();
  }
  get decodesMissing(): boolean {
    return typeof this.t?.decode === "object" && "~missing" in this.t.decode;
  }
  decodeMissing(ctx: Ctx): Step<any> {
    const g = this.t!.decode as SchemaGetterLike<any, any, any>;
    return chain(g["~missing"]!(ctx), (o: O.Option<unknown>) => (o._tag === "Some" ? this.toN.dec(o.value, ctx) : OMIT));
  }
}
/** With an explicit transformation, the target's Encoded side receives the getter output. */
const decodeTo$toTypeSide = (to: Node, m: unknown, ctx: Ctx) => to.dec(m, ctx);
const encodeTo$fromTypeSide = (to: Node, a: unknown, ctx: Ctx) => to.enc(a, ctx);
export const decodeTo: {
  <To extends Top>(to: To): <From extends Top>(from: From) => decodeTo<To, From>;
  <To extends Top, From extends Top, RD = never, RE = never>(to: To, transformation: Transformation<Encoded<To>, Type<From>, RD, RE>): (from: From) => decodeTo<To, From, RD, RE>;
} = ((to: Top, t?: Transformation) => (from: Top) => new TransformNode(from, to, t)) as never;
export const encodeTo = <From extends Top, To extends Top>(from: From, t?: Transformation) => (to: To): decodeTo<To, From> => new TransformNode(from, to, t) as never;
export const decode = <S extends Top>(t: Transformation<Type<S>, Type<S>>) => (self: S): S => new TransformNode(self, toType(self), t) as never;
export const encode = <S extends Top>(t: Transformation<Encoded<S>, Encoded<S>>) => (self: S): S => new TransformNode(toEncoded(self), self, t) as never;
class TypeSideNode extends Node {
  readonly _tag: string;
  readonly inner: Node;
  readonly side: "type" | "encoded";
  constructor(inner: Node, side: "type" | "encoded") {
    super();
    this.inner = inner;
    this.side = side;
    this._tag = inner._tag;
    this.annotations = inner.annotations;
  }
  decodeBase(u: unknown, ctx: Ctx) {
    if (this.side === "type") {
      if (this.inner.test(u)) return u;
      throw new Iss.InvalidType(this.inner, u);
    }
    return chain(this.inner.dec(u, ctx), () => u);
  }
  encodeBase(a: unknown, ctx: Ctx) {
    return this.decodeBase(a, ctx);
  }
  testBase(u: unknown) {
    if (this.side === "type") return this.inner.test(u);
    try {
      this.inner.dec(u, new Ctx());
      return true;
    } catch {
      return false;
    }
  }
  override describe() {
    return this.inner.describe();
  }
}
export const toType = <S extends Top>(self: S): toType<S> => new TypeSideNode(nodeOf(self), "type") as never;
export const typeSchema = toType;
export const toEncoded = <S extends Top>(self: S): toEncoded<S> => new TypeSideNode(nodeOf(self), "encoded") as never;
export const encodedSchema = toEncoded;
class JsonNode extends Node {
  readonly _tag: string;
  readonly inner: Node;
  constructor(inner: Node) {
    super();
    this.inner = inner;
    this._tag = inner._tag;
    this.annotations = inner.annotations;
  }
  decodeBase(u: unknown, ctx: Ctx) {
    return this.inner.dec(u, ctx.withJson());
  }
  encodeBase(a: unknown, ctx: Ctx) {
    return this.inner.enc(a, ctx.withJson());
  }
  testBase(u: unknown) {
    return this.inner.test(u);
  }
  override describe() {
    return this.inner.describe();
  }
}
/** Same Type; the Encoded side becomes JSON (DateTime → ISO string, bigint → string, Option → tagged object, ...). */
export const toCodecJson = <S extends Top>(self: S): toCodecJson<S> => new JsonNode(nodeOf(self)) as never;
export const toCodecIso = toCodecJson;
const parseJsonGetter = makeGetter((s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    throw new Iss.InvalidValue({ expected: "a valid JSON string" }, s);
  }
});
const stringifyJsonGetter = makeGetter((v: unknown) => JSON.stringify(v));
export const fromJsonString = <S extends Top>(self: S): fromJsonString<S> =>
  new TransformNode(String, self, { decode: parseJsonGetter, encode: stringifyJsonGetter }) as never;
export const UnknownFromJsonString: fromJsonString<Unknown> = fromJsonString(Unknown);

// ---------- brand / checks ----------
export const brand = <B extends string | symbol>(name: B, annotations?: Annotations) => <S extends Top>(self: S): brand<S, B> =>
  nodeOf(self).annotate({ brand: name, ...annotations }) as never;
export const check = <T>(...checks: ReadonlyArray<Check<T>>) => <S extends Top>(self: S): S => nodeOf(self).check(...checks) as never;
export const filter = <T>(pred: (a: T) => boolean | string | Iss.Issue | undefined, annotations?: Annotations) => <S extends Top>(self: S): S =>
  nodeOf(self).check(makeFilter(pred, annotations)) as never;
const mkCheck = <T>(run: (a: T) => Iss.Issue | undefined, annotations: Annotations | undefined, abort = false): Check<T> => ({
  _tag: "Filter", run, annotations, abort,
  annotate(a: Annotations) {
    return mkCheck(run, { ...annotations, ...a }, abort);
  },
});
export const makeFilter = <T>(pred: (a: T) => boolean | string | Iss.Issue | undefined | void, annotations?: Annotations, abort?: boolean): Check<T> =>
  mkCheck((a: T) => {
    const r = pred(a);
    if (r === true || r === undefined) return undefined;
    if (r === false) return new Iss.InvalidValue(annotations as Iss.IssueAnnotations | undefined, a);
    if (typeof r === "string") return new Iss.InvalidValue({ message: r }, a);
    return r as Iss.Issue;
  }, annotations, abort);
export const makeFilterGroup = <T>(checks: ReadonlyArray<Check<T>>, annotations?: Annotations): Check<T> =>
  mkCheck((a: T) => {
    for (const c of checks) {
      const i = c.run(a);
      if (i) return i;
    }
    return undefined;
  }, annotations);
const simple = <T>(test: (a: T) => boolean, expected: string, annotations?: Annotations) => mkCheck<T>((a) => (test(a) ? undefined : new Iss.InvalidValue({ expected }, a)), { expected, ...annotations });
const len = (a: unknown) => (typeof a === "string" || globalThis.Array.isArray(a) ? a.length : 0);
export const isInt = (a?: Annotations) => simple<number>((n) => globalThis.Number.isSafeInteger(n), "an integer", a);
export const isInt32 = (a?: Annotations) => simple<number>((n) => globalThis.Number.isInteger(n) && n >= -2147483648 && n <= 2147483647, "a 32-bit integer", a);
export const isUint32 = (a?: Annotations) => simple<number>((n) => globalThis.Number.isInteger(n) && n >= 0 && n <= 4294967295, "a 32-bit unsigned integer", a);
export const isFinite = (a?: Annotations) => simple<number>((n) => globalThis.Number.isFinite(n), "a finite number", a);
export const isGreaterThan = (min: number, a?: Annotations) => simple<number>((n) => n > min, `a value greater than ${min}`, a);
export const isGreaterThanOrEqualTo = (min: number, a?: Annotations) => simple<number>((n) => n >= min, `a value greater than or equal to ${min}`, a);
export const isLessThan = (max: number, a?: Annotations) => simple<number>((n) => n < max, `a value less than ${max}`, a);
export const isLessThanOrEqualTo = (max: number, a?: Annotations) => simple<number>((n) => n <= max, `a value less than or equal to ${max}`, a);
export const isBetween = (o: { readonly minimum: number; readonly maximum: number; readonly exclusiveMinimum?: boolean; readonly exclusiveMaximum?: boolean }, a?: Annotations) =>
  simple<number>((n) => (o.exclusiveMinimum ? n > o.minimum : n >= o.minimum) && (o.exclusiveMaximum ? n < o.maximum : n <= o.maximum), `a value between ${o.minimum} and ${o.maximum}`, a);
export const isMultipleOf = (d: number, a?: Annotations) => simple<number>((n) => n % d === 0, `a value that is a multiple of ${d}`, a);
export const isNonNegative = (a?: Annotations) => isGreaterThanOrEqualTo(0, a);
export const isPositive = (a?: Annotations) => isGreaterThan(0, a);
export const isNegative = (a?: Annotations) => isLessThan(0, a);
export const isMinLength = (n: number, a?: Annotations) => simple<{ readonly length: number }>((x) => len(x) >= n, `a value with a length of at least ${n}`, a);
export const isMaxLength = (n: number, a?: Annotations) => simple<{ readonly length: number }>((x) => len(x) <= n, `a value with a length of at most ${n}`, a);
export const isLengthBetween = (min: number, max: number, a?: Annotations) => simple<{ readonly length: number }>((x) => len(x) >= min && len(x) <= max, `a value with a length between ${min} and ${max}`, a);
export const isLength = (n: number, a?: Annotations) => simple<{ readonly length: number }>((x) => len(x) === n, `a value with a length of ${n}`, a);
export const isNonEmpty = (a?: Annotations) => isMinLength(1, a);
export const isPattern = (re: RegExp, a?: Annotations) => simple<string>((s) => {
  re.lastIndex = 0;
  return re.test(s);
}, `a string matching the RegExp ${re.source}`, a);
export const isTrimmed = (a?: Annotations) => simple<string>((s) => s.trim() === s, "a string with no leading or trailing whitespace", a);
export const isLowercased = (a?: Annotations) => simple<string>((s) => s.toLowerCase() === s, "a lowercase string", a);
export const isUppercased = (a?: Annotations) => simple<string>((s) => s.toUpperCase() === s, "an uppercase string", a);
export const isStartsWith = (p: string, a?: Annotations) => simple<string>((s) => s.startsWith(p), `a string starting with ${JSON.stringify(p)}`, a);
export const isEndsWith = (p: string, a?: Annotations) => simple<string>((s) => s.endsWith(p), `a string ending with ${JSON.stringify(p)}`, a);
export const isIncludes = (p: string, a?: Annotations) => simple<string>((s) => s.includes(p), `a string including ${JSON.stringify(p)}`, a);
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUUID = (_version?: number, a?: Annotations) => simple<string>((s) => uuidRe.test(s), "a UUID", a);
export const isGUID = (a?: Annotations) => simple<string>((s) => uuidRe.test(s), "a GUID", a);
export const isULID = (a?: Annotations) => simple<string>((s) => /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(s), "a ULID", a);
export const isBase64 = (a?: Annotations) => simple<string>((s) => /^[A-Za-z0-9+/]*={0,2}$/.test(s) && s.length % 4 === 0, "a base64 string", a);
export const isMaxProperties = (n: number, a?: Annotations) => simple<object>((o) => Object.keys(o).length <= n, `an object with at most ${n} properties`, a);
export const isMinProperties = (n: number, a?: Annotations) => simple<object>((o) => Object.keys(o).length >= n, `an object with at least ${n} properties`, a);
export const isUnique = (a?: Annotations) => simple<ReadonlyArray<unknown>>((xs) => new Set(xs).size === xs.length, "an array of unique items", a);
export const isValidDate = (a?: Annotations) => simple<Date>((d) => !globalThis.Number.isNaN(d.getTime()), "a valid date", a);

// ---------- common derived schemas ----------
export const Int = Number.check(isInt());
export const Finite = Number.check(isFinite());
export const Natural = Number.check(isInt(), isGreaterThanOrEqualTo(0));
export const NonNegative = Number.check(isGreaterThanOrEqualTo(0));
export const Positive = Number.check(isGreaterThan(0));
export const NonEmptyString = String.check(isNonEmpty());
export const Trimmed = String.check(isTrimmed());
export const UUID = String.check(isUUID());
export const Char = String.check(isLength(1));
const transformPrim = <T, E>(from: Top, to: Top, dec: (e: E) => T, enc: (t: T) => E, invalid?: string) =>
  new TransformNode(from, to, {
    decode: makeGetter((e: E) => {
      const t = dec(e);
      if (invalid !== undefined && (t === undefined || (typeof t === "number" && globalThis.Number.isNaN(t)))) throw new Iss.InvalidValue({ expected: invalid }, e);
      return t;
    }),
    encode: makeGetter(enc),
  });
export const NumberFromString: Bottom<number, string, never, never> = transformPrim(String, Number, (s: string) => (s.trim() === "" ? NaN : globalThis.Number(s)), (n: number) => globalThis.String(n), "a string representing a number") as never;
export const FiniteFromString: Bottom<number, string, never, never> = transformPrim(String, Finite, (s: string) => (s.trim() === "" ? NaN : globalThis.Number(s)), (n: number) => globalThis.String(n), "a string representing a finite number") as never;
export const BooleanFromBit: Bottom<boolean, 0 | 1, never, never> = transformPrim(Literals([0, 1]), Boolean, (b: 0 | 1) => b === 1, (x: boolean) => (x ? 1 : 0)) as never;
export const BooleanFromString: Bottom<boolean, "true" | "false", never, never> = transformPrim(Literals(["true", "false"]), Boolean, (s: string) => s === "true", (b: boolean) => (b ? "true" : "false")) as never;
export const StringFromUriComponent: Bottom<string, string, never, never> = transformPrim(String, String, (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined as never;
  }
}, (s: string) => encodeURIComponent(s), "a URI component") as never;
export const BigIntFromString: Bottom<bigint, string, never, never> = transformPrim(String, BigInt, (s: string) => {
  try {
    return globalThis.BigInt(s);
  } catch {
    return undefined as never;
  }
}, (b: bigint) => b.toString(), "a string representing a bigint") as never;
export const Trim: Bottom<string, string, never, never> = transformPrim(String, Trimmed, (s: string) => s.trim(), (s: string) => s) as never;
const b64 = {
  enc: (u: Uint8Array) => {
    let s = "";
    for (let i = 0; i < u.length; i++) s += globalThis.String.fromCharCode(u[i]!);
    return btoa(s);
  },
  dec: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};
const jsonDeclare = <T>(guard: (u: unknown) => boolean, name: string, toJson: (a: T) => unknown, fromJson: (u: unknown) => T | undefined) =>
  new DeclareNode(guard, {
    annotations: { identifier: name },
    jsonEncode: (a: T) => toJson(a),
    jsonDecode: (u: unknown) => {
      if (guard(u)) return u;
      let v: T | undefined;
      try {
        v = fromJson(u);
      } catch {
        v = undefined;
      }
      if (v === undefined || !guard(v)) throw new Iss.InvalidType({ _tag: "Declaration", annotations: { identifier: name } }, u);
      return v;
    },
  });
export const Uint8Array$: declare<Uint8Array> = jsonDeclare<Uint8Array>((u) => u instanceof globalThis.Uint8Array, "Uint8Array", b64.enc, (u) => (typeof u === "string" ? b64.dec(u) : undefined)) as never;
export { Uint8Array$ as Uint8Array };
export const Uint8ArrayFromBase64: Bottom<Uint8Array, string, never, never> = transformPrim(String, Uint8Array$, (s: string) => {
  try {
    return b64.dec(s);
  } catch {
    return undefined as never;
  }
}, b64.enc, "a base64 string") as never;
export const URL$: declare<globalThis.URL> = jsonDeclare<globalThis.URL>((u) => u instanceof globalThis.URL, "URL", (u) => u.href, (u) => (typeof u === "string" ? new globalThis.URL(u) : undefined)) as never;
export { URL$ as URL };
export const URLFromString: Bottom<globalThis.URL, string, never, never> = transformPrim(String, URL$, (s: string) => {
  try {
    return new globalThis.URL(s);
  } catch {
    return undefined as never;
  }
}, (u: globalThis.URL) => u.href, "a URL") as never;
export const Date$: declare<Date> = jsonDeclare<Date>((u) => u instanceof globalThis.Date, "Date", (d) => d.toISOString(), (u) => (typeof u === "string" ? new globalThis.Date(u) : undefined)) as never;
export { Date$ as Date };
export const DateFromString: Bottom<Date, string, never, never> = transformPrim(String, Date$, (s: string) => new globalThis.Date(s), (d: Date) => d.toISOString()) as never;
export const DateTimeUtc: declare<DT.Utc> = jsonDeclare<DT.Utc>((u) => DT.isDateTime(u) && u._tag === "Utc", "DateTimeUtc", DT.formatIso, (u) => (typeof u === "string" || typeof u === "number" ? DT.makeUnsafe(u) : undefined)) as never;
export const DateTimeUtcFromString: Bottom<DT.Utc, string, never, never> = transformPrim(String, DateTimeUtc, (s: string) => O.getOrUndefined(DT.make(s)) as DT.Utc, DT.formatIso, "a valid UTC DateTime string") as never;
export const DateTimeUtcFromMillis: Bottom<DT.Utc, number, never, never> = transformPrim(Number, DateTimeUtc, (n: number) => O.getOrUndefined(DT.make(n)) as DT.Utc, DT.toEpochMillis, "a number of milliseconds") as never;
export const DateTimeUtcFromDate: Bottom<DT.Utc, Date, never, never> = transformPrim(Date$, DateTimeUtc, (d: Date) => O.getOrUndefined(DT.make(d)) as DT.Utc, DT.toDateUtc) as never;
export const DateTimeZoned: declare<DT.Zoned> = jsonDeclare<DT.Zoned>((u) => DT.isDateTime(u) && u._tag === "Zoned", "DateTimeZoned", (z) => DT.formatIsoZoned(z), (u) => (typeof u === "string" ? DT.makeZonedUnsafe(u) : undefined)) as never;
export const Duration$: declare<Dur.Duration> = jsonDeclare<Dur.Duration>(Dur.isDuration, "Duration", (d) => d.millis, (u) => (typeof u === "number" ? Dur.millis(u) : undefined)) as never;
export { Duration$ as Duration };
export const DurationFromMillis: Bottom<Dur.Duration, number, never, never> = transformPrim(Number, Duration$, (n: number) => Dur.millis(n), (d: Dur.Duration) => d.millis) as never;
export const DurationFromNanos: Bottom<Dur.Duration, bigint, never, never> = transformPrim(BigInt, Duration$, (n: bigint) => Dur.nanos(n), (d: Dur.Duration) => Dur.toNanosUnsafe(d)) as never;
export const Error$: declare<Error> = jsonDeclare<Error>((u) => u instanceof globalThis.Error, "Error", (e) => ({ name: e.name, message: e.message }), (u) => {
  if (typeof u !== "object" || u === null || typeof (u as { message?: unknown }).message !== "string") return undefined;
  const e = new globalThis.Error((u as { message: string }).message);
  if (typeof (u as { name?: unknown }).name === "string") e.name = (u as { name: string }).name;
  return e;
}) as never;
/** `Schema.Error<Self>(id)(fields)` builds an error class; `Schema.Error` alone is the schema of Error values. */
export const Error: declare<globalThis.Error> & (<Self = never>(identifier: string) => <const F extends Fields>(fields: F, annotations?: Annotations) => Class<Self, F, YieldableError>) =
  Object.assign((identifier: string) => ErrorClass(identifier), { "~node": nodeOf(Error$), ast: nodeOf(Error$) }) as never;
/** Any value; Errors encode to `{ name, message }` and decode back to Error. */
export const Defect = (): Bottom<unknown, unknown, never, never> =>
  new DeclareNode(() => true, {
    annotations: { identifier: "Defect" },
    encode: (a: unknown) => (a instanceof globalThis.Error ? { name: a.name, message: a.message } : a),
    decode: (u: unknown) => {
      if (typeof u === "object" && u !== null && typeof (u as { message?: unknown }).message === "string" && typeof (u as { name?: unknown }).name === "string" && !(u instanceof globalThis.Error)) {
        const e = new globalThis.Error((u as { message: string }).message);
        e.name = (u as { name: string }).name;
        if (typeof (u as { stack?: unknown }).stack === "string") e.stack = (u as { stack: string }).stack;
        return e;
      }
      return u;
    },
    jsonEncode: (a: unknown) => (a instanceof globalThis.Error ? { name: a.name, message: a.message } : (() => {
      try {
        return JSON.parse(JSON.stringify(a ?? null));
      } catch {
        return globalThis.String(a);
      }
    })()),
  }) as never;
export const Option = <S extends Top>(value: S): Option$<S> => {
  const inner = nodeOf(value);
  return new DeclareNode(O.isOption, {
    annotations: { identifier: `Option<${inner.describe()}>` },
    decode: (o: O.Option<unknown>, ctx) => (o._tag === "None" ? o : chain(inner.dec(o.value, ctx), O.some)),
    encode: (o: O.Option<unknown>, ctx) => (o._tag === "None" ? o : chain(inner.enc(o.value, ctx), O.some)),
    jsonDecode: (u: unknown, ctx) => {
      if (O.isOption(u)) return u._tag === "None" ? u : chain(inner.dec(u.value, ctx), O.some);
      const t = (u as { _tag?: unknown } | null)?._tag;
      if (t === "None") return O.none();
      if (t === "Some" && typeof u === "object" && u !== null && "value" in u) return chain(inner.dec((u as { value: unknown }).value, ctx), O.some);
      throw new Iss.InvalidType({ _tag: "Declaration", annotations: { identifier: "Option" } }, u);
    },
    jsonEncode: (o: O.Option<unknown>, ctx) => (o._tag === "None" ? { _tag: "None" } : chain(inner.enc(o.value, ctx), (value) => ({ _tag: "Some", value }))),
  }) as never;
};
export const OptionFromNullOr = <S extends Top>(value: S): Bottom<O.Option<S["Type"]>, S["Encoded"] | null, S["DecodingServices"], S["EncodingServices"]> => {
  const inner = nodeOf(value);
  return new TransformNode(NullOr(value), Option(toType(value)), {
    decode: makeGetter((v: unknown) => (v === null ? O.none() : O.some(v))),
    encode: makeGetter((o: O.Option<unknown>) => (o._tag === "None" ? null : o.value)),
  }).clone({ annotations: { identifier: `OptionFromNullOr<${inner.describe()}>` } }) as never;
};
export const OptionFromUndefinedOr = <S extends Top>(value: S): Bottom<O.Option<S["Type"]>, S["Encoded"] | undefined, S["DecodingServices"], S["EncodingServices"]> =>
  new TransformNode(UndefinedOr(value), Option(toType(value)), {
    decode: makeGetter((v: unknown) => (v === undefined ? O.none() : O.some(v))),
    encode: makeGetter((o: O.Option<unknown>) => (o._tag === "None" ? undefined : o.value)),
  }) as never;
export const OptionFromOptionalKey = <S extends Top>(value: S) => optionalKey(OptionFromUndefinedOr(value));
export const Redacted = <S extends Top>(value: S): Bottom<Red.Redacted<S["Type"]>, Red.Redacted<S["Encoded"]>, S["DecodingServices"], S["EncodingServices"]> => {
  const inner = nodeOf(value);
  return new DeclareNode(Red.isRedacted, {
    annotations: { identifier: "Redacted" },
    decode: (r: Red.Redacted<unknown>, ctx) => chain(inner.dec(Red.value(r), ctx), (v) => Red.make(v, { label: r.label })),
    encode: (r: Red.Redacted<unknown>, ctx) => chain(inner.enc(Red.value(r), ctx), (v) => Red.make(v, { label: r.label })),
    jsonEncode: () => {
      throw new Iss.Forbidden({ message: "Cannot serialize Redacted" });
    },
  }) as never;
};
export const RedactedFromValue = <S extends Top>(value: S, options?: { readonly label?: string }): Bottom<Red.Redacted<S["Type"]>, S["Encoded"], S["DecodingServices"], S["EncodingServices"]> =>
  new TransformNode(value, new DeclareNode(Red.isRedacted, { annotations: { identifier: "Redacted" } }) as never, {
    decode: makeGetter((v: unknown) => Red.make(v, options)),
    encode: makeGetter((r: Red.Redacted<unknown>) => Red.value(r)),
  }) as never;
export const Exit = <A extends Top, E extends Top>(_success: A, _failure: E, _defect?: Top): Bottom<I.Exit<A["Type"], E["Type"]>, I.Exit<A["Encoded"], E["Encoded"]>, never, never> =>
  new DeclareNode(I.isExit, { annotations: { identifier: "Exit" } }) as never;
export const Result = <A extends Top, E extends Top>(_o: { readonly success: A; readonly failure: E }): Bottom<R.Result<A["Type"], E["Type"]>, R.Result<A["Encoded"], E["Encoded"]>, never, never> =>
  new DeclareNode(R.isResult, { annotations: { identifier: "Result" } }) as never;
export const PropertyKey$: Bottom<PropertyKey, PropertyKey, never, never> = new UnionNode([String, Number, Symbol]) as never;
export { PropertyKey$ as PropertyKey };

// ---------- classes ----------
class ClassNode extends Node {
  readonly _tag = "Declaration";
  readonly struct: StructNode;
  readonly ctor: new (props: any, options?: any) => any;
  constructor(ctor: new (props: any, options?: any) => any, struct: StructNode, annotations?: Annotations) {
    super();
    this.ctor = ctor;
    this.struct = struct;
    this.annotations = { identifier: ctor.name, ...annotations };
  }
  decodeBase(u: unknown, ctx: Ctx) {
    if (u instanceof this.ctor) return u;
    return chain(this.struct.dec(u, ctx), (fields) => new this.ctor(fields, true));
  }
  encodeBase(a: unknown, ctx: Ctx) {
    if (!(a instanceof this.ctor) && !this.struct.test(a)) throw new Iss.InvalidType(this, a);
    return this.struct.enc(a, ctx);
  }
  testBase(u: unknown) {
    return u instanceof this.ctor;
  }
  override describe() {
    return this.ctor.name;
  }
}
const classNodes = new WeakMap<Function, ClassNode>();
/** Static members making a class constructor usable as a schema. */
function installSchemaStatics(Base: any, struct: StructNode, annotations: Annotations | undefined) {
  Object.defineProperty(Base, "~node", {
    get(this: any) {
      let n = classNodes.get(this);
      if (!n) classNodes.set(this, (n = new ClassNode(this, struct, annotations)));
      return n;
    },
  });
  Object.defineProperty(Base, "ast", { get(this: any) { return this["~node"]; } });
  Object.defineProperty(Base, "fields", { value: struct.fields });
  for (const m of ["annotate", "annotateKey", "check", "pipe"] as const)
    Object.defineProperty(Base, m, { value(this: any, ...args: Array<unknown>) { return m === "pipe" ? I.pipeArgs(this, args as Array<Function>) : (this["~node"] as any)[m](...args); } });
  Object.defineProperty(Base, "makeUnsafe", { value(this: any, props: unknown) { return new this(props); } });
  Object.defineProperty(Base, "make", { value(this: any, props: unknown) { return new this(props); } });
  for (const k of ["typeOpt", "encOpt", "decDefault", "ctorDefault", "keyAnnotations", "checks"]) Object.defineProperty(Base, k, { get(this: any) { return this["~node"][k]; } });
}
const validateProps = (struct: StructNode, props: unknown, skip: unknown): unknown => {
  if (skip === true || (typeof skip === "object" && skip !== null && (skip as MakeOptions).disableValidation)) return props ?? {};
  return struct.makeUnsafe(props ?? {});
};
type ClassStatics<Self, F extends Fields, E> = Bottom<Self, E, FieldsRD<F>, FieldsRE<F>> & { readonly fields: F; make(props: StructMakeIn<F>): Self; makeUnsafe(props: StructMakeIn<F>): Self };
export type Class<Self, F extends Fields, Inherited = {}> = ClassStatics<Self, F, StructEncoded<F>> & {
  new (props: {} extends StructMakeIn<F> ? void | StructMakeIn<F> : StructMakeIn<F>, options?: MakeOptions | boolean): StructType<F> & Inherited;
};
export const Class = <Self = never>(identifier: string) => <const F extends Fields>(fields: F | Struct<F>, annotations?: Annotations): Class<Self, F> => {
  const struct = (fields instanceof StructNode ? fields : new StructNode(fields as F)) as StructNode;
  const Base = class {
    constructor(props: unknown, options?: unknown) {
      Object.assign(this, validateProps(struct, props, options));
    }
  };
  Object.assign(Base.prototype, I.StructuralProto);
  installSchemaStatics(Base, struct, { identifier, ...annotations });
  return Base as never;
};
export type TaggedClass<Self, Tag extends string, F extends Fields> = ClassStatics<Self, F & { readonly _tag: Literal<Tag> }, Simplify<{ readonly _tag: Tag } & StructEncoded<F>>> & {
  new (props: {} extends StructMakeIn<F> ? void | StructMakeIn<F> : StructMakeIn<F>, options?: MakeOptions | boolean): { readonly _tag: Tag } & StructType<F>;
};
export const TaggedClass = <Self = never>(identifier?: string) => <const Tag extends string, const F extends Fields>(tag: Tag, fields: F, annotations?: Annotations): TaggedClass<Self, Tag, F> => {
  const struct = new StructNode({ _tag: withConstructorDefault(() => tag)(Literal(tag)), ...fields });
  const Base = class {
    constructor(props: unknown, options?: unknown) {
      Object.assign(this, validateProps(struct, { ...(props as object), _tag: tag }, options));
    }
  };
  Object.assign(Base.prototype, I.StructuralProto);
  installSchemaStatics(Base, struct, { identifier: identifier ?? tag, ...annotations });
  return Base as never;
};
export type TaggedError<Self, Tag extends string, F extends Fields> = ClassStatics<Self, F & { readonly _tag: Literal<Tag> }, Simplify<{ readonly _tag: Tag } & StructEncoded<F>>> & {
  new (props: {} extends StructMakeIn<F> ? void | StructMakeIn<F> : StructMakeIn<F>, options?: MakeOptions | boolean): YieldableError & { readonly _tag: Tag } & StructType<F>;
};
export const TaggedError = <Self = never>(identifier?: string) => <const Tag extends string, const F extends Fields>(tag: Tag, fields: F, annotations?: Annotations): TaggedError<Self, Tag, F> => {
  const struct = new StructNode({ _tag: withConstructorDefault(() => tag)(Literal(tag)), ...fields });
  const Base = class extends YieldableError {
    constructor(props: unknown, options?: unknown) {
      const p = validateProps(struct, { ...(props as object), _tag: tag }, options) as Record<string, unknown>;
      super(typeof p.message === "string" ? p.message : "", "cause" in p ? { cause: p.cause } : undefined);
      Object.assign(this, p);
      this.name = tag;
    }
  };
  installSchemaStatics(Base, struct, { identifier: identifier ?? tag, ...annotations });
  return Base as never;
};
export const ErrorClass = <Self = never>(identifier: string) => <const F extends Fields>(fields: F, annotations?: Annotations): Class<Self, F, YieldableError> => {
  const struct = new StructNode(fields);
  const Base = class extends YieldableError {
    constructor(props: unknown, options?: unknown) {
      const p = validateProps(struct, props, options) as Record<string, unknown>;
      super(typeof p.message === "string" ? p.message : "");
      Object.assign(this, p);
      this.name = identifier;
    }
  };
  installSchemaStatics(Base, struct, { identifier, ...annotations });
  return Base as never;
};

// ---------- errors ----------
export class SchemaError extends YieldableError {
  readonly _tag = "SchemaError";
  readonly issue: Iss.Issue;
  constructor(issue: Iss.Issue) {
    super(Iss.format(issue));
    this.issue = issue;
    this.name = "SchemaError";
  }
}
export const isSchemaError = (u: unknown): u is SchemaError => u instanceof SchemaError;

// ---------- decoding API ----------
export interface ParseOptions {
  readonly errors?: "first" | "all";
  readonly onExcessProperty?: "ignore" | "error" | "preserve";
  readonly disableChecks?: boolean;
}
const mkCtx = (o?: ParseOptions, f?: I.Fiber) => {
  const c = new Ctx(f);
  if (o?.errors === "all") c.all = true;
  if (o?.onExcessProperty) c.excess = o.onExcessProperty;
  return c;
};
/** Returns the value, or the Issue when `asIssue` (sync only). */
function decodeWith(n: Node, u: unknown, ctx: Ctx, asIssue = false, enc = false): unknown {
  try {
    const r = enc ? n.enc(u, ctx) : n.dec(u, ctx);
    if (r instanceof Async) throw new Iss.Forbidden({ message: "cannot decode synchronously: the schema contains an asynchronous transformation" }, u);
    return asIssue ? undefined : r;
  } catch (e) {
    if (!Iss.isIssue(e)) throw e;
    if (asIssue) return e;
    throw new SchemaError(e);
  }
}
type SyncFn<In, Out> = (input: In, options?: ParseOptions) => Out;
const syncDecode = (enc: boolean) => (s: Top, o?: ParseOptions) => {
  const n = nodeOf(s);
  return (u: unknown, o2?: ParseOptions) => decodeWith(n, u, mkCtx(o2 ?? o), false, enc);
};
const effectDecode = (enc: boolean) => (s: Top, o?: ParseOptions) => {
  const n = nodeOf(s);
  return (u: unknown, o2?: ParseOptions) =>
    I.make((f) => I.settle(() => (enc ? n.enc(u, mkCtx(o2 ?? o, f)) : n.dec(u, mkCtx(o2 ?? o, f))), (a) => a, (e) => {
      if (Iss.isIssue(e)) return I.failWith(I.causeFail(new SchemaError(e)));
      throw e;
    }));
};
const exitDecode = (enc: boolean) => (s: Top, o?: ParseOptions) => {
  const n = nodeOf(s);
  return (u: unknown, o2?: ParseOptions): I.Exit<any, SchemaError> => {
    try {
      return I.exitSucceed(decodeWith(n, u, mkCtx(o2 ?? o), false, enc));
    } catch (e) {
      return e instanceof SchemaError ? I.exitFailCause(I.causeFail(e)) : I.exitFailCause(I.causeDie(e));
    }
  };
};
const optionDecode = (enc: boolean) => (s: Top, o?: ParseOptions) => {
  const n = nodeOf(s);
  return (u: unknown, o2?: ParseOptions): O.Option<any> => {
    const ctx = mkCtx(o2 ?? o);
    try {
      const r = enc ? n.enc(u, ctx) : n.dec(u, ctx);
      return r instanceof Async ? O.none() : O.some(r);
    } catch (e) {
      if (Iss.isIssue(e)) return O.none();
      throw e;
    }
  };
};
const resultDecode = (enc: boolean) => (s: Top, o?: ParseOptions) => {
  const n = nodeOf(s);
  return (u: unknown, o2?: ParseOptions): R.Result<any, SchemaError> => {
    try {
      return R.succeed(decodeWith(n, u, mkCtx(o2 ?? o), false, enc));
    } catch (e) {
      if (e instanceof SchemaError) return R.fail(e);
      throw e;
    }
  };
};
type DecSync = <S extends Top>(s: S, options?: ParseOptions) => SyncFn<unknown, S["Type"]>;
type DecSyncT = <S extends Top>(s: S, options?: ParseOptions) => SyncFn<S["Encoded"], S["Type"]>;
type EncSync = <S extends Top>(s: S, options?: ParseOptions) => SyncFn<S["Type"], S["Encoded"]>;
type EncSyncU = <S extends Top>(s: S, options?: ParseOptions) => SyncFn<unknown, S["Encoded"]>;
type DecEff = <S extends Top>(s: S, options?: ParseOptions) => (input: unknown, options?: ParseOptions) => I.Effect<S["Type"], SchemaError, S["DecodingServices"]>;
type DecEffT = <S extends Top>(s: S, options?: ParseOptions) => (input: S["Encoded"], options?: ParseOptions) => I.Effect<S["Type"], SchemaError, S["DecodingServices"]>;
type EncEff = <S extends Top>(s: S, options?: ParseOptions) => (input: S["Type"], options?: ParseOptions) => I.Effect<S["Encoded"], SchemaError, S["EncodingServices"]>;
type EncEffU = <S extends Top>(s: S, options?: ParseOptions) => (input: unknown, options?: ParseOptions) => I.Effect<S["Encoded"], SchemaError, S["EncodingServices"]>;
export const decodeUnknownSync: DecSync = syncDecode(false) as never;
export const decodeSync: DecSyncT = syncDecode(false) as never;
export const encodeSync: EncSync = syncDecode(true) as never;
export const encodeUnknownSync: EncSyncU = syncDecode(true) as never;
export const decodeUnknownEffect: DecEff = effectDecode(false) as never;
export const decodeEffect: DecEffT = effectDecode(false) as never;
export const encodeEffect: EncEff = effectDecode(true) as never;
export const encodeUnknownEffect: EncEffU = effectDecode(true) as never;
export const decodeUnknownExit = exitDecode(false) as <S extends Top>(s: S, o?: ParseOptions) => SyncFn<unknown, I.Exit<S["Type"], SchemaError>>;
export const decodeExit = exitDecode(false) as <S extends Top>(s: S, o?: ParseOptions) => SyncFn<S["Encoded"], I.Exit<S["Type"], SchemaError>>;
export const encodeUnknownExit = exitDecode(true) as <S extends Top>(s: S, o?: ParseOptions) => SyncFn<unknown, I.Exit<S["Encoded"], SchemaError>>;
export const encodeExit = exitDecode(true) as <S extends Top>(s: S, o?: ParseOptions) => SyncFn<S["Type"], I.Exit<S["Encoded"], SchemaError>>;
export const decodeUnknownOption = optionDecode(false) as <S extends Top>(s: S, o?: ParseOptions) => SyncFn<unknown, O.Option<S["Type"]>>;
export const decodeOption = optionDecode(false) as <S extends Top>(s: S, o?: ParseOptions) => SyncFn<S["Encoded"], O.Option<S["Type"]>>;
export const encodeUnknownOption = optionDecode(true) as <S extends Top>(s: S, o?: ParseOptions) => SyncFn<unknown, O.Option<S["Encoded"]>>;
export const encodeOption = optionDecode(true) as <S extends Top>(s: S, o?: ParseOptions) => SyncFn<S["Type"], O.Option<S["Encoded"]>>;
export const decodeUnknownResult = resultDecode(false) as <S extends Top>(s: S, o?: ParseOptions) => SyncFn<unknown, R.Result<S["Type"], SchemaError>>;
export const decodeResult = resultDecode(false) as <S extends Top>(s: S, o?: ParseOptions) => SyncFn<S["Encoded"], R.Result<S["Type"], SchemaError>>;
export const encodeUnknownResult = resultDecode(true) as <S extends Top>(s: S, o?: ParseOptions) => SyncFn<unknown, R.Result<S["Encoded"], SchemaError>>;
export const encodeResult = resultDecode(true) as <S extends Top>(s: S, o?: ParseOptions) => SyncFn<S["Type"], R.Result<S["Encoded"], SchemaError>>;
export const decodeUnknownPromise = <S extends Top>(s: S, o?: ParseOptions) => {
  const eff = decodeUnknownEffect(s, o);
  return (u: unknown): Promise<S["Type"]> => {
    const f = I.runFiber(eff(u), I.emptyContext);
    const toP = (e: I.Exit<any, any>) => (e._tag === "Success" ? e.value : Promise.reject((e.cause.reasons[0] as I.Fail<unknown> | undefined)?.error ?? e.cause));
    return f.exit ? Promise.resolve(toP(f.exit)) : new Promise((res) => f.addObserver((e) => res(toP(e))));
  };
};
export const is = <S extends Top>(s: S) => {
  const n = nodeOf(s);
  return (u: unknown): u is S["Type"] => n.test(u);
};
export const asserts = <S extends Top>(s: S) => {
  const n = nodeOf(s);
  return (u: unknown): asserts u is S["Type"] => {
    if (!n.test(u)) throw new SchemaError((decodeWith(new TypeSideNode(n, "type"), u, new Ctx(), true) as Iss.Issue) ?? new Iss.InvalidType(n, u));
  };
};
export const isSchema = (u: unknown): u is Top => (typeof u === "object" || typeof u === "function") && u !== null && "~node" in u;
export const toEquivalence = <S extends Top>(_s: S) => (a: S["Type"], b: S["Type"]): boolean => I.equals(a, b) || JSON.stringify(a) === JSON.stringify(b);

// ---------- JSON Schema ----------
export interface JsonSchemaDocument {
  readonly dialect: "draft-2020-12";
  readonly schema: Record<string, unknown>;
  readonly definitions: Record<string, Record<string, unknown>>;
}
/** Draft 2020-12 JSON Schema for the Encoded side of `schema`. */
export const toJsonSchemaDocument = (schema: Top, options?: { readonly onExcessProperty?: "ignore" | "error" | "preserve" }): JsonSchemaDocument => {
  const definitions: Record<string, Record<string, unknown>> = {};
  const seen = new Set<Node>();
  const meta = (n: Node, js: Record<string, unknown>): Record<string, unknown> => {
    const a = n.annotations;
    if (a?.title !== undefined) js.title = a.title;
    if (a?.description !== undefined) js.description = a.description;
    if (a?.default !== undefined) js.default = a.default;
    if (a?.examples !== undefined) js.examples = a.examples;
    for (const c of n.checks ?? []) Object.assign(js, checkJson(c));
    return js;
  };
  const go = (n: Node): Record<string, unknown> => {
    if (n instanceof SuspendNode) {
      const id = (n.annotations?.identifier as string | undefined) ?? (n.inner.annotations?.identifier as string | undefined) ?? `Suspend${Object.keys(definitions).length}`;
      if (!seen.has(n)) {
        seen.add(n);
        definitions[id] = {};
        definitions[id] = go(n.inner);
      }
      return { $ref: `#/$defs/${id}` };
    }
    if (n instanceof TypeSideNode || n instanceof JsonNode) return meta(n, go(n.inner));
    if (n instanceof TransformNode) return meta(n, go(n.fromN));
    if (n instanceof ClassNode) return meta(n, go(n.struct));
    if (n instanceof Primitive) {
      const t: Record<string, Record<string, unknown>> = {
        String: { type: "string" }, Number: { type: "number" }, Boolean: { type: "boolean" }, Null: { type: "null" },
        BigInt: { type: "string" }, ObjectKeyword: { type: "object" }, Never: { not: {} },
      };
      return meta(n, { ...(t[n._tag] ?? {}) });
    }
    if (n instanceof LiteralNode) return meta(n, n.literal === null ? { type: "null" } : { type: typeof n.literal === "bigint" ? "string" : typeof n.literal, enum: [n.literal] });
    if (n instanceof LiteralsNode) return meta(n, { type: [...new Set(n.literals.map((l) => (l === null ? "null" : typeof l)))].length === 1 ? (n.literals[0] === null ? "null" : typeof n.literals[0]) : undefined, enum: [...n.literals] });
    if (n instanceof TemplateLiteralNode) return meta(n, { type: "string", pattern: n.re.source });
    if (n instanceof StructNode) {
      const properties: Record<string, unknown> = {};
      const required: Array<string> = [];
      for (const p of n.props) {
        const k = globalThis.String(p.encKey);
        properties[k] = { ...go(p.node), ...(p.node.keyAnnotations?.description ? { description: p.node.keyAnnotations.description } : {}) };
        if (!p.encOpt) required.push(k);
      }
      const js: Record<string, unknown> = { type: "object", properties, required };
      if (n.rest.length) js.additionalProperties = n.rest.length === 1 ? go(n.rest[0]!.valueNode) : { anyOf: n.rest.map((r) => go(r.valueNode)) };
      else js.additionalProperties = options?.onExcessProperty === "error" ? false : true;
      return meta(n, js);
    }
    if (n instanceof RecordNode) {
      const js: Record<string, unknown> = { type: "object", additionalProperties: go(n.valueNode) };
      if (n.keyNode.checks?.length || n.keyNode instanceof TemplateLiteralNode) js.propertyNames = go(n.keyNode);
      return meta(n, js);
    }
    if (n instanceof ArrayNode) return meta(n, { type: "array", items: go(n.item), ...(n.nonEmpty ? { minItems: 1 } : {}) });
    if (n instanceof TupleNode) return meta(n, { type: "array", prefixItems: n.nodes.map(go), minItems: n.nodes.filter((x) => x.typeOpt !== "optional").length, ...(n.restNode ? { items: go(n.restNode) } : { maxItems: n.nodes.length }) });
    if (n instanceof UnionNode) {
      const members = n.nodes.filter((m) => m._tag !== "Undefined").map(go);
      return meta(n, members.length === 1 ? members[0]! : { anyOf: members });
    }
    if (n instanceof DeclareNode) {
      const id = n.annotations?.identifier;
      if (id === "DateTimeUtc" || id === "Date" || id === "URL" || id === "Uint8Array") return meta(n, { type: "string" });
      return meta(n, {});
    }
    return meta(n, {});
  };
  return { dialect: "draft-2020-12", schema: go(nodeOf(schema)), definitions };
};
const checkJson = (c: Check<any>): Record<string, unknown> => {
  const e = (c.annotations?.expected as string | undefined) ?? "";
  let m: RegExpMatchArray | null;
  if (e === "an integer") return { type: "integer" };
  if ((m = e.match(/^a value greater than or equal to (.+)$/))) return { minimum: globalThis.Number(m[1]) };
  if ((m = e.match(/^a value greater than (.+)$/))) return { exclusiveMinimum: globalThis.Number(m[1]) };
  if ((m = e.match(/^a value less than or equal to (.+)$/))) return { maximum: globalThis.Number(m[1]) };
  if ((m = e.match(/^a value less than (.+)$/))) return { exclusiveMaximum: globalThis.Number(m[1]) };
  if ((m = e.match(/^a value between (\S+) and (\S+)$/))) return { minimum: globalThis.Number(m[1]), maximum: globalThis.Number(m[2]) };
  if ((m = e.match(/^a value with a length of at least (\d+)$/))) return { minLength: globalThis.Number(m[1]) };
  if ((m = e.match(/^a value with a length of at most (\d+)$/))) return { maxLength: globalThis.Number(m[1]) };
  if ((m = e.match(/^a string matching the RegExp (.+)$/))) return { pattern: m[1] };
  if (c.annotations?.description) return { description: c.annotations.description };
  return {};
};
export const toJsonSchema = (schema: Top) => toJsonSchemaDocument(schema).schema;
export { Iss as Issue };
export type SchemaIssue = Iss.Issue;
