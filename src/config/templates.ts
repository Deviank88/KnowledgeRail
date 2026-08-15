export const DEFAULT_INDEX_MD = `# Indice Wiki

> Catalogo aggiornato automaticamente di tutte le pagine wiki.

## Entità
<!-- pagine su persone, organizzazioni, prodotti -->

## Concetti
<!-- pagine su idee, tecniche, pattern -->

## Riepiloghi
<!-- riepiloghi dei documenti sorgente -->

## Confronti
<!-- analisi comparative -->

## Panoramiche
<!-- visioni d'insieme di aree tematiche -->

## Analisi
<!-- argomenti ragionati e sintesi -->

## Richieste Validate
<!-- request end-to-end validate da development report -->

## Requisiti
<!-- requisiti funzionali e non funzionali -->

## Implementazioni
<!-- sintesi tecniche validate -->

## Esiti Test
<!-- risultati test e validazioni -->

## Release
<!-- changelog e rilasci -->
`;

export const DEFAULT_SCHEMA_MD = `# Wiki Schema and Conventions

> Wiki format: 4. State and derived artifact versions are stored in \`.knowledge-rail/state.json\`.

> This file defines the structure, workflows, and quality standards for this wiki.
> Read it at the start of every session. Update it when conventions change.

> MCP navigation: choose one of the eight \`knowledge_*\` domain tools directly and follow
> the machine-readable \`nextAction\` returned by each operation. Normal project work starts
> with \`knowledge_context mode="task"\` and a concrete objective.

---

## Lingua

**Tutte le pagine wiki devono essere scritte in italiano.**
I campi di frontmatter (\`title\`, \`tags\`, ecc.) rimangono nei loro formati tecnici (es. date ISO, lowercase-with-hyphens per i tag), ma tutto il testo libero — titoli, contenuto, descrizioni, commenti — deve essere in italiano.

---

## Directory Layout

\`\`\`
{project-root}/
├── docs/                # Piano documentale: fonti, output e stato evidence
│   ├── client/          # Fonti fornite dal cliente
│   ├── transcripts/     # Trascrizioni e note meeting
│   ├── reports/         # Development report validati
│   ├── changelogs/      # Changelog tecnici/funzionali
│   ├── normalized/      # Copie markdown normalizzate delle fonti
│   ├── deliverables/    # Documenti generati ed export DOCX
│   ├── assets/          # Asset dei deliverable (opzionale)
│   └── evidence-ir/     # Evidence IR durevole, gestita da KnowledgeRail
├── wiki/                # Memoria canonica mantenuta dall'agent
│   ├── SCHEMA.md        # Questo contratto
│   ├── index.md         # Indice rigenerato automaticamente
│   ├── log.md           # Log append-only
│   ├── .knowledge-rail/ # Stato operativo/derivato, non conoscenza canonica
│   └── <page-type>/     # Directory tipizzate, create al primo utilizzo
\`\`\`

Le directory wiki tipizzate sono: \`entities\`, \`concepts\`, \`summaries\`,
\`comparisons\`, \`overviews\`, \`analysis\`, \`meeting-notes\`, \`client-sources\`,
\`candidate-requests\`, \`requests\`, \`requirements\`, \`implementations\`, \`tests\`,
\`decisions\`, \`releases\`, \`risks\`, \`data-model\`, \`automations\`, \`integrations\`
e \`api\`. Le directory appaiono solo quando viene scritta la prima pagina di quel tipo.

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
client: "Cliente"
project: "Progetto"
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
- \`meeting_note\`: transcript/sintesi meeting e contesto NotebookLM; authority \`context\`.
- \`client_source\`: documento fornito dal cliente; authority \`client_input\`.
- \`candidate_request\`: richiesta emersa ma non ancora validata.
- \`request\`: richiesta validata end-to-end da development report.
- \`requirement\`: requisito funzionale/non funzionale collegato a una request.
- \`implementation\`: sintesi tecnica validata.
- \`test_result\`: evidenza test e validazione.
- \`decision\`: decisione tecnica o funzionale.
- \`release\`: changelog/rilascio.
- \`risk\`: rischio, gap o conflitto tra fonti.
- \`data_model\`, \`automation\`, \`integration\`, \`api\`: dettagli specialistici.

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

1. Normalizza la fonte, se necessario, con \`knowledge_files action="normalize"\`.
2. Avvia \`knowledge_ingest action="start"\` sul file normalizzato e segui il \`nextAction\` restituito.
3. Il ciclo guidato è \`next → apply_claims\`: \`apply_claims\` registra, collega, valida e sintetizza Evidence IR prima di aggiornare pagine canoniche.
4. Un segmento privo di claim utili può essere classificato soltanto con stato ammesso e motivazione esplicita.
5. Usa \`knowledge_ingest action="source_status"\` per verificare coverage e gap.
6. La fonte può essere finalizzata soltanto quando lo stato propone \`action="finalize"\` dopo coverage completa.

\`index.md\` viene rigenerato automaticamente a ogni mutation di pagina; registra le operazioni significative con \`knowledge_page action="append_log"\`.

---

## Query Workflow

When answering a question using the wiki:

1. Chiama \`knowledge_context mode="task"\` con l'intent appropriato e un obiettivo concreto; la risposta compact è predefinita.
2. Usa \`mode="search"\` o \`mode="graph"\` soltanto per diagnostica mirata, non come catena obbligatoria.
3. Materializza soltanto i resource link pertinenti.
4. Se la risposta contiene un \`nextAction\` di widening, eseguilo con il budget suggerito.
5. Non concatenare manualmente search, graph e page dump.
6. Se la knowledge resta insufficiente e non viene suggerito altro widening, dichiara gli \`evidenceGaps\` come GAP/unknown senza allucinare.

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

Usa questo workflow editoriale per produrre documenti strutturati (spec funzionali, architetture, ecc.) dalla conoscenza accumulata nella wiki senza perdere contenuti in contesti lunghi:

1. **Pianifica come redattore**: chiama \`knowledge_document_context action="plan"\` con \`document_type\`, opzionalmente \`project_name\`, \`objective\` e \`audience\`. Il tool restituisce contratto, sezioni, checklist e strategia di copertura.
2. **Prepara context pack mirati**: Per ogni sezione, chiama \`knowledge_document_context action="section"\` con \`section_title\`, query mirata, eventuali \`page_paths\`, filtri \`page_types\` e budget.
3. **Verifica codice quando la wiki non basta**: usa \`knowledge_code\` e materializza solo le risorse \`code://\` pertinenti. Una scansione raw è esclusivamente un fallback esplicito da registrare.
4. **Aggiorna la wiki prima del documento**: Per lacune o inesattezze, usa il prompt \`prepare_knowledge_update\`, applica la bozza con \`knowledge_page action="write"\`, poi \`action="append_log"\`. Dopo l'aggiornamento, rigenera il context pack.
5. **Assegna i writer**: Ogni writer scrive una sezione usando solo il proprio context pack aggiornato e segnala lacune invece di inventare.
6. **Assembla come redattore**: Unisci le sezioni, elimina duplicazioni e inserisci Mermaid solo quando chiarisce il contenuto.
7. **Salva la bozza**: Chiama \`knowledge_document action="write"\` con filename, titolo, tipo e contenuto completo.
8. **Revisiona**: segui il \`nextAction\` verso \`knowledge_document action="review"\` e risolvi tutti i blocker.
9. **Recupera lacune post-review**: usa \`knowledge_context\` o \`knowledge_code\`, aggiorna la wiki e rigenera la sezione.
10. **Esporta e registra**: \`knowledge_document action="export"\` rifiuta contenuti non conformi; poi usa \`knowledge_files\` e \`knowledge_page action="append_log"\`.

### Tipi di documento

| Tipo | Descrizione | Persona adottata |
|------|-------------|-----------------|
| \`functional_spec\` | Documento Funzionale di Progetto completo in italiano | PM esperto |
| \`architecture_doc\` | Architettura di sistema e decisioni tecniche | Solution Architect / Tech Lead |
| \`project_brief\` | Sintesi esecutiva per stakeholder | Business Analyst |
| \`onboarding_guide\` | Guida onboarding per nuovi sviluppatori | Senior Developer |
| \`api_reference\` | Documentazione endpoint e interfacce API | Backend Developer / API Specialist |
| \`adr\` | Architecture Decision Record | Software Architect |
| \`runbook\` | Procedura operativa, recovery e rollback | Site Reliability Engineer |
| \`test_plan\` | Piano di test tracciabile | Test Lead |
| \`incident_report\` | Incident review e azioni correttive | Incident Manager |
| \`release_notes\` | Note di rilascio e upgrade | Release Manager |
| \`custom\` | Qualsiasi altro tipo (nessun template predefinito) | — |

### Storage

I documenti vengono salvati in \`docs/deliverables/\`. Non sono pagine wiki e **non richiedono frontmatter**.

---

### Regole qualità documenti

- Usare lingua, audience e livello tecnico indicati dal contratto documentale o dagli override espliciti.
- Non lasciare placeholder come \`[Descrivere...]\`, \`[Nome]\` o \`{{PROJECT_NAME}}\` nel documento finale.
- Non inventare dettagli non presenti nella wiki: dichiarare lacune, assunzioni o dati da confermare.
- Nei documenti client-facing non citare wiki, context pack, agent, prompt, tool MCP, percorsi \`src/\`, \`tests/\`, \`docs/\` o dettagli del processo interno.
- Quando la wiki è insufficiente ma il codice chiarisce il funzionamento, aggiornare prima la wiki con una pagina o sezione verificata e poi rigenerare il documento.
- Usare tabelle e criteri verificabili quando aiutano la validazione.
- Usare blocchi Markdown \`\`\`mermaid solo quando il diagramma aggiunge chiarezza; non usare diagrammi ASCII o alberi monospaziati.

*Schema version 4 — Update this file when conventions evolve.*
`;

