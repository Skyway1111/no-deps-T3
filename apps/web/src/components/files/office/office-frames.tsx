/* oxlint-disable react/no-array-index-key -- Text runs keep their order within an immutable frame. */
import { useEffect, useState } from "react";
import type { OfficeFrame, OfficeImage, Paint } from "../decoders/officeEngine";
import { officeImageBitmap } from "./image-bitmap";
import { externalUrl } from "./links";
import { OFFICE_PREVIEW_MAX_BYTES } from "../officePreviewProtocol";
import { PreviewError } from "../previewFailure";
import { readBoundedDocument } from "../readBoundedDocument";
import { createWorkerClient } from "./worker-rpc";
import type { OfficeMethods } from "./office.worker";

export type OfficeEngine = ReturnType<typeof createWorkerClient<OfficeMethods>>;

/**
 * Fetches the file straight into a fresh Office worker: the bytes are moved, never copied. Opening must `settle`
 * within 30 s or the worker closes and `onError` gets a timeout.
 */
export function openOfficeWorker(
  src: string,
  controller: AbortController,
  onError: (cause: unknown) => void,
) {
  const engine = createWorkerClient<OfficeMethods>(
    new Worker(new URL("./office.worker.ts", import.meta.url), { type: "module" }),
  );
  const timer = setTimeout(() => {
    controller.abort();
    engine.close();
    onError(new PreviewError({ code: "office-timeout" }));
  }, 30_000);
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return {
    engine,
    bytes: readBoundedDocument(src, controller.signal, OFFICE_PREVIEW_MAX_BYTES),
    settle: () => clearTimeout(timer),
  };
}

/** Opens the file in its own worker and decodes its images; the worker closes once the model is out. */
export function useOfficeDocument<T extends { images: OfficeImage[]; truncated?: boolean }>(
  src: string,
  open: (engine: OfficeEngine, bytes: ArrayBuffer, signal: AbortSignal) => Promise<T>,
  describe: (model: T) => string,
  onDetails: (text: string, truncated: boolean) => void,
  onError: (cause: unknown) => void,
) {
  const [opened, setOpened] = useState<{ model: T; images: (ImageBitmap | null)[] }>();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own the Office fetch, worker and decoded image bitmaps for this file, releasing them when it changes or unmounts.
  useEffect(() => {
    const controller = new AbortController();
    const { engine, bytes, settle } = openOfficeWorker(src, controller, onError);
    let images: (ImageBitmap | null)[] = [];
    void bytes
      .then((buffer) => open(engine, buffer, controller.signal))
      .then(async (model) => {
        settle();
        engine.close();
        images = await Promise.all(
          model.images.map((image) =>
            officeImageBitmap(
              new Blob([image.bytes as Uint8Array<ArrayBuffer>], { type: image.mime }),
            ).catch(() => null),
          ),
        );
        if (controller.signal.aborted) return images.forEach((bitmap) => bitmap?.close());
        // Painting needs only the bitmaps; the encoded bytes go.
        setOpened({ model: { ...model, images: [] }, images });
        onDetails(describe(model), model.truncated === true);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) onError(cause);
      });
    return () => {
      controller.abort();
      engine.close();
      images.forEach((bitmap) => bitmap?.close());
    };
  }, [src, open, describe, onDetails, onError]);
  return opened;
}

