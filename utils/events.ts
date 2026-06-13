import { EventEmitter } from "events";

type Events = {
  "cron-config-changed": () => void;
};

const emitter = new EventEmitter();

export const bus = {
  on<K extends keyof Events>(event: K, listener: Events[K]): void {
    emitter.on(event, listener as any);
  },
  emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
    emitter.emit(event, ...args);
  },
  removeAllListeners<K extends keyof Events>(event: K): void {
    emitter.removeAllListeners(event);
  },
};
