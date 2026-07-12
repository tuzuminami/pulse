import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepEqual, equal, ok } from "node:assert/strict";
import { describe, it } from "node:test";

const projectRoot = process.cwd();
const boundaryScript = join(projectRoot, "scripts", "check-private-boundary.mjs");
describe("public boundary checks", () => {
  it("TEST-BOUNDARY-001 has only public release paths in the workspace", () => {
    const trackedInternalPaths = execFileSync("git", ["ls-files", "AGENTS.md", "docs"], {
      cwd: projectRoot,
      encoding: "utf8"
    }).trim();
    deepEqual(trackedInternalPaths, "");
  });

  it("TEST-BOUNDARY-002 exits non-zero when an unallowlisted path is introduced", async () => {
    const repo = await mkdtemp(join(tmpdir(), "pulse-boundary-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    mkdirSync(join(repo, "notes"), { recursive: true });
    writeFileSync(join(repo, "notes", "release-plan.md"), "synthetic fixture only\n", "utf8");

    const result = spawnSync(process.execPath, [boundaryScript], {
      cwd: repo,
      encoding: "utf8"
    });

    equal(result.status, 1);
    ok(result.stderr.includes("path is not allowlisted"));
  });

  it("TEST-BOUNDARY-003 scans untracked package candidate files", async () => {
    const repo = await mkdtemp(join(tmpdir(), "pulse-boundary-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    mkdirSync(join(repo, "openapi"), { recursive: true });
    writeFileSync(join(repo, "openapi", "leak.yaml"), "PRIVATE_CONTROL_MATERIAL\n", "utf8");

    const result = spawnSync(process.execPath, [boundaryScript], {
      cwd: repo,
      encoding: "utf8"
    });

    equal(result.status, 1);
    ok(result.stderr.includes("prohibited private marker found"));
  });

  it("TEST-BOUNDARY-004 scans ignored generated package artifacts", async () => {
    const repo = await mkdtemp(join(tmpdir(), "pulse-boundary-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    mkdirSync(join(repo, "dist", "src"), { recursive: true });
    writeFileSync(join(repo, ".gitignore"), "dist/\n", "utf8");
    writeFileSync(join(repo, "dist", "src", "leak.js"), "PRIVATE_CONTROL_MATERIAL\n", "utf8");

    const result = spawnSync(process.execPath, [boundaryScript], {
      cwd: repo,
      encoding: "utf8"
    });

    equal(result.status, 1);
    ok(result.stderr.includes("generated artifact"));
  });

  it("TEST-PACKAGE-001 excludes private material from npm package dry-run", async () => {
    const npmCache = await mkdtemp(join(tmpdir(), "pulse-npm-cache-"));
    const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--cache", npmCache], {
      cwd: projectRoot,
      encoding: "utf8"
    });
    const packedPaths = readPackedPaths(raw);

    ok(packedPaths.includes("README.md"));
    ok(packedPaths.includes("LICENSE"));
    ok(!packedPaths.some((path) => path.startsWith("docs/") || path === "AGENTS.md"));
  });
});

function readPackedPaths(raw: string): readonly string[] {
  const jsonStart = raw.indexOf("[\n");
  if (jsonStart === -1) {
    throw new Error("npm pack output did not include JSON.");
  }
  const parsed: unknown = JSON.parse(raw.slice(jsonStart));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("npm pack output was not an array.");
  }
  const first = parsed[0] as { readonly files?: unknown };
  if (!Array.isArray(first.files)) {
    throw new Error("npm pack output did not include files.");
  }
  return first.files.map((file) => {
    const record = file as { readonly path?: unknown };
    if (typeof record.path !== "string") {
      throw new Error("npm pack file entry did not include a string path.");
    }
    return record.path;
  });
}
