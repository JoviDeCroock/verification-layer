import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import type {
  ChangeContract,
  Evidence,
  Mission,
  TrustConfig,
  Verifier,
  VerificationPlan,
} from "../../core/src/index.js";
import { generateMissions, runQa } from "../../qa/src/index.js";
import { runProcessWithRetries, type CommandResult } from "../../runner/src/index.js";

export interface VerifierRunResult {
  evidence: Evidence[];
  missions: Mission[];
}

type ProcessVerifier = Extract<Verifier, { kind: "playwright" }>;
type ProcessExpectation = ProcessVerifier["expect"];

function processPassed(result: CommandResult, expect: ProcessExpectation): boolean {
  return (
    !result.aborted &&
    !result.timedOut &&
    result.exitCode === expect.exit_code &&
    expect.stdout_contains.every((value) => result.stdout.includes(value)) &&
    expect.stderr_contains.every((value) => result.stderr.includes(value))
  );
}

function processFailureReason(result: CommandResult, expect: ProcessExpectation): string {
  const reasons: string[] = [];
  if (result.aborted) reasons.push("cancelled");
  if (result.timedOut) reasons.push("timed out");
  if (result.exitCode !== expect.exit_code)
    reasons.push(`exit ${result.exitCode}, expected ${expect.exit_code}`);
  for (const value of expect.stdout_contains)
    if (!result.stdout.includes(value)) reasons.push(`stdout omitted ${JSON.stringify(value)}`);
  for (const value of expect.stderr_contains)
    if (!result.stderr.includes(value)) reasons.push(`stderr omitted ${JSON.stringify(value)}`);
  return reasons.join("; ");
}

async function runPlaywrightVerifier(
  verifier: Extract<Verifier, { kind: "playwright" }>,
  repositoryRoot: string,
  previewUrl?: string,
  inheritEnv = false,
  signal?: AbortSignal,
  maxAttempts = 1,
  retryBackoffMs = 250,
): Promise<Evidence[]> {
  const results = await runProcessWithRetries(
    {
      executable: verifier.executable,
      args: verifier.args,
      cwd: path.resolve(repositoryRoot, verifier.cwd),
      timeoutMs: verifier.timeout_ms,
      env: {
        ...verifier.env,
        ...(previewUrl ? { TRUST_PREVIEW_URL: previewUrl } : {}),
      },
      inheritEnv,
      ...(signal ? { signal } : {}),
    },
    maxAttempts,
    retryBackoffMs,
    (result) => processPassed(result, verifier.expect),
  );
  return results.map((result, index) => {
    const passed = processPassed(result, verifier.expect);
    return {
      id: index === results.length - 1 ? verifier.id : `${verifier.id}:attempt-${index + 1}`,
      source_id: verifier.id,
      category: "e2e",
      status: passed ? "verified" : "failed",
      summary: passed
        ? `${verifier.label ?? verifier.id} passed${results.length > 1 ? ` on attempt ${index + 1}` : ""}.`
        : `${verifier.label ?? verifier.id} failed on attempt ${index + 1}: ${processFailureReason(result, verifier.expect)}`,
      command: [verifier.executable, ...verifier.args].join(" "),
      duration_ms: result.durationMs,
      stdout: result.stdout.slice(-12_000),
      stderr: result.stderr.slice(-12_000),
      measurements: { attempt: index + 1, max_attempts: results.length },
    } satisfies Evidence;
  });
}

