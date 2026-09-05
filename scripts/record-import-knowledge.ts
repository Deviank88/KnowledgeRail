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
  ["ImportRuntime", "Import runtime e adapter", "src/core/code-evidence/import-resolution/diagnostics.ts", "ImportResolutionCollector",
    "ImportResolutionCollector distingue import risolti, ambigui e non risolti una volta per coppia file/specifier e generazione, senza contare ogni frammento o richiesta. Namespace e package espliciti possono contenere più file; un nome singolo duplicato non genera archi import. I membri validi di gruppi parziali restano utilizzabili. knowledge_code references mostra fino a dodici esempi per snapshot e quattro candidati ciascuno, con limiti dichiarati; non sono diagnosi attribuite al target interrogato. Unresolved può significare esterno, non supportato o non indicizzato e non richiede automaticamente rebuild. Contatori per famiglia adapter restano interni; diagnostica e cache condividono il budget del workspace."],
  ["ImportRuntime", "Import runtime e adapter", "src/core/code-evidence/query-runtime.ts", "CodeQueryRuntime",
    "CodeQueryRuntime costruisce una volta per generazione gli archi import. Gli adapter forniscono createImportResolver; il runtime verifica i percorsi nell'inventario, elimina doppioni e conserva precedenza call/reference/import, filtri e ordine."],
  ["ImportRuntime", "Import runtime e adapter", "src/core/code-evidence/index.ts", "PersistentCodeEvidenceIndex",
    "PersistentCodeEvidenceIndex riusa snapshot e query runtime con lo stesso registry. Registry personalizzati diversi non condividono le regole della cache. I resolver nuovi non cambiano parserVersion o schema dello snapshot e non richiedono una ricostruzione per la sola risoluzione degli import."],
  ["ImportRuntime", "Import runtime e adapter", "src/core/code-evidence/project-structure.ts", "ProjectStructureReader",
    "ProjectStructureReader legge i manifest dichiarati dagli adapter negli antenati dei sorgenti indicizzati e segue un livello di riferimenti locali, senza esecuzione. Ogni file è limitato a 256 KiB; dati analizzati e cache restano nel budget del workspace. Le query ricontrollano manifest noti, radice e dipendenze correnti; nuovi manifest annidati richiedono update o rebuild. Modifiche ai manifest invalidano gli archi senza riestrarre i sorgenti."],
  ["ImportDeclarations", "Import Java Kotlin CSharp PHP", "src/core/code-evidence/import-resolution/declarations.ts", "createDeclarationImportResolver",
    "Java, Kotlin e PHP risolvono gli import tramite qualifiedName delle dichiarazioni, indipendentemente da source root e nome del file. Kotlin conserva gli alias e le funzioni top-level; PHP supporta clausole raggruppate e alias. Nomi dichiarati in più file restano irrisolti per il lookup puntuale."],
  ["ImportDeclarations", "Import Java Kotlin CSharp PHP", "src/core/code-evidence/import-resolution/declarations.ts", "createDeclarationImportResolver",
    "C# using Acme.Orders importa un namespace: l'evidenza comprende i file che vi dichiarano tipi, anche se sono più di uno. Le wildcard Java/Kotlin rappresentano gruppi analoghi. Questi archi descrivono l'ambito importato, non dimostrano quali classi vengano eseguite."],
  ["ImportPaths", "Import Python JavaScript header C Cpp", "src/core/code-evidence/import-resolution/python.ts", "createPythonImportResolver",
    "Python risolve moduli, package e stub .pyi dalla radice, dalla directory dell'importatore e dalla source root attestata dalla catena di __init__.py. Sono coperti src/cli.py verso orders_cli e src/app/nested/service.py verso app.orders. Candidati discordanti restano irrisolti; root e sys.path aggiuntivi non vengono inventati."],
  ["ImportPaths", "Import Python JavaScript header C Cpp", "src/core/code-evidence/import-resolution/javascript.ts", "createJavaScriptImportResolver",
    "JavaScript e TypeScript risolvono import relativi con estensioni esplicite, sostituzioni runtime/source e index di directory; il file esatto .js precede il fallback .ts e il case dei percorsi resta significativo. Gli alias paths e baseUrl provengono dal tsconfig o jsconfig più vicino. Pattern esatti e prefissi più lunghi precedono quelli generici; target alternativi seguono l'ordine dichiarato, ma candidati ambigui non diventano archi certi."],
  ["ImportPaths", "Import Python JavaScript header C Cpp", "src/core/code-evidence/import-resolution/javascript-config.ts", "importConfig",
    "La configurazione JS/TS accetta JSON con commenti e virgole finali e un livello di extends locale. Le opzioni relative conservano la directory di origine; paths nel figlio sostituisce la mappa ereditata. rootDir non definisce nomi importabili. Configurazioni invalide, basi mancanti, cicli o ereditarietà più profonda bloccano gli alias e producono diagnostica. Project references, selezione include/exclude, package exports e configurazioni dei bundler restano fuori dal contratto."],
  ["ImportPaths", "Import Python JavaScript header C Cpp", "src/core/code-evidence/import-resolution/c-family.ts", "createCImportResolver",
    "C/C++ collegano #include orders.h o orders.hpp al file header indicizzato, cercando directory dell'includente e radice. Non aggiungono un arco al gemello .c/.cpp. Directory include configurate dal compilatore e macro non vengono dedotte; candidati diversi restano irrisolti."],
  ["ImportGoRust", "Import package Go e moduli Rust", "src/core/code-evidence/import-resolution/go.ts", "createGoImportResolver",
    "Go usa l'identità module dichiarata in go.mod e la directory del package: create.go e cancel.go sono raggiunti dallo stesso import, mentre import esterni con suffisso uguale e confini di moduli annidati non vengono confusi. I file _test.go sono esclusi. Senza manifest rilevati resta il confronto legacy per suffissi; go.work, replace, vendor e build tag non sono risolti. I manifest noti si aggiornano nelle query; per nuovi manifest annidati serve update o rebuild dell'indice."],
  ["ImportGoRust", "Import package Go e moduli Rust", "src/core/code-evidence/import-resolution/rust.ts", "createRustImportResolver",
    "Rust collega crate, self, super e gruppi use ai moduli .rs, mod.rs e moduli inline indicizzati nel crate. Ambiguità e risalita oltre il crate restano irrisolte. Path attributes, cfg, re-export arbitrari ed edition-dependent bare paths non sono un resolver completo; gli alberi use hanno un limite di espansione."],
  ["ImportSalesforce", "Salesforce Apex metadata e LWC", "src/core/code-evidence/import-resolution/salesforce.ts", "createSalesforceImportResolver",
    "LWC risolve @salesforce/apex/Orders.load verso la dichiarazione del metodo Apex, @salesforce/schema/Invoice__c.Amount__c verso il metadata del campo e c/orderChild verso il bundle locale. Duplicati e nomi non indicizzati restano irrisolti. I moduli Salesforce forniti dalla piattaforma non diventano file locali inventati."],
  ["ImportSalesforce", "Salesforce Apex metadata e LWC", "src/core/code-evidence/sfmeta-adapter.ts", "SalesforceMetadataKnowledgeAdapter",
    "SalesforceMetadataKnowledgeAdapter estrae metadata SFDX e riferimenti a oggetti/campi; Apex non usa import Java. I controlli del roster verificano metadata malformati, collegamenti verso Apex, drift e aggiornamenti selettivi, separatamente dagli archi import LWC."],
  ["CodeKnowledgeLinks", "Knowledge con riferimenti diretti al codice", "src/core/ingestion/evidence-synthesis.ts", "renderClaim",
    "Una pagina knowledge deve citare il codice quando la spiegazione riguarda una classe, un metodo o una regola implementata. Evidence IR conserva codeResourceUri e codeAnchor verificato; renderClaim mostra il link code://repo con percorso e righe. Una nota non tecnica o un target non risolto non riceve un riferimento inventato."],
  ["CodeKnowledgeLinks", "Knowledge con riferimenti diretti al codice", "src/core/ingestion/evidence-pipeline.ts", "recordEvidenceClaims",
    "Per registrare evidenze tecniche si passa target.codeResourceUri a recordEvidenceClaims: il servizio aggiorna solo i file interessati e cattura range, hash e versione del parser. Il flusso di retrieval usa knowledge_context, legge la pagina wiki e apre il code URI citato; il drift segnala quando le evidenze non sono più aggiornate."],
  ["CodeKnowledgeLinks", "Knowledge con riferimenti diretti al codice", "src/core/drift-detection.ts", "staleClaimsByPage",
    "Il registro drift conserva anche gli anchor storici. staleClaimsByPage consulta lo stato corrente dei claim e non marca obsoleta una pagina soltanto per evidenze superseded, anche se la supersessione è successiva al controllo drift. Claim attivi, ambigui o contraddetti continuano a segnalare drift. Con un registro vuoto o interamente fresco non viene letto lo store delle evidenze."],
  ["CodeKnowledgeLinks", "Knowledge con riferimenti diretti al codice", "src/context/task-context-compiler.ts", "compileTaskContext",
    "knowledge_context accetta changed_paths con file sorgenti relativi al repository, oltre ai percorsi wiki. I path sorgenti espliciti nel testo della task e i claim attivi selezionati negli intenti di impatto possono produrre codeRoots e codeRelations. Il contesto resta di sola lettura: se l'indice codice manca o è incompatibile, espone un GAP e richiede refresh esplicito. L'aggiunta dei candidati rispetta il budget tramite selezione di prefissi, senza rendere il codice prova di copertura documentale."],
  ["CodeKnowledgeLinks", "Knowledge con riferimenti diretti al codice", "src/context/code-impact.ts", "expandCodeImpact",
    "expandCodeImpact riusa il runtime codice e le associazioni claim-pagina del controllo drift. Espone al massimo tre radici, dodici candidati entranti per radice e sei pagine wiki correlate tramite claim attivi; il budget token può ridurli ulteriormente. codeSnapshot indica la generazione indicizzata, non una verifica del sorgente corrente. I collegamenti call/reference sono lessicali e gli import mantengono i limiti degli adapter: materializzare solo risorse pertinenti, verificare il codice e non dedurre assenza di utilizzo da un risultato vuoto."],
] as const;

const repositoryRoot = process.cwd();
const wikiRoot = path.join(repositoryRoot, "wiki");
setWikiRoot(repositoryRoot);
await ensureWikiStructure();
const index = new PersistentCodeEvidenceIndex({ repositoryRoot, wikiRoot });
await index.rebuild();
const snapshot = await index.snapshot();
const sourceUri = "docs/normalized/import-evidence-2.7.4.md";
const sourceContent = `# Import evidence e retrieval del codice — 2.7.4\n\n${notes.map((note) => note[4]).join("\n\n")}\n`;
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
    (claim.text === text || uniqueSlot));
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
await fs.writeFile(path.join(repositoryRoot, "benchmarks/results/274-import-knowledge.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
