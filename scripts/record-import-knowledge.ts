import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { codeResourceUri, PersistentCodeEvidenceIndex } from "../src/core/code-evidence/index.js";
import { readCodeResource } from "../src/core/code-evidence/resource-reader.js";
import { detectCodeDrift } from "../src/core/drift-detection.js";
import { recordEvidenceClaims } from "../src/core/ingestion/evidence-pipeline.js";
import { resolveEvidenceClaims } from "../src/core/ingestion/evidence-linker.js";
import { sourceCompilePlan } from "../src/core/ingestion/source-compiler.js";
import { applyEvidenceSynthesis } from "../src/core/ingestion/evidence-synthesis.js";
import { compileTaskContext } from "../src/context/task-context-compiler.js";
import { setWikiRoot } from "../src/core/paths.js";
import { ensureWikiStructure } from "../src/core/wiki-structure-service.js";
import { finalizePageMutation } from "../src/tools/helpers.js";
import { evidenceClaimId, type EvidenceClaimInput } from "../src/core/ingestion/evidence-claim.js";
import { readEvidenceIrStore } from "../src/core/ingestion/evidence-store.js";

// Project-specific, reviewable source facts. Every technical claim names an
// indexed symbol; captureCodeAnchor supplies the current range/hash automatically.
const notes = [
  ["WorkspaceMemory", "Memoria dei workspace sul computer locale", "src/core/workspace-state.ts", "registerWorkspaceState",
    "registerWorkspaceState e touchWorkspaceState gestiscono l'ordine LRU delle cache condivise del workspace. Il default conserva cinque workspace, in linea con il perimetro attuale di uno/cinque progetti sul Mac disponibile. Aprire un altro progetto rilascia gli stati della cache meno recente attraverso i disposer; non elimina gli indici persistiti o la knowledge. La riapertura recupera le stesse evidenze. KNOWLEDGE_RAIL_WORKSPACE_STATE_CAP mantiene l'override esplicito. Il tetto riguarda gli stati trattenuti da un processo, non tutta la sua RAM o il numero di repository registrabili."],
  ["KnowledgeResources", "Risorse delle evidenze documentali", "src/tools/resources.ts", "registerWikiResources",
    "registerWikiResources espone pagine wiki intere e passaggi identificati dal contenuto per requisiti, decisioni, incidenti e altre evidenze documentali. Entrambe le forme riusano il lettore confinato e limitato a 6000 caratteri, con segnalazione del troncamento; il link di pagina non richiede passage. I template separati consentono il routing MCP anche con workspace_binding nel desktop, mantenendo provenienza e isolamento tra progetti. Queste evidenze non richiedono Salesforce o un anchor di codice della fonte documentale."],
  ["ImportRuntime", "Import runtime e adapter", "src/core/code-evidence/import-resolution/diagnostics.ts", "ImportResolutionCollector",
    "ImportResolutionCollector conta esiti una volta per file/specifier e generazione. Platform ed external_dependency sono separati dagli unresolved; not_indexed richiede un path relativo verificato e unsupported_syntax registra forme non valutate. Il campione conserva dodici esempi, priorità alle ambiguità e poi alle cause azionabili, quattro candidati per esempio. Contatori per lingua e causa sono inventario, distinti dal denominatore pubblico richieste/fallback. Namespace espliciti possono contenere più file; un nome singolo duplicato non genera un arco certo."],
  ["ImportRuntime", "Import runtime e adapter", "src/core/code-evidence/query-runtime.ts", "CodeQueryRuntime",
    "CodeQueryRuntime costruisce una volta per generazione gli archi import e i riferimenti dichiarati. Gli adapter forniscono createImportResolver e createReferenceResolver; il runtime verifica i percorsi nell'inventario, elimina doppioni e conserva precedenza call/reference/import, filtri e ordine. I nomi database usati dentro un modulo fisico non sono alias del file: rimangono dati di evidenza, senza creare archi da altri file che condividono quei nomi. Gli alias delle entità nominate restano disponibili. Query concorrenti condividono caricamento e preparazione anche se lo snapshot supera il budget. I path degli import non indicizzati, compreso il risultato vuoto, sono riusati entro 1 MiB del budget esistente; aggiornamento esplicito ed eviction invalidano la generazione. Normalizzazione dei nomi e risoluzione dei riferimenti dichiarati ripetuti sono memoizzate solo durante la costruzione; le mappe temporanee non restano in cache. Letture indipendenti di manifest e import non indicizzati si sovrappongono e vengono entrambe completate prima di propagare un errore. Errori di preparazione consentono un nuovo tentativo."],
  ["ImportRuntime", "Import runtime e adapter", "src/core/code-evidence/source-metadata.ts", "prepareSourceMetadata",
    "prepareSourceMetadata acquisisce i companion dichiarati dagli adapter durante rebuild, update e remove espliciti, sotto il lock dell'indice e con pubblicazione atomica nello snapshot v2. Il contratto è indipendente dal linguaggio: è verificato anche con un adapter TypeScript senza Salesforce. La proiezione include versione di arricchimento, roster, dipendenze e warning; le query la riusano dopo riavvio. Cambi al solo metadata conservano ID, fingerprint e anchor del codice. L'adapter Apex applica il proprio stato di deployment soltanto alle estensioni dichiarate, conservando i metadati degli altri linguaggi; lo elimina se il companion Apex manca o è invalido. Anche update con sorgente invariato aggiorna i companion. Snapshot precedenti o proiezioni incompatibili usano il lettore confinato in memoria, senza migrazioni attivate dalle query. La preparazione attuale verifica i companion della generazione: il costo di aggiornamento va contato separatamente."],
  ["ImportRuntime", "Import runtime e adapter", "src/core/code-evidence/index.ts", "readCodeResourceRecords",
    "readCodeResourceRecords riusa la generazione validata della cache per materializzare evidenze di tutte le famiglie supportate. Controlla l'identità dello snapshot e restituisce record scollegati dagli oggetti interni; non ripara indici corrotti. Il lettore della risorsa continua a leggere il sorgente e confrontarne l'hash a ogni richiesta. Modifiche del codice, sostituzione dello snapshot ed eviction non possono essere nascoste dal riuso. Il riuso rispetta il budget del workspace; gli snapshot non ammessi continuano a richiedere caricamento."],
  ["ImportRuntime", "Import runtime e adapter", "src/core/code-evidence/index.ts", "PersistentCodeEvidenceIndex",
    "PersistentCodeEvidenceIndex riusa runtime e strutture dichiarate per generazione e registry. Lo schema resta v2 con campi opzionali; cambiano i parser JS/TS v6, Apex v2, sfmeta v2 e Rust v2 per i nuovi dati di estrazione. Un rebuild aggiorna selettivamente gli adapter modificati; gli anchor storici mantengono la versione originale. La cache per progetto ha un limite stimato di 64 MiB. Metadata e lettore manifest compatti possono sopravvivere a uno snapshot non ammesso, entro 1 MiB e lo stesso budget, con invalidazione esplicita della generazione. I postings con soli ordinali possono essere conservati entro 16 MiB, senza trattenere frammenti e sempre dentro il limite totale; modifiche ai manifest li invalidano."],
  ["ImportRuntime", "Import runtime e adapter", "src/core/code-evidence/project-structure.ts", "ProjectStructureReader",
    "ProjectStructureReader legge manifest dichiarati e confinati al repository, senza eseguire build. Ogni file ha limite 256 KiB e ogni dichiarazione 32 riferimenti diretti. Workspace e build espliciti possono seguire fino a otto livelli e 256 riferimenti; i glob semplici hanno enumerazione limitata senza seguire dipendenze installate. Le query ricontrollano manifest noti; nuovi confini annidati, membri glob e sidecar Apex richiedono update o rebuild. I cambi ai manifest ricostruiscono gli archi senza riestrarre i sorgenti."],
  ["ImportDeclarations", "Import Java Kotlin CSharp PHP", "src/core/code-evidence/import-resolution/declarations.ts", "createDeclarationImportResolver",
    "Java, Kotlin e PHP risolvono gli import tramite qualifiedName delle dichiarazioni, indipendentemente da source root e nome del file. Java/Kotlin condividono le dichiarazioni dei due linguaggi; import static risolve la classe proprietaria. Overload e nomi duplicati tra moduli Gradle restano ambigui, senza inferire dipendenze del build. PHP distingue classi, funzioni e costanti, anche in gruppi misti e namespace multipli con HTML interleaved."],
  ["ImportDeclarations", "Import Java Kotlin CSharp PHP", "src/core/code-evidence/import-resolution/declarations.ts", "createDeclarationImportResolver",
    "C# using Acme.Orders importa un namespace: l'evidenza comprende i file che vi dichiarano tipi, anche se sono più di uno. Namespace annidati e file-scoped conservano i nomi completi. Parti partial compatibili si uniscono soltanto con lo stesso confine csproj; progetti concorrenti restano ambigui. Directory.Build.props può fornire un confine condiviso e Compile Remove letterali esclude file; Condition e MSBuild non sono eseguiti. Le wildcard Java/Kotlin rappresentano gruppi analoghi. Questi archi descrivono l'ambito importato, non dimostrano quali classi vengano eseguite."],
  ["ImportPaths", "Import Python JavaScript header C Cpp", "src/core/code-evidence/import-resolution/python.ts", "createPythonImportResolver",
    "Python risolve package e stub da root dichiarate setuptools, Poetry, Hatch, Flit e PDM, oltre alla directory di script e ai package regolari verificati. Namespace impliciti e sys.path dinamico restano fuori contratto. Test esterni raggiungono soltanto layout supportati e dichiarati; la selezione implicita di Hatch resta non modellata. Backend in conflitto non producono root, ma mantengono gli import interni a package verificati."],
  ["ImportPaths", "Import Python JavaScript header C Cpp", "src/core/code-evidence/import-resolution/python-config.ts", "pythonDeclaredNames",
    "pythonDeclaredNames normalizza mapping setuptools e backend Python nello stesso indice di nomi: Poetry include/from, Hatch wheel packages/sources, Flit nome modulo e layout flat/src, PDM package-dir/includes. Richiede package regolari indicizzati e mantiene separati confini annidati; i cambi ai manifest invalidano i mapping senza riestrazione."],
  ["ImportPaths", "Import Python JavaScript header C Cpp", "src/core/code-evidence/manifest-toml.ts", "parseManifestToml",
    "Il parser TOML comune supporta tabelle, chiavi quoted e dotted, stringhe, array, tabelle inline e scalari con limiti di profondità e nodi. La proiezione Python/Cargo valida solo i campi pertinenti, saltando valori e tool estranei; confini lessicali ambigui o root selezionate malformate restano errori. Non esegue manifest; il lettore mantiene il limite di 256 KiB e il budget del workspace."],
  ["ImportPaths", "Import Python JavaScript header C Cpp", "src/core/code-evidence/import-resolution/ruby.ts", "createRubyImportResolver",
    "Ruby risolve require_relative dalla directory del chiamante. require usa require_paths ordinati della gemspec e gemme locali dichiarate con Gemfile path. Mutazioni, condizioni, manifest concorrenti e percorsi esterni non inventano root. Le dipendenze esterne dichiarate sono classificate senza caricarle; require_relative resta indipendente dagli errori della gemspec."],
  ["ImportDeclarations", "Import Java Kotlin CSharp PHP", "src/core/code-evidence/import-resolution/php-config.ts", "createPhpImportResolver",
    "Composer legge autoload e autoload-dev con PSR-4, PSR-0, classmap, files ed esclusioni letterali. Verifica la corrispondenza namespace e path, rispetta i tipi di simbolo e separa i progetti annidati. I pattern classmap sono compilati una volta e riusano un matcher limitato senza backtracking, condiviso con Python. Nessuna esecuzione di Composer o caricamento di dipendenze installate."],
  ["CodeKnowledgeLinks", "Knowledge con riferimenti diretti al codice", "src/core/code-evidence/request-telemetry.ts", "codeRequestSummary",
    "Le risposte pubbliche symbol/search/references forniscono requestId. record_fallback può collegarlo tramite request_id; i conteggi separano linguaggi, richieste vuote, duplicati ed eventi non collegabili. Il tasso è fallback distinti collegati diviso risposte servite. Admin status e report locale espongono un aggregato senza query o path; la finestra comprende 512 richieste e il file atomico ha limite 256 KiB, senza cache permanente né fsync per richiesta. Un file vuoto, troncato o incoerente viene archiviato sotto lock e apre un nuovo periodo di conteggio; status espone recovery e startedAt, senza mescolare i vecchi ID. Formati futuri, symlink esterni e errori IO non vengono azzerati. Non misura fallback non dichiarati o tassi utenti storici."],
  ["ImportPaths", "Import Python JavaScript header C Cpp", "src/core/code-evidence/import-resolution/javascript.ts", "createJavaScriptImportResolver",
    "JavaScript e TypeScript risolvono import relativi con estensioni esplicite, sostituzioni runtime/source e index di directory; il file esatto .js precede il fallback .ts e il case dei percorsi resta significativo. Gli alias paths e baseUrl provengono dal tsconfig o jsconfig più vicino. Pattern esatti e prefissi più lunghi precedono quelli generici; target alternativi seguono l'ordine dichiarato, ma candidati ambigui non diventano archi certi."],
  ["ImportPaths", "Import Python JavaScript header C Cpp", "src/core/code-evidence/import-resolution/javascript-config.ts", "importConfig",
    "JS/TS accetta JSON con commenti e virgole finali e un livello di extends locale. Le opzioni conservano la directory di origine; paths del figlio sostituisce la mappa ereditata. Project references e membership include/exclude/files selezionano il proprietario tra config antenati scoperti; sovrapposizioni sono ambigue. Package exports/imports e workspace locali hanno resolver separato condiviso. rootDir e alias bundler non diventano root inferite."],
  ["ImportPaths", "Import Python JavaScript header C Cpp", "src/core/code-evidence/import-resolution/c-family.ts", "createCImportResolver",
    "C/C++ cerca header quotati prima accanto al sorgente, poi nei percorsi letterali della compilation database o di CMake. CMake supporta set letterali, root di progetto e add_subdirectory; dichiarazioni indipendenti valide sopravvivono agli errori di un altro target. Root globali sconosciute che possono fare shadowing bloccano lo scope con avviso. Non vengono eseguiti build tool né dedotti include angle o header esterni."],
  ["ImportGoRust", "Import package Go e moduli Rust", "src/core/code-evidence/import-resolution/go.ts", "createGoImportResolver",
    "Go rispetta module identity, go.work use e replace verso directory locali. Workspace e sostituzioni non rendono importabili moduli nascosti o nomi diversi da quelli dichiarati; sostituzioni concorrenti restano ambigue. _test.go è escluso. Senza go.mod resta il fallback suffix diagnosticato. Vendor e build tag non sono valutati."],
  ["ImportGoRust", "Import package Go e moduli Rust", "src/core/code-evidence/import-resolution/rust.ts", "createRustImportResolver",
    "Rust combina root Cargo e glob semplici dei workspace con mod dichiarati, path letterali e candidati cfg non valutati. I moduli emettono import e i path espliciti sostituiscono quelli convenzionali. Re-export pub use univoci sono seguiti per un livello; catene, macro e cfg_attr dinamici non inventano target. Dipendenze esterne sono classificate separatamente; errori indipendenti non cancellano root valide."],
  ["ImportSalesforce", "Salesforce Apex metadata e LWC", "src/core/code-evidence/import-resolution/salesforce.ts", "createSalesforceImportResolver",
    "LWC risolve Apex, schema oggetti/campi, label, static resource, message channel e bundle c locali soltanto verso file indicizzati. sfdx-project.json dichiara package directory e confini annidati. Bundle duplicati restano ambigui. Resolver import e reference condividono nomi e appartenenza preparati per la stessa struttura; ogni resolver conserva la propria callback diagnostica. Le strutture condivise contengono stringhe, non frammenti o callback. Le famiglie di moduli di piattaforma hanno conteggio separato e non riempiono gli unresolved; namespace non modellati restano irrisolti."],
  ["ImportSalesforce", "Salesforce Apex metadata e LWC", "src/core/code-evidence/sfmeta-adapter.ts", "SalesforceMetadataKnowledgeAdapter",
    "SalesforceMetadataKnowledgeAdapter estrae entità SFDX e attributi letterali controller/extensions di Visualforce e Aura. I trigger producono reference dichiarate verso il metadata oggetto; i riferimenti SOQL restano distinti. Sidecar Apex espongono stato Active, Inactive o Deleted senza rimuovere evidenza; update esplicito invalida lo stato. Template LWC HTML ed espressioni dinamiche restano fuori inventario. Telemetria e roster usano la stessa fonte."],
  ["CodeKnowledgeLinks", "Knowledge con riferimenti diretti al codice", "src/core/ingestion/evidence-synthesis.ts", "renderClaim",
    "Una pagina knowledge deve citare il codice quando la spiegazione riguarda una classe, un metodo o una regola implementata. Evidence IR conserva codeResourceUri e codeAnchor verificato; renderClaim mostra il link code://repo con percorso e righe. Una nota non tecnica o un target non risolto non riceve un riferimento inventato."],
  ["CodeKnowledgeLinks", "Knowledge con riferimenti diretti al codice", "src/core/ingestion/evidence-pipeline.ts", "recordEvidenceClaims",
    "Per registrare evidenze tecniche si passa target.codeResourceUri a recordEvidenceClaims: il servizio aggiorna solo i file interessati e cattura range, hash e versione del parser. Un solo refresh snapshot/manifest serve tutti i claim eleggibili del gruppo. La risposta propone al massimo otto vicini diretti call/import, con direzione e code URI: sono candidati da materializzare e accettare esplicitamente, senza nuove relazioni o claim automatici. Il drift verifica le evidenze aggiornate; call resta un indizio lessicale."],
  ["CodeKnowledgeLinks", "Knowledge con riferimenti diretti al codice", "src/core/drift-detection.ts", "staleClaimsByPage",
    "Il registro drift conserva anche gli anchor storici. staleClaimsByPage consulta lo stato corrente dei claim e non marca obsoleta una pagina soltanto per evidenze superseded, anche se la supersessione è successiva al controllo drift. Claim attivi, ambigui o contraddetti continuano a segnalare drift. Con un registro vuoto o interamente fresco non viene letto lo store delle evidenze."],
  ["CodeKnowledgeLinks", "Knowledge con riferimenti diretti al codice", "src/context/task-context-compiler.ts", "compileTaskContext",
    "knowledge_context accetta changed_paths con file sorgenti relativi al repository, oltre ai percorsi wiki. I path sorgenti espliciti nel testo della task e i claim attivi selezionati negli intenti di impatto possono produrre codeRoots e codeRelations. Il contesto resta di sola lettura: se l'indice codice manca o è incompatibile, espone un GAP e richiede refresh esplicito. L'aggiunta dei candidati rispetta il budget tramite selezione di prefissi, senza rendere il codice prova di copertura documentale."],
  ["CodeKnowledgeLinks", "Knowledge con riferimenti diretti al codice", "src/context/code-impact.ts", "expandCodeImpact",
    "expandCodeImpact riusa il runtime codice e le associazioni claim-pagina del controllo drift. Espone al massimo tre radici, dodici candidati entranti per radice e sei pagine wiki correlate tramite claim attivi; il budget token può ridurli ulteriormente. codeSnapshot indica la generazione indicizzata, non una verifica del sorgente corrente. I collegamenti call/reference sono lessicali e gli import mantengono i limiti degli adapter: materializzare solo risorse pertinenti, verificare il codice e non dedurre assenza di utilizzo da un risultato vuoto."],
  ["CodeKnowledgeLinks", "Knowledge con riferimenti diretti al codice", "src/core/retrieval-selection.ts", "selectLexicalEvidence",
    "selectLexicalEvidence omette candidati lessicali subordinati solo sotto metà dei segnali della domanda, quando una pagina precedente dello stesso tipo li copre tutti e ne aggiunge altri. Il denominatore comprende facet ed entità anche assenti dal pool. Una pagina specifica con almeno metà dei segnali resta eleggibile, entro i budget ordinari. Semantica, grafo, traceability, diversità, contraddizioni e tipi espliciti mantengono selezione ed espansione; i GAP usano il pool completo. Il test panoramica/dettaglio copre tre profili. Sotto soglia resta il rischio di omettere dettagli utili; non è stabilità generale."],
] as const;

