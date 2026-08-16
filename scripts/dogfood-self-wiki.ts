import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import type {
  JSONRPCMessage,
  JSONRPCRequest,
  Transport,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildServer } from "../src/mcp/server.js";

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const EXPECTED_MODERN_TOOL_COUNT = 8;

type RpcId = string | number;
type ToolResult = Record<string, unknown> & {
  content?: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

class MemoryTransport implements Transport {
  peer?: MemoryTransport;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;
  setSupportedProtocolVersions?: (versions: string[]) => void;
  private started = false;
  private closed = false;

  async start(): Promise<void> {
    this.started = true;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.started || this.closed || !this.peer?.started || this.peer.closed) {
      throw new Error("Memory transport is not open.");
    }
    const peer = this.peer;
    queueMicrotask(() => peer.onmessage?.(structuredClone(message)));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

function linkedPair(): [MemoryTransport, MemoryTransport] {
  const left = new MemoryTransport();
  const right = new MemoryTransport();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

function modernMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientInfo": {
      name: "knowledge-rail-self-dogfood",
      version: "1.0.0",
    },
    "io.modelcontextprotocol/clientCapabilities": {
      resources: true,
      prompts: true,
    },
  };
}

function resultOf(message: JSONRPCMessage): Record<string, unknown> {
  if ("error" in message) {
    throw new Error(`MCP error: ${JSON.stringify(message.error)}`);
  }
  if (!("result" in message)) throw new Error(`Expected MCP result: ${JSON.stringify(message)}`);
  return (message as { result: Record<string, unknown> }).result;
}

function textContent(result: Record<string, unknown>): string {
  const content = result.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: "text"; text: string } =>
      Boolean(item && typeof item === "object" && item.type === "text" && typeof item.text === "string")
    )
    .map((item) => item.text)
    .join("\n");
}

function resourceLinks(result: Record<string, unknown>): string[] {
  const content = result.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((item): item is { type: "resource_link"; uri: string } =>
      Boolean(item && typeof item === "object" && item.type === "resource_link" && typeof item.uri === "string")
    )
    .map((item) => item.uri);
}

async function createHarness() {
  const [peer, wire] = linkedPair();
  const waiters = new Map<RpcId, (message: JSONRPCMessage) => void>();
  const serverRequests: JSONRPCRequest[] = [];
  const eras: Array<"legacy" | "modern"> = [];
  let requestId = 0;

  peer.onmessage = (message) => {
    if ("method" in message && "id" in message && message.id !== undefined) {
      serverRequests.push(message as JSONRPCRequest);
    }
    if ("id" in message && message.id !== undefined) {
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        waiter(message);
      }
    }
  };

  await peer.start();
  const handle = serveStdio((context) => {
    eras.push(context.era);
    return buildServer(context);
  }, { transport: wire, legacy: "reject" });

  const request = async (
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000
  ): Promise<Record<string, unknown>> => {
    const id = `self-dogfood-${++requestId}`;
    const response = await new Promise<JSONRPCMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);
      timeout.unref();
      waiters.set(id, (message) => {
        clearTimeout(timeout);
        resolve(message);
      });
      void peer.send({
        jsonrpc: "2.0",
        id,
        method,
        params: { ...params, _meta: modernMeta() },
      }).catch(reject);
    });
    return resultOf(response);
  };

  const callTool = async (
    name: string,
    args: Record<string, unknown> = {},
    timeoutMs = 30_000
  ): Promise<ToolResult> => {
    const result = await request("tools/call", { name, arguments: args }, timeoutMs) as ToolResult;
    if (result.isError) throw new Error(`${name} failed:\n${textContent(result)}`);
    return result;
  };

  return {
    request,
    callTool,
    serverRequests,
    eras,
    close: async () => {
      await handle.close();
      await peer.close();
    },
  };
}

interface SelfWikiPage {
  path: string;
  title: string;
  type: string;
  tags: readonly string[];
  body: readonly string[];
  authority?: string;
}

const OVERVIEW_TITLE = "KnowledgeRail — Panoramica della piattaforma";
const TEST_TITLE = "Dogfood MCP 2.0 del repository";

function pageMarkdown(page: SelfWikiPage, date: string): string {
  return [
    "---",
    `title: "${page.title}"`,
    `type: ${page.type}`,
    `tags: [${page.tags.join(", ")}]`,
    `created: ${date}`,
    `updated: ${date}`,
    "sources: []",
    ...(page.authority ? [`authority: ${page.authority}`] : []),
    "---",
    "",
    `# ${page.title}`,
    "",
    ...page.body,
    "",
  ].join("\n");
}

