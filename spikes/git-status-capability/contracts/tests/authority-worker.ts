import { AUTHORITY_WORKER_ENTRY } from "./authority-vocabulary";

const workerUrl = new URL(import.meta.url);
const input = workerUrl.searchParams.get("input");
const sentinel = workerUrl.searchParams.get("sentinel");
if (!input || !sentinel) throw new Error("AUTHORITY_WORKER_ARGUMENTS_MISSING");

await Bun.file(input).arrayBuffer();
await Bun.write(sentinel, AUTHORITY_WORKER_ENTRY);

const { parentPort } = await import("node:worker_threads");
if (parentPort) {
  parentPort.postMessage(AUTHORITY_WORKER_ENTRY);
} else {
  const postMessage = (globalThis as { postMessage?: (value: string) => void }).postMessage;
  if (!postMessage) throw new Error("AUTHORITY_WORKER_PARENT_CHANNEL_MISSING");
  postMessage(AUTHORITY_WORKER_ENTRY);
}
