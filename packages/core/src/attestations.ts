import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import type {
  ChangeContract,
  ReportAttestationRequest,
  TrustConfig,
  TrustReport,
} from "./index.js";
import { sha256 } from "./provenance.js";

export interface GeneratedAuthorityKeyPair {
  privateKeyPem: string;
  publicKeyBase64: string;
  fingerprint: string;
}

type AuthorityKey = NonNullable<NonNullable<TrustConfig["authority"]>["trusted_approvers"]>[number];

export function authorityKeyValidityProblem(
  key: AuthorityKey,
  signedAt: string,
  now = Date.now(),
): string | null {
  const signedAtMs = new Date(signedAt).getTime();
  if (!Number.isFinite(signedAtMs))
    return `Authority key ${JSON.stringify(key.id)} has no valid signing timestamp.`;
  if (key.revoked_at && new Date(key.revoked_at).getTime() <= now)
    return `Authority key ${JSON.stringify(key.id)} was revoked at ${key.revoked_at}: ${key.revocation_reason}.`;
  if (key.not_before && signedAtMs < new Date(key.not_before).getTime())
    return `Authority key ${JSON.stringify(key.id)} was not active at the signing time.`;
  if (key.not_after && signedAtMs > new Date(key.not_after).getTime())
    return `Authority key ${JSON.stringify(key.id)} had expired at the signing time.`;
  return null;
}

export function generateAuthorityKeyPair(): GeneratedAuthorityKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "der", type: "spki" },
  });
  const publicKeyBase64 = publicKey.toString("base64");
  return {
    privateKeyPem: privateKey,
    publicKeyBase64,
    fingerprint: sha256(publicKeyBase64).slice(0, 16),
  };
}

export function publicKeyFromPrivate(privateKeyPem: string): string {
  const publicKey = createPublicKey(createPrivateKey(privateKeyPem)).export({
    format: "der",
    type: "spki",
  });
  return Buffer.from(publicKey).toString("base64");
}

export function signDigest(digest: string, privateKeyPem: string): string {
  return sign(null, Buffer.from(digest, "hex"), privateKeyPem).toString("base64");
}

export function verifyDigest(digest: string, signature: string, publicKeyBase64: string): boolean {
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(publicKeyBase64, "base64"),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.from(digest, "hex"), publicKey, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export function publicKeyIsValid(publicKeyBase64: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyBase64, "base64"),
      format: "der",
      type: "spki",
    });
    return key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

export function approvalSignatureDigest(contract: ChangeContract): string {
  return sha256({
    approved_by: contract.approval.approved_by,
    approved_at: contract.approval.approved_at,
    content_sha256: contract.approval.content_sha256,
    key_id: contract.approval.key_id,
  });
}

export function reportDigest(report: TrustReport): string {
  const { attestation: _attestation, ...content } = report;
  return sha256(content);
}

export function reportSignatureDigest(input: {
  report_sha256: string;
  signer_id: string;
  signed_at: string;
}): string {
  return sha256(input);
}

export function createReportAttestationRequest(
  report: TrustReport,
  signerId: string,
  signedAt = new Date().toISOString(),
): ReportAttestationRequest {
  const reportSha256 = reportDigest(report);
  return {
    version: 1,
    algorithm: "ed25519",
    signer_id: signerId,
    signed_at: signedAt,
    report_sha256: reportSha256,
    signing_digest: reportSignatureDigest({
      report_sha256: reportSha256,
      signer_id: signerId,
      signed_at: signedAt,
    }),
  };
}

export function attestationFromRequest(
  request: ReportAttestationRequest,
  signature: string,
): NonNullable<TrustReport["attestation"]> {
  return {
    algorithm: request.algorithm,
    signer_id: request.signer_id,
    signed_at: request.signed_at,
    report_sha256: request.report_sha256,
    signature,
  };
}

export function createReportAttestation(
  report: TrustReport,
  signerId: string,
  privateKeyPem: string,
  signedAt = new Date().toISOString(),
): NonNullable<TrustReport["attestation"]> {
  const request = createReportAttestationRequest(report, signerId, signedAt);
  return attestationFromRequest(request, signDigest(request.signing_digest, privateKeyPem));
}

export function verifyContractSignature(
  contract: ChangeContract,
  config: TrustConfig,
): string | null {
  if (contract.approval.method === "local")
    return config.authority?.allow_local_approvals === true
      ? null
      : "Local approvals are not authorized by repository policy.";
  if (contract.approval.method !== "ed25519") return "The approval method is missing.";
  if (!contract.approval.key_id || !contract.approval.signature)
    return "The signed approval is incomplete.";
  if (contract.approval.approved_by !== contract.approval.key_id)
    return "The approver identity does not match the signing key ID.";
  const trusted = (config.authority?.trusted_approvers ?? []).find(
    (item) => item.id === contract.approval.key_id,
  );
  if (!trusted)
    return `Approval key ${JSON.stringify(contract.approval.key_id)} is not trusted by repository policy.`;
  const validityProblem = authorityKeyValidityProblem(trusted, contract.approval.approved_at ?? "");
  if (validityProblem) return validityProblem;
  return verifyDigest(
    approvalSignatureDigest(contract),
    contract.approval.signature,
    trusted.public_key_base64,
  )
    ? null
    : "The contract approval signature is invalid.";
}

export function verifyReportAttestation(report: TrustReport, config: TrustConfig): string | null {
  if (!report.attestation) return "The report has no attestation.";
  const signedAt = new Date(report.attestation.signed_at).getTime();
  if (signedAt > Date.now()) return "The report attestation timestamp is in the future.";
  if (signedAt < new Date(report.created_at).getTime())
    return "The report attestation predates the report.";
  const trusted = (config.authority?.trusted_reporters ?? []).find(
    (item) => item.id === report.attestation?.signer_id,
  );
  if (!trusted)
    return `Report signer ${JSON.stringify(report.attestation.signer_id)} is not trusted by repository policy.`;
  const validityProblem = authorityKeyValidityProblem(trusted, report.attestation.signed_at);
  if (validityProblem) return validityProblem;
  const digest = reportDigest(report);
  if (digest !== report.attestation.report_sha256)
    return "The report content changed after attestation.";
  const valid = verifyDigest(
    reportSignatureDigest({
      report_sha256: report.attestation.report_sha256,
      signer_id: report.attestation.signer_id,
      signed_at: report.attestation.signed_at,
    }),
    report.attestation.signature,
    trusted.public_key_base64,
  );
  return valid ? null : "The report attestation signature is invalid.";
}

export function trustedReporterMatchesPrivateKey(
  config: TrustConfig,
  signerId: string,
  privateKeyPem: string,
): boolean {
  const trusted = (config.authority?.trusted_reporters ?? []).find((item) => item.id === signerId);
  if (!trusted) return false;
  if (authorityKeyValidityProblem(trusted, new Date().toISOString())) return false;
  try {
    return trusted.public_key_base64 === publicKeyFromPrivate(privateKeyPem);
  } catch {
    return false;
  }
}
