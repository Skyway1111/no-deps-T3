import { Children, cloneElement, createElement, Fragment, isValidElement, Profiler, StrictMode, Suspense } from "./jsx-runtime.ts";
import * as hooks from "./hooks.ts";
import { act } from "./reconciler.ts";
import { version } from "./client.ts";

export { Children, cloneElement, createElement, Fragment, isValidElement, Profiler, StrictMode, Suspense } from "./jsx-runtime.ts";
export * from "./hooks.ts";
export { act } from "./reconciler.ts";
export { version } from "./client.ts";

const React = { ...hooks, Children, cloneElement, createElement, Fragment, isValidElement, Profiler, StrictMode, Suspense, act, version };
export default React;
