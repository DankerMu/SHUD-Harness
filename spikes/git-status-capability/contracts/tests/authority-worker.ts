import { AUTHORITY_WORKER_ENTRY } from "./authority-vocabulary";

type WorkerChannel = "global" | "parent_port";
type WorkerConfiguration = Readonly<{ input: string; sentinel: string; channel: WorkerChannel }>;
type WorkerProbe = Readonly<{ state: "probe"; channel: WorkerChannel }>;

function workerConfiguration(value: unknown): WorkerConfiguration | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("input" in value) ||
    !("sentinel" in value) ||
    !("channel" in value)
  ) {
    return undefined;
  }
  const input = value.input;
  const sentinel = value.sentinel;
  const channel = value.channel;
  if (
    typeof input !== "string" ||
    !input ||
    typeof sentinel !== "string" ||
    !sentinel ||
    (channel !== "global" && channel !== "parent_port")
  ) {
    return undefined;
  }
  return { input, sentinel, channel };
}
function workerProbe(value: unknown): WorkerProbe | undefined {
  if (typeof value !== "object" || value === null || !("state" in value) || !("channel" in value)) {
    return undefined;
  }
  const state = value.state;
  const channel = value.channel;
  if (state !== "probe" || (channel !== "global" && channel !== "parent_port")) return undefined;
  return { state: "probe", channel };
}


// The shared fixture defers the Node-only parent-port binding so it can also load in the global Worker realm.
const { parentPort } = await import("node:worker_threads");
const workerScope = globalThis as {
  onmessage?: (event: unknown) => void;
  postMessage?: (value: unknown) => void;
};
let settled = false;

function postOnChannel(value: unknown, actualChannel: WorkerChannel): void {
  if (actualChannel === "parent_port") {
    if (!parentPort) throw new Error("AUTHORITY_WORKER_PARENT_PORT_MISSING");
    parentPort.postMessage(value);
    return;
  }
  const postMessage = workerScope.postMessage;
  if (!postMessage) throw new Error("AUTHORITY_WORKER_PARENT_CHANNEL_MISSING");
  postMessage.call(workerScope, value);
}

async function runConfiguredWorker(configuration: WorkerConfiguration, actualChannel: WorkerChannel): Promise<void> {
  const inputBytes = (await Bun.file(configuration.input).arrayBuffer()).byteLength;
  await Bun.write(configuration.sentinel, AUTHORITY_WORKER_ENTRY);
  postOnChannel({
    entry: AUTHORITY_WORKER_ENTRY,
    inputBytes,
    transport: "message",
    channel: actualChannel
  }, actualChannel);
}

function reportRunFailure(error: unknown): void {
  const failure = error instanceof Error ? error : new Error("AUTHORITY_WORKER_FAILED");
  setTimeout(() => {
    throw failure;
  }, 0);
}

function accept(value: unknown, actualChannel: WorkerChannel): void {
  if (settled) return;
  const probe = workerProbe(value);
  if (probe) {
    if (probe.channel === actualChannel) postOnChannel({ state: "ready", channel: actualChannel }, actualChannel);
    return;
  }
  const configuration = workerConfiguration(value);
  if (!configuration) {
    settled = true;
    throw new Error("AUTHORITY_WORKER_CONFIGURATION_INVALID");
  }
  if (configuration.channel !== actualChannel) return;
  settled = true;
  void runConfiguredWorker(configuration, actualChannel).catch(reportRunFailure);
}

workerScope.onmessage = (event) => {
  const value = typeof event === "object" && event !== null && "data" in event
    ? event.data
    : event;
  accept(value, "global");
};
if (parentPort) parentPort.on("message", (value) => accept(value, "parent_port"));
