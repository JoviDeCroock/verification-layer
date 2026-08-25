import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyMissionEvalReview,
  createMissionEvalReview,
  missionEvalCandidateSchema,
  missionEvalReviewSchema,
  missionEvalSuiteSchema,
  renderMissionEvalReviewMarkdown,
} from "../packages/evals/src/index.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const candidateArgument = argument("--candidate");
if (!candidateArgument) throw new Error("Use --candidate with a model candidate artifact.");
const candidateFile = path.resolve(candidateArgument);
const suiteFile = path.resolve(argument("--suite") ?? "evals/mission-generation/suite.v1.json");
const suite = missionEvalSuiteSchema.parse(JSON.parse(await readFile(suiteFile, "utf8")));
const candidate = missionEvalCandidateSchema.parse(
  JSON.parse(await readFile(candidateFile, "utf8")),
);
const applyFile = argument("--apply");

if (applyFile) {
  const review = missionEvalReviewSchema.parse(
    JSON.parse(await readFile(path.resolve(applyFile), "utf8")),
  );
  const reviewed = applyMissionEvalReview(suite, candidate, review);
  const outputFile = path.resolve(
    argument("--output") ?? candidateFile.replace(/\.candidate\.json$/, ".reviewed.candidate.json"),
  );
  if (outputFile === candidateFile)
    throw new Error("Review application must not overwrite the unreviewed candidate artifact.");
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, `${JSON.stringify(reviewed, null, 2)}\n`, { mode: 0o600 });
  console.log(`Wrote reviewed candidate ${outputFile}`);
} else {
  const review = createMissionEvalReview(suite, candidate);
  const outputBase = path.resolve(
    argument("--output") ?? path.join(path.dirname(candidateFile), `review-${review.review_id}`),
  );
  await mkdir(path.dirname(outputBase), { recursive: true });
  await writeFile(`${outputBase}.json`, `${JSON.stringify(review, null, 2)}\n`, { mode: 0o600 });
  await writeFile(`${outputBase}.md`, renderMissionEvalReviewMarkdown(review), { mode: 0o600 });
  console.log(`Wrote review template ${outputBase}.json`);
  console.log(`Wrote review rendering ${outputBase}.md`);
}
