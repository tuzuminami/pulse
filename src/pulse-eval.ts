import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type CaseOutcome = "pass" | "fail" | "inconclusive" | "error";
export type RunStatus = "passed" | "failed" | "inconclusive";
export type RegressionStatus = "passed" | "failed";
export type DecisionOutcome = "allow" | "deny";
export type ShadowReplayReasonCode =
  | "DECISION_OUTCOME_MISMATCH"
  | "DECISION_REASON_CODE_MISMATCH"
  | "POLICY_REFERENCE_MISMATCH";

export interface EvalCase {
  readonly id: string;
  readonly input: {
    readonly path: string;
    readonly method: "POST";
    readonly body: Record<string, unknown>;
  };
  readonly expected: {
    readonly contains?: string;
    readonly jsonFieldEquals?: {
      readonly field: string;
      readonly value: string | number | boolean | null;
    };
  };
  readonly tags: readonly string[];
  readonly classification: "public" | "internal" | "confidential";
}

export interface EvalSuiteVersion {
  readonly suiteId: string;
  readonly version: string;
  readonly status: "published";
  readonly cases: readonly EvalCase[];
  readonly thresholds: {
    readonly minPassRate: number;
    readonly maxInconclusiveRate: number;
  };
}

export interface TargetConfig {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes?: number;
}

export interface RedactedTrace {
  readonly request: {
    readonly path: string;
    readonly method: "POST";
    readonly bodyHash: string;
  };
  readonly response: {
    readonly status: number;
    readonly bodyHash: string;
  };
  readonly durationMs: number;
}

export interface CaseResult {
  readonly caseId: string;
  readonly outcome: CaseOutcome;
  readonly evidenceHash: string;
  readonly trace: RedactedTrace;
  readonly reasonCode: string;
}

export type EvaluatorKind = "contains" | "jsonFieldEquals";

export interface EvaluatorInput {
  readonly testCase: EvalCase;
  readonly responseText: string;
}

export interface DeterministicEvaluator {
  readonly kind: EvaluatorKind;
  readonly evaluate: (input: EvaluatorInput) => CaseOutcome;
}

export interface EvaluatorRegistry {
  readonly evaluators: readonly DeterministicEvaluator[];
}

export interface RunMetrics {
  readonly totalCases: number;
  readonly passedCases: number;
  readonly failedCases: number;
  readonly inconclusiveCases: number;
  readonly passRate: number;
  readonly inconclusiveRate: number;
}

export interface EvalRun {
  readonly runId: string;
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly targetBaseUrl: string;
  readonly status: RunStatus;
  readonly correlationId: string;
  readonly caseResults: readonly CaseResult[];
  readonly metrics: RunMetrics;
}

export interface Baseline {
  readonly baselineId: string;
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly minPassRate: number;
  readonly maxInconclusiveRate: number;
}

export interface Regression {
  readonly status: RegressionStatus;
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly baselineId: string;
  readonly observed: RunMetrics;
  readonly violations: readonly string[];
  readonly ciExitCode: 0 | 1;
}

/**
 * A redacted-safe policy decision result. It deliberately contains no request
 * or response body; policyReference must be an opaque, versioned identifier.
 */
export interface DecisionResult {
  readonly outcome: DecisionOutcome;
  readonly reasonCode: string;
  readonly policyReference: string;
}

export type HmacSha256Key = string | Uint8Array;

export interface DecisionReceiptSigner {
  readonly keyId: string;
  readonly key: HmacSha256Key;
}

export type DecisionReceiptKeyResolver = (tenantId: string, keyId: string) => HmacSha256Key | undefined;

export interface CreateDecisionReceiptOptions {
  readonly tenantId: string;
  readonly subjectHash: string;
  readonly issuedAt: string;
  readonly signer: DecisionReceiptSigner;
}

export interface ShadowReplayVerificationContext {
  readonly tenantId: string;
  readonly subjectHash: string;
  readonly keyResolver: DecisionReceiptKeyResolver;
}

/**
 * Portable, redacted evidence for a single decision. The signature covers all
 * fields except itself; receipt data never includes raw key material.
 */
export interface DecisionReceipt extends DecisionResult {
  readonly schemaVersion: "pulse.decision-receipt.v1";
  readonly tenantId: string;
  readonly subjectHash: string;
  readonly issuedAt: string;
  readonly keyId: string;
  readonly signature: string;
}

