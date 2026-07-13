import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const options = parseOptions(process.argv.slice(2));
const artifactDir = resolve(options.artifactDir ?? "release-artifacts");
const decision = JSON.parse(await readFile(resolve(artifactDir, "pulse-release-decision.json"), "utf8"));
if (decision?.schemaVersion !== "pulse.release-decision.v1" || !Array.isArray(decision.artifacts)) {
  throw new Error("Release decision manifest is invalid.");
}
for (const artifact of decision.artifacts) {
  if (typeof artifact?.path !== "string" || typeof artifact.sha256 !== "string" || !artifact.path.startsWith("release-artifacts/")) {
    throw new Error("Release decision artifact entry is invalid.");
  }
  const file = artifact.path.slice("release-artifacts/".length);
  if (file !== basename(file)) throw new Error(`Release evidence path is unsafe: ${artifact.path}`);
  const actual = createHash("sha256").update(await readFile(resolve(artifactDir, file))).digest("hex");
  if (actual !== artifact.sha256) throw new Error(`Release evidence hash mismatch: ${artifact.path}`);
}
console.log("release-evidence: verified artifact hashes");

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
