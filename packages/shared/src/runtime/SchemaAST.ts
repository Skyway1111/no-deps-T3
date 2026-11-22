import { nodeOf, Node, type Top } from "./Schema.ts";

export type AST = Node;
export { Node };
const tagged = (tag: string) => (ast: AST): boolean => ast._tag === tag;
export interface PropertySignature {
  readonly name: PropertyKey;
  readonly type: AST;
}
export interface IndexSignature {
  readonly parameter: AST;
  readonly type: AST;
}
export interface Objects extends Node {
  readonly propertySignatures: ReadonlyArray<PropertySignature>;
  readonly indexSignatures: ReadonlyArray<IndexSignature>;
}
export interface Literal extends Node {
  readonly literal: string | number | boolean | bigint | null | undefined;
}
export const isObjects = (ast: AST): ast is Objects => ast._tag === "Objects";
export const isArrays = tagged("Arrays");
export const isUnion = tagged("Union");
export const isSuspend = tagged("Suspend");
export const isLiteral = (ast: AST): ast is Literal => ast._tag === "Literal";
export const isDeclaration = tagged("Declaration");
export const isString = tagged("String");
export const isNumber = tagged("Number");
export const isBoolean = tagged("Boolean");
export const resolveTitle = (ast: AST): string | undefined => ast.annotations?.title;
export const resolveDescription = (ast: AST): string | undefined => ast.annotations?.description;
export const resolveIdentifier = (ast: AST): string | undefined => ast.annotations?.identifier;
export const toEncoded = (ast: AST): AST => ((ast as unknown as { fromN?: AST }).fromN ? toEncoded((ast as unknown as { fromN: AST }).fromN) : ast);
export const toType = (ast: AST): AST => ((ast as unknown as { toN?: AST }).toN ? toType((ast as unknown as { toN: AST }).toN) : ast);
export const getAST = (s: Top): AST => nodeOf(s);
export interface ParseOptions {
  readonly errors?: "first" | "all";
  readonly onExcessProperty?: "ignore" | "error" | "preserve";
}
export interface Filter<_T> {
  readonly annotations?: Record<string, unknown>;
}
