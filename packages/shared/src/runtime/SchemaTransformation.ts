import * as I from "./internal.ts";
import * as Iss from "./SchemaIssue.ts";
import * as G from "./SchemaGetter.ts";
import type { Transformation as T } from "./Schema.ts";

export class Transformation<To, From, RD = never, RE = never> implements T<To, From, RD, RE> {
  readonly decode: G.Getter<To, From, RD>;
  readonly encode: G.Getter<From, To, RE>;
  constructor(decode: G.Getter<To, From, RD>, encode: G.Getter<From, To, RE>) {
    this.decode = decode;
    this.encode = encode;
  }
  flip(): Transformation<From, To, RE, RD> {
    return new Transformation(this.encode, this.decode);
  }
  compose<To2, RD2, RE2>(that: Transformation<To2, To, RD2, RE2>): Transformation<To2, From, RD | RD2, RE | RE2> {
    return new Transformation(G.compose(this.decode, that.decode), G.compose(that.encode, this.encode));
  }
}
export const make = <To, From, RD = never, RE = never>(o: { readonly decode: G.Getter<To, From, RD>; readonly encode: G.Getter<From, To, RE> }) => new Transformation(o.decode, o.encode);
export const transform = <To, From>(o: { readonly decode: (from: From) => To; readonly encode: (to: To) => From }) => new Transformation(G.transform(o.decode), G.transform(o.encode));
export const transformEffect = <To, From, RD = never, RE = never>(o: {
  readonly decode: (from: From) => I.Effect<To, Iss.Issue, RD>;
  readonly encode: (to: To) => I.Effect<From, Iss.Issue, RE>;
}) => new Transformation(G.transformEffect(o.decode), G.transformEffect(o.encode));
export const transformOrFail = transformEffect;
export const transformOptional = <To, From>(o: { readonly decode: (from: import("./Option.ts").Option<From>) => import("./Option.ts").Option<To>; readonly encode: (to: import("./Option.ts").Option<To>) => import("./Option.ts").Option<From> }) =>
  new Transformation(G.transformOptional(o.decode), G.transformOptional(o.encode));
export const passthrough = <T>() => new Transformation<T, T>(G.passthrough(), G.passthrough());
export const composeTransformation = <A, B, C>(first: Transformation<B, A, any, any>, second: Transformation<C, B, any, any>) => first.compose(second);
export const trim = () => new Transformation<string, string>(G.trim(), G.passthrough());
export const toLowerCase = () => new Transformation<string, string>(G.toLowerCase(), G.passthrough());
export const toUpperCase = () => new Transformation<string, string>(G.toUpperCase(), G.passthrough());
export const numberFromString = new Transformation<number, string>(G.Number(), G.String());
export const isTransformation = (u: unknown): u is Transformation<unknown, unknown> => u instanceof Transformation;