async function runCliVerifier(
  verifier: Extract<Verifier, { kind: "cli" }>,
  repositoryRoot: string,
  inheritEnv = false,
  signal?: AbortSignal,
  maxAttempts = 1,
  retryBackoffMs = 250,
): Promise<Evidence[]> {
  const evidence: Evidence[] = [];
  for (const mission of verifier.missions) {
    const results = await runProcessWithRetries(
      {
        executable: mission.executable,
        args: mission.args,
        cwd: path.resolve(repositoryRoot, mission.cwd),
        timeoutMs: verifier.timeout_ms,
        env: mission.env,
        ...(mission.stdin === undefined ? {} : { stdin: mission.stdin }),
        inheritEnv,
        ...(signal ? { signal } : {}),
      },
      maxAttempts,
      retryBackoffMs,
      (result) => processPassed(result, mission.expect),
    );
    for (const [index, result] of results.entries()) {
      const passed = processPassed(result, mission.expect);
      evidence.push({
        id:
          index === results.length - 1
            ? `${verifier.id}:${mission.id}`
            : `${verifier.id}:${mission.id}:attempt-${index + 1}`,
        source_id: verifier.id,
        category: "cli",
        status: passed ? "verified" : "failed",
        summary: passed
          ? `CLI mission ${mission.id} passed${results.length > 1 ? ` on attempt ${index + 1}` : ""}.`
          : `CLI mission ${mission.id} failed on attempt ${index + 1}: ${processFailureReason(result, mission.expect)}`,
        command: [mission.executable, ...mission.args].join(" "),
        duration_ms: result.durationMs,
        stdout: result.stdout.slice(-12_000),
        stderr: result.stderr.slice(-12_000),
        measurements: { attempt: index + 1, max_attempts: results.length },
      });
    }
  }
  return evidence;
}

function jsonPath(value: unknown, expression: string): unknown {
  const segments = expression
    .replace(/^\$\.?/, "")
    .split(".")
    .filter(Boolean);
  let current = value;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment))
      return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

async function readBoundedBody(response: Response, maxBytes = 100_000): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      body += decoder.decode(value, { stream: true });
      if (bytes >= maxBytes) break;
    }
    body += decoder.decode();
  } finally {
    if (bytes >= maxBytes) await reader.cancel("verification response capture limit reached");
    reader.releaseLock();
  }
  return body.slice(0, maxBytes);
}

