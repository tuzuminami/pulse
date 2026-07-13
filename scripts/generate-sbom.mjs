import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("package.json", "utf8"));
const runtimeDependencies = [
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.optionalDependencies ?? {}),
  ...(Array.isArray(manifest.bundledDependencies) ? manifest.bundledDependencies : [])
];

if (runtimeDependencies.length > 0) {
  throw new Error(`PULSE release SBOM generator requires explicit runtime dependency support: ${runtimeDependencies.join(", ")}`);
}

const serialSource = createHash("sha256").update(`${manifest.name}@${manifest.version}`).digest("hex");
const serialNumber = `${serialSource.slice(0, 8)}-${serialSource.slice(8, 12)}-5${serialSource.slice(13, 16)}-${(Number.parseInt(serialSource.slice(16, 17), 16) & 0x3 | 0x8).toString(16)}${serialSource.slice(17, 20)}-${serialSource.slice(20, 32)}`;

const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  serialNumber: `urn:uuid:${serialNumber}`,
  version: 1,
  metadata: {
    component: {
      type: "library",
      name: manifest.name,
      version: manifest.version,
      licenses: [{ license: { id: manifest.license } }],
      purl: `pkg:npm/${manifest.name.replace("@", "%40")}@${manifest.version}`
    }
  },
  components: []
};

await mkdir("release-artifacts", { recursive: true });
await writeFile("release-artifacts/pulse-sbom.cdx.json", `${JSON.stringify(sbom, null, 2)}\n`);
console.log("sbom: generated CycloneDX 1.6 for a release with no runtime dependencies");