function selfWikiPages(): SelfWikiPage[] {
  return [
    {
      path: "overviews/KnowledgeRail_Platform.md",
      title: OVERVIEW_TITLE,
      type: "overview",
      tags: ["knowledge-rail", "architecture", "mcp-2"],
      authority: "validated_report",
      body: [
        "KnowledgeRail è un server MCP locale che mantiene una base di conoscenza Markdown persistente e verificabile per agenti LLM. Markdown e fonti rimangono canonici; indici lessicali, grafo, ANN, code evidence e ledger sono artefatti derivati e ricostruibili.",
        "",
        "## Flusso principale",
        "",
        "```mermaid",
        "flowchart LR",
        "  A[Agente MCP 2.0] --> B[8 tool di dominio]",
        "  B --> C[nextAction strutturato]",
        "  C --> D[Markdown canonico]",
        "  D --> E[BM25 + grafo + ANN]",
        "  E --> F[knowledge_context compatto]",
        "  F --> A",
        "```",
        "",
        "## Mappa della conoscenza",
        "",
        `- [[MCP 2.0 Runtime e negoziazione moderna]] descrive bootstrap, protocollo e workspace.`,
        `- [[Superficie tool MCP]] documenta tool di dominio, prompt e risorse.`,
        `- [[Retrieval ibrido e Task Context]] descrive il percorso di lettura accuracy-safe.`,
        `- [[Source Coverage ed Evidence IR]] descrive l'ingestione completa e la provenance.`,
        `- [[Code Evidence Index]] descrive l'evidence strutturale dal repository.`,
        `- [[Pipeline documentale e Mermaid]] descrive deliverable Markdown, review terminale e diagrammi opt-in.`,
        `- [[Modello persistente della conoscenza]] distingue dati canonici e derivati.`,
        `- [[Guida domain-first per agenti]] registra la decisione di navigazione.`,
        `- [[Provider OCR e semantic retrieval]] documenta le integrazioni opzionali.`,
        `- [[Requisiti di produzione]] definisce i gate operativi.`,
        `- [[Rischi e limiti operativi]] rende espliciti i limiti residui.`,
        `- [[${TEST_TITLE}]] registra il dogfood del repository.`,
      ],
    },
    {
      path: "implementations/MCP_2_Runtime.md",
      title: "MCP 2.0 Runtime e negoziazione moderna",
      type: "implementation",
      tags: ["mcp-2", "runtime", "protocol"],
      authority: "test_evidence",
      body: [
        `Vedi [[${OVERVIEW_TITLE}]] e [[Superficie tool MCP]].`,
        "",
        "## Bootstrap",
        "",
        "L'entrypoint verifica Node.js prima di toccare il workspace, risolve la root da override esplicito, variabile WIKI_ROOT o directory corrente e avvia il trasporto stdio del pacchetto @modelcontextprotocol/server 2.x.",
        "",
        "## Percorso moderno",
        "",
        "Il protocollo moderno usa l'envelope 2026-07-28. La factory riceve era=modern, non negozia Roots e restituisce evidence tramite resource link standard. server/discover e i cataloghi statici dichiarano cache privata con TTL di cinque minuti; le letture mutabili non vengono rese persistenti nella cache.",
        "",
        "## Compatibilità isolata",
        "",
        "L'adapter di trasporto legacy può ancora essere servito a client precedenti e abilita Roots soltanto quando la factory riceve era=legacy. Entrambe le ere espongono gli stessi otto tool di dominio; il percorso moderno legge knowledge-rail:// e code:// tramite resources/read.",
        "",
        "## Evidenza di codice",
        "",
        "Componenti principali: src/index.ts, src/mcp/server.ts e src/mcp/workspace.ts. Il dogfood fallisce se la sessione non rimane interamente moderna.",
      ],
    },
    {
      path: "api/MCP_Tool_Surface.md",
      title: "Superficie tool MCP",
      type: "api",
      tags: ["mcp-2", "tools", "resources"],
      authority: "validated_report",
      body: [
        `Vedi [[${OVERVIEW_TITLE}]], [[Guida domain-first per agenti]] e [[MCP 2.0 Runtime e negoziazione moderna]].`,
        "",
        "## Cataloghi moderni",
        "",
        "La sessione moderna espone otto tool di dominio, tre prompt, due risorse statiche e due template di risorsa. Non esiste un menu separato: ogni risultato restituisce stato e nextAction, mentre gli handler operativi di dettaglio restano interni.",
        "",
        "## Tool di dominio",
        "",
        "| Tool | Responsabilità |",
        "|---|---|",
        "| knowledge_context | Task Context, search, grafo e widening |",
        "| knowledge_page / knowledge_files | Memoria canonica e fonti controllate |",
        "| knowledge_ingest / knowledge_code | Evidence IR e codice |",
        "| knowledge_document_context / knowledge_document | Context pack, scrittura Markdown e review terminale |",
        "| knowledge_admin | Inizializzazione, lint e migrazione |",
        "",
        "## Risorse",
        "",
        "wiki://schema e wiki://log sono risorse statiche. knowledge-rail://page/{path} e code://repo/{path}#{symbol} materializzano soltanto l'evidence selezionata. Nel protocollo moderno non è necessario un tool di lettura ridondante.",
      ],
    },
    {
      path: "implementations/Retrieval_And_Task_Context.md",
      title: "Retrieval ibrido e Task Context",
      type: "implementation",
      tags: ["retrieval", "task-context", "accuracy"],
      authority: "validated_report",
      body: [
        `Vedi [[${OVERVIEW_TITLE}]], [[Modello persistente della conoscenza]] e [[Requisiti di produzione]].`,
        "",
        "## Candidate generation",
        "",
        "Il percorso unisce BM25 passage-aware, candidati ANN opzionali e un'espansione locale del grafo. La fusione è deterministica e il grafo parte da seed recuperati: il normal path non esegue full scan globale.",
        "",
        "## Progressive widening",
        "",
        "W0 usa un budget locale ridotto; W1 amplia seed e frontier; W2 aggiunge entity query e traversal locale massimo. W3 è riservato a un fallback esplicitamente configurato. Ogni tentativo registra nodi, archi, evidence e token proxy.",
        "",
        "## Task Context",
        "",
        "knowledge_context classifica evidence per intent understand, implement, modify, debug, review e document. La risposta compatta mantiene URI, path, coverage, gap e budget; full conserva il payload storico. Evidence mancanti diventano unknown o GAP, non inferenze silenziose.",
      ],
    },
    {
      path: "implementations/Source_Coverage_And_Evidence_IR.md",
      title: "Source Coverage ed Evidence IR",
      type: "implementation",
      tags: ["ingestion", "coverage", "provenance"],
      authority: "validated_report",
      body: [
        `Vedi [[${OVERVIEW_TITLE}]], [[Modello persistente della conoscenza]] e [[Rischi e limiti operativi]].`,
        "",
        "## Compilazione completa",
        "",
        "Una fonte normalizzata viene segmentata integralmente in unità content-addressed. max_chars limita una tranche di lavoro, non la fonte totale. Il ledger resta open finché ogni segmento non ha una disposizione esplicita e verificabile.",
        "",
        "## Evidence IR",
        "",
        "Il ciclo obbligatorio è record, link, plan_synthesis e synthesize. I claim vengono persistiti prima della scrittura wiki con sourceUri e segmentId; duplicati, contraddizioni e supersessioni sono conservati. La finalizzazione è bloccata finché coverage, provenance e rappresentazione non sono complete.",
        "",
        "## Knowledge recovery",
        "",
        "Evidence trovata tardi da fallback o widening crea debt durevole e deduplicato. La registrazione non riscrive automaticamente la wiki; la chiusura passa dalla stessa pipeline Evidence IR e verifica pagina, provenance e coverage.",
      ],
    },
    {
      path: "implementations/Code_Evidence_Index.md",
      title: "Code Evidence Index",
      type: "implementation",
      tags: ["code-evidence", "index", "security"],
      authority: "test_evidence",
      body: [
        `Vedi [[${OVERVIEW_TITLE}]], [[Retrieval ibrido e Task Context]] e [[Rischi e limiti operativi]].`,
        "",
        "## Indice deterministico",
        "",
        "L'adapter TypeScript/JavaScript estrae moduli, classi, funzioni, metodi, route, test e commenti con import, call, config key e riferimenti database. Il fingerprint combina path, content hash e versione parser; rebuild e update riusano i file invariati.",
        "",
        "## Lettura selettiva",
        "",
        "Le query search, symbol e references restituiscono URI code://repo content-addressed. resources/read verifica che path e realpath restino nel repository, che l'indice contenga il frammento e che l'hash del file sia ancora corrente prima di leggere il corpo del simbolo.",
        "",
        "## Fallback",
        "",
        "Una scansione raw non è il percorso normale. Se un coverage controller la autorizza, record_fallback rende osservabili query, motivo, risultati e knowledge debt eventualmente usata.",
      ],
    },
    {
      path: "implementations/Document_Pipeline_And_Mermaid.md",
      title: "Pipeline documentale e Mermaid",
      type: "implementation",
      tags: ["documents", "markdown", "mermaid"],
      authority: "test_evidence",
      body: [
        `Vedi [[${OVERVIEW_TITLE}]], [[Retrieval ibrido e Task Context]] e [[Provider OCR e semantic retrieval]].`,
        "",
        "## Context per sezione",
        "",
        "knowledge_document_context action=section usa lo stesso compiler accuracy-safe e produce evidence plan, matrice di coverage, provenance, GAP e, quando utile, un diagram evidence pack. action=plan accetta preset o profili liberi; il writer materializza soltanto l'evidence selezionata.",
        "",
        "## Review terminale",
        "",
        "I deliverable Markdown vengono salvati in docs/deliverables e revisionati contro contratti di struttura, contenuto, lingua, audience, placeholder e asset locali. Una review senza blocker è terminale e restituisce lo SHA-256 del contenuto ispezionato.",
        "",
        "## Diagrammi e portabilità",
        "",
        "I diagrammi sono opt-in: l'LLM può scrivere Mermaid nel Markdown oppure collegare un SVG/PNG già presente in docs/assets. KnowledgeRail non disegna e non converte formati; Obsidian e altri viewer compatibili rendono direttamente Mermaid.",
      ],
    },
    {
      path: "data-model/Persistent_Knowledge_Artifacts.md",
      title: "Modello persistente della conoscenza",
      type: "data_model",
      tags: ["data-model", "markdown", "derived-artifacts"],
      authority: "validated_report",
      body: [
        `Vedi [[${OVERVIEW_TITLE}]], [[Source Coverage ed Evidence IR]] e [[Retrieval ibrido e Task Context]].`,
        "",
        "## Canonico",
        "",
        "Le pagine wiki Markdown e le fonti in docs sono la source of truth. Ogni pagina possiede frontmatter validato, titolo, tipo, tag, date e fonti; index.md viene rigenerato e log.md è append-only.",
        "",
        "## Derivato",
        "",
        "La directory wiki/.knowledge-rail contiene stato formato, manifest, BM25, graph runtime, semantic index, code evidence, coverage ledger e migration journal. Evidence IR e recovery debt durevoli risiedono in docs/evidence-ir. Gli indici derivati possono essere invalidati e ricostruiti senza riscrivere semanticamente i Markdown canonici.",
        "",
        "## Integrità",
        "",
        "Le scritture usano operazioni atomiche e lock mirati. I path sono risolti entro root controllate; traversal, path assoluti e symlink escape vengono rifiutati. Le migrazioni creano backup e journal e possono essere rollbackate solo se i canonical hash sono ancora coerenti.",
      ],
    },
    {
      path: "decisions/Domain_First_Agent_Guidance.md",
      title: "Guida domain-first per agenti",
      type: "decision",
      tags: ["agent-guidance", "domain-tools", "mcp-2"],
      authority: "validated_report",
      body: [
        `Vedi [[${OVERVIEW_TITLE}]] e [[Superficie tool MCP]].`,
        "",
        "## Decisione",
        "",
        "Ogni task KnowledgeRail sceglie direttamente uno degli otto tool di dominio. Il discriminatore mode/action seleziona l'operazione e ogni risultato restituisce stato, una sola nextAction, argomenti richiesti e suggerimenti.",
        "",
        "## Motivazione",
        "",
        "Non vengono usati menu, tool-profile, scope per sessione o refresh dinamico del catalogo. La guida è progressiva e result-driven: l'agente vede subito il dominio corretto e riceve il passo successivo soltanto dopo l'esito reale.",
        "",
        "## Conseguenze",
        "",
        "Le ere legacy e MCP 2.0 vedono gli stessi otto nomi knowledge_* senza alias duplicati. Gli schemi bloccano chiamate incomplete e le transizioni critiche sono validate server-side; il routing iniziale in linguaggio naturale richiede comunque eval su modelli reali.",
      ],
    },
    {
      path: "integrations/OCR_And_Semantic_Providers.md",
      title: "Provider OCR e semantic retrieval",
      type: "integration",
      tags: ["ocr", "semantic", "providers"],
      authority: "validated_report",
      body: [
        `Vedi [[${OVERVIEW_TITLE}]], [[Pipeline documentale e Mermaid]] e [[Rischi e limiti operativi]].`,
        "",
        "## OCR",
        "",
        "Le fonti PDF e immagine possono usare GLM-OCR tramite Ollama oppure un server nativo. Host, modello, timeout, retry e prompt sono configurazione infrastrutturale via variabili KNOWLEDGE_RAIL_* e non parametri modificabili dall'agente.",
        "",
        "## Semantic retrieval",
        "",
        "Il provider embedding è opzionale e OpenAI-compatible anche per endpoint locali. L'indice passage-level LSH/cosine è derivato, versionato e incrementale. Se il provider è assente o fallisce, il percorso lessicale e il grafo continuano senza perdita del servizio base.",
        "",
        "## Vincoli",
        "",
        "Endpoint, dimensioni e risposte vengono validati. Il motore ANN deve mantenere candidate set bounded e non può trasformarsi in una scansione completa dei vettori nel normal path.",
      ],
    },
    {
      path: "requirements/Production_Readiness.md",
      title: "Requisiti di produzione",
      type: "requirement",
      tags: ["production", "requirements", "verification"],
      authority: "test_evidence",
      body: [
        `Vedi [[${OVERVIEW_TITLE}]], [[MCP 2.0 Runtime e negoziazione moderna]], [[Rischi e limiti operativi]] e [[${TEST_TITLE}]].`,
        "",
        "## Protocollo",
        "",
        "- Il runtime deve usare @modelcontextprotocol/server major 2.",
        "- La sessione di produzione moderna deve negoziare 2026-07-28 e non deve mai richiedere Roots.",
        "- Il catalogo moderno non deve contenere wiki_read_resource; la materializzazione deve usare resources/read.",
        "",
        "## Qualità e sicurezza",
        "",
        "- La self-wiki deve essere creata soltanto attraverso tools/call MCP.",
        "- L'indice codice deve coprire i file TypeScript/JavaScript senza fallback grep.",
        "- La wiki finale deve superare lint senza errori, link mancanti o pagine orfane.",
        "- knowledge_context deve recuperare evidence di implementazione, requisiti, decisioni, test e rischi entro budget bounded.",
        "- Un resource link codice e uno wiki devono essere materializzati con il protocollo moderno.",
        "",
        "## Portabilità",
        "",
        "Il server deve funzionare su Node.js supportato in macOS, Windows e Linux. Rendering Mermaid, OCR ed embedding richiedono un controllo separato delle dipendenze infrastrutturali.",
      ],
    },
    {
      path: "risks/Production_Risks_And_Limits.md",
      title: "Rischi e limiti operativi",
      type: "risk",
      tags: ["risks", "production", "limits"],
      authority: "validated_report",
      body: [
        `Vedi [[${OVERVIEW_TITLE}]], [[Requisiti di produzione]] e [[Guida domain-first per agenti]].`,
        "",
        "## Rischi residui",
        "",
        "- Gli otto domini e nextAction riducono le scelte ma non garantiscono che ogni modello classifichi correttamente una richiesta naturale; servono A/B su modelli reali.",
        "- Il token estimator UTF-8 bytes / 3 è riproducibile ma non coincide necessariamente con il tokenizer del provider.",
        "- L'adapter legacy è ancora incluso per compatibilità: un host vecchio può negoziarlo, mentre questo dogfood lo vieta esplicitamente.",
        "- Mermaid dipende dall'avvio di Chromium; container e policy sandbox possono richiedere configurazione aggiuntiva.",
        "- OCR ed embedding dipendono da servizi esterni o locali non necessari al percorso base.",
        "",
        "## Mitigazioni",
        "",
        "CI e benchmark bloccano regressioni di accuracy, coverage, migrazione e tool surface. Gli indici degradano in modo sicuro, i fallback vengono telemetrati e gap o evidence non disponibili devono restare espliciti.",
      ],
    },
  ];
}

