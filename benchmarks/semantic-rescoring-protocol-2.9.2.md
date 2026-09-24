# Protocollo 2.9.2 — congelato prima dei confronti

24 settembre 2026, baseline Git `a5d5e185c41625fbc955340a7d390d5e95fbcb93`.
Il confronto usa gli stessi embedding originali per tutte le varianti. Il manifest
di ogni esecuzione registra SHA-256 di corpus, query, giudizi e vettori, descrittore
del provider, runtime e hardware. Corpus reale: documentazione di questo repository;
query annotate costruite per questa valutazione, non traffico di utenti. Conservare
separatamente le 16 query storiche. Lo split aggiuntivo è 20 sviluppo / 40 valutazione.
Congelare il dataset prima di eseguire le varianti; nessuna taratura sul secondo split.

Metrica primaria: nDCG@8 sui 40 casi separati, giudizi 0/1/2. Adozione solo con
delta positivo e limite inferiore dell'intervallo bootstrap appaiato al 95% > 0
(10.000 ricampionamenti, seed 292). Riportare anche Recall@8, Precision@8, MRR,
copertura/GAP, candidati rispetto ai giudizi e ai vicini esaustivi, categorie e
singole query. Il default rimane int8 quando manca evidenza sufficiente.

Parametri invarianti: LSH 10 tabelle, 10 bit, 4 probe, seed
`knowledge-rail-semantic-lsh-v1`, soglia ANN 0.55; RRF k=60 e pesi 1/0.7/0.65;
coverage 0.72/0.80 invariata; uso storico vuoto, output massimo 8 pagine / 4.000
token euristici. Pool 32 e 64, nessun pool 128 o widening semantico automatico.
Varianti: lessicale/grafo; int8 32/64; int8 + originali 32/64; ANN float32 32/64;
esaustivo float32 come riferimento vettoriale (non giudizio di rilevanza).

Profilo misurabile locale SSD, dimensioni fino a 1.024: budget semantico totale
1.500 ms, comprensivo di coda, priorità, embedding, coverage e I/O. Costo aggiuntivo
p95 del rescoring <= 20 ms rispetto allo stesso pool, 5 ripetizioni per query
(prima separata, successive calde). Nessuna p99 con meno di 1.000 campioni.
Cache originali <= 1 MiB/workspace, pool <= 64 nel confronto, API sperimentale
limitata a 128; un lettore per workspace, blocchi <= 256 KiB, massimo 4 KiB di
gap per lettura e 64 KiB extra totali/query. I/O <= pool * dimensioni * 4 + 64 KiB
+ header. Al massimo 64 richieste in coda, una richiesta embedding in volo per
workspace; circuito aperto dopo 3 errori consecutivi, recupero dopo 5 secondi.
Le operazioni background non consumano il budget foreground ma la loro attesa sì.

Scala sintetica dichiarata: 1k/10k/50k passaggi, int8, doppio formato, float32;
RSS/heap/ArrayBuffers, spazio disco, costruzione, riavvio e compattazione. Separare
memoria del provider e cache OS. Cache applicativa vuota non equivale a cache OS
fredda. HDD, provider realmente freddo e traffico reale restano non misurati in
assenza dell'hardware/dati. Misure provider live separate dai vettori congelati.
Test di correttezza e gate esistenti mantengono tutte le soglie.

Dataset congelato: `benchmarks/fixtures/semantic-rescoring-292.json`, SHA-256 `8b9e3f5ed32ef95a87865a006a37baef447f697019cf396523f8b1e08fc14fc3`; 59 sezioni di documentazione reale, 60 query annotate (20/40). Giudizi redatti dall’agente, senza revisione umana indipendente; i negativi non esaustivamente giudicati sono un limite dichiarato.
