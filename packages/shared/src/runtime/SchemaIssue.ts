import * as O from "./Option.ts";
import { safeJson } from "./internal.ts";

export const TypeId: unique symbol = Symbol.for("effect/SchemaIssue") as never;
export interface IssueAnnotations {
  readonly message?: string | undefined;
  readonly expected?: string | undefined;
  readonly [k: string]: unknown;
}
type AnyAst = { readonly _tag: string; readonly annotations?: Record<string, unknown> | undefined; describe?: () => string };

abstract class Base {
  readonly [TypeId]: typeof TypeId = TypeId;
  abstract readonly _tag: string;
  input?: unknown;
  toString(this: Issue): string {
    return format(this);
  }
}
const withInput = <T extends Base>(issue: T, input: unknown, hasInput: boolean): T => {
  if (hasInput) issue.input = input;
  return issue;
};
export class InvalidType extends Base {
  readonly _tag = "InvalidType";
  readonly ast: AnyAst;
  constructor(ast: AnyAst, input?: unknown) {
    super();
    this.ast = ast;
    withInput(this, input, arguments.length > 1);
  }
}
export class InvalidValue extends Base {
  readonly _tag = "InvalidValue";
  readonly annotations: IssueAnnotations | undefined;
  constructor(annotations?: IssueAnnotations, input?: unknown) {
    super();
    this.annotations = annotations;
    withInput(this, input, arguments.length > 1);
  }
}
export class MissingKey extends Base {
  readonly _tag = "MissingKey";
  readonly annotations: IssueAnnotations | undefined;
  constructor(annotations?: IssueAnnotations) {
    super();
    this.annotations = annotations;
  }
}
export class UnexpectedKey extends Base {
  readonly _tag = "UnexpectedKey";
  readonly ast: AnyAst;
  constructor(ast: AnyAst, input?: unknown) {
    super();
    this.ast = ast;
    withInput(this, input, arguments.length > 1);
  }
}
export class Forbidden extends Base {
  readonly _tag = "Forbidden";
  readonly annotations: IssueAnnotations | undefined;
  constructor(annotations?: IssueAnnotations, input?: unknown) {
    super();
    this.annotations = annotations;
    withInput(this, input, arguments.length > 1);
  }
}
export class OneOf extends Base {
  readonly _tag = "OneOf";
  readonly ast: AnyAst;
  readonly successes: ReadonlyArray<AnyAst>;
  constructor(ast: AnyAst, successes: ReadonlyArray<AnyAst>, input?: unknown) {
    super();
    this.ast = ast;
    this.successes = successes;
    withInput(this, input, arguments.length > 2);
  }
}
export class Filter extends Base {
  readonly _tag = "Filter";
  readonly filter: { readonly annotations?: IssueAnnotations | undefined };
  readonly issue: Issue;
  constructor(filter: { readonly annotations?: IssueAnnotations | undefined }, issue: Issue, input?: unknown) {
    super();
    this.filter = filter;
    this.issue = issue;
    withInput(this, input, arguments.length > 2);
  }
}
export class Encoding extends Base {
  readonly _tag = "Encoding";
  readonly ast: AnyAst;
  readonly issue: Issue;
  constructor(ast: AnyAst, issue: Issue, input?: unknown) {
    super();
    this.ast = ast;
    this.issue = issue;
    withInput(this, input, arguments.length > 2);
  }
}
export class Pointer extends Base {
  readonly _tag = "Pointer";
  readonly path: ReadonlyArray<PropertyKey>;
  readonly issue: Issue;
  constructor(path: ReadonlyArray<PropertyKey>, issue: Issue) {
    super();
    this.path = path;
    this.issue = issue;
  }
}
export class Composite extends Base {
  readonly _tag = "Composite";
  readonly ast: AnyAst;
  readonly issues: readonly [Issue, ...Array<Issue>];
  constructor(ast: AnyAst, issues: readonly [Issue, ...Array<Issue>], input?: unknown) {
    super();
    this.ast = ast;
    this.issues = issues;
    withInput(this, input, arguments.length > 2);
  }
}
export class AnyOf extends Base {
  readonly _tag = "AnyOf";
  readonly ast: AnyAst;
  readonly issues: ReadonlyArray<Issue>;
  constructor(ast: AnyAst, issues: ReadonlyArray<Issue>, input?: unknown) {
    super();
    this.ast = ast;
    this.issues = issues;
    withInput(this, input, arguments.length > 2);
  }
}
export type Leaf = InvalidType | InvalidValue | MissingKey | UnexpectedKey | Forbidden | OneOf;
export type Issue = Leaf | Filter | Encoding | Pointer | Composite | AnyOf;
export const isIssue = (u: unknown): u is Issue => typeof u === "object" && u !== null && TypeId in u;

