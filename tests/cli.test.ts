import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { deepEqual, equal } from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createBaseline,
  createDecisionReceipt,
  runEvaluationSuite,
  saveBaseline,
  saveRun
} from "../src/index.js";

import type { CreateDecisionReceiptOptions, DecisionResult, EvalSuiteVersion, WriteContext } from "../src/index.js";

const suite: EvalSuiteVersion = {
  suiteId: "cli-suite",
  version: "1.0.0",
  status: "published",
  cases: [
    {
      id: "case-cli",
      input: {
        path: "/chat",
        method: "POST",
        body: { prompt: "hello" }
      },
      expected: {
        jsonFieldEquals: {
          field: "message",
          value: "ok"
        }
      },
      tags: ["cli"],
      classification: "public"
    }
  ],
  thresholds: {
    minPassRate: 1,
    maxInconclusiveRate: 0
  }
};

const cliPath = new URL("../src/cli.js", import.meta.url);
const decision: DecisionResult = {
  outcome: "allow",
  reasonCode: "POLICY_REQUIREMENT_MET",
  policyReference: "veil/access-policy@2026-07-12"
};
const receiptOptions: CreateDecisionReceiptOptions = {
  tenantId: "tenant_cli",
  subjectHash: "a".repeat(64),
  issuedAt: "2026-07-12T00:00:00.000Z",
  signer: {
    keyId: "pulse-v1-test",
    key: "pulse-v1-test-signing-key"
  }
};
const writeContext: WriteContext = {
  tenantId: "tenant_cli",
  actorId: "actor:cli-test",
  correlationId: "corr_cli_test",
  reasonCode: "TEST_FIXTURE",
  now: () => "2026-07-13T00:00:00.000Z"
};

test("TEST-CLI-001 selects a matching baseline when stores contain multiple suites", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pulse-cli-"));
  const store = join(dir, "store.json");
  const run = await runEvaluationSuite({
    suite,
    target: { baseUrl: "http://target.local", timeoutMs: 1000 },
    fetchImpl: async () => new Response(JSON.stringify({ message: "ok" }), { status: 200 })
  });
  const otherSuite = { ...suite, suiteId: "other-cli-suite" };

  await saveBaseline(store, createBaseline(suite, "cli-baseline"), writeContext);
  await saveRun(store, run, writeContext);
  await saveBaseline(store, createBaseline(otherSuite, "other-cli-baseline"), writeContext);

  const result = spawnSync(process.execPath, [cliPath.pathname, "regression:check", "--store", store], {
    encoding: "utf8"
  });

  equal(result.status, 0);
  deepEqual(JSON.parse(result.stdout), {
    status: "passed",
    suiteId: suite.suiteId,
    suiteVersion: suite.version,
    baselineId: "cli-baseline",
    observed: run.metrics,
    violations: [],
    ciExitCode: 0
  });
});

test("TEST-CLI-002 treats an unavailable target as a non-zero run outcome", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pulse-cli-"));
  const suitePath = join(dir, "suite.json");
  await writeFile(suitePath, JSON.stringify(suite), "utf8");

  const result = spawnSync(
    process.execPath,
    [cliPath.pathname, "run", "--suite", suitePath, "--target", "http://127.0.0.1:1", "--store", join(dir, "store.json")],
    { encoding: "utf8", timeout: 5000 }
  );

  equal(result.status, 1);
  equal((JSON.parse(result.stdout) as { status: string }).status, "inconclusive");
});

test("TEST-CLI-003 verifies a signed receipt with an environment-provided key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pulse-cli-"));
  const receiptPath = join(dir, "receipt.json");
  const decisionPath = join(dir, "decision.json");
  await writeFile(receiptPath, JSON.stringify(createDecisionReceipt(decision, receiptOptions)), "utf8");
  await writeFile(decisionPath, JSON.stringify(decision), "utf8");

  const result = spawnSync(
    process.execPath,
    [
      cliPath.pathname,
      "shadow:check",
      "--receipt",
      receiptPath,
      "--decision",
      decisionPath,
      "--tenant-id",
      receiptOptions.tenantId,
      "--subject-hash",
      receiptOptions.subjectHash,
      "--receipt-key-id",
      receiptOptions.signer.keyId
    ],
    {
      encoding: "utf8",
      env: { ...process.env, PULSE_RECEIPT_HMAC_KEY: String(receiptOptions.signer.key) }
    }
  );

  equal(result.status, 0);
  equal((JSON.parse(result.stdout) as { status: string }).status, "passed");
});

test("TEST-CLI-004 compares a VEIL receipt without a PULSE HMAC key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pulse-cli-"));
  const receiptPath = join(dir, "veil-receipt.json");
  const decisionPath = join(dir, "veil-decision.json");
  const receipt = {
    receiptVersion: "veil-decision-receipt/1.0",
    decisionId: "decision_cli",
    tenantId: "tenant_cli",
    policyId: "policy_cli",
    policyVersion: "1.0.0",
    policyHash: "policy-hash-cli",
    action: "ALLOW",
    reasonCodes: ["LOW_RISK_ALLOWED"],
    obligations: ["AUDIT_LOG"],
    inputHash: "input-hash-cli",
    evidenceHash: "evidence-hash-cli",
    correlationId: "corr-cli",
    createdAt: "2026-07-13T00:00:00.000Z",
    receiptHash: "89496b20ac96b65b9bb0b32b894ade88e7a92d18a9285fde6ef27e3f39b157d3"
  };
  await writeFile(receiptPath, JSON.stringify(receipt), "utf8");
  await writeFile(
    decisionPath,
    JSON.stringify({
      action: "ALLOW",
      policyId: "policy_cli",
      policyVersion: "1.0.0",
      policyHash: "policy-hash-cli",
      reasonCodes: ["LOW_RISK_ALLOWED"],
      obligations: ["AUDIT_LOG"],
      inputHash: "input-hash-cli",
      evidenceHash: "evidence-hash-cli"
    }),
    "utf8"
  );

  const result = spawnSync(
    process.execPath,
    [cliPath.pathname, "veil:replay-check", "--receipt", receiptPath, "--decision", decisionPath],
    { encoding: "utf8", env: { ...process.env, PULSE_RECEIPT_HMAC_KEY: "" } }
  );

  equal(result.status, 0);
  equal((JSON.parse(result.stdout) as { status: string }).status, "passed");
});