export interface ShadowReplayComparison {
  readonly status: RegressionStatus;
  readonly expectedReceiptHash: string;
  readonly replayedDecisionHash: string;
  readonly violations: readonly ShadowReplayReasonCode[];
  readonly ciExitCode: 0 | 1;
}

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export interface RunOptions {
  readonly suite: EvalSuiteVersion;
  readonly target: TargetConfig;
  readonly correlationId?: string;
  /**
   * Runtime-only target headers. They are deliberately excluded from suites,
   * traces, stored runs, audit events, and outbox events.
   */
  readonly requestHeaders?: Readonly<Record<string, string>>;
  /** Runtime-only per-case headers, for example a downstream idempotency key. */
  readonly requestHeadersForCase?: (caseId: string) => Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
  readonly evaluatorRegistry?: EvaluatorRegistry;
  readonly idGenerator?: () => string;
  readonly now?: () => number;
}

export interface PulseStoreSnapshot {
  readonly suites: readonly EvalSuiteVersion[];
  readonly runs: readonly EvalRun[];
  readonly baselines: readonly Baseline[];
  readonly auditEvents: readonly AuditEvent[];
  readonly outboxEvents: readonly OutboxEvent[];
  readonly idempotencyRecords: readonly IdempotencyRecord[];
}

export interface WriteContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly correlationId: string;
  readonly reasonCode: string;
  readonly now?: () => string;
  readonly idGenerator?: () => string;
}

export interface AuditEvent {
  readonly eventId: string;
  readonly eventType: "pulse.audit.v1";
  readonly occurredAt: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly correlationId: string;
  readonly resourceType: "suite" | "run" | "baseline";
  readonly resourceId: string;
  readonly reasonCode: string;
  readonly afterHash: string;
}

export interface OutboxEvent {
  readonly eventId: string;
  readonly eventType: "pulse.resource.changed.v1";
  readonly occurredAt: string;
  readonly tenantId: string;
  readonly correlationId: string;
  readonly resourceType: "suite" | "run" | "baseline";
  readonly resourceId: string;
  readonly payloadHash: string;
}

export interface IdempotencyRecord {
  readonly key: string;
  readonly method: string;
  readonly path: string;
  readonly requestHash: string;
  readonly status?: "pending" | "completed";
  readonly leaseExpiresAt?: string;
  readonly responseHash?: string;
  readonly response?: unknown;
  readonly createdAt: string;
}

export class PulseEvalError extends Error {
  public readonly code:
    | "VALIDATION_FAILED"
    | "INVALID_DECISION_RECEIPT"
    | "DECISION_RECEIPT_SIGNER_REQUIRED"
    | "DECISION_RECEIPT_VERIFIER_REQUIRED"
    | "DECISION_RECEIPT_UNKNOWN_KEY"
    | "DECISION_RECEIPT_INVALID_SIGNATURE"
    | "DECISION_RECEIPT_TENANT_MISMATCH"
    | "DECISION_RECEIPT_SUBJECT_MISMATCH"
    | "REDACTION_FAILED_SAFE"
    | "DEPENDENCY_UNAVAILABLE";

  public constructor(code: PulseEvalError["code"], message: string) {
    super(message);
    this.name = "PulseEvalError";
    this.code = code;
  }
}

export function validateSuite(suite: EvalSuiteVersion): void {
  requireNonEmpty(suite.suiteId, "suiteId");
  requireNonEmpty(suite.version, "version");
  if (suite.status !== "published") {
    throw new PulseEvalError("VALIDATION_FAILED", "Suite must be published before it can run.");
  }
  if (suite.cases.length === 0) {
    throw new PulseEvalError("VALIDATION_FAILED", "Suite requires at least one case.");
  }
  validateRatio(suite.thresholds.minPassRate, "minPassRate");
  validateRatio(suite.thresholds.maxInconclusiveRate, "maxInconclusiveRate");

  const ids = new Set<string>();
  for (const testCase of suite.cases) {
    requireNonEmpty(testCase.id, "case.id");
    requireNonEmpty(testCase.input.path, "case.input.path");
    if (!testCase.input.path.startsWith("/") || testCase.input.path.startsWith("//")) {
      throw new PulseEvalError("VALIDATION_FAILED", "case.input.path must be a relative HTTP path.");
    }
    if (testCase.input.path.includes("\\") || /[\u0000-\u001f]/.test(testCase.input.path)) {
      throw new PulseEvalError("VALIDATION_FAILED", "case.input.path contains unsafe URL characters.");
    }
    if (testCase.input.method !== "POST") {
      throw new PulseEvalError("VALIDATION_FAILED", "case.input.method must be POST.");
    }
    if (!isRecord(testCase.input.body)) {
      throw new PulseEvalError("VALIDATION_FAILED", "case.input.body must be an object.");
    }
    if (testCase.classification !== "public" && testCase.classification !== "internal" && testCase.classification !== "confidential") {
      throw new PulseEvalError("VALIDATION_FAILED", "case.classification is invalid.");
    }
    if (!Array.isArray(testCase.tags) || !testCase.tags.every((tag) => typeof tag === "string")) {
      throw new PulseEvalError("VALIDATION_FAILED", "case.tags must be a string array.");
    }
    if (
      testCase.expected.contains === undefined &&
      testCase.expected.jsonFieldEquals === undefined
    ) {
      throw new PulseEvalError("VALIDATION_FAILED", "case.expected must define at least one condition.");
    }
    if (testCase.expected.contains !== undefined) {
      requireNonEmpty(testCase.expected.contains, "case.expected.contains");
    }
    if (testCase.expected.jsonFieldEquals !== undefined) {
      requireNonEmpty(testCase.expected.jsonFieldEquals.field, "case.expected.jsonFieldEquals.field");
    }
    if (ids.has(testCase.id)) {
      throw new PulseEvalError("VALIDATION_FAILED", `Duplicate case id: ${testCase.id}`);
    }
    ids.add(testCase.id);
  }
}

