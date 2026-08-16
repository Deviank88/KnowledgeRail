import { isDocumentType } from "./document-contracts.js";

export const DEFAULT_INDEX_MD = `# Wiki Index

> Automatically updated catalog of all wiki pages.

## Entities
<!-- pages about people, organizations, and products -->

## Concepts
<!-- pages about ideas, techniques, and patterns -->

## Summaries
<!-- source-document summaries -->

## Comparisons
<!-- comparative analyses -->

## Overviews
<!-- landscape views of topic areas -->

## Analysis
<!-- reasoned topics and syntheses -->

## Validated Requests
<!-- end-to-end requests validated by development reports -->

## Requirements
<!-- functional and non-functional requirements -->

## Implementations
<!-- validated technical summaries -->

## Test Results
<!-- test and validation results -->

## Releases
<!-- changelogs and releases -->
`;

export const DEFAULT_SCHEMA_MD = `# Wiki Schema and Conventions

> Wiki format: 4. State and derived artifact versions are stored in \`.knowledge-rail/state.json\`.

> This file defines the structure, workflows, and quality standards for this wiki.
> Read it at the start of every session. Update it when conventions change.

> MCP navigation: choose one of the eight \`knowledge_*\` domain tools directly and follow
> the machine-readable \`nextAction\` returned by each operation. Normal project work starts
> with \`knowledge_context mode="task"\` and a concrete objective.

---

## Language

**Write new wiki content in the language of the user's current request.**
An explicit language request overrides inference. When editing an existing page, preserve its language unless the user asks for a translation. If the user's language cannot be inferred safely, ask before writing instead of silently defaulting to English. This policy is open-ended: any natural language understood by the consuming model is valid.

Frontmatter fields (\`title\`, \`tags\`, and so on) retain their technical formats (for example ISO dates and lowercase-with-hyphens tags). Model-facing instructions, stable identifiers, and generated control files remain in English; this does not constrain the language of human-readable wiki pages or deliverables.

---

## Directory Layout

\`\`\`
{project-root}/
├── docs/                # Document plan: sources, outputs, and evidence state
│   ├── client/          # Client-provided sources
│   ├── transcripts/     # Transcripts and meeting notes
│   ├── reports/         # Validated development reports
│   ├── changelogs/      # Technical and functional changelogs
│   ├── normalized/      # Normalized Markdown source copies
│   ├── deliverables/    # Reviewed Markdown deliverables
│   ├── assets/          # Optional deliverable assets
│   └── evidence-ir/     # Durable Evidence IR managed by KnowledgeRail
├── wiki/                # Canonical memory maintained by the agent
│   ├── SCHEMA.md        # This contract
│   ├── index.md         # Automatically regenerated index
│   ├── log.md           # Log append-only
│   ├── .knowledge-rail/ # Operational/derived state, not canonical knowledge
│   └── <page-type>/     # Typed directories created on first use
\`\`\`

The typed wiki directories are: \`entities\`, \`concepts\`, \`summaries\`,
\`comparisons\`, \`overviews\`, \`analysis\`, \`meeting-notes\`, \`client-sources\`,
\`candidate-requests\`, \`requests\`, \`requirements\`, \`implementations\`, \`tests\`,
\`decisions\`, \`releases\`, \`risks\`, \`data-model\`, \`automations\`, \`integrations\`
and \`api\`. A directory appears only when the first page of that type is written.

---

## Required Frontmatter

Every wiki page MUST begin with YAML frontmatter:

\`\`\`yaml
---
title: "Human-readable page title"
type: entity | concept | summary | comparison | overview | analysis | meeting_note | client_source | candidate_request | request | requirement | implementation | test_result | decision | release | risk | data_model | automation | integration | api
tags: [tag1, tag2, tag3]
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources: ["docs/filename.md", "docs/other.md"]
client: "Client"
project: "Project"
request_id: "REQ-001"
status: candidate | validated | implemented | tested | released | superseded | conflict
authority: context | client_input | validated_report | test_evidence | deliverable
---
\`\`\`

### Field Rules

| Field     | Required | Notes                                                       |
|-----------|----------|-------------------------------------------------------------|
| \`title\`   | yes      | Human-readable, title case                                  |
| \`type\`    | yes      | One of the supported page types below                       |
| \`tags\`    | yes      | At least one tag; lowercase with hyphens                    |
| \`created\` | yes      | ISO date of first creation                                  |
| \`updated\` | yes      | ISO date of last modification — update on every edit        |
| \`sources\` | yes      | List of docs/ files this page draws from; empty list \`[]\` if none |

---

## Page Types

### \`entity\`
A named real-world thing: person, organization, product, place.
- File location: \`wiki/entities/Name_Of_Entity.md\`
- Contains: description, key facts, relationships, timeline
- Example: \`wiki/entities/OpenAI.md\`, \`wiki/entities/Sam_Altman.md\`

### \`concept\`
An idea, technique, algorithm, or pattern.
- File location: \`wiki/concepts/ConceptName.md\`
- Contains: definition, how it works, use cases, trade-offs
- Example: \`wiki/concepts/Retrieval_Augmented_Generation.md\`

### \`summary\`
A digest of a single source document.
- File location: \`wiki/summaries/SourceFileName.md\`
- Contains: key points, main arguments, notable quotes (with attribution)
- Example: \`wiki/summaries/attention_is_all_you_need.md\`

### \`comparison\`
Side-by-side analysis of two or more entities or concepts.
- File location: \`wiki/comparisons/A_vs_B.md\`
- Contains: comparison table, pros/cons, when to use which
- Example: \`wiki/comparisons/GPT4_vs_Claude.md\`

### \`overview\`
A landscape view of a topic area, linking to many other pages.
- File location: \`wiki/overviews/TopicArea.md\`
- Contains: taxonomy, key players, key concepts, recommended reading order
- Example: \`wiki/overviews/Large_Language_Models.md\`

### \`analysis\`
A reasoned argument, opinion synthesis, or inference drawn from sources.
- File location: \`wiki/analysis/TopicAnalysis.md\`
- Contains: thesis, evidence (with citations), conclusion, open questions
- Example: \`wiki/analysis/Scaling_Laws_Implications.md\`

### Project delivery types
Use these page types for consulting-project knowledge:
- \`meeting_note\`: meeting transcript/summary and contextual notes; authority \`context\`.
- \`client_source\`: client-provided document; authority \`client_input\`.
- \`candidate_request\`: an emerging request that is not yet validated.
- \`request\`: a request validated end-to-end by a development report.
- \`requirement\`: a functional or non-functional requirement linked to a request.
- \`implementation\`: a validated technical summary.
- \`test_result\`: test and validation evidence.
- \`decision\`: a technical or functional decision.
- \`release\`: a changelog or release record.
- \`risk\`: a risk, gap, or source conflict.
- \`data_model\`, \`automation\`, \`integration\`, \`api\`: specialist details.

---

## Cross-Reference Format

Use \`[[Page Name]]\` for wiki-internal links. The page name matches the \`title\` field.

\`\`\`markdown
See also [[Retrieval Augmented Generation]] and [[OpenAI]].
\`\`\`

Standard markdown links for external URLs:
\`\`\`markdown
[Attention Is All You Need](https://arxiv.org/abs/1706.03762)
\`\`\`

---

## Ingest Workflow

1. Normalize the source when necessary with \`knowledge_files action="normalize"\`.
2. Run \`knowledge_ingest action="start"\` on the normalized file and follow its \`nextAction\`.
3. The guided cycle is \`next → apply_claims\`: \`apply_claims\` records, links, validates, and synthesizes Evidence IR before updating canonical pages.
4. A segment without useful claims may be classified only with an allowed state and explicit reason.
5. Use \`knowledge_ingest action="source_status"\` to inspect coverage and gaps.
6. Finalize a source only when the state proposes \`action="finalize"\` after complete coverage.

\`index.md\` is regenerated after every page mutation; record significant operations with \`knowledge_page action="append_log"\`.

---

## Query Workflow

When answering a question using the wiki:

1. Call \`knowledge_context mode="task"\` with the appropriate intent and a concrete objective; compact response detail is the default.
2. Use \`mode="search"\` or \`mode="graph"\` only for targeted diagnostics, not as a mandatory chain.
3. Materialize only relevant resource links.
4. If the response contains a widening \`nextAction\`, execute it with the suggested budget.
5. Do not manually chain search, graph, and page dumps.
6. If knowledge remains insufficient and no further widening is suggested, report \`evidenceGaps\` as GAP/unknown without hallucinating.

---

## Lint Checklist

Run \`knowledge_admin action="lint"\` periodically and fix:

- **Orphan pages**: Pages with no inbound \`[[links]]\` — connect them to an overview or the index.
- **Missing pages**: \`[[links]]\` referencing non-existent pages — create the page or remove the link.
- **Broken markdown links**: Fix or remove.
- **Stale \`updated\` fields**: If you edited a page, ensure \`updated:\` reflects today's date.
- **Empty \`sources\`**: Every summary page must have at least one source.

---

## Naming Conventions

| Item          | Convention                         | Example                          |
|---------------|------------------------------------|----------------------------------|
| Entity pages  | Title_Case_With_Underscores.md     | \`Sam_Altman.md\`               |
| Concept pages | Descriptive_Name.md                | \`Chain_of_Thought.md\`         |
| Summary pages | Match source filename (lowercased) | \`attention_is_all_you_need.md\`|
| Tags          | lowercase-with-hyphens             | \`large-language-model\`        |
| WikiLinks     | Match the \`title\` field          | \`[[Sam Altman]]\`             |

---

---

## Document Generation Workflow

Use this editorial workflow to produce structured documents (functional specifications, architecture documents, and so on) from accumulated wiki knowledge without losing information in long contexts:

1. **Plan as an editor**: call \`knowledge_document_context action="plan"\` with \`document_type\` and optional \`project_name\`, \`objective\`, and \`audience\`. The tool returns the contract, sections, checklist, and coverage strategy.
2. **Prepare targeted context packs**: for each section call \`knowledge_document_context action="section"\` with \`section_title\`, a targeted query, optional \`page_paths\`, \`page_types\` filters, and budgets.
3. **Verify code when the wiki is insufficient**: use \`knowledge_code\` and materialize only relevant \`code://\` resources. A raw scan is exclusively an explicit fallback that must be recorded.
4. **Update the wiki before the document**: for gaps or inaccuracies, use \`prepare_knowledge_update\`, apply the draft with \`knowledge_page action="write"\`, then \`action="append_log"\`. Regenerate the context pack afterward.
5. **Assign writers**: each writer produces one section using only its updated context pack and reports gaps instead of inventing content.
6. **Assemble as an editor**: merge sections and remove duplication. Diagrams are optional; use only the representation explicitly selected by the user.
7. **Save the draft**: call \`knowledge_document action="write"\` with the filename, title, type, and complete content.
8. **Review**: follow \`nextAction\` to \`knowledge_document action="review"\` and resolve every blocker.
9. **Recover post-review gaps**: use \`knowledge_context\` or \`knowledge_code\`, update the wiki, and regenerate the section.
10. **Complete**: a passing review is terminal. Any conversion or branded rendering is owned by the user and their chosen tools.

### Document types

| Type | Description | Persona |
|------|-------------|---------|
| \`functional_spec\` | Complete functional project specification | Expert PM |
| \`functional_analysis\` | Business processes, rules, requirements and expected outcomes | Business Analyst |
| \`technical_analysis\` | Current state, proposed implementation and verification strategy | Technical Analyst |
| \`architecture_doc\` | System architecture and technical decisions | Solution Architect / Tech Lead |
| \`project_brief\` | Executive stakeholder summary | Business Analyst |
| \`user_manual\` | Task-oriented guide for end users | Technical Writer |
| \`onboarding_guide\` | Onboarding guide for new developers | Senior Developer |
| \`api_reference\` | Endpoint and API-interface documentation | Backend Developer / API Specialist |
| \`adr\` | Architecture Decision Record | Software Architect |
| \`runbook\` | Operational, recovery, and rollback procedure | Site Reliability Engineer |
| \`test_plan\` | Traceable test plan | Test Lead |
| \`incident_report\` | Incident review and corrective actions | Incident Manager |
| \`release_notes\` | Release and upgrade notes | Release Manager |
| \`custom\` | Generic custom structure | Senior Technical Editor |

These are presets, not a closed taxonomy. Any non-empty document type is valid, and callers can provide their own required sections.

### Storage

Documents are saved under \`docs/deliverables/\`. They are not wiki pages and **do not require frontmatter**.

---

### Document quality rules

- Use the explicit output language when supplied; otherwise use the language of the user's current request. Translate human-facing template headings and prose instead of treating an English reference template as an English-output requirement.
- Do not leave placeholders such as \`[Describe...]\`, \`[Name]\`, or \`{{PROJECT_NAME}}\` in the final document.
- Do not invent details absent from the wiki; report gaps, assumptions, or data to confirm.
- In client-facing documents, do not mention the wiki, context packs, agents, prompts, MCP tools, \`src/\`, \`tests/\`, \`docs/\` paths, or internal process details.
- When the wiki is insufficient but code clarifies behavior, first update the wiki with a verified page or section and then regenerate the document.
- Use tables and verifiable criteria when they aid validation.
- Diagrams are optional and no representation is enforced when the choice is omitted. Use Mermaid or a relative external SVG/PNG only when the user selected that representation; do not use ASCII diagrams or monospace trees.

*Schema version 4 — Update this file when conventions evolve.*
`;

