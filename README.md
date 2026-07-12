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
- Append-only audit and outbox events for important persisted changes.
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
```

`regression:check` exits with `1` when observed metrics breach the stored baseline.

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

## API Contract

The public HTTP contract is documented in `openapi/openapi.yaml`. State-changing endpoints require:

- An `Authorization` value accepted by the required `authenticate` callback
- `X-Tenant-Id: <tenant-id>`
- `Idempotency-Key: <unique-operation-key>`

The included HTTP handler is a deterministic harness boundary, not a production authentication system. The principal returned by `authenticate` must match `X-Tenant-Id`, use a lowercase ASCII tenant ID (`[a-z0-9][a-z0-9_-]{0,127}`), and have an operator role. HTTP target execution is fail-closed: self-hosts must provide a `targetPolicy` allow rule before `POST /v1/runs` can call any target. The bundled JSON store serializes writes only within one Node.js process; it is not a multi-replica persistence layer.

`POST /v1/runs` holds a 60-second pending idempotency lease before target execution. A matching request waits fail-closed while the lease is live. After a process crash, the same request may be retried after the lease expires, so evaluation targets must be safe for at-least-once execution.

`POST /v1/shadow-replays` compares a captured `pulse.decision-receipt.v1` object with a replayed decision. A receipt is HMAC-SHA256 signed by a tenant-bound trusted key and binds `tenantId`, `subjectHash`, `issuedAt`, `outcome`, `reasonCode`, and `policyReference`. The key resolver receives both `tenantId` and `keyId`; do not use a cross-tenant key lookup. It never stores request or response bodies or key material.

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
