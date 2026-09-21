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

All eligible claims in one record operation share a single snapshot and manifest
refresh, with separate outcomes per target and the same overall candidate limit.
The response can also include `relatedEvidence`: at most eight direct incoming or
outgoing call/import candidates across at most eight eligible claims. Each carries
the originating claim, target URI, relation, direction and candidate `code://` URI.
`lexical_call` is a lexical hint; `resolved_import` identifies an indexed file.
Open useful candidates and explicitly record further evidence only after inspection.
Proposals never add claim relations or extra claims. Truncation and unavailable
proposals are explicit; candidate discovery does not rebuild an index or undo a
successful claim write.

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
are retained, with ambiguity first, then actionable `not_indexed`/`unsupported_syntax` cases, and four candidates per example. Strings longer
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
callback. `importResolutionCounts` and `importReasonsByLanguage` expose generation inventory
by adapter family; they are not request or fallback rates. `platform` and
`external_dependency` do not fill the unresolved sample or unresolved counter.
Dependency classification uses only declared names, with no distribution-to-module
or Composer-package-to-namespace guessing. `not_indexed` requires an existing,
repository-confined relative literal with an explicit extension, absent from the
source inventory. At most 4,096 distinct paths are probed once per source generation;
other missing imports retain `not_indexed_or_unsupported`. JS dynamic import/require
expressions are inventoried as `unsupported_syntax` without evaluating them. Task context carries a compact warning for incomplete
resolution, without turning ambiguity into a missing-index GAP.

