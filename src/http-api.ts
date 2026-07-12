import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";

import {
  canonicalJson,
  compareShadowReplay,
  compareRunToBaseline,
  createBaseline,
  PulseEvalError,
  readStore,
  runEvaluationSuite,
  saveIdempotencyRecord,
  saveResourceWithIdempotency,
  validateTarget
} from "./pulse-eval.js";

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type {
  DecisionReceiptKeyResolver,
  DecisionResult,
  EvalCase,
  EvalSuiteVersion
} from "./pulse-eval.js";

export interface PulseApiOptions {
  readonly storeDir: string;
  readonly targetPolicy?: PulseTargetPolicy;
  readonly authenticate: PulseAuthenticator;
  readonly receiptKeyResolver?: DecisionReceiptKeyResolver;
}

export interface PulsePrincipal {
  readonly tenantId: string;
  readonly actorId: string;
  readonly roles: readonly string[];
}

export type PulseAuthenticator = (input: {
  readonly authorization: string | undefined;
}) => PulsePrincipal | undefined | Promise<PulsePrincipal | undefined>;

export interface PulseTargetPolicy {
  readonly allows: (input: {
    readonly tenantId: string;
    readonly targetBaseUrl: string;
  }) => boolean;
  readonly fetch: typeof fetch;
}

interface RequestContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly correlationId: string;
}

export interface PulseHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
}

export interface PulseHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

const MAX_JSON_BODY_BYTES = 1024 * 1024;
const RUN_LEASE_MS = 60_000;
const tenantStoreLockTails = new Map<string, Promise<void>>();
const runExecutionLockTails = new Map<string, Promise<void>>();

export function createPulseApiServer(options: PulseApiOptions): Server {
  return createServer((request, response) => {
    void handlePulseRequest(request, response, options);
  });
}

export async function handlePulseRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: PulseApiOptions
): Promise<void> {
  const headers = normalizeHeaders(request);
  let result: PulseHttpResponse;
  const auth = await authenticate({ headers }, options);
  if ("error" in auth) {
    result = errorResponse(auth.status, auth.error, headers["x-correlation-id"]);
    response.writeHead(result.status, { "content-type": "application/json" });
    response.end(JSON.stringify(result.body));
    return;
  }

  try {
    const body = request.method === "GET" ? undefined : await readJsonBody(request);
    result = await processAuthenticatedPulseHttpRequest(
      {
        method: request.method ?? "GET",
        path: new URL(request.url ?? "/", "http://localhost").pathname,
        headers,
        body
      },
      options,
      auth
    );
  } catch {
    result = errorResponse(422, "VALIDATION_FAILED", headers["x-correlation-id"]);
  }

  response.writeHead(result.status, { "content-type": "application/json" });
  response.end(JSON.stringify(result.body));
}

export async function processPulseHttpRequest(
  request: PulseHttpRequest,
  options: PulseApiOptions
): Promise<PulseHttpResponse> {
  const context = await authenticate(request, options);
  if ("error" in context) {
    return errorResponse(context.status, context.error, request.headers["x-correlation-id"]);
  }

  return processAuthenticatedPulseHttpRequest(request, options, context);
}

