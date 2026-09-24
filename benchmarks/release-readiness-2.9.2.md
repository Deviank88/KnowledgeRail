# Verifica pre-release 2.9.2 — rescoring semantico misurato

> Aggiornamento di perimetro del 24 settembre 2026: il rescoring float32 e la
> persistenza doppia sono stati rimossi dal runtime per decisione dell'utente.
> Sono chiusi ulteriori sweep arbitrari di pool/parametri. Questo rapporto conserva
> le misure storiche e l'identità dei runtime originali; non descrive le verifiche
> del successivo runtime semplificato. Sorgenti storici e istruzioni sono in
> [archivio](archive/semantic-rescoring-292/README.md).


24 settembre 2026. Implementazione locale verificata; **nessuna pubblicazione o tag
2.9.2**. Il package rimane 2.9.1 con modifiche in `Unreleased`.

## Esito e scelta del default

Sulle 40 query di valutazione separata, nessuno dei tre modelli migliora nDCG@8
con il rescoring, né a pool 32 né a pool 64. Il criterio di adozione non è
soddisfatto: **int8 senza rescoring rimane il default**. Il percorso sperimentale
resta disponibile per riprodurre l'esperimento; non viene raccomandato per il
profilo misurato. Non viene introdotto un pool 128 o un widening semantico dinamico.
Il budget semantico complessivo e le correzioni di cancellazione/fallback sono
indipendenti dall'adozione del rescoring.

Questo risultato nullo riguarda il corpus misurato, non dimostra equivalenza
universale. Le metriche assolute restano lontane dalla perfezione: maggior precisione
numerica dei vettori non risolve automaticamente ANN, soglia, selezione o lacune.

## Protocollo e provenienza

[Protocollo congelato](semantic-rescoring-protocol-2.9.2.md), baseline Git
`a5d5e185c41625fbc955340a7d390d5e95fbcb93`. Le prove usano il worktree modificato, non il solo commit:
SHA-256 dell'inventario dei sorgenti runtime **`914bacb59ef0570b3ee9beecc16eed77a51cfaff4d0edf13c199951aa9b3c740`**, uguale nei tre report
finali. Non è stato creato un commit automaticamente.

- Corpus aggiuntivo: 59 sezioni / 124 passaggi della documentazione reale di questo
  repository alla baseline. 60 query annotate IT/EN: 20 sviluppo e 40 valutazione.
  Fixture immutabile e SHA-256 nel protocollo. Giudizi redatti dall'agente, senza
  annotazione umana indipendente; pagine affini non elencate sono negativi non
  esaustivamente giudicati. Non è traffico reale degli utenti.
- Regressione storica separata: 46 pagine / 53 passaggi / 16 query, corpus originale.
- Varianti: lessicale/grafo; int8 32/64; int8 + originali 32/64; ANN f32 32/64;
  vicini esaustivi f32 come riferimento vettoriale, senza presentarli come verità
  sulla rilevanza. Output invariato a massimo 8 pagine / 4.000 token euristici.
- Cinque ripetizioni per query, ordine ruotato fra varianti. Stessi output reali
  del provider congelati; uso storico disabilitato. LSH/RRF/coverage mantengono
  seed, parametri e soglie del protocollo. Nessuna taratura sullo split valutazione.
- Bootstrap appaiato: 10.000 ricampionamenti, seed 292, IC 95%. Il risultato [0,0]
  descrive delta identici a zero nel campione, non una prova generale di equivalenza.
- Hardware: Apple M4 Max, 36 GiB RAM,
  darwin arm64, Node v24.9.0; controller Apple SSD,
  `APPLE SSD AP1024Z` verificato con `system_profiler SPNVMeDataType`.
- Qwen `qwen3-embedding:0.6b`, 1.024 dimensioni, digest Ollama
  `ac6da0dfba84a81fdbfbaf330198c33cd77c4cdfc53e8bc50eb581914a15621d`.
  Statici: `potion-retrieval-32M` (512) e `potion-multilingual-128M` (256), revisioni
  e hash controllati dal provider. Budget matrice statico **256 MiB**: il modello
  multilingue legge le righe da disco. Nessun download durante le prove.