const DOCUMENT_QUALITY_RULES =
  "Cross-cutting rules: use the explicit output language when supplied, otherwise the language of the user's current request; " +
  "translate human-facing headings and prose even when the structural reference template is in English; " +
  "leave no unresolved placeholders; do not invent details absent from the wiki; " +
  "if the wiki is incomplete but code clarifies behavior, update the wiki before regenerating the document; " +
  "do not mention the wiki, context packs, agents, prompts, MCP tools, or internal paths in client-facing documents; " +
  "diagrams are optional and no representation is enforced when the choice is omitted; use Mermaid or a relative external asset only when the user selected it; " +
  "do not use ASCII art, text trees, or monospace diagrams.";

export const DOCUMENT_PERSONAS: Record<string, string> = {
  functional_spec:
    "You are a PM experienced in functional documentation. " +
    "Produce a clear, structured document that the client can validate. " +
    "Prioritize requirements understandable by non-technical stakeholders, concrete usage scenarios, " +
    "and measurable acceptance criteria. The client must be able to validate the solution before development. " +
    DOCUMENT_QUALITY_RULES,

  functional_analysis:
    "You are a senior Business Analyst. Describe actors, current and target processes, business rules, functional requirements, exceptions, and measurable outcomes without prescribing unsupported implementation details. " +
    DOCUMENT_QUALITY_RULES,

  technical_analysis:
    "You are a senior Technical Analyst. Explain verified current behavior, constraints, components, interfaces, data impact, implementation options, risks, migration, and a concrete verification strategy. " +
    DOCUMENT_QUALITY_RULES,

  architecture_doc:
    "You are a senior Solution Architect / Tech Lead with extensive distributed-systems experience. " +
    "Produce an architecture document that guides the development team precisely. " +
    "Prioritize justified architecture decisions, explicit trade-offs, precise components and interfaces, " +
    "and scalability, security, and maintainability. " +
    DOCUMENT_QUALITY_RULES,

  project_brief:
    "You are a Business Analyst focused on business value. " +
    "Produce a concise summary for executive and non-technical stakeholders. " +
    "Prioritize a clear problem statement, measurable benefits, a realistic timeline, and major risks. " +
    "Use direct language and keep it to one page. " +
    DOCUMENT_QUALITY_RULES,

  user_manual:
    "You are a senior Technical Writer focused on end users. Produce task-oriented instructions with prerequisites, expected outcomes, recovery guidance, troubleshooting, and an accessible glossary. " +
    DOCUMENT_QUALITY_RULES,

  onboarding_guide:
    "You are a Senior Developer focused on developer experience and onboarding. " +
    "Produce a practical, self-contained guide for new team members. " +
    "Prioritize unambiguous step-by-step environment setup, an explained codebase structure, " +
    "a clear development workflow, and useful links and resources. Assume no prior project knowledge. " +
    DOCUMENT_QUALITY_RULES,

  api_reference:
    "You are a Backend Developer / API Specialist experienced in technical documentation. " +
    "Produce a precise API reference that integration developers can use immediately. " +
    "Prioritize clear API contracts, realistic JSON request/response examples, documented error codes " +
    "with causes and corrective actions, and explained authentication and rate limiting. " +
    DOCUMENT_QUALITY_RULES,

  adr:
    "You are a software architect. Record one decision with its context, drivers, alternatives, outcome, and consequences. " +
    "Clearly distinguish facts, constraints, and trade-offs, and link any superseded decisions. " +
    DOCUMENT_QUALITY_RULES,

  runbook:
    "You are a Site Reliability Engineer. Produce executable, safe, and reversible operational instructions. " +
    "Include signals, diagnosis, mitigation, rollback, escalation, and final verification. " +
    DOCUMENT_QUALITY_RULES,

  test_plan:
    "You are a Test Lead. Define scope, environments, data, cases, expected results, evidence, and exit criteria. " +
    "Every case must be repeatable and linked to a requirement or risk. " +
    DOCUMENT_QUALITY_RULES,

  incident_report:
    "You are an Incident Manager. Reconstruct facts and the timeline without blame, quantify impact, and separate " +
    "root cause, contributing factors, and corrective actions with owners and deadlines. " +
    DOCUMENT_QUALITY_RULES,

  release_notes:
    "You are a Release Manager. Communicate observable changes, compatibility, upgrades, fixes, and known issues " +
    "concisely and verifiably for the target audience. " +
    DOCUMENT_QUALITY_RULES,

  custom:
    "You are a senior technical editor. Follow the user-supplied purpose and structure, keep claims evidence-backed, and make gaps explicit. " +
    DOCUMENT_QUALITY_RULES,
};