function dogfoodTestPage(params: {
  sdkVersion: string;
  toolCount: number;
  indexedFiles: number;
  indexedFragments: number;
  codeQueries: number;
  codeResourcesRead: number;
  preliminaryLintClean: boolean;
  contextCoverageSufficient: boolean;
  contextEvidenceCount: number;
  contextGapCount: number;
  blockingContextGapCount: number;
  contextBudgets: readonly number[];
  contextResourceReads: number;
}): SelfWikiPage {
  return {
    path: "tests/Self_Dogfood_MCP2.md",
    title: TEST_TITLE,
    type: "test_result",
    tags: ["test", "dogfood", "mcp-2", "production"],
    authority: "test_evidence",
    body: [
      `Vedi [[${OVERVIEW_TITLE}]], [[Requisiti di produzione]] e [[Rischi e limiti operativi]].`,
      "",
      "## Esito",
      "",
      params.preliminaryLintClean && params.contextCoverageSufficient
        ? "PASS — la self-wiki è stata generata attraverso una sessione MCP moderna e ha superato i controlli preliminari."
        : "FAIL — almeno un requisito preliminare non è stato soddisfatto.",
      "",
      "## Protocollo osservato",
      "",
      `- SDK server: ${params.sdkVersion}`,
      `- Envelope: ${MODERN_PROTOCOL_VERSION}`,
      "- Era factory: modern",
      "- Richieste Roots: 0",
      "- Tool wiki_read_resource nel catalogo: assente",
      `- Tool moderni: ${params.toolCount}`,
      "",
      "## Evidence e retrieval",
      "",
      `- File codice indicizzati: ${params.indexedFiles}`,
      `- Frammenti codice indicizzati: ${params.indexedFragments}`,
      `- Query code evidence: ${params.codeQueries}`,
      `- Resource code materializzate: ${params.codeResourcesRead}`,
      `- Evidence wiki nel Task Context: ${params.contextEvidenceCount}`,
      `- Gap Task Context dichiarati: ${params.contextGapCount}`,
      `- Gap Task Context bloccanti: ${params.blockingContextGapCount}`,
      `- Budget Task Context attraversati: ${params.contextBudgets.join(" → ")}`,
      `- Resource wiki materializzate: ${params.contextResourceReads}`,
      `- Coverage Task Context sufficiente: ${params.contextCoverageSufficient}`,
      `- Lint preliminare pulito: ${params.preliminaryLintClean}`,
      "",
      "## Interpretazione",
      "",
      "La prova copre il percorso protocollare e operativo end-to-end sul repository reale. Non sostituisce load test concorrenti, eval di routing con provider LLM reali o validazione di OCR/embedding non configurati.",
    ],
  };
}

