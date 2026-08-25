import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type {
  ChangeContract,
  Evidence,
  ExpectedBehavior,
  Mission,
  TrustConfig,
} from "../../core/src/index.js";
import { sha256 } from "../../core/src/provenance.js";

export interface QaObservation {
  status: "verified" | "failed" | "not_verified";
  summary: string;
  measurements?: Record<string, string | number | boolean>;
  expected_statuses?: number[];
}

export interface QaMissionContext {
  mission: Mission;
  page: Page;
  context: BrowserContext;
  previewUrl: string;
}

export interface QaAdapter {
  supports(mission: Mission): boolean;
  execute(context: QaMissionContext): Promise<QaObservation>;
}

export interface QaRunResult {
  missions: Mission[];
  evidence: Evidence[];
}

export interface QaRunOptions {
  missions?: Mission[];
  evidencePrefix?: string;
  category?: Evidence["category"];
  viewport?: { width: number; height: number };
  userAgent?: string;
  hasTouch?: boolean;
  sourceId?: string;
  signal?: AbortSignal;
}

const GENERATOR = "executable-trust-layer/intent-heuristics";
const GENERATOR_VERSION = "1";

function deterministicGeneration(input: unknown): NonNullable<Mission["generation"]> {
  return {
    method: "deterministic",
    generator: GENERATOR,
    version: GENERATOR_VERSION,
    input_sha256: sha256(input),
  };
}

function behaviorMission(behavior: ExpectedBehavior): Mission {
  const normalized = behavior.description.toLowerCase();
  const generation = deterministicGeneration({
    expected_behavior: { id: behavior.id, description: behavior.description },
  });
  if (/duplicate|twice|idempotent/.test(normalized)) {
    return {
      id: behavior.id,
      title: "Retry and duplicate submission",
      objective: behavior.description,
      derived_from: [behavior.description],
      risk: "state integrity",
      viewport: "desktop",
      generation,
    };
  }
  if (/non-admin|unauthori[sz]ed|permission/.test(normalized)) {
    return {
      id: behavior.id,
      title: "Unauthorized actor is denied",
      objective: behavior.description,
      derived_from: [behavior.description],
      risk: "authorization",
      viewport: "desktop",
      generation,
    };
  }
  if (/expir/.test(normalized)) {
    return {
      id: behavior.id,
      title: "Expired artifact is rejected",
      objective: behavior.description,
      derived_from: [behavior.description],
      risk: "time boundary",
      viewport: "desktop",
      generation,
    };
  }
  if (/unchanged|regression|existing/.test(normalized)) {
    return {
      id: behavior.id,
      title: "Existing adjacent journey remains intact",
      objective: behavior.description,
      derived_from: [behavior.description],
      viewport: "desktop",
      generation,
    };
  }
  return {
    id: behavior.id,
    title: behavior.description,
    objective: behavior.description,
    derived_from: [behavior.description],
    viewport: "desktop",
    generation,
  };
}

export function generateMissions(contract: ChangeContract): Mission[] {
  if (contract.qa_missions?.length) return contract.qa_missions;
  const missions = contract.expected_behaviors.map(behaviorMission);
  if (contract.risks.some((risk) => /ui|responsive|mobile/.test(risk.toLowerCase()))) {
    missions.push({
      id: "mobile-journey",
      title: "Primary journey works on a mobile viewport",
      objective: contract.intent,
      derived_from: ["risk heuristic: mobile"],
      risk: "responsive UI",
      viewport: "mobile",
      generation: deterministicGeneration({
        intent: contract.intent,
        risk_heuristic: "mobile",
        matching_risks: contract.risks.filter((risk) =>
          /ui|responsive|mobile/.test(risk.toLowerCase()),
        ),
      }),
    });
  }
  return [...new Map(missions.map((mission) => [mission.id, mission])).values()];
}

async function loadAdapter(file: string): Promise<QaAdapter> {
  const module = (await import(`${pathToFileUrl(file)}?t=${Date.now()}`)) as {
    default?: QaAdapter;
    adapter?: QaAdapter;
  };
  const adapter = module.default ?? module.adapter;
  if (!adapter) throw new Error(`QA adapter ${file} did not export a default adapter.`);
  return adapter;
}

