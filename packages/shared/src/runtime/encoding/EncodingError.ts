import { TaggedError } from "../errors.ts";

export class EncodingError extends TaggedError("EncodingError")<{ readonly kind: "Decode" | "Encode"; readonly module: string; readonly input: unknown; readonly message: string }> {}
export const isEncodingError = (u: unknown): u is EncodingError => u instanceof EncodingError;