function shapePath(context: CanvasRenderingContext2D, item: Extract<Paint, { t: "rect" }>) {
  const { x, y, w, h } = item;
  const polygon = (points: number[][]) => {
    points.forEach(([px, py], i) =>
      i ? context.lineTo(x + px! * w, y + py! * h) : context.moveTo(x + px! * w, y + py! * h),
    );
    context.closePath();
  };
  context.beginPath();
  switch (item.shape) {
    case "ellipse":
    case "donut":
      context.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    case "roundRect":
    case "flowChartAlternateProcess":
    case "flowChartTerminator":
      context.roundRect(
        x,
        y,
        w,
        h,
        Math.min(w, h) * (item.shape === "flowChartTerminator" ? 0.5 : 0.17),
      );
      break;
    case "triangle":
      polygon([
        [0.5, 0],
        [1, 1],
        [0, 1],
      ]);
      break;
    case "rtTriangle":
      polygon([
        [0, 0],
        [1, 1],
        [0, 1],
      ]);
      break;
    case "diamond":
    case "flowChartDecision":
      polygon([
        [0.5, 0],
        [1, 0.5],
        [0.5, 1],
        [0, 0.5],
      ]);
      break;
    case "parallelogram":
      polygon([
        [0.25, 0],
        [1, 0],
        [0.75, 1],
        [0, 1],
      ]);
      break;
    case "hexagon":
      polygon([
        [0.25, 0],
        [0.75, 0],
        [1, 0.5],
        [0.75, 1],
        [0.25, 1],
        [0, 0.5],
      ]);
      break;
    case "chevron":
    case "homePlate":
    case "pentagon":
      polygon([
        [0, 0],
        [0.8, 0],
        [1, 0.5],
        [0.8, 1],
        [0, 1],
        ...(item.shape === "chevron" ? [[0.2, 0.5]] : []),
      ]);
      break;
    case "rightArrow":
      polygon([
        [0, 0.25],
        [0.7, 0.25],
        [0.7, 0],
        [1, 0.5],
        [0.7, 1],
        [0.7, 0.75],
        [0, 0.75],
      ]);
      break;
    case "leftArrow":
      polygon([
        [1, 0.25],
        [0.3, 0.25],
        [0.3, 0],
        [0, 0.5],
        [0.3, 1],
        [0.3, 0.75],
        [1, 0.75],
      ]);
      break;
    case "upArrow":
      polygon([
        [0.25, 1],
        [0.25, 0.3],
        [0, 0.3],
        [0.5, 0],
        [1, 0.3],
        [0.75, 0.3],
        [0.75, 1],
      ]);
      break;
    case "downArrow":
      polygon([
        [0.25, 0],
        [0.25, 0.7],
        [0, 0.7],
        [0.5, 1],
        [1, 0.7],
        [0.75, 0.7],
        [0.75, 0],
      ]);
      break;
    case "plus":
      polygon([
        [0.25, 0],
        [0.75, 0],
        [0.75, 0.25],
        [1, 0.25],
        [1, 0.75],
        [0.75, 0.75],
        [0.75, 1],
        [0.25, 1],
        [0.25, 0.75],
        [0, 0.75],
        [0, 0.25],
        [0.25, 0.25],
      ]);
      break;
    case "octagon":
      polygon([
        [0.29, 0],
        [0.71, 0],
        [1, 0.29],
        [1, 0.71],
        [0.71, 1],
        [0.29, 1],
        [0, 0.71],
        [0, 0.29],
      ]);
      break;
    case "snip1Rect":
      polygon([
        [0, 0],
        [0.83, 0],
        [1, 0.17],
        [1, 1],
        [0, 1],
      ]);
      break;
    case "star5":
      polygon(
        Array.from({ length: 10 }, (_, i) => {
          const angle = -Math.PI / 2 + (i * Math.PI) / 5;
          const radius = i % 2 ? 0.19 : 0.5;
          return [0.5 + radius * Math.cos(angle), 0.5 + radius * 1.05 * Math.sin(angle) + 0.03];
        }),
      );
      break;
    default:
      context.rect(x, y, w, h);
  }
}

