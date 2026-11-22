import * as Effect from "effect/Effect";

import { type ZipEntry, ZipReader } from "./zipReader.ts";

/** Closing the scope closes the archive. */
export const openZipArchive = Effect.fn("zipArchive.open")(function* <E>(
  archivePath: string,
  makeError: (detail: string, cause: unknown) => E,
) {
  const zip = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => ZipReader.open(archivePath),
      catch: (cause) => makeError("Could not open the verified archive.", cause),
    }),
    (zip) =>
      Effect.tryPromise({
        try: () => zip.close(),
        catch: (cause) => makeError("Could not close the archive.", cause),
      }).pipe(Effect.orDie),
  );
  let index = 0;
  const next = Effect.sync((): ZipEntry | null => zip.entries[index++] ?? null);
  const streamEntry = (entry: ZipEntry) =>
    Effect.acquireRelease(
      Effect.tryPromise({
        try: () => zip.openReadStream(entry),
        catch: (cause) => makeError("Could not read an archive member.", cause),
      }),
      (readable) => Effect.sync(() => readable.destroy()),
    );
  return { entryCount: zip.entries.length, next, streamEntry };
});
