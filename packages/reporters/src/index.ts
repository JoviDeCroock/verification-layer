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

function missionGenerationSummary(report: TrustReport): string[] {
  const groups = new Map<
    string,
    { generation: TrustReport["qa_missions"][number]["generation"]; count: number }
  >();
  for (const mission of report.qa_missions) {
    const generation = mission.generation;
    const key = generation
      ? JSON.stringify({
          method: generation.method,
          generator: generation.generator,
          version: generation.version,
          provider: generation.provider,
          model: generation.model,
          prompt_sha256: generation.prompt_sha256,
        })
      : "legacy";
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { generation, count: 1 });
  }
  if (!groups.size) return ["No QA missions were generated."];
  return [...groups.values()].map(({ generation, count }) =>
    generation === undefined
      ? `Legacy mission provenance was not recorded for ${count} mission(s).`
      : generation.method === "model"
        ? `Model: ${generation.provider}/${generation.model}; generator ${generation.generator}@${generation.version}; prompt ${generation.prompt_sha256}; ${count} mission(s)`
        : `Deterministic: ${generation.generator}@${generation.version}; no LLM used; ${count} mission(s)`,
  );
}

function qaExecutorSummary(report: TrustReport): string[] {
  const executors = [
    ...new Map(
      report.evidence
        .filter((item) => item.category === "qa" || item.category === "device")
        .map((item) => {
          const executor = item.executor ?? null;
          return [JSON.stringify(executor), executor] as const;
        }),
    ).values(),
  ];
  if (!executors.length) return ["No QA executor ran."];
  return executors.map((executor) =>
    executor === null
      ? "Legacy evidence: QA executor provenance was not recorded."
      : executor.method === "model"
        ? `Model: ${executor.provider}/${executor.model}; adapter ${executor.adapter}@${executor.version}; prompt ${executor.prompt_sha256}`
        : `Deterministic: ${executor.adapter}@${executor.version}; no LLM used`,
  );
}

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
  lines.push(
    `Commit: ${report.provenance.repository.head_sha?.slice(0, 12) ?? "unavailable"}`,
    `Branch: ${report.provenance.repository.branch ?? "detached or unavailable"}`,
    `Working tree: ${report.provenance.repository.dirty ? pc.yellow("dirty") : pc.green("clean")}`,
    `Change set: ${report.provenance.repository.changed_files_source}`,
    `Snapshot: ${report.provenance.digests.change_set_sha256.slice(0, 12)}`,
    `Attestation: ${report.attestation ? `${report.attestation.signer_id} (${report.attestation.algorithm})` : "none"}`,
  );
  lines.push("", pc.bold("Behavior claims"));
  const claims = report.evidence.filter((item) => item.category === "claim");
  for (const claim of claims) lines.push(`${terminalIcon(claim.status)} ${claim.summary}`);
  lines.push("", pc.bold("Verification"));
  for (const evidence of report.evidence.filter((item) => item.category !== "claim"))
    lines.push(`${terminalIcon(evidence.status)} ${evidence.summary}`);
  lines.push("", pc.bold("QA mission generation"));
  for (const summary of missionGenerationSummary(report)) lines.push(summary);
  lines.push("", pc.bold("QA execution"));
  for (const summary of qaExecutorSummary(report)) lines.push(summary);
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
    `- Commit: \`${report.provenance.repository.head_sha ?? "unavailable"}\``,
    `- Branch: \`${report.provenance.repository.branch ?? "detached or unavailable"}\``,
    `- Working tree: ${report.provenance.repository.dirty ? "dirty" : "clean"}`,
    `- Change-set source: ${report.provenance.repository.changed_files_source}`,
    `- Contract digest: \`${report.provenance.digests.contract_sha256}\``,
    `- Policy digest: \`${report.provenance.digests.policy_sha256}\``,
    `- Plan digest: \`${report.provenance.digests.plan_sha256}\``,
    `- Change-set digest: \`${report.provenance.digests.change_set_sha256}\``,
    `- Attestation: ${report.attestation ? `signed by **${report.attestation.signer_id}** at ${report.attestation.signed_at}` : "none"}`,
    ...(report.provenance.target.preview_origin
      ? [`- Preview origin: ${report.provenance.target.preview_origin}`]
      : []),
    "",
    "## Behavior claims",
    "",
  ];
  for (const claim of report.evidence.filter((item) => item.category === "claim"))
    lines.push(
      `- ${statusIcon(claim.status)} **${claim.id.replace(/^claim:/, "")}** — ${claim.summary}`,
    );
  lines.push("", "## Verification", "");
  for (const evidence of report.evidence.filter((item) => item.category !== "claim"))
    lines.push(`- ${statusIcon(evidence.status)} **${evidence.id}** — ${evidence.summary}`);
  lines.push("", "## QA mission generation", "");
  for (const summary of missionGenerationSummary(report)) lines.push(`- ${summary}`);
  for (const mission of report.qa_missions)
    lines.push(
      `- **${mission.id}** — ${mission.title}; derived from ${mission.derived_from.map((source) => `\`${source}\``).join(", ")}${mission.generation ? `; input \`${mission.generation.input_sha256.slice(0, 12)}\`` : ""}`,
    );
  lines.push("", "## QA execution", "");
  for (const summary of qaExecutorSummary(report)) lines.push(`- ${summary}`);
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
