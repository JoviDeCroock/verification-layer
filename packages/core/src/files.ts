import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, "utf8");
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
