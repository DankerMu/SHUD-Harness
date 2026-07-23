import { openWorkspaceLocalTokenAuthority } from "./local-token-store";
import {
  LOCAL_TOKEN_MAX_BYTES,
  LocalTokenStorageError,
  type WorkspaceLocalTokenAuthority
} from "./local-token-types";

export const LOCAL_AUTH_ENVIRONMENT_VARIABLE = "HARNESS_LOCAL_TOKEN" as const;

export interface EnvironmentLocalTokenAuthority {
  readonly source: "environment";
  readonly token: string;
  assertCurrent(): void;
}

export type LocalTokenAuthority =
  | EnvironmentLocalTokenAuthority
  | WorkspaceLocalTokenAuthority;

export interface ResolveLocalTokenAuthorityInput {
  readonly workspaceRoot: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export function resolveLocalTokenAuthority(
  input: ResolveLocalTokenAuthorityInput
): LocalTokenAuthority {
  const environment = input.environment ?? process.env;
  const configuredToken = environment[LOCAL_AUTH_ENVIRONMENT_VARIABLE];
  if (configuredToken !== undefined) {
    assertTransportSafeLocalToken(configuredToken);
    return Object.freeze({
      source: "environment" as const,
      token: configuredToken,
      assertCurrent(): void {}
    });
  }

  return openWorkspaceLocalTokenAuthority({ workspaceRoot: input.workspaceRoot });
}

export function assertTransportSafeLocalToken(token: string): void {
  const bytes = Buffer.from(token, "utf8");
  if (
    token.length === 0 ||
    bytes.byteLength > LOCAL_TOKEN_MAX_BYTES ||
    [...token].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint < 0x21 || codePoint > 0x7e || codePoint === 0x2c;
    }) ||
    !Buffer.from(token, "utf8").equals(bytes)
  ) {
    throw new LocalTokenStorageError();
  }

  try {
    const headers = new Headers();
    headers.set("Authorization", `Bearer ${token}`);
    if (headers.get("Authorization") !== `Bearer ${token}`) {
      throw new LocalTokenStorageError();
    }
  } catch {
    throw new LocalTokenStorageError();
  }
}
