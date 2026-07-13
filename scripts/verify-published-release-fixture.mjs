import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const tag = `v${packageJson.version}`;
const directory = mkdtempSync(join(tmpdir(), "pulse-published-release-fixture-"));
const packageName = `${packageJson.name.slice(1).replace("/", "-")}-${packageJson.version}.tgz`;
const names = [packageName, "pulse-sbom.cdx.json", "pulse-release-evaluation.json", "pulse-release-decision.json", "verification.log", "verify-release-evidence.mjs"];

try {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", directory, "--json"], { cwd: root, encoding: "utf8" }));
  if (packed[0]?.filename !== packageName) throw new Error("release package fixture name is invalid");
  execFileSync(process.execPath, ["scripts/generate-sbom.mjs"], { cwd: root, stdio: "pipe" });
  copyFileSync(join(root, "release-artifacts", "pulse-sbom.cdx.json"), join(directory, "pulse-sbom.cdx.json"));
  execFileSync(process.execPath, ["scripts/generate-release-evaluation.mjs", "--output", join(directory, "pulse-release-evaluation.json")], { cwd: root, stdio: "pipe" });
  copyFileSync(join(root, "scripts", "verify-release-evidence.mjs"), join(directory, "verify-release-evidence.mjs"));
  writeFileSync(join(directory, "verification.log"), "fixture verification\n");
  execFileSync(process.execPath, ["scripts/generate-release-evidence.mjs", "--release-source", root, "--release-tag", tag, "--artifact-dir", directory, "--pnpm-version", "fixture"], { cwd: root, stdio: "pipe" });

  const assets = names.map((name) => asset(name));
  verify(assets, "true", false);
  verify(assets, "false", true);
  verify([...assets, { ...asset(names[0]), name: "unexpected-private-notes.zip" }], "true", true);
  const decisionPath = join(directory, "pulse-release-decision.json");
  const decision = JSON.parse(readFileSync(decisionPath, "utf8"));
  decision.release.sourceCommit = "0".repeat(40);
  writeFileSync(decisionPath, `${JSON.stringify(decision, null, 2)}\n`);
  verify(names.map((name) => asset(name)), "true", true);
  console.log(`published-release-fixture: verified ${tag}`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

function asset(name) {
  const content = readFileSync(join(directory, name));
  return { name, state: "uploaded", size: statSync(join(directory, name)).size, digest: `sha256:${createHash("sha256").update(content).digest("hex")}`, browser_download_url: `https://github.com/tuzuminami/pulse/releases/download/${tag}/${name}` };
}

function verify(assets, immutable, shouldFail) {
  const result = spawnSync(process.execPath, ["scripts/verify-published-release.mjs"], { cwd: root, encoding: "utf8", env: { ...process.env, PULSE_RELEASE_TAG: tag, PULSE_RELEASE_ASSETS_JSON: JSON.stringify(assets), PULSE_RELEASE_IS_IMMUTABLE: immutable, PULSE_RELEASE_FIXTURE_DIR: directory } });
  if (shouldFail ? result.status === 0 : result.status !== 0) throw new Error(`published release fixture check failed: ${result.stdout}\n${result.stderr}`);
}
