import { createHash } from "node:crypto";

export const VEIL_DECISION_RECEIPT_VERSION = "veil-decision-receipt/1.0" as const;

export type VeilDecisionAction = "ALLOW" | "TRANSFORM" | "REQUIRE_CONFIRMATION" | "BLOCK" | "ESCALATE";
export type VeilDecisionOutcome = "allow" | "deny";
export type VeilReplayMismatchReason =
  | "ACTION_MISMATCH"
  | "ACTION_OUTCOME_MISMATCH"
  | "POLICY_ID_MISMATCH"
  | "POLICY_VERSION_MISMATCH"
  | "POLICY_HASH_MISMATCH"
  | "INPUT_HASH_MISMATCH"
  | "EVIDENCE_HASH_MISMATCH"
  | "OBLIGATIONS_MISMATCH"
  | "REASON_CODES_MISMATCH"
  | "TENANT_ID_MISMATCH"
  | "REQUEST_ID_MISMATCH"
  | "CORRELATION_ID_MISMATCH";

/** Public VEIL v1 receipt shape, copied here without a VEIL runtime dependency. */
export interface VeilDecisionReceipt {
  readonly receiptVersion: typeof VEIL_DECISION_RECEIPT_VERSION;
  readonly decisionId: string;
  readonly tenantId: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly policyHash: string;
  readonly action: VeilDecisionAction;
  readonly reasonCodes: readonly string[];
  readonly obligations: readonly string[];
  readonly matchedRuleId?: string;
  readonly inputHash: string;
  readonly evidenceHash: string;
  readonly requestId?: string;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly receiptHash: string;
}

export interface AdaptedVeilDecisionReceipt {
  readonly receipt: VeilDecisionReceipt;
  readonly outcome: VeilDecisionOutcome;
}

/**
 * The replay input is deliberately limited to public VEIL decision evidence.
 * tenantId, requestId, and correlationId are optional for callers that do not retain them;
 * when supplied, they are compared as safe metadata.
 */
export interface VeilReplayedDecision {
  readonly action: VeilDecisionAction;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly policyHash: string;
  readonly reasonCodes: readonly string[];
  readonly obligations: readonly string[];
  readonly inputHash: string;
  readonly evidenceHash: string;
  readonly tenantId?: string;
  readonly requestId?: string;
  readonly correlationId?: string;
}

export interface VeilReplayComparison {
  readonly status: "passed" | "failed";
  readonly expectedReceiptHash: string;
  readonly replayedDecisionHash: string;
  readonly violations: readonly VeilReplayMismatchReason[];
  readonly ciExitCode: 0 | 1;
}

export class VeilReceiptError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "VeilReceiptError";
  }
}

export function adaptVeilDecisionReceipt(receipt: unknown): AdaptedVeilDecisionReceipt {
  validateVeilDecisionReceipt(receipt);
  return {
    receipt,
    outcome: veilActionToOutcome(receipt.action)
  };
}

export function compareVeilDecisionReplay(
  expectedReceipt: unknown,
  replayedDecision: unknown
): VeilReplayComparison {
  const expected = adaptVeilDecisionReceipt(expectedReceipt);
  validateVeilReplayedDecision(replayedDecision);

  const violations: VeilReplayMismatchReason[] = [];
  if (replayedDecision.action !== expected.receipt.action) violations.push("ACTION_MISMATCH");
  if (veilActionToOutcome(replayedDecision.action) !== expected.outcome) violations.push("ACTION_OUTCOME_MISMATCH");
  if (replayedDecision.policyId !== expected.receipt.policyId) violations.push("POLICY_ID_MISMATCH");
  if (replayedDecision.policyVersion !== expected.receipt.policyVersion) violations.push("POLICY_VERSION_MISMATCH");
  if (replayedDecision.policyHash !== expected.receipt.policyHash) violations.push("POLICY_HASH_MISMATCH");
  if (replayedDecision.inputHash !== expected.receipt.inputHash) violations.push("INPUT_HASH_MISMATCH");
  if (replayedDecision.evidenceHash !== expected.receipt.evidenceHash) violations.push("EVIDENCE_HASH_MISMATCH");
  if (!sameStrings(replayedDecision.obligations, expected.receipt.obligations)) violations.push("OBLIGATIONS_MISMATCH");
  if (!sameStrings(replayedDecision.reasonCodes, expected.receipt.reasonCodes)) violations.push("REASON_CODES_MISMATCH");
  if (replayedDecision.tenantId !== undefined && replayedDecision.tenantId !== expected.receipt.tenantId) {
    violations.push("TENANT_ID_MISMATCH");
  }
  if (replayedDecision.requestId !== undefined && replayedDecision.requestId !== expected.receipt.requestId) {
    violations.push("REQUEST_ID_MISMATCH");
  }
  if (replayedDecision.correlationId !== undefined && replayedDecision.correlationId !== expected.receipt.correlationId) {
    violations.push("CORRELATION_ID_MISMATCH");
  }

  return {
    status: violations.length === 0 ? "passed" : "failed",
    expectedReceiptHash: expected.receipt.receiptHash,
    replayedDecisionHash: canonicalHash(replayedDecision),
    violations,
    ciExitCode: violations.length === 0 ? 0 : 1
  };
}

