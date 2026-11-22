import { useRef, useSyncExternalStore } from "react";
import { bindReactStoreHooks } from "./signal.ts";

export {
  createJSONStorage,
  createStore,
  persist,
  shallow,
  type PersistApi,
  type PersistedStateCreator,
  type PersistedStoreApi,
  type PersistOptions,
  type PersistStorage,
  type SetStateInternal,
  type StateCreator,
  type StateStorage,
  type StorageValue,
  type StoreApi,
  type UseBoundStore,
} from "./signal.ts";

export const { create, useShallow, useStore } = bindReactStoreHooks({
  useSyncExternalStore,
  useRef,
});
