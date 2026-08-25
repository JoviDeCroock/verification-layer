import { missionPromptCacheKey } from "../packages/evals/src/index.js";

interface MissionRequestOptions {
  model: string;
  reasoningEffort: string;
  prompt: string;
  promptSha256: string;
  input: unknown;
  outputSchema: unknown;
}

export const promptCacheMode = "explicit" as const;
export const promptCacheTtl = "30m" as const;
export const missionModelRequestPolicy = {
  api: "openai-responses",
  store: false,
  max_output_tokens: 4_000,
  timeout_ms: 60_000,
  max_prompt_bytes: 128 * 1024,
  max_input_bytes: 64 * 1024,
  max_missions_per_case: 20,
  attempts: 1,
} as const;

export { missionPromptCacheKey };

export function openAIMissionRequest(options: MissionRequestOptions): Record<string, unknown> {
  return {
    model: options.model,
    reasoning: { effort: options.reasoningEffort },
    max_output_tokens: missionModelRequestPolicy.max_output_tokens,
    store: missionModelRequestPolicy.store,
    prompt_cache_key: missionPromptCacheKey(options.promptSha256),
    prompt_cache_options: { mode: promptCacheMode, ttl: promptCacheTtl },
    input: [
      {
        role: "developer",
        content: [
          {
            type: "input_text",
            text: options.prompt,
            prompt_cache_breakpoint: { mode: promptCacheMode },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: JSON.stringify(options.input) }],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "qa_mission_proposal",
        strict: true,
        schema: options.outputSchema,
      },
    },
  };
}