## Qualità finale

Migliorate/peggiorate/invariate si riferisce a nDCG@8, con confronti appaiati.

| Modello | Pool | nDCG@8 int8 | nDCG@8 rescoring | Delta | IC 95% | Migl./pegg./inv. |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| potion-retrieval-32M | 32 | 0.539040 | 0.539040 | 0.000000 | [0, 0] | 0/0/40 |
| potion-retrieval-32M | 64 | 0.539040 | 0.539040 | 0.000000 | [0, 0] | 0/0/40 |
| potion-multilingual-128M | 32 | 0.530653 | 0.530653 | 0.000000 | [0, 0] | 0/0/40 |
| potion-multilingual-128M | 64 | 0.530653 | 0.530653 | 0.000000 | [0, 0] | 0/0/40 |
| qwen3-embedding:0.6b | 32 | 0.528866 | 0.528866 | 0.000000 | [0, 0] | 0/0/40 |
| qwen3-embedding:0.6b | 64 | 0.528866 | 0.528866 | 0.000000 | [0, 0] | 0/0/40 |

Anche Recall@8, Precision@8, MRR e accuratezza della dichiarazione di copertura
sono conservate nei risultati grezzi, insieme a delta assoluti/relativi e intervalli
per categoria. Precision@8 usa denominatore 8; i casi senza documenti rilevanti
hanno Recall=1 e nDCG=0. L'accuratezza GAP confronta `coverage.sufficient` con il
giudizio di risposta disponibile nel corpus: è una misura operativa limitata,
non una valutazione umana di ogni singola lacuna.

Regressione storica, stesso confronto:

| Modello | Pool | Migl./pegg./inv. |
| --- | ---: | --- |
| potion-retrieval-32M | 32 | 0/0/16 |
| potion-retrieval-32M | 64 | 0/0/16 |
| potion-multilingual-128M | 32 | 0/0/16 |
| potion-multilingual-128M | 64 | 0/0/16 |
| qwen3-embedding:0.6b | 32 | 0/0/16 |
| qwen3-embedding:0.6b | 64 | 0/0/16 |

Le liste finali e la copertura sono identiche fra int8 e rescoring su tutte le
76 query di ciascun modello/pool, oltre alla parità della metrica primaria.

Ogni report conserva le liste finali per query, copertura, recall dei candidati
rispetto ai giudizi e ai vicini f32, pagine distinte, tagli della soglia/pool,
filtri, deduplicazione e fallback. La ricerca diagnostica dei passaggi è una
chiamata separata esclusa dalla latenza della pipeline. Un audit aggiuntivo su
1.368 combinazioni query/variante ricostruisce la sorte di ogni passaggio:
esclusione ANN, soglia ANN, pool, soglia dopo rescoring, filtro, deduplicazione,
selezione semantica. Contatori e passaggi selezionati sono verificati contro il
runtime; le liste finali coincidono con quelle già salvate. Le soglie di produzione
non vengono abbassate: solo l'osservatore espone i candidati prima della soglia.

Sul confronto rescoring-64 delle 40 query di valutazione, le pagine rilevanti
mancanti nell'output finale si fermano ai seguenti stadi:

| Modello | Nessun passaggio trovato da ANN | Passaggi esclusi dalla soglia | Pool / filtro / dedup / selezione finale |
| --- | ---: | ---: | ---: |
| potion-retrieval-32M | 11 | 1 | 0 |
| potion-multilingual-128M | 6 | 5 | 0 |
| qwen3-embedding:0.6b | 9 | 3 | 0 |

I conteggi sono coppie query/pagina; ogni pagina è assegnata allo stadio più
avanzato raggiunto da un suo passaggio. Le pagine recuperate da lessicale/grafo
non sono contate come perdite finali. La deduplicazione conserva un passaggio per
pagina, quindi non perde da sola una pagina con rilevanza annotata. I giudizi sono
a livello di pagina: non rendono ogni suo passaggio rilevante. Questa attribuzione
descrive dove si ferma la pipeline, senza promettere che correggere uno stadio
basterebbe a recuperare la pagina. Dettagli per query e tutte le varianti nei file
`*-losses.json`; nessuna nuova misura di latenza ricavata da questo audit.

