import type { Evidence, TrustConfig, VerificationPlan } from "../../core/src/index.js";
import { runCommand } from "../../runner/src/index.js";

export interface InvariantDefinition {
  id: string;
  scope: string[];
  measure(context: { exec(command: string): Promise<number> }): Promise<number>;
  assert(input: { baseline?: number; current: number }): boolean;
}

export function defineInvariant(definition: InvariantDefinition): InvariantDefinition {
  return definition;
}

function measurementFrom(stdout: string): number | null {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { value?: unknown };
      if (typeof parsed.value === "number") return parsed.value;
    } catch {
      const match = line.match(/(-?\d+(?:\.\d+)?)/);
      if (match) return Number(match[1]);
    }
  }
  return null;
}

export async function runSelectedInvariants(
  config: TrustConfig,
  plan: VerificationPlan,
  cwd: string,
): Promise<Evidence[]> {
  const evidence: Evidence[] = [];
  for (const id of plan.selected_invariants) {
    const invariant = config.invariants.find((item) => item.id === id);
    if (!invariant) continue;
    const result = await runCommand(invariant.command, cwd, invariant.timeout_ms);
    const current = measurementFrom(result.stdout);
    const allowed =
      current !== null &&
      (invariant.threshold.max === undefined || current <= invariant.threshold.max) &&
      (invariant.threshold.regression === undefined ||
        invariant.baseline === undefined ||
        current <= invariant.baseline + invariant.threshold.regression);
    const passed = result.exitCode === 0 && allowed;
    evidence.push({
      id,
      category: "invariant",
      status: passed ? "verified" : "failed",
      summary:
        current === null
          ? `${invariant.label ?? id} did not emit a numeric measurement.`
          : `${invariant.label ?? id}: ${current} ${invariant.unit}${passed ? " within" : " outside"} threshold.`,
      command: invariant.command,
      duration_ms: result.durationMs,
      stdout: result.stdout.slice(-12_000),
      stderr: result.stderr.slice(-12_000),
      measurements: {
        ...(current === null ? {} : { current }),
        ...(invariant.baseline === undefined ? {} : { baseline: invariant.baseline }),
        ...(invariant.threshold.max === undefined ? {} : { max: invariant.threshold.max }),
        ...(invariant.threshold.regression === undefined
          ? {}
          : { allowed_regression: invariant.threshold.regression }),
        unit: invariant.unit,
      },
    });
  }
  return evidence;
}
