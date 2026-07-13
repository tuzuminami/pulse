import { readFile } from "node:fs/promises";
import { deepEqual, equal, throws } from "node:assert/strict";
import { describe, it } from "node:test";

import {
  adaptVeilDecisionReceipt,
  compareVeilDecisionReplay,
  veilActionToOutcome
} from "../src/index.js";

const fixtureDirectory = new URL("../../tests/fixtures/", import.meta.url);

async function fixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(name, fixtureDirectory), "utf8")) as Record<string, unknown>;
}

describe("VEIL v1 decision receipt consumer", () => {
  it("TEST-VEIL-CONTRACT-001 freezes the public v1 schema shape and representative receipt", async () => {
    const schema = await fixture("veil-decision-receipt-v1.schema.json");
    const receipt = await fixture("veil-decision-receipt-v1.json");
    const properties = schema.properties as Record<string, unknown>;
    const required = schema.required as readonly string[];

    equal(properties.receiptVersion && (properties.receiptVersion as { const: string }).const, "veil-decision-receipt/1.0");
    deepEqual((properties.action as { enum: readonly string[] }).enum, ["ALLOW", "TRANSFORM", "REQUIRE_CONFIRMATION", "BLOCK", "ESCALATE"]);
    for (const field of required) equal(typeof receipt[field], field === "reasonCodes" || field === "obligations" ? "object" : "string");
    equal(adaptVeilDecisionReceipt(receipt).outcome, "allow");
  });

  it("TEST-VEIL-ADAPTER-001 maps every VEIL action exactly and fails closed on unsupported receipts", async () => {
    const receipt = await fixture("veil-decision-receipt-v1.json");
    deepEqual(
      ["ALLOW", "TRANSFORM", "REQUIRE_CONFIRMATION", "BLOCK", "ESCALATE"].map((action) => veilActionToOutcome(action as never)),
      ["allow", "deny", "deny", "deny", "deny"]
    );
    throws(() => adaptVeilDecisionReceipt({ ...receipt, receiptVersion: "veil-decision-receipt/2.0" }), /Unsupported VEIL decision receipt version/);
    throws(() => adaptVeilDecisionReceipt({ ...receipt, obligations: ["AUDIT_LOG", 1] }), /reasonCodes and obligations/);
    throws(() => adaptVeilDecisionReceipt({ ...receipt, unexpected: true }), /unsupported fields/);
  });

  it("TEST-VEIL-COMPARE-001 compares action outcome, policy evidence, obligations, reasons, and safe metadata", async () => {
    const receipt = await fixture("veil-decision-receipt-v1.json");
    const replay = {
      action: "ALLOW",
      policyId: "policy_public_fixture",
      policyVersion: "1.0.0",
      policyHash: "policy-hash-public-fixture",
      reasonCodes: ["LOW_RISK_ALLOWED"],
      obligations: ["AUDIT_LOG"],
      inputHash: "input-hash-public-fixture",
      evidenceHash: "evidence-hash-public-fixture",
      tenantId: "tenant_public_fixture",
      correlationId: "corr-public-fixture"
    } as const;

    const match = compareVeilDecisionReplay(receipt, replay);
    equal(match.status, "passed");
    equal(match.ciExitCode, 0);
    deepEqual(match.violations, []);

    const mismatch = compareVeilDecisionReplay(receipt, {
      ...replay,
      action: "BLOCK",
      policyId: "other-policy",
      policyVersion: "2.0.0",
      policyHash: "other-policy-hash",
      inputHash: "other-input-hash",
      evidenceHash: "other-evidence-hash",
      obligations: [],
      reasonCodes: ["POLICY_DENIED"],
      tenantId: "other-tenant",
      correlationId: "other-correlation"
    });
    equal(mismatch.status, "failed");
    equal(mismatch.ciExitCode, 1);
    deepEqual(mismatch.violations, [
      "ACTION_MISMATCH",
      "ACTION_OUTCOME_MISMATCH",
      "POLICY_ID_MISMATCH",
      "POLICY_VERSION_MISMATCH",
      "POLICY_HASH_MISMATCH",
      "INPUT_HASH_MISMATCH",
      "EVIDENCE_HASH_MISMATCH",
      "OBLIGATIONS_MISMATCH",
      "REASON_CODES_MISMATCH",
      "TENANT_ID_MISMATCH",
      "CORRELATION_ID_MISMATCH"
    ]);
  });

  it("TEST-VEIL-INTEGRITY-001 rejects a tampered receipt hash or evidence", async () => {
    const receipt = await fixture("veil-decision-receipt-v1.json");
    throws(() => adaptVeilDecisionReceipt({ ...receipt, evidenceHash: "tampered-evidence" }), /hash is invalid/);
    throws(() => adaptVeilDecisionReceipt({ ...receipt, receiptHash: "0".repeat(64) }), /hash is invalid/);
  });
});