const ENGLISH_FUNCTIONAL_SPEC = `# Functional Specification: {{PROJECT_NAME}}

> **Version:** 1.0
> **Date:** {{DATE}}
> **Status:** Draft

---

## 1. Purpose and Objectives
[Describe the document purpose, audience, project objectives, and measurable success criteria.]

## 2. Context and Motivation
[Describe the business context, current situation, target situation, and stakeholders.]

## 3. Functional Requirements
### FR-001 — [Requirement name]
**Priority:** High / Medium / Low
**Description:** [Detailed requirement description.]
**Acceptance criteria:**
- [ ] [Verifiable criterion 1]
- [ ] [Verifiable criterion 2]

## 4. Non-Functional Requirements
[State performance, security, scalability, availability, and maintainability requirements.]

## 5. System Architecture
[Describe the high-level architecture, main components, responsibilities, and technology stack.]

## 6. Data Model
[Describe primary entities, fields, constraints, and relationships.]

## 7. Process Flows
[Describe actors, preconditions, main steps, postconditions, and alternative scenarios.]

## 8. Integrations
[Describe external systems, exposed APIs, protocols, payloads, and frequency.]

## 9. Timeline and Roadmap
[Describe phases, estimated duration, dependencies, milestones, and target dates.]

## 10. Risks and Mitigations
[List each risk, probability, impact, mitigation, and owner.]

## 11. Glossary
[Define project-specific terms.]

## 12. Appendices
[Add references and revision history.]
`;

