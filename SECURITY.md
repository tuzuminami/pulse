# Security Policy

PULSE is a self-hostable OSS evaluation harness. Do not submit production secrets, private conversation logs, or private operator material in issues, pull requests, fixtures, traces, or support requests.

## Supported Versions

| Version | Supported |
| --- | --- |
| 1.0.x | Yes |
| 0.x | No |

## Reporting A Vulnerability

Use [GitHub Private Vulnerability Reporting](https://github.com/tuzuminami/pulse/security/advisories/new) for every suspected vulnerability. Do not open a public issue first. Include a minimal synthetic reproduction and avoid real user data. The maintainer acknowledges reports privately, coordinates a fix, and publishes an advisory only after a remediation is available.

## Data Handling

Evaluation runs persist redacted trace metadata by default. Request and response bodies are represented by hashes in run traces. Suite fixtures should use synthetic data only.

For shared HTTP deployments, configure a verified principal authenticator, tenant-bound trusted receipt-signing keys, and a network egress adapter that enforces your target allow policy. PULSE fails closed when those boundaries are not configured. Use lowercase ASCII tenant IDs consistently across the identity provider and `X-Tenant-Id`.

The bundled JSON store serializes writes only inside one Node.js process. Do not deploy multiple API replicas against it. A shared deployment needs a transactional store and distributed coordination before horizontal scaling.

Runs use a 60-second pending idempotency lease. A retry after an interrupted process can re-run the target after that lease expires, so configure evaluation targets to be safe for at-least-once execution.
