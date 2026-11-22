import {
  BUILT_IN_FILE_EXTENSION_TOKENS,
  BUILT_IN_FILE_NAME_TOKENS,
  BUILT_IN_SPRITE_SHEET,
} from "./sprite.ts";

export interface ResolvedFileIcon {
  readonly name: string;
  readonly token?: string;
}

export type FileIconEntry = string | ResolvedFileIcon;

/** Overrides checked before the built-in tokens; keys match case-insensitively. */
export interface FileTreeIcons {
  /** Symbols for override icons that are not built in. */
  readonly spriteSheet?: string;
  readonly byFileName?: Readonly<Record<string, FileIconEntry>>;
  readonly byFileExtension?: Readonly<Record<string, FileIconEntry>>;
  readonly byFileNameContains?: Readonly<Record<string, FileIconEntry>>;
}

/** Light and dark colors per built-in token; icons without an entry use `default`. */
const FILE_ICON_COLORS: Readonly<Record<string, readonly [light: string, dark: string]>> = {
  astro: ["#a631be", "#d568ea"],
  babel: ["#d5a910", "#ffd452"],
  bash: ["#199f43", "#5ecc71"],
  biome: ["#1a85d4", "#69b1ff"],
  bootstrap: ["#693acf", "#9d6afb"],
  browserslist: ["#d5a910", "#ffd452"],
  bun: ["#594c5b", "#79697b"],
  c: ["#1a85d4", "#69b1ff"],
  claude: ["#d47628", "#ffa359"],
  cpp: ["#1a85d4", "#69b1ff"],
  css: ["#693acf", "#9d6afb"],
  database: ["#a631be", "#d568ea"],
  default: ["#84848a", "#adadb1"],
  docker: ["#1a85d4", "#69b1ff"],
  eslint: ["#693acf", "#9d6afb"],
  git: ["#ff8c5b", "#d5512f"],
  go: ["#1ca1c7", "#68cdf2"],
  graphql: ["#d32a61", "#ff678d"],
  html: ["#d47628", "#ffa359"],
  image: ["#d32a61", "#ff678d"],
  javascript: ["#d5a910", "#ffd452"],
  json: ["#d47628", "#ffa359"],
  markdown: ["#199f43", "#5ecc71"],
  mcp: ["#17a5af", "#64d1db"],
  nextjs: ["#84848a", "#adadb1"],
  npm: ["#d52c36", "#ff6762"],
  oxc: ["#1ca1c7", "#68cdf2"],
  postcss: ["#d52c36", "#ff6762"],
  prettier: ["#17a5af", "#64d1db"],
  python: ["#1a85d4", "#69b1ff"],
  react: ["#1ca1c7", "#68cdf2"],
  ruby: ["#d52c36", "#ff6762"],
  rust: ["#d47628", "#ffa359"],
  sass: ["#d32a61", "#ff678d"],
  stylelint: ["#84848a", "#adadb1"],
  svelte: ["#d52c36", "#ff6762"],
  svg: ["#d47628", "#ffa359"],
  svgo: ["#199f43", "#5ecc71"],
  swift: ["#d47628", "#ffa359"],
  table: ["#17a5af", "#64d1db"],
  tailwind: ["#1ca1c7", "#68cdf2"],
  terraform: ["#693acf", "#9d6afb"],
  text: ["#84848a", "#adadb1"],
  typescript: ["#1a85d4", "#69b1ff"],
  video: ["#a631be", "#d568ea"],
  vite: ["#a631be", "#d568ea"],
  vscode: ["#1a85d4", "#69b1ff"],
  vue: ["#199f43", "#5ecc71"],
  wasm: ["#693acf", "#9d6afb"],
  webpack: ["#1a85d4", "#69b1ff"],
  yml: ["#d52c36", "#ff6762"],
  zig: ["#d47628", "#ffa359"],
  zip: ["#d47628", "#ffa359"],
};

export function fileIconColors(token: string | undefined): readonly [light: string, dark: string] {
  return FILE_ICON_COLORS[token ?? "default"] ?? FILE_ICON_COLORS.default!;
}

/** Every built-in symbol, including the tree's chevron and git-status dot. */
export function getBuiltInSpriteSheet(): string {
  return BUILT_IN_SPRITE_SHEET;
}

const asIcon = (entry: FileIconEntry): ResolvedFileIcon =>
  typeof entry === "string" ? { name: entry } : entry;

const lowerKeys = (record: Readonly<Record<string, FileIconEntry>> = {}) =>
  new Map(Object.entries(record).map(([key, icon]) => [key.trim().toLowerCase(), icon]));

export function createFileTreeIconResolver(icons: FileTreeIcons = {}) {
  const byFileName = lowerKeys(icons.byFileName);
  const byFileExtension = lowerKeys(icons.byFileExtension);
  const byFileNameContains = [...lowerKeys(icons.byFileNameContains)];
  return {
    resolveIcon(path: string): ResolvedFileIcon {
      const fileName = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
      const named = byFileName.get(fileName);
      if (named !== undefined) return asIcon(named);
      for (const [needle, icon] of byFileNameContains) {
        if (fileName.includes(needle)) return asIcon(icon);
      }
      const segments = fileName.split(".");
      const extensions = segments.slice(1).map((_, index) => segments.slice(index + 1).join("."));
      for (const extension of extensions) {
        const icon = byFileExtension.get(extension);
        if (icon !== undefined) return asIcon(icon);
      }
      let token = BUILT_IN_FILE_NAME_TOKENS[fileName];
      for (const extension of extensions) token ??= BUILT_IN_FILE_EXTENSION_TOKENS[extension];
      token ??= "default";
      return { name: `file-tree-builtin-${token}`, token };
    },
  };
}