## Latenza e chiamate effettive

Misure live end-to-end della retrieval ibrida, 300 query per variante e modello
(60 × 5). Query e coverage attraversano il provider reale; documenti invariati già
costruiti. Provider e filesystem caldi; cache coverage normale del runtime.
Nessuna p99: i campioni non raggiungono la numerosità fissata.

| Modello | Variante | p50 ms | p95 ms | Embedding query | Input coverage | Documenti | Timeout |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| potion-retrieval-32M | i8-64 | 19.53 | 82.76 | 300 | 2500 | 0 | 0 |
| potion-retrieval-32M | rescore-64 | 19.64 | 76.72 | 300 | 2500 | 0 | 0 |
| potion-multilingual-128M | i8-64 | 20.06 | 80.70 | 300 | 2500 | 0 | 0 |
| potion-multilingual-128M | rescore-64 | 19.79 | 80.51 | 300 | 2500 | 0 | 0 |
| qwen3-embedding:0.6b | i8-64 | 108.04 | 173.11 | 300 | 2500 | 0 | 0 |
| qwen3-embedding:0.6b | rescore-64 | 109.78 | 177.81 | 300 | 2500 | 0 | 0 |

La raccolta iniziale dei vettori registra separatamente tempo e input di documenti,
query e coverage. I tempi di qualità con vettori congelati non sono tempi Ollama.
I report live registrano anche il tempo cumulativo delle chiamate query e coverage.

- potion-retrieval-32M, pool 32: delta p95 locale con vettori congelati 0.04 ms (limite +20 ms).
- potion-retrieval-32M, pool 64: delta p95 locale con vettori congelati -0.52 ms (limite +20 ms).
- potion-multilingual-128M, pool 32: delta p95 locale con vettori congelati -0.65 ms (limite +20 ms).
- potion-multilingual-128M, pool 64: delta p95 locale con vettori congelati 0.62 ms (limite +20 ms).
- qwen3-embedding:0.6b, pool 32: delta p95 locale con vettori congelati -0.10 ms (limite +20 ms).
- qwen3-embedding:0.6b, pool 64: delta p95 locale con vettori congelati 0.16 ms (limite +20 ms).

Il budget foreground è 1.500 ms e comprende attesa in coda, priorità, query,
coverage e rescoring. La cancellazione conserva al massimo una chiamata provider
in volo per workspace e rimuove le richieste scadute dalla coda (limite 64).
Tre errori consecutivi aprono il circuito per cinque secondi. Con un provider
che ignora definitivamente la cancellazione il singolo slot resta occupato: il
percorso di base continua a funzionare, ma non si presume un recupero impossibile.

Prova aggiuntiva del modello Qwen scaricato dalla RAM: cinque coppie della stessa
query, rimozione verificata tramite `/api/ps`, nuove istanze indice/cache per ogni
richiesta. Mediana **967,97 ms** (958,67–997,03) dopo unload e **113,32 ms**
(105,55–120,32) a modello caricato: dieci richieste senza timeout entro 1.500 ms.
Conteggio separato: 10 embedding query, 110 input coverage, 5 warmup e zero
documenti rigenerati. Il modello è lasciato caricato. Cinque coppie su una query
non stimano la p95 generale; la cache del filesystem rimane calda.

Campione di memoria esterno alla fine della prova: runner 4.537.024.512 byte RSS,
app Ollama 518.553.600 e servizio 40.763.392. L'API Ollama riporta separatamente
5.776.426.925 byte di allocazione del modello (`size` e `size_vram`). Su memoria
unificata questi valori non vanno sommati all'RSS: sono contabilità diverse,
non una scomposizione dei pesi, un picco del provider o una misura della page cache.

## Scala, memoria, disco e durata

