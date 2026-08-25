import pc from "picocolors";
import type { Evidence, TrustReport } from "../../core/src/index.js";

const statusIcon = (status: Evidence["status"]): string => {
  if (status === "verified") return "✓";
  if (status === "failed") return "✗";
  if (status === "not_applicable") return "–";
  return "!";
};

const terminalIcon = (status: Evidence["status"]): string => {
  const icon = statusIcon(status);
  if (status === "verified") return pc.green(icon);
  if (status === "failed") return pc.red(icon);
  if (status === "not_verified") return pc.yellow(icon);
  return pc.dim(icon);
};

export function renderTerminalReport(report: TrustReport): string {
  const lines = [
    pc.bold("CHANGE VERIFICATION"),
    "",
    pc.bold("Intent"),
    report.contract.intent,
    "",
    pc.bold("Plan"),
  ];
  lines.push(
    `${report.contract.approval.status === "approved" ? pc.green("✓") : pc.red("✗")} ${report.contract.approval.status}`,
  );
  lines.push(
    "",
    pc.bold("Implementation"),
    `${report.implementation.changed_files} changed file(s)`,
  );
  lines.push("", pc.bold("Verification"));
  for (const evidence of report.evidence)
    lines.push(`${terminalIcon(evidence.status)} ${evidence.summary}`);
  lines.push("", pc.bold("Experiential evidence"));
  const qa = report.evidence.filter((item) => item.category === "qa" || item.category === "device");
  if (!qa.length) lines.push(`${pc.dim("–")} Not applicable`);
  for (const item of qa) lines.push(`${terminalIcon(item.status)} ${item.summary}`);
  lines.push("", pc.bold("Unverified assumptions"));
  if (!report.unknowns.length) lines.push(`${pc.green("✓")} None recorded`);
  for (const unknown of report.unknowns) lines.push(`${pc.yellow("!")} ${unknown}`);
  lines.push("", pc.bold("Learning proposals"));
  if (!report.learning_proposals.length) lines.push(`${pc.dim("–")} None`);
  for (const proposal of report.learning_proposals)
    lines.push(`${pc.cyan("+")} [${proposal.type}] ${proposal.description}`);
  lines.push("", pc.bold("VERDICT"));
  if (report.verdict === "trusted") lines.push(pc.green("✓ Change satisfies approved intent."));
  if (report.verdict === "not_trusted")
    lines.push(pc.red("✗ Change does not satisfy approved intent."));
  if (report.verdict === "insufficient_evidence")
    lines.push(pc.yellow("! Evidence is insufficient to trust this change."));
  return `${lines.join("\n")}\n`;
}

export function renderMarkdownReport(report: TrustReport): string {
  const lines = [
    "# Change verification",
    "",
    "## Intent",
    "",
    report.contract.intent,
    "",
    "## Plan",
    "",
    `- ${report.contract.approval.status === "approved" ? "✅" : "❌"} ${report.contract.approval.status}`,
    "",
    "## Implementation",
    "",
    `- ${report.implementation.changed_files} changed file(s)`,
    "",
    "## Verification",
    "",
  ];
  for (const evidence of report.evidence)
    lines.push(`- ${statusIcon(evidence.status)} **${evidence.id}** — ${evidence.summary}`);
  lines.push("", "## Evidence selection", "");
  for (const [id, reasons] of Object.entries(report.plan.selection_reasons))
    lines.push(`- **${id}**: ${reasons.join("; ")}`);
  lines.push("", "## Unverified assumptions", "");
  if (!report.unknowns.length) lines.push("- None recorded.");
  for (const unknown of report.unknowns) lines.push(`- ⚠️ ${unknown}`);
  lines.push("", "## Learning proposals", "");
  if (!report.learning_proposals.length) lines.push("- None.");
  for (const proposal of report.learning_proposals)
    lines.push(`- **${proposal.type}**: ${proposal.description}`);
  lines.push(
    "",
    "## Verdict",
    "",
    report.verdict === "trusted"
      ? "✅ **Change satisfies approved intent.**"
      : report.verdict === "not_trusted"
        ? "❌ **Change does not satisfy approved intent.**"
        : "⚠️ **Evidence is insufficient to trust this change.**",
    "",
  );
  return lines.join("\n");
}
