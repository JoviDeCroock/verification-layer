import { appendFile } from "node:fs/promises";
import type { TrustReport } from "../../core/src/index.js";

function markdown(value: string): string {
  return value
    .replace(/[\\`*_{[\]}()<>#+.!|~-]/g, "\\$&")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
}

function workflowData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function environmentValue(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

export function renderGitHubSummary(report: TrustReport): string {
  const claims = report.evidence.filter((item) => item.category === "claim");
  const counts = report.evidence.reduce(
    (result, item) => {
      result[item.status] += 1;
      return result;
    },
    { verified: 0, failed: 0, not_verified: 0, not_applicable: 0 },
  );
  return [
    `## ${report.verdict === "trusted" ? "✅" : "❌"} Trust authority`,
    "",
    `**Verdict:** ${markdown(report.verdict)}`,
    `**Run:** \`${markdown(report.run_id)}\`  `,
    `**Commit:** \`${markdown(report.provenance.repository.head_sha ?? "unavailable")}\``,
    "",
    `Evidence: ${counts.verified} verified · ${counts.failed} failed · ${counts.not_verified} not verified · ${counts.not_applicable} not applicable`,
    "",
    "### Behavior claims",
    "",
    ...(claims.length
      ? claims.map(
          (claim) =>
            `- ${claim.status === "verified" ? "✅" : claim.status === "failed" ? "❌" : "⚠️"} ${markdown(claim.summary)}`,
        )
      : ["- ⚠️ No behavior claims were produced."]),
    "",
  ].join("\n");
}

export async function publishGitHubReport(
  report: TrustReport,
  reportFile: string,
  environment: NodeJS.ProcessEnv = process.env,
  writeAnnotation: (line: string) => void = console.log,
): Promise<boolean> {
  if (environment.GITHUB_ACTIONS !== "true") return false;
  if (environment.GITHUB_STEP_SUMMARY)
    await appendFile(environment.GITHUB_STEP_SUMMARY, renderGitHubSummary(report), "utf8");
  if (environment.GITHUB_OUTPUT)
    await appendFile(
      environment.GITHUB_OUTPUT,
      [
        `trust_verdict=${environmentValue(report.verdict)}`,
        `trust_run_id=${environmentValue(report.run_id)}`,
        `trust_report=${environmentValue(reportFile)}`,
        `trust_head_sha=${environmentValue(report.provenance.repository.head_sha ?? "")}`,
        "",
      ].join("\n"),
      "utf8",
    );
  for (const claim of report.evidence.filter(
    (item) => item.category === "claim" && item.status !== "verified",
  ))
    writeAnnotation(
      `::${claim.status === "failed" ? "error" : "warning"} title=Trust authority::${workflowData(claim.summary)}`,
    );
  return true;
}
