import pc from "picocolors";
import type { DiscoveryReport } from "./index.js";

export function renderDiscovery(report: DiscoveryReport): string {
  const lines = [pc.bold(`TRUST DISCOVERY — ${report.name}`), "", pc.bold("Found:")];
  for (const item of report.found)
    lines.push(`${pc.green("✓")} ${item.label}${item.detail ? pc.dim(` — ${item.detail}`) : ""}`);
  lines.push("", pc.bold("Application structure:"));
  if (!report.entryPoints.length && !report.routes.length && !report.packages.length)
    lines.push(`${pc.yellow("!")} No application surfaces inferred.`);
  for (const item of report.packages) lines.push(`- package: ${item}`);
  for (const item of report.entryPoints.slice(0, 8)) lines.push(`- entry: ${item}`);
  for (const item of report.routes.slice(0, 8)) lines.push(`- route: ${item}`);
  lines.push("", pc.bold("Potential gaps:"));
  if (!report.potentialGaps.length) lines.push(`${pc.green("✓")} No obvious gaps detected.`);
  for (const gap of report.potentialGaps) lines.push(`${pc.yellow("!")} ${gap}`);
  return `${lines.join("\n")}\n`;
}
