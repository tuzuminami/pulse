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

Only release from a green `main` commit through a pull request. The published-release workflow creates the npm tarball and reproducible CycloneDX SBOM, uploads both as workflow evidence, attaches the SBOM to the GitHub Release, and signs package provenance plus the SBOM through GitHub Artifact Attestations. Do not rewrite a public tag; publish a corrective patch release instead.

Verify published evidence with:

```bash
gh release download v<version> --repo tuzuminami/pulse --pattern 'pulse-sbom.cdx.json'
gh attestation verify <package-tarball> --repo tuzuminami/pulse
```
