import { mock } from "bun:test";
import fs, { type WatchListener } from "node:fs";
import * as fsPromises from "node:fs/promises";

export const CALLBACK_DELAY_MS = 180;

export interface DelayedWatchEvent {
  nativeAtMs: number;
  deliveredAtMs?: number;
  eventType: string;
  filename: string | null;
}

export interface DelayedWatchRegistration {
  family: "node:fs.watch" | "node:fs/promises.watch" | "node:fs.watchFile";
  path: string;
}

const delayedEvents: DelayedWatchEvent[] = [];
const registrations: DelayedWatchRegistration[] = [];
Object.assign(globalThis, {
  __issue108DelayedWatchEvents: delayedEvents,
  __issue108DelayedWatchRegistrations: registrations
});

const originalWatch = fs.watch;
const delayedWatch = ((...args: Parameters<typeof fs.watch>) => {
  registrations.push({ family: "node:fs.watch", path: String(args[0]) });
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

const originalPromisesWatch = fsPromises.watch;
const delayedPromisesWatch = ((...args: Parameters<typeof fsPromises.watch>) => {
  registrations.push({
    family: "node:fs/promises.watch",
    path: String(args[0])
  });
  return originalPromisesWatch(...args);
}) as typeof fsPromises.watch;

const originalWatchFile = fs.watchFile;
const delayedWatchFile = ((...args: unknown[]) => {
  registrations.push({ family: "node:fs.watchFile", path: String(args[0]) });
  return (originalWatchFile as (...watchFileArgs: unknown[]) => unknown)(...args);
}) as typeof fs.watchFile;

mock.module("node:fs", () => ({
  ...fs,
  default: { ...fs, watch: delayedWatch, watchFile: delayedWatchFile },
  watch: delayedWatch,
  watchFile: delayedWatchFile
}));

mock.module("node:fs/promises", () => ({
  ...fsPromises,
  watch: delayedPromisesWatch
}));
