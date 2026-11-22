export interface NativeReviewDiffSource {
  readonly oldContents: string;
  readonly newContents: string;
}

export interface NativeReviewDiffFile {
  readonly id: string;
  readonly path: string;
  /** A lexer name from @t3tools/shared/highlight. */
  readonly language: string;
  readonly additions: number;
  readonly deletions: number;
  readonly loadContents?: (signal?: AbortSignal) => Promise<NativeReviewDiffSource | null>;
}
