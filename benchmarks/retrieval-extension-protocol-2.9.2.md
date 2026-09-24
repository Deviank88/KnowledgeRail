# Protocollo congelato — estensione retrieval 2.9.2

24 settembre 2026, prima di eseguire i confronti dell'estensione. La precedente
valutazione del rescoring è conservata in `semantic-rescoring-protocol-2.9.2.md`.

- Sviluppo: le 20 query originarie. Le 40 originarie già analizzate diventano
  regressione, non un nuovo holdout. Nuove 40 formulazioni IT/EN congelate in
  `fixtures/retrieval-extension-292.json`, SHA-256
  `345a35dace5ac552170f823b46ceb07365426b81198cad764e156ed60f320518`.
  Pagine/giudizi invariati: 59 sezioni, 124 passaggi. Queste nuove formulazioni
  non costituiscono nuovi domini o un'annotazione umana indipendente.
- Modelli embedding: gli stessi tre della prima fase, con documenti congelati;
  incorporare soltanto le nuove query/coverage, registrando le chiamate reali.
- Baseline: LSH 10 tabelle/10 bit/4 probe, soglia .55, int8, pool 32.
  Varianti: stessa baseline a pool 64; top-k 32/64; LSH top-k con 8 probe;
  esatta top-k 32/64; HNSW top-k 32/64, M16, efConstruction100, efSearch64.
  Nessun cambiamento a embedding, RRF, coverage .72/.8, uso storico disabilitato.
- Reranker: cross-encoder multilingue esplicito, pool 32/64 dall'unione ibrida,
  massimo 2048 caratteri/documento e 131072 totali. Score del reranker separato
  dalla sufficienza. Nessun dato di valutazione nei prompt o nel modello.
- Output: massimo 8 evidenze/4000 token euristici. Cinque ripetizioni locali;
  tempi con embedding congelati distinti dalle chiamate reali al reranker.
- Metrica primaria nDCG@8. Recall@8, Precision@8, MRR, recall pool, candidati
  distinti, GAP/assenza e casi peggiorati restano visibili. Bootstrap appaiato
  10000 campioni, seed292; promozione default solo con limite inferiore IC95% >0
  sul nuovo holdout e nessuna regressione obbligatoria, dopo selezione su sviluppo.
- Budget: foreground semantico1500ms; reranker massimo500ms cumulativi attraverso
  widening, incluso nel tempo foreground quando il canale semantico è attivo.
  Misurare separatamente qualità a completamento del cross-encoder e percorso
  effettivo con deadline: una misura offline lenta non giustifica l'adozione.
  Motore: p95 locale aggiuntiva ≤20ms sul corpus annotato. Scala sintetica
  1k/10k/50k/1024 dimensioni: target p95 query ≤100ms e RSS indice ≤1GiB a50k,
  costruzione/ripristino riportati senza nascondere costi di rebuild del grafo.
- Semantica e reranking restano opzionali. Configurazione assente/incompleta,
  errori, score invalidi e cancellazioni devono preservare il percorso di base;
  nessun download o cambio di modello durante il normale retrieval.
- HDD/cacheOS fredda, attribuzione page cache e traffico reale restano limiti
  della sessione. Nessuna modifica delle soglie dei gate per promuovere varianti.

Riferimenti algoritmici: [HNSW](https://arxiv.org/abs/1603.09320),
[parametri hnswlib](https://github.com/nmslib/hnswlib/blob/master/ALGO_PARAMS.md),
[cross-encoder multilingue](https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1).

## Chiarimento prima dei risultati dell'estensione

I pool top-k sono lotti sperimentali per confrontare i motori, non quote finali
che rendono irrilevanti le evidenze successive. Aggiungiamo espansione progressiva
dei candidati e continuazioni verificabili del contesto, con limiti di risorse
dichiarati. Misuriamo separatamente richiamo nel pool e nei primi risultati.
Il 90% citato nella discussione era un esempio: nessun parametro deriva da esso.
La validità usa intervalli e provenienza registrati; una riattivazione deve essere
una nuova evidenza esplicita, senza riscrivere il passato.

## Iterazione aggiunta su richiesta: grafo persistito

Dopo la misura del costo di ricostruzione, l'utente richiede la persistenza HNSW
e conferma che il grafo ANN deve restare separato da quello knowledge. Il nuovo
artefatto binario deve legare vettori, parametri e collegamenti esatti; corruzione
o journal successivo invalidano soltanto il grafo. Confrontare a 1k/10k/50k il
ripristino di cinque nuove istanze dell'indice, e a 50k anche cinque processi nuovi.
Riportare tempi di costruzione, caricamento, prima query, memoria, byte del grafo
e totale su disco. Cache OS non svuotata. Nessuna soglia di qualità o query
cambia; ripetere la valutazione sul runtime finale, senza tarare sul holdout.
