# Esperimento rescoring 2.9.2 archiviato

Il 24 settembre 2026 l'utente ha accettato la rimozione del rescoring float32 e
della persistenza doppia dal runtime, dopo il beneficio nullo misurato. Questi
sorgenti conservano l'esperimento completato; non fanno parte dei benchmark attivi
né della compilazione TypeScript. Il suffisso `.txt` evita che vengano eseguiti
accidentalmente contro un runtime che non offre più quelle API.

Per riprodurre le misure storiche occorrono il runtime corrispondente, i fixture,
gli output congelati dei provider e i comandi dei protocolli originali. Ripristinare
i sorgenti nella posizione `benchmarks/` originale, togliendo solo il suffisso
`.txt`, in una copia isolata del runtime archiviato. Non usare il runtime corrente.

- [Protocollo originale](../../semantic-rescoring-protocol-2.9.2.md)
- [Risultati e identità del runtime](../../release-readiness-2.9.2.md)
- [Estensione e bundle successivi](../../retrieval-extension-results-2.9.2.md)

I bundle locali e i manifest restano in `benchmarks/results/semantic-rescoring-292/`
e `benchmarks/results/retrieval-extension-292/`, ignorati da Git. I report conservano
le limitazioni delle misure. Il benchmark attivo `semantic-durability-bench.ts`
continua a verificare i formati singoli int8/float32 e la persistenza HNSW.

Sono chiusi ulteriori confronti indiscriminati di pool e parametri nella 2.9.2.
Restano la matrice di regressione già congelata e l'espansione progressiva dei
candidati: il limite di presentazione non decide la rilevanza delle altre evidenze.