export async function runEvaluationSuite(options: RunOptions): Promise<EvalRun> {
  validateSuite(options.suite);
  validateTarget(options.target);
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestHeaders = normalizeRuntimeRequestHeaders(options.requestHeaders);
  const evaluatorRegistry = options.evaluatorRegistry ?? createDefaultEvaluatorRegistry();
  const caseResults: CaseResult[] = [];

  for (const testCase of options.suite.cases) {
    caseResults.push(
      await executeCase(
        testCase,
        options.target,
        requestHeaders,
        options.requestHeadersForCase,
        fetchImpl,
        evaluatorRegistry,
        options.now ?? (() => Date.now())
      )
    );
  }

  const metrics = calculateMetrics(caseResults);
  const status: RunStatus =
    metrics.failedCases > 0
      ? "failed"
      : metrics.inconclusiveCases > 0
        ? "inconclusive"
        : "passed";

  return {
    runId: options.idGenerator?.() ?? randomUUID(),
    suiteId: options.suite.suiteId,
    suiteVersion: options.suite.version,
    targetBaseUrl: normalizedTargetBaseUrl(options.target.baseUrl),
    status,
    correlationId: options.correlationId ?? randomUUID(),
    caseResults,
    metrics
  };
}

export function createBaseline(
  suite: EvalSuiteVersion,
  baselineId = `${suite.suiteId}-${suite.version}`
): Baseline {
  validateSuite(suite);
  return {
    baselineId,
    suiteId: suite.suiteId,
    suiteVersion: suite.version,
    minPassRate: suite.thresholds.minPassRate,
    maxInconclusiveRate: suite.thresholds.maxInconclusiveRate
  };
}

export function compareRunToBaseline(run: EvalRun, baseline: Baseline): Regression {
  if (run.suiteId !== baseline.suiteId || run.suiteVersion !== baseline.suiteVersion) {
    throw new PulseEvalError("VALIDATION_FAILED", "Baseline scope does not match run scope.");
  }

  const violations: string[] = [];
  if (run.metrics.passRate < baseline.minPassRate) {
    violations.push("PASS_RATE_BELOW_BASELINE");
  }
  if (run.metrics.inconclusiveRate > baseline.maxInconclusiveRate) {
    violations.push("INCONCLUSIVE_RATE_ABOVE_BASELINE");
  }

  return {
    status: violations.length === 0 ? "passed" : "failed",
    suiteId: run.suiteId,
    suiteVersion: run.suiteVersion,
    baselineId: baseline.baselineId,
    observed: run.metrics,
    violations,
    ciExitCode: violations.length === 0 ? 0 : 1
  };
}

export function createDecisionReceipt(
  decision: DecisionResult,
  options?: CreateDecisionReceiptOptions
): DecisionReceipt {
  validateDecisionResult(decision, "decision");
  if (options === undefined) {
    throw new PulseEvalError("DECISION_RECEIPT_SIGNER_REQUIRED", "Decision receipt signer is required.");
  }
  validateReceiptCreationOptions(options);
  const receipt: Omit<DecisionReceipt, "signature"> = {
    schemaVersion: "pulse.decision-receipt.v1" as const,
    tenantId: options.tenantId,
    subjectHash: options.subjectHash,
    issuedAt: options.issuedAt,
    outcome: decision.outcome,
    reasonCode: decision.reasonCode,
    policyReference: decision.policyReference,
    keyId: options.signer.keyId
  };
  return {
    ...receipt,
    signature: signHmacSha256(canonicalJson(receipt), options.signer.key)
  };
}

