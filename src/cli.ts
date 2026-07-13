#!/usr/bin/env node
import {
  compareShadowReplay,
  compareRunToBaseline,
  createBaseline,
  readStore,
  runEvaluationSuite,
  saveBaseline,
  saveRun,
  saveSuite
} from "./pulse-eval.js";

import type { EvalSuiteVersion, WriteContext } from "./pulse-eval.js";

interface CliOptions {
  readonly store: string;
  readonly suite: string | undefined;
  readonly target: string | undefined;
  readonly baselineId: string | undefined;
  readonly tenantId: string;
  readonly actorId: string;
  readonly correlationId: string;
  readonly reasonCode: string | undefined;
  readonly receipt: string | undefined;
  readonly decision: string | undefined;
  readonly subjectHash: string | undefined;
  readonly receiptKeyId: string | undefined;
}

const command = process.argv[2];
const options = parseOptions(process.argv.slice(3));

try {
  if (command === "suite:publish") {
    await requireSuite(options, async (suite) => {
      await saveSuite(options.store, suite, writeContext(options, "SUITE_PUBLISHED"));
      console.log(JSON.stringify({ suiteId: suite.suiteId, version: suite.version }));
    });
  } else if (command === "run") {
    await requireSuite(options, async (suite) => {
      const target = requireOption(options.target, "--target");
      const run = await runEvaluationSuite({
        suite,
        target: {
          baseUrl: target,
          timeoutMs: 2000
        },
        correlationId: options.correlationId
      });
      await saveRun(options.store, run, writeContext(options, "RUN_COMPLETED"));
      console.log(JSON.stringify(run));
      process.exitCode = run.status === "passed" ? 0 : 1;
    });
  } else if (command === "baseline:create") {
    await requireSuite(options, async (suite) => {
      const baseline = createBaseline(suite, options.baselineId);
      await saveBaseline(options.store, baseline, writeContext(options, "BASELINE_REGISTERED"));
      console.log(JSON.stringify(baseline));
    });
  } else if (command === "regression:check") {
    const snapshot = await readStore(options.store);
    const latestRun = snapshot.runs.at(-1);
    const latestBaseline = latestRun
      ? [...snapshot.baselines].reverse().find(
          (baseline) =>
            baseline.suiteId === latestRun.suiteId && baseline.suiteVersion === latestRun.suiteVersion
        )
      : undefined;
    if (!latestRun || !latestBaseline) {
      throw new Error("A run and matching baseline are required before regression check.");
    }
    const regression = compareRunToBaseline(latestRun, latestBaseline);
    console.log(JSON.stringify(regression));
    process.exitCode = regression.ciExitCode;
  } else if (command === "shadow:check") {
    const expectedReceipt = await importJson(requireOption(options.receipt, "--receipt"));
    const replayedDecision = await importJson(requireOption(options.decision, "--decision"));
    const receiptKey = process.env.PULSE_RECEIPT_HMAC_KEY;
    if (!receiptKey) {
      throw new Error("PULSE_RECEIPT_HMAC_KEY is required for shadow:check.");
    }
    const receiptKeyId = requireOption(options.receiptKeyId, "--receipt-key-id");
    const comparison = compareShadowReplay(
      expectedReceipt,
      replayedDecision as Parameters<typeof compareShadowReplay>[1],
      {
        tenantId: options.tenantId,
        subjectHash: requireOption(options.subjectHash, "--subject-hash"),
        keyResolver: (tenantId, keyId) =>
          tenantId === options.tenantId && keyId === receiptKeyId ? receiptKey : undefined
      }
    );
    console.log(JSON.stringify(comparison));
    process.exitCode = comparison.ciExitCode;
  } else if (command === "veil:replay-check") {
    const expectedReceipt = await importJson(requireOption(options.receipt, "--receipt"));
    const replayedDecision = await importJson(requireOption(options.decision, "--decision"));
    const { compareVeilDecisionReplay } = await import("./veil-receipt.js");
    const comparison = compareVeilDecisionReplay(expectedReceipt, replayedDecision);
    console.log(JSON.stringify(comparison));
    process.exitCode = comparison.ciExitCode;
  } else {
    throw new Error("Unknown command. Use suite:publish, run, baseline:create, regression:check, shadow:check, or veil:replay-check.");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown failure.";
  console.error(JSON.stringify({ error: { code: "PULSE_CLI_FAILED", message } }));
  process.exitCode = 1;
}

async function requireSuite(
  options: CliOptions,
  callback: (suite: EvalSuiteVersion) => Promise<void>
): Promise<void> {
  const suitePath = requireOption(options.suite, "--suite");
  const suite = (await importJson(suitePath)) as EvalSuiteVersion;
  await callback(suite);
}

async function importJson(path: string): Promise<unknown> {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function parseOptions(args: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid option near ${key ?? "<empty>"}.`);
    }
    values.set(key, value);
  }

  return {
    store: values.get("--store") ?? ".pulse/store.json",
    suite: values.get("--suite"),
    target: values.get("--target"),
    baselineId: values.get("--baseline-id"),
    tenantId: values.get("--tenant-id") ?? "tenant_cli",
    actorId: values.get("--actor-id") ?? "actor:cli",
    correlationId: values.get("--correlation-id") ?? "corr_cli",
    reasonCode: values.get("--reason-code"),
    receipt: values.get("--receipt"),
    decision: values.get("--decision"),
    subjectHash: values.get("--subject-hash"),
    receiptKeyId: values.get("--receipt-key-id")
  };
}

function writeContext(options: CliOptions, fallbackReasonCode: string): WriteContext {
  return {
    tenantId: options.tenantId,
    actorId: options.actorId,
    correlationId: options.correlationId,
    reasonCode: options.reasonCode ?? fallbackReasonCode,
    now: () => new Date().toISOString()
  };
}

function requireOption(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}
