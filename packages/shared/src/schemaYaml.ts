import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import {
  YamlError,
  parseYaml as parseYamlString,
  stringifyYaml as stringifyYamlValue,
} from "./parsers/yaml.ts";

function parseYaml<E extends string>(): SchemaGetter.Getter<unknown, E> {
  return SchemaGetter.transformEffect((input: E) =>
    Effect.try({
      try: () => parseYamlString(input),
      // YamlError messages carry a position, never source text.
      catch: (error) =>
        new SchemaIssue.InvalidValue({
          message: error instanceof YamlError ? error.message : "Invalid YAML.",
        }),
    }),
  );
}

function stringifyYaml(): SchemaGetter.Getter<string, unknown> {
  return SchemaGetter.transformEffect((input: unknown) =>
    Effect.try({
      try: () => stringifyYamlValue(input),
      catch: () => new SchemaIssue.InvalidValue({ message: "Failed to stringify YAML." }),
    }),
  );
}

const fromYamlString = new SchemaTransformation.Transformation<unknown, string>(
  parseYaml(),
  stringifyYaml(),
);

export const fromYaml = <S extends Schema.Top>(schema: S) =>
  Schema.String.pipe(Schema.decodeTo(schema, fromYamlString));
