import { z } from "zod";

export const evidenceStatusSchema = z.enum([
  "verified",
  "failed",
  "not_applicable",
  "not_verified",
]);

export type EvidenceStatus = z.infer<typeof evidenceStatusSchema>;

const stringList = z.array(z.string()).default([]);

export const checkSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  kind: z.enum(["static", "test", "e2e", "security", "architecture", "custom"]),
  command: z.string().min(1),
  scope: stringList,
  tags: stringList,
  required: z.boolean().default(false),
  timeout_ms: z.number().int().positive().default(120_000),
});

export const invariantSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  scope: z.array(z.string()).min(1),
  command: z.string().min(1),
  unit: z.string().default("units"),
  baseline: z.number().optional(),
  threshold: z
    .object({
      max: z.number().optional(),
      regression: z.number().optional(),
    })
    .refine((value) => value.max !== undefined || value.regression !== undefined, {
      message: "invariant threshold needs max or regression",
    }),
  timeout_ms: z.number().int().positive().default(120_000),
});

export const surfaceSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  paths: z.array(z.string()).min(1),
  requires: stringList,
  risks: stringList,
  depends_on: stringList,
});

export const qaSchema = z.object({
  enabled: z.boolean().default(false),
  adapter: z.string().optional(),
  preview_url: z.string().url().optional(),
  instructions: stringList,
  screenshot: z.boolean().default(true),
  timeout_ms: z.number().int().positive().default(30_000),
});

const verifierBaseSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  scope: stringList,
  tags: stringList,
  required: z.boolean().default(false),
  timeout_ms: z.number().int().positive().default(120_000),
});

const processExpectationSchema = z.object({
  exit_code: z.number().int().default(0),
  stdout_contains: stringList,
  stderr_contains: stringList,
});

export const verifierSchema = z.discriminatedUnion("kind", [
  verifierBaseSchema.extend({
    kind: z.literal("playwright"),
    executable: z.string().min(1),
    args: stringList,
    cwd: z.string().default("."),
    env: z.record(z.string(), z.string()).default({}),
    expect: processExpectationSchema.default({
      exit_code: 0,
      stdout_contains: [],
      stderr_contains: [],
    }),
  }),
  verifierBaseSchema.extend({
    kind: z.literal("cli"),
    missions: z
      .array(
        z.object({
          id: z.string().min(1),
          executable: z.string().min(1),
          args: stringList,
          cwd: z.string().default("."),
          stdin: z.string().optional(),
          env: z.record(z.string(), z.string()).default({}),
          expect: processExpectationSchema.default({
            exit_code: 0,
            stdout_contains: [],
            stderr_contains: [],
          }),
        }),
      )
      .min(1),
  }),
  verifierBaseSchema.extend({
    kind: z.literal("requests"),
    base_url: z.string().url().optional(),
    requests: z
      .array(
        z.object({
          id: z.string().min(1),
          method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
          path: z.string().startsWith("/"),
          headers: z.record(z.string(), z.string()).default({}),
          body: z.unknown().optional(),
          expect: z.object({
            status: z.number().int().min(100).max(599),
            body_includes: z.string().optional(),
            json_path: z.string().optional(),
            equals: z.unknown().optional(),
          }),
        }),
      )
      .min(1),
  }),
  verifierBaseSchema.extend({
    kind: z.literal("agent-browser"),
    adapter: z.string().min(1),
    base_url: z.string().url().optional(),
    instructions: stringList,
    screenshot: z.boolean().default(true),
  }),
  verifierBaseSchema.extend({
    kind: z.literal("agent-device"),
    adapter: z.string().min(1),
    base_url: z.string().url().optional(),
    instructions: stringList,
    screenshot: z.boolean().default(true),
    devices: z
      .array(
        z.object({
          name: z.string().min(1),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          user_agent: z.string().optional(),
          has_touch: z.boolean().default(true),
        }),
      )
      .min(1),
  }),
]);