/** Paints a laid-out page or slide at `scale` device pixels per layout pixel. */
export function paintFrame(
  canvas: HTMLCanvasElement,
  frame: OfficeFrame,
  images: readonly (ImageBitmap | null)[],
  scale: number,
) {
  canvas.width = Math.max(1, Math.round(frame.width * scale));
  canvas.height = Math.max(1, Math.round(frame.height * scale));
  const context = canvas.getContext("2d");
  if (!context) return;
  context.scale(scale, scale);
  context.fillStyle = frame.background ?? "#fff";
  context.fillRect(0, 0, frame.width, frame.height);
  context.textBaseline = "alphabetic";
  for (const item of frame.items) {
    if (item.t === "rect") {
      context.save();
      if (item.rotation) {
        context.translate(item.x + item.w / 2, item.y + item.h / 2);
        context.rotate((item.rotation * Math.PI) / 180);
        context.translate(-(item.x + item.w / 2), -(item.y + item.h / 2));
      }
      shapePath(context, item);
      if (item.fill) {
        context.fillStyle = item.fill;
        context.fill();
      }
      if (item.stroke) {
        context.strokeStyle = item.stroke;
        context.lineWidth = item.lineWidth ?? 1;
        context.stroke();
      }
      context.restore();
    } else if (item.t === "line") {
      context.beginPath();
      context.moveTo(item.x1, item.y1);
      context.lineTo(item.x2, item.y2);
      context.strokeStyle = item.color;
      context.lineWidth = item.width;
      context.stroke();
    } else if (item.t === "image") {
      const bitmap = images[item.image];
      const [l, t, r, b] = item.crop ?? [0, 0, 0, 0];
      if (bitmap && item.crop)
        context.drawImage(
          bitmap,
          bitmap.width * l,
          bitmap.height * t,
          bitmap.width * (1 - l - r),
          bitmap.height * (1 - t - b),
          item.x,
          item.y,
          item.w,
          item.h,
        );
      else if (bitmap) context.drawImage(bitmap, item.x, item.y, item.w, item.h);
      else {
        context.fillStyle = "#e5e5e5";
        context.fillRect(item.x, item.y, item.w, item.h);
      }
    } else {
      context.font = item.font;
      context.fillStyle = item.color;
      context.fillText(item.text, item.x, item.y);
      if (item.underline || item.strike) {
        const y = item.underline ? item.y + item.size * 0.12 : item.y - item.size * 0.3;
        context.fillRect(item.x, y, item.width, Math.max(0.75, item.size / 16));
      }
    }
  }
}

/** Selectable, transparent copies of a frame's text over its canvas, with links a reader can follow. */
export function FrameText(props: {
  frame: OfficeFrame;
  onInternalLink?: (target: string) => void;
}) {
  const { frame } = props;
  return (
    <div
      className="absolute inset-0 select-text overflow-hidden whitespace-pre text-transparent selection:bg-primary/30 selection:text-transparent"
      style={{ containerType: "inline-size", fontSize: 0, lineHeight: 1.15 }}
    >
      {frame.items.map((item, index) => {
        if (item.t !== "text") return null;
        const url = item.link && !item.link.startsWith("#") ? externalUrl(item.link) : undefined;
        const internal = item.link?.startsWith("#") ? item.link.slice(1) : undefined;
        const follow = () => {
          if (url) window.open(url, "_blank", "noopener,noreferrer");
          else if (internal) props.onInternalLink?.(internal);
        };
        return (
          <span
            key={index}
            role={url || internal ? "link" : undefined}
            tabIndex={url || internal ? 0 : undefined}
            title={url}
            className="absolute origin-top-left"
            style={{
              left: `${(item.x / frame.width) * 100}%`,
              top: `${((item.y - item.size * 0.95) / frame.height) * 100}%`,
              font: item.font.replace(/[\d.]+px/, `${(item.size / frame.width) * 100}cqw`),
              cursor: url || internal ? "pointer" : "text",
            }}
            onClick={(event) => {
              if ((url || internal) && event.button === 0 && (getSelection()?.isCollapsed ?? true))
                follow();
            }}
            onKeyDown={(event) => {
              if ((url || internal) && event.key === "Enter") {
                event.preventDefault();
                follow();
              }
            }}
          >
            {item.text}
          </span>
        );
      })}
    </div>
  );
}