const repositoryRoot = process.cwd();
const wikiRoot = path.join(repositoryRoot, "wiki");
setWikiRoot(repositoryRoot);
await ensureWikiStructure();
const index = new PersistentCodeEvidenceIndex({ repositoryRoot, wikiRoot });
await index.rebuild();
const snapshot = await index.snapshot();
const sourceUri = "docs/normalized/import-evidence-2.7.4.md";
const sourceContent = `# Import evidence e retrieval del codice — stato 2.8.x\n\n${notes.map((note) => note[4]).join("\n\n")}\n`;
await fs.mkdir(path.dirname(path.join(repositoryRoot, sourceUri)), { recursive: true });
await fs.writeFile(path.join(repositoryRoot, sourceUri), sourceContent);
const plan = await sourceCompilePlan({ wikiRoot, sourceUri, content: sourceContent, segmentMaxChars: 32_768 });
assert.equal(plan.ledger.segments.length, 1);
const previous = await readEvidenceIrStore(wikiRoot);
const claims: EvidenceClaimInput[] = notes.map(([page, title, file, symbol, text]) => {
  const fragment = snapshot.fragments.find((fragment) => fragment.path === file && fragment.symbol === symbol);
  assert.ok(fragment, `Missing code anchor ${file}#${symbol}`);
  const id = evidenceClaimId({ sourceUri, segmentId: plan.ledger.segments[0]!.id, text, kind: "behavior", origin: "explicit" });
  const uniqueSlot = notes.filter((note) => note[0] === page && note[2] === file).length === 1;
  // This script owns these source facts. Explicitly supersede their older
  // revisions; never rewrite or recapture unrelated historical claims.
  const replaced = previous.claims.filter((claim) => claim.id !== id && claim.sourceUri === sourceUri &&
    claim.target?.pagePath === `implementations/${page}.md` && claim.codeAnchor?.path === file &&
    (claim.text === text || uniqueSlot || (file.endsWith("/declarations.ts") &&
      ["Java, Kotlin e PHP ", "C# using Acme.Orders "].some((prefix) => text.startsWith(prefix) && claim.text.startsWith(prefix)))));
  return {
    text, kind: "behavior", origin: "explicit", confidence: 1,
    target: { pagePath: `implementations/${page}.md`, pageTitle: title, pageType: "implementation", codeResourceUri: codeResourceUri(fragment) },
    relations: replaced.map((claim) => ({ type: "supersedes", targetClaimId: claim.id })),
  };
});
const recorded = await recordEvidenceClaims({ wikiRoot, sourceUri, sourceContent, segmentId: plan.ledger.segments[0]!.id, claims });
assert.deepEqual(recorded.anchorWarnings, []);
assert.equal(recorded.claims.filter((claim) => claim.codeAnchor).length, notes.length);
const claimIds = recorded.claims.map((claim) => claim.id);
await resolveEvidenceClaims({ wikiRoot, claimIds });
const pages = await applyEvidenceSynthesis({ wikiRoot, claimIds });
await finalizePageMutation(pages.map((page) => page.pagePath));
const drift = await detectCodeDrift({ repositoryRoot, wikiRoot, paths: [...new Set(notes.map((note) => note[2]))], writeLedger: true });
const currentIds = new Set(claimIds);
const currentDrift = drift.entries.filter((entry) => currentIds.has(entry.claimId));
assert.equal(currentDrift.length, notes.length);
assert.ok(currentDrift.every((entry) => entry.verdict === "fresh"));
let resourcesRead = 0;
const queries = [];
for (const page of pages) {
  const relevant = notes.filter((note) => page.pagePath === `implementations/${note[0]}.md`);
  const query = `${relevant[0]![1]} ${relevant[0]![3]}`;
  const started = performance.now();
  const context = await compileTaskContext({ wikiRoot, intent: "understand", objective: query, query, maxEvidence: 4, heuristicTokenBudget: 2_000 });
  const retrieved = context.evidence.find((evidence) => evidence.path === page.pagePath);
  assert.ok(retrieved, `Retrieval missed ${page.pagePath}`);
  assert.notEqual(retrieved.stale, true, `Current knowledge marked stale: ${page.pagePath}`);
  const retrievedPage = await fs.readFile(path.join(wikiRoot, page.pagePath), "utf8");
  const pageClaims = recorded.claims.filter((claim) => claim.target?.pagePath === page.pagePath);
  const links = pageClaims.map((claim) => {
    const block = retrievedPage.split(`### ${claim.kind}: ${claim.id}\n`)[1]?.split("\n### ")[0];
    assert.ok(block?.includes(`](<${claim.target!.codeResourceUri!}>)`), `Missing current claim code link: ${claim.id}`);
    return claim.target!.codeResourceUri!;
  });
  assert.equal(links.length, relevant.length);
  for (const uri of links) {
    const code = await readCodeResource({ repositoryRoot, wikiRoot, resourceUri: uri, maxCharacters: 2_000 });
    assert.ok(relevant.some((note) => note[2] === code.path && note[3] === code.symbol));
    assert.ok(code.endLine > code.startLine, `Code link must include a body: ${uri}`);
    if (code.kind === "function") {
      assert.match(code.text, /\n {2}(?:const|let|if|for|return|await)\b/u, `Function link must expose implementation statements: ${uri}`);
    }
    resourcesRead++;
  }
  queries.push({ query, page: page.pagePath, directCodeLinks: links.length, elapsedMs: performance.now() - started });
}
const impact = await compileTaskContext({ wikiRoot, intent: "modify", objective: "Verificare l'impatto dell'espansione dei riferimenti nel contesto",
  changedPaths: ["src/context/code-impact.ts"], maxEvidence: 2, heuristicTokenBudget: 6_000 });
