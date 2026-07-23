import {
  createBackendProductionListenOptions,
  type BackendApiOptions
} from "./routes/index";

export const BACKEND_PRODUCTION_DEFAULT_PORT = 3000 as const;

export interface BackendProductionServerOptions extends BackendApiOptions {
  readonly port?: number;
}

export function startBackendProductionServer(
  options: BackendProductionServerOptions = {}
): ReturnType<typeof Bun.serve> {
  const { port = BACKEND_PRODUCTION_DEFAULT_PORT, ...apiOptions } = options;
  return Bun.serve({
    ...createBackendProductionListenOptions(apiOptions),
    port
  });
}

if (import.meta.main) {
  startBackendProductionServer();
}
