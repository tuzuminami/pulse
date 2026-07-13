# Contributing

Thanks for helping improve PULSE.

## Development

```bash
pnpm install
pnpm run check
```

Keep changes small and covered by tests. Source code uses strict TypeScript and must avoid `any`.

Read [maintainer governance](.github/MAINTAINER_GOVERNANCE.md) before proposing release, workflow, contract, or security-sensitive work.

## Pull Requests

Include:

- what changed and why
- tests run
- public API or CLI impact
- security, tenant, idempotency, and audit impact where relevant
- compatibility, migration, rollout, rollback, and operational impact where relevant

Use the pull request template and create public issues from the supplied templates. Report vulnerabilities through `SECURITY.md`, not public issues.

Do not include secrets, private prompts, production conversation data, local operator notes, or local-only planning material.