export const formatValue = (u: unknown): string => {
  if (typeof u === "string") return JSON.stringify(u);
  if (typeof u === "bigint") return `${u}n`;
  if (u === undefined) return "undefined";
  if (typeof u === "function") return "<function>";
  if (u instanceof Date) return u.toISOString();
  const s = safeJson(u);
  return s.length > 200 ? `${s.slice(0, 197)}...` : s;
};
const describe = (ast: AnyAst): string =>
  (ast.annotations?.expected as string | undefined) ?? (ast.annotations?.identifier as string | undefined) ?? ast.describe?.() ?? ast._tag;
/** Matches effect's default formatter, which does not print the actual value. */
const got = (_issue: Base) => "";
const leafMessage = (issue: Issue): string => {
  switch (issue._tag) {
    case "InvalidType":
      return (issue.ast.annotations?.message as string | undefined) ?? `Expected ${describe(issue.ast)}${got(issue)}`;
    case "InvalidValue":
      return issue.annotations?.message ?? (issue.annotations?.expected ? `Expected ${issue.annotations.expected}${got(issue)}` : `Invalid data${got(issue)}`);
    case "MissingKey":
      return issue.annotations?.messageMissingKey as string | undefined ?? "Missing key";
    case "UnexpectedKey":
      return "Unexpected key";
    case "Forbidden":
      return issue.annotations?.message ?? "Forbidden operation";
    case "OneOf":
      return `Expected exactly one member to match the input${got(issue)}`;
    case "Filter":
      return (issue.filter.annotations?.message as string | undefined) ?? leafMessage(issue.issue);
    case "Encoding":
      return leafMessage(issue.issue);
    default:
      return "";
  }
};
/** Flatten an issue tree into `[path, message]` pairs. */
export const flatten = (issue: Issue, path: ReadonlyArray<PropertyKey> = []): Array<{ path: ReadonlyArray<PropertyKey>; message: string; issue: Issue }> => {
  switch (issue._tag) {
    case "Pointer":
      return flatten(issue.issue, [...path, ...issue.path]);
    case "Composite":
      return issue.issues.flatMap((i) => flatten(i, path));
    case "AnyOf":
      if (issue.issues.length === 0) return [{ path, message: `Expected ${describe(issue.ast)}${got(issue)}`, issue }];
      return issue.issues.flatMap((i) => flatten(i, path));
    case "Filter":
      if (issue.filter.annotations?.message) return [{ path, message: issue.filter.annotations.message as string, issue }];
      if (issue.issue._tag === "InvalidValue" && !issue.issue.annotations?.message && issue.filter.annotations?.expected)
        return [{ path, message: `Expected ${issue.filter.annotations.expected}${got(issue)}`, issue }];
      return flatten(issue.issue, path);
    case "Encoding":
      return flatten(issue.issue, path);
    default:
      return [{ path, message: leafMessage(issue), issue }];
  }
};
const formatPath = (path: ReadonlyArray<PropertyKey>) => path.map((p) => `[${typeof p === "symbol" ? String(p) : JSON.stringify(p)}]`).join("");
export const format = (issue: Issue): string =>
  flatten(issue).map(({ path, message }) => (path.length ? `${message}\n  at ${formatPath(path)}` : message)).join("\n");
export const getActual = (issue: Issue): O.Option<unknown> => ("input" in issue ? O.some(issue.input) : O.none());
export interface Formatter<Out> {
  readonly format: (issue: Issue) => Out;
}
export const makeFormatterDefault = (): Formatter<string> => ({ format });
export const makeFormatterStandardSchemaV1 = (): Formatter<{ readonly issues: ReadonlyArray<{ message: string; path: ReadonlyArray<PropertyKey> }> }> => ({
  format: (issue) => ({ issues: flatten(issue).map(({ path, message }) => ({ path, message })) }),
});
export const defaultLeafHook = leafMessage;
