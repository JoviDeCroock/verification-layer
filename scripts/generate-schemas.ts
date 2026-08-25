import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  auditEntrySchema,
  changeContractSchema,
  doctorResultSchema,
  incidentSchema,
  reportAttestationRequestSchema,
  startResultSchema,
  statusResultSchema,
  trustConfigSchema,
  trustReportSchema,
  verificationPlanSchema,
} from "../packages/core/src/index.js";

const definitions = [
  {
    file: "audit-entry.schema.json",
    id: "urn:executable-trust:v1:audit-entry",
    title: "Executable Trust audit journal entry",
    schema: auditEntrySchema,
  },
  {
    file: "trust.schema.json",
    id: "urn:executable-trust:v1:policy",
    title: "Executable Trust repository policy",
    schema: trustConfigSchema,
  },
  {
    file: "attestation-request.schema.json",
    id: "urn:executable-trust:v1:attestation-request",
    title: "Executable Trust external attestation request",
    schema: reportAttestationRequestSchema,
  },
  {
    file: "change-contract.schema.json",
    id: "urn:executable-trust:v1:change-contract",
    title: "Executable Trust change contract",
    schema: changeContractSchema,
  },
  {
    file: "verification-plan.schema.json",
    id: "urn:executable-trust:v1:verification-plan",
    title: "Executable Trust verification plan",
    schema: verificationPlanSchema,
  },
  {
    file: "report.schema.json",
    id: "urn:executable-trust:v1:report",
    title: "Executable Trust report",
    schema: trustReportSchema,
  },
  {
    file: "doctor.schema.json",
    id: "urn:executable-trust:v1:doctor",
    title: "Executable Trust doctor result",
    schema: doctorResultSchema,
  },
  {
    file: "status.schema.json",
    id: "urn:executable-trust:v1:status",
    title: "Executable Trust repository status",
    schema: statusResultSchema,
  },
  {
    file: "start.schema.json",
    id: "urn:executable-trust:v1:start",
    title: "Executable Trust guided start result",
    schema: startResultSchema,
  },
  {
    file: "incident.schema.json",
    id: "urn:executable-trust:v1:incident",
    title: "Executable Trust incident",
    schema: incidentSchema,
  },
] as const;

const outputDirectory = path.resolve("schemas");
const check = process.argv.includes("--check");
let drift = false;
for (const definition of definitions) {
  const generated = z.toJSONSchema(definition.schema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "any",
  });
  const contents = `${JSON.stringify(
    { ...generated, $id: definition.id, title: definition.title },
    null,
    2,
  )}\n`;
  const file = path.join(outputDirectory, definition.file);
  if (check) {
    const existing = await readFile(file, "utf8").catch(() => "");
    if (existing !== contents) {
      console.error(`Schema is stale: ${path.relative(process.cwd(), file)}`);
      drift = true;
    }
  } else {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(file, contents, "utf8");
    console.log(`Wrote ${path.relative(process.cwd(), file)}`);
  }
}
if (drift) process.exitCode = 1;
