# Contributing

KnowledgeRail accepts focused bug fixes, tests, documentation improvements, and features that preserve retrieval accuracy, provenance, and bounded context behavior.

## Setup

Use Node.js `22.12.0` or newer:

```bash
npm ci
npm run build
npm run verify
```

## Pull requests

- Keep changes scoped and add regression tests for changed behavior.
- Do not lower an existing quality threshold to make a change pass.
- Never commit project wikis, source documents, generated deliverables, credentials, local agent settings, build output, or dependencies.
- Run `npm run audit:runtime` and every quality gate affected by the change.
- Record relevant benchmark or evaluation results in the pull request.
- Update public documentation when behavior, configuration, compatibility, or security assumptions change.

The complete deterministic gate list and fixture policy are documented in [benchmarks/README.md](benchmarks/README.md). CI remains the source of truth for the supported Node.js matrix and required checks.
