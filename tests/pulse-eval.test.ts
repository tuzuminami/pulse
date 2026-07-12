import { mkdtemp, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepEqual, equal, ok, rejects, throws } from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compareShadowReplay,
  compareRunToBaseline,
  createDecisionReceipt,
  createBaseline,
  readStore,
  registerDeterministicEvaluator,
  runEvaluationSuite,
  saveBaseline,
  saveRun,
  saveSuite,
  validateDecisionReceipt,
  validateSuite
} from "../src/index.js";

import type { CreateDecisionReceiptOptions, DecisionReceiptKeyResolver, DecisionResult, EvalRun, EvalSuiteVersion, ShadowReplayVerificationContext } from "../src/index.js";

const suite: EvalSuiteVersion = {
  suiteId: "public-demo-suite",
  version: "1.0.0",
  status: "published",
  cases: [
    {
      id: "case-hello",
      input: {
        path: "/chat",
        method: "POST",
        body: { prompt: "hello" }
      },
      expected: {
        jsonFieldEquals: {
          field: "message",
          value: "hello accepted"
        }
      },
      tags: ["smoke"],
      classification: "public"
    }
  ],
  thresholds: {
    minPassRate: 1,
    maxInconclusiveRate: 0
  }
};

const decision: DecisionResult = {
  outcome: "allow",
  reasonCode: "POLICY_REQUIREMENT_MET",
  policyReference: "veil/access-policy@2026-07-12"
};

const receiptOptions: CreateDecisionReceiptOptions = {
  tenantId: "tenant_demo",
  subjectHash: "a".repeat(64),
  issuedAt: "2026-07-12T00:00:00.000Z",
  signer: {
    keyId: "pulse-v1-test",
    key: "pulse-v1-test-signing-key"
  }
};

const replayContext: ShadowReplayVerificationContext = {
  tenantId: receiptOptions.tenantId,
  subjectHash: receiptOptions.subjectHash,
  keyResolver: (tenantId, keyId) =>
    tenantId === receiptOptions.tenantId && keyId === receiptOptions.signer.keyId
      ? receiptOptions.signer.key
      : undefined
};

