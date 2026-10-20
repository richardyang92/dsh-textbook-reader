/** In-process per-key serialization for book state mutations. */

export class KeyedLock {
  private readonly queues = new Map<string, Promise<unknown>>()

  /** Run `task` after every previously queued task for the same key settles. */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(task)
    this.queues.set(key, next)
    return next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key)
    })
  }
}
