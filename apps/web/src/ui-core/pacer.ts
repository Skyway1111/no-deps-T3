import { useEffect, useState } from "react";

export interface DebouncerOptions {
  wait: number;
  leading?: boolean;
  trailing?: boolean;
}

/** Trailing-edge (optionally leading) debounce; `cancel` drops the pending call and its args. */
export class Debouncer<TArgs extends unknown[]> {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: TArgs | undefined;
  private readonly listeners = new Set<() => void>();
  state = { isPending: false };

  private readonly fn: (...args: TArgs) => void;
  readonly options: DebouncerOptions;

  constructor(fn: (...args: TArgs) => void, options: DebouncerOptions) {
    this.fn = fn;
    this.options = options;
  }

  maybeExecute(...args: TArgs): void {
    const idle = this.timer === undefined;
    clearTimeout(this.timer);
    if (idle && this.options.leading) {
      this.pending = undefined;
      this.fn(...args);
    } else if (this.options.trailing !== false) {
      this.pending = args;
    }
    this.timer = setTimeout(() => this.flush(), this.options.wait);
    this.setPending(this.pending !== undefined);
  }

  flush(): void {
    const args = this.pending;
    this.cancel();
    if (args) this.fn(...args);
  }

  cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
    this.setPending(false);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setPending(isPending: boolean): void {
    if (this.state.isPending === isPending) return;
    this.state = { isPending };
    for (const listener of this.listeners) listener();
  }
}

/** Debounced copy of `value`; the second item exposes the debouncer and its pending state. */
export function useDebouncedValue<T>(value: T, options: DebouncerOptions) {
  const [debounced, setDebounced] = useState(value);
  const [debouncer] = useState(() => new Debouncer(setDebounced, options));
  const [, rerender] = useState(debouncer.state);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes React to the debouncer's timer state.
  useEffect(() => {
    const unsubscribe = debouncer.subscribe(() => rerender(debouncer.state));
    return () => {
      unsubscribe();
      debouncer.cancel();
    };
  }, [debouncer]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- feeds each new value into the external timer.
  useEffect(() => {
    if (Object.is(value, debounced)) debouncer.cancel();
    else debouncer.maybeExecute(value);
  }, [debouncer, value, debounced]);
  return [debounced, debouncer] as const;
}
