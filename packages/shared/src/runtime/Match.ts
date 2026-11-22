/** `Match.valueTags(value, { A: (a) => ..., B: (b) => ... })` and the data-last form. */
type Cases<I extends { readonly _tag: string }> = { readonly [K in I["_tag"]]: (a: Extract<I, { _tag: K }>) => any };
export const valueTags: {
  <const I extends { readonly _tag: string }, P extends Cases<I>>(input: I, cases: P): ReturnType<P[keyof P]>;
  <const I extends { readonly _tag: string }, P extends Cases<I>>(cases: P): (input: I) => ReturnType<P[keyof P]>;
} = function (a: any, b?: any): any {
  if (b === undefined) return (input: { _tag: string }) => a[input._tag](input);
  return b[a._tag](a);
} as never;
export const typeTags = <I extends { readonly _tag: string }>() => <P extends Cases<I>>(cases: P) => (input: I): ReturnType<P[keyof P]> => (cases as any)[input._tag](input);
