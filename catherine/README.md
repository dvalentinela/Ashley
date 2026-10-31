# Catherine operating specifications

This directory holds Catherine's versioned operating instructions. It is kept
apart from application code (`src/`), provider credentials (Cloudflare
secrets) and customer records (D1/R2).

- `specs/<id>.md` — one file per specification version. Never edit a released
  file in place; add a new file with a new id and version.
- `scripts/build-specs.mjs` turns these files into `src/agent/specs.generated.ts`
  with a SHA-256 of each file. Every Catherine run records the spec id, version
  and hash it used, so a plan can always be traced to its instructions.
- The active spec is chosen by the `AGENT_SPEC_ID` variable.

## Status

Only `provisional-0.1` exists. It is a **provisional role written by the
developer** to make the runtime testable. It is not the approved Catherine
specification, does not describe Catherine's personality or history, and does
not change her authority model. Replace it with the specification supplied by
the strategy project by adding a new file (for example `approved-1.0.md`) and
setting `AGENT_SPEC_ID`.

Header fields (first lines, `key: value`) are required: `id`, `version`,
`status` (`provisional` or `approved`), `approved_by` (or `none`), `date`.
