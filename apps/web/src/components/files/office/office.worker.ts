import {
  layoutDocx,
  layoutPptx,
  openXlsx,
  readSheet,
  type CellStyle,
  type Measure,
  type OfficeImage,
  type OfficePackage,
  type PresentationModel,
  type SheetData,
  type WordDocumentModel,
  type Workbook,
} from "../decoders/officeEngine";
import { serveWorker, Transfer, type Method } from "./worker-rpc";

// One worker per open file parses and lays out off the main thread; the window paints the returned frames.
export type OfficeMethods = {
  readonly docx: Method<{ readonly bytes: ArrayBuffer }, WordDocumentModel>;
  readonly pptx: Method<{ readonly bytes: ArrayBuffer }, PresentationModel>;
  readonly workbook: Method<
    { readonly bytes: ArrayBuffer },
    {
      readonly tabs: readonly { index: number; name: string }[];
      readonly active: number;
      readonly styles: readonly CellStyle[];
    }
  >;
  readonly sheet: Method<{ readonly sheet: number }, SheetData>;
};

const context = new OffscreenCanvas(1, 1).getContext("2d");
const measure: Measure = (text, font) => {
  if (!context) return text.length * 8;
  context.font = font;
  return context.measureText(text).width;
};
const state: { workbook?: { pkg: OfficePackage; workbook: Workbook } } = {};

/** Moves the embedded images to the window instead of copying them. */
const withImages = <T extends { images: OfficeImage[] }>(model: T) =>
  new Transfer(model, [...new Set(model.images.map((image) => image.bytes.buffer as ArrayBuffer))]);

serveWorker<OfficeMethods>({
  docx: async ({ bytes }) => withImages(await layoutDocx(bytes, measure)),
  pptx: async ({ bytes }) => withImages(await layoutPptx(bytes, measure)),
  async workbook({ bytes }) {
    state.workbook = await openXlsx(bytes);
    const { workbook } = state.workbook;
    const tabs = workbook.sheets.flatMap((sheet, index) =>
      sheet.hidden ? [] : [{ index, name: sheet.name }],
    );
    const active = tabs.find((tab) => tab.index === workbook.active)?.index ?? tabs[0]?.index ?? -1;
    return { tabs, active, styles: workbook.styles };
  },
  sheet({ sheet }) {
    if (!state.workbook) throw new Error("No workbook is open.");
    return readSheet(state.workbook.pkg, state.workbook.workbook, sheet);
  },
});