Carico **sintetico**, 1.024 dimensioni, processi separati e cinque riavvii per
configurazione, cache filesystem calda. Modelli/provider esterni esclusi.
KB/passaggio è l'incremento di heap + ArrayBuffers dopo GC e un giro di event loop;
RSS è memoria del processo, non memoria dell'indice né page cache del sistema.
`dual` indica int8 residente più originali su disco e relativi offset/hash.

| Passaggi | Formato | Costruzione s | Riavvio ms | Compattazione ms | Disco MB | KB/passaggio | RSS stabile MB | Picco costruzione MB |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | i8 | 0.39 | 10.97 | 30.20 | 1.25 | 3.90 | 145.8 | 145.6 |
| 1,000 | dual | 0.61 | 16.74 | 98.01 | 5.50 | 4.22 | 150.0 | 149.9 |
| 1,000 | f32 | 0.37 | 12.24 | 37.96 | 4.33 | 6.92 | 158.4 | 158.4 |
| 10,000 | i8 | 2.97 | 55.49 | 81.58 | 12.55 | 2.21 | 275.1 | 275.0 |
| 10,000 | dual | 5.12 | 69.43 | 770.22 | 55.04 | 2.37 | 307.6 | 308.3 |
| 10,000 | f32 | 2.96 | 71.14 | 126.28 | 43.27 | 5.27 | 360.9 | 360.9 |
| 50,000 | i8 | 15.18 | 287.07 | 300.54 | 62.81 | 2.12 | 475.1 | 475.5 |
| 50,000 | dual | 35.13 | 339.09 | 3813.38 | 275.29 | 2.27 | 564.0 | 566.1 |
| 50,000 | f32 | 16.00 | 381.04 | 542.75 | 216.41 | 5.17 | 728.4 | 728.9 |

Migrazione separata su 10.000 passaggi sintetici, una prova per origine:
f32 → dual in 3.72 s con **zero** embedding ripetuti;
int8 senza originali → dual in 5.03 s con 10.000 embedding
necessari. Non sono latenze di un modello reale. I successivi cinque riavvii non
rigenerano documenti. Riprodurre con `--migrate-from=f32` oppure `--migrate-from=i8`
insieme a `--dtype=i8 --rescore --scale=10000`.

Tutti i riavvii riproducono i risultati senza nuovi embedding dei documenti.
Il risparmio di RAM va confrontato con f32 residente; dual costa più di int8 in
memoria e soprattutto su disco. I log separano letture/scritture e byte logici
ANN/originali. Non sono misure dei byte fisicamente trasferiti dall'SSD: lock,
metadati filesystem, errori parziali e cache OS non sono conteggiati.

Soak: 2 workspace, 1000 passaggi ciascuno,
156 query durante la costruzione e 400 giri
successivi per workspace (956 query totali). Vettori originali
in cache sempre ≤1 MiB/workspace, nessuna contaminazione dei risultati.
Incremento heap + ArrayBuffers fra campioni stabilizzati iniziale/finale:
1.05 MiB; serie completa nel log.
Questa è una prova di durata limitata, non una garanzia sull'uptime di produzione.

## Correttezza e gate

- `npm run verify`: repository hygiene, TypeScript e tutti gli 89 file di test.
- `npm run eval:gates`: tutti i 19 gate, senza riduzione delle soglie.
- Suite specifica: 12 test passati, inclusa una traversata della soglia 0.55 senza
  modificarla e coverage invariata; originali autentici e query riusata, migrazione int8/f32,
  file mancanti/corrotti, offset/generazioni errati, cache/I/O, cancellazione,
  configurazione assente/incompleta, circuito e recupero HTTP/statico.
- Fault injection fra scrittura originali e journal, e fra rotazione originali e
  snapshot; ripresa di batch parziali, pagine cambiate/cancellate, modifica durante
  lettura. Queste prove simulano interruzioni nei punti critici; non sono power cut
  fisici del dispositivo.
- Compatibilità con rescoring attivo: 25 test preesistenti di indice, inclusi
  scrittori in processi distinti. Gate lifecycle: 16 query full/compact identiche
  su due riavvii, zero rigenerazioni; 1.000 passaggi completati sotto query continue.
