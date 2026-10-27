import type { QueryClient } from "@tanstack/react-query";
import type { HarnessAccount, Host } from "@/hooks/useHosts";
import type { HarnessCredentialKind } from "@/lib/harnessSetup";

export type HarnessFixMode = "reconfigure" | "update" | "install" | "switch";

export interface HarnessFixResult {
  configuredHarnesses: Record<string, boolean | string>;
  credentialKind?: HarnessCredentialKind;
  version?: string;
  gatewayInference?: Record<string, boolean> | null;
  harnessAccounts?: Record<string, HarnessAccount> | null;
}

export function harnessFixMode(reason: string | null): HarnessFixMode {
  if (reason === "version-too-low") return "update";
  if (reason === "binary-missing" || reason === "unconfigured") return "install";
  return "reconfigure";
}

/** Apply confirmed readiness to every host-list variant used by the composer and Settings. */
export function applyHarnessFixResult(
  queryClient: QueryClient,
  hostId: string,
  { configuredHarnesses, harnessAccounts, gatewayInference }: HarnessFixResult,
): void {
  queryClient.setQueriesData<Host[]>({ queryKey: ["hosts"] }, (hosts) =>
    hosts?.map((host) =>
      host.host_id === hostId
        ? {
            ...host,
            configured_harnesses: configuredHarnesses,
            ...(harnessAccounts !== undefined ? { harness_accounts: harnessAccounts } : {}),
            ...(gatewayInference !== undefined ? { gateway_inference: gatewayInference } : {}),
          }
        : host,
    ),
  );
}
