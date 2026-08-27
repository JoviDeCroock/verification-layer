import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import {
  changeContractSchema,
  trustConfigSchema,
  trustReportSchema,
  type ChangeContract,
  type TrustConfig,
  type TrustReport,
} from "./index.js";

export async function readYamlFile<T>(file: string): Promise<T> {
  return YAML.parse(await readFile(file, "utf8")) as T;
}

export async function loadTrustConfig(file: string): Promise<TrustConfig> {
  return trustConfigSchema.parse(await readYamlFile(file));
}

export async function loadChangeContract(file: string): Promise<ChangeContract> {
  return changeContractSchema.parse(await readYamlFile(file));
}

export async function loadTrustReport(file: string): Promise<TrustReport> {
  return trustReportSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

export async function writeTextFile(file: string, contents: string): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await writeTextFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeYamlFile(file: string, value: unknown): Promise<void> {
  await writeTextFile(file, YAML.stringify(value, { lineWidth: 100 }));
}

export function resolveFrom(base: string, candidate: string): string {
  return path.isAbsolute(candidate) ? candidate : path.resolve(base, candidate);
}
