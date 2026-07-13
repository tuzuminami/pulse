import { readFileSync } from "node:fs";

const required = new Map([
  [".github/CODEOWNERS", ["* @tuzuminami", "/src/ @tuzuminami", "/openapi/ @tuzuminami", "/.github/ @tuzuminami"]],
  [".github/PULL_REQUEST_TEMPLATE.md", ["Compatibility", "Tenant isolation", "Release Impact"]],
  [".github/ISSUE_TEMPLATE/bug-report.yml", ["Minimal synthetic reproduction", "tenant isolation"]],
  [".github/ISSUE_TEMPLATE/feature-request.yml", ["VEIL receipt compatibility", "Migration, rollout, rollback"]],
  [".github/MAINTAINER_GOVERNANCE.md", ["Require the `verify` status check", "Block force pushes", "CycloneDX SBOM", "Artifact Attestations"]]
]);

for (const [path, fragments] of required) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    fail(`missing required governance file: ${path}`);
  }
  for (const fragment of fragments) {
    if (!content.includes(fragment)) fail(`missing governance requirement in ${path}: ${fragment}`);
  }
}

console.log("governance: passed");

function fail(message) {
  console.error(`governance: ${message}`);
  process.exit(1);
}
