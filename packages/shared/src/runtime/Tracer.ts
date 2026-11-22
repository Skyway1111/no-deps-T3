import * as I from "./internal.ts";
import * as Ctx from "./Context.ts";
import * as O from "./Option.ts";

export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";
export type SpanStatus = { _tag: "Started"; startTime: bigint } | { _tag: "Ended"; startTime: bigint; endTime: bigint; exit: I.Exit<unknown, unknown> };
export interface SpanLink { readonly span: AnySpan; readonly attributes: Readonly<Record<string, unknown>> }
export interface ExternalSpan {
  readonly _tag: "ExternalSpan";
  readonly spanId: string;
  readonly traceId: string;
  readonly sampled: boolean;
  readonly annotations: Ctx.Context<never>;
}
export interface Span {
  readonly _tag: "Span";
  readonly name: string;
  readonly spanId: string;
  readonly traceId: string;
  readonly parent: O.Option<AnySpan>;
  readonly annotations: Ctx.Context<never>;
  readonly status: SpanStatus;
  readonly attributes: ReadonlyMap<string, unknown>;
  readonly links: ReadonlyArray<SpanLink>;
  readonly sampled: boolean;
  readonly kind: SpanKind;
  end(endTime: bigint, exit: I.Exit<unknown, unknown>): void;
  attribute(key: string, value: unknown): void;
  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void;
  addLinks(links: ReadonlyArray<SpanLink>): void;
}
export type AnySpan = Span | ExternalSpan;
export type ParentSpan = AnySpan;
export interface SpanOptions {
  readonly attributes?: Record<string, unknown> | undefined;
  readonly links?: ReadonlyArray<SpanLink> | undefined;
  readonly parent?: AnySpan | undefined;
  readonly root?: boolean | undefined;
  readonly kind?: SpanKind | undefined;
  readonly captureStackTrace?: boolean | LazyArg<string | undefined> | undefined;
  readonly sampled?: boolean | undefined;
  readonly level?: string | undefined;
}
type LazyArg<A> = () => A;
export interface Tracer {
  span(options: {
    readonly name: string;
    readonly parent: O.Option<AnySpan>;
    readonly annotations: Ctx.Context<never>;
    readonly links: Array<SpanLink>;
    readonly startTime: bigint;
    readonly kind: SpanKind;
    readonly root: boolean;
    readonly sampled: boolean;
  }): Span;
}

const hex = (n: number) => {
  let s = "";
  for (let i = 0; i < n; i++) s += ((Math.random() * 16) | 0).toString(16);
  return s;
};
export class NativeSpan implements Span {
  readonly _tag = "Span";
  readonly spanId: string;
  readonly traceId: string;
  status: SpanStatus;
  readonly attributes = new Map<string, unknown>();
  readonly events: Array<[string, bigint, Record<string, unknown>]> = [];
  links: Array<SpanLink>;
  readonly name: string;
  readonly parent: O.Option<AnySpan>;
  readonly annotations: Ctx.Context<never>;
  readonly startTime: bigint;
  readonly kind: SpanKind;
  readonly sampled: boolean;
  constructor(o: Parameters<Tracer["span"]>[0]) {
    this.name = o.name;
    this.parent = o.parent;
    this.annotations = o.annotations;
    this.startTime = o.startTime;
    this.kind = o.kind;
    this.sampled = o.sampled;
    this.links = o.links;
    this.status = { _tag: "Started", startTime: o.startTime };
    this.traceId = o.parent._tag === "Some" && !o.root ? o.parent.value.traceId : hex(32);
    this.spanId = hex(16);
  }
  end(endTime: bigint, exit: I.Exit<unknown, unknown>) {
    this.status = { _tag: "Ended", startTime: this.status.startTime, endTime, exit };
  }
  attribute(key: string, value: unknown) {
    this.attributes.set(key, value);
  }
  event(name: string, startTime: bigint, attributes?: Record<string, unknown>) {
    this.events.push([name, startTime, attributes ?? {}]);
  }
  addLinks(links: ReadonlyArray<SpanLink>) {
    this.links.push(...links);
  }
}
export const make = (options: Tracer): Tracer => options;
export const nativeTracer: Tracer = { span: (o) => new NativeSpan(o) };
export const Tracer = Ctx.Reference<Tracer>("effect/Tracer", { defaultValue: () => nativeTracer });
export const TracerKey = Tracer.key;
export const ParentSpan = Ctx.Service<ParentSpan, AnySpan>("effect/Tracer/ParentSpan");
export const ParentSpanKey = ParentSpan.key;
export const DisablePropagation = Ctx.Reference<boolean>("effect/Tracer/DisablePropagation", { defaultValue: () => false });
export const MinimumTraceLevel = Ctx.Reference<string>("effect/Tracer/MinimumTraceLevel", { defaultValue: () => "All" });
export const CurrentTraceLevel = Ctx.Reference<string>("effect/Tracer/CurrentTraceLevel", { defaultValue: () => "Info" });
export const externalSpan = (o: { spanId: string; traceId: string; sampled?: boolean; annotations?: Ctx.Context<never> }): ExternalSpan => ({
  _tag: "ExternalSpan", spanId: o.spanId, traceId: o.traceId, sampled: o.sampled ?? true, annotations: o.annotations ?? I.emptyContext,
});