async function processAuthenticatedPulseHttpRequest(
  request: PulseHttpRequest,
  options: PulseApiOptions,
  context: RequestContext
): Promise<PulseHttpResponse> {

  try {
    const storePath = tenantStorePath(options.storeDir, context.tenantId);
    const requiresIdempotency = isStateChangingRequest(request);
    const idempotencyKey = requiresIdempotency ? request.headers["idempotency-key"] : undefined;
    if (requiresIdempotency && !idempotencyKey) {
      return errorResponse(422, "IDEMPOTENCY_KEY_REQUIRED", context.correlationId);
    }

    if (request.method === "POST" && request.path === "/v1/suites") {
      return await withTenantStoreTransaction(storePath, async () => {
        const replay = await existingIdempotencyResponse(storePath, request, context);
        if (replay) return replay;
        const suite = parseSuiteBody(request.body);
        const result = dataResponse(201, { suiteId: suite.suiteId, version: suite.version }, context);
        await saveResourceWithIdempotency(storePath, suite, completedIdempotencyRecord(request, result), writeContext(context, "SUITE_PUBLISHED"));
        return result;
      });
    }

    if (request.method === "POST" && request.path === "/v1/baselines") {
      return await withTenantStoreTransaction(storePath, async () => {
        const replay = await existingIdempotencyResponse(storePath, request, context);
        if (replay) return replay;
        const body = parseBaselineBody(request.body);
        const suite = (await readStore(storePath)).suites.find((item) => item.suiteId === body.suiteId && item.version === body.suiteVersion);
        if (!suite) return errorResponse(404, "RESOURCE_NOT_FOUND", context.correlationId);
        const baseline = createBaseline(suite, body.baselineId);
        const result = dataResponse(201, baseline, context);
        await saveResourceWithIdempotency(storePath, baseline, completedIdempotencyRecord(request, result), writeContext(context, "BASELINE_REGISTERED"));
        return result;
      });
    }

    if (request.method === "POST" && request.path === "/v1/runs") {
      return await withRunExecutionLock(`${storePath}:${idempotencyKey}`, async () => {
        const prepared = await withTenantStoreTransaction(storePath, async () => {
          const replay = await existingIdempotencyResponse(storePath, request, context, true);
          if (replay) return { replay };
          const body = parseRunBody(request.body);
          validateTarget(body.target);
          const suite = (await readStore(storePath)).suites.find((item) => item.suiteId === body.suiteId && item.version === body.suiteVersion);
          if (!suite) return { replay: errorResponse(422, "VALIDATION_FAILED", context.correlationId) };
          const targetPolicy = resolveTargetPolicy(body.target.baseUrl, context, options);
          if (!targetPolicy) return { replay: errorResponse(403, "TARGET_NOT_ALLOWED", context.correlationId) };
          await saveIdempotencyRecord(storePath, pendingIdempotencyRecord(request));
          return { suite, body, targetPolicy };
        });
        if ("replay" in prepared) return prepared.replay;
        const run = await runEvaluationSuite({ suite: prepared.suite, target: prepared.body.target, correlationId: context.correlationId, fetchImpl: prepared.targetPolicy.fetch });
        const result = dataResponse(201, run, context);
        await withTenantStoreTransaction(storePath, () => saveResourceWithIdempotency(storePath, run, completedIdempotencyRecord(request, result), writeContext(context, "RUN_COMPLETED")));
        return result;
      });
    }

    if (request.method === "POST" && request.path === "/v1/shadow-replays") {
      const body = parseShadowReplayBody(request.body);
      if (!options.receiptKeyResolver) {
        return errorResponse(503, "RECEIPT_VERIFICATION_UNAVAILABLE", context.correlationId);
      }
      return dataResponse(
        200,
        compareShadowReplay(body.expectedReceipt, body.replayedDecision, {
          tenantId: context.tenantId,
          subjectHash: body.subjectHash,
          keyResolver: options.receiptKeyResolver
        }),
        context
      );
    }

    if (request.method === "GET" && request.path.startsWith("/v1/runs/")) {
      const runId = request.path.slice("/v1/runs/".length);
      const snapshot = await readStore(storePath);
      const run = snapshot.runs.find((item) => item.runId === runId);
      if (!run) {
        return errorResponse(404, "RESOURCE_NOT_FOUND", context.correlationId);
      }
      return dataResponse(200, run, context);
    }

    if (request.method === "GET" && request.path === "/v1/regressions") {
      const snapshot = await readStore(storePath);
      const run = snapshot.runs.at(-1);
      const baseline = run
        ? [...snapshot.baselines].reverse().find(
            (candidate) =>
              candidate.suiteId === run.suiteId && candidate.suiteVersion === run.suiteVersion
          )
        : undefined;
      if (!run || !baseline) {
        return errorResponse(404, "RESOURCE_NOT_FOUND", context.correlationId);
      }
      return dataResponse(200, compareRunToBaseline(run, baseline), context);
    }

    return errorResponse(404, "RESOURCE_NOT_FOUND", context.correlationId);
  } catch (error) {
    const code =
      error instanceof SyntaxError ||
      (error instanceof PulseEvalError &&
        (error.code === "VALIDATION_FAILED" ||
          error.code === "INVALID_DECISION_RECEIPT" ||
          error.code.startsWith("DECISION_RECEIPT_")))
        ? "VALIDATION_FAILED"
        : "DEPENDENCY_UNAVAILABLE";
    return errorResponse(code === "VALIDATION_FAILED" ? 422 : 503, code, context.correlationId);
  }
}