- Build e smoke test del pacchetto installato: stdio, HTTP e adapter desktop.
- Ranking d'uso: ablation dedicata passata su quattro pool, senza perdita delle
  protezioni lessicali. Audit runtime: zero vulnerabilità segnalate; 71 pacchetti
  con firme verificate e 19 con attestazioni. Coerenza dei manifest passata per
  l'attuale versione 2.9.1; non è una validazione di pubblicazione della 2.9.2.

## Limiti e attività non dichiarate validate

HDD reale, cache OS realmente fredda e traffico reale non sono disponibili/misurati.
Non si sostituiscono con ritardi simulati. La memoria esterna del provider ha un
campione puntuale separato, ma manca l'attribuzione della page cache del sistema.
La scala 10k/50k usa dati sintetici, non un corpus reale annotato di quella dimensione.
Il corpus annotato non ha revisione umana indipendente e i negativi non sono
esaustivamente giudicati; una generalizzazione sulla qualità richiede altri dati.
L'attribuzione per stadio non è una prova causale controfattuale; non si rivendica
assenza di leak per durate arbitrarie. Il budget del runtime è cooperativo e non interrompe una singola
operazione sincrona JavaScript già in esecuzione. Le caselle della milestone che
richiedono queste evidenze restano esplicitamente aperte/limitate.

## Riproduzione e risultati grezzi

```sh
npm run verify
npm run eval:gates
KNOWLEDGE_RAIL_SEMANTIC_RESCORE=true node --import tsx --test tests/semantic-index.test.ts
KNOWLEDGE_RAIL_SEMANTIC_RESCORE=true npm run eval:semantic:lifecycle
node --import tsx benchmarks/semantic-rescoring-eval.ts --provider=potion-retrieval-32M --assets=/path/to/installed-models --live
node --import tsx benchmarks/semantic-rescoring-eval.ts --provider=potion-multilingual-128M --assets=/path/to/installed-models --live
node --import tsx benchmarks/semantic-rescoring-eval.ts --provider=ollama --config=/path/to/client-config.json --live
node --import tsx benchmarks/semantic-cold-provider-bench.ts --config=/path/to/client-config.json --live
node --import tsx benchmarks/semantic-rescoring-losses.ts
node --expose-gc --import tsx benchmarks/semantic-durability-bench.ts --dtype=i8 --rescore --scale=50000 --reloads=5
node --expose-gc --import tsx benchmarks/semantic-rescoring-soak.ts
npm run build
npm run package:smoke
```

Ripetere la scala per 1.000/10.000/50.000 e per i8 senza `--rescore` e f32.
La prova a modello scaricato richiede i vettori Qwen salvati dal benchmark
precedente e scarica/ricarica esplicitamente il modello Ollama configurato.
L'audit delle perdite usa soltanto i risultati salvati, senza chiamate al provider.
Raw locali e vettori congelati: `benchmarks/results/semantic-rescoring-292/`,
esclusi da Git secondo la convenzione del repository. `manifest.json` registra
SHA-256 e dimensioni dei file. I report `*-report.json` contengono tutte le varianti,
le differenze per query/categoria e i descrittori; `*-vectors.json` preservano gli
output reali riusati. `runtime-source.tar.gz` conserva i sorgenti runtime esatti
misurati; `evaluation-source.tar.gz` preserva script, fixture e test aggiunti;
`implementation.patch` conserva il diff dei file tracciati. Le fixture,
il protocollo e gli script sono versionabili.

## Estensione successiva a questa prima fase

Su richiesta dell'utente sono stati aggiunti confronti candidati/ANN/reranker,
continuazioni del contesto, storia delle evidenze e persistenza HNSW. Il grafo
ANN rimane separato dal grafo knowledge. La prima fase e il suo digest restano
storici; il runtime finale dell'estensione e le nuove misure sono documentati
nel [rapporto dedicato](retrieval-extension-results-2.9.2.md).
