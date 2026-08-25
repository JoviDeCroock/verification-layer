# Demo navigation instructions

- `/` is the administrator invitation surface.
- Use the “Acting as” selector to exercise the authorization boundary.
- `/signup` represents adjacent behavior that must not regress.
- `/accept/:id` renders invitation acceptance state.
- QA may reset isolated local state through `POST /api/testing/reset`.
- A verification mission must treat console errors, uncaught exceptions, and failed network requests as evidence failures.
