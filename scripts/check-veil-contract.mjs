import { fileURLToPath } from "node:url";
import { checkVeilReceiptContract as runCheck } from "../dist/src/veil-contract.js";

export const VEIL_RECEIPT_SCHEMA_URL =
  process.env.VEIL_RECEIPT_SCHEMA_URL ??
  "https://raw.githubusercontent.com/tuzuminami/veil/v1.0.0/schemas/decision-receipt.schema.json";
export const VEIL_RECEIPT_SCHEMA_FIXTURE = new URL(
  "../tests/fixtures/veil-decision-receipt-v1.schema.json",
  import.meta.url
);

export async function checkVeilReceiptContract({
  fetchImpl = fetch,
  fixturePath = VEIL_RECEIPT_SCHEMA_FIXTURE,
  schemaUrl = VEIL_RECEIPT_SCHEMA_URL
} = {}) {
  return runCheck({ fetchImpl, fixturePath, schemaUrl });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await checkVeilReceiptContract()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "VEIL receipt contract check failed.");
    process.exitCode = 1;
  }
}
