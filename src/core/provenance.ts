import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { ChangeContract, TrustConfig, TrustReport, VerificationPlan } from "./index.js";
import { runProcess } from "../runner/index.js";
import { TRUST_VERSION } from "./version.js";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  return value;
}

export function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function approvalDigest(contract: unknown): string {
  const { approval: _approval, ...approvedContent } = contract as Record<string, unknown>;
  return sha256(approvedContent);
}

async function git(repositoryRoot: string, args: string[]): Promise<string | null> {
  const result = await runProcess({
    executable: "git",
    args: [
      "-c",
      "core.fsmonitor=false",
      "-c",
      `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
      ...args,
    ],
    cwd: repositoryRoot,
    timeoutMs: 5_000,
    inheritEnv: false,
  });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

function lines(value: string | null): string[] {
  return (
    value
      ?.split("\n")
      .map((item) => item.trim())
      .filter(Boolean) ?? []
  );
}

export async function resolveGitChangeSet(
  repositoryRoot: string,
  baseRef?: string,
): Promise<{ changedFiles: string[]; baseSha?: string }> {
  const baseSha = baseRef ? await git(repositoryRoot, ["merge-base", baseRef, "HEAD"]) : null;
  if (baseRef && !baseSha)
    throw new Error(`Could not resolve Git base ${JSON.stringify(baseRef)}.`);
  const results = await Promise.all([
    baseSha
      ? git(repositoryRoot, ["diff", "--name-only", "--relative", `${baseSha}...HEAD`])
      : Promise.resolve(null),
    git(repositoryRoot, ["diff", "--name-only", "--relative"]),
    git(repositoryRoot, ["diff", "--name-only", "--relative", "--cached"]),
    git(repositoryRoot, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  const changedFiles = [...new Set(results.flatMap(lines))].sort();
  return { changedFiles, ...(baseSha ? { baseSha } : {}) };
}

export async function gitTracksPath(repositoryRoot: string, file: string): Promise<boolean> {
  const relative = path.relative(repositoryRoot, path.resolve(file));
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    return false;
  return (await git(repositoryRoot, ["ls-files", "--error-unmatch", "--", relative])) !== null;
}

export interface ProvenanceInput {
  config: TrustConfig;
  contract: ChangeContract;
  plan: VerificationPlan;
  repositoryRoot: string;
  changedFilesSource: "git" | "explicit";
  baseSha?: string;
  previewUrl?: string;
  repositoryIdentity?: Awaited<ReturnType<typeof currentGitIdentity>>;
  changeSetSha256?: string;
}

export function validateChangedFiles(repositoryRoot: string, changedFiles: string[]): void {
  const root = path.resolve(repositoryRoot);
  if (new Set(changedFiles).size !== changedFiles.length)
    throw new Error("Changed files must not contain duplicate paths.");
  for (const file of changedFiles) {
    if (
      !file ||
      file.includes("\0") ||
      path.isAbsolute(file) ||
      file.includes("\\") ||
      path.posix.normalize(file) !== file ||
      file === "." ||
      file.startsWith("../")
    )
      throw new Error(
        `Changed file is not a canonical repository-relative path: ${JSON.stringify(file)}.`,
      );
    const absolute = path.resolve(root, file);
    if (absolute === root || !absolute.startsWith(`${root}${path.sep}`))
      throw new Error(`Changed file escapes repository root: ${JSON.stringify(file)}.`);
  }
}

export async function changeSetDigest(
  repositoryRoot: string,
  changedFiles: string[],
): Promise<string> {
  validateChangedFiles(repositoryRoot, changedFiles);
  const root = path.resolve(repositoryRoot);
  const entries = await Promise.all(
    [...new Set(changedFiles)].sort().map(async (file) => {
      const absolute = path.resolve(root, file);
      if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`))
        throw new Error(`Changed file escapes repository root: ${JSON.stringify(file)}.`);
      try {
        const details = await lstat(absolute);
        if (details.isSymbolicLink())
          return {
            file,
            kind: "symlink",
            target_sha256: createHash("sha256")
              .update(await readlink(absolute))
              .digest("hex"),
          };
        if (!details.isFile())
          throw new Error(
            `Changed path is not a regular file or symlink: ${JSON.stringify(file)}.`,
          );
        return {
          file,
          kind: "file",
          content_sha256: createHash("sha256")
            .update(await readFile(absolute))
            .digest("hex"),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file, deleted: true };
        throw error;
      }
    }),
  );
  return sha256(entries);
}

export async function currentGitIdentity(repositoryRoot: string): Promise<{
  headSha: string | null;
  branch: string | null;
  dirty: boolean;
}> {
  const [headSha, branch, status] = await Promise.all([
    git(repositoryRoot, ["rev-parse", "HEAD"]),
    git(repositoryRoot, ["branch", "--show-current"]),
    git(repositoryRoot, ["status", "--porcelain", "--untracked-files=normal"]),
  ]);
  return { headSha, branch: branch || null, dirty: Boolean(status) };
}

export async function collectProvenance(
  input: ProvenanceInput,
): Promise<TrustReport["provenance"]> {
  const identity = input.repositoryIdentity ?? (await currentGitIdentity(input.repositoryRoot));
  let previewOrigin: string | undefined;
  if (input.previewUrl) previewOrigin = new URL(input.previewUrl).origin;
  return {
    repository: {
      head_sha: identity.headSha,
      branch: identity.branch,
      dirty: identity.dirty,
      changed_files_source: input.changedFilesSource,
      base_sha: input.baseSha ?? null,
    },
    digests: {
      contract_sha256: sha256(input.contract),
      policy_sha256: sha256(input.config),
      plan_sha256: sha256(input.plan),
      change_set_sha256:
        input.changeSetSha256 ??
        (await changeSetDigest(input.repositoryRoot, input.plan.changed_files)),
    },
    runtime: {
      trust_version: TRUST_VERSION,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    target: previewOrigin ? { preview_origin: previewOrigin } : {},
  };
}
