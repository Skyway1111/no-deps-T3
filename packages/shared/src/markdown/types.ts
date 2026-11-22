import type { CodexArtifactTemplate } from "../codexArtifactTemplates.ts";

export interface SourcePoint {
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}

export interface SourcePosition {
  readonly start: SourcePoint;
  readonly end: SourcePoint;
}

export interface MdRoot {
  readonly type: "root";
  children: MdNode[];
  readonly definitions?: ReadonlyMap<string, MdDefinition>;
  readonly footnotes?: ReadonlyMap<string, MdFootnoteDefinition>;
  readonly position?: SourcePosition;
}

export interface MdParagraph {
  readonly type: "paragraph";
  children: MdNode[];
  readonly position?: SourcePosition;
}

export interface MdHeading {
  readonly type: "heading";
  readonly depth: 1 | 2 | 3 | 4 | 5 | 6;
  children: MdNode[];
  readonly position?: SourcePosition;
}

export interface MdBlockquote {
  readonly type: "blockquote";
  alert?: string;
  children: MdNode[];
  readonly position?: SourcePosition;
}

export interface MdList {
  readonly type: "list";
  readonly ordered: boolean;
  readonly start?: number | null;
  readonly spread: boolean;
  children: MdListItem[];
  readonly position?: SourcePosition;
}

export interface MdListItem {
  readonly type: "listItem";
  readonly checked?: boolean | null;
  readonly spread: boolean;
  value?: number;
  children: MdNode[];
  readonly position?: SourcePosition;
}

export interface MdCode {
  readonly type: "code";
  readonly lang?: string | null;
  readonly meta?: string | null;
  readonly value: string;
  readonly fenced?: boolean;
  readonly closed?: boolean;
  readonly position?: SourcePosition;
}

export interface MdHtml {
  readonly type: "html";
  readonly value: string;
  readonly block?: boolean;
  readonly position?: SourcePosition;
}

export interface MdThematicBreak {
  readonly type: "thematicBreak";
  readonly position?: SourcePosition;
}

export interface MdTable {
  readonly type: "table";
  readonly align: ReadonlyArray<"left" | "center" | "right" | null>;
  children: MdTableRow[];
  readonly position?: SourcePosition;
}

export interface MdTableRow {
  readonly type: "tableRow";
  children: MdTableCell[];
  readonly position?: SourcePosition;
}

export interface MdTableCell {
  readonly type: "tableCell";
  children: MdNode[];
  readonly position?: SourcePosition;
}

export interface MdDefinition {
  readonly type: "definition";
  readonly identifier: string;
  readonly label: string;
  readonly url: string;
  readonly title?: string | null;
  readonly position?: SourcePosition;
}

export interface MdFootnoteDefinition {
  readonly type: "footnoteDefinition";
  readonly identifier: string;
  readonly label: string;
  children: MdNode[];
  readonly position?: SourcePosition;
}

export interface MdMath {
  readonly type: "math";
  readonly value: string;
  readonly position?: SourcePosition;
}

export interface MdInlineMath {
  readonly type: "inlineMath";
  readonly value: string;
  readonly display?: boolean;
  readonly data?: { readonly hProperties?: { readonly className?: string[] } };
  readonly position?: SourcePosition;
}

export interface MdText {
  readonly type: "text";
  value: string;
  readonly position?: SourcePosition;
}

export interface MdInlineCode {
  readonly type: "inlineCode";
  readonly value: string;
  readonly position?: SourcePosition;
}

export interface MdEmphasis {
  readonly type: "emphasis";
  children: MdNode[];
  readonly position?: SourcePosition;
}

export interface MdStrong {
  readonly type: "strong";
  children: MdNode[];
  readonly position?: SourcePosition;
}

export interface MdDelete {
  readonly type: "delete";
  children: MdNode[];
  readonly position?: SourcePosition;
}

export interface MdLink {
  readonly type: "link";
  url: string;
  readonly title?: string | null;
  readonly autolink?: boolean;
  children: MdNode[];
  readonly position?: SourcePosition;
}

