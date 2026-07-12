import { execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { equal } from "node:assert/strict";
import { describe, it } from "node:test";

const projectRoot = process.cwd();

describe("published package import", () => {
  it("TEST-PACKAGE-IMPORT-001 installs the packed tarball into a fresh consumer", async () => {
    const cache = await mkdtemp(join(tmpdir(), "pulse-npm-cache-"));
    const consumer = await mkdtemp(join(tmpdir(), "pulse-consumer-"));
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--cache", cache], {
        cwd: projectRoot,
        encoding: "utf8"
      })
    ) as readonly { readonly filename?: unknown }[];
    const filename = packed[0]?.filename;
    if (typeof filename !== "string") {
      throw new Error("npm pack did not report a tarball filename.");
    }
    const tarball = resolve(projectRoot, filename);

    try {
      await writeFile(join(consumer, "package.json"), '{"type":"module"}\n', "utf8");
      execFileSync(
        "npm",
        ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", cache, tarball],
        { cwd: consumer, encoding: "utf8" }
      );
      const output = execFileSync(
        process.execPath,
        ["--input-type=module", "--eval", "import('@tuzuminami/pulse').then((pkg) => console.log(typeof pkg.processPulseHttpRequest))"],
        { cwd: consumer, encoding: "utf8" }
      );

      equal(output.trim(), "function");
    } finally {
      await rm(tarball, { force: true });
    }
  });
});
