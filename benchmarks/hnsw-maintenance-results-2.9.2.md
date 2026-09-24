# HNSW 2.9.2 — manutenzione incrementale e riuso del journal

24 settembre 2026, worktree basato su `a5d5e18`, package 2.9.1 con modifiche
Unreleased. Nessun cambio di default, versione, commit o pubblicazione.

## Comportamento implementato

Il grafo viene creato quando manca e mantenuto dopo aggiunte, sostituzioni e
cancellazioni. Le aggiunte usano l'inserimento HNSW; cancellazioni e sostituzioni
ravvicinate vengono accorpate. Una scansione delle adiacenze individua i riferimenti
ai nodi rimossi e ripara soltanto i vicinati coinvolti, attraversando anche sequenze
e cicli di nodi cancellati. I vettori sostituiti vengono reinseriti. Il lavoro già
completato non riparte quando arrivano ulteriori modifiche.

Questa scelta evita una seconda matrice di vettori e un grafo inverso residente.
Il costo della scansione rimane O(E) per lotto; il calcolo delle distanze necessario
alla riparazione è locale. Un grande lotto con molti nodi collegati può richiedere
molto più lavoro di una singola cancellazione. Il costo iniziale HNSW rimane.
La ricerca sugli aggiornamenti dei grafi ANN evidenzia proprio il compromesso fra
collegamenti entranti, spazio e qualità; questa implementazione non pretende di
replicare IP-DiskANN o Wolverine. Riferimento primario:
[In-Place Updates of a Graph Index for Streaming ANN Search](https://arxiv.org/html/2502.13826v1).

Durante costruzione/riparazione le query cercano esattamente sui vettori correnti:
quelli cancellati non possono ricomparire come candidati. Le operazioni cedono il
controllo fra porzioni di lavoro, con obiettivo 8 ms, senza promettere una deadline
rigida per un singolo nodo. Il checkpoint accetta solo la topologia completa.
Errori della manutenzione mantengono il fallback esatto e vengono segnalati da
`ready()`, senza salvare una topologia parziale.

Al riavvio il grafo viene validato contro i vettori del suo checkpoint **prima** di
applicare le differenze del journal. Lo storage conserva temporaneamente una mappa
di riferimenti ai vettori del checkpoint, senza convertirli o copiarne i byte.
Le differenze del journal e delle pagine canoniche si applicano incrementalmente.
Un grafo assente, corrotto o incompatibile viene costruito dai vettori validi,
senza rigenerare gli embedding. Formato/checksum esistenti restano compatibili.
La topologia knowledge rimane indipendente.

## Protocollo congelato

`benchmarks/hnsw-maintenance-bench.ts`: stesso generatore deterministico, seed 292,
10.000/50.000 vettori int8 a 1.024 dimensioni, 128 gruppi sintetici e 32 query con
rumore indipendente. M=16, efConstruction=100, efSearch=64, nessuna selezione di
parametri sui risultati. Ricerca esatta sul corpus corrente come riferimento per
recall@32; il 32 misura i vicini e non introduce un limite alle evidenze utente.

Sequenza identica prima/dopo: costruzione iniziale; eliminazione del vicino della
prima query; 32 sostituzioni; 16 cancellazioni e 16 nuovi inserimenti. Nel nuovo
motore seguono 20 lotti di 32 sostituzioni, per altre 640 modifiche. Dopo ciascuna
delle prime quattro fasi, salvataggio/ripristino binario e parità esatta dei
risultati delle prime quattro query. I test verificano anche checkpoint dopo churn.

Il tempo di modifica include l'applicazione e `ready()`, esclude embedding,
checkpoint, I/O del journal e richiesta MCP completa. p50/p95 si riferiscono alle
32 query, non a una distribuzione di latenze di aggiornamento. Un run per scala e
versione, Apple M4 Max/macOS, Node 24.9.0, cache OS calda. I confronti prima/dopo
sono eseguiti in successione, non simultaneamente; durante parte del baseline
sono stati eseguiti brevi test mirati e operazioni documentali. Nessuna misura di
capacità in produzione o attribuzione della page cache.

## Risultati

Con 50.000 vettori:

| Modifica | Prima: rebuild | Dopo: incrementale | Recall@32 prima → dopo |
| --- | ---: | ---: | ---: |
| Una cancellazione | 90.327 ms | 52,57 ms | 99,512% → 99,512% |
| 32 sostituzioni | 90.174 ms | 705,76 ms | 99,512% → 99,609% |
| 16 cancellazioni + 16 aggiunte | 91.110 ms | 340,14 ms | 99,316% → 99,414% |

Le ulteriori 640 modifiche richiedono 10,79 s complessivi e terminano con recall@32
99,023%. Il corpus è cambiato: il confronto esatto usa ogni volta i vettori correnti.
Non è stato eseguito un rebuild di riferimento dopo ciascuno dei 20 lotti.
Il contatore resta **un solo build completo**, quello iniziale; 23 lotti di
riparazione complessivi, nessuna modifica pendente al termine.

La prima costruzione a 50k richiede ancora 110,58 s (baseline 136,66 s); il vantaggio
principale misurato riguarda la manutenzione, non l'eliminazione di questo costo.
Query dopo le tre modifiche: p50 0,96–1,00 ms, p95 1,61–1,89 ms; dopo churn p50
0,95 ms e p95 1,64 ms. Il grafo passa da 4.415.868 a 4.370.040 byte dopo il lotto
misto, prima del churn. Ripristino della sola topologia dai byte già in memoria:
315–322 ms, risultati identici; questi tempi non includono lettura disco o avvio MCP.
Il massimo intervallo osservato dal timer durante le modifiche è circa 20 ms.
RSS 428–464 MB nel processo di prova include fixture, riferimento esatto e temporanei;
non rappresenta memoria attribuibile al solo grafo né un picco campionato.

A 10.000 vettori, nel run ripetuto dopo la pausa anomala descritta sotto:

| Modifica | Prima: rebuild | Dopo: incrementale | Recall@32 prima → dopo |
| --- | ---: | ---: | ---: |
| Una cancellazione | 21.388 ms | 22,93 ms | 100% → 100% |
| 32 sostituzioni | 21.538 ms | 586,24 ms | 100% → 100% |
| 16 cancellazioni + 16 aggiunte | 21.651 ms | 274,20 ms | 100% → 100% |

Primo build 27,49 s (baseline 33,98 s); ulteriori 640 modifiche in 7,31 s,
recall@32 ancora 100%, un solo build completo. Dopo churn, query p50 0,77 ms e
p95 0,90 ms. Il nuovo run completo è `after-final-repeat-10000.json`; anche il
primo run finale e quello esplorativo rimangono disponibili, con identità distinte.

## Verifica e riproduzione

I test dedicati controllano int8/float32, cancellazione dell'entry point, catene e
cicli di nodi rimossi, mutazioni durante costruzione/riparazione, coalescenza,
aggiornamenti identici, eliminazione di tutto il corpus, dispose e cambio di
generazione. Viene misurato recall su query indipendenti dopo 20 lotti, verificato
il checkpoint e riavviato l'indice con aggiunte/cancellazioni nel journal senza
nuovi embedding o rebuild totale. Restano i test di corruzione e cambio motore.

Verifica finale: **93 file di test passati**, typecheck e repository hygiene,
**19 gate di qualità passati**, build e package smoke riusciti. Il file dedicato
agli engine contiene 13 test. Nessuna soglia dei gate è stata allentata.
Pacchetto verificato: 689 file, 1.096.812 byte compressi e 4.223.888 non compressi.

Identità runtime: SHA-256 dell'inventario ordinato percorsi+contenuti `src/**/*.ts`
`1bc68b817cc532dbdece457e05d87702951519c19df938289736887e2a0a5d06`.
Motore precedente `ec4f81217d98d4a61176ac2382c518e5992c180f5e6e2b48f5465bcba4afee1e`;
motore nuovo `aaea9315bcbd0caee0db38ae0ff324198d29e281baa46fb4cdd5ff5a3e4b5632`.
Raw locali, log, sorgenti esatti e identità:
`benchmarks/results/hnsw-maintenance-292/` (ignorato da Git come gli altri raw).
Il run preliminare `after-10000.json` usa un motore intermedio e resta distinto.
`after-final-10000.json` ha registrato 286,09 s per il build, con un singolo intervallo
del timer di 258,33 s. La causa della pausa non è stata isolata; il dato non viene
cancellato, sottratto artificialmente o presentato come costo ordinario del build.

```sh
mkdir -p /tmp/kr292-hnsw-before
tar -xzf benchmarks/results/hnsw-maintenance-292/before-source.tar.gz -C /tmp/kr292-hnsw-before
node --expose-gc --import tsx benchmarks/hnsw-maintenance-bench.ts --count=10000 --legacy=/tmp/kr292-hnsw-before/hnsw-engine.ts --output=/tmp/hnsw-before-10000.json
node --expose-gc --import tsx benchmarks/hnsw-maintenance-bench.ts --count=10000 --rounds=20 --output=/tmp/hnsw-after-10000.json
```

Ripetere con `--count=50000` e nuovi percorsi output; i file esistenti non vengono
sovrascritti. Il recall di vicini sintetici non misura la rilevanza delle fonti:
la generalizzazione su progetti indipendenti, carichi prolungati, prestazioni MCP,
portabilità e cache fisica resta pianificata nella milestone locale 2.9.3
`milestones/validazione-operativa-retrieval-2-9-3.md`.
