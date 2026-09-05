# Retrieve knowledge with direct code evidence

A knowledge page that explains an implementation should identify the class,
function or method supporting that explanation. KnowledgeRail can keep this
reference with the claim and render it as a directly readable code resource.
Operational notes, requirements without an implementation, and unsupported
targets do not need invented code links.

## Record an implementation claim

1. Use `knowledge_code action="symbol"` with the qualified declaration name, or
   a bounded code search, to locate the relevant fragment. Read its returned
   resource and verify that it supports the claim.
2. In the `knowledge_ingest` workflow, provide that URI as
   `claims[].target.code_resource_uri` when calling `action="apply_claims"`.
   Keep the normalized document and segment provenance as usual.
3. The pipeline refreshes only the targeted code files and captures the indexed
   line range, range hash and parser version. If capture fails, the warning is
   explicit and the page does not receive a purportedly verified code link.
4. Synthesis places the code URI and captured line range beside the claim on the
   canonical wiki page. Run drift checks before relying on older implementation
   claims; the displayed range records the capture, not a perpetual freshness claim.

Example claim payload; replace the URI with the actual indexed resource:

```json
{
  "text": "OrderService validates the order before persistence.",
  "kind": "behavior",
  "origin": "explicit",
  "confidence": 1,
  "target": {
    "page_path": "implementations/OrderValidation.md",
    "page_title": "Order validation",
    "page_type": "implementation",
    "code_resource_uri": "<URI returned by knowledge_code>"
  }
}
```

Code references belong in this field, not in the page's `sources` frontmatter:
`sources` lists documents under `docs/`. The TypeScript core API uses camelCase
`target.codeResourceUri`; MCP tool arguments use `target.code_resource_uri`.

## Follow the evidence during retrieval

Start with `knowledge_context` for the task, open the returned wiki resource,
then open its cited `code://repo/...#symbol-...` resource. This retrieves a bounded
fragment directly instead of repeating a repository-wide search for its location.
For dependency questions, use `knowledge_code action="references"` on the indexed
file module. An import edge identifies the resolved file or members of an explicit
namespace/package group; it does not prove which declarations execute.