export const DOCUMENT_TEMPLATES: Record<string, string> = {
  functional_spec: ENGLISH_FUNCTIONAL_SPEC,
  functional_analysis: `# Functional Analysis: {{PROJECT_NAME}}

> **Date:** {{DATE}} | **Status:** Draft

## Purpose and Scope
[Define the business objective, audience, boundaries, and explicit exclusions.]

## Stakeholders and Actors
[Identify actors, responsibilities, needs, and permissions.]

## Current Process and Problems
[Describe the verified current workflow, pain points, and constraints.]

## Target Process and Use Cases
[Describe the desired workflow, primary scenarios, exceptions, and expected outcomes.]

## Functional Requirements
[List traceable functional requirements and applicable business rules.]

## Data and Integrations
[Describe business data, ownership, external systems, and exchange requirements.]

## Acceptance Criteria
[Define measurable criteria that demonstrate the requested behavior.]

## Assumptions, Gaps, and Risks
[Separate confirmed facts from assumptions, missing evidence, and risks.]
`,
  technical_analysis: `# Technical Analysis: {{PROJECT_NAME}}

> **Date:** {{DATE}} | **Status:** Draft

## Objective and Scope
[Define the technical question, affected boundaries, and exclusions.]

## Verified Current State
[Describe current components, behavior, interfaces, and implementation evidence.]

## Requirements and Constraints
[List functional drivers, non-functional constraints, and invariants.]

## Proposed Technical Approach
[Explain the implementation approach, responsibilities, and justified trade-offs.]

## Components, Interfaces, and Data
[Describe affected components, contracts, dependencies, and data impact.]

## Security, Operations, and Migration
[Cover security, observability, rollout, compatibility, and rollback.]

## Risks and Open Questions
[Record risks, mitigations, unknowns, and evidence gaps.]

## Verification Strategy
[Define tests, acceptance evidence, and completion criteria.]
`,
  _legacy_functional_spec: `# Documento Funzionale di Progetto: {{PROJECT_NAME}}

> **Versione:** 1.0
> **Data:** {{DATE}}
> **Stato:** Bozza

---

## 1. Scopo e Obiettivi

### 1.1 Scopo del Documento
[Descrivere lo scopo di questo documento e il suo pubblico di riferimento.]

### 1.2 Obiettivi del Progetto
- [Obiettivo principale 1]
- [Obiettivo principale 2]
- [Obiettivo principale 3]

### 1.3 Criteri di Successo
- [Criterio misurabile 1]
- [Criterio misurabile 2]

---

## 2. Contesto e Motivazione

### 2.1 Contesto di Business
[Descrivere il contesto aziendale, il problema che si vuole risolvere e perché il progetto è necessario ora.]

### 2.2 Situazione Attuale (As-Is)
[Descrivere il processo o sistema attuale. Identificare inefficienze, gap, pain point.]

### 2.3 Situazione Futura (To-Be)
[Descrivere come sarà il processo o sistema dopo l'implementazione.]

### 2.4 Stakeholder
| Ruolo | Nome/Team | Interesse |
|-------|-----------|-----------|
| Sponsor | | |
| Product Owner | | |
| Team di sviluppo | | |
| Utenti finali | | |

---

## 3. Requisiti Funzionali

### 3.1 RF-001 — [Nome Requisito]
**Priorità:** Alta / Media / Bassa
**Descrizione:** [Descrizione dettagliata del requisito.]
**Criteri di accettazione:**
- [ ] [Criterio 1]
- [ ] [Criterio 2]

### 3.2 RF-002 — [Nome Requisito]
**Priorità:** Alta / Media / Bassa
**Descrizione:** [Descrizione dettagliata del requisito.]
**Criteri di accettazione:**
- [ ] [Criterio 1]

_[Aggiungere ulteriori requisiti secondo necessità.]_

---

## 4. Requisiti Non-Funzionali

### 4.1 Prestazioni
- [Requisito di performance — es. tempo di risposta < 200ms per il 95° percentile]

### 4.2 Sicurezza
- [Requisito di sicurezza — es. autenticazione tramite OAuth 2.0]

### 4.3 Scalabilità
- [Requisito di scalabilità — es. supporto fino a N utenti concorrenti]

### 4.4 Disponibilità
- [Requisito di uptime — es. 99.9% SLA]

### 4.5 Manutenibilità
- [Standard di codice, documentazione, test coverage minima]

---

## 5. Architettura di Sistema

### 5.1 Panoramica dell'Architettura
[Descrizione ad alto livello dell'architettura.]

\`\`\`mermaid
flowchart LR
  A[Sistema sorgente] --> B[Componente applicativo]
  B --> C[Servizio / integrazione]
  C --> D[Persistenza / CRM]
\`\`\`

### 5.2 Componenti Principali
| Componente | Responsabilità | Tecnologia |
|------------|----------------|------------|
| [Componente 1] | | |
| [Componente 2] | | |

### 5.3 Stack Tecnologico
- **Frontend:** [tecnologia]
- **Backend:** [tecnologia]
- **Database:** [tecnologia]
- **Infrastruttura:** [cloud provider, containerizzazione, ecc.]

---

## 6. Modello dei Dati

### 6.1 Entità Principali

#### Entità: [NomeEntità]
| Campo | Tipo | Obbligatorio | Descrizione |
|-------|------|--------------|-------------|
| id | UUID | Sì | Identificatore univoco |
| [campo] | [tipo] | | [descrizione] |

### 6.2 Relazioni tra Entità
[Descrivere le relazioni principali.]

\`\`\`mermaid
flowchart TD
  A[Entità padre] --> B[Entità figlia]
  B --> C[Entità correlata]
\`\`\`

---

## 7. Flussi di Processo

### 7.1 Flusso Principale: [Nome Flusso]
**Attori:** [lista attori]
**Pre-condizioni:** [stato iniziale]
**Post-condizioni:** [stato finale]

**Passi:**
1. [Passo 1 — attore: azione]
2. [Passo 2]
3. [Passo 3]

**Scenari alternativi:**
- **Alt-A:** [Condizione] → [Azione alternativa]
- **Alt-B:** [Condizione di errore] → [Gestione dell'errore]

---

## 8. Integrazioni

### 8.1 Sistemi Esterni
| Sistema | Tipo | Protocollo | Frequenza | Note |
|---------|------|------------|-----------|------|
| [Sistema 1] | Inbound/Outbound | REST/Event | Real-time/Batch | |

### 8.2 API Esposte

#### Endpoint: [METODO] /[percorso]
**Descrizione:** [cosa fa]
**Request:**
\`\`\`json
{ "campo": "tipo" }
\`\`\`
**Response (200):**
\`\`\`json
{ "campo": "valore" }
\`\`\`

---

## 9. Timeline e Roadmap

| Fase | Descrizione | Durata stimata | Dipendenze |
|------|-------------|----------------|------------|
| Fase 1 — Setup | Infrastruttura, ambienti | [N settimane] | — |
| Fase 2 — Core | [Funzionalità principali] | [N settimane] | Fase 1 |
| Fase 3 — Integrazioni | [Sistemi esterni] | [N settimane] | Fase 2 |
| Fase 4 — Testing & QA | UAT, fix | [N settimane] | Fase 3 |
| Fase 5 — Go-Live | Deploy produzione | [N settimane] | Fase 4 |

**Milestone:**
- **M1 — [Nome]:** [Data target] — [Criteri]
- **M2 — Go-Live:** [Data target] — Sistema in produzione

---

## 10. Rischi e Mitigazioni

| ID | Rischio | Probabilità | Impatto | Mitigazione |
|----|---------|-------------|---------|-------------|
| R01 | [Rischio 1] | Alta/Media/Bassa | Alto/Medio/Basso | [Azione] |
| R02 | [Rischio 2] | | | |

---

## 11. Glossario

| Termine | Definizione |
|---------|-------------|
| [Termine 1] | [Definizione] |

---

## 12. Appendici

### Appendice A — Riferimenti
- [Link o citazione 1]

### Appendice B — Cronologia delle Revisioni
| Versione | Data | Autore | Modifiche |
|----------|------|--------|-----------|
| 1.0 | {{DATE}} | [LLM Agent] | Prima bozza |
`,

  architecture_doc: `# Architecture Document: {{PROJECT_NAME}}

> **Version:** 1.0 | **Date:** {{DATE}} | **Status:** Draft

---

## 1. Executive Summary
[High-level description of the system architecture and key decisions.]

## 2. System Context
[System boundary, external actors, and dependencies.]

## 3. Component Architecture

### 3.1 Component Overview
| Component | Responsibility | Technology |
|-----------|----------------|------------|
| [Component 1] | | |
| [Component 2] | | |

### 3.2 Component Details
[Detail each component: interfaces, state, failure modes.]

## 4. Data Architecture
[Data stores, data flow, persistence strategy, caching.]

## 5. Infrastructure & Deployment
[Cloud resources, containerization, CI/CD pipeline, environments.]

## 6. Security Architecture
[Authentication, authorization, data encryption, network security, secrets management.]

## 7. Observability
[Logging strategy, metrics, distributed tracing, alerting.]

## 8. Architecture Decision Records (ADRs)

### ADR-001 — [Title]
**Status:** Accepted
**Context:** [Why this decision was needed]
**Decision:** [What was decided]
**Consequences:** [Trade-offs and implications]
`,

  project_brief: `# Project Brief: {{PROJECT_NAME}}

> **Date:** {{DATE}}

## Problem Statement
[The problem being solved in 2-3 sentences.]

## Proposed Solution
[High-level description of the solution.]

## Target Users
[Who will use this and how.]

## Key Features (MVP)
- [Feature 1]
- [Feature 2]
- [Feature 3]

## Success Metrics
- [Metric 1 — measurable]
- [Metric 2 — measurable]

## Constraints & Assumptions
- [Constraint or assumption 1]

## Estimated Timeline
[High-level timeline — e.g., Q1 MVP, Q2 full launch]

## Budget / Resources
[High-level resource estimate if known]
`,

  user_manual: `# User Manual: {{PROJECT_NAME}}

> **Date:** {{DATE}}

## Overview
[Explain what the product does, who it is for, and its main capabilities.]

## Prerequisites and Access
[List supported environments, permissions, accounts, and initial configuration.]

## Getting Started
[Provide the shortest verified path to a successful first outcome.]

## Common Tasks
[Organize task-oriented procedures by user goal, with expected outcomes.]

## Errors and Troubleshooting
[Describe recognizable symptoms, safe recovery steps, and escalation conditions.]

## Frequently Asked Questions
[Answer recurring user questions with concise, verified guidance.]

## Glossary and Support
[Define product terminology and provide approved support channels.]
`,

  onboarding_guide: `# Onboarding Guide: {{PROJECT_NAME}}

> **Date:** {{DATE}}

## Welcome to the project
[Briefly introduce the project, team, and objectives.]

## Prerequisites

Before starting, make sure you have installed:
- [Tool 1 — minimum version]
- [Tool 2]
- [Required access — for example VPN, repository, cloud console]

## Development Environment Setup

\`\`\`bash
# Clone the repository
git clone [repository-url]
cd [directory]

# Install dependencies
[install command]

# Configure environment variables
cp .env.example .env
# Edit .env with your values

# Start locally
[start command]
\`\`\`

## Repository Structure

\`\`\`
[Directory tree with an explanation of each main directory]
\`\`\`

## Development Workflow

1. Create a branch from \`main\`: \`git checkout -b feature/name\`
2. Develop and test locally
3. Open a pull request to \`main\`
4. Wait for code review and green CI
5. Merge after approval

## Test

\`\`\`bash
# Run tests
[test command]
\`\`\`

## Troubleshooting

[Describe common errors, diagnostic checks, and escalation paths.]

## Contacts and Resources

| Role | Contact |
|-------|----------|
| Tech Lead | |
| Product Owner | |
| Team Slack channel | |
| Documentation | |
| Issue tracker | |
`,

  api_reference: `# API Reference: {{PROJECT_NAME}}

> **Version:** 1.0 | **Date:** {{DATE}}
> **Base URL:** \`https://api.example.com/v1\`

## Authentication

[Describe the authentication method, for example a Bearer token in the Authorization header.]

\`\`\`
Authorization: Bearer <token>
\`\`\`

## Response Format

All responses use JSON:

\`\`\`json
{
  "success": true,
  "data": {},
  "error": null,
  "meta": { "page": 1, "total": 100 }
}
\`\`\`

## Error Codes

| Code | Meaning | Recommended action |
|--------|-------------|-------------------|
| 400 | Bad Request | Check request parameters |
| 401 | Unauthorized | Renew the authentication token |
| 403 | Forbidden | Check the user's permissions |
| 404 | Not Found | The resource does not exist |
| 429 | Too Many Requests | Implement exponential backoff |
| 500 | Internal Server Error | Retry later or contact support |

## Rate Limiting

[Describe limits, for example 100 requests per minute per token.]

---

## Endpoint

### [Resource Name]

#### GET /[resource]
**Description:** [List all resources]
**Query params:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| page | integer | 1 | Page number |
| limit | integer | 20 | Results per page |

**Response 200:**
\`\`\`json
{ "data": [], "meta": { "total": 0 } }
\`\`\`

#### POST /[resource]
**Description:** [Create a resource]
**Body:**
\`\`\`json
{ "field": "value" }
\`\`\`
**Response 201:**
\`\`\`json
{ "data": { "id": "uuid", "field": "value" } }
\`\`\`

#### GET /[resource]/:id
**Description:** [Read a specific resource]
**Response 200:**
\`\`\`json
{ "data": { "id": "uuid" } }
\`\`\`

#### PUT /[resource]/:id
**Description:** [Update a resource]

#### DELETE /[resource]/:id
**Description:** [Delete a resource]
**Response 204:** No content
`,

  adr: `# ADR: {{PROJECT_NAME}} — [Decision title]

> **Status:** Proposed | **Date:** {{DATE}}

## Context
[Describe the problem, constraints and decision drivers.]

## Decision
[State the selected option precisely.]

## Alternatives Considered
| Alternative | Benefits | Drawbacks | Reason rejected |
|---|---|---|---|
| [Alternative] | [Benefit] | [Drawback] | [Reason] |

## Consequences
[Describe positive, negative and operational consequences.]

## Validation and Follow-up
[Define how the decision will be validated and when it must be revisited.]
`,

  runbook: `# Operational Runbook: {{PROJECT_NAME}}

> **Owner:** [Team] | **Last reviewed:** {{DATE}}

## Scope and Safety
[State when to use this runbook, permissions required and stop conditions.]

## Signals and Preconditions
[List alerts, symptoms and checks that confirm the scenario.]

## Diagnosis
\`\`\`bash
# Replace with a safe diagnostic command
[diagnostic command]
\`\`\`

## Mitigation and Recovery
[Provide ordered, independently verifiable recovery steps.]

## Rollback
[Explain how to reverse changes and verify the rollback.]

## Escalation
[List severity thresholds, owner and communication channel.]

## Post-recovery Verification
[Define health checks, metrics and evidence to retain.]
`,

  test_plan: `# Test Plan: {{PROJECT_NAME}}

> **Version:** 1.0 | **Date:** {{DATE}} | **Status:** Draft

## Scope and Objectives
[List in-scope behavior, exclusions and risks addressed.]

## Test Environment and Data
[Describe environment, versions, dependencies, accounts and test data.]

## Entry and Exit Criteria
[Define measurable prerequisites and acceptance criteria.]

## Test Cases
| ID | Requirement/Risk | Preconditions | Steps | Expected Result | Evidence |
|---|---|---|---|---|---|
| TC-001 | [Reference] | [State] | [Steps] | [Expected result] | [Artifact] |

## Regression Strategy
[Identify the regression suite and selection rationale.]

## Defects, Reporting and Ownership
[Define severity, triage, owner and reporting cadence.]
`,

  incident_report: `# Incident Report: {{PROJECT_NAME}} — [Incident title]

> **Incident ID:** [ID] | **Severity:** [SEV] | **Date:** {{DATE}}

## Executive Summary and Impact
[Describe customer and business impact with measurable scope and duration.]

## Timeline
| Time (UTC) | Event | Evidence |
|---|---|---|
| [time] | [event] | [source] |

## Detection and Response
[Explain detection, triage, mitigation and recovery.]

## Root Cause and Contributing Factors
[Separate confirmed root cause from contributing conditions and unknowns.]

## Corrective Actions
| Action item | Owner | Due date | Verification |
|---|---|---|---|
| [Action] | [Owner] | [Date] | [Evidence] |

## Lessons and Follow-up
[Record improvements, residual risks and review date.]
`,

  release_notes: `# Release Notes: {{PROJECT_NAME}} v[VERSION]

> **Release date:** {{DATE}}

## Highlights
[Summarize the most important user-visible outcomes.]

## Added and Changed
[List new or changed behavior with links to relevant documentation.]

## Fixed
[List resolved defects and observable effects.]

## Compatibility and Upgrade
[State prerequisites, migrations, breaking changes and rollback guidance.]

## Known Issues
[List known limitations, workarounds and planned resolution.]

## Verification
[State release checks and evidence.]
`,
};

export function documentPersona(documentType: string): string {
  if (isDocumentType(documentType) && Object.hasOwn(DOCUMENT_PERSONAS, documentType)) {
    return DOCUMENT_PERSONAS[documentType];
  }
  return DOCUMENT_PERSONAS.custom;
}

export function documentTemplate(documentType: string): string | undefined {
  if (isDocumentType(documentType) && Object.hasOwn(DOCUMENT_TEMPLATES, documentType)) {
    return DOCUMENT_TEMPLATES[documentType];
  }
  return undefined;
}