export interface MdLinkReference {
  readonly type: "linkReference";
  readonly identifier: string;
  readonly label: string;
  children: MdNode[];
  readonly position?: SourcePosition;
}

export interface MdImage {
  readonly type: "image";
  readonly url: string;
  readonly alt: string;
  readonly title?: string | null;
  readonly position?: SourcePosition;
}

export interface MdImageReference {
  readonly type: "imageReference";
  readonly identifier: string;
  readonly label: string;
  readonly alt: string;
  readonly position?: SourcePosition;
}

export interface MdFootnoteReference {
  readonly type: "footnoteReference";
  readonly identifier: string;
  readonly label: string;
  readonly position?: SourcePosition;
}

export interface MdBreak {
  readonly type: "break";
  readonly position?: SourcePosition;
}

export interface MdLeadingWhitespace {
  readonly type: "leadingWhitespace";
  readonly value: string;
  readonly position?: SourcePosition;
}

export interface MdDirective {
  readonly type: "directive";
  readonly kind: "text" | "leaf";
  readonly name: string;
  readonly label: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly template?: CodexArtifactTemplate;
  children: MdNode[];
  readonly position?: SourcePosition;
}

export type MdNode =
  | MdRoot
  | MdParagraph
  | MdHeading
  | MdBlockquote
  | MdList
  | MdListItem
  | MdCode
  | MdHtml
  | MdThematicBreak
  | MdTable
  | MdTableRow
  | MdTableCell
  | MdDefinition
  | MdFootnoteDefinition
  | MdMath
  | MdInlineMath
  | MdText
  | MdInlineCode
  | MdEmphasis
  | MdStrong
  | MdDelete
  | MdLink
  | MdLinkReference
  | MdImage
  | MdImageReference
  | MdFootnoteReference
  | MdBreak
  | MdLeadingWhitespace
  | MdDirective;

export type ElProperties = Record<string, unknown>;

export interface ElText {
  type: "text";
  value: string;
  position?: SourcePosition;
}

export interface ElElement {
  type: "element";
  tagName: string;
  properties: ElProperties;
  children: ElContent[];
  position?: SourcePosition;
}

export type ElContent = ElElement | ElText;

export interface ElRoot {
  type: "root";
  children: ElContent[];
  position?: SourcePosition;
}

export type ElNode = ElRoot | ElContent;

export interface TextAutolink {
  readonly index: number;
  readonly text: string;
  readonly label: string;
  readonly url: string;
  readonly kind: string;
}

export interface ParseOptions {
  readonly gfm?: boolean;
  readonly singleTilde?: boolean;
  readonly math?: boolean;
  readonly directives?: boolean;
  readonly insights?: boolean;
  readonly windowsPaths?: boolean;
  readonly windowsProsePathsOnly?: boolean;
  readonly githubAlerts?: boolean;
  readonly normalizeListIndentation?: boolean;
  readonly keepOrderedListNumbers?: boolean;
  readonly leadingWhitespace?: boolean;
  readonly leadingWhitespaceIndent?: number;
  readonly autolinkBoundaries?: boolean;
}

export interface EmitOptions {
  readonly breaks?: boolean;
  readonly math?: boolean;
  readonly escapeHtml?: boolean;
  readonly skipHtml?: boolean;
  readonly sanitize?: boolean;
  readonly linkFilePaths?: boolean;
  readonly breakAroundImageLines?: boolean;
  readonly tagInlineCode?: boolean;
  readonly normalizeWindowsLinks?: boolean;
  readonly preserveImageMeta?: boolean;
  readonly normalizeLocalEditorLinks?: boolean;
  readonly resolveMediaUrl?: ((src: string) => string) | undefined;
  readonly textAutolinks?: ((text: string) => ReadonlyArray<TextAutolink>) | null | undefined;
  readonly transformText?: ((text: string) => string) | undefined;
  readonly rawHtmlAsText?: boolean;
  readonly source?: string;
}
