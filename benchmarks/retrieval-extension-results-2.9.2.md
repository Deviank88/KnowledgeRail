# Retrieval 2.9.2 — candidati, ANN, reranker e storia delle evidenze

> Aggiornamento di perimetro del 24 settembre 2026: il rescoring float32 e la
> persistenza doppia sono stati rimossi dal runtime per decisione dell'utente.
> Sono chiusi ulteriori sweep arbitrari di pool/parametri. Questo rapporto conserva
> le misure storiche e l'identità dei runtime originali; non descrive le verifiche
> del successivo runtime semplificato. Sorgenti storici e istruzioni sono in
> [archivio](archive/semantic-rescoring-292/README.md).

> La successiva [manutenzione incrementale HNSW](hnsw-maintenance-results-2.9.2.md)
> sostituisce il rebuild dopo normali modifiche descritto in questo rapporto storico.
> Il [reranker Ollama nativo](ollama-reranker-results-2.9.2.md) documenta inoltre la
> configurazione finale senza deadline predefinita; i limiti qui sotto sono storici.


Rapporto locale del 24 settembre 2026, nel worktree basato su `a5d5e18`.
Package 2.9.1, modifiche Unreleased: nessun commit, tag o pubblicazione 2.9.2.
La prima fase di rescoring è conservata in [release-readiness-2.9.2.md](release-readiness-2.9.2.md),
con il suo runtime e le sue misure. Questa estensione segue il
[protocollo dedicato](retrieval-extension-protocol-2.9.2.md).

## Implementazione

- Ricerca esatta, LSH e HNSW dietro la stessa interfaccia. Parametri e seed espliciti;
  LSH/int8 rimane il default. Ammissione candidati separata dalle soglie coverage.
- Espansione per lotti riutilizzando l'embedding della query; diagnostica distingue
  approssimazione, taglio del pool e limite di risorse. Top-k non stabilisce che
  un'evidenza successiva sia irrilevante. Nessun parametro deriva dal 90% d'esempio.
- `evidence_cursor="start"` rende recuperabili i candidati oltre il primo contesto;
  `nextAction` conserva query e filtri. Revisioni diverse invalidano la continuazione.
  I limiti ANN, temporali e di memoria sono dichiarati: non si promette richiamo
  esaustivo e i candidati aggiuntivi non sono automaticamente rilevanti o sufficienti.
- Reranker HTTP opzionale, input massimo 64 documenti, budget cumulativo 500 ms,
  riuso dei pool identici, verifica del contenuto dopo l'inferenza e fallback.
  Score del reranker, score vettoriale e validità delle fonti restano distinti.
- `history_cursor="start"` recupera intervalli, fonti, motivazioni e sostituzioni;
  `reinstates` richiede una nuova claim con provenienza e un intervallo precedente
  chiuso. A gennaio vale A, a marzo B lo sostituisce, a giugno una nuova claim C
  riprende A: l'intervallo gennaio–marzo resta chiuso, quello marzo–giugno non sparisce.
  Conflitti e date non note non diventano certezze tramite ranking. La provenienza
  è `recorded_only`, non una nuova verifica automatica dei byte della fonte.

## Grafo persistito e residente

Il grafo knowledge e quello ANN restano separati, come richiesto esplicitamente.
`semantic-graph.bin` contiene soltanto topologia binaria e riferimenti numerici ai
vettori; niente seconda matrice o testo duplicato. Hash dei vettori/ID, descrittore
motore e checksum proteggono il riuso. Un grafo assente, corrotto o reso obsoleto dal
journal viene ricostruito indipendentemente, conservando i vettori validi.

Gli indici attivi mantengono in RAM vettori int8 e adiacenze. Non è un grafo con
pagine caricate da disco su richiesta e non introduce Redis. L'indice condivide i
buffer vettoriali già posseduti dallo storage. I float32 originali, se abilitati per
rescoring, restano su disco con cache limitata. Il primo build HNSW resta costoso;
rimozioni e sostituzioni ricostruiscono il grafo cooperativamente, con ricerca
esatta sui vettori correnti durante la ricostruzione.

| Passaggi | Build iniziale | Ripristino mediano | Grafo SSD | Totale SSD | Heap+buffer incrementali |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 1.79 s | 18.57 ms | 0.10 MB | 1.31 MB | 2.83 MB |
| 10,000 | 39.12 s | 116.99 ms | 1.08 MB | 13.23 MB | 22.17 MB |
| 50,000 | 301.39 s | 548.02 ms | 5.55 MB | 66.36 MB | 110.69 MB |

