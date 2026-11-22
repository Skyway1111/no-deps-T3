/* oxlint-disable react/no-unstable-nested-components -- The overlay callback is a render function, not a component. */
import { msg } from "@t3tools/shared/i18n/react";
import { useRef } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import { m } from "~/i18n/messages";
import { FileSurfaceLoading } from "../fileSurfaceChrome";
import { OfficePages, type PaintPage } from "./OfficePages";
import { FrameText, paintFrame, useOfficeDocument, type OfficeEngine } from "./office-frames";

const openDocument = (engine: OfficeEngine, bytes: ArrayBuffer, signal: AbortSignal) =>
  engine.call("docx", { bytes }, { transfer: [bytes], signal });
const describe = (model: { pages: readonly unknown[] }) =>
  m(
    msg("{count, plural, one {{count} page} other {{count} pages}}", { count: model.pages.length }),
  );

export default function WordDocument(props: {
  src: string;
  onDetails: (text: string, truncated: boolean) => void;
  onError: (cause: unknown) => void;
}) {
  const { src, onDetails, onError } = props;
  const opened = useOfficeDocument(src, openDocument, describe, onDetails, onError);
  const scroll = useRef<((index: number, y?: number) => void) | null>(null);
  // One identity for the document's life, so re-rendering the page indicator repaints nothing.
  const paint: PaintPage = useStableCallback(async (index, canvas, scale) => {
    const frame = opened?.model.pages[index];
    if (frame) paintFrame(canvas, frame, opened.images, scale * (window.devicePixelRatio || 1));
  });

  if (!opened) return <FileSurfaceLoading />;
  const { model } = opened;
  return (
    <OfficePages
      pages={model.pages}
      paint={paint}
      kind="page"
      scrollRef={scroll}
      onError={onError}
      overlay={(index) => (
        <FrameText
          frame={model.pages[index]!}
          onInternalLink={(name) => {
            const target = model.bookmarks[name];
            if (target) scroll.current?.(target.page, target.y);
          }}
        />
      )}
    />
  );
}
