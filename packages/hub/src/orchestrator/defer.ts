/**
 * Speed: work off the streaming path. Once an agent's words are posted to the room, the follow-on bookkeeping
 * (memory harvest, tag routing, non-critical status writes) should not stand between the reply and the room. This
 * schedules such work to run after the current step instead of inline. Durability-critical writes (the run_finished
 * step record, accepted-before-merge) stay inline at their call sites; only best-effort work is handed to this.
 *
 * The scheduler and an optional observer are injectable so a test can prove the post is created before the deferred
 * work runs. The default scheduler is a microtask, which runs after the current synchronous stack (and so after the
 * post) but before the hub goes idle, so nothing is dropped.
 */
export class Deferrer {
  constructor(
    private schedule: (fn: () => void) => void = queueMicrotask,
    private onRun?: (label: string) => void,
  ) {}

  /** Run `fn` after the current step. A throw inside it is swallowed so one failed bookkeeping task can't take down the turn. */
  after(label: string, fn: () => void): void {
    this.schedule(() => {
      try { fn(); } catch { /* best-effort bookkeeping */ } finally { this.onRun?.(label); }
    });
  }
}