async function authenticate(
  request: Pick<PulseHttpRequest, "headers">,
  options: PulseApiOptions
): Promise<RequestContext | { readonly status: 401 | 403; readonly error: string }> {
  const tenantId = request.headers["x-tenant-id"];
  const correlationId = request.headers["x-correlation-id"] ?? "corr_generated";
  if (!tenantId) {
    return { status: 401, error: "AUTHENTICATION_REQUIRED" };
  }

  let principal: PulsePrincipal | undefined;
  try {
    principal = await options.authenticate({ authorization: request.headers.authorization });
  } catch {
    return { status: 401, error: "AUTHENTICATION_REQUIRED" };
  }
  if (!principal) {
    return { status: 401, error: "AUTHENTICATION_REQUIRED" };
  }

  if (
    principal.tenantId !== tenantId ||
    !isSafeTenantId(tenantId) ||
    !isSafeTenantId(principal.tenantId) ||
    !principal.roles.includes("operator")
  ) {
    return { status: 403, error: "TENANT_SCOPE_DENIED" };
  }

  return { tenantId: principal.tenantId, actorId: principal.actorId, correlationId };
}

function normalizeHeaders(request: IncomingMessage): Readonly<Record<string, string | undefined>> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    result[key] = Array.isArray(value) ? value[0] : value;
  }
  return result;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      throw new PulseEvalError("VALIDATION_FAILED", "Request body exceeds the maximum size.");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseSuiteBody(body: unknown): EvalSuiteVersion {
  const record = requireRecord(body);
  const cases = requireArray(record.cases, "cases").map((item) => parseCase(item));
  const thresholds = requireRecord(record.thresholds);
  return {
    suiteId: requireString(record.suiteId, "suiteId"),
    version: requireString(record.version, "version"),
    status: requireLiteral(record.status, "published", "status"),
    cases,
    thresholds: {
      minPassRate: requireNumber(thresholds.minPassRate, "thresholds.minPassRate"),
      maxInconclusiveRate: requireNumber(thresholds.maxInconclusiveRate, "thresholds.maxInconclusiveRate")
    }
  };
}

function parseCase(value: unknown): EvalCase {
  const record = requireRecord(value);
  const input = requireRecord(record.input);
  const expected = requireRecord(record.expected);
  const jsonFieldEquals =
    expected.jsonFieldEquals === undefined
      ? undefined
      : parseJsonFieldEquals(expected.jsonFieldEquals);
  return {
    id: requireString(record.id, "case.id"),
    input: {
      path: requireString(input.path, "case.input.path"),
      method: requireLiteral(input.method, "POST", "case.input.method"),
      body: requireRecord(input.body)
    },
    expected: {
      ...(expected.contains === undefined ? {} : { contains: requireString(expected.contains, "case.expected.contains") }),
      ...(jsonFieldEquals ? { jsonFieldEquals } : {})
    },
    tags: requireArray(record.tags, "case.tags").map((item) => requireString(item, "case.tags[]")),
    classification: requireClassification(record.classification)
  };
}

function parseJsonFieldEquals(value: unknown): EvalCase["expected"]["jsonFieldEquals"] {
  const record = requireRecord(value);
  const expectedValue = record.value;
  if (
    typeof expectedValue !== "string" &&
    typeof expectedValue !== "number" &&
    typeof expectedValue !== "boolean" &&
    expectedValue !== null
  ) {
    throw validation("case.expected.jsonFieldEquals.value");
  }
  return {
    field: requireString(record.field, "case.expected.jsonFieldEquals.field"),
    value: expectedValue
  };
}

