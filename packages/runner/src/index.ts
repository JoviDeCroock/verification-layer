import { spawn } from "node:child_process";
import type { Evidence, TrustConfig, VerificationPlan } from "../../core/src/index.js";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
}

export interface ProcessInput {
  executable: string;
  args?: string[];
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
  stdin?: string;
  shell?: boolean;
  inheritEnv?: boolean;
  signal?: AbortSignal;
}

const MAX_CAPTURE_BYTES = 1_000_000;

function appendBounded(current: string, chunk: Buffer): string {
  const next = current + chunk.toString();
  return next.length <= MAX_CAPTURE_BYTES ? next : next.slice(-MAX_CAPTURE_BYTES);
}

export async function runProcess(input: ProcessInput): Promise<CommandResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    // Some repositories augment ProcessEnv with application-specific required
    // keys. The runner deliberately does not promise those keys when isolation
    // is enabled, so keep the constructed environment structurally generic.
    const environment = {
      ...(input.inheritEnv === false ? safeEnvironment() : process.env),
      ...input.env,
    } as unknown as NodeJS.ProcessEnv;
    const child = spawn(input.executable, input.args ?? [], {
      cwd: input.cwd,
      env: environment,
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
    let aborted = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
        aborted,
      });
    };
    const terminate = (exitCode: number) => {
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
        finish(exitCode);
      }, 2_000);
    };
    const onAbort = () => {
      aborted = true;
      terminate(130);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(124);
    }, input.timeoutMs);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    child.on("error", (error) => {
      stderr = appendBounded(stderr, Buffer.from(error.message));
      finish(1);
    });
    child.on("close", (code) => finish(aborted ? 130 : timedOut ? 124 : (code ?? 1)));
  });
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds === 0) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new Error("Verification cancelled."));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function runProcessWithRetries(
  input: ProcessInput,
  maxAttempts = 1,
  retryBackoffMs = 250,
  accept: (result: CommandResult) => boolean = (result) => result.exitCode === 0,
): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    input.signal?.throwIfAborted();
    const result = await runProcess(input);
    results.push(result);
    if (accept(result) || result.aborted || attempt === maxAttempts) break;
    await abortableDelay(retryBackoffMs, input.signal);
  }
  return results;
}

function safeEnvironment(): Record<string, string> {
  const allowed = [
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "CI",
    "NO_COLOR",
    "FORCE_COLOR",
    "TERM",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
  ];
  const entries: Array<[string, string]> = [];
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) entries.push([name, value]);
  }
  return Object.fromEntries(entries);
}

export async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  inheritEnv = true,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return runProcess({
    executable: command,
    cwd,
    timeoutMs,
    shell: true,
    inheritEnv,
    ...(signal ? { signal } : {}),
  });
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
  signal?: AbortSignal,
): Promise<Evidence[]> {
  const evidence: Evidence[] = [];
  for (const id of plan.selected_checks) {
    signal?.throwIfAborted();
    const check = config.checks.find((item) => item.id === id);
    if (!check) continue;
    if (config.execution?.allow_shell_commands !== true) {
      evidence.push({
        id: check.id,
        source_id: check.id,
        category: categoryFor(check.kind),
        status: "not_verified",
        summary: `${check.label ?? check.id} was not executed.`,
        reason: "Repository policy does not authorize shell-backed command checks.",
      });
      continue;
    }
    const results = await runProcessWithRetries(
      {
        executable: check.command,
        cwd,
        timeoutMs: check.timeout_ms,
        shell: true,
        inheritEnv: config.execution?.inherit_environment === true,
        ...(signal ? { signal } : {}),
      },
      config.execution?.max_attempts,
      config.execution?.retry_backoff_ms,
    );
    for (const [index, result] of results.entries())
      evidence.push({
        id: index === results.length - 1 ? check.id : `${check.id}:attempt-${index + 1}`,
        source_id: check.id,
        category: categoryFor(check.kind),
        status: result.exitCode === 0 ? "verified" : "failed",
        summary:
          result.exitCode === 0
            ? `${check.label ?? check.id} passed${results.length > 1 ? ` on attempt ${index + 1}` : ""}.`
            : `${check.label ?? check.id} failed on attempt ${index + 1}${result.timedOut ? " (timed out)" : result.aborted ? " (cancelled)" : ""}.`,
        command: check.command,
        duration_ms: result.durationMs,
        stdout: result.stdout.slice(-12_000),
        stderr: result.stderr.slice(-12_000),
        measurements: { attempt: index + 1, max_attempts: results.length },
      });
  }
  return evidence;
}
