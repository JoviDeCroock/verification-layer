import { expect, test } from "@playwright/test";

test("renders the invitation product surface", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Team invitations" })).toBeVisible();
  await expect(page.getByTestId("send-invite")).toBeEnabled();
});

test("exposes a healthy Worker API", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  await expect(response).toBeOK();
  expect(await response.json()).toMatchObject({ ok: true });
});
