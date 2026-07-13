import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { equal, ok } from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canonicalJson,
  createDecisionReceipt,
  handlePulseRequest,
  processPulseHttpRequest,
  readStore,
  saveIdempotencyRecord
} from "../src/index.js";

import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  CreateDecisionReceiptOptions,
  DecisionResult,
  EvalSuiteVersion,
  PulseApiOptions,
  PulseTargetPolicy
} from "../src/index.js";

const suite: EvalSuiteVersion = {
  suiteId: "api-suite",
  version: "1.0.0",
  status: "published",
  cases: [
    {
      id: "case-api",
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
      tags: ["api"],
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
  tenantId: "tenant_a",
  subjectHash: "a".repeat(64),
  issuedAt: "2026-07-12T00:00:00.000Z",
  signer: {
    keyId: "pulse-v1-test",
    key: "pulse-v1-test-signing-key"
  }
};

describe("PULSE HTTP API", () => {
  it("TEST-API-001 enforces bearer tenant scope and runs the primary API flow", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pulse-api-"));
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ message: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    const options = { ...authenticatedOptions, storeDir, targetPolicy: allowAllTargets(fetchImpl) };
    const headers = {
      authorization: "Bearer test-token-tenant-a",
      "x-tenant-id": "tenant_a",
      "x-correlation-id": "corr_api",
      "idempotency-key": "idem-suite"
    };

    const publish = await processPulseHttpRequest(
      { method: "POST", path: "/v1/suites", headers, body: suite },
      options
    );
    equal(publish.status, 201);

    const baseline = await processPulseHttpRequest(
      {
        method: "POST",
        path: "/v1/baselines",
        headers: { ...headers, "idempotency-key": "idem-baseline" },
        body: { suiteId: "api-suite", suiteVersion: "1.0.0", baselineId: "api-baseline" }
      },
      options
    );
    equal(baseline.status, 201);

    const run = await processPulseHttpRequest(
      {
        method: "POST",
        path: "/v1/runs",
        headers: { ...headers, "idempotency-key": "idem-run" },
        body: {
          suiteId: "api-suite",
          suiteVersion: "1.0.0",
          target: { baseUrl: "http://target.local", timeoutMs: 1000 }
        }
      },
      options
    );
    equal(run.status, 201);

    const regression = await processPulseHttpRequest(
      { method: "GET", path: "/v1/regressions", headers },
      options
    );
    const body = regression.body as { data: { status: string; ciExitCode: number } };
    equal(regression.status, 200);
    equal(body.data.status, "passed");
    equal(body.data.ciExitCode, 0);

    const shadowReplay = await processPulseHttpRequest(
      {
        method: "POST",
        path: "/v1/shadow-replays",
        headers: {
          authorization: "Bearer test-token-tenant-a",
          "x-tenant-id": "tenant_a"
        },
        body: {
          expectedReceipt: createDecisionReceipt(decision, receiptOptions),
          replayedDecision: decision,
          subjectHash: receiptOptions.subjectHash
        }
      },
      options
    );
    const shadowReplayBody = shadowReplay.body as { data: { status: string; ciExitCode: number } };
    equal(shadowReplay.status, 200);
    equal(shadowReplayBody.data.status, "passed");
    equal(shadowReplayBody.data.ciExitCode, 0);

    const unsafeShadowReplay = await processPulseHttpRequest(
      {
        method: "POST",
        path: "/v1/shadow-replays",
        headers: {
          authorization: "Bearer test-token-tenant-a",
          "x-tenant-id": "tenant_a"
        },
        body: {
          expectedReceipt: { ...createDecisionReceipt(decision, receiptOptions), request: "raw-prompt" },
          replayedDecision: decision,
          subjectHash: receiptOptions.subjectHash
        }
      },
      options
    );
    equal(unsafeShadowReplay.status, 422);
  });

  it("TEST-REGRESSION-001 selects a matching baseline when a tenant stores multiple suites", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pulse-api-"));
    const headers = {
      authorization: "Bearer test-token-tenant-a",
      "x-tenant-id": "tenant_a",
      "idempotency-key": "idem-primary-suite"
    };
    await processPulseHttpRequest({ method: "POST", path: "/v1/suites", headers, body: suite }, { ...authenticatedOptions, storeDir });
    await processPulseHttpRequest(
      {
        method: "POST",
        path: "/v1/baselines",
        headers: { ...headers, "idempotency-key": "idem-primary-baseline" },
        body: { suiteId: suite.suiteId, suiteVersion: suite.version, baselineId: "primary" }
      },
      { ...authenticatedOptions, storeDir }
    );
    await processPulseHttpRequest(
      {
        method: "POST",
        path: "/v1/runs",
        headers: { ...headers, "idempotency-key": "idem-primary-run" },
        body: {
          suiteId: suite.suiteId,
          suiteVersion: suite.version,
          target: { baseUrl: "http://target.local", timeoutMs: 1000 }
        }
      },
      {
        ...authenticatedOptions,
        storeDir,
        targetPolicy: allowAllTargets(
          async () => new Response(JSON.stringify({ message: "ok" }), { status: 200 })
        )
      }
    );
    const otherSuite = { ...suite, suiteId: "other-suite" };
    await processPulseHttpRequest(
      {
        method: "POST",
        path: "/v1/suites",
        headers: { ...headers, "idempotency-key": "idem-other-suite" },
        body: otherSuite
      },
      { ...authenticatedOptions, storeDir }
    );
    await processPulseHttpRequest(
      {
        method: "POST",
        path: "/v1/baselines",
        headers: { ...headers, "idempotency-key": "idem-other-baseline" },
        body: { suiteId: otherSuite.suiteId, suiteVersion: otherSuite.version, baselineId: "other" }
      },
      { ...authenticatedOptions, storeDir }
    );

    const regression = await processPulseHttpRequest(
      { method: "GET", path: "/v1/regressions", headers },
      { ...authenticatedOptions, storeDir }
    );
    const body = regression.body as { data: { suiteId: string; status: string } };
    equal(regression.status, 200);
    equal(body.data.suiteId, suite.suiteId);
    equal(body.data.status, "passed");
  });

  it("TEST-TENANT-001 rejects a mismatched tenant token before data access", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pulse-api-"));
    const response = await processPulseHttpRequest(
      {
        method: "GET",
        path: "/v1/regressions",
        headers: {
          authorization: "Bearer test-token-tenant-a",
          "x-tenant-id": "tenant_b"
        }
      },
      { ...authenticatedOptions, storeDir }
    );

    equal(response.status, 403);
  });

  it("TEST-AUTH-001 rejects requests when no authenticator is configured", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pulse-api-"));
    const response = await processPulseHttpRequest(
      {
        method: "GET",
        path: "/v1/regressions",
        headers: {
          authorization: "Bearer test-token-tenant-a",
          "x-tenant-id": "tenant_a"
        }
      },
      { storeDir } as PulseApiOptions
    );

    equal(response.status, 401);
  });

  it("TEST-AUTH-002 rejects the forged legacy bearer format", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pulse-api-"));
    const response = await processPulseHttpRequest(
      {
        method: "GET",
        path: "/v1/regressions",
        headers: {
          authorization: "Bearer tenant:tenant_a",
          "x-tenant-id": "tenant_a"
        }
      },
      { ...authenticatedOptions, storeDir }
    );

    equal(response.status, 401);
  });

  it("TEST-AUTH-003 rejects a verified principal without the operator role", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pulse-api-"));
    const response = await processPulseHttpRequest(
      {
        method: "GET",
        path: "/v1/regressions",
        headers: {
          authorization: "Bearer test-token-observer",
          "x-tenant-id": "tenant_a"
        }
      },
      { ...authenticatedOptions, storeDir }
    );

    equal(response.status, 403);
  });

  it("TEST-TENANT-003 rejects tenant ids that would collide on storage paths", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pulse-api-"));
    const pathTraversal = await processPulseHttpRequest(
      {
        method: "GET",
        path: "/v1/regressions",
        headers: {
          authorization: "Bearer test-token-tenant-a",
          "x-tenant-id": "tenant/a"
        }
      },
      { ...authenticatedOptions, storeDir }
    );

    equal(pathTraversal.status, 403);

    const uppercaseHeader = await processPulseHttpRequest(
      {
        method: "GET",
        path: "/v1/regressions",
        headers: {
          authorization: "Bearer uppercase-principal",
          "x-tenant-id": "Tenant_A"
        }
      },
      {
        storeDir,
        authenticate: () => ({ tenantId: "Tenant_A", actorId: "actor_uppercase", roles: ["operator"] })
      }
    );
    equal(uppercaseHeader.status, 403);
  });

  it("TEST-TENANT-002 does not read another tenant's persisted run", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pulse-api-"));
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ message: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    const tenantAHeaders = {
      authorization: "Bearer test-token-tenant-a",
      "x-tenant-id": "tenant_a",
      "idempotency-key": "idem-tenant-a-suite"
    };

    await processPulseHttpRequest(
      { method: "POST", path: "/v1/suites", headers: tenantAHeaders, body: suite },
      { ...authenticatedOptions, storeDir, targetPolicy: allowAllTargets(fetchImpl) }
    );
    const run = await processPulseHttpRequest(
      {
        method: "POST",
        path: "/v1/runs",
        headers: { ...tenantAHeaders, "idempotency-key": "idem-tenant-a-run" },
        body: {
          suiteId: "api-suite",
          suiteVersion: "1.0.0",
          target: { baseUrl: "http://target.local", timeoutMs: 1000 }
        }
      },
      { ...authenticatedOptions, storeDir, targetPolicy: allowAllTargets(fetchImpl) }
    );
    const runBody = run.body as { readonly data?: { readonly runId?: unknown } };
    const runId = runBody.data?.runId;
    ok(typeof runId === "string");

    const tenantBRead = await processPulseHttpRequest(
      {
        method: "GET",
        path: `/v1/runs/${runId}`,
        headers: {
          authorization: "Bearer test-token-tenant-b",
          "x-tenant-id": "tenant_b"
        }
      },
      { ...authenticatedOptions, storeDir }
    );

    equal(tenantBRead.status, 404);
  });

  it("TEST-CONTRACT-001 rejects malformed suite body with validation failure", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pulse-api-"));
    const response = await processPulseHttpRequest(
      {
        method: "POST",
        path: "/v1/suites",
        headers: {
          authorization: "Bearer test-token-tenant-a",
          "x-tenant-id": "tenant_a",
          "idempotency-key": "idem-invalid-suite"
        },
        body: { suiteId: "bad-suite" }
      },
      { ...authenticatedOptions, storeDir }
    );

    equal(response.status, 422);
  });

  it("TEST-CONTRACT-002 rejects malformed run body with validation failure", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pulse-api-"));
    const response = await processPulseHttpRequest(
      {
        method: "POST",
        path: "/v1/runs",
        headers: {
          authorization: "Bearer test-token-tenant-a",
          "x-tenant-id": "tenant_a",
          "idempotency-key": "idem-invalid-run"
        },
        body: { suiteId: "api-suite", suiteVersion: "1.0.0", target: {} }
      },
      { ...authenticatedOptions, storeDir }
    );

    equal(response.status, 422);
  });

  it("TEST-IDEMP-VALIDATION-001 validates targets before reserving a run idempotency key", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pulse-api-"));
    const headers = {
      authorization: "Bearer test-token-tenant-a",
      "x-tenant-id": "tenant_a",
      "idempotency-key": "idem-target-validation-suite"
    };
    const options = { ...authenticatedOptions, storeDir, targetPolicy: allowAllTargets(async () => new Response(JSON.stringify({ message: "ok" }), { status: 200 })) };
    await processPulseHttpRequest({ method: "POST", path: "/v1/suites", headers, body: suite }, options);

    const runHeaders = { ...headers, "idempotency-key": "idem-target-validation-run" };
    const invalidTimeout = await processPulseHttpRequest(
      {
        method: "POST",
        path: "/v1/runs",
        headers: runHeaders,
        body: { suiteId: suite.suiteId, suiteVersion: suite.version, target: { baseUrl: "http://target.local", timeoutMs: 0 } }
      },
      options
    );
    const invalidResponseLimit = await processPulseHttpRequest(
      {
        method: "POST",
        path: "/v1/runs",
        headers: { ...headers, "idempotency-key": "idem-target-response-limit" },
        body: { suiteId: suite.suiteId, suiteVersion: suite.version, target: { baseUrl: "http://target.local", timeoutMs: 1000, maxResponseBytes: 0 } }
      },
      options
    );
    const retry = await processPulseHttpRequest(
      {
        method: "POST",
        path: "/v1/runs",
        headers: runHeaders,
        body: { suiteId: suite.suiteId, suiteVersion: suite.version, target: { baseUrl: "http://target.local", timeoutMs: 1000, maxResponseBytes: 1024 } }
      },
      options
    );
    const snapshot = await readStore(join(storeDir, "tenant_a.json"));

    equal(invalidTimeout.status, 422);
    equal(invalidResponseLimit.status, 422);
    equal(retry.status, 201);
    equal(snapshot.idempotencyRecords.filter((record) => record.path === "/v1/runs").length, 1);
  });

  it("TEST-TARGET-001 denies HTTP target execution until the self-host config allows it", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pulse-api-"));
    const headers = {
      authorization: "Bearer test-token-tenant-a",
      "x-tenant-id": "tenant_a",
      "idempotency-key": "idem-target-suite"
    };
    await processPulseHttpRequest({ method: "POST", path: "/v1/suites", headers, body: suite }, { ...authenticatedOptions, storeDir });

    const response = await processPulseHttpRequest(
      {
        method: "POST",
        path: "/v1/runs",
        headers: { ...headers, "idempotency-key": "idem-target-run" },
        body: {
          suiteId: suite.suiteId,
          suiteVersion: suite.version,
          target: { baseUrl: "http://127.0.0.1:1", timeoutMs: 1000 }
        }
      },
      { ...authenticatedOptions, storeDir }
    );

    equal(response.status, 403);
    ok(JSON.stringify(response.body).includes("TARGET_NOT_ALLOWED"));
  });

  it("TEST-IDEMP-001 replays a POST response without duplicate audit or outbox entries", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pulse-api-"));
    const headers = {
      authorization: "Bearer test-token-tenant-a",
      "x-tenant-id": "tenant_a",
      "idempotency-key": "idem-replay"
    };

    const first = await processPulseHttpRequest(
      { method: "POST", path: "/v1/suites", headers, body: suite },
      { ...authenticatedOptions, storeDir }
    );
    const second = await processPulseHttpRequest(
      { method: "POST", path: "/v1/suites", headers, body: suite },
      { ...authenticatedOptions, storeDir }
    );
    const snapshot = await readStore(join(storeDir, "tenant_a.json"));

    equal(first.status, 201);
    equal(second.status, 201);
    equal(snapshot.suites.length, 1);
    equal(snapshot.auditEvents.length, 1);
    equal(snapshot.outboxEvents.length, 1);
    equal(snapshot.idempotencyRecords.length, 1);
  });

  it("TEST-IDEMP-004 serializes concurrent run requests with the same idempotency key", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pulse-api-"));
    const headers = {
      authorization: "Bearer test-token-tenant-a",
      "x-tenant-id": "tenant_a",
      "idempotency-key": "idem-concurrent-suite"
    };
    await processPulseHttpRequest(
      { method: "POST", path: "/v1/suites", headers, body: suite },
      { ...authenticatedOptions, storeDir }
    );

    let targetCalls = 0;
    const runRequest = {
      method: "POST",
      path: "/v1/runs",
      headers: { ...headers, "idempotency-key": "idem-concurrent-run" },
      body: {
        suiteId: suite.suiteId,
        suiteVersion: suite.version,
        target: { baseUrl: "http://target.local", timeoutMs: 1000 }
      }
    } as const;
    const options = {
      ...authenticatedOptions,
      storeDir,
      targetPolicy: allowAllTargets(async () => {
        targetCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return new Response(JSON.stringify({ message: "ok" }), { status: 200 });
      })
    };

    const [first, second] = await Promise.all([
      processPulseHttpRequest(runRequest, options),
      processPulseHttpRequest(runRequest, options)
    ]);
    const snapshot = await readStore(join(storeDir, "tenant_a.json"));

    equal(first.status, 201);
    equal(second.status, 201);
    equal(targetCalls, 1);
    equal(snapshot.runs.length, 1);
    equal(snapshot.idempotencyRecords.length, 2);
  });

  it("TEST-STORE-TRANSACTION-001 preserves distinct concurrent suite writes for one tenant", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pulse-api-"));
    const headers = {
      authorization: "Bearer test-token-tenant-a",
      "x-tenant-id": "tenant_a"
    };
    const [first, second] = await Promise.all([
      processPulseHttpRequest(
        {
          method: "POST",
          path: "/v1/suites",
          headers: { ...headers, "idempotency-key": "idem-concurrent-suite-a" },
          body: suite
        },
        { ...authenticatedOptions, storeDir }
      ),
      processPulseHttpRequest(
        {
          method: "POST",
          path: "/v1/suites",
          headers: { ...headers, "idempotency-key": "idem-concurrent-suite-b" },
          body: { ...suite, suiteId: "api-suite-b" }
        },
        { ...authenticatedOptions, storeDir }
      )
    ]);
    const snapshot = await readStore(join(storeDir, "tenant_a.json"));

    equal(first.status, 201);
    equal(second.status, 201);
    equal(snapshot.suites.length, 2);
    equal(snapshot.auditEvents.length, 2);
    equal(snapshot.outboxEvents.length, 2);
    equal(snapshot.idempotencyRecords.length, 2);
  });

  it("TEST-IDEMP-PENDING-001 recovers an expired run reservation after a crashed worker", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pulse-api-"));
    const headers = {
      authorization: "Bearer test-token-tenant-a",
      "x-tenant-id": "tenant_a",
      "idempotency-key": "idem-pending-suite"
    };
    await processPulseHttpRequest(
      { method: "POST", path: "/v1/suites", headers, body: suite },
      { ...authenticatedOptions, storeDir }
    );
    const runRequest = {
      method: "POST",
      path: "/v1/runs",
      headers: { ...headers, "idempotency-key": "idem-pending-run" },
      body: {
        suiteId: suite.suiteId,
        suiteVersion: suite.version,
        target: { baseUrl: "http://target.local", timeoutMs: 1000 }
      }
    } as const;
    await saveIdempotencyRecord(join(storeDir, "tenant_a.json"), {
      key: "idem-pending-run",
      method: "POST",
      path: "/v1/runs",
      requestHash: createHash("sha256").update(canonicalJson(runRequest.body), "utf8").digest("hex"),
      status: "pending",
      createdAt: new Date(0).toISOString(),
      leaseExpiresAt: new Date(0).toISOString()
    });
    let targetCalls = 0;
    const response = await processPulseHttpRequest(runRequest, {
      ...authenticatedOptions,
      storeDir,
      targetPolicy: allowAllTargets(async () => {
        targetCalls += 1;
        return new Response(JSON.stringify({ message: "ok" }), { status: 200 });
      })
    });

    equal(response.status, 201);
    equal(targetCalls, 1);
  });

  it("TEST-IDEMP-LEASE-002 keeps a live same-key run exclusive while other tenant writes proceed", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pulse-api-"));
    const headers = { authorization: "Bearer test-token-tenant-a", "x-tenant-id": "tenant_a" };
    await processPulseHttpRequest({ method: "POST", path: "/v1/suites", headers: { ...headers, "idempotency-key": "idem-lease-suite" }, body: suite }, { ...authenticatedOptions, storeDir });
    let releaseFetch: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const runRequest = {
      method: "POST", path: "/v1/runs", headers: { ...headers, "idempotency-key": "idem-lease-run" },
      body: { suiteId: suite.suiteId, suiteVersion: suite.version, target: { baseUrl: "http://target.local", timeoutMs: 1000 } }
    } as const;
    let targetCalls = 0;
    const options = { ...authenticatedOptions, storeDir, targetPolicy: allowAllTargets(async () => {
      targetCalls += 1;
      signalStarted?.();
      await new Promise<void>((resolve) => { releaseFetch = resolve; });
      return new Response(JSON.stringify({ message: "ok" }), { status: 200 });
    }) };
    const first = processPulseHttpRequest(runRequest, options);
    await started;
    const suiteWrite = await processPulseHttpRequest(
      { method: "POST", path: "/v1/suites", headers: { ...headers, "idempotency-key": "idem-during-run" }, body: { ...suite, suiteId: "suite-during-run" } },
      options
    );
    const second = processPulseHttpRequest(runRequest, options);
    releaseFetch?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    equal(suiteWrite.status, 201);
    equal(firstResult.status, 201);
    equal(secondResult.status, 201);
    equal(targetCalls, 1);
  });

  it("TEST-HTTP-TARGET-001 passes maxResponseBytes through the HTTP run parser", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pulse-api-"));
    const headers = { authorization: "Bearer test-token-tenant-a", "x-tenant-id": "tenant_a", "idempotency-key": "idem-http-limit" };
    await processPulseHttpRequest({ method: "POST", path: "/v1/suites", headers, body: suite }, { ...authenticatedOptions, storeDir });
    const request = Readable.from([JSON.stringify({ suiteId: suite.suiteId, suiteVersion: suite.version, target: { baseUrl: "http://target.local", timeoutMs: 1000, maxResponseBytes: 1 } })]) as unknown as IncomingMessage;
    request.method = "POST";
    request.url = "/v1/runs";
    request.headers = { ...headers, "idempotency-key": "idem-http-limit-run", "content-type": "application/json" };
    const capture: { body?: string } = {};
    const response = { writeHead: () => response, end: (body: string) => { capture.body = body; return response; } } as unknown as ServerResponse;
    await handlePulseRequest(request, response, { ...authenticatedOptions, storeDir, targetPolicy: allowAllTargets(async () => new Response(JSON.stringify({ message: "ok" }), { status: 200 })) });
    ok(capture.body?.includes("TARGET_RESPONSE_TOO_LARGE"));
  });

  it("TEST-HTTP-AUTH-003 authenticates an HTTP request exactly once", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pulse-api-"));
    const request = Readable.from([]) as unknown as IncomingMessage;
    request.method = "GET";
    request.url = "/v1/regressions";
    request.headers = { authorization: "Bearer test-token-tenant-a", "x-tenant-id": "tenant_a" };
    let authenticationCalls = 0;
    const response = { writeHead: () => response, end: () => response } as unknown as ServerResponse;
    await handlePulseRequest(request, response, { storeDir, authenticate: (input) => { authenticationCalls += 1; return testAuthenticator(input); } });
    equal(authenticationCalls, 1);
  });

  it("TEST-IDEMP-003 rejects idempotency key reuse with a different payload", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pulse-api-"));
    const headers = {
      authorization: "Bearer test-token-tenant-a",
      "x-tenant-id": "tenant_a",
      "idempotency-key": "idem-conflict"
    };

    const first = await processPulseHttpRequest(
      { method: "POST", path: "/v1/suites", headers, body: suite },
      { ...authenticatedOptions, storeDir }
    );
    const second = await processPulseHttpRequest(
      {
        method: "POST",
        path: "/v1/suites",
        headers,
        body: { ...suite, suiteId: "api-suite-other" }
      },
      { ...authenticatedOptions, storeDir }
    );
    const snapshot = await readStore(join(storeDir, "tenant_a.json"));

    equal(first.status, 201);
    equal(second.status, 409);
    equal(snapshot.suites.length, 1);
  });

  it("TEST-IDEMP-002 requires idempotency keys for state-changing HTTP requests", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pulse-api-"));
    const response = await processPulseHttpRequest(
      {
        method: "POST",
        path: "/v1/suites",
        headers: {
          authorization: "Bearer test-token-tenant-a",
          "x-tenant-id": "tenant_a"
        },
        body: suite
      },
      { ...authenticatedOptions, storeDir }
    );

    equal(response.status, 422);
  });

  it("TEST-TARGET-AUTH-001 injects allowlisted credentials and trusted propagation headers for VEIL and RELAY", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pulse-api-"));
    const observedHeaders = new Map<string, Headers>();
    const targetPolicy: PulseTargetPolicy = {
      allows: () => true,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input.toString());
        observedHeaders.set(url.origin, new Headers(init?.headers));
        return new Response(JSON.stringify({ message: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      },
      headerTemplates: [
        { name: "x-tenant-id", value: "{{tenantId}}" },
        { name: "x-correlation-id", value: "{{correlationId}}" },
        { name: "idempotency-key", value: "{{idempotencyKey}}" }
      ],
      credentialHeaderNames: ["authorization", "x-relay-api-key"],
      credentialProvider: ({ targetOrigin }) =>
        targetOrigin === "https://veil.local"
          ? { headers: { authorization: "Bearer veil-fixture-secret" } }
          : { headers: { "x-relay-api-key": "relay-fixture-secret" } }
    };
    const options = {
      ...authenticatedOptions,
      storeDir,
      targetPolicy
    };
    const headers = {
      authorization: "Bearer test-token-tenant-a",
      "x-tenant-id": "tenant_a",
      "x-correlation-id": "corr_target_auth",
      "idempotency-key": "idem-auth-suite"
    };

    const publish = await processPulseHttpRequest(
      { method: "POST", path: "/v1/suites", headers, body: suite },
      options
    );
    equal(publish.status, 201);

    for (const [baseUrl, idempotencyKey] of [
      ["https://veil.local", "idem-auth-veil"],
      ["https://relay.local", "idem-auth-relay"]
    ] as const) {
      const response = await processPulseHttpRequest(
        {
          method: "POST",
          path: "/v1/runs",
          headers: { ...headers, "idempotency-key": idempotencyKey },
          body: { suiteId: suite.suiteId, suiteVersion: suite.version, target: { baseUrl, timeoutMs: 1000 } }
        },
        options
      );
      equal(response.status, 201);
    }

    const veilHeaders = observedHeaders.get("https://veil.local");
    const relayHeaders = observedHeaders.get("https://relay.local");
    equal(veilHeaders?.get("authorization"), "Bearer veil-fixture-secret");
    equal(veilHeaders?.get("x-tenant-id"), "tenant_a");
    equal(veilHeaders?.get("x-correlation-id"), "corr_target_auth");
    ok(veilHeaders?.get("idempotency-key")?.startsWith("pulse-"));
    ok(veilHeaders?.get("idempotency-key") !== "idem-auth-veil");
    equal(veilHeaders?.get("x-relay-api-key"), null);
    equal(relayHeaders?.get("authorization"), null);
    equal(relayHeaders?.get("x-relay-api-key"), "relay-fixture-secret");
    equal(relayHeaders?.get("x-tenant-id"), "tenant_a");
    equal(relayHeaders?.get("x-correlation-id"), "corr_target_auth");
    ok(relayHeaders?.get("idempotency-key")?.startsWith("pulse-"));
    ok(relayHeaders?.get("idempotency-key") !== "idem-auth-relay");

    const persisted = JSON.stringify(await readStore(join(storeDir, "tenant_a.json")));
    ok(!persisted.includes("veil-fixture-secret"));
    ok(!persisted.includes("relay-fixture-secret"));
    ok(!persisted.includes("test-token-tenant-a"));
  });

  it("TEST-TARGET-AUTH-002 returns a redacted controlled outcome when credentials are unavailable or invalid", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pulse-api-"));
    let targetCalls = 0;
    const unexpectedTargetFetch: typeof fetch = async () => {
      targetCalls += 1;
      return new Response(JSON.stringify({ message: "ok" }));
    };
    const headers = {
      authorization: "Bearer test-token-tenant-a",
      "x-tenant-id": "tenant_a",
      "idempotency-key": "idem-credential-suite"
    };
    const publish = await processPulseHttpRequest(
      { method: "POST", path: "/v1/suites", headers, body: suite },
      { ...authenticatedOptions, storeDir }
    );
    equal(publish.status, 201);

    const unavailable = await processPulseHttpRequest(
      {
        method: "POST",
        path: "/v1/runs",
        headers: { ...headers, "idempotency-key": "idem-credential-unavailable" },
        body: { suiteId: suite.suiteId, suiteVersion: suite.version, target: { baseUrl: "https://veil.local", timeoutMs: 1000 } }
      },
      {
        ...authenticatedOptions,
        storeDir,
        targetPolicy: {
          ...allowAllTargets(unexpectedTargetFetch),
          credentialProvider: () => undefined,
          credentialHeaderNames: ["authorization"]
        }
      }
    );
    equal(unavailable.status, 503);
    equal((unavailable.body as { error: { code: string } }).error.code, "TARGET_CREDENTIALS_UNAVAILABLE");

    const invalidSecret = "credential-must-not-leak";
    const invalid = await processPulseHttpRequest(
      {
        method: "POST",
        path: "/v1/runs",
        headers: { ...headers, "idempotency-key": "idem-credential-invalid" },
        body: { suiteId: suite.suiteId, suiteVersion: suite.version, target: { baseUrl: "https://relay.local", timeoutMs: 1000 } }
      },
      {
        ...authenticatedOptions,
        storeDir,
        targetPolicy: {
          ...allowAllTargets(unexpectedTargetFetch),
          credentialProvider: () => ({ headers: { "x-tenant-id": invalidSecret } }),
          credentialHeaderNames: ["x-tenant-id"]
        }
      }
    );
    equal(invalid.status, 503);
    equal((invalid.body as { error: { code: string } }).error.code, "TARGET_CREDENTIALS_INVALID");
    ok(!JSON.stringify(invalid.body).includes(invalidSecret));

    const empty = await processPulseHttpRequest(
      {
        method: "POST",
        path: "/v1/runs",
        headers: { ...headers, "idempotency-key": "idem-credential-empty" },
        body: { suiteId: suite.suiteId, suiteVersion: suite.version, target: { baseUrl: "https://relay.local", timeoutMs: 1000 } }
      },
      {
        ...authenticatedOptions,
        storeDir,
        targetPolicy: {
          ...allowAllTargets(unexpectedTargetFetch),
          credentialProvider: () => ({ headers: {} }),
          credentialHeaderNames: ["authorization"]
        }
      }
    );
    equal(empty.status, 503);
    equal((empty.body as { error: { code: string } }).error.code, "TARGET_CREDENTIALS_INVALID");

    const snapshot = await readStore(join(storeDir, "tenant_a.json"));
    ok(!JSON.stringify(snapshot).includes(invalidSecret));
    equal(snapshot.idempotencyRecords.length, 1);
    equal(targetCalls, 0);
  });

  it("TEST-HTTP-001 converts invalid JSON bodies into validation responses", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pulse-api-"));
    const request = Readable.from(["{"]) as unknown as IncomingMessage;
    request.method = "POST";
    request.url = "/v1/suites";
    request.headers = {
      authorization: "Bearer test-token-tenant-a",
      "x-tenant-id": "tenant_a",
      "idempotency-key": "idem-invalid-json",
      "content-type": "application/json"
    };
    const capture: { status?: number; body?: string } = {};
    const response = {
      writeHead: (status: number) => {
        capture.status = status;
        return response;
      },
      end: (body: string) => {
        capture.body = body;
        return response;
      }
    } as unknown as ServerResponse;

    await handlePulseRequest(request, response, { ...authenticatedOptions, storeDir });

    equal(capture.status, 422);
    ok(capture.body?.includes("VALIDATION_FAILED"));
  });

  it("TEST-HTTP-002 rejects an unauthenticated malformed request before parsing its body", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pulse-api-"));
    const request = Readable.from(["{"]) as unknown as IncomingMessage;
    request.method = "POST";
    request.url = "/v1/suites";
    request.headers = { "content-type": "application/json" };
    const capture: { status?: number; body?: string } = {};
    const response = {
      writeHead: (status: number) => {
        capture.status = status;
        return response;
      },
      end: (body: string) => {
        capture.body = body;
        return response;
      }
    } as unknown as ServerResponse;

    await handlePulseRequest(request, response, { storeDir } as PulseApiOptions);

    equal(capture.status, 401);
    ok(capture.body?.includes("AUTHENTICATION_REQUIRED"));
  });
});

const allowAllTargets = (fetchImpl: typeof fetch) => ({
  allows: () => true,
  fetch: fetchImpl
});

const testAuthenticator: PulseApiOptions["authenticate"] = ({ authorization }) => {
  const principals = {
    "Bearer test-token-tenant-a": {
      tenantId: "tenant_a",
      actorId: "actor_a",
      roles: ["operator"]
    },
    "Bearer test-token-tenant-b": {
      tenantId: "tenant_b",
      actorId: "actor_b",
      roles: ["operator"]
    },
    "Bearer test-token-observer": {
      tenantId: "tenant_a",
      actorId: "observer_a",
      roles: []
    }
  } as const;
  return authorization === undefined ? undefined : principals[authorization as keyof typeof principals];
};

const authenticatedOptions: Pick<PulseApiOptions, "authenticate" | "receiptKeyResolver"> = {
  authenticate: testAuthenticator,
  receiptKeyResolver: (tenantId, keyId) =>
    tenantId === receiptOptions.tenantId && keyId === receiptOptions.signer.keyId
      ? receiptOptions.signer.key
      : undefined
};
