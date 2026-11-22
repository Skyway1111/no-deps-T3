import * as I from "./internal.ts";

export class Latch implements I.Pipeable {
  private opened: boolean;
  private waiters = new Set<() => void>();
  constructor(open: boolean) {
    this.opened = open;
  }
  openUnsafe(): boolean {
    if (this.opened) return false;
    this.opened = true;
    this.releaseUnsafe();
    return true;
  }
  releaseUnsafe(): boolean {
    if (this.waiters.size === 0) return false;
    const ws = [...this.waiters];
    this.waiters.clear();
    for (const w of ws) w();
    return true;
  }
  closeUnsafe(): boolean {
    if (!this.opened) return false;
    this.opened = false;
    return true;
  }
  isOpen(): boolean {
    return this.opened;
  }
  get open(): I.Effect<boolean> {
    return I.make(() => this.openUnsafe());
  }
  get release(): I.Effect<boolean> {
    return I.make(() => this.releaseUnsafe());
  }
  get close(): I.Effect<boolean> {
    return I.make(() => this.closeUnsafe());
  }
  get await(): I.Effect<void> {
    return I.make((f) => {
      if (this.opened) return undefined;
      return I.interruptibleWait<void>(f, (resolve) => {
        const w = () => resolve();
        this.waiters.add(w);
        return () => this.waiters.delete(w);
      });
    });
  }
  whenOpen<A, E, R>(self: I.Effect<A, E, R>): I.Effect<A, E, R> {
    return I.make((f) => I.chain(I.exec(this.await, f), () => I.exec(self, f)));
  }
  pipe() {
    return I.pipeArgs(this, arguments);
  }
}
export const makeUnsafe = (open = false): Latch => new Latch(open);
export const make = (open = false): I.Effect<Latch> => I.make(() => new Latch(open));
export const open = (self: Latch) => self.open;
export const openUnsafe = (self: Latch) => self.openUnsafe();
export const release = (self: Latch) => self.release;
export const close = (self: Latch) => self.close;
export const closeUnsafe = (self: Latch) => self.closeUnsafe();
const await_ = (self: Latch) => self.await;
export { await_ as await };
export const whenOpen = (self: Latch) => <A, E, R>(effect: I.Effect<A, E, R>) => self.whenOpen(effect);
export const isOpen = (self: Latch) => self.isOpen();