Lexical display selection is still under observation. A higher-ranked page of the
same type can remove another candidate when it covers a strict superset of that
candidate's query signals **and the candidate covers less than half of all query
signals**. Facets and entities share the coverage matcher; query signals absent
from every retrieved page still count. Pages meeting the half-coverage threshold
are protected from dominance, including a specific page beneath a broad overview,
but remain subject to the ordinary result/token budgets. Below that threshold,
an overview can still suppress a page containing useful detail. Semantic/graph evidence,
traceability, explicit artifact chains and diversity/contradiction requests retain
their existing selection. The full candidate pool remains available for GAP assessment.
Deterministic regressions cover overview/detail ranking in all three profiles,
including five-of-six and half-coverage cases. The local workspace check retains
all expected pages. An additional read-only check on one authentic overview/detail
wiki retained all expected pages across 120 runs (20 analyst-authored questions,
three profiles, two budgets); 86 runs had the target below first rank. This does
not close the requirement for real questions across three authentic workspaces. See the
[workspace probe](../../benchmarks/README.md#workspace-specific-page-retention).

For Go projects, module identities come from discovered `go.mod` files. References
recheck existing manifests automatically. After creating a nested `go.mod`, call
`knowledge_code action="update"` with its path, or rebuild the index, to discover
the new module boundary. This reuses source fragments and existing anchors.
Manifest problems appear as bounded `manifestWarnings` in the reference response.
Without discovered manifests, Go retains its legacy suffix heuristic. Its edges now
carry a `legacy_suffix_heuristic` diagnostic with unverified candidates; suffix
coincidences can still create false positives.

JS/TS uses declared `paths` and `baseUrl` from the nearest `tsconfig.json` or
`jsconfig.json`. Configs accept comments, trailing commas and one local `extends`
level. Known configs and their current base files refresh on reference queries;
new nested configs need `update` on their path or a rebuild. Missing, invalid or
unsupported bases produce manifest diagnostics. `rootDir` is not an import alias.
Local `references`, literal `include`/`exclude`/`files`, and one-level inherited
membership choose the owning config; overlapping explicit projects stay ambiguous.
`package.json` supports local `exports` and `imports` (`#alias`), single-star
patterns, and ordered `import`/`require`/`default` conditions. npm/yarn `workspaces`
and literal pnpm `packages` lists supply local package identities. Duplicate package
names stay ambiguous; unexported subpaths remain private. Arrays, external alias
targets, custom conditions and bundler aliases are not resolved. Config ownership
is selected among discovered ancestor-directory configs; configs outside that chain
cannot claim arbitrary external source trees.

Python reads setuptools `package-dir`, explicit `packages`/`py-modules` and literal
package discovery roots/patterns from `pyproject.toml` or `setup.cfg`. Named directory
mappings preserve logical package names, including relative imports in renamed
directories. Regular package chains require indexed `__init__.py`/`.pyi`; `.py`
takes precedence over its stub. Without a manifest, a script supplies its directory
and a regular package supplies its verified root. Repository-wide `PYTHONPATH`,
implicit namespace packages, dynamic imports and build-backend execution are not
inferred. Tests outside a package need declared roots to import that package.

Poetry supports literal `packages = [{include="pkg", from="src"}]`, or the
project-named regular package beside the manifest. Hatch supports wheel `packages`
and literal `sources` lists/mappings; its implicit package selection is not guessed.
Flit supports its module/project name, flat and `src/` regular packages and single
modules. PDM supports `package-dir` and literal `includes`. Backend identity comes
from `build-backend` or a unique relevant tool table. Conflicting tables produce a
warning and no declared roots, while intra-package relative imports keep their
verified package boundary. Tests/scripts outside packages can now reach these
explicit layouts; implicit namespaces and runtime `sys.path` remain unsupported.
The pinned Hatch project deliberately verifies the undeclared-layout limit, while
the deterministic fixtures cover explicit Hatch layouts.

Composer reads PSR-4, PSR-0, classmap, files and literal exclusions from `autoload`
and `autoload-dev`, including string or array PSR directories. It
checks class namespace/path correspondence and keeps nested Composer projects
separate. Metadata-only manifests preserve declaration-based resolution within
that project boundary. Class/function/constant imports remain distinct, including
mixed groups, multiple namespaces and HTML between PHP blocks. Classmaps and
Python discovery filters share a compiled literal glob matcher with no exponential
backtracking. Composer scripts and installed packages are not executed or loaded.

Java and Kotlin share declared classes and functions across source roots and both
languages; Java static imports identify the owning class. Duplicate names or overloads
in competing Gradle modules remain ambiguous. Gradle dependency declarations are not
used to guess which duplicate is active. Literal Gradle settings and Maven modules
identify build boundaries; Maven reactor members share declarations, independent
nested builds remain separate. Conditional includes, profiles and custom Gradle
project directories are not evaluated. C# composes nested and file-scoped namespaces
and joins compatible partial types within the same discovered `.csproj` boundary.
Multiple project files in one directory are ambiguous. Without project declarations,
the repository remains one unspecified boundary. `Directory.Build.props` supplies
a shared boundary, and literal `Compile Remove` patterns exclude members. If the
file contains `Condition`, its remove rules are skipped with a notice; no MSBuild
condition or imported build script is executed.

Cargo reads package identities, custom `[lib].path`/`[[bin]].path`, literal workspace
members and bounded simple globs such as `crates/*`. Rust file-level `mod` declarations
produce edges, literal `#[path]` replaces conventional targets, and `cfg` alternatives
remain candidates with `cfg_conditional` diagnostics. Unsupported `cfg_attr`/path
expressions do not fall through to a guessed file. Unique one-level `pub use` can
reach the defining module; chains and macro expansion remain unsupported. Declared
Cargo dependencies are classified separately and are never resolved from installed
crates. Invalid independent workspace/dependency declarations retain valid root targets.

The shared minimal TOML parser supports tables, quoted/dotted keys, strings, arrays,
inline tables and scalar values used by these manifests. Python and Cargo select
only relevant declaration fields; unrelated tool options and date literals are
skipped without retaining their values. Selected malformed roots still yield
`invalid_manifest`. Unterminated strings/containers or malformed table boundaries
can prevent trustworthy section discovery and still invalidate the read. The reader
is not a validator for unrelated configuration. Manifest readers retain 256 KiB/file
and 32 direct references. Selected workspace/build graphs opt into at most eight
levels and 256 followed references. Wildcard enumeration has limits of 32 patterns,
32 results, 16 path segments and 16,384 directory entries; recursive `**` manifest
discovery is unsupported. Confinement, freshness and the 32 MiB project query-cache
admission budget remain enforced. These are bounded
declaration readers, not validators for every build tool's grammar.

Ruby `require_relative` resolves the literal path from the importing file, including
explicit `.rb`; ordinary `require` remains unresolved without a modeled load path.
The nearest unambiguous gemspec supplies literal, ordered `require_paths`. A declared
`Gem::Specification` without require_paths access supplies RubyGems' default `lib`;
dynamic/conditional assignments and mutations produce notices instead of guessed roots.
`require_relative` remains usable independently of gemspec errors. External gems are
not resolved. Literal `Gemfile` path gems add only their declared gemspec load paths.
Go also supports literal `go.work use` and local `replace`, respecting nested module
identity; competing replacements stay ambiguous. Vendor/build tags remain outside
the contract. The reader discovers `*.gemspec` and `*.csproj` in indexed ancestors
with bounded directory enumeration; new nested boundaries require index update.

C/C++ quoted includes first check the including directory, then literal include
options from `compile_commands.json`, or bounded directory/target declarations in
`CMakeLists.txt`. Compilation arguments retain include-search order; configurations
that resolve to different headers stay ambiguous. Literal CMake candidates are
conservative, without transitive target/build evaluation or arbitrary header choice.
Only repository-confined paths are considered. Compiler databases in arbitrary build
directories must be made discoverable at indexed ancestors/root. Angle includes,
macros, response files, dynamic CMake expressions and external paths remain unsupported.
No implementation twin is invented.

CMake supports single-level literal `set`, `${PROJECT_SOURCE_DIR}` and
`${CMAKE_SOURCE_DIR}` relative to the outer linked manifest, and literal
`add_subdirectory`. Unsupported declarations discard the affected target, while
independent literal targets survive. An unknown global include root blocks the
scope because it could shadow known headers; this is explicitly diagnosed.
Source-relative quoted includes remain available. No percentage of all real CMake
projects is claimed by the controlled corpus.

Salesforce reads `sfdx-project.json` package directories and nested project boundaries.
`@salesforce/label/c.Name`, `resourceUrl/Name` and `messageChannel/Name__c` resolve only
to indexed entity metadata. Duplicate bundles remain ambiguous across package
directories. Namespaced labels without a modeled declaration remain unresolved.
The platform module families (`lwc`, `lightning/*`, `@lwc/*`, `@wire`, bare
`@salesforce/apex`, and supported Salesforce user/client/i18n/community/site/permission
and content-asset families) never create invented local files.

Trigger headers create declared object references. Literal `controller`/`extensions`
attributes in Visualforce and `controller` in Aura reach Apex classes. Dynamic
expressions and LWC HTML templates remain unsupported. Apex `.cls-meta.xml` and
`.trigger-meta.xml` supply `Active`/`Inactive`/`Deleted` status on explicit index
updates; they remain outside the source roster and telemetry reports them as
unsupported source extensions. Up to 1 MiB of compact sidecar data and manifest-reader state can survive an
oversized uncached snapshot. Ordinal reference postings can also be retained under
a separate 16 MiB cap, without retaining fragment objects. Both count against the
unchanged 32 MiB project ceiling. Source generations invalidate both; manifest edits
invalidate postings. This avoids repeated sidecar discovery and resolver construction
when the full snapshot cannot be admitted. Status never removes evidence.

The public `imports` array retains raw specifiers; optional `importStatements` on
file modules preserve these syntax distinctions. Mixed resolved/unresolved forms
remain visible through partial-import diagnostics.

## Measure fallback use

Successful public `knowledge_code` search, symbol and references responses include
`requestId`, including empty results. When using a diagnostic fallback, pass that
ID as `request_id` to `record_fallback`, with `fallback_reason` set to `no_match`,
`ambiguous`, `unresolved_import` or `unsupported_extension` when applicable. Other
reasons are counted as `other`; the existing free-text fallback interface remains
compatible. The input schema lists the normalized reasons while continuing to accept legacy
free text. A repeated fallback for the same retained ID does not inflate the rate.
The compact action description supplies routing hints rather than enumerating the
whole API: `status`, `update` and `remove` remain in the action enum and the full
[tool reference](../reference/tool-actions.md).

`knowledge_admin action="status"` exposes `status.requestTelemetry`. The local
read-only report is `npm run report:code-requests -- /path/to/wiki`. Rates are distinct
linked fallback requests divided by served responses, per workspace and language.
Search/symbol requests use a file-extension scope when supplied, otherwise returned
hit languages; references use their target's language. Unscoped empty requests are
`unknown`, mixed languages are `mixed`, and `.h` follows the default C++ adapter.
Internal context/index calls, failed tool calls and resource reads are excluded.

Counters survive ordinary process restarts and use an atomic file with cross-process
locking, bounded to 256 KiB and the last 512 request IDs. They use OS buffering;
power-loss durability is not promised. Unknown, expired or foreign IDs count as
unlinked events and never fabricate a denominator. Unreported fallback use remains
unknown, so these rates are not complete user-behavior or language-coverage estimates.
The new aggregate stores no query text, source paths, symbols or result bodies.
Empty, truncated or inconsistent counter files recover on the next counter write,
under the same workspace lock. The original bytes are preserved in
`.knowledge-rail/code-request-counts.corrupt-<timestamp>-<id>.json`; status exposes
that archive under `recovery` and a new `startedAt` counting period. Old request IDs
become unlinked, so rates never mix periods. Status alone does not mutate a corrupt
file. Archives are retained for inspection. Unsupported newer formats, IO failures,
non-regular files and foreign symlinks are not reset; tool warnings name the workspace
counter path when counting remains unavailable.

The separate preexisting fallback journal retains its legacy format and contents.

## Include code impact in task context

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
implementation claims on six local wiki pages, with code anchors for runtime
classes, language resolvers, Salesforce metadata and knowledge synthesis. It uses
the same record/link/synthesis and mutation-finalization services as the tools.
Existing unrelated pages are preserved.

The script verifies every anchor with drift detection, checks that function links
expose implementation statements rather than just signatures, retrieves all six pages
through task context with a 2,000-token budget and opens all current cited code
resources. The local result is written to
`benchmarks/results/274-import-knowledge.json`. This is a functional path check,
not a claim about retrieval accuracy or speed on all projects.

On source revisions, the script explicitly supersedes its own previous claims.
It verifies all current anchors and code links, and reports older anchors requiring
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

Version 2.8.0's TypeScript adapter v5 includes the v4 handling of expression-position regex
literals containing quotes/backticks/braces and keeps UTF-16 offsets intact. Refresh
existing indexes with `knowledge_code action="rebuild"`; the upgrade reparses that
adapter's files selectively. This remains a deterministic extractor, not a complete
JavaScript parser: ambiguous statement-position regexes and nested Unicode-set
syntax still need dedicated coverage.

V5 also excludes import-like text in comments, strings and templates. Ruby advances
to v2 and C/C++ to v3 for import syntax provenance; Java, Kotlin, C# and PHP advance
to v2 for declaration scopes, import provenance and PHP constants. Rebuild refreshes affected adapters
selectively; the optional metadata keeps snapshot schema v2 compatible. Existing
anchors retain their captured parser versions and require drift verification.

Automated coverage includes `tests/code-import-resolution.test.ts`,
`tests/import-adapter-contract.test.ts` and the page → code-resource test in
`tests/drift-detection.test.ts`. Non-code and unresolved claims are checked to
remain free of fabricated code references; repeated synthesis preserves the link.

## Optional live semantic evaluation

`KNOWLEDGE_RAIL_EMBEDDING_QUERY_PREFIX` supplies an optional instruction applied to
queries only. It changes provider identity so embeddings with a different query
contract do not silently reuse the same index; document text remains unchanged.
Changing the prefix invalidates the semantic index and triggers a full document
re-embedding at its next synchronization, even though the document embedding inputs
are identical. Account for provider latency and, where applicable, cost when changing it.
For the user's Ollama `qwen3-embedding:0.6b` (1024 dimensions), the tested prefix was
`Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: `,
using the newline required by the [model's instruction format](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B).
Set it only for a model whose contract requires it.

Live runs use the same questions and production ANN thresholds. In this corpus,
the model passed all 29 recorded-alias functional scenarios but recovered neither
of the two paraphrase-only probes. The instruction reduced no-benefit token growth from six queries to one (+2
estimated tokens) in the final run; it did not improve recall. See the
[measured report](../../benchmarks/knowledge-routing-2.8.0.md) before interpreting
successful integration as general semantic coverage.