The [import contract](../../benchmarks/README.md#local-import-references) describes
declaration lookup, header paths, Go/Rust conventions, LWC virtual imports and
remaining ambiguities. Inspect the extracted specifier and relevant source when
a rule cannot resolve the edge.

Reference responses expose `unresolvedImports` when the indexed snapshot contains
recognized ambiguity or unresolved imports. Each example includes the source path,
specifier, matched name, status, reason and candidate paths. At most twelve examples
are retained, with ambiguity first and four candidates per example. Strings longer
than 256 UTF-16 code units are abbreviated and marked `textTruncated`; use the
indexed source for complete text. `unresolvedImportsTruncated` also reports omitted
examples or candidates.

`unresolvedImportsScope: "indexed_snapshot"` means these are sampled from the
generation's import inventory, **not attributed to the queried target or filtered
by its path prefixes**. They do not establish an indexing failure: unresolved can
mean external, unsupported or absent from the index. Rebuilding alone may not help.
An ambiguous singular name contributes no import edge. An explicit namespace or
package can legitimately contain multiple files; valid members of partially
resolved PHP/Rust groups remain available while failed members get diagnostics.
Custom resolver arrays remain trusted declarations, with an optional issue-reporting
callback. Inventory counts by adapter language family stay internal and are not
request or fallback rates. Task context carries a compact warning for incomplete
resolution, without turning ambiguity into a missing-index GAP.

For Go projects, module identities come from discovered `go.mod` files. References
recheck existing manifests automatically. After creating a nested `go.mod`, call
`knowledge_code action="update"` with its path, or rebuild the index, to discover
the new module boundary. This reuses source fragments and existing anchors.
Manifest problems appear as bounded `manifestWarnings` in the reference response.
Without discovered manifests, Go retains its legacy suffix heuristic.

JS/TS uses declared `paths` and `baseUrl` from the nearest `tsconfig.json` or
`jsconfig.json`. Configs accept comments, trailing commas and one local `extends`
level. Known configs and their current base files refresh on reference queries;
new nested configs need `update` on their path or a rebuild. Missing, invalid or
unsupported bases produce manifest diagnostics. `rootDir` is not an import alias.
Project references, include/exclude ownership and package/bundler resolution remain
outside this bounded resolver; inspect those declarations when an edge is missing.

For an impact question, one request can now include source files:

```json
{
  "mode": "task",
  "intent": "modify",
  "objective": "Assess the effects of changing the credit rule",
  "changed_paths": ["unusual/domain/credit.ts"],
  "heuristic_token_budget": 4000
}
```

`changeImpact.codeRoots` identifies indexed files or active anchored claims;
`codeRelations` contains incoming call/reference/import candidates, and
`codeWikiPages` links up to six canonical pages associated with active claims for
those targets. Explicit source paths in the objective/query are also recognized.
For impact intents (implement, modify, debug, review), selected pages can supply
claim roots without the request naming a symbol. Superseded, contradicted, ambiguous
and known-drifted claims are excluded from this automatic expansion.

The maximum is three roots and twelve incoming candidates per root, reduced further
by the total context token budget. Full and compact responses expose the same code
links. Related wiki metadata is a candidate list and does not claim to satisfy
documentary coverage. Read only relevant links. `codeSnapshot` identifies the indexed
generation; source bodies are not re-read by context and may have changed since
indexing. Materialization verifies them through the existing resource reader.

Context never creates or repairs a code index. An absent, incompatible, corrupt or
unsafe index produces a GAP while wiki evidence remains usable; refresh it explicitly
with `knowledge_code` when needed. Fixed expansion limits report `widenable: false`;
token-budget omissions can suggest a larger budget while preserving the query,
changed paths and page-type filters. Existing adapter limitations still apply:
lexical call/reference matches and heuristic imports are candidates, and an empty
result does not establish that a module is unused.

## Verified project example

Run `npm run dogfood:import-knowledge` from the KnowledgeRail checkout. It records
19 implementation claims on six local wiki pages, with code anchors for runtime
classes, language resolvers, Salesforce metadata and knowledge synthesis. It uses
the same record/link/synthesis and mutation-finalization services as the tools.
Existing unrelated pages are preserved.

The script verifies every anchor with drift detection, checks that function links
expose implementation statements rather than just signatures, retrieves all six pages
through task context with a 2,000-token budget and opens all 19 cited code
resources. The local result is written to
`benchmarks/results/274-import-knowledge.json`. This is a functional path check,
not a claim about retrieval accuracy or speed on all projects.

On source revisions, the script explicitly supersedes its own previous claims.
It verifies all 19 current anchors and code links, and reports older anchors requiring
review separately. Historical claims are preserved; a fresh current claim does not
make an old captured range fresh. Page staleness now consults current claim status:
superseded anchors remain in the audit ledger but do not alone mark a page obsolete.
Active, ambiguous and contradicted claims still propagate drift. This also handles
supersession after the last drift check, without rewriting history. Empty or wholly
fresh ledgers do not trigger an evidence-store read; with linked drift entries, the
validated store is read once per task-context request and is not retained in a new cache.
Code impact shares that same per-request store read when it needs anchored claims.
The script also checks actual code impact for `src/context/code-impact.ts`, including
the compiler that uses it, then materializes every disclosed code candidate within
a separate 6,000-token context budget.

Version 2.7.4 also corrects TypeScript function ranges containing destructured or
object-typed parameters. Its adapter version advances to v3; refresh the code index
and check older anchors for drift before relying on those ranges.

The unreleased TypeScript adapter v4 additionally handles expression-position regex
literals containing quotes/backticks/braces and keeps UTF-16 offsets intact. Refresh
existing indexes with `knowledge_code action="rebuild"`; the upgrade reparses that
adapter's files selectively. This remains a deterministic extractor, not a complete
JavaScript parser: ambiguous statement-position regexes and nested Unicode-set
syntax still need dedicated coverage.

Automated coverage includes `tests/code-import-resolution.test.ts`,
`tests/import-adapter-contract.test.ts` and the page → code-resource test in
`tests/drift-detection.test.ts`. Non-code and unresolved claims are checked to
remain free of fabricated code references; repeated synthesis preserves the link.
