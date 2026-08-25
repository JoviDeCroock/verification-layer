import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  deterministicMissionCandidate,
  missionEvalCandidateSchema,
  missionEvalSuiteSchema,
  renderMissionEvalMarkdown,
  scoreMissionEval,
} from "../packages/evals/src/index.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const suiteFile = path.resolve(argument("--suite") ?? "evals/mission-generation/suite.v1.json");
const candidateFile = argument("--candidate");
const outputDirectory = path.resolve(argument("--output") ?? ".trust/evals/mission-generation");
const suite = missionEvalSuiteSchema.parse(JSON.parse(await readFile(suiteFile, "utf8")));
const candidate = candidateFile
  ? missionEvalCandidateSchema.parse(
      JSON.parse(await readFile(path.resolve(candidateFile), "utf8")),
    )
  : deterministicMissionCandidate(suite);
const report = scoreMissionEval(suite, candidate);
await mkdir(outputDirectory, { recursive: true });
const base = path.join(outputDirectory, candidate.id);
await writeFile(`${base}.candidate.json`, `${JSON.stringify(candidate, null, 2)}\n`);
await writeFile(`${base}.report.json`, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(`${base}.report.md`, renderMissionEvalMarkdown(report));
console.log(renderMissionEvalMarkdown(report));
if (report.summary.hard_pass_rate !== 1) process.exitCode = 1;
