import { deepEqual, equal, rejects } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { checkVeilReceiptContract } from "../src/veil-contract.js";

const fixturePath = join(process.cwd(), "tests/fixtures/veil-decision-receipt-v1.schema.json");

test("TEST-VEIL-CONTRACT-002 accepts the frozen schema from a mocked upstream fetch", async () => {
  const frozen = JSON.parse(await readFile(fixturePath, "utf8"));
  const result = await checkVeilReceiptContract({
    schemaUrl: "https://example.test/veil/v1/decision-receipt.schema.json",
    fixturePath,
    fetchImpl: async (input) => {
      equal(input, "https://example.test/veil/v1/decision-receipt.schema.json");
      return new Response(JSON.stringify(frozen), { status: 200 });
    }
  });
  deepEqual(result, {
    status: "matched",
    schemaUrl: "https://example.test/veil/v1/decision-receipt.schema.json"
  });
});

test("TEST-VEIL-CONTRACT-003 fails when the mocked upstream schema drifts", async () => {
  await rejects(
    checkVeilReceiptContract({
      schemaUrl: "https://example.test/veil/v1/decision-receipt.schema.json",
      fixturePath,
      fetchImpl: async () =>
        new Response(JSON.stringify({ title: "DecisionReceipt", changed: true }), { status: 200 })
    }),
    /VEIL receipt schema drift detected/
  );
});
