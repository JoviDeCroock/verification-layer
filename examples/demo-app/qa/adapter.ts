import { expect } from "@playwright/test";
import type { QaAdapter, QaMissionContext, QaObservation } from "../../../packages/qa/src/index.js";

async function reset(context: QaMissionContext): Promise<void> {
  const response = await context.context.request.post(`${context.previewUrl}/api/testing/reset`);
  if (!response.ok())
    throw new Error(`Reset failed: ${response.status()} ${await response.text()}`);
}

async function happyPath(context: QaMissionContext): Promise<QaObservation> {
  await reset(context);
  await context.page.goto(context.previewUrl);
  await context.page.getByTestId("invite-email").fill("qa-user@example.com");
  await context.page.getByTestId("send-invite").click();
  await expect(context.page.getByTestId("message")).toContainText("Invitation sent");
  await expect(context.page.getByTestId("invitation")).toHaveCount(1);
  return {
    status: "verified",
    summary: "An administrator invited a new user through the running UI.",
  };
}

const adapter: QaAdapter = {
  supports: (mission) =>
    [
      "happy-path",
      "duplicate-submission",
      "authorization",
      "expiration",
      "regression",
      "mobile-journey",
    ].includes(mission.id),
  async execute(context) {
    if (context.mission.id === "happy-path" || context.mission.id === "mobile-journey")
      return happyPath(context);
    if (context.mission.id === "duplicate-submission") {
      await reset(context);
      await context.page.goto(context.previewUrl);
      await context.page.getByTestId("invite-email").fill("duplicate@example.com");
      const send = context.page.getByTestId("send-invite");
      await send.click();
      await expect(context.page.getByTestId("message")).toContainText("Invitation sent");
      await expect(send).toBeEnabled();
      const refresh = context.page.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          new URL(response.url()).pathname === "/api/invitations",
      );
      await send.click();
      await refresh;
      await expect(send).toBeEnabled();
      const sequentialCount = await context.page.getByTestId("invitation").count();
      await reset(context);
      await context.page.evaluate(`Promise.all([
        fetch("/api/invitations", {
          method: "POST",
          headers: { "content-type": "application/json", "x-demo-role": "admin" },
          body: JSON.stringify({ email: "race@example.com" })
        }),
        fetch("/api/invitations", {
          method: "POST",
          headers: { "content-type": "application/json", "x-demo-role": "admin" },
          body: JSON.stringify({ email: "race@example.com" })
        })
      ])`);
      await context.page.reload();
      await expect(context.page.getByTestId("send-invite")).toBeEnabled();
      await context.page.waitForFunction(
        `document.querySelectorAll('[data-testid="invitation"]').length > 0`,
      );
      const concurrentCount = await context.page.getByTestId("invitation").count();
      const passed = sequentialCount === 1 && concurrentCount === 1;
      return {
        status: passed ? "verified" : "failed",
        summary: passed
          ? "Retry and concurrent submission reused one pending invitation."
          : `Duplicate submission counts were sequential=${sequentialCount}, concurrent=${concurrentCount}.`,
        measurements: {
          sequential_pending_invitations: sequentialCount,
          concurrent_pending_invitations: concurrentCount,
        },
      };
    }
    if (context.mission.id === "authorization") {
      await reset(context);
      await context.page.goto(context.previewUrl);
      await context.page.getByTestId("role").selectOption("member");
      await context.page.getByTestId("send-invite").click();
      await expect(context.page.getByTestId("message")).toContainText("Only administrators");
      await expect(context.page.getByTestId("invitation")).toHaveCount(0);
      return {
        status: "verified",
        summary: "A non-admin was denied and no invitation was created.",
        expected_statuses: [403],
      };
    }
    if (context.mission.id === "expiration") {
      await reset(context);
      const response = await context.context.request.post(
        `${context.previewUrl}/api/testing/expired`,
      );
      const body = (await response.json()) as { invitation: { id: string } };
      await context.page.goto(`${context.previewUrl}/accept/${body.invitation.id}`);
      await expect(context.page.getByTestId("acceptance-state")).toContainText("expired");
      return {
        status: "verified",
        summary: "An expired invitation was rejected in the acceptance journey.",
        expected_statuses: [410],
      };
    }
    await context.page.goto(`${context.previewUrl}/signup`);
    await expect(context.page.getByRole("heading", { name: "Sign up" })).toBeVisible();
    await expect(context.page.getByTestId("signup-email")).toBeVisible();
    return {
      status: "verified",
      summary: "The existing signup surface remained reachable and interactive.",
    };
  },
};

export default adapter;
