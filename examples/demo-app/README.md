# Demo application

A Cloudflare Workers example using Hono, Drizzle with D1, Preact, and Preact Signals. It is both a realistic discovery target and the behavioral proof fixture for the executable trust layer.

The `DEMO_VARIANT=broken` Worker variable deliberately removes duplicate-invitation idempotency. Domain tests still pass, while the independently generated duplicate-submission QA mission fails.
