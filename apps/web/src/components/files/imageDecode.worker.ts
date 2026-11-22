import { decodeHeif, parseHeif } from "./decoders/heicDecoder";
import { checkImageSize, DecodeError, decodeTiff } from "./decoders/tiffDecoder";
import { PreviewError, previewFailure } from "./previewFailure";

/**
 * Opaque images become JPEG at 0.92: a tenth of a lossless PNG's size and faster to encode than either PNG or WebP.
 * Images that may carry alpha stay PNG. The canvas is released once encoded.
 */
async function encode(
  width: number,
  height: number,
  opaque: boolean,
  draw: (context: OffscreenCanvasRenderingContext2D) => void,
) {
  const canvas = new OffscreenCanvas(width, height);
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new PreviewError({ code: "image-decoding-unavailable" });
    draw(context);
    if (opaque) {
      const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
      if (jpeg.type === "image/jpeg") return jpeg;
    }
    return await canvas.convertToBlob({ type: "image/png" });
  } finally {
    canvas.width = canvas.height = 0;
  }
}

async function decode(bytes: ArrayBuffer, heif: boolean) {
  if (bytes.byteLength > 50 * 1024 * 1024) throw new PreviewError({ code: "file-too-large" });
  if (heif) {
    const image = parseHeif(bytes);
    checkImageSize(image.width, image.height);
    // Tiles and thumbnails decode opaque; a browser-native decode may keep an alpha plane.
    const { bitmap, native } = await decodeHeif(bytes, image);
    try {
      return await encode(bitmap.width, bitmap.height, !native, (context) => context.drawImage(bitmap, 0, 0));
    } finally {
      bitmap.close();
    }
  }
  const { width, height, data, alpha } = await decodeTiff(bytes);
  return encode(width, height, !alpha, (context) => context.putImageData(new ImageData(data, width, height), 0, 0));
}

self.addEventListener("message", (event: MessageEvent<{ bytes: ArrayBuffer; heif: boolean }>) => {
  void decode(event.data.bytes, event.data.heif).then(
    (blob) => self.postMessage({ blob }, { transfer: [] }),
    (cause: unknown) =>
      self.postMessage(
        {
          failure: previewFailure(
            cause instanceof DecodeError ? new PreviewError({ code: cause.code }) : cause,
            "image-decode-failed",
          ),
        },
        { transfer: [] },
      ),
  );
});
