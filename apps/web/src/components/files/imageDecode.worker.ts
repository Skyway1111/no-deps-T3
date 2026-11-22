import { decodeHeif, parseHeif } from "./decoders/heicDecoder";
import { checkImageSize, DecodeError, decodeTiff } from "./decoders/tiffDecoder";
import { PreviewError, previewFailure } from "./previewFailure";

async function encode(width: number, height: number, draw: (context: OffscreenCanvasRenderingContext2D) => void) {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) throw new PreviewError({ code: "image-decoding-unavailable" });
  draw(context);
  return canvas.convertToBlob({ type: "image/png" });
}

async function decode(bytes: ArrayBuffer, heif: boolean) {
  if (bytes.byteLength > 50 * 1024 * 1024) throw new PreviewError({ code: "file-too-large" });
  if (heif) {
    const image = parseHeif(bytes);
    checkImageSize(image.width, image.height);
    const { bitmap } = await decodeHeif(bytes, image);
    try {
      return await encode(bitmap.width, bitmap.height, (context) => context.drawImage(bitmap, 0, 0));
    } finally {
      bitmap.close();
    }
  }
  const { width, height, data } = await decodeTiff(bytes);
  return encode(width, height, (context) => context.putImageData(new ImageData(data, width, height), 0, 0));
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
