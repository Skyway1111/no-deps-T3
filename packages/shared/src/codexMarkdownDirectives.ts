import {
  codexArtifactTemplatePresentationLabel,
  resolveCodexArtifactTemplate,
  type CodexArtifactTemplate,
} from "./codexArtifactTemplates.ts";
import { codexFileCitationMarkdown, resolveCodexFileCitationLink } from "./codexFileCitations.ts";
import { extractCodexDirectives, type ExtractedCodexDirective } from "./markdown/index.ts";

export { extractCodexDirectives, type ExtractedCodexDirective };

const CODEX_FILE_CITATION_NAME = "codex-file-citation";
const CODEX_FOLLOW_UP_NAME = "codex-followup";
const CODEX_ARTIFACT_TEMPLATE_NAME = "artifact-template";

export type CodexArtifactTemplateMarkdownSegment =
  | { readonly kind: "markdown"; readonly markdown: string; readonly sourceOffset: number }
  | {
      readonly kind: "artifact-template";
      readonly sourceOffset: number;
      readonly template: CodexArtifactTemplate;
    };

function replaceDirectives(
  markdown: string,
  replacementFor: (directive: ExtractedCodexDirective) => string | undefined,
): string {
  const matches = extractCodexDirectives(markdown);
  if (matches.length === 0) return markdown;
  let rendered = markdown;
  for (const match of matches.sort((left, right) => right.start - left.start)) {
    const replacement = replacementFor(match);
    if (replacement !== undefined) {
      rendered = rendered.slice(0, match.start) + replacement + rendered.slice(match.end);
    }
  }
  return rendered;
}

function inlineDirectiveReplacement(directive: ExtractedCodexDirective): string | undefined {
  if (directive.name === CODEX_FILE_CITATION_NAME) {
    const citation = directive.inLink ? null : resolveCodexFileCitationLink(directive.attributes);
    return citation ? codexFileCitationMarkdown(citation) : undefined;
  }
  if (directive.name === CODEX_FOLLOW_UP_NAME) {
    return directive.attributes.prompt?.trim() && directive.label.trim()
      ? directive.label
      : undefined;
  }
  return undefined;
}

export function renderCodexInlineDirectivesAsMarkdown(markdown: string): string {
  if (
    !markdown.includes(`:${CODEX_FILE_CITATION_NAME}`) &&
    !markdown.includes(`:${CODEX_FOLLOW_UP_NAME}`)
  ) {
    return markdown;
  }
  return replaceDirectives(markdown, inlineDirectiveReplacement);
}

export function renderCodexDirectivesForCopy(markdown: string): string {
  if (
    !markdown.includes(`:${CODEX_FILE_CITATION_NAME}`) &&
    !markdown.includes(`:${CODEX_FOLLOW_UP_NAME}`) &&
    !markdown.includes(`::${CODEX_ARTIFACT_TEMPLATE_NAME}`)
  ) {
    return markdown;
  }
  return replaceDirectives(markdown, (directive) => {
    if (directive.name !== CODEX_ARTIFACT_TEMPLATE_NAME) {
      return inlineDirectiveReplacement(directive);
    }
    const template = resolveCodexArtifactTemplate(directive.attributes);
    return template
      ? `${template.displayName} (${codexArtifactTemplatePresentationLabel(template.artifactKind)})`
      : undefined;
  });
}

export function splitCodexArtifactTemplateMarkdown(
  markdown: string,
): ReadonlyArray<CodexArtifactTemplateMarkdownSegment> {
  if (!markdown.includes(`::${CODEX_ARTIFACT_TEMPLATE_NAME}`)) {
    return [{ kind: "markdown", markdown, sourceOffset: 0 }];
  }

  const templates = extractCodexDirectives(markdown)
    .flatMap((directive) => {
      if (directive.name !== CODEX_ARTIFACT_TEMPLATE_NAME) return [];
      const template = resolveCodexArtifactTemplate(directive.attributes);
      return template ? [{ start: directive.start, end: directive.end, template }] : [];
    })
    .sort((left, right) => left.start - right.start);

  if (templates.length === 0) {
    return [{ kind: "markdown", markdown, sourceOffset: 0 }];
  }

  const segments: CodexArtifactTemplateMarkdownSegment[] = [];
  let cursor = 0;
  for (const match of templates) {
    if (match.start > cursor) {
      segments.push({
        kind: "markdown",
        markdown: markdown.slice(cursor, match.start),
        sourceOffset: cursor,
      });
    }
    segments.push({
      kind: "artifact-template",
      sourceOffset: match.start,
      template: match.template,
    });
    cursor = match.end;
  }
  if (cursor < markdown.length) {
    segments.push({ kind: "markdown", markdown: markdown.slice(cursor), sourceOffset: cursor });
  }
  return segments;
}
