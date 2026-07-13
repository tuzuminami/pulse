import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const options = parseOptions(process.argv.slice(2));
const releaseTag = requireOption(options.releaseTag, "--release-tag");
const releaseSource = resolve(options.releaseSource ?? process.cwd());
const artifactDir = resolve(options.artifactDir ?? "release-artifacts");
const outputPath = resolve(options.output ?? `${artifactDir}/pulse-release-decision.json`);
const artifactNames = (await readdir(artifactDir)).filter((name) =>
  name.endsWith(".tgz") || name === "pulse-sbom.cdx.json" || name === "pulse-release-evaluation.json" || name === "verification.log"
).sort();
const requiredNames = ["pulse-sbom.cdx.json", "pulse-release-evaluation.json", "verification.log"];
if (!artifactNames.some((name) => name.endsWith(".tgz")) || requiredNames.some((name) => !artifactNames.includes(name))) {
  throw new Error("Release decision evidence requires package, SBOM, synthetic evaluation, and verification log artifacts.");
}

const evaluation = JSON.parse(await readFile(resolve(artifactDir, "pulse-release-evaluation.json"), "utf8"));
if (evaluation?.schemaVersion !== "pulse.release-evaluation.v1" || evaluation?.synthetic !== true || evaluation?.regression?.value?.ciExitCode !== 0) {
  throw new Error("Release evaluation evidence is missing, unsafe, or did not pass its baseline.");
}

const packageManifest = JSON.parse(await readFile(resolve(releaseSource, "package.json"), "utf8"));
const sourceCommit = git(releaseSource, ["rev-parse", "HEAD"]);
const artifacts = await Promise.all(artifactNames.map(async (name) => {
  const path = resolve(artifactDir, name);
  const content = await readFile(path);
  return { path: `release-artifacts/${name}`, sha256: sha256(content), bytes: (await stat(path)).size };
}));
const decision = {
  schemaVersion: "pulse.release-decision.v1",
  generatedAt: new Date().toISOString(),
  release: {
    tag: releaseTag,
    sourceCommit,
    package: { name: packageManifest.name, version: packageManifest.version, license: packageManifest.license }
  },
  environment: {
    node: process.version,
    pnpm: options.pnpmVersion ?? "unknown",
    lockfileSha256: sha256(await readFile(resolve(releaseSource, "pnpm-lock.yaml")))
  },
  commands: ["pnpm run check", "pnpm run check:veil-contract", "node scripts/generate-release-evaluation.mjs", "npm pack"],
  evaluation: {
    synthetic: true,
    suiteSha256: evaluation.suite.sha256,
    baselineSha256: evaluation.baseline.sha256,
    runSha256: evaluation.run.sha256,
    regressionSha256: evaluation.regression.sha256,
    status: evaluation.regression.value.status,
    ciExitCode: evaluation.regression.value.ciExitCode,
    violations: evaluation.regression.value.violations
  },
  artifacts,
  retention: {
    workflowArtifactDays: 90,
    canonicalRecord: "GitHub Release assets",
    policy: "Retain the decision manifest, synthetic evaluation, SBOM, and package tarball with the published release."
  }
};

await mkdir(resolve(outputPath, ".."), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(decision, null, 2)}\n`);
console.log(`release-evidence: wrote ${outputPath}`);

function parseOptions(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid option near ${key ?? "<empty>"}.`);
    values[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return values;
}

function requireOption(value, name) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