function reportMarkdown(metrics: Record<string, unknown>): string {
  return [
    "# Report di dogfood MCP 2.0 — KnowledgeRail",
    "",
    "## Esito esecutivo",
    "",
    metrics["productionReady"] === true
      ? "Il percorso locale verificato è pronto per l'uso produttivo controllato con MCP 2.0."
      : "Il percorso non soddisfa ancora tutti i requisiti di produzione.",
    "La conclusione richiede simultaneamente negoziazione moderna, assenza del tool di lettura legacy, lint pulito, coverage sufficiente e materializzazione delle evidence tramite resources/read. Un fallimento di uno solo di questi controlli interrompe lo script con exit code non-zero.",
    "",
    "## Protocollo verificato",
    "",
    `- SDK: ${String(metrics["sdkVersion"])}`,
    `- Protocollo: ${String(metrics["protocolVersion"])}`,
    `- Era: ${String(metrics["era"])}`,
    `- Tool moderni: ${String(metrics["toolCount"])}`,
    `- Roots richiesti: ${String(metrics["rootsRequests"])}`,
    `- Tool legacy esposti: ${String(metrics["legacyToolsExposed"])}`,
    "La factory è stata osservata durante l'esecuzione e ha creato esclusivamente l'era modern. Il client di prova ha inviato l'envelope 2026-07-28 a ogni richiesta; inoltre il server non ha richiesto Roots, capacità appartenente al percorso di compatibilità precedente.",
    "",
    "## Flusso dogfood",
    "",
    "```mermaid",
    "flowchart TD",
    "  A[server/discover moderno] --> B[8 tool di dominio]",
    "  B --> C[knowledge_code rebuild e query]",
    "  C --> D[knowledge_page write]",
    "  D --> E[knowledge_admin lint]",
    "  E --> F[knowledge_context compact]",
    "  F --> G[resources/read]",
    "  G --> H[write Markdown e review terminale]",
    "```",
    "Il flusso verifica in ordine discovery, guida, indicizzazione, memoria canonica, retrieval selettivo e deliverable.",
    "",
    "## Metriche",
    "",
    `- Pagine wiki: ${String(metrics["pageCount"])}`,
    `- File codice indicizzati: ${String(metrics["indexedFiles"])}`,
    `- Frammenti codice: ${String(metrics["indexedFragments"])}`,
    `- Resource code lette: ${String(metrics["codeResourcesRead"])}`,
    `- Evidence Task Context: ${String(metrics["contextEvidenceCount"])}`,
    `- Gap Task Context dichiarati: ${String(metrics["contextGapCount"])}`,
    `- Gap Task Context bloccanti: ${String(metrics["contextBlockingGapCount"])}`,
    `- Budget Task Context attraversati: ${(metrics["contextBudgets"] as number[]).join(" → ")}`,
    `- Resource wiki lette: ${String(metrics["contextResourcesRead"])}`,
    `- Coverage sufficiente: ${String(metrics["contextCoverageSufficient"])}`,
    `- Lint pulito: ${String(metrics["lintClean"])}`,
    `- Durata: ${String(metrics["durationMs"])} ms`,
    "",
    "## Limiti della conclusione",
    "",
    "Il test dimostra negoziazione moderna, workflow guidato, mutation, retrieval, resource link e pipeline documentale sul repository reale. Non misura concorrenza multi-client, routing di un provider LLM specifico, OCR o embedding remoti.",
  ].join("\n");
}

