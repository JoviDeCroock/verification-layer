import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  missionEvalCandidateSchema,
  missionEvalSuiteSchema,
  missionGenerationInput,
} from "../packages/evals/src/index.js";
import { missionSchema } from "../packages/core/src/index.js";
import { sha256 } from "../packages/core/src/provenance.js";
import {
  missionPromptCacheKey,
  missionModelRequestPolicy,
  openAIMissionRequest,
  promptCacheMode,
  promptCacheTtl,
} from "./openai-mission-request.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey)
  throw new Error("OPENAI_API_KEY is required. The benchmark never writes the key to an artifact.");
const model = argument("--model");
if (!model) throw new Error("Use --model with an exact model identifier.");
const effort = argument("--reasoning-effort") ?? "medium";
const repetitions = Number(argument("--repetitions") ?? "3");
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 10)
  throw new Error("--repetitions must be an integer between 1 and 10.");
const suiteFile = path.resolve(argument("--suite") ?? "evals/mission-generation/suite.v1.json");
const promptFile = path.resolve(argument("--prompt") ?? "evals/mission-generation/prompt-v2.md");
const suite = missionEvalSuiteSchema.parse(JSON.parse(await readFile(suiteFile, "utf8")));
const prompt = await readFile(promptFile, "utf8");
if (Buffer.byteLength(prompt) > missionModelRequestPolicy.max_prompt_bytes)
  throw new Error("Mission prompt exceeds the 128 KiB evaluation safety limit.");
const promptSha256 = sha256(prompt);
const outputFile = path.resolve(
  argument("--output") ??
    `.trust/evals/mission-generation/${model.replaceAll(/[^a-zA-Z0-9._-]/g, "-")}.candidate.json`,
);

const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["missions"],
  properties: {
    missions: {
      type: "array",
      minItems: 1,
      maxItems: missionModelRequestPolicy.max_missions_per_case,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "objective", "derived_from", "risk", "viewport"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 200 },
          title: { type: "string", minLength: 1, maxLength: 200 },
          objective: { type: "string", minLength: 1, maxLength: 1_000 },
          derived_from: {
            type: "array",
            minItems: 1,
            maxItems: 10,
            items: { type: "string", maxLength: 500 },
          },
          risk: { type: ["string", "null"], maxLength: 500 },
          viewport: { type: "string", enum: ["desktop", "mobile"] },
        },
      },
    },
  },
} as const;

interface ResponsePayload {
  id?: string;
  status?: string;
  incomplete_details?: { reason?: string };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
    };
  };
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string; refusal?: string }>;
  }>;
  error?: { message?: string };
}

function responseText(response: ResponsePayload): string | undefined {
  return response.output
    ?.flatMap((item) => item.content ?? [])
    .find((item) => item.type === "output_text")?.text;
}

const runs: unknown[] = [];
for (const suiteCase of suite.cases) {
  const input = missionGenerationInput(suiteCase.contract);
  if (
    suiteCase.contract.expected_behaviors.length + suiteCase.contract.risks.length >
    missionModelRequestPolicy.max_missions_per_case
  )
    throw new Error(
      `Evaluation case ${JSON.stringify(suiteCase.id)} exceeds 20 proposed missions.`,
    );
  if (Buffer.byteLength(JSON.stringify(input)) > missionModelRequestPolicy.max_input_bytes)
    throw new Error(
      `Evaluation case ${JSON.stringify(suiteCase.id)} exceeds 64 KiB of model input.`,
    );
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    const started = performance.now();
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(missionModelRequestPolicy.timeout_ms),
        body: JSON.stringify(
          openAIMissionRequest({
            model,
            reasoningEffort: effort,
            prompt,
            promptSha256,
            input,
            outputSchema,
          }),
        ),
      });
      const payload = (await response.json()) as ResponsePayload;
      const common = {
        case_id: suiteCase.id,
        repetition,
        latency_ms: Math.round(performance.now() - started),
        ...(payload.id ? { response_id: payload.id } : {}),
        ...(payload.usage?.input_tokens === undefined
          ? {}
          : { input_tokens: payload.usage.input_tokens }),
        ...(payload.usage?.output_tokens === undefined
          ? {}
          : { output_tokens: payload.usage.output_tokens }),
        ...(payload.usage?.input_tokens_details?.cached_tokens === undefined
          ? {}
          : { cached_input_tokens: payload.usage.input_tokens_details.cached_tokens }),
        ...(payload.usage?.input_tokens_details?.cache_write_tokens === undefined
          ? {}
          : { cache_write_input_tokens: payload.usage.input_tokens_details.cache_write_tokens }),
      };
      if (!response.ok) {
        runs.push({
          ...common,
          status: "error",
          reason: payload.error?.message ?? `OpenAI returned HTTP ${response.status}.`,
        });
        continue;
      }
      const refusal = payload.output
        ?.flatMap((item) => item.content ?? [])
        .find((item) => item.type === "refusal")?.refusal;
      if (refusal) {
        runs.push({ ...common, status: "refused", reason: refusal });
        continue;
      }
      const text = responseText(payload);
      if (!text || payload.status === "incomplete") {
        runs.push({
          ...common,
          status: "error",
          reason:
            payload.incomplete_details?.reason ?? "Response contained no complete output text.",
        });
        continue;
      }
      try {
        const parsed = JSON.parse(text) as { missions?: unknown[] };
        const missions = (parsed.missions ?? []).map((mission) => {
          const value = mission as Record<string, unknown>;
          const withProvenance = {
            ...value,
            ...(value.risk === null ? { risk: undefined } : {}),
            generation: {
              method: "model",
              generator: "executable-trust-layer/mission-proposer",
              version: "3",
              input_sha256: sha256(input),
              provider: "openai",
              model,
              prompt_sha256: promptSha256,
            },
          };
          return missionSchema.parse(withProvenance);
        });
        runs.push({ ...common, status: "valid", missions });
      } catch (error) {
        runs.push({
          ...common,
          status: "invalid",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (error) {
      runs.push({
        case_id: suiteCase.id,
        repetition,
        latency_ms: Math.round(performance.now() - started),
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

const candidate = missionEvalCandidateSchema.parse({
  version: 1,
  id: `${model}-${effort}`,
  kind: "model",
  generator: "executable-trust-layer/mission-proposer",
  generator_version: "3",
  provider: "openai",
  model,
  reasoning_effort: effort,
  prompt_sha256: promptSha256,
  prompt_cache: {
    key: missionPromptCacheKey(promptSha256),
    mode: promptCacheMode,
    ttl: promptCacheTtl,
  },
  request_policy: missionModelRequestPolicy,
  repetitions,
  runs,
});
await mkdir(path.dirname(outputFile), { recursive: true });
await writeFile(outputFile, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 });
console.log(`Wrote ${outputFile}`);