export const trustConfigSchema = z
  .object({
    version: z.literal(1),
    repository: z.object({
      name: z.string().min(1),
      root: z.string().default("."),
    }),
    knowledge: z.object({
      sources: stringList,
    }),
    checks: z.array(checkSchema).default([]),
    invariants: z.array(invariantSchema).default([]),
    surfaces: z.array(surfaceSchema).default([]),
    verifiers: z.array(verifierSchema).default([]),
    qa: qaSchema.default({
      enabled: false,
      instructions: [],
      screenshot: true,
      timeout_ms: 30_000,
    }),
  })
  .superRefine((config, context) => {
    const evidenceIds = [
      ...config.checks.map((item) => item.id),
      ...config.invariants.map((item) => item.id),
      ...config.verifiers.map((item) => item.id),
    ];
    for (const id of new Set(evidenceIds)) {
      if (evidenceIds.filter((candidate) => candidate === id).length > 1)
        context.addIssue({
          code: "custom",
          message: `Evidence ID ${JSON.stringify(id)} is declared more than once.`,
          path: ["checks"],
        });
    }
    const surfaceIds = config.surfaces.map((surface) => surface.id);
    for (const id of new Set(surfaceIds)) {
      if (surfaceIds.filter((candidate) => candidate === id).length > 1)
        context.addIssue({
          code: "custom",
          message: `Surface ID ${JSON.stringify(id)} is declared more than once.`,
          path: ["surfaces"],
        });
    }
    const known = new Set([...evidenceIds, ...(config.qa.enabled ? ["qa", "preview-qa"] : [])]);
    for (const [index, surface] of config.surfaces.entries()) {
      for (const requirement of surface.requires) {
        if (!known.has(requirement))
          context.addIssue({
            code: "custom",
            message: `Surface ${JSON.stringify(surface.id)} requires unknown evidence ${JSON.stringify(requirement)}.`,
            path: ["surfaces", index, "requires"],
          });
      }
      for (const dependency of surface.depends_on) {
        if (!surfaceIds.includes(dependency))
          context.addIssue({
            code: "custom",
            message: `Surface ${JSON.stringify(surface.id)} depends on unknown surface ${JSON.stringify(dependency)}.`,
            path: ["surfaces", index, "depends_on"],
          });
      }
    }
  });

export const changeContractSchema = z.object({
  version: z.literal(1).default(1),
  id: z.string().min(1),
  intent: z.string().min(1),
  expected_behaviors: z.array(z.string()).min(1),
  affected_surfaces: stringList,
  risks: stringList,
  required_evidence: stringList,
  excluded: z.array(z.object({ item: z.string(), reason: z.string() })).default([]),
  approval: z.object({
    status: z.enum(["draft", "approved"]),
    approved_by: z.string().optional(),
    approved_at: z.string().datetime().optional(),
  }),
});

export const missionSchema = z.object({
  id: z.string(),
  title: z.string(),
  objective: z.string(),
  derived_from: z.array(z.string()),
  risk: z.string().optional(),
  viewport: z.enum(["desktop", "mobile"]).default("desktop"),
});

export const evidenceSchema = z.object({
  id: z.string(),
  category: z.enum([
    "plan",
    "static",
    "test",
    "e2e",
    "qa",
    "invariant",
    "architecture",
    "security",
    "request",
    "cli",
    "device",
  ]),
  status: evidenceStatusSchema,
  summary: z.string(),
  command: z.string().optional(),
  duration_ms: z.number().nonnegative().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  measurements: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  artifacts: z.array(z.string()).optional(),
  reason: z.string().optional(),
});

export const verificationPlanSchema = z.object({
  version: z.literal(1),
  contract_id: z.string(),
  created_at: z.string().datetime(),
  changed_files: z.array(z.string()),
  affected_surfaces: z.array(z.string()),
  selected_checks: z.array(z.string()),
  selected_invariants: z.array(z.string()),
  selected_verifiers: z.array(z.string()).default([]),
  qa_required: z.boolean(),
  selection_reasons: z.record(z.string(), z.array(z.string())),
});

export const trustReportSchema = z.object({
  version: z.literal(1),
  run_id: z.string(),
  created_at: z.string().datetime(),
  contract: changeContractSchema,
  plan: verificationPlanSchema,
  implementation: z.object({
    changed_files: z.number().nonnegative(),
    additions: z.number().nonnegative().optional(),
    deletions: z.number().nonnegative().optional(),
  }),
  evidence: z.array(evidenceSchema),
  qa_missions: z.array(missionSchema),
  unknowns: z.array(z.string()),
  learning_proposals: z.array(
    z.object({
      type: z.enum([
        "knowledge",
        "qa-heuristic",
        "lint",
        "regression-test",
        "architectural-invariant",
      ]),
      description: z.string(),
      source_evidence: z.string(),
    }),
  ),
  verdict: z.enum(["trusted", "not_trusted", "insufficient_evidence"]),
});

export const incidentSchema = z.object({
  version: z.literal(1).default(1),
  title: z.string(),
  related_change: z.string().optional(),
  cause: z.string(),
  missed_by: z.array(z.string()),
  affected_surfaces: z.array(z.string()).default([]),
});

export type TrustConfig = z.infer<typeof trustConfigSchema>;
export type Verifier = z.infer<typeof verifierSchema>;
export type ChangeContract = z.infer<typeof changeContractSchema>;
export type Mission = z.infer<typeof missionSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type VerificationPlan = z.infer<typeof verificationPlanSchema>;
export type TrustReport = z.infer<typeof trustReportSchema>;
export type Incident = z.infer<typeof incidentSchema>;

export function computeVerdict(evidence: Evidence[]): TrustReport["verdict"] {
  if (evidence.some((item) => item.status === "failed")) return "not_trusted";
  if (evidence.some((item) => item.status === "not_verified")) return "insufficient_evidence";
  return "trusted";
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72);
}
