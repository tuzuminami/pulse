import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const tag = process.env.PULSE_RELEASE_TAG;
const assets = JSON.parse(process.env.PULSE_RELEASE_ASSETS_JSON ?? "[]");
const fixtureDirectory = process.env.PULSE_RELEASE_FIXTURE_DIR;
const packageName = `${packageJson.name.slice(1).replace("/", "-")}-${packageJson.version}.tgz`;
const required = [packageName, "pulse-sbom.cdx.json", "pulse-release-evaluation.json", "pulse-release-decision.json", "verification.log", "verify-release-evidence.mjs"];
const temporary = mkdtempSync(join(tmpdir(), "pulse-published-release-"));

try {
  check(tag === `v${packageJson.version}`, `published tag must equal v${packageJson.version}`);
  for (const name of required) {
    const asset = assets.find((candidate) => candidate?.name === name);
    check(asset?.browser_download_url === `https://github.com/tuzuminami/pulse/releases/download/${tag}/${name}`, `release asset is missing or not bound to ${tag}: ${name}`);
    const destination = join(temporary, name);
    if (fixtureDirectory) {
      copyFileSync(join(fixtureDirectory, name), destination);
    } else {
      const response = await fetch(asset.browser_download_url, { redirect: "follow" });
      check(response.ok, `release asset download failed with HTTP ${response.status}: ${name}`);
      writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
    }
  }

  execFileSync(process.execPath, [join(temporary, "verify-release-evidence.mjs"), "--artifact-dir", temporary], { stdio: "pipe" });
  const decision = JSON.parse(readFileSync(join(temporary, "pulse-release-decision.json"), "utf8"));
  check(decision.release?.tag === tag, "decision manifest tag must match the published release");
  check(decision.release?.package?.name === packageJson.name && decision.release?.package?.version === packageJson.version, "decision manifest package identity must match the released tag");

  const consumer = join(temporary, "consumer");
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  execFileSync("npm", ["install", "--ignore-scripts", join(temporary, packageName)], { cwd: consumer, stdio: "pipe" });
  execFileSync(process.execPath, ["--input-type=module", "--eval", `const pulse = await import(${JSON.stringify(packageJson.name)}); if (typeof pulse.runEvaluationSuite !== 'function') throw new Error('missing public SDK export');`], { cwd: consumer, stdio: "pipe" });

  console.log(`published-release: verified ${tag} with ${required.length} public assets`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function check(condition, message) {
  if (!condition) throw new Error(`PULSE published release verification failed: ${message}`);
}
