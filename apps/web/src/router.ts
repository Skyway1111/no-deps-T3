import { createRouter, type RouterHistory } from "./ui-core/router";

import { routeTree } from "./routeTree";

export function getRouter(history: RouterHistory) {
  return createRouter({ routeTree, history, context: {}, defaultPreload: "intent" });
}

export type AppRouter = ReturnType<typeof getRouter>;
