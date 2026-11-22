import { EqualSymbol, equals as eq, isEqual as isEq, type Equal as EqualT } from "./internal.ts";

export const symbol = EqualSymbol;
export type Equal = EqualT;
export const isEqual = isEq;
export const equals: { (that: unknown): (self: unknown) => boolean; (self: unknown, that: unknown): boolean } = function (this: unknown): any {
  if (arguments.length === 1) {
    const that = arguments[0];
    return (self: unknown) => eq(self, that);
  }
  return eq(arguments[0], arguments[1]);
} as never;
export const equivalence = <A>() => (a: A, b: A): boolean => eq(a, b);
