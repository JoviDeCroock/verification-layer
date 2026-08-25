import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { canInvite, INVITATION_TTL_MS, isExpired, normalizeEmail } from "./domain.js";
import { invitations } from "./schema.js";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.use("/api/*", async (context, next) => {
  const started = Date.now();
  try {
    await next();
  } finally {
    console.log(
      JSON.stringify({
        event: "request",
        method: context.req.method,
        path: context.req.path,
        status: context.res.status,
        duration_ms: Date.now() - started,
      }),
    );
  }
});

app.get("/api/health", (context) => context.json({ ok: true, variant: context.env.DEMO_VARIANT }));

app.post("/api/testing/reset", async (context) => {
  const db = drizzle(context.env.DB);
  await db.delete(invitations);
  return context.json({ ok: true });
});

app.get("/api/invitations", async (context) => {
  const db = drizzle(context.env.DB);
  const rows = await db.select().from(invitations).orderBy(invitations.createdAt);
  return context.json({
    invitations: rows.map((row) => ({ ...row, expired: isExpired(row.expiresAt) })),
  });
});

app.post("/api/invitations", async (context) => {
  if (!canInvite(context.req.header("x-demo-role") ?? null))
    return context.json({ error: "Only administrators can invite members." }, 403);
  const body = await context.req.json<{ email?: unknown }>();
  if (typeof body.email !== "string" || !body.email.includes("@") || body.email.length > 254)
    return context.json({ error: "A valid email is required." }, 400);
  const email = normalizeEmail(body.email);
  const db = drizzle(context.env.DB);

  const now = new Date();
  const id = crypto.randomUUID();
  const broken = String(context.env.DEMO_VARIANT) === "broken";
  const invitation = {
    id,
    email,
    // The broken proof variant deliberately evades the stable key. Standard tests still pass;
    // intent-derived QA retries and races the mutation, exposing duplicate rows.
    dedupeKey: broken ? `${email}:${id}` : email,
    createdAt: now,
    expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
  };
  if (broken) {
    await db.insert(invitations).values(invitation);
    return context.json({ invitation, duplicate: false }, 201);
  }

  const inserted = await db
    .insert(invitations)
    .values(invitation)
    .onConflictDoNothing({ target: invitations.dedupeKey })
    .returning();
  if (inserted[0]) return context.json({ invitation: inserted[0], duplicate: false }, 201);
  const existing = await db
    .select()
    .from(invitations)
    .where(eq(invitations.dedupeKey, email))
    .limit(1);
  return context.json({ invitation: existing[0], duplicate: true });
});

app.post("/api/testing/expired", async (context) => {
  const db = drizzle(context.env.DB);
  const invitation = {
    id: crypto.randomUUID(),
    email: "expired@example.com",
    dedupeKey: `expired:${crypto.randomUUID()}`,
    createdAt: new Date(Date.now() - INVITATION_TTL_MS - 1_000),
    expiresAt: new Date(Date.now() - 1_000),
  };
  await db.insert(invitations).values(invitation);
  return context.json({ invitation }, 201);
});

app.get("/api/invitations/:id", async (context) => {
  const db = drizzle(context.env.DB);
  const rows = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.id, context.req.param("id"))))
    .limit(1);
  const invitation = rows[0];
  if (!invitation) return context.json({ error: "Invitation not found." }, 404);
  if (isExpired(invitation.expiresAt))
    return context.json({ error: "This invitation has expired.", expired: true }, 410);
  return context.json({ invitation, expired: false });
});

app.onError((error, context) => {
  console.error(
    JSON.stringify({ event: "request_error", path: context.req.path, message: error.message }),
  );
  return context.json({ error: "Unexpected server error." }, 500);
});

export default app;