Tutte le 15 nuove istanze riusano gli embedding e ripristinano la topologia salvata;
risultati identici. A 50k: RSS dopo build 556,65 MB; picco del processo 754,17 MB
(incluso indice originale ancora residente durante i reload), checkpoint 446 ms.
Unità MB decimali. Nessuna misura RSS è presentata come attribuzione della page cache.

Le misure di nuove istanze includono lettura/validazione dei file e ripristino
dell'indice nello stesso processo; non includono avvio di Node, import dei moduli
o preparazione dei record. RSS è dell'intero processo benchmark, non il solo grafo.
Heap+ArrayBuffers incrementali distinguono meglio la memoria trattenuta dall'indice;
RSS risente anche della memoria riservata da V8. Cache OS calda, SSD Apple AP1024Z,
Apple M4 Max, Node 24.9.0. Le prove locali possono sovrapporsi ad altri benchmark;
non sono una misura di capacità in produzione.

Prova aggiuntiva in **cinque processi Node nuovi**, a 50k: mediana del processo
completo 906.40 ms (import, preparazione fixture, caricamento, query e uscita),
ripristino indice 597.91 ms, prima query 8.09 ms. In tutti i casi
`graphRestored=true`, zero embedding documentali e identico digest dei risultati.
RSS del processo nuovo 400.44–403.60 MB, heap circa 89,24 MB e buffer 51,43 MB,
inclusi i record del fixture. Questo secondo build costa 312.49 s. La prova misura
il processo benchmark, non la latenza end-to-end di un client MCP con provider reale.

## Qualità e costo dell'inferenza

Tre provider embedding reali: Qwen3 0.6B/1024, Potion Retrieval 32M/512 e Potion
Multilingual 128M/256. 59 sezioni, 124 passaggi; 20 query sviluppo, 40 regressioni
ispezionate e 40 nuove parafrasi IT/EN congelate. Le nuove formulazioni riusano
i giudizi delle pagine: non sono nuovi domini o annotazioni umane indipendenti.
18 varianti per provider, cinque ripetizioni con rotazione dell'ordine; parità dei
percorsi finali e coverage verificata fra le ripetizioni. Output di confronto 8
risultati/4000 token euristici; recall del pool riportata separatamente dal display.

Cross-encoder [mmarco-mMiniLMv2-L12-H384-v1](https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1),
revisione `1427fd652930e4ba29e8149678df786c240d8825`, artefatti locali con hash,
PyTorch CPU a 4 thread, batch 16, tokenizzazione massima 512. Inferenza reale su
query/documento; il confronto dei ranking riusa gli score reali congelati.
I suoi tempi includono la fusione e il recupero dei documenti, ma **non** una nuova
inferenza embedding/cross-encoder per ogni variante. Le latenze live sono separate.

| Provider | Selezionato su sviluppo | nDCG baseline → variante | Delta, IC95% | Recall@8 |
|---|---|---:|---|---:|
| ollama | exact-top-k-64-rerank-32 | 0.6396 → 0.7109 | +0.0712 [-0.0364, +0.1855] | 0.850 → 0.950 |
| potion-retrieval-32M | exact-top-k-64-rerank-64 | 0.5836 → 0.7109 | +0.1273 [+0.0170, +0.2429] | 0.825 → 0.950 |
| potion-multilingual-128M | exact-top-k-64-rerank-32 | 0.5776 → 0.7016 | +0.1240 [+0.0185, +0.2400] | 0.825 → 0.925 |

Il limite inferiore IC95% è positivo per i due modelli statici, ma non per Qwen.
Questo non autorizza la promozione: restano regressioni, giudizi limitati e costo
live del reranker. Non è stata cercata una nuova soglia sui risultati del holdout.

- ollama: recall pool 0.925 → 1.000; 11 query migliorate e 8 peggiorate per nDCG; coverage accuracy 0.475 → 0.475.
- potion-retrieval-32M: recall pool 0.925 → 1.000; 13 query migliorate e 7 peggiorate per nDCG; coverage accuracy 0.475 → 0.475.
- potion-multilingual-128M: recall pool 0.925 → 0.975; 12 query migliorate e 8 peggiorate per nDCG; coverage accuracy 0.475 → 0.475.

Ablation nDCG@8 sulle 40 nuove formulazioni:

| Variante | Qwen | Potion32M | Potion128M |
|---|---:|---:|---:|
| lsh-threshold-32 | 0.6396 | 0.5836 | 0.5776 |
| lsh-top-k-32 | 0.5570 | 0.4799 | 0.4760 |
| lsh8-top-k-32 | 0.5925 | 0.5155 | 0.5412 |
| exact-top-k-32 | 0.6189 | 0.6060 | 0.6111 |
| hnsw-top-k-32 | 0.6189 | 0.6060 | 0.6111 |
| lsh-threshold-64 | 0.6396 | 0.5836 | 0.5776 |
| lsh-top-k-64 | 0.5570 | 0.4799 | 0.4760 |
| lsh8-top-k-64 | 0.5925 | 0.5155 | 0.5412 |
| exact-top-k-64 | 0.6189 | 0.6060 | 0.5989 |
| hnsw-top-k-64 | 0.6189 | 0.6060 | 0.6022 |
| exact-threshold-64 | 0.6504 | 0.5836 | 0.6055 |
| hnsw-threshold-64 | 0.6504 | 0.5836 | 0.6055 |
| lsh-threshold-64-rerank-32 | 0.7120 | 0.6962 | 0.7120 |
| exact-top-k-64-rerank-32 | 0.7109 | 0.7109 | 0.7016 |
| hnsw-top-k-64-rerank-32 | 0.7109 | 0.7109 | 0.7016 |
| lsh-threshold-64-rerank-64 | 0.7120 | 0.6962 | 0.7120 |
| exact-top-k-64-rerank-64 | 0.7109 | 0.7109 | 0.7095 |
| hnsw-top-k-64-rerank-64 | 0.7109 | 0.7109 | 0.7095 |

I bootstrap appaiati del protocollo ricampionano le query, non domini indipendenti.
Le due parafrasi per tema sono correlate: gli intervalli descrivono questo fixture,
non una validazione universale. Negativi e giudizi di rilevanza non sono esaustivi.
Reranking e un pool più ampio possono migliorare alcuni casi e peggiorarne altri;
le liste `improved`/`regressed` sono conservate per query e variante nei JSON.
La coverage resta indipendente e non viene dichiarata migliorata dal solo ranking.

80 chiamate HTTP locali, 20 query, pool richiesti 32/64 (32–47 documenti
effettivamente disponibili), modello già caricato:

| Budget | Richieste | Reranking applicato | Tempo p50 | Tempo p95 |
|---|---:|---:|---:|---:|
| 500 ms | 40 | 0 | 500.44 ms | 501.35 ms |
| 30000 ms | 40 | 40 | 1032.58 ms | 1426.86 ms |

Zero applicazioni entro 500 ms su questo ambiente. Le misure a completamento
sono un riferimento separato, non una modifica della deadline predefinita.
Il benchmark verifica il componente HTTP su pool reali registrati; non è una
misura end-to-end comprensiva degli embedding. Durante una parte della sessione
erano in esecuzione benchmark ANN: questi tempi non sono una misura isolata.

Il server di prova completa i calcoli CPU anche dopo l'abbandono della richiesta;
la cancellazione HTTP limita il tempo del chiamante, non garantisce l'interruzione
fisica del provider remoto. La coda locale impedisce richieste concorrenti a provider
che mantengono aperta la stessa promessa. Nessun download avviene nel retrieval.

## Scala ANN e compromessi

| Motore a 50k | Recall vicini@32 | Query p50 | Query p95 | Build | Ripristino senza snapshot HNSW |
|---|---:|---:|---:|---:|---:|
| lsh | 0.6807 | 3.05 ms | 3.65 ms | 4.13 s | 4.09 s |
| lsh8 | 0.8115 | 5.77 ms | 6.82 ms | 4.12 s | 4.09 s |
| exact | 1.0000 | 84.37 ms | 87.05 ms | 0.22 s | 0.30 s |
| hnsw | 0.9951 | 1.13 ms | 1.95 ms | 123.68 s | 92.72 s |

La rimozione con ricostruzione HNSW in questa prima iterazione costa 78,54 s a 50k.
La tabella usa il primo prototipo, prima della persistenza: il dato non rappresenta
un riavvio del runtime finale con snapshot valido. RSS processo tra 344 e 405 MB
nel benchmark dei soli motori; tutte le p95 misurate sono sotto 100 ms.

