import { describe, expect, it, vi } from "vite-plus/test";
import { createJSONStorage, createStore, persist, type StateStorage } from "./signal.ts";

function memoryStorage() {
  const items = new Map<string, string>();
  const storage: StateStorage = {
    getItem: (key) => items.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => void items.set(key, value)),
    removeItem: (key) => void items.delete(key),
  };
  return { items, storage, setItem: storage.setItem as ReturnType<typeof vi.fn> };
}

describe("persist", () => {
  it("writes only when the persisted slice changes, coalescing within debounceMs", async () => {
    vi.useFakeTimers();
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    const { items, storage, setItem } = memoryStorage();
    const store = createStore<{ saved: number; transient: number }>()(
      persist(() => ({ saved: 0, transient: 0 }), {
        name: "s",
        storage: createJSONStorage(() => storage),
        partialize: (state) => ({ saved: state.saved }),
        debounceMs: 200,
      }),
    );
    setItem.mockClear();

    store.setState({ saved: 1 });
    store.setState({ saved: 2 });
    expect(setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(items.get("s")!).state).toEqual({ saved: 2 });

    store.setState({ transient: 1 });
    store.setState((state) => state);
    store.persist.flush();
    expect(setItem).toHaveBeenCalledTimes(1);

    // A pending write must not clobber what rehydrate reads.
    store.setState({ saved: 3 });
    items.set("s", JSON.stringify({ state: { saved: 9 }, version: 0 }));
    await store.persist.rehydrate();
    vi.advanceTimersByTime(200);
    expect(store.getState().saved).toBe(9);
    expect(JSON.parse(items.get("s")!).state).toEqual({ saved: 9 });
  });
});
