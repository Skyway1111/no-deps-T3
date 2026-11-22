import { PdfDocument, type PdfTextItem } from "./decoders/pdfEngine";

export type { PdfDocument, PdfTextItem };
export const openPdf = (bytes: ArrayBuffer) => PdfDocument.open(bytes);

let measure: CanvasRenderingContext2D | null | undefined;
// Text layers re-render on every Find keystroke; each run is measured once per font size.
const measured = new Map<string, number>();
/** How much a text layer span stretches so the browser's sans-serif covers the PDF run's width. */
export function pdfSpanScale(text: string, fontPx: number, widthPx: number) {
  measure ??= document.createElement("canvas").getContext("2d");
  if (!measure || !fontPx) return 1;
  const key = `${fontPx}\u0000${text}`;
  let width = measured.get(key);
  if (width === undefined) {
    if (measured.size >= 20_000) measured.clear();
    measure.font = `${fontPx}px sans-serif`;
    measured.set(key, (width = measure.measureText(text).width));
  }
  return width > 0 ? widthPx / width : 1;
}
