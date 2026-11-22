import { useGT } from "@t3tools/shared/i18n/react";
import type { CSSProperties, Ref } from "react";

import { cn } from "~/lib/utils";
import { CodeView } from "~/ui-core/codeView/CodeView";
import type { CodeViewHandle, CodeViewOptions, CodeViewProps } from "~/ui-core/codeView/types";

import "./diffSurfaceTheme";

export type StyledDiffCodeViewOptions<LAnnotation> = CodeViewOptions<LAnnotation>;

type StyledDiffCodeViewProps<LAnnotation> = Omit<CodeViewProps<LAnnotation>, "ref"> & {
  readonly viewerRef?: Ref<CodeViewHandle<LAnnotation>>;
  /** For hosts that show their own line counts in `renderHeaderMetadata`. */
  readonly hideLineCounts?: boolean;
};

/** The app's diff surface: a `CodeView` themed by the `.diff-render-surface` rules in index.css. */
export function StyledDiffCodeView<LAnnotation = undefined>({
  viewerRef,
  className,
  hideLineCounts,
  style,
  ...props
}: StyledDiffCodeViewProps<LAnnotation>) {
  const gt = useGT();
  return (
    <CodeView<LAnnotation>
      {...props}
      {...(viewerRef ? { ref: viewerRef } : {})}
      className={cn(
        "diff-render-surface [--code-background:var(--background)] outline-none",
        hideLineCounts && "[&_:is([data-additions-count],[data-deletions-count])]:hidden",
        className,
      )}
      style={
        {
          // The change bars are colour alone; these name each changed line for screen readers.
          "--diffs-removed-label": JSON.stringify(
            gt("Removed", { $context: "diff line, read by screen readers" }),
          ),
          "--diffs-added-label": JSON.stringify(
            gt("Added", { $context: "diff line, read by screen readers" }),
          ),
          ...style,
        } as CSSProperties
      }
    />
  );
}
