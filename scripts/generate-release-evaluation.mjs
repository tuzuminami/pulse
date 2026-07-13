import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const options = parseOptions(process.argv.slice(2));
const releaseSource = resolve(options.releaseSource ?? process.cwd());
const outputPath = resolve(options.output ?? "release-artifacts/pulse-release-evaluation.json");
const suitePath = resolve(releaseSource, "examples/suite.public-demo.json");
const pulse = await import(pathToFileURL(resolve(releaseSource, "dist/src/pulse-eval.js")).href);
const suiteText = await readFile(suitePath, "utf8");
const suite = JSON.parse(suiteText);

if (!Array.isArray(suite.cases) || suite.cases.some((testCase) => testCase.classification !== "public")) {
  throw new Error("Release evaluation requires an all-public synthetic suite.");
}

let clock = 0;
const baseline = pulse.createBaseline(suite, `${suite.suiteId}-${suite.version}-release-canary`);
const run = await pulse.runEvaluationSuite({
  suite,
  target: { baseUrl: "https://pulse-release-canary.invalid", timeoutMs: 1_000 },
  correlationId: "corr_release_canary",
  idGenerator: () => "run_release_canary",
  now: () => clock++,
  fetchImpl: async () =>
    new Response(JSON.stringify({ message: "hello accepted" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
});
const regression = pulse.compareRunToBaseline(run, baseline);
if (regression.ciExitCode !== 0) {
  throw new Error("Synthetic release evaluation did not satisfy its baseline.");
}

const evidence = {
  schemaVersion: "pulse.release-evaluation.v1",
  synthetic: true,
  suite: { path: "examples/suite.public-demo.json", sha256: sha256(suiteText), value: suite },
  baseline: { sha256: sha256(pulse.canonicalJson(baseline)), value: baseline },
  run: { sha256: sha256(pulse.canonicalJson(run)), value: run },
  regression: { sha256: sha256(pulse.canonicalJson(regression)), value: regression }
};

await mkdir(resolve(outputPath, ".."), { recursive: true });
await writeFile(outputPath, `${pulse.canonicalJson(evidence)}\n`);
console.log(`release-evaluation: wrote ${outputPath}`);

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

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
