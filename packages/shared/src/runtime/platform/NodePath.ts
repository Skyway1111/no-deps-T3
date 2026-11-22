import * as NodePath from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import * as I from "../internal.ts";
import * as Layer from "../Layer.ts";
import { Path, TypeId, type PathService } from "../Path.ts";
import { badArgument } from "../PlatformError.ts";

const fromNode = (p: NodePath.PlatformPath): PathService => ({
  [TypeId]: TypeId,
  sep: p.sep, delimiter: p.delimiter, basename: p.basename, dirname: p.dirname, extname: p.extname, format: p.format,
  isAbsolute: p.isAbsolute, join: p.join, normalize: p.normalize, parse: p.parse, relative: p.relative, resolve: p.resolve,
  toNamespacedPath: p.toNamespacedPath,
  fromFileUrl: (url) => I.make(() => {
    try {
      return fileURLToPath(url, { windows: p === NodePath.win32 });
    } catch (e) {
      return I.failWith(I.causeFail(badArgument({ module: "Path", method: "fromFileUrl", description: (e as Error).message })));
    }
  }),
  toFileUrl: (path) => I.make(() => pathToFileURL(path, { windows: p === NodePath.win32 })),
});
export const layer: Layer.Layer<Path> = Layer.succeed(Path, fromNode(NodePath));
export const layerPosix: Layer.Layer<Path> = Layer.succeed(Path, fromNode(NodePath.posix));
export const layerWin32: Layer.Layer<Path> = Layer.succeed(Path, fromNode(NodePath.win32));
