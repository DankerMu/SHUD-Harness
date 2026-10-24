import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Context, type Plugin } from "@deepseek-ai/cordis";
import { createScope } from "@deepseek-ai/dsh-scope";
import type { SessionController } from "@deepseek-ai/dsh-api-session-controller";
import type { Session, SessionId } from "@deepseek-ai/dsh-session";
import type { JobEvent, JobHandle, JobId, JobOutcome, JobSpec } from "@deepseek-ai/dsh-jobs";
import type { UserMessage } from "@deepseek-ai/dsh-llm";

export async function installScriptFixture(path: string, script: string): Promise<void> {
  await writeFile(`${path}.script`, script);
  await rm(path, { force: true });
  await symlink(
    fileURLToPath(new URL("../../../scripts/fixtures/exec-script.sh", import.meta.url)),
    path,
  );
}

export async function createHarness(
  parentDir = tmpdir(),
  sessionController: "available" | "absent" = "available",
) {
  const root = await mkdtemp(join(parentDir, "shud-jobs-test-"));
  const stateDir = join(root, "state");
  const cwd = join(root, "workspace");
  const shudBin = join(root, "shud");
  await mkdir(stateDir);
  await mkdir(cwd);
  await installScriptFixture(shudBin, "#!/bin/sh\nexit 0\n");
  const ctx = new Context();
  const sessionEvents: Array<{ type: string; data: unknown }> = [];
  const flushes: SessionId[] = [];
  const resolutions: SessionId[] = [];
  const followups: Array<{ sessionId: SessionId; message: UserMessage }> = [];
  const flushObservations: Array<{ sessionId: SessionId; messages: readonly UserMessage[] }> = [];
  const presetKey = {};
  const preset = createScope(ctx, presetKey);
  const ownerScope = createScope(ctx, {}, { parent: presetKey });
  const otherScope = createScope(ctx, {});
  // Only the opaque session-id brand is asserted; service doubles expose the consumed boundary.
  const ownerId = "session-owner" as SessionId;
  const otherId = "session-other" as SessionId;
  function createSession(id: SessionId) {
    return {
      id,
      acceptedMessages: [] as UserMessage[],
      header: { cwd },
      append(type: string, data: unknown) {
        sessionEvents.push({ type, data: structuredClone(data) });
      },
    };
  }
  function createAgent(id: SessionId, agentCtx: Context) {
    const session = createSession(id);
    return {
      id,
      ctx: agentCtx,
      session,
      followup(message: UserMessage) {
        if (!message.id || message.role !== "user")
          throw new Error("followup requires an identified user message");
        session.acceptedMessages.push(message);
        followups.push({ sessionId: id, message });
      },
    };
  }
  const owners = new Map([
    [ownerId, createAgent(ownerId, ownerScope.ctx)],
    [otherId, createAgent(otherId, otherScope.ctx)],
  ]);
  async function mountSessionController() {
    const fiber = ctx.plugin((services: Context) => {
      services.provide("sessionController", {
        resolveAgent(id: Parameters<SessionController["resolveAgent"]>[0]) {
          resolutions.push(id);
          const agent = owners.get(id);
          return Promise.resolve(
            agent
              ? { agent }
              : {
                  error: Object.assign(new Error("PRIVATE_SESSION_RESTORE_DETAIL"), {
                    code: "session/not-found" as const,
                  }),
                },
          );
        },
      });
    });
    await fiber;
    return fiber;
  }
  await ctx.plugin((services: Context) => {
    services.provide("agents", { get: (id: SessionId) => owners.get(id) });
    services.provide("sessions", {
      get: (id: SessionId) => owners.get(id)?.session,
      flush(session: Pick<Session, "id">) {
        const live = owners.get(session.id)?.session;
        if (live !== session) {
          throw new Error(`unknown live session ${session.id}`);
        }
        flushes.push(session.id);
        flushObservations.push({ sessionId: session.id, messages: [...live.acceptedMessages] });
        return Promise.resolve(true);
      },
    });
  });
  if (sessionController === "available") await mountSessionController();

  return {
    ctx,
    root,
    cwd,
    stateDir,
    shudBin,
    ownerId,
    otherId,
    sessionEvents,
    flushes,
    resolutions,
    followups,
    flushObservations,
    mountSessionController,
    presetCtx: preset.ctx,
    otherCtx: otherScope.ctx,
    config: { stateDir, shudBin },
    async apply(registry: Plugin, config: unknown) {
      const fiber = ctx.plugin(registry, config);
      await fiber;
      return fiber;
    },
    async attachController(scoped: boolean) {
      const target = scoped ? preset.ctx : ctx;
      const fiber = target.plugin({
        inject: ["jobs"],
        apply(controller: Context) {
          controller.jobs.attachController("test-job-controls");
        },
      });
      await fiber;
      return fiber;
    },
    replaceOwnerSession() {
      owners.set(ownerId, createAgent(ownerId, ownerScope.ctx));
    },
    async releaseOwner() {
      await ownerScope.dispose();
      owners.delete(ownerId);
    },
    async dispose() {
      try {
        await ctx.fiber.dispose();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

export function producer(owner?: SessionId) {
  let settle!: (outcome: JobOutcome) => void;
  const done = new Promise<JobOutcome>((resolve) => {
    settle = resolve;
  });
  const cancels: Array<string | undefined> = [];
  let handle: JobHandle | undefined;
  const spec: JobSpec = {
    kind: "bash",
    label: "controlled background task",
    ...(owner === undefined ? {} : { owner }),
    run(job) {
      handle = job;
      return {
        done,
        cancel(reason) {
          cancels.push(reason);
          settle({ status: "killed", detail: "producer cancelled" });
        },
      };
    },
  };
  return {
    spec,
    cancels,
    settle,
    append(text: string) {
      if (!handle) throw new Error("producer has not started");
      handle.append(text, { channel: "stdout" });
    },
  };
}

export async function captureEvents(
  ctx: Context,
  owners: "all" | "scope" = "all",
): Promise<JobEvent[]> {
  const events: JobEvent[] = [];
  await ctx.plugin({
    inject: ["jobs"],
    apply(services: Context) {
      services.jobs.events.subscribe({ owners }, (event) => events.push(structuredClone(event)));
    },
  });
  return events;
}

export function normalizeTrace(value: unknown, ids: readonly JobId[], key = ""): unknown {
  if (key === "startedAt" || key === "finishedAt") return "<time>";
  if (typeof value === "string") {
    return ids.reduce((text, id, index) => text.replaceAll(id, `<job-${index}>`), value);
  }
  if (Array.isArray(value)) return value.map((item: unknown) => normalizeTrace(item, ids));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]: [string, unknown]) => [
        name,
        normalizeTrace(item, ids, name),
      ]),
    );
  }
  return value;
}