async function runRequestVerifier(
  verifier: Extract<Verifier, { kind: "requests" }>,
  previewUrl?: string,
  signal?: AbortSignal,
): Promise<Evidence[]> {
  const baseUrl = previewUrl ?? verifier.base_url;
  if (!baseUrl) {
    return [
      {
        id: verifier.id,
        source_id: verifier.id,
        category: "request",
        status: "not_verified",
        summary: `${verifier.label ?? verifier.id} has no preview or base URL.`,
        reason: "A request verifier cannot run without an explicit target.",
      },
    ];
  }
  const evidence: Evidence[] = [];
  for (const mission of verifier.requests) {
    const started = Date.now();
    try {
      const response = await fetch(new URL(mission.path, baseUrl), {
        method: mission.method,
        headers: mission.headers,
        ...(mission.body === undefined ? {} : { body: JSON.stringify(mission.body) }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(verifier.timeout_ms)])
          : AbortSignal.timeout(verifier.timeout_ms),
      });
      const body = await readBoundedBody(response);
      let passed = response.status === mission.expect.status;
      const reasons: string[] = [];
      if (!passed) reasons.push(`status ${response.status}, expected ${mission.expect.status}`);
      if (
        mission.expect.body_includes !== undefined &&
        !body.includes(mission.expect.body_includes)
      ) {
        passed = false;
        reasons.push(`body omitted ${JSON.stringify(mission.expect.body_includes)}`);
      }
      let observed: unknown;
      if (mission.expect.json_path !== undefined) {
        try {
          observed = jsonPath(JSON.parse(body), mission.expect.json_path);
          if (
            Object.hasOwn(mission.expect, "equals") &&
            !isDeepStrictEqual(observed, mission.expect.equals)
          ) {
            passed = false;
            reasons.push(
              `${mission.expect.json_path} was ${JSON.stringify(observed)}, expected ${JSON.stringify(mission.expect.equals)}`,
            );
          }
        } catch (error) {
          passed = false;
          reasons.push(
            `response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      evidence.push({
        id: `${verifier.id}:${mission.id}`,
        source_id: verifier.id,
        category: "request",
        status: passed ? "verified" : "failed",
        summary: passed
          ? `${mission.method} ${mission.path} satisfied its response contract.`
          : `${mission.method} ${mission.path} failed: ${reasons.join("; ")}`,
        duration_ms: Date.now() - started,
        ...(verifier.capture_body ? { stdout: body.slice(-12_000) } : {}),
        measurements: {
          status: response.status,
          response_bytes: Buffer.byteLength(body),
          ...(observed === undefined ? {} : { observed: JSON.stringify(observed) }),
        },
      });
    } catch (error) {
      evidence.push({
        id: `${verifier.id}:${mission.id}`,
        source_id: verifier.id,
        category: "request",
        status: "failed",
        summary: `${mission.method} ${mission.path} could not be verified.`,
        duration_ms: Date.now() - started,
        stderr: error instanceof Error ? error.stack : String(error),
      });
    }
  }
  return evidence;
}

function qaConfig(
  config: TrustConfig,
  verifier: Extract<Verifier, { kind: "agent-browser" | "agent-device" }>,
): TrustConfig {
  return {
    ...config,
    qa: {
      enabled: true,
      adapter: verifier.adapter,
      ...(verifier.executor ? { executor: verifier.executor } : {}),
      ...(verifier.base_url ? { preview_url: verifier.base_url } : {}),
      instructions: verifier.instructions,
      screenshot: verifier.screenshot,
      timeout_ms: verifier.timeout_ms,
    },
  };
}

async function runAgentVerifier(
  config: TrustConfig,
  verifier: Extract<Verifier, { kind: "agent-browser" | "agent-device" }>,
  contract: ChangeContract,
  repositoryRoot: string,
  outputDirectory: string,
  previewUrl?: string,
  signal?: AbortSignal,
): Promise<VerifierRunResult> {
  const missions = generateMissions(contract);
  if (verifier.kind === "agent-browser") {
    return runQa(
      qaConfig(config, verifier),
      contract,
      repositoryRoot,
      outputDirectory,
      previewUrl,
      {
        missions: missions.filter((mission) => mission.viewport === "desktop"),
        evidencePrefix: `agent-browser:${verifier.id}`,
        category: "qa",
        sourceId: verifier.id,
        ...(signal ? { signal } : {}),
      },
    );
  }

  const evidence: Evidence[] = [];
  for (const device of verifier.devices) {
    const result = await runQa(
      qaConfig(config, verifier),
      contract,
      repositoryRoot,
      outputDirectory,
      previewUrl,
      {
        missions,
        evidencePrefix: `agent-device:${verifier.id}:${device.name}`,
        category: "device",
        sourceId: verifier.id,
        viewport: { width: device.width, height: device.height },
        ...(device.user_agent ? { userAgent: device.user_agent } : {}),
        hasTouch: device.has_touch,
        ...(signal ? { signal } : {}),
      },
    );
    evidence.push(...result.evidence);
  }
  return { missions, evidence };
}

export async function runSelectedVerifiers(
  config: TrustConfig,
  plan: VerificationPlan,
  contract: ChangeContract,
  repositoryRoot: string,
  outputDirectory: string,
  previewUrl?: string,
  signal?: AbortSignal,
): Promise<VerifierRunResult> {
  const evidence: Evidence[] = [];
  const missions: Mission[] = [];
  for (const id of plan.selected_verifiers) {
    signal?.throwIfAborted();
    const verifier = config.verifiers.find((item) => item.id === id);
    if (!verifier) continue;
    if (verifier.kind === "playwright")
      evidence.push(
        ...(await runPlaywrightVerifier(
          verifier,
          repositoryRoot,
          previewUrl,
          config.execution?.inherit_environment === true,
          signal,
          config.execution?.max_attempts,
          config.execution?.retry_backoff_ms,
        )),
      );
    if (verifier.kind === "cli")
      evidence.push(
        ...(await runCliVerifier(
          verifier,
          repositoryRoot,
          config.execution?.inherit_environment === true,
          signal,
          config.execution?.max_attempts,
          config.execution?.retry_backoff_ms,
        )),
      );
    if (verifier.kind === "requests")
      evidence.push(...(await runRequestVerifier(verifier, previewUrl, signal)));
    if (verifier.kind === "agent-browser" || verifier.kind === "agent-device") {
      const result = await runAgentVerifier(
        config,
        verifier,
        contract,
        repositoryRoot,
        outputDirectory,
        previewUrl,
        signal,
      );
      evidence.push(...result.evidence);
      missions.push(...result.missions);
    }
  }
  return {
    evidence,
    missions: [...new Map(missions.map((mission) => [mission.id, mission])).values()],
  };
}