function pathToFileUrl(file: string): string {
  return new URL(`file://${path.resolve(file)}`).href;
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split(/[?#]/, 1)[0]!;
  }
}

export async function runQa(
  config: TrustConfig,
  contract: ChangeContract,
  repositoryRoot: string,
  outputDirectory: string,
  previewOverride?: string,
  options: QaRunOptions = {},
): Promise<QaRunResult> {
  options.signal?.throwIfAborted();
  const missions = options.missions ?? generateMissions(contract);
  const evidencePrefix = options.evidencePrefix ?? "qa";
  const category = options.category ?? "qa";
  const evidenceId = (mission: Mission) => `${evidencePrefix}:${mission.id}`;
  const sourceId = options.sourceId ?? "qa";
  const executor = config.qa.executor;
  if (!config.qa.adapter) {
    return {
      missions,
      evidence: missions.map((mission) => ({
        id: evidenceId(mission),
        source_id: sourceId,
        category,
        status: "not_verified",
        summary: mission.title,
        reason: "No QA adapter is configured.",
      })),
    };
  }
  if (!executor) {
    return {
      missions,
      evidence: missions.map((mission) => ({
        id: evidenceId(mission),
        source_id: sourceId,
        category,
        status: "not_verified",
        summary: mission.title,
        reason: "QA executor provenance is not declared in repository policy.",
      })),
    };
  }
  const previewUrl = previewOverride ?? config.qa.preview_url;
  if (!previewUrl) {
    return {
      missions,
      evidence: missions.map((mission) => ({
        id: evidenceId(mission),
        source_id: sourceId,
        category,
        status: "not_verified",
        summary: mission.title,
        reason: "No preview URL was provided.",
      })),
    };
  }

  let adapter: QaAdapter;
  try {
    adapter = await loadAdapter(path.resolve(repositoryRoot, config.qa.adapter));
  } catch (error) {
    return {
      missions,
      evidence: missions.map((mission) => ({
        id: evidenceId(mission),
        source_id: sourceId,
        category,
        status: "not_verified",
        summary: mission.title,
        reason: `QA adapter could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      })),
    };
  }
  await mkdir(path.join(outputDirectory, "evidence", "screenshots"), { recursive: true });
  let browser: Browser | undefined;
  const evidence: Evidence[] = [];
  const closeBrowser = () => void browser?.close();
  options.signal?.addEventListener("abort", closeBrowser, { once: true });
  try {
    browser = await chromium.launch({ headless: true });
    for (const mission of missions) {
      options.signal?.throwIfAborted();
      if (!adapter.supports(mission)) {
        evidence.push({
          id: evidenceId(mission),
          source_id: sourceId,
          category,
          status: "not_verified",
          summary: mission.title,
          reason: "The repository QA adapter has no driver for this intent-derived mission.",
          executor,
        });
        continue;
      }
      const context = await browser.newContext({
        viewport:
          options.viewport ??
          (mission.viewport === "mobile"
            ? { width: 390, height: 844 }
            : { width: 1280, height: 900 }),
        ...(options.userAgent ? { userAgent: options.userAgent } : {}),
        ...(options.hasTouch === undefined ? {} : { hasTouch: options.hasTouch }),
      });
      const page = await context.newPage();
      const consoleErrors: string[] = [];
      const failedRequests: string[] = [];
      const errorResponses: Array<{ status: number; url: string }> = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("pageerror", (error) => consoleErrors.push(error.message));
      page.on("requestfailed", (request) =>
        failedRequests.push(
          `${request.method()} ${safeUrl(request.url())}: ${request.failure()?.errorText ?? "failed"}`,
        ),
      );
      page.on("response", (response) => {
        if (response.status() >= 400)
          errorResponses.push({ status: response.status(), url: safeUrl(response.url()) });
      });
      const started = Date.now();
      try {
        const observation = await Promise.race([
          adapter.execute({ mission, page, context, previewUrl }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("QA mission timed out")), config.qa.timeout_ms),
          ),
        ]);
        const artifact = path.join(
          outputDirectory,
          "evidence",
          "screenshots",
          `${evidencePrefix.replace(/[^a-z0-9_-]/gi, "-")}-${mission.id}.png`,
        );
        if (config.qa.screenshot) await page.screenshot({ path: artifact, fullPage: true });
        const expectedStatuses = new Set(observation.expected_statuses ?? []);
        const unexpectedResponses = errorResponses.filter(
          (response) => !expectedStatuses.has(response.status),
        );
        const unexpectedConsoleErrors = consoleErrors.filter((message) => {
          return !(expectedStatuses.size > 0 && message.startsWith("Failed to load resource:"));
        });
        const infrastructureFailure =
          unexpectedConsoleErrors.length > 0 ||
          failedRequests.length > 0 ||
          unexpectedResponses.length > 0;
        evidence.push({
          id: evidenceId(mission),
          source_id: sourceId,
          category,
          status:
            observation.status === "verified" && infrastructureFailure
              ? "failed"
              : observation.status,
          summary: infrastructureFailure
            ? `${observation.summary} Browser errors were observed.`
            : observation.summary,
          duration_ms: Date.now() - started,
          measurements: {
            ...observation.measurements,
            final_url: safeUrl(page.url()),
            console_errors: consoleErrors.length,
            failed_requests: failedRequests.length,
            http_error_responses: errorResponses.length,
          },
          artifacts: config.qa.screenshot ? [path.relative(outputDirectory, artifact)] : [],
          executor,
          ...(infrastructureFailure
            ? {
                stderr: [
                  ...unexpectedConsoleErrors,
                  ...failedRequests,
                  ...unexpectedResponses.map((response) => `${response.status} ${response.url}`),
                ].join("\n"),
              }
            : {}),
        });
      } catch (error) {
        const artifact = path.join(
          outputDirectory,
          "evidence",
          "screenshots",
          `${evidencePrefix.replace(/[^a-z0-9_-]/gi, "-")}-${mission.id}-failure.png`,
        );
        await page.screenshot({ path: artifact, fullPage: true }).catch(() => undefined);
        evidence.push({
          id: evidenceId(mission),
          source_id: sourceId,
          category,
          status: "failed",
          summary: `${mission.title} failed to execute.`,
          duration_ms: Date.now() - started,
          stderr: error instanceof Error ? error.stack : String(error),
          artifacts: [path.relative(outputDirectory, artifact)],
          executor,
        });
      } finally {
        await context.close();
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", closeBrowser);
    await browser?.close();
  }
  return { missions, evidence };
}
