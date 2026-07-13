import { readFile } from "node:fs/promises";

export interface VeilContractCheckOptions {
  readonly fetchImpl?: typeof fetch;
  readonly fixturePath: string | URL;
  readonly schemaUrl: string;
}

export interface VeilContractCheckResult {
  readonly status: "matched";
  readonly schemaUrl: string;
}

export async function checkVeilReceiptContract(
  options: VeilContractCheckOptions
): Promise<VeilContractCheckResult> {
  const response = await (options.fetchImpl ?? fetch)(options.schemaUrl);
  if (!response.ok) {
    throw new Error(`VEIL receipt schema fetch failed with HTTP ${response.status}.`);
  }
  const upstream = await response.json();
  const frozen = JSON.parse(await readFile(options.fixturePath, "utf8")) as unknown;
  if (canonicalJson(upstream) !== canonicalJson(frozen)) {
    throw new Error(`VEIL receipt schema drift detected at ${options.schemaUrl}.`);
  }
  return { status: "matched", schemaUrl: options.schemaUrl };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonical(value));
}

function toCanonical(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(toCanonical);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = toCanonical(record[key]);
    return sorted;
  }
  return String(value);
}
