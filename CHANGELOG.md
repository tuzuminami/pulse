# Changelog

## 1.0.1

- Published the complete immutable GitHub Release evidence bundle: package tarball, SBOM, synthetic evaluation, decision manifest, verification log, and verifier.
- Added no-credential consumer verification of published release assets, manifest hashes, package identity, and public package import.
- Documented that v1.0.0 retained only its SBOM; GitHub Release evidence is canonical from v1.0.1 onward.
- Aligned the VEIL receipt fixture with `v1.0.1`, accepting its optional request identity without changing PULSE's public replay mismatch union.

## 1.0.0

- Established PULSE as a deterministic proof harness for policy regression and release evidence.
- Added decision-receipt and shadow-replay verification with CI-friendly failure outcomes.
- Added signed receipt verification, authenticated HTTP boundaries, response-size limits, atomic idempotency persistence, and packed-artifact import coverage.
- Removed non-public planning material from the public release tree and added release-boundary checks.
- Kept raw request and response bodies out of persisted run evidence and package artifacts.

## 0.2.0

- Added HTTP idempotency enforcement for state-changing endpoints.
- Added append-only audit and outbox evidence to persisted store snapshots.
- Added GitHub Actions release gates and GitHub-detectable Apache-2.0 license file.
- Hardened API request validation and private-boundary scanning.
- Removed the out-of-scope persona compiler slice from PULSE public exports.

## 0.1.0

- Added strict TypeScript project bootstrap.
- Added PULSE evaluation suite runner, redacted traces, baseline comparison, and CI-style regression result.
- Added public private-boundary guard and release artifact ignore rules.
