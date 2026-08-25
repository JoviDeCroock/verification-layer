# ADR 0001: Cloudflare demo, local trust definition

The demo application runs as a Hono Cloudflare Worker, stores invitations in D1 through Drizzle, and renders a Preact UI using Signals.

The trust definition and change contract remain local, readable, and version-controlled. Browser QA executes against a preview but does not own policy. Findings become proposals and require human approval before promotion.
