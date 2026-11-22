import type { ComposerDoc } from "./composer/types";
import type { DiffThemeName } from "~/lib/diffRendering";
import { languageOfInfoString } from "~/composer-code-languages";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";
import { highlighterLanguageOf } from "./chat/MarkdownCodeBlock.logic";

export interface CodeBlockHighlightSpan { readonly from: number; readonly to: number; readonly color: string }

export const MAX_HIGHLIGHTED_CODE_BLOCK_LENGTH = 20_000;
export const DEFERRED_HIGHLIGHT_CODE_BLOCK_LENGTH = 2_000;
export const DEFERRED_HIGHLIGHT_DELAY_MS = 300;
const NO_SPANS: ReadonlyArray<CodeBlockHighlightSpan> = [];

type Highlighter = Awaited<ReturnType<typeof getSyntaxHighlighterPromise>>;

export function tokenizeBlock(
  highlighter: Highlighter,
  code: string,
  language: string,
  theme: DiffThemeName,
): ReadonlyArray<CodeBlockHighlightSpan> {
  let tokens;
  try {
    tokens = highlighter.codeToTokens(code, { lang: language, theme }).tokens;
  } catch {
    return [];
  }
  const spans: CodeBlockHighlightSpan[] = [];
  let offset = 0;
  for (const [lineIndex, line] of tokens.entries()) {
    if (lineIndex > 0) offset += code.startsWith("\r\n", offset) ? 2 : 1;
    for (const token of line) {
      if (token.color && token.content.trim()) {
        spans.push({ from: offset, to: offset + token.content.length, color: token.color });
      }
      offset += token.content.length;
    }
  }
  return spans;
}

const signatureOf = (language: string, code: string, theme: DiffThemeName) => `${theme}\u0000${language}\u0000${code}`;

export interface ComposerCodeBlockHighlighter {
  readonly getSpans: (language: string, code: string) => ReadonlyArray<CodeBlockHighlightSpan>;
  readonly syncDoc: (doc: ComposerDoc, deferLong?: boolean) => void;
  readonly dispose: () => void;
}

export function createCodeBlockHighlighter(options: {
  resolveTheme: () => DiffThemeName;
  onUpdate: () => void;
}): ComposerCodeBlockHighlighter {
  const cache = new Map<string, ReadonlyArray<CodeBlockHighlightSpan>>();
  let live = new Set<string>();
  let disposed = false;
  let paintedTheme = options.resolveTheme();
  let lastDoc: ComposerDoc | null = null;
  let deferredTimer: ReturnType<typeof setTimeout> | undefined;

  const refresh = (doc: ComposerDoc, deferLong: boolean) => {
    if (disposed) return;
    const theme = options.resolveTheme();
    const themeChanged = theme !== paintedTheme;
    paintedTheme = theme;
    if (!themeChanged && doc === lastDoc) return;
    clearTimeout(deferredTimer);
    lastDoc = doc;

    const codeBlocks = doc.blocks.filter((b) => b.kind === "codeBlock");
    const signatures = new Set(codeBlocks.map((b) => signatureOf(b.language, b.code, theme)));
    live = signatures;
    for (const key of cache.keys()) if (!live.has(key)) cache.delete(key);

    const missing = codeBlocks.filter(
      (b) => b.code.length <= MAX_HIGHLIGHTED_CODE_BLOCK_LENGTH && !cache.has(signatureOf(b.language, b.code, theme)),
    );
    const pending =
      deferLong && !themeChanged
        ? missing.filter((b) => b.code.length <= DEFERRED_HIGHLIGHT_CODE_BLOCK_LENGTH)
        : missing;

    if (pending.length < missing.length) {
      deferredTimer = setTimeout(() => {
        lastDoc = null;
        refresh(doc, false);
      }, DEFERRED_HIGHLIGHT_DELAY_MS);
    }
    if (pending.length === 0) {
      if (themeChanged) options.onUpdate();
      return;
    }
    void Promise.allSettled(
      pending.map(async (b) => {
        const lang = highlighterLanguageOf(languageOfInfoString(b.language) || "text");
        const sig = signatureOf(b.language, b.code, theme);
        const hl = await getSyntaxHighlighterPromise(lang).catch(() => null);
        if (disposed || live !== signatures || cache.has(sig)) return;
        cache.set(sig, hl ? tokenizeBlock(hl, b.code, lang, theme) : []);
      }),
    ).then(() => {
      if (!disposed && live === signatures) options.onUpdate();
    });
  };

  let observer: MutationObserver | null = null;
  if (typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
    observer = new MutationObserver(() => {
      if (lastDoc) refresh(lastDoc, false);
    });
    observer.observe(document.documentElement, { attributeFilter: ["class"] });
  }

  return {
    getSpans: (lang, code) =>
      (code.length <= MAX_HIGHLIGHTED_CODE_BLOCK_LENGTH && cache.get(signatureOf(lang, code, options.resolveTheme()))) || NO_SPANS,
    syncDoc: (doc, deferLong = true) => refresh(doc, deferLong),
    dispose: () => {
      disposed = true;
      clearTimeout(deferredTimer);
      observer?.disconnect();
    },
  };
}
