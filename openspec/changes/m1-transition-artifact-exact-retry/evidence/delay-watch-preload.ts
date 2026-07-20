import { mock } from "bun:test";
import fs, { type WatchListener } from "node:fs";

export const CALLBACK_DELAY_MS = 180;

export interface DelayedWatchEvent {
  nativeAtMs: number;
  deliveredAtMs?: number;
  eventType: string;
  filename: string | null;
}

const delayedEvents: DelayedWatchEvent[] = [];
const registrations: string[] = [];
Object.assign(globalThis, {
  __issue108DelayedWatchEvents: delayedEvents,
  __issue108DelayedWatchRegistrations: registrations
});

const originalWatch = fs.watch;
const delayedWatch = ((...args: Parameters<typeof fs.watch>) => {
  registrations.push(String(args[0]));
  const listener = args.at(-1) as WatchListener<string>;
  const wrapped: WatchListener<string> = (eventType, filename) => {
    const event: DelayedWatchEvent = {
      nativeAtMs: Date.now(),
      eventType,
      filename: filename === null ? null : String(filename)
    };
    delayedEvents.push(event);
    setTimeout(() => {
      event.deliveredAtMs = Date.now();
      listener(eventType, filename);
    }, CALLBACK_DELAY_MS);
  };
  return originalWatch(...[
    ...args.slice(0, -1),
    wrapped
  ] as Parameters<typeof fs.watch>);
}) as typeof fs.watch;

mock.module("node:fs", () => ({
  ...fs,
  default: { ...fs, watch: delayedWatch },
  watch: delayedWatch
}));