const DOCUMENT_QUALITY_RULES =
  "Regole trasversali: usa la lingua e il registro richiesti dal contratto documentale; " +
  "non lasciare placeholder irrisolti; non inventare dettagli non presenti nella wiki; " +
  "se la wiki è incompleta ma il codice chiarisce il comportamento, aggiorna prima la wiki e poi rigenera il documento; " +
  "nei documenti client-facing non citare wiki, context pack, agent, prompt, tool MCP o percorsi interni; " +
  "usa blocchi Markdown ```mermaid solo quando il diagramma chiarisce davvero flussi, architetture, dati o sequenze; " +
  "non usare ASCII art, alberi testuali o diagrammi monospaziati.";

export const DOCUMENT_PERSONAS: Record<string, string> = {
  functional_spec:
    "Sei un PM (Project Manager) esperto nella stesura di documentazione funzionale. " +
    "Il tuo obiettivo è produrre un documento chiaro, strutturato e validabile dal cliente. " +
    "Priorità: requisiti comprensibili anche da stakeholder non tecnici, scenari d'uso concreti, " +
    "criteri di accettazione misurabili. Il documento deve poter essere usato dal cliente per validare " +
    "la soluzione prima dello sviluppo. Quando servono diagrammi, usa esclusivamente blocchi Markdown " +
    "```mermaid con flowchart o sequenceDiagram: non usare ASCII art, alberi testuali o diagrammi monospaziati. " +
    DOCUMENT_QUALITY_RULES,

  architecture_doc:
    "Sei un Solution Architect / Tech Lead senior con vasta esperienza nella progettazione di sistemi distribuiti. " +
    "Il tuo obiettivo è produrre un documento di architettura che guidi il team di sviluppo con precisione. " +
    "Priorità: decisioni architetturali motivate, trade-off esplicitati, componenti e interfacce precisi, " +
    "considerazioni su scalabilità, sicurezza e manutenibilità. Quando servono diagrammi, usa esclusivamente " +
    "blocchi Markdown ```mermaid con flowchart, sequenceDiagram o erDiagram: non usare ASCII art, alberi testuali " +
    "o diagrammi monospaziati. " +
    DOCUMENT_QUALITY_RULES,

  project_brief:
    "Sei un Business Analyst orientato al valore di business. " +
    "Il tuo obiettivo è produrre una sintesi concisa per stakeholder esecutivi e non tecnici. " +
    "Priorità: chiarezza sul problema da risolvere, benefici misurabili, timeline realistica, " +
    "rischi principali. Massimo una pagina, linguaggio diretto. " +
    DOCUMENT_QUALITY_RULES,

  onboarding_guide:
    "Sei un Senior Developer con forte attenzione alla developer experience e all'onboarding. " +
    "Il tuo obiettivo è produrre una guida pratica e auto-sufficiente per nuovi membri del team. " +
    "Priorità: setup dell'ambiente passo-passo senza ambiguità, struttura del codebase spiegata, " +
    "workflow di sviluppo chiaro, link e risorse utili. Zero assunzioni sulle conoscenze pregresse del lettore. " +
    DOCUMENT_QUALITY_RULES,

  api_reference:
    "Sei un Backend Developer / API Specialist esperto nella produzione di documentazione tecnica. " +
    "Il tuo obiettivo è produrre una reference API precisa e immediatamente fruibile dagli sviluppatori integratori. " +
    "Priorità: contratti API chiari, esempi reali di request/response in JSON, " +
    "codici di errore documentati con cause e azioni correttive, autenticazione e rate limiting spiegati. " +
    DOCUMENT_QUALITY_RULES,

  adr:
    "Sei un software architect. Registra una singola decisione con contesto, driver, alternative, esito e conseguenze. " +
    "Distingui chiaramente fatti, vincoli e trade-off; collega eventuali decisioni sostituite. " +
    DOCUMENT_QUALITY_RULES,

  runbook:
    "Sei un Site Reliability Engineer. Produci istruzioni operative eseguibili, sicure e reversibili. " +
    "Includi segnali, diagnosi, mitigazione, rollback, escalation e verifica finale. " +
    DOCUMENT_QUALITY_RULES,

  test_plan:
    "Sei un Test Lead. Definisci scope, ambienti, dati, casi, risultati attesi, evidenze e criteri di uscita. " +
    "Ogni caso deve essere ripetibile e collegato a un requisito o rischio. " +
    DOCUMENT_QUALITY_RULES,

  incident_report:
    "Sei un Incident Manager. Ricostruisci fatti e timeline senza colpevolizzare, quantifica l'impatto e separa " +
    "causa radice, fattori contribuenti e azioni correttive con owner e scadenze. " +
    DOCUMENT_QUALITY_RULES,

  release_notes:
    "Sei un Release Manager. Comunica cambiamenti osservabili, compatibilità, upgrade, fix e problemi noti " +
    "in modo sintetico e verificabile per il pubblico destinatario. " +
    DOCUMENT_QUALITY_RULES,
};

