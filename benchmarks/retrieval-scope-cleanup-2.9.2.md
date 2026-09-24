# Semplificazione della retrieval 2.9.2

24 settembre 2026. Decisione esplicita dell'utente; package 2.9.1, modifiche
Unreleased, nessun commit/tag/pubblicazione.

## Perimetro

Rimossi opzione di rescoring, originali float32 aggiuntivi, lookup/cache, migrazioni
verso il doppio formato e relativa diagnostica. Float32 come formato singolo resta
un riferimento disponibile. Chiusi ulteriori sweep arbitrari di pool/parametri;
conservati la matrice congelata di regressione e l'espansione progressiva dei
candidati. Restano storia/provenienza, budget/fallback/freschezza, ricerca esatta,
HNSW persistito separato e reranker opzionale.

Gli indici sperimentali compatibili riusano i vettori int8 e l'eventuale topologia
HNSW. Riferimenti agli originali sono ignorati. Il checkpoint riscrive i metadati
e rimuove il sidecar solo dopo snapshot e confine journal durevoli; la lettura non
modifica storage. Un symlink viene rimosso senza seguire o modificare il bersaglio.

[Report iniziale](release-readiness-2.9.2.md),
[estensione](retrieval-extension-results-2.9.2.md) e
[sorgenti archiviati](archive/semantic-rescoring-292/README.md) conservano le misure
negative e i runtime corrispondenti. Non si attribuiscono quelle latenze al nuovo
runtime.

## Verifica del runtime semplificato

SHA-256 dell'inventario ordinato percorsi+contenuti in `src/`:
`20b639c92f4be5a158380054fee25a1cc5f2818d1500d65a84c8fd45592d9ed7`.

- `npm run verify`: tutti i 92 file di test passati.
- 52 test mirati: runtime/indice, HNSW, reranker, completezza/storia. Inclusi riuso
  senza embedding, sidecar mancante/corrotto/symlink, checkpoint interrotto,
  freschezza canonica, cancellazione HTTP e opzione ritirata senza effetto sulla cache.
- Tutti i 19 quality gate passati, senza variazioni delle soglie.
- Build e package smoke passati: 684 file, tarball 1.086.890 byte, stdio circa 321 ms.
- 5.400 confronti di parità: 100 query × 18 varianti × 3 provider, percorsi finali e
  coverage identici al runtime misurato `df08d8a80249f4d8a6c549503b05ec9df1a86c6c3500f4fe0b6c3c79abfe4fe6`.

Le prove di parità riusano embedding e score reali congelati: nessuna nuova
inferenza, qualità indipendente o latenza live viene dedotta da questi confronti.
Le copie dei riferimenti e i risultati nuovi sono separati in
`benchmarks/results/retrieval-cleanup-292/`; i raw precedenti restano invariati.

## Reranker e limiti

Il cross-encoder precedente era `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1`,
Python/PyTorch CPU a quattro thread, batch 16, 512 token, modello già residente.
Qwen3 Embedding 0.6B era invece su Ollama. Il reranker aveva miglioramenti di ranking
anche con LSH; nessuna delle 40 chiamate con budget 500 ms si applicava in tempo.
La mediana a completamento era circa 1.03 s, con possibile sovrapposizione ad altri
benchmark. I 500 ms sono una scelta operativa configurabile; questa prova non
misura GPU/Metal, runtime ottimizzati o due modelli residenti su Ollama.

L'integrazione HTTP resta portabile: nessuna dipendenza obbligatoria da Metal o
macOS. Accelerazione e modelli appartengono al backend scelto, con fallback quando
non è configurato o non risponde nel budget. I limiti ambientali M5, i giudizi non
indipendenti e il corpus limitato restano documentati.
