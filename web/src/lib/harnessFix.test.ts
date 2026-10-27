import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { applyHarnessFixResult, harnessFixMode } from "./harnessFix";

describe("harnessFixMode", () => {
  it.each([
    ["binary-missing", "install"],
    ["unconfigured", "install"],
    ["version-too-low", "update"],
    ["needs-auth", "reconfigure"],
    ["readiness-error", "reconfigure"],
    ["host-unavailable", "reconfigure"],
    ["harness-unavailable", "reconfigure"],
    ["readiness-unknown", "reconfigure"],
    ["ready", "reconfigure"],
    [null, "reconfigure"],
  ])("maps %s to %s", (reason, mode) => {
    expect(harnessFixMode(reason)).toBe(mode);
  });
});

it("patches all host lists while preserving omitted account and gateway metadata", () => {
  const client = new QueryClient();
  const host = {
    host_id: "local",
    harness_accounts: { codex: { label: "Personal" } },
    gateway_inference: { codex: true },
  };
  for (const key of [["hosts"], ["hosts", "online"]])
    client.setQueryData(key, [host, { host_id: "other" }]);
  applyHarnessFixResult(client, "local", { configuredHarnesses: { "codex-native": true } });
  for (const key of [["hosts"], ["hosts", "online"]]) {
    expect(client.getQueryData(key)).toEqual([
      { ...host, configured_harnesses: { "codex-native": true } },
      { host_id: "other" },
    ]);
  }
  applyHarnessFixResult(client, "local", {
    configuredHarnesses: {},
    harnessAccounts: null,
    gatewayInference: null,
  });
  expect(client.getQueryData(["hosts"])).toEqual([
    { ...host, configured_harnesses: {}, harness_accounts: null, gateway_inference: null },
    { host_id: "other" },
  ]);
});
