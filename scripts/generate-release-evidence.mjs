import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const options = parseOptions(process.argv.slice(2));
const releaseTag = requireOption(options.releaseTag, "--release-tag");
const releaseSource = resolve(options.releaseSource ?? process.cwd());
const artifactDir = resolve(options.artifactDir ?? "release-artifacts");
const outputPath = resolve(options.output ?? `${artifactDir}/pulse-release-decision.json`);
const artifactNames = (await readdir(artifactDir)).filter((name) =>
  name.endsWith(".tgz") || name === "pulse-sbom.cdx.json" || name === "pulse-release-evaluation.json" || name === "verification.log" || name === "verify-release-evidence.mjs"
).sort();
const requiredNames = ["pulse-sbom.cdx.json", "pulse-release-evaluation.json", "verification.log"];
if (!artifactNames.some((name) => name.endsWith(".tgz")) || requiredNames.some((name) => !artifactNames.includes(name))) {
  throw new Error("Release decision evidence requires package, SBOM, synthetic evaluation, and verification log artifacts.");
}

const evaluation = JSON.parse(await readFile(resolve(artifactDir, "pulse-release-evaluation.json"), "utf8"));
const pulse = await import(pathToFileURL(resolve(releaseSource, "dist/src/pulse-eval.js")).href);
verifySyntheticEvaluation(evaluation, pulse);

const packageManifest = JSON.parse(await readFile(resolve(releaseSource, "package.json"), "utf8"));
if (releaseTag !== `v${packageManifest.version}`) {
  throw new Error("Release tag must match package.json version exactly.");
}
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

function verifySyntheticEvaluation(evaluation, pulse) {
  if (evaluation?.schemaVersion !== "pulse.release-evaluation.v1" || evaluation?.synthetic !== true) {
    throw new Error("Release evaluation evidence is missing or unsafe.");
  }
  const { suite, baseline, run, regression } = evaluation;
  if (!suite || !baseline || !run || !regression || suite.path !== "examples/suite.public-demo.json") {
    throw new Error("Release evaluation evidence is incomplete.");
  }
  const expectedSuite = {
    suiteId: "public-demo-suite", version: "1.0.0", status: "published",
    cases: [{ id: "case-hello", input: { path: "/chat", method: "POST", body: { prompt: "hello" } }, expected: { jsonFieldEquals: { field: "message", value: "hello accepted" } }, tags: ["smoke"], classification: "public" }],
    thresholds: { minPassRate: 1, maxInconclusiveRate: 0 }
  };
  if (pulse.canonicalJson(suite.value) !== pulse.canonicalJson(expectedSuite)) {
    throw new Error("Release evaluation suite is not the exact public canary.");
  }
  if (suite.sha256 !== sha256(pulse.canonicalJson(suite.value))) {
    throw new Error("Release evaluation suite hash is invalid.");
  }
  const expectedBaseline = pulse.createBaseline(suite.value, `${suite.value.suiteId}-${suite.value.version}-release-canary`);
  if (pulse.canonicalJson(baseline.value) !== pulse.canonicalJson(expectedBaseline) || baseline.sha256 !== sha256(pulse.canonicalJson(baseline.value))) {
    throw new Error("Release evaluation baseline is invalid.");
  }
  if (run.value?.runId !== "run_release_canary" || run.value?.correlationId !== "corr_release_canary" || run.value?.targetBaseUrl !== "https://pulse-release-canary.invalid" || run.sha256 !== sha256(pulse.canonicalJson(run.value))) {
    throw new Error("Release evaluation run is invalid.");
  }
  const expectedRegression = pulse.compareRunToBaseline(run.value, baseline.value);
  if (pulse.canonicalJson(regression.value) !== pulse.canonicalJson(expectedRegression) || regression.sha256 !== sha256(pulse.canonicalJson(regression.value)) || regression.value.ciExitCode !== 0) {
    throw new Error("Release evaluation regression is invalid.");
  }
}
