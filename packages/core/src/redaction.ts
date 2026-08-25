import type { Evidence, TrustConfig } from "./index.js";

const sensitiveName =
  /(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|credential|cookie|authorization)/i;
const tokenPatterns = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /-----BEGIN (?:ED25519 |RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:ED25519 |RSA |EC )?PRIVATE KEY-----/g,
];

function configuredSecrets(config: TrustConfig): Array<{ label: string; value: string }> {
  const values: Array<{ label: string; value: string }> = [];
  const add = (entries: Record<string, string>) => {
    for (const [name, value] of Object.entries(entries))
      if (sensitiveName.test(name) && value.length >= 4) values.push({ label: name, value });
  };
  for (const [name, value] of Object.entries(process.env))
    if (value && sensitiveName.test(name) && value.length >= 4) values.push({ label: name, value });
  for (const verifier of config.verifiers) {
    if (verifier.kind === "playwright") add(verifier.env);
    if (verifier.kind === "cli") for (const mission of verifier.missions) add(mission.env);
    if (verifier.kind === "requests") for (const request of verifier.requests) add(request.headers);
  }
  return [...new Map(values.map((item) => [item.value, item])).values()].sort(
    (left, right) => right.value.length - left.value.length,
  );
}

export function redactText(
  value: string,
  secrets: Array<{ label: string; value: string }> = [],
): string {
  let redacted = value;
  for (const secret of secrets)
    redacted = redacted.split(secret.value).join(`[REDACTED:${secret.label}]`);
  for (const pattern of tokenPatterns) redacted = redacted.replace(pattern, "[REDACTED:TOKEN]");
  return redacted;
}

export function redactEvidence(evidence: Evidence[], config: TrustConfig): Evidence[] {
  const secrets = configuredSecrets(config);
  return evidence.map((item) => ({
    ...item,
    summary: redactText(item.summary, secrets),
    ...(item.command ? { command: redactText(item.command, secrets) } : {}),
    ...(item.stdout ? { stdout: redactText(item.stdout, secrets) } : {}),
    ...(item.stderr ? { stderr: redactText(item.stderr, secrets) } : {}),
    ...(item.reason ? { reason: redactText(item.reason, secrets) } : {}),
    ...(item.measurements
      ? {
          measurements: Object.fromEntries(
            Object.entries(item.measurements).map(([name, value]) => [
              name,
              typeof value === "string" ? redactText(value, secrets) : value,
            ]),
          ),
        }
      : {}),
  }));
}
