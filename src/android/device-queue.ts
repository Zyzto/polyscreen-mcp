export class DeviceQueue {
  readonly #tails = new Map<string, Promise<void>>();

  async mutate<T>(serial: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(serial) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#tails.set(serial, queued);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(serial) === queued) this.#tails.delete(serial);
    }
  }
}