export const DOCUMENT_TEMPLATES: Record<string, string> = {
  functional_spec: `# Documento Funzionale di Progetto: {{PROJECT_NAME}}

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

  onboarding_guide: `# Guida di Onboarding: {{PROJECT_NAME}}

> **Data:** {{DATE}}

## Benvenuto nel progetto!
[Breve presentazione del progetto, del team e degli obiettivi.]

## Prerequisiti

Prima di iniziare assicurati di avere installato:
- [Strumento 1 — versione minima]
- [Strumento 2]
- [Accessi necessari — es. VPN, repository, cloud console]

## Setup dell'Ambiente di Sviluppo

\`\`\`bash
# Clona il repository
git clone [repository-url]
cd [directory]

# Installa le dipendenze
[install command]

# Configura le variabili d'ambiente
cp .env.example .env
# Edita .env con i tuoi valori

# Avvia in locale
[start command]
\`\`\`

## Struttura del Repository

\`\`\`
[Struttura delle cartelle con spiegazione di ogni directory principale]
\`\`\`

## Workflow di Sviluppo

1. Crea un branch da \`main\`: \`git checkout -b feature/nome-feature\`
2. Sviluppa e testa in locale
3. Apri una Pull Request verso \`main\`
4. Attendi code review e CI verde
5. Merge dopo approvazione

## Test

\`\`\`bash
# Esegui i test
[test command]
\`\`\`

## Risoluzione dei Problemi

[Descrivere errori comuni, controlli diagnostici e modalità di escalation.]

## Contatti e Risorse

| Ruolo | Contatto |
|-------|----------|
| Tech Lead | |
| Product Owner | |
| Canale Slack del team | |
| Documentazione | |
| Issue tracker | |
`,

  api_reference: `# API Reference: {{PROJECT_NAME}}

> **Version:** 1.0 | **Date:** {{DATE}}
> **Base URL:** \`https://api.example.com/v1\`

## Autenticazione

[Descrivi il metodo di autenticazione — es. Bearer token nell'header Authorization.]

\`\`\`
Authorization: Bearer <token>
\`\`\`

## Formato delle Risposte

Tutte le risposte usano JSON:

\`\`\`json
{
  "success": true,
  "data": {},
  "error": null,
  "meta": { "page": 1, "total": 100 }
}
\`\`\`

## Codici di Errore

| Codice | Significato | Azione consigliata |
|--------|-------------|-------------------|
| 400 | Bad Request | Verifica i parametri della richiesta |
| 401 | Unauthorized | Rinnova il token di autenticazione |
| 403 | Forbidden | Verifica i permessi dell'utente |
| 404 | Not Found | La risorsa non esiste |
| 429 | Too Many Requests | Implementa exponential backoff |
| 500 | Internal Server Error | Riprova più tardi o contatta il supporto |

## Rate Limiting

[Descrivi i limiti — es. 100 richieste/minuto per token.]

---

## Endpoint

### [Nome Risorsa]

#### GET /[risorsa]
**Descrizione:** [Elenca tutte le risorse]
**Query params:**
| Parametro | Tipo | Default | Descrizione |
|-----------|------|---------|-------------|
| page | integer | 1 | Numero di pagina |
| limit | integer | 20 | Risultati per pagina |

**Response 200:**
\`\`\`json
{ "data": [], "meta": { "total": 0 } }
\`\`\`

#### POST /[risorsa]
**Descrizione:** [Crea una risorsa]
**Body:**
\`\`\`json
{ "field": "value" }
\`\`\`
**Response 201:**
\`\`\`json
{ "data": { "id": "uuid", "field": "value" } }
\`\`\`

#### GET /[risorsa]/:id
**Descrizione:** [Leggi una risorsa specifica]
**Response 200:**
\`\`\`json
{ "data": { "id": "uuid" } }
\`\`\`

#### PUT /[risorsa]/:id
**Descrizione:** [Aggiorna una risorsa]

#### DELETE /[risorsa]/:id
**Descrizione:** [Elimina una risorsa]
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
