import {
  embeddedScripts,
  withEmbeddedScripts,
  type SyntaxToken,
} from "@t3tools/client-runtime/work-log/embedded-scripts";
import { isKnownLanguage, tokenizeCompact, type CompactTokens } from "@t3tools/shared/highlight";

export type HighlightScheme = "light" | "dark";

export interface HighlightedToken {
  readonly content: string;
  readonly color: string | null;
  readonly fontStyle: number | null;
}

export type HighlightedLines = ReadonlyArray<ReadonlyArray<HighlightedToken>>;

// t3-light darkens pierre-light until every color reads on light diff surfaces, as on web.
const THEMES = { light: "t3-light", dark: "pierre-dark" } as const;

export interface TokenizedCode {
  /** Retained UTF-16 source, compact records, and line indexes. */
  readonly byteLength: number;
  readonly lineCount: number;
  readonly highlightLine: (
    index: number,
    scheme: HighlightScheme,
  ) => ReadonlyArray<HighlightedToken> | undefined;
}

/** Keep records compact; expand only lines a client will display. */
export function tokenizeCode(code: string, language: string): TokenizedCode {
  const tokens: CompactTokens = tokenizeCompact(code, language);
  return {
    byteLength: tokens.byteLength,
    lineCount: tokens.lineCount,
    highlightLine: (index, scheme) => tokens.highlightLine(index, THEMES[scheme]),
  };
}

/** Shell commands also color the scripts they embed, such as heredocs and `python -c`. */
export function highlightCommand(
  code: string,
  language: "shellscript" | "powershell",
  scheme: HighlightScheme,
): HighlightedLines {
  const tokenize = (text: string, lang: string) => {
    // A missing grammar keeps the shell colors, as on web.
    if (!isKnownLanguage(lang)) throw new Error(`No grammar for ${lang}`);
    return withOffsets(text, highlightCode(text, lang, scheme));
  };
  const embedded = language === "shellscript" ? embeddedScripts(code) : [];
  return withEmbeddedScripts(code, tokenize(code, language), embedded, tokenize).map((line) =>
    line.map((token) => ({
      content: token.content,
      color: token.color ?? null,
      fontStyle: token.fontStyle ?? null,
    })),
  );
}

function withOffsets(code: string, lines: HighlightedLines): SyntaxToken[][] {
  const endings = code.match(/\r?\n/gu) ?? [];
  let offset = 0;
  return lines.map((line, index) => {
    const tokens = line.map((token) => {
      const start = offset;
      offset += token.content.length;
      return {
        content: token.content,
        offset: start,
        ...(token.color ? { color: token.color } : {}),
        ...(token.fontStyle ? { fontStyle: token.fontStyle } : {}),
      };
    });
    offset += endings[index]?.length ?? 0;
    return tokens;
  });
}

/** LF and CRLF split lines; a trailing line break yields a final empty line. */
export function highlightCode(
  code: string,
  language: string,
  scheme: HighlightScheme,
): HighlightedLines {
  const source = tokenizeCode(code, language);
  return Array.from({ length: source.lineCount }, (_, index) =>
    source.highlightLine(index, scheme)!,
  );
}
