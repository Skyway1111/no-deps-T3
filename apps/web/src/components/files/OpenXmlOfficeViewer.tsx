import { useStableCallback } from "~/hooks/useStableCallback";
import type { OfficePreviewKind } from "@t3tools/shared/filePreview";
import { msg, T, useGT } from "@t3tools/shared/i18n/react";
import { lazy, Suspense, useState } from "react";
import { m } from "~/i18n/messages";
import {
  FileSurfaceLoading,
  FileSurfaceNotice,
  FILE_SURFACE_SUBHEADER_CLASS,
} from "./fileSurfaceChrome";
import { OFFICE_PREVIEW_MAX_BYTES } from "./officePreviewProtocol";
import { previewErrorText } from "./previewFailureMessages";
const WordDocument = lazy(() => import("./office/WordDocument"));
const Spreadsheet = lazy(() => import("./office/Spreadsheet"));
const Presentation = lazy(() => import("./office/Presentation"));

export default function OfficeViewer(props: {
  readonly src: string;
  readonly name: string;
  readonly kind: Extract<OfficePreviewKind, "docx" | "xlsx" | "pptx">;
  readonly sizeBytes?: number;
}) {
  const gt = useGT();
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState({ text: "", truncated: false });
  const fail = useStableCallback((cause: unknown) =>
    setError(previewErrorText(cause, m(msg("Could not render this Office document.")))),
  );
  const onDetails = useStableCallback((text: string, truncated: boolean) =>
    setDetails({ text, truncated }),
  );
  // Metadata bounds are checked before fetching or starting an engine.
  const message =
    (props.sizeBytes ?? 0) > OFFICE_PREVIEW_MAX_BYTES
      ? m(msg("Preview limited to files under 50 MB."))
      : error;
  if (message)
    return (
      <div
        role="alert"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center"
      >
        <p className="text-sm font-medium">
          <T>No preview for this file</T>
        </p>
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
          {gt("{error} Save it or open it in another app.", { error: message })}
        </p>
      </div>
    );
  const Viewer =
    props.kind === "docx" ? WordDocument : props.kind === "xlsx" ? Spreadsheet : Presentation;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {details.text ? (
        <div className={FILE_SURFACE_SUBHEADER_CLASS}>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {details.text}
            {props.kind !== "xlsx" ? ` · ${gt("Fit to width")}` : ""}
          </span>
        </div>
      ) : null}
      {details.truncated ? (
        <FileSurfaceNotice>
          <T>Preview limited. Save it or open it in another app to read the full document.</T>
        </FileSurfaceNotice>
      ) : null}
      <Suspense fallback={<FileSurfaceLoading />}>
        <Viewer src={props.src} onDetails={onDetails} onError={fail} />
      </Suspense>
    </div>
  );
}
