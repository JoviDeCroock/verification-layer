import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { TrustReport } from "../packages/core/src/index.js";

const root = process.cwd();
const demo = path.join(root, "examples", "demo-app");
const bin = (name: string) => path.join(root, "node_modules", ".bin", name);

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: string[],
  cwd = root,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function waitFor(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Preview exited before becoming ready (${child.exitCode}).`);
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {
      // Preview is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Preview did not become ready at ${url}.`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function proveVariant(variant: "broken" | "fixed", port: number): Promise<TrustReport> {
  const state = await mkdtemp(path.join(os.tmpdir(), `trust-${variant}-`));
  const output = path.join(demo, ".trust", "runs", variant);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const migration = await run(
    bin("wrangler"),
    ["d1", "migrations", "apply", "trust-demo", "--local", "--persist-to", state],
    demo,
    { ...process.env, CI: "1" },
  );
  if (migration.code !== 0)
    throw new Error(
      `D1 migration failed for ${variant}:\n${migration.stdout}\n${migration.stderr}`,
    );

  const preview = spawn(
    bin("wrangler"),
    ["dev", "--port", String(port), "--persist-to", state, "--var", `DEMO_VARIANT:${variant}`],
    {
      cwd: demo,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let previewLog = "";
  preview.stdout.on("data", (chunk: Buffer) => (previewLog += chunk.toString()));
  preview.stderr.on("data", (chunk: Buffer) => (previewLog += chunk.toString()));
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitFor(url, preview);
    const verification = await run(process.execPath, [
      "--import",
      "tsx",
      "packages/cli/src/index.ts",
      "verify",
      "--config",
      "examples/demo-app/trust.yaml",
      "--contract",
      "examples/demo-app/change-contract.yaml",
      "--changed",
      "src/worker.ts,src/client.tsx",
      "--preview-url",
      url,
      "--output",
      path.relative(root, output),
    ]);
    await writeFile(
      path.join(output, "command-output.txt"),
      `${verification.stdout}\n${verification.stderr}`,
      "utf8",
    );
    const report = JSON.parse(
      await readFile(path.join(output, "report.json"), "utf8"),
    ) as TrustReport;
    const standardEvidence = report.evidence.filter((item) =>
      ["typecheck", "unit-tests", "client-build", "demo-client-bundle"].includes(item.id),
    );
    if (!standardEvidence.length || standardEvidence.some((item) => item.status !== "verified"))
      throw new Error(`${variant}: deterministic evidence did not all pass.`);
    const duplicateQa = report.evidence.find(
      (item) => item.category === "qa" && item.id.endsWith(":duplicate-submission"),
    );
    if (
      variant === "broken" &&
      (report.verdict !== "not_trusted" || duplicateQa?.status !== "failed")
    )
      throw new Error("Broken variant was not rejected by duplicate-submission QA.");
    if (variant === "fixed") {
      const requiredCategories = ["e2e", "request", "cli", "qa", "device", "invariant"];
      const missingCategory = requiredCategories.find(
        (category) => !report.evidence.some((item) => item.category === category),
      );
      if (report.verdict !== "trusted" || missingCategory)
        throw new Error(
          `Fixed variant was not trusted across the full verifier matrix${missingCategory ? `; missing ${missingCategory}` : ""}.`,
        );
    }
    return report;
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nPreview log:\n${previewLog.slice(-15_000)}`,
    );
  } finally {
    await stop(preview);
    await rm(state, { recursive: true, force: true });
  }
}

const build = await run("pnpm", ["--dir", demo, "build"]);
if (build.code !== 0) throw new Error(`Demo build failed:\n${build.stdout}\n${build.stderr}`);

const broken = await proveVariant("broken", 4317);
const fixed = await proveVariant("fixed", 4318);
const summary = {
  proven_at: new Date().toISOString(),
  thesis:
    "The full verifier matrix stays deterministic; independent browser and device agents reject the duplicate-invitation bug while the fixed implementation passes every required evidence category.",
  broken: {
    verdict: broken.verdict,
    matrix: broken.evidence
      .filter((item) => item.category !== "plan")
      .map((item) => ({
        id: item.id,
        category: item.category,
        status: item.status,
        summary: item.summary,
      })),
  },
  fixed: {
    verdict: fixed.verdict,
    matrix: fixed.evidence
      .filter((item) => item.category !== "plan")
      .map((item) => ({
        id: item.id,
        category: item.category,
        status: item.status,
        summary: item.summary,
      })),
  },
};
await writeFile(
  path.join(demo, ".trust", "runs", "proof-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(summary, null, 2));
