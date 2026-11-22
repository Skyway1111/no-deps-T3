import type { LazyRouteTree, Route } from "./ui-core/router";

// `_chat.settings.general.tsx` is route `/_chat/settings/general`; `_chat.index.tsx` is `/_chat/`.
const modules = import.meta.glob<{ Route: Route }>("./routes/*.tsx");
const idOf = (file: string) =>
  `/${file.slice("./routes/".length, -".tsx".length).replaceAll(".", "/")}`.replace(
    /\/index$/,
    "/",
  );
const lazy = (file: string) => () => modules[file]!().then((module) => module.Route);

export const routeTree: LazyRouteTree = {
  root: lazy("./routes/__root.tsx"),
  routes: Object.fromEntries(
    Object.keys(modules)
      .filter((file) => !file.endsWith("/__root.tsx"))
      .map((file) => [idOf(file), lazy(file)]),
  ),
};
