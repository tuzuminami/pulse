import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { describe, it } from "node:test";

const execFile = promisify(execFileCallback);

describe("PULSE release evidence", () => {
  it("TEST-RELEASE-EVIDENCE-001 creates a deterministic public synthetic baseline decision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pulse-release-evidence-"));
    const output = join(directory, "pulse-release-evaluation.json");
    await execFile(process.execPath, ["scripts/generate-release-evaluation.mjs", "--output", output], { cwd: process.cwd() });

    const evidence = JSON.parse(await readFile(output, "utf8"));
    equal(evidence.schemaVersion, "pulse.release-evaluation.v1");
    equal(evidence.synthetic, true);
    equal(evidence.regression.value.ciExitCode, 0);
    deepEqual(evidence.regression.value.violations, []);
    ok(!JSON.stringify(evidence).includes("credential"));
  });

  it("TEST-RELEASE-EVIDENCE-002 records reproducible release-decision hashes and retention", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pulse-release-evidence-"));
    const evaluation = join(directory, "pulse-release-evaluation.json");
    const output = join(directory, "pulse-release-decision.json");
    await execFile(process.execPath, ["scripts/generate-release-evaluation.mjs", "--output", evaluation], { cwd: process.cwd() });
    await writeFile(join(directory, "package.tgz"), "package fixture\n");
    await writeFile(join(directory, "pulse-sbom.cdx.json"), "{\"bomFormat\":\"CycloneDX\"}\n");
    await writeFile(join(directory, "verification.log"), "verification fixture\n");
    await execFile(process.execPath, [
      "scripts/generate-release-evidence.mjs",
      "--release-tag", "v1.0.1",
      "--artifact-dir", directory,
      "--output", output,
      "--pnpm-version", "10-test"
    ], { cwd: process.cwd() });

    const decision = JSON.parse(await readFile(output, "utf8"));
    equal(decision.schemaVersion, "pulse.release-decision.v1");
    equal(decision.release.tag, "v1.0.1");
    equal(decision.evaluation.ciExitCode, 0);
    equal(decision.retention.workflowArtifactDays, 90);
    equal(decision.artifacts.length, 4);
    ok(decision.artifacts.every((artifact: { sha256: string }) => /^[a-f0-9]{64}$/.test(artifact.sha256)));
    await execFile(process.execPath, ["scripts/verify-release-evidence.mjs", "--artifact-dir", directory], { cwd: process.cwd() });
  });

  it("TEST-RELEASE-EVIDENCE-003 rejects a forged public evaluation hash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pulse-release-evidence-"));
    const evaluation = join(directory, "pulse-release-evaluation.json");
    await execFile(process.execPath, ["scripts/generate-release-evaluation.mjs", "--output", evaluation], { cwd: process.cwd() });
    const forged = JSON.parse(await readFile(evaluation, "utf8"));
    forged.run.sha256 = "0".repeat(64);
    await writeFile(evaluation, `${JSON.stringify(forged)}\n`);
    await writeFile(join(directory, "package.tgz"), "package fixture\n");
    await writeFile(join(directory, "pulse-sbom.cdx.json"), "{\"bomFormat\":\"CycloneDX\"}\n");
    await writeFile(join(directory, "verification.log"), "verification fixture\n");

    await rejects(
      execFile(process.execPath, [
        "scripts/generate-release-evidence.mjs",
        "--release-tag", "v1.0.1",
        "--artifact-dir", directory,
        "--output", join(directory, "pulse-release-decision.json")
      ], { cwd: process.cwd() })
    );
  });
});
