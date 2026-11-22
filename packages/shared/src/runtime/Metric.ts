import * as I from "./internal.ts";
import * as Ctx from "./Context.ts";

/** Minimal metrics: counters, gauges, histograms/timers stored in a registry keyed by name+attributes. */
export type MetricType = "Counter" | "Gauge" | "Histogram" | "Frequency" | "Summary";
export interface MetricState {
  readonly type: MetricType;
  value: number;
  count: number;
  sum: number;
  min: number;
  max: number;
  readonly occurrences: Map<string, number>;
}
export interface Metric<in Input, out State = MetricState> extends I.Pipeable {
  readonly id: string;
  readonly type: MetricType;
  readonly description: string | undefined;
  readonly attributes: Readonly<Record<string, string>>;
  readonly _I?: (_: Input) => void;
  readonly _S?: () => State;
}
export class MetricRegistryImpl {
  readonly states = new Map<string, { metric: Metric<any>; state: MetricState }>();
  stateOf(m: Metric<any>): MetricState {
    const key = `${m.id}${JSON.stringify(m.attributes)}`;
    let e = this.states.get(key);
    if (!e) this.states.set(key, (e = { metric: m, state: { type: m.type, value: 0, count: 0, sum: 0, min: Infinity, max: -Infinity, occurrences: new Map() } }));
    return e.state;
  }
}
export const MetricRegistry = Ctx.Reference<MetricRegistryImpl>("effect/Metric/MetricRegistry", { defaultValue: () => new MetricRegistryImpl() });
const mk = <In>(type: MetricType, id: string, o?: { readonly description?: string; readonly attributes?: Record<string, string> }): Metric<In> =>
  ({ id, type, description: o?.description, attributes: o?.attributes ?? {}, pipe() { return I.pipeArgs(this, arguments); } });
export const counter = (name: string, o?: { readonly description?: string; readonly attributes?: Record<string, string>; readonly bigint?: boolean; readonly incremental?: boolean }): Metric<number> => mk("Counter", name, o);
export const gauge = (name: string, o?: { readonly description?: string; readonly attributes?: Record<string, string> }): Metric<number> => mk("Gauge", name, o);
export const histogram = (name: string, o?: { readonly description?: string; readonly attributes?: Record<string, string>; readonly boundaries?: ReadonlyArray<number> }): Metric<number> => mk("Histogram", name, o);
export const timer = (name: string, o?: { readonly description?: string; readonly attributes?: Record<string, string> }): Metric<import("./Duration.ts").Duration | number> => mk("Histogram", name, o);
export const frequency = (name: string, o?: { readonly description?: string; readonly attributes?: Record<string, string> }): Metric<string> => mk("Frequency", name, o);
export const summary = histogram;
const apply = (s: MetricState, input: unknown) => {
  const n = typeof input === "number" ? input : typeof input === "object" && input !== null && "millis" in input ? (input as { millis: number }).millis : 0;
  s.count++;
  if (s.type === "Counter") s.value += n;
  else if (s.type === "Gauge") s.value = n;
  else if (s.type === "Frequency") s.occurrences.set(globalThis.String(input), (s.occurrences.get(globalThis.String(input)) ?? 0) + 1);
  else {
    s.sum += n;
    s.value = n;
    s.min = Math.min(s.min, n);
    s.max = Math.max(s.max, n);
  }
};
export const update: { <In>(input: In): (self: Metric<In>) => I.Effect<void>; <In>(self: Metric<In>, input: In): I.Effect<void> } =
  I.dual(2, (self: Metric<any>, input: unknown) => I.make((f) => apply((I.lookup(f.context, MetricRegistry.key) as MetricRegistryImpl).stateOf(self), input)));
export const increment = (self: Metric<number>): I.Effect<void> => update(self, 1);
export const incrementBy: { (n: number): (self: Metric<number>) => I.Effect<void>; (self: Metric<number>, n: number): I.Effect<void> } = I.dual(2, (self: Metric<number>, n: number) => update(self, n));
export const set = update;
export const value = <In>(self: Metric<In>): I.Effect<MetricState> => I.make((f) => (I.lookup(f.context, MetricRegistry.key) as MetricRegistryImpl).stateOf(self));
export const withAttributes: {
  (attributes: Record<string, string>): <In, S>(self: Metric<In, S>) => Metric<In, S>;
  <In, S>(self: Metric<In, S>, attributes: Record<string, string>): Metric<In, S>;
} = I.dual(2, (self: Metric<any>, attributes: Record<string, string>) => ({ ...self, attributes: { ...self.attributes, ...attributes } }));
export const snapshot: I.Effect<ReadonlyArray<{ readonly metric: Metric<any>; readonly state: MetricState }>> =
  I.make((f) => [...(I.lookup(f.context, MetricRegistry.key) as MetricRegistryImpl).states.values()]);
/** Count each run of `effect` (or record its duration for timers). */
export const trackAll: { <In>(input: In): (self: Metric<In>) => <A, E, R>(effect: I.Effect<A, E, R>) => I.Effect<A, E, R> } =
  ((input: unknown) => (self: Metric<any>) => (effect: I.Effect<any, any, any>) => I.make((f) => I.chain(I.exec(effect, f), (a) => (apply((I.lookup(f.context, MetricRegistry.key) as MetricRegistryImpl).stateOf(self), input), a)))) as never;
