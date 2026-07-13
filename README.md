# PULSE


PULSE is a self-hostable evaluation harness for conversational AI. It runs versioned suites against deterministic HTTP targets, stores redacted evidence, compares runs with baselines, and returns CI-friendly regression outcomes.

## What Works In 1.0

- Strict TypeScript package with public SDK exports.
- Versioned evaluation cases and suites with immutable publish semantics.
- Deterministic evaluator registration through suite expectations.
- Deterministic HTTP-target runner through an injectable `fetch` boundary.
- Rule-style expectations for response text and JSON fields.
- Redacted trace persistence: request and response bodies are stored as hashes.
- Baseline comparison with non-zero CI outcome on material regression.
- Redacted, hash-verified decision receipts with stable outcome, reason-code, and policy-reference contracts.
- Deterministic shadow replay comparison with CI-friendly mismatch reason codes.
- Tenant-scoped HTTP storage paths, caller-supplied principal checks, and fail-closed request validation.
- Required idempotency keys for state-changing HTTP endpoints.
- Required attributable write contexts and append-only audit/outbox events for persisted changes.
- Host-configurable evaluation budgets for suite size, target timeout, total deadline, tenant concurrency/queueing, and target rate.
- Public boundary guard to prevent accidental release of local-only operator material.

## Non-Goals

- PULSE is not a production traffic recorder.
- PULSE is not a policy engine, LLM gateway, scenario runtime, memory system, relationship engine, or persona compiler.
- PULSE does not treat a probabilistic model judge as the only release authority.
- PULSE does not store raw production conversations by default.
- PULSE does not provide a management UI.
- The JSON store and its transaction lock are designed for one Node.js process. Use a shared transactional store and distributed coordination before running multiple API replicas.
- The HTTP handler is a deterministic harness boundary. Provide a production identity provider and egress policy for shared deployments.

## Install

```bash
pnpm install
pnpm run check
```

## CLI

```bash
pnpm run build
node dist/src/cli.js suite:publish --suite examples/suite.public-demo.json --store .pulse/store.json
node dist/src/cli.js baseline:create --suite examples/suite.public-demo.json --store .pulse/store.json
node dist/src/cli.js run --suite examples/suite.public-demo.json --target http://localhost:3000 --store .pulse/store.json
node dist/src/cli.js regression:check --store .pulse/store.json
PULSE_RECEIPT_HMAC_KEY=... node dist/src/cli.js shadow:check --receipt receipt.json --decision replayed-decision.json --tenant-id tenant_demo --subject-hash <sha256> --receipt-key-id key-2026-01
node dist/src/cli.js veil:replay-check --receipt veil-receipt.json --decision veil-replayed-decision.json
```

`regression:check` exits with `1` when observed metrics breach the stored baseline.
`veil:replay-check` compares a public VEIL v1 receipt with replayed VEIL decision evidence and exits with `1` on mismatch. It does not use PULSE HMAC keys or require a VEIL runtime dependency.

VEIL receipt hashes are deterministic integrity checks, not caller authentication. Use this replay path for regression evidence only; do not make authorization decisions from an untrusted receipt file.

The normal `pnpm run check` is offline and repeatable. CI pins `pnpm run check:veil-contract` to the VEIL `v1.0.0` receipt schema, then runs the same check against VEIL `main` as an explicit compatibility monitor. Both compare parsed JSON with `tests/fixtures/veil-decision-receipt-v1.schema.json`; any upstream change fails the monitor. Override the URL with `VEIL_RECEIPT_SCHEMA_URL` when validating another public schema.

## SDK

```ts
import {
  compareShadowReplay,
  compareRunToBaseline,
  createDecisionReceipt,
  createBaseline,
  runEvaluationSuite
} from "@tuzuminami/pulse";
```

Library persistence through `saveSuite`, `saveRun`, `saveBaseline`, and `saveResourceWithIdempotency` requires a validated `WriteContext`. Supply a verified lowercase tenant ID, actor ID, correlation ID, uppercase reason code, and a real UTC ISO-8601 clock. PULSE rejects missing or malformed context before it writes a resource, audit event, or outbox event. Tests should use an explicit deterministic clock rather than an unknown audit subject.

## API Contract

The public HTTP contract is documented in `openapi/openapi.yaml`. State-changing endpoints require:

- An `Authorization` value accepted by the required `authenticate` callback
- `X-Tenant-Id: <tenant-id>`
- `Idempotency-Key: <unique-operation-key>`

The included HTTP handler is a deterministic harness boundary, not a production authentication system. The principal returned by `authenticate` must match `X-Tenant-Id`, use a lowercase ASCII tenant ID (`[a-z0-9][a-z0-9_-]{0,127}`), and have an operator role. HTTP target execution is fail-closed: self-hosts must provide a `targetPolicy` allow rule before `POST /v1/runs` can call any target. The bundled JSON store serializes writes only within one Node.js process; it is not a multi-replica persistence layer.

The HTTP server applies an `evaluationBudget` even when the host does not configure one: 25 cases per suite, 10-second target timeout, 60-second total run deadline, two concurrent runs plus four queued runs per tenant, and 30 runs per target per minute. A host can lower or raise these numbers through `PulseApiOptions.evaluationBudget`. Exceeded budgets return `429 EVALUATION_BUDGET_EXCEEDED`; PULSE records a redacted, durable `budgetEvents` record plus attributable audit/outbox hashes, never target URLs or credentials. These counters are process-local, so a multi-replica deployment must enforce matching distributed limits at its ingress or worker layer.

`POST /v1/runs` holds a 60-second pending idempotency lease before target execution. A matching request waits fail-closed while the lease is live. After a process crash, the same request may be retried after the lease expires, so evaluation targets must be safe for at-least-once execution.

`POST /v1/shadow-replays` compares a captured `pulse.decision-receipt.v1` object with a replayed decision. A receipt is HMAC-SHA256 signed by a tenant-bound trusted key and binds `tenantId`, `subjectHash`, `issuedAt`, `outcome`, `reasonCode`, and `policyReference`. The key resolver receives both `tenantId` and `keyId`; do not use a cross-tenant key lookup. It never stores request or response bodies or key material.

Authenticated evaluation targets are configured only by the self-host. `targetPolicy.credentialProvider` receives the verified tenant, normalized HTTPS target origin, correlation ID, and PULSE operation idempotency key at execution time; it returns allowlisted credential headers from the host's secret manager. `headerTemplates` can propagate only `X-Tenant-Id`, `X-Correlation-Id`, and an opaque per-case `Idempotency-Key` derived from trusted PULSE context. PULSE never forwards the caller's `Authorization` header to a target, rejects origin-changing case paths, and excludes target credentials from suites, traces, runs, audit events, snapshots, and error bodies. A missing or invalid credential provider result returns `TARGET_CREDENTIALS_UNAVAILABLE` or `TARGET_CREDENTIALS_INVALID` without exposing the value.

## Security And Data Notes

Use synthetic fixtures. Do not put secrets, production conversation logs, private prompts, or local operator material in suites, traces, issues, pull requests, package artifacts, or CI logs.

Suite definitions are stored as test fixtures. PULSE redacts run traces before persistence, but it does not make unsafe suite inputs safe after the fact.

## Development

```bash
pnpm run build
pnpm run test
pnpm run check:private-boundary
```

## License

Apache-2.0