export function validateVeilDecisionReceipt(receipt: unknown): asserts receipt is VeilDecisionReceipt {
  if (!isRecord(receipt)) throw invalidReceipt("VEIL decision receipt must be an object.");
  requireExactKeys(
    receipt,
    ["receiptVersion", "decisionId", "tenantId", "policyId", "policyVersion", "policyHash", "action", "reasonCodes", "obligations", "matchedRuleId", "inputHash", "evidenceHash", "requestId", "correlationId", "createdAt", "receiptHash"],
    "VEIL decision receipt"
  );
  if (receipt.receiptVersion !== VEIL_DECISION_RECEIPT_VERSION) {
    throw invalidReceipt(`Unsupported VEIL decision receipt version: ${String(receipt.receiptVersion)}.`);
  }
  for (const field of ["decisionId", "tenantId", "policyId", "policyVersion", "policyHash", "inputHash", "evidenceHash", "correlationId", "createdAt", "receiptHash"] as const) {
    if (!isNonEmptyString(receipt[field])) throw invalidReceipt(`VEIL decision receipt ${field} must be a non-empty string.`);
  }
  if (!isVeilAction(receipt.action)) throw invalidReceipt("VEIL decision receipt action is invalid.");
  if (!isStringArray(receipt.reasonCodes) || !isStringArray(receipt.obligations)) {
    throw invalidReceipt("VEIL decision receipt reasonCodes and obligations must be string arrays.");
  }
  if (receipt.matchedRuleId !== undefined && !isNonEmptyString(receipt.matchedRuleId)) {
    throw invalidReceipt("VEIL decision receipt matchedRuleId must be a non-empty string when present.");
  }
  if (receipt.requestId !== undefined && !isNonEmptyString(receipt.requestId)) {
    throw invalidReceipt("VEIL decision receipt requestId must be a non-empty string when present.");
  }
  const { receiptHash, ...contents } = receipt;
  if (receiptHash !== sha256(contents)) {
    throw invalidReceipt("VEIL decision receipt hash is invalid.");
  }
}

export function veilActionToOutcome(action: VeilDecisionAction): VeilDecisionOutcome {
  return action === "ALLOW" ? "allow" : "deny";
}

function validateVeilReplayedDecision(decision: unknown): asserts decision is VeilReplayedDecision {
  if (!isRecord(decision)) throw invalidReceipt("Replayed VEIL decision must be an object.");
  requireExactKeys(decision, ["action", "policyId", "policyVersion", "policyHash", "reasonCodes", "obligations", "inputHash", "evidenceHash", "tenantId", "requestId", "correlationId"], "Replayed VEIL decision");
  if (!isVeilAction(decision.action)) throw invalidReceipt("Replayed VEIL decision action is invalid.");
  for (const field of ["policyId", "policyVersion", "policyHash", "inputHash", "evidenceHash"] as const) {
    if (!isNonEmptyString(decision[field])) throw invalidReceipt(`Replayed VEIL decision ${field} must be a non-empty string.`);
  }
  if (!isStringArray(decision.reasonCodes) || !isStringArray(decision.obligations)) {
    throw invalidReceipt("Replayed VEIL decision reasonCodes and obligations must be string arrays.");
  }
  for (const field of ["tenantId", "requestId", "correlationId"] as const) {
    if (decision[field] !== undefined && !isNonEmptyString(decision[field])) {
      throw invalidReceipt(`Replayed VEIL decision ${field} must be a non-empty string when present.`);
    }
  }
}

function requireExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[], field: string): void {
  const unexpected = Object.keys(value).filter((key) => !expectedKeys.includes(key));
  if (unexpected.length > 0) throw invalidReceipt(`${field} contains unsupported fields.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isVeilAction(value: unknown): value is VeilDecisionAction {
  return value === "ALLOW" || value === "TRANSFORM" || value === "REQUIRE_CONFIRMATION" || value === "BLOCK" || value === "ESCALATE";
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalHash(value: unknown): string {
  return sha256(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonical(value));
}

function toCanonical(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(toCanonical);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child !== undefined) sorted[key] = toCanonical(child);
    }
    return sorted;
  }
  return String(value);
}

function invalidReceipt(message: string): VeilReceiptError {
  return new VeilReceiptError(message);
}
