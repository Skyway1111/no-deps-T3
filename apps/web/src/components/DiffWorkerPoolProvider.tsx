import type { ReactNode } from "react";

/** Code views highlight synchronously, so this only passes its children through. */
export function DiffWorkerPoolProvider({ children }: { children?: ReactNode }) {
  return children;
}