describe("PULSE evaluation MVP", () => {
  const baseUrl = "http://deterministic-target.local";
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === `${baseUrl}/chat` && init?.method === "POST") {
      return new Response(JSON.stringify({ message: "hello accepted" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };

  it("AT-PULSE-001 runs a suite, stores redacted trace, and passes baseline", async () => {
    const run = await runEvaluationSuite({
      suite,
      target: {
        baseUrl,
        timeoutMs: 1000
      },
      idGenerator: () => "run_demo",
      correlationId: "corr_demo",
      now: () => 100,
      fetchImpl
    });
    const baseline = createBaseline(suite, "baseline_demo");
    const regression = compareRunToBaseline(run, baseline);

    equal(run.status, "passed");
    equal(regression.status, "passed");
    equal(regression.ciExitCode, 0);
    equal(run.caseResults[0]?.trace.request.bodyHash.length, 64);
    deepEqual(Object.keys(run.caseResults[0]?.trace.request ?? {}).sort(), ["bodyHash", "method", "path"]);
  });

  it("TEST-TARGET-URL-001 joins a trailing-slash base URL and leading-slash case path safely", async () => {
    let requestedUrl: string | undefined;
    await runEvaluationSuite({
      suite,
      target: {
        baseUrl: "https://example.test/",
        timeoutMs: 1000
      },
      idGenerator: () => "run_target_url_join",
      fetchImpl: async (input) => {
        requestedUrl = String(input);
        return new Response(JSON.stringify({ message: "hello accepted" }), { status: 200 });
      }
    });

    equal(requestedUrl, "https://example.test/chat");
  });

  it("TEST-DETERMINISM-001 produces deterministic run evidence with injected boundaries", async () => {
    const runOptions = {
      suite,
      target: {
        baseUrl,
        timeoutMs: 1000
      },
      idGenerator: () => "run_deterministic",
      correlationId: "corr_deterministic",
      now: () => 100,
      fetchImpl
    };

    const firstRun: EvalRun = await runEvaluationSuite(runOptions);
    const secondRun: EvalRun = await runEvaluationSuite(runOptions);

    deepEqual(firstRun, secondRun);
  });

  it("AT-PULSE-003 verifies a signed replay receipt bound to its tenant and subject", () => {
    const receipt = createDecisionReceipt(decision, receiptOptions);
    const comparison = compareShadowReplay(receipt, decision, replayContext);

    equal(comparison.status, "passed");
    equal(comparison.ciExitCode, 0);
    deepEqual(comparison.violations, []);
    ok(!JSON.stringify(receipt).includes("request"));
    ok(!JSON.stringify(receipt).includes("response"));
    ok(!JSON.stringify(receipt).includes(String(receiptOptions.signer.key)));
  });

  it("TEST-SHADOW-REPLAY-001 returns stable CI violations for replay differences", () => {
    const receipt = createDecisionReceipt(decision, receiptOptions);
    const comparison = compareShadowReplay(receipt, {
      outcome: "deny",
      reasonCode: "POLICY_REQUIREMENT_DENIED",
      policyReference: "veil/access-policy@2026-07-13"
    }, replayContext);

    equal(comparison.status, "failed");
    equal(comparison.ciExitCode, 1);
    deepEqual(comparison.violations, [
      "DECISION_OUTCOME_MISMATCH",
      "DECISION_REASON_CODE_MISMATCH",
      "POLICY_REFERENCE_MISMATCH"
    ]);
  });

  it("TEST-SHADOW-REPLAY-002 rejects a tampered receipt with a recomputed plain digest", () => {
    const receipt = createDecisionReceipt(decision, receiptOptions);
    const tampered = {
      ...receipt,
      policyReference: "veil/access-policy@tampered",
      signature: createHash("sha256").update("attacker-recomputed-digest", "utf8").digest("hex")
    };

    throws(() => validateDecisionReceipt(tampered, replayContext.keyResolver), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "DECISION_RECEIPT_INVALID_SIGNATURE"
    );
    throws(() => compareShadowReplay(tampered, decision, replayContext), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "DECISION_RECEIPT_INVALID_SIGNATURE"
    );
  });

  it("TEST-SHADOW-REPLAY-004 rejects unknown fields and unknown signing keys", () => {
    const receipt = { ...createDecisionReceipt(decision, receiptOptions), request: "raw-prompt" };

    throws(() => validateDecisionReceipt(receipt, replayContext.keyResolver), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "INVALID_DECISION_RECEIPT"
    );
    throws(() => compareShadowReplay({ ...receipt, keyId: "unknown-key" }, decision, replayContext), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "INVALID_DECISION_RECEIPT"
    );
    throws(() => compareShadowReplay({ ...createDecisionReceipt(decision, receiptOptions), keyId: "unknown-key" }, decision, replayContext), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "DECISION_RECEIPT_UNKNOWN_KEY"
    );
  });

  it("TEST-SHADOW-REPLAY-003 creates deterministic signed receipts and comparisons", () => {
    const firstReceipt = createDecisionReceipt(decision, receiptOptions);
    const secondReceipt = createDecisionReceipt(decision, receiptOptions);

    deepEqual(firstReceipt, secondReceipt);
    deepEqual(
      compareShadowReplay(firstReceipt, decision, replayContext),
      compareShadowReplay(secondReceipt, decision, replayContext)
    );
  });

  it("TEST-SHADOW-REPLAY-005 rejects receipts from another tenant or subject", () => {
    const receipt = createDecisionReceipt(decision, receiptOptions);
    let resolvedKey = false;

    throws(
      () => compareShadowReplay(receipt, decision, {
        ...replayContext,
        tenantId: "tenant_other",
        keyResolver: () => {
          resolvedKey = true;
          return receiptOptions.signer.key;
        }
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "DECISION_RECEIPT_TENANT_MISMATCH"
    );
    equal(resolvedKey, false);
    throws(() => compareShadowReplay(receipt, decision, { ...replayContext, subjectHash: "b".repeat(64) }), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "DECISION_RECEIPT_SUBJECT_MISMATCH"
    );
  });

  it("TEST-SHADOW-REPLAY-006 binds receipt key resolution to the verified replay tenant", () => {
    const tenantAOnlyKey = "tenant-a-only-signing-key";
    const tenantBReceipt = createDecisionReceipt(decision, {
      ...receiptOptions,
      tenantId: "tenant_b",
      signer: { keyId: "shared-key-id", key: tenantAOnlyKey }
    });
    const keyring: DecisionReceiptKeyResolver = (tenantId, keyId) =>
      tenantId === "tenant_a" && keyId === "shared-key-id" ? tenantAOnlyKey : undefined;

    throws(
      () => compareShadowReplay(tenantBReceipt, decision, {
        tenantId: "tenant_b",
        subjectHash: receiptOptions.subjectHash,
        keyResolver: keyring
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "DECISION_RECEIPT_UNKNOWN_KEY"
    );
  });

  it("TEST-VALIDATION-001 rejects malformed evaluation cases before execution", () => {
    const malformedSuite: EvalSuiteVersion = {
      ...suite,
      cases: [
        {
          ...suite.cases[0]!,
          input: {
            ...suite.cases[0]!.input,
            path: "https://example.com/chat"
          }
        }
      ]
    };

    throws(() => validateSuite(malformedSuite), /relative HTTP path/);
  });

  it("TEST-VALIDATION-002 rejects unsafe target URLs before persistence", async () => {
    await rejects(
      () =>
        runEvaluationSuite({
          suite,
          target: {
            baseUrl: "https://user:pass@example.test/chat?token=secret",
            timeoutMs: 1000
          },
          fetchImpl
        }),
      /credentials, query, or fragment/
    );
  });

  it("TEST-EVALUATOR-001 treats evaluator failures as failed cases", async () => {
    const evaluatorRegistry = registerDeterministicEvaluator(
      { evaluators: [] },
      {
        kind: "jsonFieldEquals",
        evaluate: () => {
          throw new Error("synthetic evaluator failure");
        }
      }
    );
    const run = await runEvaluationSuite({
      suite,
      target: {
        baseUrl,
        timeoutMs: 1000
      },
      idGenerator: () => "run_evaluator_failure",
      evaluatorRegistry,
      fetchImpl: async () =>
        new Response(JSON.stringify({ message: "hello accepted" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    });

    equal(run.status, "failed");
    equal(run.caseResults[0]?.outcome, "fail");
  });

  it("AT-PULSE-002 returns non-zero CI outcome on baseline regression", async () => {
    const firstCase = suite.cases[0];
    if (!firstCase) {
      throw new Error("test fixture is missing a case");
    }
    const regressedSuite: EvalSuiteVersion = {
      ...suite,
      cases: [
        {
          ...firstCase,
          expected: {
            jsonFieldEquals: {
              field: "message",
              value: "different"
            }
          }
        }
      ]
    };

    const run = await runEvaluationSuite({
      suite: regressedSuite,
      target: {
        baseUrl,
        timeoutMs: 1000
      },
      idGenerator: () => "run_regression",
      fetchImpl
    });
    const regression = compareRunToBaseline(run, createBaseline(regressedSuite, "baseline_regression"));

    equal(regression.status, "failed");
    equal(regression.ciExitCode, 1);
    deepEqual(regression.violations, ["PASS_RATE_BELOW_BASELINE"]);
  });

  it("TEST-CI-001 reports target outages as non-passing CI regressions", async () => {
    const run = await runEvaluationSuite({
      suite,
      target: {
        baseUrl,
        timeoutMs: 1000
      },
      idGenerator: () => "run_target_unavailable",
      fetchImpl: async () => {
        throw new Error("synthetic target outage");
      }
    });
    const regression = compareRunToBaseline(run, createBaseline(suite, "baseline_outage"));

    equal(run.status, "inconclusive");
    equal(run.caseResults[0]?.reasonCode, "TARGET_UNAVAILABLE");
    equal(regression.status, "failed");
    equal(regression.ciExitCode, 1);
    deepEqual(regression.violations, ["PASS_RATE_BELOW_BASELINE", "INCONCLUSIVE_RATE_ABOVE_BASELINE"]);
  });

  it("TEST-TARGET-RESPONSE-001 bounds streamed target responses and disables redirects", async () => {
    let redirect: RequestRedirect | undefined;
    const run = await runEvaluationSuite({
      suite,
      target: {
        baseUrl,
        timeoutMs: 1000,
        maxResponseBytes: 8
      },
      idGenerator: () => "run_response_too_large",
      fetchImpl: async (_input, init) => {
        redirect = init?.redirect;
        return new Response("012345678", { status: 200 });
      }
    });

    equal(redirect, "manual");
    equal(run.status, "failed");
    equal(run.caseResults[0]?.outcome, "error");
    equal(run.caseResults[0]?.reasonCode, "TARGET_RESPONSE_TOO_LARGE");
    equal(run.caseResults[0]?.trace.response.bodyHash.length, 64);
  });

  it("TEST-TARGET-TIMEOUT-001 applies the deadline while reading and cancels a stalled response stream", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
      },
      cancel() {
        cancelled = true;
      }
    });
    const run = await runEvaluationSuite({
      suite,
      target: { baseUrl, timeoutMs: 10 },
      idGenerator: () => "run_target_timeout",
      fetchImpl: async () => new Response(body, { status: 200 })
    });

    equal(cancelled, true);
    equal(run.status, "inconclusive");
    equal(run.caseResults[0]?.outcome, "inconclusive");
    equal(run.caseResults[0]?.reasonCode, "TARGET_TIMEOUT");
  });

  it("TEST-AUDIT-001 persists suites, runs, and baselines without raw response text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pulse-store-"));
    const storePath = join(dir, "store.json");
    const run = await runEvaluationSuite({
      suite,
      target: {
        baseUrl,
        timeoutMs: 1000
      },
      idGenerator: () => "run_store",
      fetchImpl
    });
    const baseline = createBaseline(suite, "baseline_store");

    await saveSuite(storePath, suite);
    await saveRun(storePath, run);
    await saveBaseline(storePath, baseline);

    const snapshot = await readStore(storePath);
    const raw = await readFile(storePath, "utf8");

    equal(snapshot.suites.length, 1);
    equal(snapshot.runs.length, 1);
    equal(snapshot.baselines.length, 1);
    equal(snapshot.auditEvents.length, 3);
    equal(snapshot.outboxEvents.length, 3);
    ok(!JSON.stringify(snapshot.runs).includes("hello accepted"));
    ok(raw.includes("bodyHash"));
  });
});