async function main(): Promise<void> {
  const startedAt = performance.now();
  const sdkPackage = JSON.parse(await fs.readFile(
    path.join(process.cwd(), "node_modules", "@modelcontextprotocol", "server", "package.json"),
    "utf8"
  )) as { version?: string };
  const sdkVersion = sdkPackage.version ?? "unknown";
  assert.equal(sdkVersion.split(".")[0], "2", `Expected MCP server SDK 2.x, found ${sdkVersion}.`);

  const harness = await createHarness();
  try {
    const discover = await harness.request("server/discover");
    assert.match(String(discover.instructions ?? ""), /knowledge_context mode=task/);
    assert.match(String(discover.instructions ?? ""), /nextAction/);
    assert.deepEqual(harness.eras, ["modern"], "The server factory must only instantiate the modern era.");

    const listed = await harness.request("tools/list");
    const tools = listed.tools as Array<{ name?: string }>;
    const toolNames = tools.map((tool) => tool.name).filter((name): name is string => Boolean(name));
    assert.equal(toolNames.length, EXPECTED_MODERN_TOOL_COUNT);
    assert.equal(toolNames.includes("knowledge_menu"), false);
    assert.equal(toolNames.includes("knowledge_context"), true);
    assert.equal(toolNames.includes("knowledge_ingest"), true);
    assert.equal(toolNames.includes("wiki_menu"), false);
    assert.equal(toolNames.includes("wiki_read_resource"), false, "Legacy read tool leaked into MCP 2.0.");

    const prompts = await harness.request("prompts/list");
    const resources = await harness.request("resources/list");
    const resourceTemplates = await harness.request("resources/templates/list");
    assert.equal((prompts.prompts as unknown[]).length, 3);
    assert.equal((resources.resources as unknown[]).length, 2);
    assert.equal((resourceTemplates.resourceTemplates as unknown[]).length, 2);

    const initialized = await harness.callTool("knowledge_admin", { action: "init", force: false });
    assert.equal((initialized.structuredContent?.nextAction as { tool?: string }).tool, "knowledge_context");
    await harness.callTool("knowledge_admin", { action: "lint" });

    const rebuilt = await harness.callTool("knowledge_code", { action: "rebuild" }, 120_000);
    assert.equal((rebuilt.structuredContent?.nextAction as { action?: string }).action, "status");
    const update = rebuilt.structuredContent?.update as {
      scannedFiles: number;
      fragmentCount: number;
    };
    assert.ok(update.scannedFiles > 0);
    assert.ok(update.fragmentCount > 0);
    const codeStatus = await harness.callTool("knowledge_code", { action: "status" });
    const status = codeStatus.structuredContent?.status as {
      indexedFiles: number;
      indexedFragments: number;
      recordedGrepFallbacks: number;
    };
    assert.equal(status.recordedGrepFallbacks, 0);

    const codeQueries = [
      "MCP server domain tools nextAction protocol modern",
      "hybrid retrieval progressive widening task context",
      "source coverage Evidence IR synthesis",
      "code evidence index resource reader",
      "Markdown document review diagram evidence assets",
      "workspace path validation migration security",
    ];
    const codeResourceUris = new Set<string>();
    for (const query of codeQueries) {
      const found = await harness.callTool("knowledge_code", {
        action: "search",
        query,
        max_results: 8,
      });
      const links = resourceLinks(found);
      assert.ok(links.length > 0, `No code evidence for query: ${query}`);
      codeResourceUris.add(links[0]!);
    }
    let codeResourcesRead = 0;
    for (const uri of codeResourceUris) {
      const read = await harness.request("resources/read", { uri });
      assert.ok(Array.isArray(read.contents) && read.contents.length > 0);
      codeResourcesRead++;
    }
    assert.ok(codeResourcesRead >= 4);

    const initialTestPage = dogfoodTestPage({
      sdkVersion,
      toolCount: toolNames.length,
      indexedFiles: status.indexedFiles,
      indexedFragments: status.indexedFragments,
      codeQueries: codeQueries.length,
      codeResourcesRead,
      preliminaryLintClean: true,
      contextCoverageSufficient: true,
      contextEvidenceCount: 0,
      contextGapCount: 0,
      blockingContextGapCount: 0,
      contextBudgets: [2_000],
      contextResourceReads: 0,
    });
    const pages = [...selfWikiPages(), initialTestPage];
    for (const page of pages) {
      await harness.callTool("knowledge_page", {
        action: "write",
        path: page.path,
        content: pageMarkdown(page, date),
      });
    }

    const preliminaryLint = await harness.callTool("knowledge_admin", { action: "lint" });
    const preliminaryLintText = textContent(preliminaryLint);
    const preliminaryLintClean = preliminaryLintText.includes("Nessun problema trovato");
    assert.equal(preliminaryLintClean, true, preliminaryLintText);

    const contextArgs = {
      mode: "task",
      intent: "review",
      objective: "Valutare la readiness produttiva MCP 2.0 di KnowledgeRail",
      query: "MCP 2.0 produzione protocollo moderno test rischi requisiti sicurezza workflow",
      max_evidence: 12,
      heuristic_token_budget: 2_000,
      response_detail: "compact",
    };
    let context = await harness.callTool("knowledge_context", contextArgs);
    let contextStructured = context.structuredContent as {
      evidence?: unknown[];
      gaps?: Array<Record<string, unknown>>;
      retrieval?: { coverageSufficient?: boolean; evidenceGaps?: string[] };
      nextAction?: {
        tool?: string;
        suggestedArguments?: { heuristic_token_budget?: number };
      } | null;
    };
    const contextBudgets = [2_000];
    const materializedWikiUris = new Set<string>();
    let contextResourceReads = 0;
    let contextCoverageSufficient = false;
    let blockingContextGaps: Array<Record<string, unknown>> = [];

    for (;;) {
      const wikiResourceUris = resourceLinks(context);
      assert.ok(wikiResourceUris.length > 0);
      for (const uri of wikiResourceUris.slice(0, 3)) {
        if (materializedWikiUris.has(uri)) continue;
        const read = await harness.request("resources/read", { uri });
        assert.ok(Array.isArray(read.contents) && read.contents.length > 0);
        materializedWikiUris.add(uri);
        contextResourceReads++;
      }

      blockingContextGaps = (contextStructured.gaps ?? []).filter((gap) =>
        gap.kind === "missing_evidence" ||
        gap.kind === "stale_evidence" ||
        gap.kind === "budget_limited"
      );
      const observedEvidenceGaps = [...new Set([
        ...(contextStructured.retrieval?.evidenceGaps ?? []),
        ...blockingContextGaps.map((gap) =>
          `${String(gap.kind ?? "unknown")}: ${String(gap.description ?? "unspecified gap")}`.slice(0, 256)
        ),
      ])];
      contextCoverageSufficient =
        contextStructured.retrieval?.coverageSufficient === true &&
        observedEvidenceGaps.length === 0;
      if (contextCoverageSufficient) break;
      assert.equal(contextStructured.nextAction?.tool, "knowledge_context");
      const nextBudget = contextStructured.nextAction?.suggestedArguments?.heuristic_token_budget;
      assert.ok(
        nextBudget && nextBudget > contextBudgets.at(-1)! && nextBudget <= 12_000,
        `Task Context returned no valid bounded widening after ${contextBudgets.at(-1)} tokens.`
      );
      contextBudgets.push(nextBudget);
      context = await harness.callTool("knowledge_context", {
        ...contextArgs,
        retrieval_profile: "coverage",
        heuristic_token_budget: nextBudget,
      });
      contextStructured = context.structuredContent as typeof contextStructured;
    }
    assert.deepEqual(blockingContextGaps, []);

    const finalTestPage = dogfoodTestPage({
      sdkVersion,
      toolCount: toolNames.length,
      indexedFiles: status.indexedFiles,
      indexedFragments: status.indexedFragments,
      codeQueries: codeQueries.length,
      codeResourcesRead,
      preliminaryLintClean,
      contextCoverageSufficient,
      contextEvidenceCount: contextStructured.evidence?.length ?? 0,
      contextGapCount: contextStructured.gaps?.length ?? 0,
      blockingContextGapCount: blockingContextGaps.length,
      contextBudgets,
      contextResourceReads,
    });
    await harness.callTool("knowledge_page", {
      action: "write",
      path: finalTestPage.path,
      content: pageMarkdown(finalTestPage, date),
    });

    const finalLint = await harness.callTool("knowledge_admin", { action: "lint" });
    const finalLintText = textContent(finalLint);
    const lintClean = finalLintText.includes("Nessun problema trovato");
    assert.equal(lintClean, true, finalLintText);
    const rootsRequests = harness.serverRequests.filter((request) => request.method === "roots/list").length;
    assert.equal(rootsRequests, 0, "MCP 2.0 dogfood must never negotiate legacy Roots.");
    assert.deepEqual(harness.eras, ["modern"]);

    const metrics: Record<string, unknown> = {
      productionReady: true,
      sdkVersion,
      protocolVersion: MODERN_PROTOCOL_VERSION,
      era: harness.eras[0],
      toolCount: toolNames.length,
      legacyToolsExposed: toolNames.filter((name) => name === "wiki_read_resource").length,
      rootsRequests,
      promptCount: (prompts.prompts as unknown[]).length,
      staticResourceCount: (resources.resources as unknown[]).length,
      resourceTemplateCount: (resourceTemplates.resourceTemplates as unknown[]).length,
      pageCount: pages.length,
      indexedFiles: status.indexedFiles,
      indexedFragments: status.indexedFragments,
      codeQueryCount: codeQueries.length,
      codeResourcesRead,
      contextEvidenceCount: contextStructured.evidence?.length ?? 0,
      contextGapCount: contextStructured.gaps?.length ?? 0,
      contextBlockingGapCount: blockingContextGaps.length,
      contextGaps: contextStructured.gaps ?? [],
      contextBudgets,
      contextResourcesRead: contextResourceReads,
      contextCoverageSufficient,
      lintClean,
      grepFallbackCount: status.recordedGrepFallbacks,
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
    };

    await harness.callTool("knowledge_document_context", {
      action: "plan",
      document_type: "custom",
      project_name: "KnowledgeRail",
      objective: "Registrare il dogfood MCP 2.0",
      audience: "maintainer",
    });
    await harness.callTool("knowledge_document_context", {
      action: "section",
      section_title: "Readiness produttiva MCP 2.0",
      document_type: "custom",
      query: "protocollo moderno requisiti test rischi produzione",
      page_paths: [
        "requirements/Production_Readiness.md",
        "tests/Self_Dogfood_MCP2.md",
        "risks/Production_Risks_And_Limits.md",
      ],
      max_pages: 8,
      heuristic_token_budget: 4_000,
    });
    await harness.callTool("knowledge_document", {
      action: "write",
      filename: "knowledge-rail_mcp2_dogfood_report.md",
      title: "Report di dogfood MCP 2.0 — KnowledgeRail",
      document_type: "custom",
      diagram_mode: "mermaid",
      content: reportMarkdown(metrics),
      overwrite: true,
    });
    const review = await harness.callTool("knowledge_document", {
      action: "review",
      filename: "knowledge-rail_mcp2_dogfood_report.md",
      document_type: "custom",
      diagram_mode: "mermaid",
      language: "italiano",
      client_facing: false,
      include_wiki_update_plan: false,
    });
    const reviewText = textContent(review);
    assert.match(reviewText, /^- \*\*INFO NESSUN_BLOCCANTE:/m);
    assert.doesNotMatch(reviewText, /^- \*\*(?:BLOCKER|WARNING) /m);
    assert.equal(review.structuredContent?.readyForDelivery, true);
    assert.equal(review.structuredContent?.nextAction, null);
    assert.match(String(review.structuredContent?.contentSha256), /^[a-f0-9]{64}$/);

    process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
  } finally {
    await harness.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
