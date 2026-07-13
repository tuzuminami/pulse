# Maintainer Governance

PULSE is maintained in the open as a public evaluation and regression harness. `CODEOWNERS` assigns the current maintainer for source, contracts, workflow, release, and security-sensitive paths.

## Required Pull Request Evidence

Every change uses the pull request template. The exact commit must pass the `verify` GitHub Actions check. Contract, package, compatibility, security, tenant, idempotency, audit, target-egress, and rollback impact must be recorded when relevant.

Use synthetic data only. Security vulnerabilities use the disclosure path in `SECURITY.md`, not public issues.

## Default Branch Baseline

Repository administrators configure `main` with these protections:

1. Require pull requests before merging; do not allow direct pushes.
2. Require the `verify` status check and require branches to be up to date.
3. Require all review conversations to be resolved.
4. Block force pushes and branch deletion, including for administrators.
5. Request CODEOWNERS review for sensitive paths; the designated maintainer records independent correctness and security review evidence before release.

Verify the live setting with:

```bash
gh api repos/tuzuminami/pulse/branches/main/protection
```

## Release Baseline

Only release from a green `main` commit through a pull request. Create a draft release for the matching `v<package-version>` tag, then run the release-evidence workflow against that draft. It creates the npm tarball, reproducible CycloneDX SBOM, public synthetic evaluation bundle, and release-decision manifest. The CI artifact is retained for 90 days; after publishing the completed draft with immutable releases enabled, the GitHub Release assets are the long-term canonical audit record. The workflow signs package provenance, the SBOM, and the release-decision manifest through GitHub Artifact Attestations. Do not rewrite a public tag; publish a corrective patch release instead.

The synthetic evaluation bundle contains only the all-public `examples/suite.public-demo.json` fixture, its generated baseline, redacted run result, regression decision, and SHA-256 hashes. It is a deterministic release canary, not evidence of a customer's production target. The release-decision manifest binds this bundle to the release tag, source commit, lockfile hash, runtime versions, verification log, package tarball, and SBOM.

Any baseline threshold, public fixture, or evaluator change requires an issue or pull request that states the rationale, expected regression effect, rollback path, and review evidence. Do not silently refresh a baseline to make a failing release pass.

Verify published evidence with:

```bash
gh release download v<version> --repo tuzuminami/pulse --pattern '*'
for asset in <downloaded-release-artifact-directory>/*; do gh release verify-asset v<version> "$asset" --repo tuzuminami/pulse; done
gh attestation verify <downloaded-release-artifact-directory>/pulse-release-decision.json --repo tuzuminami/pulse
node <downloaded-release-artifact-directory>/verify-release-evidence.mjs --artifact-dir <downloaded-release-artifact-directory>
```
