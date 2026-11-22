/* oxlint-disable react/no-unstable-nested-components -- These callbacks return overlays, and are invoked as render functions. */
import { msg, T, useGT } from "@t3tools/shared/i18n/react";
import { useRef, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "~/ui-core/icons";
import {
  FileSurfaceAction,
  FileSurfaceLoading,
  FILE_SURFACE_SUBHEADER_CLASS,
} from "../fileSurfaceChrome";
import { OfficePages, type PaintPage } from "./OfficePages";
import { FrameText, paintFrame, useOfficeDocument, type OfficeEngine } from "./office-frames";
import { useStableCallback } from "~/hooks/useStableCallback";
import { m } from "~/i18n/messages";

const openPresentation = async (engine: OfficeEngine, bytes: ArrayBuffer, signal: AbortSignal) => {
  const model = await engine.call("pptx", { bytes }, { transfer: [bytes], signal });
  if (model.slides.length === 0 || model.slides.length > 500)
    throw new Error(m(msg("Preview limited to presentations with 1 to 500 slides.")));
  return model;
};
const describe = (model: { slides: readonly unknown[] }) =>
  m(
    msg("{count, plural, one {{count} slide} other {{count} slides}}", {
      count: model.slides.length,
    }),
  );

export default function Presentation(props: {
  src: string;
  onDetails: (text: string, truncated: boolean) => void;
  onError: (cause: unknown) => void;
}) {
  const { onError, src, onDetails } = props;
  const gt = useGT();
  const [page, setPage] = useState(0);
  const scroll = useRef<((index: number, y?: number) => void) | null>(null);
  const opened = useOfficeDocument(src, openPresentation, describe, onDetails, onError);
  // One identity for the document's life, so re-rendering the page indicator repaints nothing.
  const paint: PaintPage = useStableCallback(async (index, canvas, scale) => {
    const frame = opened?.model.slides[index];
    if (frame) paintFrame(canvas, frame, opened.images, scale * (window.devicePixelRatio || 1));
  });

  if (!opened) return <FileSurfaceLoading />;
  const slides = opened.model.slides;
  const select = (index: number) => {
    setPage(index);
    scroll.current?.(index);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={FILE_SURFACE_SUBHEADER_CLASS}>
        <FileSurfaceAction
          label={gt("Previous slide")}
          disabled={page === 0}
          onPress={() => select(page - 1)}
        >
          <ChevronLeftIcon className="size-3.5" />
        </FileSurfaceAction>
        <span className="flex-1 text-center text-xs tabular-nums" aria-live="polite">
          {gt("Slide {page} of {count}", {
            page: String(page + 1),
            count: String(slides.length),
          })}
        </span>
        <FileSurfaceAction
          label={gt("Next slide")}
          disabled={page + 1 === slides.length}
          onPress={() => select(page + 1)}
        >
          <ChevronRightIcon className="size-3.5" />
        </FileSurfaceAction>
      </div>
      <OfficePages
        pages={slides}
        paint={paint}
        kind="slide"
        scrollRef={scroll}
        onPageChange={setPage}
        onError={onError}
        overlay={(index) => (
          <>
            <FrameText frame={slides[index]!} />
            {slides[index]?.hidden ? (
              <div className="pointer-events-none absolute inset-0 bg-white/50" />
            ) : null}
          </>
        )}
        footer={(index) => {
          const slide = slides[index];
          return slide?.notes || slide?.hidden ? (
            <div className="space-y-1 text-xs text-muted-foreground">
              {slide.hidden ? (
                <p>
                  <T>Hidden slide</T>
                </p>
              ) : null}
              {slide.notes ? (
                <p
                  role="note"
                  aria-label={gt("Speaker notes")}
                  className="select-text whitespace-pre-wrap break-words"
                >
                  {slide.notes}
                </p>
              ) : null}
            </div>
          ) : null;
        }}
      />
    </div>
  );
}
