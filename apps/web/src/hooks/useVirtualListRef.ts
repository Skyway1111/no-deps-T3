import type { VirtualListRef } from "~/ui-core/virtualList";
import { type RefObject } from "react";
import { useStableCallback } from "./useStableCallback";

/** Refresh scroll-derived UI when layout changes without a scroll event. */
export function useVirtualListRef(listRef: RefObject<VirtualListRef | null>, onChange: () => void) {
  const notify = useStableCallback(onChange);
  return (list: VirtualListRef | null) => {
    listRef.current = list;
    if (!list) return;
    const state = list.getState();
    const stops = [
      state.listen("totalSize", notify),
      state.listen("headerSize", notify),
      state.listen("footerSize", notify),
      state.listen("isAtStart", notify),
      state.listen("isAtEnd", notify),
    ];
    notify();
    return () => {
      for (const stop of stops) stop();
      listRef.current = null;
    };
  };
}
