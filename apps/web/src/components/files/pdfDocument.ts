import { PdfDocument, type PdfTextItem } from "./decoders/pdfEngine";

export type { PdfDocument, PdfTextItem };
export const openPdf = (bytes: ArrayBuffer) => PdfDocument.open(bytes);

let measure: CanvasRenderingContext2D | null | undefined;
/** How much a text layer span stretches so the browser's sans-serif covers the PDF run's width. */
export function pdfSpanScale(text: string, fontPx: number, widthPx: number) {
  measure ??= document.createElement("canvas").getContext("2d");
  if (!measure || !fontPx) return 1;
  measure.font = `${fontPx}px sans-serif`;
  const measured = measure.measureText(text).width;
  return measured > 0 ? widthPx / measured : 1;
}
