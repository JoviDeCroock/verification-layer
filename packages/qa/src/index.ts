import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { ChangeContract, Evidence, Mission, TrustConfig } from "../../core/src/index.js";

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
}

function behaviorMission(behavior: string, index: number): Mission {
  const normalized = behavior.toLowerCase();
  if (/duplicate|twice|idempotent/.test(normalized)) {
    return {
      id: "duplicate-submission",
      title: "Retry and duplicate submission",
      objective: behavior,
      derived_from: [behavior],
      risk: "state integrity",
      viewport: "desktop",
    };
  }
  if (/non-admin|unauthori[sz]ed|permission/.test(normalized)) {
    return {
      id: "authorization",
      title: "Unauthorized actor is denied",
      objective: behavior,
      derived_from: [behavior],
      risk: "authorization",
      viewport: "desktop",
    };
  }
  if (/expir/.test(normalized)) {
    return {
      id: "expiration",
      title: "Expired artifact is rejected",
      objective: behavior,
      derived_from: [behavior],
      risk: "time boundary",
      viewport: "desktop",
    };
  }
  if (/unchanged|regression|existing/.test(normalized)) {
    return {
      id: "regression",
      title: "Existing adjacent journey remains intact",
      objective: behavior,
      derived_from: [behavior],
      viewport: "desktop",
    };
  }
  return {
    id: index === 0 ? "happy-path" : `behavior-${index + 1}`,
    title: behavior,
    objective: behavior,
    derived_from: [behavior],
    viewport: "desktop",
  };
}

export function generateMissions(contract: ChangeContract): Mission[] {
  const missions = contract.expected_behaviors.map(behaviorMission);
  if (contract.risks.some((risk) => /ui|responsive|mobile/.test(risk.toLowerCase()))) {
    missions.push({
      id: "mobile-journey",
      title: "Primary journey works on a mobile viewport",
      objective: contract.intent,
      derived_from: ["risk heuristic: mobile"],
      risk: "responsive UI",
      viewport: "mobile",
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

export async function runQa(
  config: TrustConfig,
  contract: ChangeContract,
  repositoryRoot: string,
  outputDirectory: string,
  previewOverride?: string,
  options: QaRunOptions = {},
): Promise<QaRunResult> {
  const missions = options.missions ?? generateMissions(contract);
  const evidencePrefix = options.evidencePrefix ?? "qa";
  const category = options.category ?? "qa";
  const evidenceId = (mission: Mission) => `${evidencePrefix}:${mission.id}`;
  if (!config.qa.adapter) {
    return {
      missions,
      evidence: missions.map((mission) => ({
        id: evidenceId(mission),
        category,
        status: "not_verified",
        summary: mission.title,
        reason: "No QA adapter is configured.",
      })),
    };
  }
  const previewUrl = previewOverride ?? config.qa.preview_url;
  if (!previewUrl) {
    return {
      missions,
      evidence: missions.map((mission) => ({
        id: evidenceId(mission),
        category,
        status: "not_verified",
        summary: mission.title,
        reason: "No preview URL was provided.",
      })),
    };
  }

  const adapter = await loadAdapter(path.resolve(repositoryRoot, config.qa.adapter));
  await mkdir(path.join(outputDirectory, "evidence", "screenshots"), { recursive: true });
  let browser: Browser | undefined;
  const evidence: Evidence[] = [];
  try {
    browser = await chromium.launch({ headless: true });
    for (const mission of missions) {
      if (!adapter.supports(mission)) {
        evidence.push({
          id: evidenceId(mission),
          category,
          status: "not_verified",
          summary: mission.title,
          reason: "The repository QA adapter has no driver for this intent-derived mission.",
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
          `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "failed"}`,
        ),
      );
      page.on("response", (response) => {
        if (response.status() >= 400)
          errorResponses.push({ status: response.status(), url: response.url() });
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
            final_url: page.url(),
            console_errors: consoleErrors.length,
            failed_requests: failedRequests.length,
            http_error_responses: errorResponses.length,
          },
          artifacts: config.qa.screenshot ? [path.relative(outputDirectory, artifact)] : [],
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
          category,
          status: "failed",
          summary: `${mission.title} failed to execute.`,
          duration_ms: Date.now() - started,
          stderr: error instanceof Error ? error.stack : String(error),
          artifacts: [path.relative(outputDirectory, artifact)],
        });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser?.close();
  }
  return { missions, evidence };
}
