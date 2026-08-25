import { describe, expect, it } from "vitest";
import { canInvite, INVITATION_TTL_MS, isExpired, normalizeEmail } from "../src/domain.js";

describe("invitation domain", () => {
  it("normalizes an invitation email", () => expect(normalizeEmail("  TeAm@Example.COM ")).toBe("team@example.com"));
  it("only authorizes administrators", () => {
    expect(canInvite("admin")).toBe(true);
    expect(canInvite("member")).toBe(false);
  });
  it("uses a seven day expiry boundary", () => {
    const now = new Date("2026-08-25T10:00:00Z");
    expect(isExpired(new Date(now.getTime() + INVITATION_TTL_MS), now)).toBe(false);
    expect(isExpired(new Date(now.getTime() - 1), now)).toBe(true);
  });
});
