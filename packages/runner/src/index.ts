import { spawn } from "node:child_process";
import type { Evidence, TrustConfig, VerificationPlan } from "../../core/src/index.js";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ProcessInput {
  executable: string;
  args?: string[];
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
  stdin?: string;
  shell?: boolean;
}

const MAX_CAPTURE_BYTES = 1_000_000;

function appendBounded(current: string, chunk: Buffer): string {
  const next = current + chunk.toString();
  return next.length <= MAX_CAPTURE_BYTES ? next : next.slice(-MAX_CAPTURE_BYTES);
}

export async function runProcess(input: ProcessInput): Promise<CommandResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(input.executable, input.args ?? [], {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      shell: input.shell ?? false,
      detached: process.platform !== "win32",
      stdio: [input.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;
    child.stdout?.on("data", (chunk: Buffer) => (stdout = appendBounded(stdout, chunk)));
    child.stderr?.on("data", (chunk: Buffer) => (stderr = appendBounded(stderr, chunk)));
    if (input.stdin !== undefined) child.stdin?.end(input.stdin);
    let timedOut = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      resolve({ exitCode, stdout, stderr, durationMs: Date.now() - started, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      forceTimer = setTimeout(() => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        finish(124);
      }, 2_000);
    }, input.timeoutMs);
    child.on("error", (error) => {
      stderr = appendBounded(stderr, Buffer.from(error.message));
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}

export async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  return runProcess({ executable: command, cwd, timeoutMs, shell: true });
}

function categoryFor(kind: TrustConfig["checks"][number]["kind"]): Evidence["category"] {
  if (kind === "test") return "test";
  if (kind === "e2e") return "e2e";
  if (kind === "security") return "security";
  if (kind === "architecture") return "architecture";
  return "static";
}

export async function runSelectedChecks(
  config: TrustConfig,
  plan: VerificationPlan,
  cwd: string,
): Promise<Evidence[]> {
  const evidence: Evidence[] = [];
  for (const id of plan.selected_checks) {
    const check = config.checks.find((item) => item.id === id);
    if (!check) continue;
    const result = await runCommand(check.command, cwd, check.timeout_ms);
    evidence.push({
      id: check.id,
      category: categoryFor(check.kind),
      status: result.exitCode === 0 ? "verified" : "failed",
      summary:
        result.exitCode === 0
          ? `${check.label ?? check.id} passed.`
          : `${check.label ?? check.id} failed${result.timedOut ? " (timed out)" : ""}.`,
      command: check.command,
      duration_ms: result.durationMs,
      stdout: result.stdout.slice(-12_000),
      stderr: result.stderr.slice(-12_000),
    });
  }
  return evidence;
}