export function validateDecisionReceipt(
  receipt: unknown,
  keyResolver?: DecisionReceiptKeyResolver
): asserts receipt is DecisionReceipt {
  validateDecisionReceiptStructure(receipt);
  if (keyResolver === undefined) {
    throw new PulseEvalError("DECISION_RECEIPT_VERIFIER_REQUIRED", "Decision receipt key resolver is required.");
  }
  const key = keyResolver(receipt.tenantId, receipt.keyId);
  if (key === undefined) {
    throw new PulseEvalError("DECISION_RECEIPT_UNKNOWN_KEY", "Decision receipt keyId is not trusted.");
  }
  if (!verifyHmacSha256(canonicalJson(receiptPayload(receipt)), receipt.signature, key)) {
    throw new PulseEvalError("DECISION_RECEIPT_INVALID_SIGNATURE", "Decision receipt signature is invalid.");
  }
}

function validateDecisionReceiptStructure(receipt: unknown): asserts receipt is DecisionReceipt {
  if (!isRecord(receipt)) {
    throw invalidDecisionReceipt("Decision receipt must be an object.");
  }
  requireExactKeys(
    receipt,
    ["schemaVersion", "tenantId", "subjectHash", "issuedAt", "outcome", "reasonCode", "policyReference", "keyId", "signature"],
    "receipt",
    invalidDecisionReceipt
  );
  if (receipt.schemaVersion !== "pulse.decision-receipt.v1") {
    throw invalidDecisionReceipt("Decision receipt schemaVersion is invalid.");
  }
  validateDecisionResult(
    receipt,
    "receipt",
    invalidDecisionReceipt,
    ["schemaVersion", "tenantId", "subjectHash", "issuedAt", "outcome", "reasonCode", "policyReference", "keyId", "signature"]
  );
  validateReceiptBinding(receipt);
  if (typeof receipt.signature !== "string" || !isSha256(receipt.signature)) {
    throw invalidDecisionReceipt("Decision receipt signature must be a SHA-256 HMAC signature.");
  }
}

export function compareShadowReplay(
  expectedReceipt: unknown,
  replayedDecision: DecisionResult,
  context?: ShadowReplayVerificationContext
): ShadowReplayComparison {
  if (context === undefined) {
    throw new PulseEvalError("DECISION_RECEIPT_VERIFIER_REQUIRED", "Shadow replay verification context is required.");
  }
  validateReplayContext(context);
  validateDecisionReceiptStructure(expectedReceipt);
  if (expectedReceipt.tenantId !== context.tenantId) {
    throw new PulseEvalError("DECISION_RECEIPT_TENANT_MISMATCH", "Decision receipt tenantId does not match replay context.");
  }
  if (expectedReceipt.subjectHash !== context.subjectHash) {
    throw new PulseEvalError("DECISION_RECEIPT_SUBJECT_MISMATCH", "Decision receipt subjectHash does not match replay context.");
  }
  validateDecisionReceipt(expectedReceipt, context.keyResolver);
  validateDecisionResult(replayedDecision, "replayedDecision");

  const violations: ShadowReplayReasonCode[] = [];
  if (replayedDecision.outcome !== expectedReceipt.outcome) {
    violations.push("DECISION_OUTCOME_MISMATCH");
  }
  if (replayedDecision.reasonCode !== expectedReceipt.reasonCode) {
    violations.push("DECISION_REASON_CODE_MISMATCH");
  }
  if (replayedDecision.policyReference !== expectedReceipt.policyReference) {
    violations.push("POLICY_REFERENCE_MISMATCH");
  }

  return {
    status: violations.length === 0 ? "passed" : "failed",
    expectedReceiptHash: sha256(canonicalJson(receiptPayload(expectedReceipt))),
    replayedDecisionHash: sha256(canonicalJson(replayedDecision)),
    violations,
    ciExitCode: violations.length === 0 ? 0 : 1
  };
}

export function signHmacSha256(payload: string, key: HmacSha256Key): string {
  return createHmac("sha256", key).update(payload, "utf8").digest("hex");
}

export function verifyHmacSha256(payload: string, signature: string, key: HmacSha256Key): boolean {
  if (!isSha256(signature)) {
    return false;
  }
  const actual = Buffer.from(signature, "hex");
  const expected = Buffer.from(signHmacSha256(payload, key), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createDefaultEvaluatorRegistry(): EvaluatorRegistry {
  return {
    evaluators: [
      {
        kind: "contains",
        evaluate: ({ testCase, responseText }) =>
          testCase.expected.contains !== undefined && responseText.includes(testCase.expected.contains)
            ? "pass"
            : "fail"
      },
      {
        kind: "jsonFieldEquals",
        evaluate: ({ testCase, responseText }) => {
          if (testCase.expected.jsonFieldEquals === undefined) {
            return "fail";
          }
          try {
            const parsed = JSON.parse(responseText) as Record<string, unknown>;
            return parsed[testCase.expected.jsonFieldEquals.field] === testCase.expected.jsonFieldEquals.value
              ? "pass"
              : "fail";
          } catch {
            return "fail";
          }
        }
      }
    ]
  };
}

export function registerDeterministicEvaluator(
  registry: EvaluatorRegistry,
  evaluator: DeterministicEvaluator
): EvaluatorRegistry {
  if (registry.evaluators.some((item) => item.kind === evaluator.kind)) {
    throw new PulseEvalError("VALIDATION_FAILED", `Evaluator already registered: ${evaluator.kind}`);
  }
  return {
    evaluators: [...registry.evaluators, evaluator]
  };
}

export async function readStore(path: string): Promise<PulseStoreSnapshot> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<PulseStoreSnapshot>;
    return {
      suites: parsed.suites ?? [],
      runs: parsed.runs ?? [],
      baselines: parsed.baselines ?? [],
      auditEvents: parsed.auditEvents ?? [],
      outboxEvents: parsed.outboxEvents ?? [],
      idempotencyRecords: parsed.idempotencyRecords ?? []
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return emptyStore();
    }
    throw error;
  }
}

