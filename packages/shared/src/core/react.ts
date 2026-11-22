import { useRef, useSyncExternalStore } from "react";
import { bindReactStoreHooks } from "./signal.ts";

export {
  batch,
  computed,
  createJSONStorage,
  createStore,
  effect,
  persist,
  shallow,
  signal,
  untracked,
  type Computed,
  type PersistApi,
  type PersistedStateCreator,
  type PersistedStoreApi,
  type PersistOptions,
  type PersistStorage,
  type ReadonlySignal,
  type SetStateInternal,
  type Signal,
  type StateCreator,
  type StateStorage,
  type StorageValue,
  type StoreApi,
  type UseBoundStore,
} from "./signal.ts";

export const { create, useShallow, useSignal, useStore } = bindReactStoreHooks({
  useSyncExternalStore,
  useRef,
});
