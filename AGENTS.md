# Repository guidance

Bun/TypeScript source lives in `bun/`; tests are in `tests-bun/`.
Read `README.md` for setup and `docs/development.md` for architecture and recovery.

Install dependencies with `bun install --frozen-lockfile`. For code changes, run
`bun run typecheck` and relevant tests; use `bun test tests-bun` for broad changes.
Read integration probes before running them: they create temporary Codex sessions
and plugins.

Preserve session ownership, pairing validation, and stable delivery request IDs.
Inspect ambiguous delivery receipts before retrying; never blindly replay sends.
Keep credentials, private runtime state, and machine-specific paths out of commits.

Keep user documentation concise and focused on actions. Put implementation details
in the developer reference. System notices should be calm and actionable; routine
tool failures belong in local diagnostics.
