import { batchedUpdates, createPortal, createRootFiber, enqueue, flushSync, unmountRoot, type Fiber } from "./reconciler.ts";

export interface Root {
  render(children: unknown): void;
  unmount(): void;
}

export function createRoot(container: any, _options?: unknown): Root {
  let fiber: Fiber | null = null;
  return {
    render(children) {
      if (fiber?.dead) throw new Error("Cannot update an unmounted root.");
      fiber ??= createRootFiber(container);
      fiber.props = children;
      enqueue(fiber);
    },
    unmount() {
      if (fiber) flushSync(() => unmountRoot(fiber!));
    },
  };
}

/** Client-renders over server markup (React's mismatch fallback) instead of adopting nodes. */
export function hydrateRoot(container: any, children: unknown, options?: unknown): Root {
  container.textContent = "";
  const root = createRoot(container, options);
  root.render(children);
  return root;
}

export const version = "19.2.0";
export { batchedUpdates as unstable_batchedUpdates, createPortal, flushSync };
