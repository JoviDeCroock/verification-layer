import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  missionEvalCandidateSchema,
  missionEvalSuiteSchema,
  missionModelSelectionPolicySchema,
  renderMissionModelDecisionMarkdown,
  scoreMissionEval,
  selectMissionProposalModel,
  type MissionModelReport,
} from "../packages/evals/src/index.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function argumentsFor(name: string): string[] {
  return process.argv.flatMap((value, index) =>
    value === name && process.argv[index + 1] ? [process.argv[index + 1]!] : [],
  );
}

const policyFile = path.resolve(
  argument("--policy") ?? "evals/mission-generation/model-selection-policy.v1.json",
);
const outputDirectory = path.resolve(argument("--output") ?? ".trust/evals/mission-generation");
const suiteFile = path.resolve(argument("--suite") ?? "evals/mission-generation/suite.v1.json");
const policy = missionModelSelectionPolicySchema.parse(
  JSON.parse(await readFile(policyFile, "utf8")),
);
const reportFiles = argumentsFor("--report");
const candidateFiles = argumentsFor("--candidate");
if (reportFiles.length && candidateFiles.length)
  throw new Error("Use either --candidate or --report inputs, not both.");
if (!reportFiles.length && !candidateFiles.length)
  throw new Error("Supply at least one --candidate or --report input.");
if (process.argv.includes("--require-selection") && reportFiles.length)
  throw new Error("--require-selection requires candidate artifacts so scores can be recomputed.");
const reports = candidateFiles.length
  ? await (async () => {
      const suite = missionEvalSuiteSchema.parse(JSON.parse(await readFile(suiteFile, "utf8")));
      return Promise.all(
        candidateFiles.map(async (file) => {
          const candidate = missionEvalCandidateSchema.parse(
            JSON.parse(await readFile(path.resolve(file), "utf8")),
          );
          return scoreMissionEval(suite, candidate);
        }),
      );
    })()
  : await Promise.all(
      reportFiles.map(async (file) => JSON.parse(await readFile(path.resolve(file), "utf8"))),
    );
const decision = selectMissionProposalModel(policy, reports as MissionModelReport[]);
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  path.join(outputDirectory, "model-selection.json"),
  `${JSON.stringify(decision, null, 2)}\n`,
);
await writeFile(
  path.join(outputDirectory, "model-selection.md"),
  renderMissionModelDecisionMarkdown(decision),
);
console.log(renderMissionModelDecisionMarkdown(decision));
if (process.argv.includes("--require-selection") && decision.status !== "selected")
  process.exitCode = 1;
