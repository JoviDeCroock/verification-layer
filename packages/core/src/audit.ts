import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import {
  auditEntrySchema,
  type AuditEntry,
  type AuditEntryPayload,
  type TrustConfig,
  type TrustReport,
} from "./index.js";
import { reportDigest } from "./attestations.js";
import { sha256 } from "./provenance.js";

export interface AuditJournalValidation {
  entries: AuditEntry[];
  problems: string[];
  headSha256: string | null;
}

export function auditEntryDigest(payload: AuditEntryPayload): string {
  return sha256(payload);
}

export function createAuditEntry(
  policy: TrustConfig,
  report: TrustReport,
  previous: AuditEntry | undefined,
  recordedAt = new Date().toISOString(),
): AuditEntry {
  const payload = auditEntrySchema.omit({ entry_sha256: true }).parse({
    version: 1,
    sequence: (previous?.sequence ?? 0) + 1,
    event: "report-attested",
    recorded_at: recordedAt,
    previous_entry_sha256: previous?.entry_sha256 ?? null,
    policy_sha256: sha256(policy),
    report_sha256: reportDigest(report),
    report,
  });
  return auditEntrySchema.parse({ ...payload, entry_sha256: auditEntryDigest(payload) });
}

export function parseAuditJournal(contents: string): AuditJournalValidation {
  const problems: string[] = [];
  const entries: AuditEntry[] = [];
  if (contents && !contents.endsWith("\n"))
    problems.push("The audit journal ends with a partial record.");
  const lines = contents.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.some((line) => line.trim() === ""))
    problems.push("The audit journal contains an empty or partial record.");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      entries.push(auditEntrySchema.parse(JSON.parse(line)));
    } catch (error) {
      problems.push(
        `Audit record ${index + 1} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  for (const [index, entry] of entries.entries()) {
    const expectedSequence = index + 1;
    if (entry.sequence !== expectedSequence)
      problems.push(
        `Audit record ${index + 1} declares sequence ${entry.sequence}, expected ${expectedSequence}.`,
      );
    const previous = entries[index - 1];
    const expectedPrevious = previous?.entry_sha256 ?? null;
    if (entry.previous_entry_sha256 !== expectedPrevious)
      problems.push(`Audit record ${index + 1} does not link to the preceding record.`);
    const { entry_sha256: _entrySha256, ...payload } = entry;
    if (entry.entry_sha256 !== auditEntryDigest(payload))
      problems.push(`Audit record ${index + 1} has an invalid content digest.`);
    if (entry.report_sha256 !== reportDigest(entry.report))
      problems.push(`Audit record ${index + 1} has an invalid report digest.`);
  }
  return {
    entries,
    problems,
    headSha256: entries.at(-1)?.entry_sha256 ?? null,
  };
}

async function assertRegularOrMissing(file: string): Promise<void> {
  try {
    const details = await lstat(file);
    if (!details.isFile()) throw new Error(`Audit journal ${file} is not a regular file.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function appendAuditJournal(
  file: string,
  policy: TrustConfig,
  report: TrustReport,
  expectation: { headSha256?: string; count?: number } = {},
): Promise<AuditEntry> {
  const resolved = path.resolve(file);
  const directory = path.dirname(resolved);
  const lockFile = `${resolved}.lock`;
  await mkdir(directory, { recursive: true });
  let lock;
  try {
    lock = await open(lockFile, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`Audit journal is locked by another writer: ${lockFile}`);
    throw error;
  }
  try {
    await assertRegularOrMissing(resolved);
    const contents = await readFile(resolved, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const validation = parseAuditJournal(contents);
    if (validation.problems.length)
      throw new Error(
        `Refusing to append to an invalid audit journal:\n${validation.problems.join("\n")}`,
      );
    if (expectation.headSha256 !== undefined && validation.headSha256 !== expectation.headSha256)
      throw new Error("The audit journal head does not match the expected external checkpoint.");
    if (expectation.count !== undefined && validation.entries.length !== expectation.count)
      throw new Error(
        `The audit journal has ${validation.entries.length} record(s), expected ${expectation.count}.`,
      );
    if (validation.entries.some((entry) => entry.report_sha256 === reportDigest(report)))
      throw new Error("This attested report is already present in the audit journal.");
    const entry = createAuditEntry(policy, report, validation.entries.at(-1));
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    const handle = await open(
      resolved,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return entry;
  } finally {
    await lock.close();
    await unlink(lockFile).catch(() => undefined);
  }
}
