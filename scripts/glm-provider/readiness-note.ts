import type { GlmProviderConfig } from "./smoke-core";

export const DEFAULT_READINESS_NOTE_NAME = "glm_provider_smoke.json";
export const FIXTURE_READINESS_NOTE_NAME = "glm_provider_smoke.fixture.json";
export const MAX_PRIOR_READINESS_NOTE_BYTES = 64 * 1024;

export type SmokeStatus = "passed" | "failed";

export type SmokeFailureCategory =
  | "missing_key"
  | "base_url_mismatch"
  | "http_error"
  | "invalid_response"
  | "empty_completion"
  | "oversized_response"
  | "timeout"
  | "network_error";

export interface SmokeFailure {
  category: SmokeFailureCategory;
  message: string;
  http_status?: number;
}

interface BaseReadinessNote {
  checked_at: string;
  provider_name: "glm-dmxapi";
  api_type: "openai_chat_completions";
  base_url: "https://www.dmxapi.cn/v1";
  endpoint: "https://www.dmxapi.cn/v1/chat/completions";
  smoke_model: "deepseek-v4-pro-guan";
  target_model_id: "glm-5.2";
  status: SmokeStatus;
  model_admission: false;
  secret_ref: "env:GLM_API_KEY";
  attempts: number;
  configured_base_url_hit: boolean;
  completion_nonempty: boolean;
  response_url?: "https://www.dmxapi.cn/v1/chat/completions";
  failure?: SmokeFailure;
}

export interface CanonicalReadinessNote extends BaseReadinessNote {
  schema_version: "m1.glm-provider-smoke.v1";
  kind: "glm_provider_smoke";
  evidence_scope: "canonical";
}

export interface FixtureReadinessNote extends BaseReadinessNote {
  schema_version: "m1.glm-provider-smoke.fixture.v1";
  kind: "glm_provider_smoke_fixture";
  evidence_scope: "fixture";
}

export type ReadinessNote = CanonicalReadinessNote;

export type ReadinessNoteNameFor<Scope extends "canonical" | "fixture"> = Scope extends "canonical"
  ? typeof DEFAULT_READINESS_NOTE_NAME
  : typeof FIXTURE_READINESS_NOTE_NAME;

export type SmokeRunResultFor<
  Note extends CanonicalReadinessNote | FixtureReadinessNote,
  Scope extends "canonical" | "fixture"
> =
  | {
      ok: true;
      evidenceScope: Scope;
      readinessNoteName: ReadinessNoteNameFor<Scope>;
      status: "passed";
      config: GlmProviderConfig;
      endpoint: "https://www.dmxapi.cn/v1/chat/completions";
      attempts: number;
      responseUrl: "https://www.dmxapi.cn/v1/chat/completions";
      completionNonempty: true;
      readinessNotePath: string;
      note: Note;
    }
  | {
      ok: false;
      evidenceScope: Scope;
      readinessNoteName: ReadinessNoteNameFor<Scope>;
      status: "failed";
      config: GlmProviderConfig;
      endpoint: "https://www.dmxapi.cn/v1/chat/completions";
      attempts: number;
      error: SmokeFailure;
      readinessNotePath: string;
      note: Note;
    };

export type CanonicalSmokeRunResult = SmokeRunResultFor<CanonicalReadinessNote, "canonical">;
export type FixtureSmokeRunResult = SmokeRunResultFor<FixtureReadinessNote, "fixture">;
export type SmokeRunResult = CanonicalSmokeRunResult;
