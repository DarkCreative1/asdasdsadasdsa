import { settings } from './config.js';
import { networkGuard } from './network.js';

// One shared budget: live rechecks jump ahead of queued discovery jobs.
// Queues are bounded by checkAll's producer count, not the source list size.
export class CheckScheduler {
  constructor(guard = networkGuard) {
    this.guard = guard;
    this.active = 0;
    this.queue = [];
    this.inFlight = new Set();
  }

  drain() {
    this.queue.sort((a, b) => b.priority - a.priority);
    while (this.queue.length && this.active < this.guard.concurrency(settings.checkConcurrency)) {
      const entry = this.queue.shift();
      entry.signal?.removeEventListener('abort', entry.cancel);
      if (entry.signal?.aborted || this.guard.paused()) { entry.resolve(null); continue; }
      this.active++;
      entry.resolve(() => { this.active--; this.drain(); });
    }
  }

  async run(proxy, task, { priority = 0, signal } = {}) {
    if (signal?.aborted || this.guard.paused() || this.inFlight.has(proxy)) return null;
    this.inFlight.add(proxy);
    let release;
    try {
      release = await new Promise((resolve) => {
        const entry = { resolve, priority, signal };
        entry.cancel = () => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          resolve(null);
        };
        signal?.addEventListener('abort', entry.cancel, { once: true });
        this.queue.push(entry);
        this.drain();
      });
      if (!release || signal?.aborted || this.guard.paused()) return null;
      return await task();
    } finally {
      this.inFlight.delete(proxy);
      release?.();
    }
  }

  status() { return { active: this.active, queued: this.queue.length, in_flight: this.inFlight.size }; }
}
