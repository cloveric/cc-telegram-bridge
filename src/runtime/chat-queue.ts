export class ChatQueue {
  private readonly queues = new Map<number, Promise<unknown>>();

  enqueue<T>(chatId: number, job: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(chatId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(job);

    this.queues.set(chatId, run.then(() => undefined, () => undefined));
    return run;
  }
}
