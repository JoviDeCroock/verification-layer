import { z } from "zod";

export const evidenceStatusSchema = z.enum([
  "verified",
  "failed",
  "not_applicable",
  "not_verified",
]);

export type EvidenceStatus = z.infer<typeof evidenceStatusSchema>;

export const assuranceLevelSchema = z.enum(["trial", "local", "attested"]);
export type AssuranceLevel = z.infer<typeof assuranceLevelSchema>;

const stringList = z.array(z.string()).default([]);

const checkBaseSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  kind: z.enum(["static", "test", "e2e", "security", "architecture", "custom"]),
  scope: stringList,
  tags: stringList,
  required: z.boolean().default(false),
  timeout_ms: z.number().int().positive().default(120_000),
});

export const checkSchema = z.union([
  checkBaseSchema.extend({
    command: z.string().min(1),
  }),
  checkBaseSchema.extend({
    executable: z.string().min(1),
    args: stringList,
    cwd: z.string().default("."),
    env: z.record(z.string(), z.string()).default({}),
  }),
]);

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

export const qaExecutorSchema = z
  .object({
    method: z.enum(["deterministic", "model"]),
    adapter: z.string().min(1),
    version: z.string().min(1),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    prompt_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .superRefine((executor, context) => {
    if (executor.method !== "model") return;
    for (const field of ["provider", "model", "prompt_sha256"] as const)
      if (!executor[field])
        context.addIssue({
          code: "custom",
          message: `Model-driven QA executors require ${field}.`,
          path: [field],
        });
  });

export const qaSchema = z.object({
  enabled: z.boolean().default(false),
  adapter: z.string().optional(),
  executor: qaExecutorSchema.optional(),
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

const authorityKeySchema = z
  .object({
    id: z.string().min(1),
    public_key_base64: z.string().min(1),
    not_before: z.string().datetime().optional(),
    not_after: z.string().datetime().optional(),
    revoked_at: z.string().datetime().optional(),
    revocation_reason: z.string().min(1).optional(),
  })
  .superRefine((key, context) => {
    if (
      key.not_before &&
      key.not_after &&
      new Date(key.not_before).getTime() >= new Date(key.not_after).getTime()
    )
      context.addIssue({
        code: "custom",
        message: "Authority key not_before must predate not_after.",
        path: ["not_after"],
      });
    if (Boolean(key.revoked_at) !== Boolean(key.revocation_reason))
      context.addIssue({
        code: "custom",
        message: "Authority key revocation requires both revoked_at and revocation_reason.",
        path: [key.revoked_at ? "revocation_reason" : "revoked_at"],
      });
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
    capture_body: z.boolean().default(false),
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
    executor: qaExecutorSchema.optional(),
    base_url: z.string().url().optional(),
    instructions: stringList,
    screenshot: z.boolean().default(true),
  }),
  verifierBaseSchema.extend({
    kind: z.literal("agent-device"),
    adapter: z.string().min(1),
    executor: qaExecutorSchema.optional(),
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
      allow_explicit_changed_files: z.boolean().optional(),
    }),
    knowledge: z.object({
      sources: stringList,
    }),
    authority: z
      .object({
        allow_local_approvals: z.boolean().optional(),
        require_signed_reports: z.boolean().optional(),
        trusted_approvers: z.array(authorityKeySchema).optional(),
        trusted_reporters: z.array(authorityKeySchema).optional(),
      })
      .optional(),
    execution: z
      .object({
        allow_shell_commands: z.boolean().optional(),
        inherit_environment: z.boolean().optional(),
        max_attempts: z.number().int().min(1).max(5).default(1),
        retry_backoff_ms: z.number().int().min(0).max(30_000).default(250),
      })
      .optional(),
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
    for (const [field, keys] of [
      ["trusted_approvers", config.authority?.trusted_approvers ?? []],
      ["trusted_reporters", config.authority?.trusted_reporters ?? []],
    ] as const) {
      const ids = keys.map((key) => key.id);
      for (const id of new Set(ids))
        if (ids.filter((candidate) => candidate === id).length > 1)
          context.addIssue({
            code: "custom",
            message: `Authority key ID ${JSON.stringify(id)} is declared more than once in ${field}.`,
            path: ["authority", field],
          });
    }
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
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string, trail: string[]): void => {
      if (visiting.has(id)) {
        const cycle = [...trail.slice(trail.indexOf(id)), id];
        context.addIssue({
          code: "custom",
          message: `Surface dependency cycle: ${cycle.join(" -> ")}.`,
          path: ["surfaces"],
        });
        return;
      }
      if (visited.has(id)) return;
      visiting.add(id);
      const surface = config.surfaces.find((item) => item.id === id);
      for (const dependency of surface?.depends_on ?? []) visit(dependency, [...trail, id]);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of surfaceIds) visit(id, []);
  });

export const missionGenerationSchema = z
  .object({
    method: z.enum(["deterministic", "model"]),
    generator: z.string().min(1),
    version: z.string().min(1),
    input_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    prompt_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .superRefine((generation, context) => {
    if (generation.method !== "model") return;
    for (const field of ["provider", "model", "prompt_sha256"] as const)
      if (!generation[field])
        context.addIssue({
          code: "custom",
          message: `Model-generated missions require ${field}.`,
          path: [field],
        });
  });

export const missionSchema = z.object({
  id: z.string(),
  title: z.string(),
  objective: z.string(),
  derived_from: z.array(z.string()),
  risk: z.string().optional(),
  viewport: z.enum(["desktop", "mobile"]).default("desktop"),
  // Optional for verification of reports created before generation provenance shipped.
  // All missions produced by the current generator populate this field.
  generation: missionGenerationSchema.optional(),
});

export const expectedBehaviorSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Behavior IDs must use lowercase kebab-case."),
  description: z.string().min(1),
  evidence: z.array(z.string().min(1)).min(1),
});

export const changeContractSchema = z.object({
  version: z.literal(1).default(1),
  id: z.string().min(1),
  intent: z.string().min(1),
  expected_behaviors: z.array(expectedBehaviorSchema).min(1),
  affected_surfaces: stringList,
  risks: stringList,
  required_evidence: stringList,
  qa_missions: z.array(missionSchema).min(1).optional(),
  excluded: z.array(z.object({ item: z.string(), reason: z.string() })).default([]),
  approval: z
    .object({
      status: z.enum(["draft", "approved"]),
      approved_by: z.string().min(1).optional(),
      approved_at: z.string().datetime().optional(),
      content_sha256: z.string().length(64).optional(),
      method: z.enum(["local", "ed25519"]).optional(),
      key_id: z.string().min(1).optional(),
      signature: z.string().min(1).optional(),
    })
    .superRefine((approval, context) => {
      if (approval.status !== "approved") return;
      if (!approval.approved_by)
        context.addIssue({
          code: "custom",
          message: "Approved contracts require approved_by.",
          path: ["approved_by"],
        });
      if (!approval.approved_at)
        context.addIssue({
          code: "custom",
          message: "Approved contracts require approved_at.",
          path: ["approved_at"],
        });
      if (!approval.content_sha256)
        context.addIssue({
          code: "custom",
          message: "Approved contracts require content_sha256.",
          path: ["content_sha256"],
        });
      if (!approval.method)
        context.addIssue({
          code: "custom",
          message: "Approved contracts require an approval method.",
          path: ["method"],
        });
      if (approval.method === "ed25519") {
        if (!approval.key_id)
          context.addIssue({
            code: "custom",
            message: "Signed approvals require key_id.",
            path: ["key_id"],
          });
        if (!approval.signature)
          context.addIssue({
            code: "custom",
            message: "Signed approvals require signature.",
            path: ["signature"],
          });
      }
    }),
});

export const evidenceSchema = z.object({
  id: z.string(),
  category: z.enum([
    "plan",
    "claim",
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
  source_id: z.string().optional(),
  summary: z.string(),
  command: z.string().optional(),
  duration_ms: z.number().nonnegative().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  measurements: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  artifacts: z.array(z.string()).optional(),
  reason: z.string().optional(),
  // Optional so historical signed version-1 reports remain verifiable.
  executor: qaExecutorSchema.optional(),
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
  provenance: z.object({
    repository: z.object({
      head_sha: z.string().nullable(),
      branch: z.string().nullable(),
      dirty: z.boolean(),
      changed_files_source: z.enum(["git", "explicit"]),
      base_sha: z.string().nullable(),
    }),
    digests: z.object({
      contract_sha256: z.string().length(64),
      policy_sha256: z.string().length(64),
      plan_sha256: z.string().length(64),
      change_set_sha256: z.string().length(64),
    }),
    runtime: z.object({
      trust_version: z.string(),
      node: z.string(),
      platform: z.string(),
      arch: z.string(),
    }),
    target: z.object({
      preview_origin: z.string().url().optional(),
    }),
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
  // Optional so reports created before assurance labeling remain readable.
  assurance: z
    .object({
      level: assuranceLevelSchema,
    })
    .optional(),
  verdict: z.enum(["trusted", "not_trusted", "insufficient_evidence"]),
  attestation: z
    .object({
      algorithm: z.literal("ed25519"),
      signer_id: z.string().min(1),
      signed_at: z.string().datetime(),
      report_sha256: z.string().length(64),
      signature: z.string().min(1),
    })
    .optional(),
});

export const doctorResultSchema = z.object({
  version: z.literal(1),
  repository: z.string().min(1),
  required_level: assuranceLevelSchema,
  readiness: z.object({
    trial: z.boolean(),
    local: z.boolean(),
    attested: z.boolean(),
  }),
  ready: z.boolean(),
  counts: z.object({
    checks: z.number().int().nonnegative(),
    invariants: z.number().int().nonnegative(),
    verifiers: z.number().int().nonnegative(),
    surfaces: z.number().int().nonnegative(),
    active_approvers: z.number().int().nonnegative(),
    active_reporters: z.number().int().nonnegative(),
  }),
  verifiers: z.array(z.object({ id: z.string().min(1), kind: z.string().min(1) })),
  warnings: z.array(z.string()),
  problems: z.array(z.string()),
});

export const reportAttestationRequestSchema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal("ed25519"),
    signer_id: z.string().min(1),
    signed_at: z.string().datetime(),
    report_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    signing_digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const auditEntryPayloadSchema = z
  .object({
    version: z.literal(1),
    sequence: z.number().int().positive(),
    event: z.literal("report-attested"),
    recorded_at: z.string().datetime(),
    previous_entry_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    policy_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    report_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    report: trustReportSchema,
  })
  .strict();

export const auditEntrySchema = auditEntryPayloadSchema
  .extend({ entry_sha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();

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
export type ExpectedBehavior = z.infer<typeof expectedBehaviorSchema>;
export type Mission = z.infer<typeof missionSchema>;
export type QaExecutor = z.infer<typeof qaExecutorSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type ReportAttestationRequest = z.infer<typeof reportAttestationRequestSchema>;
export type AuditEntryPayload = z.infer<typeof auditEntryPayloadSchema>;
export type AuditEntry = z.infer<typeof auditEntrySchema>;
export type VerificationPlan = z.infer<typeof verificationPlanSchema>;
export type TrustReport = z.infer<typeof trustReportSchema>;
export type Incident = z.infer<typeof incidentSchema>;

export function computeVerdict(evidence: Evidence[]): TrustReport["verdict"] {
  if (evidence.some((item) => item.status === "failed")) return "not_trusted";
  if (evidence.some((item) => item.status === "not_verified")) return "insufficient_evidence";
  if (!evidence.some((item) => item.category === "claim" && item.status === "verified"))
    return "insufficient_evidence";
  return "trusted";
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72);
}