Recall@32 qui significa sovrapposizione con i vicini esatti, non rilevanza documentale.
Corpus sintetico a 128 cluster, 1024 dimensioni, int8, 32 query con rumore indipendente,
96 misure per motore. Dataset distinto dal benchmark di durata a 32 passaggi/pagina.
La prima iterazione ricostruiva HNSW al riavvio: i suoi tempi rimangono nell'ablation
storica. Il grafo persistito risolve quel costo di avvio; non quello di modifica
che richiede ricostruzione, né garantisce qualità su ogni corpus reale.

## Verifica e decisione

Passati `npm run verify` (92 file), tutti i 19 quality gate, build, package smoke e
verifica di coerenza della versione 2.9.1. Test specifici: motori e snapshot HNSW,
corruzione/journal/cambio motore, sesta evidenza oltre cinque, continuazioni e
revisioni, storia A→B→C, conflitti/date mancanti, freschezza e fallback del reranker.
Un test verifica che il file del grafo knowledge resti invariato durante il recupero
ANN. Restano validi i test di rescoring, concorrenza, budget e isolamento della prima
fase. Nessuna nuova dipendenza runtime; nessuna soglia dei gate aumentata.

La persistenza HNSW è implementata e utilizzabile in modalità sperimentale. LSH/int8
rimane il default: il corpus limitato e i costi di aggiornamento non giustificano
un cambio universale. Il cross-encoder misurato resta opzionale: qualità offline e
rispetto della deadline sono criteri distinti. Non si conclude che non esistano
altri miglioramenti; le misure individuano quali strade meritano ulteriore lavoro.

Restano fuori dalla validazione locale: HDD, cache OS realmente fredda, attribuzione
della page cache, traffico reale prolungato e revisione indipendente dei giudizi.
Questi limiti della prima fase non vengono segnati come completati.

## Riproduzione e artefatti

Raw e manifest locale: `benchmarks/results/retrieval-extension-292/` (ignorato da Git).
Include report completi per provider/query, score e hash del modello, misure live,
scala, restart e archivio dei sorgenti. `prior-run/` conserva l'iterazione precedente
alla persistenza, senza attribuirle il digest del runtime finale.

Runtime delle misure di qualità e scala: SHA-256 della lista ordinata percorsi+contenuti
`df08d8a80249f4d8a6c549503b05ec9df1a86c6c3500f4fe0b6c3c79abfe4fe6`.
Il manifest dei raw contiene gli hash dei file; il bundle dei sorgenti permette
di distinguere questa estensione dalla prima fase.

```sh
node --import tsx benchmarks/retrieval-extension-eval.ts --provider=ollama --collect
python3 benchmarks/retrieval-reranker-score.py --model=/path/to/pinned/local/model
node --import tsx benchmarks/retrieval-extension-eval.ts --provider=ollama
node --expose-gc --import tsx benchmarks/ann-extension-scale.ts --engine=hnsw --count=50000
KNOWLEDGE_RAIL_SEMANTIC_ENGINE=hnsw node --expose-gc --import tsx benchmarks/semantic-durability-bench.ts --scale=50000 --dtype=i8 --reloads=5 --require-graph --process-restarts
```

Ripetere collect/eval per i due provider statici per riprodurre tutti i confronti.
Servono anche i vettori e i fixture congelati della prima fase. Lo scorer richiede
PyTorch/Transformers nell'ambiente di valutazione; non sono dipendenze del server.

## Chiusura della validazione sul runtime finale

Dopo le misure è stato corretto il salvataggio automatico del grafo quando si
attiva HNSW su vettori esistenti o si ripara un artefatto corrotto, senza nuovi
embedding. Le richieste concorrenti condividono il checkpoint di riparazione e
la chiusura dell'indice durante il rebuild non può sovrascrivere i dati durevoli.
Test dedicati, suite, gate e build sono stati ripetuti dopo la correzione.

Sul runtime finale sono state rieseguite tutte le 100 query × 18 varianti × 3 provider:
**5.400 confronti** verificano percorsi finali e coverage identici al runtime
delle cinque ripetizioni. Le metriche di ranking restano quindi identiche; i tempi
del confronto precedente rimangono attribuiti al suo runtime. Sul runtime finale
sono passati anche cinque nuovi processi a 1k con snapshot HNSW, zero nuovi embedding
e risultati identici. I tempi a 50k restano riferiti all'iterazione documentata sopra.

Il bundle `measured-runtime-source.tar.gz` conserva il runtime delle misure;
`runtime-source.tar.gz` conserva il runtime finale, digest
`8aa1bb3fd41ecc8f69099ed6202371f2750637a426349454a2d6626a20da7cf9`. Nessun dato precedente viene attribuito retroattivamente al nuovo digest.
