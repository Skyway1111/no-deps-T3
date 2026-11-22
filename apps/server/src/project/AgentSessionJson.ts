import { createStreamJsonReader, type JsonPath } from "@t3tools/shared/core/streamJson";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";

export function createTranscriptJsonSelector(schema: { readonly ast: SchemaAST.AST }) {
  const ast = SchemaAST.toEncoded(schema.ast);
  const includes = (node: SchemaAST.AST, path: JsonPath, index: number): boolean => {
    if (index === path.length) return true;
    switch (node._tag) {
      case "Objects":
        if (node.indexSignatures.length > 0) return true;
        return node.propertySignatures.some(
          (property) =>
            String(property.name) === path[index] && includes(property.type, path, index + 1),
        );
      case "Arrays": {
        const key = path[index];
        if (typeof key !== "number") return true;
        const element = node.elements[key];
        if (element) return includes(element, path, index + 1);
        return node.rest.length === 0 || node.rest.some((item) => includes(item, path, index + 1));
      }
      case "Union":
        return node.types.some((type) => includes(type, path, index));
      case "Suspend":
        return includes(node.thunk(), path, index);
      case "Unknown":
      case "Any":
      case "ObjectKeyword":
      case "Declaration":
        return true;
      default:
        return false;
    }
  };
  return (path: JsonPath) => includes(ast, path, 0);
}

export class TranscriptJsonLimitError extends Schema.TaggedError<TranscriptJsonLimitError>()(
  "TranscriptJsonLimitError",
  { message: Schema.String },
) {}

export function createTranscriptJsonReader(
  reserve: (bytes: number) => void,
  selectPath: (path: JsonPath) => boolean,
  options?: { readonly maxDepth?: number },
) {
  const reader = createStreamJsonReader({
    reserve,
    selectPath,
    maxDepth: options?.maxDepth ?? 128,
    onDepthLimit: () => {
      throw new TranscriptJsonLimitError({
        message: "Transcript JSON nesting exceeds the depth limit",
      });
    },
  });
  return {
    write: (chunk: string) => reader.write(chunk),
    finish: (): unknown => reader.finish(),
  };
}
