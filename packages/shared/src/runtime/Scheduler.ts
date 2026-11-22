import * as Ctx from "./Context.ts";
import { MaxOpsBeforeYield, PreventSchedulerYield } from "./References.ts";

export type Task = () => void;
export interface SchedulerDispatcher {
  scheduleTask(task: Task, priority: number): void;
  flush(): void;
}
export interface Scheduler {
  readonly executionMode: "sync" | "async";
  makeDispatcher(): SchedulerDispatcher;
}
/** Runs tasks on the macrotask queue (setImmediate when available). */
export class MixedScheduler implements Scheduler {
  readonly executionMode: "sync" | "async";
  constructor(executionMode: "sync" | "async" = "async") {
    this.executionMode = executionMode;
  }
  makeDispatcher(): SchedulerDispatcher {
    const queue: Array<Task> = [];
    let scheduled = false;
    const run = () => {
      scheduled = false;
      const tasks = queue.splice(0);
      for (const t of tasks) t();
    };
    const tick = typeof setImmediate === "function" ? setImmediate : (f: () => void) => setTimeout(f, 0);
    return {
      scheduleTask(task) {
        queue.push(task);
        if (!scheduled) {
          scheduled = true;
          tick(run);
        }
      },
      flush: run,
    };
  }
}
export const Scheduler = Ctx.Reference<Scheduler>("effect/Scheduler", { defaultValue: () => new MixedScheduler() });
export { MaxOpsBeforeYield, PreventSchedulerYield };
