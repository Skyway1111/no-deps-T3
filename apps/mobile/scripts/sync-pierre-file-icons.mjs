import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { fileIconColors, getBuiltInSpriteSheet } from "@t3tools/shared/file-icons";

const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const appDirectory = NodePath.resolve(scriptDirectory, "..");
const repositoryRoot = NodePath.resolve(appDirectory, "../..");
const outputDirectory = NodePath.join(appDirectory, "assets/file-icons");
const generatedModulePath = NodePath.join(appDirectory, "src/lib/markdownFileIcons.generated.ts");
const webIconSource = NodeFS.readFileSync(
  NodePath.join(repositoryRoot, "apps/web/src/pierre-icons.ts"),
  "utf8",
);
const customSprite = webIconSource.match(/const T3_FILE_ICON_SPRITE = `([\s\S]*?)`;/)?.[1];

if (!customSprite) {
  throw new Error("Could not read the T3 Pierre icon sprite from apps/web/src/pierre-icons.ts");
}

const customIcons = {
  agents: "t3-file-icon-agents",
  pnpm: "t3-file-icon-pnpm",
  video: "t3-file-icon-video",
};

function symbolFromSprite(sprite, id) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = sprite.match(
    new RegExp(`<symbol id="${escapedId}"([^>]*)>([\\s\\S]*?)<\\/symbol>`),
  );
  if (!match) throw new Error(`Missing Pierre icon symbol: ${id}`);
  return {
    body: match[2],
    viewBox: match[1].match(/viewBox="([^"]+)"/)?.[1] ?? "0 0 16 16",
  };
}

function renderIcon(token, symbol, color) {
  const svgPath = NodePath.join(outputDirectory, `.pierre-${token}.svg`);
  const pngPath = NodePath.join(outputDirectory, `pierre_${token}.png`);
  NodeFS.writeFileSync(
    svgPath,
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="${symbol.viewBox}" style="color:${color}">${symbol.body}</svg>`,
  );
  NodeChildProcess.execFileSync("sips", ["-s", "format", "png", svgPath, "--out", pngPath], {
    stdio: "ignore",
  });
  NodeFS.rmSync(svgPath);
}

NodeFS.rmSync(outputDirectory, { recursive: true, force: true });
NodeFS.mkdirSync(outputDirectory, { recursive: true });

const builtInSprite = getBuiltInSpriteSheet();
const builtInTokens = [...builtInSprite.matchAll(/<symbol id="file-tree-builtin-([^"]+)"/g)]
  .map((match) => match[1])
  .sort();

for (const token of builtInTokens) {
  renderIcon(
    token,
    symbolFromSprite(builtInSprite, `file-tree-builtin-${token}`),
    fileIconColors(token)[0],
  );
}
for (const [token, symbolId] of Object.entries(customIcons)) {
  renderIcon(token, symbolFromSprite(customSprite, symbolId), fileIconColors(token)[0]);
}

const tokens = [...new Set([...builtInTokens, ...Object.keys(customIcons)])].sort();
const generatedSource = `import type { ImageSourcePropType } from "react-native";\n\nexport const MARKDOWN_FILE_ICON_SOURCES = {\n${tokens
  .map((token) => `  ${token}: require("../../assets/file-icons/pierre_${token}.png"),`)
  .join("\n")}\n} as const satisfies Readonly<Record<string, ImageSourcePropType>>;\n`;
NodeFS.writeFileSync(generatedModulePath, generatedSource);
