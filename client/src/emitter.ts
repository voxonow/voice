type Listener = (...args: never[]) => void;

/** Minimal typed event emitter that runs in browsers and React Native alike. */
export class Emitter<Events extends Record<string, unknown[]>> {
  private readonly listeners = new Map<keyof Events, Set<Listener>>();

  on<E extends keyof Events>(event: E, listener: (...args: Events[E]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener as unknown as Listener);
    return () => this.off(event, listener);
  }

  off<E extends keyof Events>(event: E, listener: (...args: Events[E]) => void): void {
    this.listeners.get(event)?.delete(listener as unknown as Listener);
  }

  protected emit<E extends keyof Events>(event: E, ...args: Events[E]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        (listener as unknown as (...args: Events[E]) => void)(...args);
      } catch (error) {
        // A failing listener must not break the client's own bookkeeping.
        console.error(`voice-client: ${String(event)} listener threw`, error);
      }
    }
  }
}