function parseBaselineBody(body: unknown): { readonly suiteId: string; readonly suiteVersion: string; readonly baselineId: string | undefined } {
  const record = requireRecord(body);
  return {
    suiteId: requireString(record.suiteId, "suiteId"),
    suiteVersion: requireString(record.suiteVersion, "suiteVersion"),
    baselineId: record.baselineId === undefined ? undefined : requireString(record.baselineId, "baselineId")
  };
}

function parseRunBody(body: unknown): { readonly suiteId: string; readonly suiteVersion: string; readonly target: { readonly baseUrl: string; readonly timeoutMs: number; readonly maxResponseBytes?: number } } {
  const record = requireRecord(body);
  const target = requireRecord(record.target);
  return {
    suiteId: requireString(record.suiteId, "suiteId"),
    suiteVersion: requireString(record.suiteVersion, "suiteVersion"),
    target: {
      baseUrl: requireString(target.baseUrl, "target.baseUrl"),
      timeoutMs: requireNumber(target.timeoutMs, "target.timeoutMs"),
      ...(target.maxResponseBytes === undefined ? {} : { maxResponseBytes: requireNumber(target.maxResponseBytes, "target.maxResponseBytes") })
    }
  };
}

function parseShadowReplayBody(body: unknown): {
  readonly expectedReceipt: unknown;
  readonly replayedDecision: DecisionResult;
  readonly subjectHash: string;
} {
  const record = requireRecord(body);
  rejectUnexpectedKeys(record, ["expectedReceipt", "replayedDecision", "subjectHash"], "body");
  return {
    expectedReceipt: record.expectedReceipt,
    replayedDecision: parseDecisionResult(record.replayedDecision, "replayedDecision"),
    subjectHash: requireString(record.subjectHash, "subjectHash")
  };
}

function parseDecisionResult(value: unknown, field: string): DecisionResult {
  const record = requireRecord(value);
  rejectUnexpectedKeys(record, ["outcome", "reasonCode", "policyReference"], field);
  const outcome = record.outcome;
  if (outcome !== "allow" && outcome !== "deny") {
    throw validation(`${field}.outcome`);
  }
  return {
    outcome,
    reasonCode: requireString(record.reasonCode, `${field}.reasonCode`),
    policyReference: requireString(record.policyReference, `${field}.policyReference`)
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw validation("body");
  }
  return value as Record<string, unknown>;
}

function rejectUnexpectedKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  field: string
): void {
  if (Object.keys(value).some((key) => !expectedKeys.includes(key))) {
    throw validation(field);
  }
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw validation(field);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validation(field);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw validation(field);
  }
  return value;
}

function requireLiteral<T extends string>(value: unknown, expected: T, field: string): T {
  if (value !== expected) {
    throw validation(field);
  }
  return expected;
}

function requireClassification(value: unknown): EvalCase["classification"] {
  if (value === "public" || value === "internal" || value === "confidential") {
    return value;
  }
  throw validation("case.classification");
}

function validation(field: string): PulseEvalError {
  return new PulseEvalError("VALIDATION_FAILED", `Invalid ${field}.`);
}

function dataResponse(
  status: number,
  data: unknown,
  context: RequestContext
): PulseHttpResponse {
  return {
    status,
    body: {
      data,
      meta: {
        requestId: "req_generated",
        correlationId: context.correlationId,
        apiVersion: "v1"
      }
    }
  };
}

function errorResponse(
  status: number,
  code: string,
  correlationId: string | string[] | undefined
): PulseHttpResponse {
  return {
    status,
    body: {
      error: {
        code,
        message: "Request cannot be completed.",
        details: [],
        correlationId: Array.isArray(correlationId) ? correlationId[0] : correlationId ?? "corr_generated"
      }
    }
  };
}

function tenantStorePath(storeDir: string, tenantId: string): string {
  return join(storeDir, `${tenantId}.json`);
}

function isSafeTenantId(tenantId: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,127}$/.test(tenantId);
}

function isStateChangingRequest(request: Pick<PulseHttpRequest, "method" | "path">): boolean {
  return request.method === "POST" && request.path !== "/v1/shadow-replays";
}

