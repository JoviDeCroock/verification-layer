import type { Evidence, TrustConfig, VerificationPlan } from "../../core/src/index.js";
import { runProcessWithRetries } from "../../runner/src/index.js";

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
  signal?: AbortSignal,
): Promise<Evidence[]> {
  const evidence: Evidence[] = [];
  for (const id of plan.selected_invariants) {
    signal?.throwIfAborted();
    const invariant = config.invariants.find((item) => item.id === id);
    if (!invariant) continue;
    if (config.execution?.allow_shell_commands !== true) {
      evidence.push({
        id,
        source_id: id,
        category: "invariant",
        status: "not_verified",
        summary: `${invariant.label ?? id} was not measured.`,
        reason: "Repository policy does not authorize shell-backed invariant commands.",
      });
      continue;
    }
    const results = await runProcessWithRetries(
      {
        executable: invariant.command,
        cwd,
        timeoutMs: invariant.timeout_ms,
        shell: true,
        inheritEnv: config.execution?.inherit_environment === true,
        ...(signal ? { signal } : {}),
      },
      config.execution?.max_attempts,
      config.execution?.retry_backoff_ms,
    );
    for (const [index, result] of results.entries()) {
      const current = measurementFrom(result.stdout);
      const allowed =
        current !== null &&
        (invariant.threshold.max === undefined || current <= invariant.threshold.max) &&
        (invariant.threshold.regression === undefined ||
          invariant.baseline === undefined ||
          current <= invariant.baseline + invariant.threshold.regression);
      const passed = result.exitCode === 0 && allowed;
      evidence.push({
        id: index === results.length - 1 ? id : `${id}:attempt-${index + 1}`,
        source_id: id,
        category: "invariant",
        status: passed ? "verified" : "failed",
        summary:
          current === null
            ? `${invariant.label ?? id} did not emit a numeric measurement on attempt ${index + 1}.`
            : result.aborted
              ? `${invariant.label ?? id} was cancelled.`
              : `${invariant.label ?? id}: ${current} ${invariant.unit}${passed ? " within" : " outside"} threshold on attempt ${index + 1}.`,
        command: invariant.command,
        duration_ms: result.durationMs,
        stdout: result.stdout.slice(-12_000),
        stderr: result.stderr.slice(-12_000),
        measurements: {
          attempt: index + 1,
          max_attempts: results.length,
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
  }
  return evidence;
}
