import { AUTHORITY_WORKER_ENTRY } from "./authority-vocabulary";

const { parentPort, workerData } = await import("node:worker_threads");
const workerUrl = new URL(import.meta.url);
const queryInput = workerUrl.searchParams.get("input");
const querySentinel = workerUrl.searchParams.get("sentinel");
const workerDataRecord = typeof workerData === "object" && workerData !== null ? workerData : undefined;
const dataInput = workerDataRecord && "input" in workerDataRecord && typeof workerDataRecord.input === "string"
  ? workerDataRecord.input
  : undefined;
const dataSentinel = workerDataRecord && "sentinel" in workerDataRecord && typeof workerDataRecord.sentinel === "string"
  ? workerDataRecord.sentinel
  : undefined;
const input = queryInput ?? dataInput;
const sentinel = querySentinel ?? dataSentinel;
if (!input || !sentinel) throw new Error("AUTHORITY_WORKER_ARGUMENTS_MISSING");

const inputBytes = (await Bun.file(input).arrayBuffer()).byteLength;
await Bun.write(sentinel, AUTHORITY_WORKER_ENTRY);
const receipt = { entry: AUTHORITY_WORKER_ENTRY, inputBytes };
if (parentPort) {
  parentPort.postMessage(receipt);
} else {
  const postMessage = (globalThis as { postMessage?: (value: unknown) => void }).postMessage;
  if (!postMessage) throw new Error("AUTHORITY_WORKER_PARENT_CHANNEL_MISSING");
  postMessage(receipt);
}