function resolveTargetPolicy(
  targetBaseUrl: string,
  context: RequestContext,
  options: PulseApiOptions
): PulseTargetPolicy | undefined {
  const targetPolicy = options.targetPolicy;
  if (!targetPolicy) {
    return undefined;
  }
  try {
    return targetPolicy.allows({
      tenantId: context.tenantId,
      targetBaseUrl
    }) ? targetPolicy : undefined;
  } catch {
    return undefined;
  }
}

async function acquireTenantStoreLock(storePath: string): Promise<() => void> {
  const previous = tenantStoreLockTails.get(storePath) ?? Promise.resolve();
  let releaseCurrent: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.then(() => current);
  tenantStoreLockTails.set(storePath, tail);
  await previous;

  return () => {
    releaseCurrent?.();
    if (tenantStoreLockTails.get(storePath) === tail) {
      tenantStoreLockTails.delete(storePath);
    }
  };
}

async function withTenantStoreTransaction<T>(storePath: string, operation: () => Promise<T>): Promise<T> {
  const release = await acquireTenantStoreLock(storePath);
  try {
    return await operation();
  } finally {
    release();
  }
}

async function withRunExecutionLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = runExecutionLockTails.get(key) ?? Promise.resolve();
  let releaseCurrent: (() => void) | undefined;
  const current = new Promise<void>((resolve) => { releaseCurrent = resolve; });
  const tail = previous.then(() => current);
  runExecutionLockTails.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    releaseCurrent?.();
    if (runExecutionLockTails.get(key) === tail) runExecutionLockTails.delete(key);
  }
}

async function existingIdempotencyResponse(
  storePath: string,
  request: PulseHttpRequest,
  context: RequestContext,
  recoverExpiredRunReservation = false
): Promise<PulseHttpResponse | undefined> {
  const key = request.headers["idempotency-key"];
  if (!key) return undefined;
  const existing = (await readStore(storePath)).idempotencyRecords.find(
    (item) => item.key === key && item.method === request.method && item.path === request.path
  );
  if (!existing) return undefined;
  if (existing.requestHash !== hashForIdempotency(request.body ?? null)) {
    return errorResponse(409, "IDEMPOTENCY_KEY_CONFLICT", context.correlationId);
  }
  if (existing.status === "pending") {
    if (recoverExpiredRunReservation && isLeaseExpired(existing.leaseExpiresAt)) return undefined;
    return errorResponse(503, "IDEMPOTENCY_REQUEST_PENDING", context.correlationId);
  }
  return existing.response as PulseHttpResponse;
}

function isLeaseExpired(leaseExpiresAt: string | undefined): boolean {
  return leaseExpiresAt === undefined || Date.parse(leaseExpiresAt) <= Date.now();
}

function writeContext(context: RequestContext, reasonCode: string) {
  return {
    tenantId: context.tenantId,
    actorId: context.actorId,
    correlationId: context.correlationId,
    reasonCode
  };
}

function pendingIdempotencyRecord(
  request: PulseHttpRequest,
): { readonly key: string; readonly method: string; readonly path: string; readonly requestHash: string; readonly status: "pending"; readonly createdAt: string; readonly leaseExpiresAt: string } {
  const key = request.headers["idempotency-key"];
  if (!key) {
    throw new Error("State-changing requests require an idempotency key.");
  }
  const createdAt = new Date().toISOString();
  return {
    key,
    method: request.method,
    path: request.path,
    requestHash: hashForIdempotency(request.body ?? null),
    status: "pending",
    createdAt,
    leaseExpiresAt: new Date(Date.now() + RUN_LEASE_MS).toISOString()
  };
}

function completedIdempotencyRecord(
  request: PulseHttpRequest,
  response: PulseHttpResponse
): { readonly key: string; readonly method: string; readonly path: string; readonly requestHash: string; readonly status: "completed"; readonly responseHash: string; readonly response: PulseHttpResponse; readonly createdAt: string } {
  const { leaseExpiresAt: _leaseExpiresAt, ...record } = pendingIdempotencyRecord(request);
  return {
    ...record,
    status: "completed",
    responseHash: hashForIdempotency(response),
    response
  };
}

function hashForIdempotency(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