export async function writeStore(path: string, snapshot: PulseStoreSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${canonicalJson(snapshot)}\n`, "utf8");
  await rename(temporaryPath, path);
}

export async function saveSuite(path: string, suite: EvalSuiteVersion, context?: WriteContext): Promise<void> {
  validateSuite(suite);
  const snapshot = await readStore(path);
  if (snapshot.suites.some((item) => item.suiteId === suite.suiteId && item.version === suite.version)) {
    throw new PulseEvalError("VALIDATION_FAILED", "Published suite versions are immutable.");
  }
  await writeStore(path, withEvidence({
    ...snapshot,
    suites: [...snapshot.suites, suite]
  }, "suite", `${suite.suiteId}@${suite.version}`, suite, context));
}

export async function saveRun(path: string, run: EvalRun, context?: WriteContext): Promise<void> {
  const snapshot = await readStore(path);
  await writeStore(path, withEvidence({
    ...snapshot,
    runs: [...snapshot.runs, run]
  }, "run", run.runId, run, context));
}

export async function saveBaseline(path: string, baseline: Baseline, context?: WriteContext): Promise<void> {
  const snapshot = await readStore(path);
  await writeStore(path, withEvidence({
    ...snapshot,
    baselines: [
      ...snapshot.baselines.filter((item) => item.baselineId !== baseline.baselineId),
      baseline
    ]
  }, "baseline", baseline.baselineId, baseline, context));
}

export async function saveIdempotencyRecord(
  path: string,
  record: IdempotencyRecord
): Promise<void> {
  const snapshot = await readStore(path);
  await writeStore(path, {
    ...snapshot,
    idempotencyRecords: [
      ...snapshot.idempotencyRecords.filter(
        (item) => item.key !== record.key || item.method !== record.method || item.path !== record.path
      ),
      record
    ]
  });
}

export async function saveResourceWithIdempotency(
  path: string,
  resource: EvalSuiteVersion | EvalRun | Baseline,
  record: IdempotencyRecord,
  context?: WriteContext
): Promise<void> {
  const snapshot = await readStore(path);
  let resourceType: AuditEvent["resourceType"];
  let resourceId: string;
  let nextSnapshot: PulseStoreSnapshot;

  if (isEvalSuiteVersion(resource)) {
    validateSuite(resource);
    if (snapshot.suites.some((item) => item.suiteId === resource.suiteId && item.version === resource.version)) {
      throw new PulseEvalError("VALIDATION_FAILED", "Published suite versions are immutable.");
    }
    resourceType = "suite";
    resourceId = `${resource.suiteId}@${resource.version}`;
    nextSnapshot = { ...snapshot, suites: [...snapshot.suites, resource] };
  } else if (isEvalRun(resource)) {
    resourceType = "run";
    resourceId = resource.runId;
    nextSnapshot = { ...snapshot, runs: [...snapshot.runs, resource] };
  } else {
    resourceType = "baseline";
    resourceId = resource.baselineId;
    nextSnapshot = {
      ...snapshot,
      baselines: [
        ...snapshot.baselines.filter((item) => item.baselineId !== resource.baselineId),
        resource
      ]
    };
  }

  await writeStore(path, {
    ...withEvidence(nextSnapshot, resourceType, resourceId, resource, context),
    idempotencyRecords: [
      ...snapshot.idempotencyRecords.filter(
        (item) => item.key !== record.key || item.method !== record.method || item.path !== record.path
      ),
      record
    ]
  });
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonicalValue(value));
}

async function executeCase(
  testCase: EvalCase,
  target: TargetConfig,
  requestHeaders: Readonly<Record<string, string>>,
  requestHeadersForCase: ((caseId: string) => Readonly<Record<string, string>>) | undefined,
  fetchImpl: typeof fetch,
  evaluatorRegistry: EvaluatorRegistry,
  now: () => number
): Promise<CaseResult> {
  const requestBody = canonicalJson(testCase.input.body);
  const startedAt = now();
  let timedOut = false;
  const targetUrl = resolveCaseTargetUrl(testCase.input.path, target.baseUrl);
  const caseRequestHeaders = normalizeRuntimeRequestHeaders({
    ...requestHeaders,
    ...(requestHeadersForCase?.(testCase.id) ?? {})
  });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, target.timeoutMs);
    try {
      const response = await fetchImpl(targetUrl, {
        method: testCase.input.method,
        headers: {
          ...caseRequestHeaders,
          "content-type": "application/json"
        },
        body: requestBody,
        signal: controller.signal,
        redirect: "manual"
      });

      const responseText = await readResponseText(
        response,
        target.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
        controller.signal
      );
      const trace = redactTrace(testCase, response.status, responseText, startedAt, now());
      const outcome = evaluateResponse(testCase, response.status, responseText, evaluatorRegistry);
      return {
        caseId: testCase.id,
        outcome,
        evidenceHash: sha256(canonicalJson({ outcome, trace })),
        trace,
        reasonCode: outcome === "pass" ? "EXPECTED_CONDITION_MET" : "EXPECTED_CONDITION_NOT_MET"
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (timedOut || error instanceof TargetTimeoutError) {
      return {
        caseId: testCase.id,
        outcome: "inconclusive",
        evidenceHash: sha256(`${testCase.id}:target-timeout`),
        trace: {
          request: {
            path: testCase.input.path,
            method: testCase.input.method,
            bodyHash: sha256(requestBody)
          },
          response: {
            status: 503,
            bodyHash: sha256("target-timeout")
          },
          durationMs: 0
        },
        reasonCode: "TARGET_TIMEOUT"
      };
    }
    if (error instanceof ResponseBodyTooLargeError) {
      return {
        caseId: testCase.id,
        outcome: "error",
        evidenceHash: sha256(`${testCase.id}:response-too-large`),
        trace: {
          request: {
            path: testCase.input.path,
            method: testCase.input.method,
            bodyHash: sha256(requestBody)
          },
          response: {
            status: error.status,
            bodyHash: sha256("response-too-large")
          },
          durationMs: 0
        },
        reasonCode: "TARGET_RESPONSE_TOO_LARGE"
      };
    }
    return {
      caseId: testCase.id,
      outcome: "inconclusive",
      evidenceHash: sha256(`${testCase.id}:target-unavailable`),
      trace: {
        request: {
          path: testCase.input.path,
          method: testCase.input.method,
          bodyHash: sha256(requestBody)
        },
        response: {
          status: 503,
          bodyHash: sha256("target-unavailable")
        },
        durationMs: 0
      },
      reasonCode: "TARGET_UNAVAILABLE"
    };
  }
}

function normalizeRuntimeRequestHeaders(headers: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  if (!headers) return {};
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (
      !/^[a-z0-9-]+$/.test(lowerName) ||
      lowerName === "content-length" ||
      lowerName === "connection" ||
      lowerName === "host" ||
      typeof value !== "string" ||
      /[\r\n]/.test(value)
    ) {
      throw new PulseEvalError("VALIDATION_FAILED", "Runtime target request headers are invalid.");
    }
    if (lowerName in normalized) {
      throw new PulseEvalError("VALIDATION_FAILED", "Runtime target request headers must not contain duplicate names.");
    }
    normalized[lowerName] = value;
  }
  return normalized;
}

function resolveCaseTargetUrl(path: string, targetBaseUrl: string): URL {
  const targetOrigin = new URL(targetBaseUrl).origin;
  const url = new URL(path, targetBaseUrl);
  if (url.origin !== targetOrigin) {
    throw new PulseEvalError("VALIDATION_FAILED", "case.input.path must resolve within target.baseUrl origin.");
  }
  return url;
}

function evaluateResponse(
  testCase: EvalCase,
  status: number,
  responseText: string,
  evaluatorRegistry: EvaluatorRegistry
): CaseOutcome {
  if (status < 200 || status >= 300) {
    return "fail";
  }
  if (testCase.expected.contains !== undefined) {
    return runEvaluator(evaluatorRegistry, "contains", testCase, responseText);
  }
  if (testCase.expected.jsonFieldEquals !== undefined) {
    return runEvaluator(evaluatorRegistry, "jsonFieldEquals", testCase, responseText);
  }
  return "inconclusive";
}

function runEvaluator(
  registry: EvaluatorRegistry,
  kind: EvaluatorKind,
  testCase: EvalCase,
  responseText: string
): CaseOutcome {
  const evaluator = registry.evaluators.find((item) => item.kind === kind);
  if (!evaluator) {
    return "fail";
  }
  try {
    return evaluator.evaluate({ testCase, responseText });
  } catch {
    return "fail";
  }
}

function redactTrace(
  testCase: EvalCase,
  status: number,
  responseText: string,
  startedAt: number,
  finishedAt: number
): RedactedTrace {
  const requestBody = canonicalJson(testCase.input.body);
  if (requestBody.length === 0) {
    throw new PulseEvalError("REDACTION_FAILED_SAFE", "Cannot redact empty request body.");
  }
  return {
    request: {
      path: testCase.input.path,
      method: testCase.input.method,
      bodyHash: sha256(requestBody)
    },
    response: {
      status,
      bodyHash: sha256(responseText)
    },
    durationMs: Math.max(0, finishedAt - startedAt)
  };
}

async function readResponseText(
  response: Response,
  maxResponseBytes: number,
  signal: AbortSignal
): Promise<string> {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await readResponseChunk(reader, signal);
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxResponseBytes) {
        await reader.cancel();
        throw new ResponseBodyTooLargeError(response.status);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      void reader.cancel().catch(() => undefined);
      reject(new TargetTimeoutError());
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

class ResponseBodyTooLargeError extends Error {
  public constructor(public readonly status: number) {
    super("Target response exceeds the configured size limit.");
    this.name = "ResponseBodyTooLargeError";
  }
}

class TargetTimeoutError extends Error {
  public constructor() {
    super("Target response exceeded the configured deadline.");
    this.name = "TargetTimeoutError";
  }
}

function calculateMetrics(results: readonly CaseResult[]): RunMetrics {
  const totalCases = results.length;
  const passedCases = results.filter((result) => result.outcome === "pass").length;
  const failedCases = results.filter((result) => result.outcome === "fail" || result.outcome === "error").length;
  const inconclusiveCases = results.filter((result) => result.outcome === "inconclusive").length;
  return {
    totalCases,
    passedCases,
    failedCases,
    inconclusiveCases,
    passRate: totalCases === 0 ? 0 : passedCases / totalCases,
    inconclusiveRate: totalCases === 0 ? 0 : inconclusiveCases / totalCases
  };
}

function validateRatio(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new PulseEvalError("VALIDATION_FAILED", `${field} must be between 0 and 1.`);
  }
}

export function validateTarget(target: TargetConfig): void {
  try {
    const url = new URL(target.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new PulseEvalError("VALIDATION_FAILED", "target.baseUrl must be an HTTP URL.");
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new PulseEvalError("VALIDATION_FAILED", "target.baseUrl must not include credentials, query, or fragment.");
    }
    if (url.pathname !== "/" && url.pathname !== "") {
      throw new PulseEvalError("VALIDATION_FAILED", "target.baseUrl must not include a path.");
    }
  } catch (error) {
    if (error instanceof PulseEvalError) {
      throw error;
    }
    throw new PulseEvalError("VALIDATION_FAILED", "target.baseUrl must be a valid URL.");
  }
  if (!Number.isInteger(target.timeoutMs) || target.timeoutMs < 1 || target.timeoutMs > 60_000) {
    throw new PulseEvalError("VALIDATION_FAILED", "target.timeoutMs must be between 1 and 60000.");
  }
  if (
    target.maxResponseBytes !== undefined &&
    (!Number.isInteger(target.maxResponseBytes) || target.maxResponseBytes < 1 || target.maxResponseBytes > 16 * 1024 * 1024)
  ) {
    throw new PulseEvalError("VALIDATION_FAILED", "target.maxResponseBytes must be between 1 and 16777216.");
  }
}

function normalizedTargetBaseUrl(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

function emptyStore(): PulseStoreSnapshot {
  return {
    suites: [],
    runs: [],
    baselines: [],
    auditEvents: [],
    outboxEvents: [],
    idempotencyRecords: []
  };
}

function isEvalSuiteVersion(resource: EvalSuiteVersion | EvalRun | Baseline): resource is EvalSuiteVersion {
  return "cases" in resource;
}

function isEvalRun(resource: EvalSuiteVersion | EvalRun | Baseline): resource is EvalRun {
  return "runId" in resource;
}

function withEvidence(
  snapshot: PulseStoreSnapshot,
  resourceType: AuditEvent["resourceType"],
  resourceId: string,
  resource: unknown,
  context: WriteContext | undefined
): PulseStoreSnapshot {
  const safeContext = context ?? {
    tenantId: "tenant_unknown",
    actorId: "actor_unknown",
    correlationId: "corr_unknown",
    reasonCode: "SYSTEM_WRITE"
  };
  const occurredAt = safeContext.now?.() ?? new Date(0).toISOString();
  const payloadHash = sha256(canonicalJson(resource));
  const base = `${safeContext.tenantId}:${resourceType}:${resourceId}:${payloadHash}:${snapshot.auditEvents.length}`;
  const eventId = safeContext.idGenerator?.() ?? `evt_${sha256(base).slice(0, 24)}`;

  return {
    ...snapshot,
    auditEvents: [
      ...snapshot.auditEvents,
      {
        eventId: `aud_${eventId}`,
        eventType: "pulse.audit.v1",
        occurredAt,
        tenantId: safeContext.tenantId,
        actorId: safeContext.actorId,
        correlationId: safeContext.correlationId,
        resourceType,
        resourceId,
        reasonCode: safeContext.reasonCode,
        afterHash: payloadHash
      }
    ],
    outboxEvents: [
      ...snapshot.outboxEvents,
      {
        eventId: `out_${eventId}`,
        eventType: "pulse.resource.changed.v1",
        occurredAt,
        tenantId: safeContext.tenantId,
        correlationId: safeContext.correlationId,
        resourceType,
        resourceId,
        payloadHash
      }
    ]
  };
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new PulseEvalError("VALIDATION_FAILED", `${field} must be non-empty.`);
  }
}

function validateDecisionResult(
  value: unknown,
  field: string,
  errorFactory: (message: string) => PulseEvalError = (message) =>
    new PulseEvalError("VALIDATION_FAILED", message),
  expectedKeys: readonly string[] = ["outcome", "reasonCode", "policyReference"]
): asserts value is DecisionResult {
  if (!isRecord(value)) {
    throw errorFactory(`${field} must be an object.`);
  }
  requireExactKeys(value, expectedKeys, field, errorFactory);
  if (value.outcome !== "allow" && value.outcome !== "deny") {
    throw errorFactory(`${field}.outcome must be allow or deny.`);
  }
  if (typeof value.reasonCode !== "string" || !isReasonCode(value.reasonCode)) {
    throw errorFactory(`${field}.reasonCode must be an uppercase stable reason code.`);
  }
  if (typeof value.policyReference !== "string" || value.policyReference.trim().length === 0 || value.policyReference.length > 256) {
    throw errorFactory(`${field}.policyReference must be a non-empty opaque identifier of at most 256 characters.`);
  }
}

function validateReceiptCreationOptions(options: CreateDecisionReceiptOptions): void {
  validateReceiptBinding({
    tenantId: options.tenantId,
    subjectHash: options.subjectHash,
    issuedAt: options.issuedAt,
    keyId: options.signer.keyId
  });
}

function validateReplayContext(context: ShadowReplayVerificationContext): void {
  validateTenantId(context.tenantId);
  validateSubjectHash(context.subjectHash);
  if (typeof context.keyResolver !== "function") {
    throw new PulseEvalError("DECISION_RECEIPT_VERIFIER_REQUIRED", "Decision receipt key resolver is required.");
  }
}

function validateReceiptBinding(value: Record<string, unknown>): void {
  validateTenantId(value.tenantId);
  validateSubjectHash(value.subjectHash);
  if (typeof value.issuedAt !== "string" || !isIsoTimestamp(value.issuedAt)) {
    throw invalidDecisionReceipt("Decision receipt issuedAt must be an ISO timestamp.");
  }
  if (typeof value.keyId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.keyId)) {
    throw invalidDecisionReceipt("Decision receipt keyId is invalid.");
  }
}

function validateTenantId(value: unknown): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 128) {
    throw invalidDecisionReceipt("Decision receipt tenantId must be a non-empty identifier of at most 128 characters.");
  }
}

function validateSubjectHash(value: unknown): void {
  if (typeof value !== "string" || !isSha256(value)) {
    throw invalidDecisionReceipt("Decision receipt subjectHash must be a SHA-256 hash.");
  }
}

function receiptPayload(receipt: DecisionReceipt): Omit<DecisionReceipt, "signature"> {
  return {
    schemaVersion: receipt.schemaVersion,
    tenantId: receipt.tenantId,
    subjectHash: receipt.subjectHash,
    issuedAt: receipt.issuedAt,
    outcome: receipt.outcome,
    reasonCode: receipt.reasonCode,
    policyReference: receipt.policyReference,
    keyId: receipt.keyId
  };
}

function invalidDecisionReceipt(message: string): PulseEvalError {
  return new PulseEvalError("INVALID_DECISION_RECEIPT", message);
}

function isReasonCode(value: string): boolean {
  return /^[A-Z][A-Z0-9_]{2,127}$/.test(value);
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function isIsoTimestamp(value: string): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  field: string,
  errorFactory: (message: string) => PulseEvalError
): void {
  const unexpected = Object.keys(value).filter((key) => !expectedKeys.includes(key));
  if (unexpected.length > 0) {
    throw errorFactory(`${field} contains unsupported fields.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function toCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => toCanonicalValue(item));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).filter((item) => record[item] !== undefined).sort()) {
      result[key] = toCanonicalValue(record[key]);
    }
    return result;
  }
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