assert.ok(impact.changeImpact.codeRoots?.some((root) => root.path === "src/context/code-impact.ts"));
assert.ok(impact.changeImpact.codeRelations?.some((relation) => relation.path === "src/context/task-context-compiler.ts"));
assert.ok(impact.budget.withinHeuristicBudget);
let impactResourcesRead = 0;
for (const ref of [...impact.changeImpact.codeRoots!, ...impact.changeImpact.codeRelations!]) {
  const code = await readCodeResource({ repositoryRoot, wikiRoot, resourceUri: ref.uri, maxCharacters: 1_000 });
  assert.equal(code.path, ref.path);
  impactResourcesRead++;
}
const report = { pages: pages.map((page) => page.pagePath), claims: claimIds.length, anchoredClaims: recorded.claims.filter((claim) => claim.codeAnchor).length, resourcesRead,
  impact: { roots: impact.changeImpact.codeRoots!.length, relations: impact.changeImpact.codeRelations!.length,
    relatedWikiPages: impact.changeImpact.codeWikiPages!.length, resourcesRead: impactResourcesRead,
    heuristicTokens: impact.size.heuristicTokens, withinBudget: impact.budget.withinHeuristicBudget },
  currentAnchorsFresh: currentDrift.length, otherAnchorsRequiringReview: drift.entries.filter((entry) => !currentIds.has(entry.claimId) && entry.verdict !== "fresh").length,
  drift: drift.summary, queries };
await fs.mkdir(path.join(repositoryRoot, "benchmarks/results"), { recursive: true });
await fs.writeFile(path.join(repositoryRoot, "benchmarks/results/281-import-knowledge.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
