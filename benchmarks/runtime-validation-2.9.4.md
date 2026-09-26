# Protocollo Mac — punti 1, 2, 4 e 5 della milestone 2.9.4

Eseguire sullo stesso checkout, con gli stessi pesi Qwen3-Embedding 0.6B e BGE Q8
delle prove precedenti. Registrare commit/working tree, versione di Node, Ollama,
llama.cpp, digest completo dei pesi e comando di avvio dei servizi. I risultati
Linux non sostituiscono questa misura. Gli script non avviano né arrestano servizi.

## Preparazione

```bash
npm ci
npm run check
npm run build
export KNOWLEDGE_RAIL_EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1
export KNOWLEDGE_RAIL_EMBEDDING_MODEL=qwen3-embedding:0.6b
export KNOWLEDGE_RAIL_EMBEDDING_DIMENSIONS=1024
export KNOWLEDGE_RAIL_EMBEDDING_TIMEOUT_MS=120000
export KNOWLEDGE_RAIL_USAGE_RANKING=0
```

I benchmark usano una copia temporanea della fixture pubblica, nella lingua della
knowledge (inglese). Non copiano la knowledge del cliente. L'output deve essere un
file nuovo: i report non vengono sovrascritti.

## llama-server: uno slot, poi quattro

Avviare esternamente il BGE Q8 con la configurazione del README e **uno slot**.
Adattare la porta al server realmente avviato; il numero di slot nello script è
un'etichetta e deve corrispondere al comando del server. Usare un contesto totale
appropriato al numero di slot, mantenendo lo stesso contesto per singolo slot.

```bash
unset KNOWLEDGE_RAIL_RERANK_BASE_URL
export KNOWLEDGE_RAIL_RERANK_PROVIDER=http
export KNOWLEDGE_RAIL_RERANK_ENDPOINT=http://127.0.0.1:8080/v1/rerank
export KNOWLEDGE_RAIL_RERANK_MODEL=bge-reranker-v2-m3-q8_0
# Impostare anche KNOWLEDGE_RAIL_RERANK_VERSION al digest/versione effettivo.
npm run bench:runtime-validation -- --slots=1 --queries=100 --iterations=3 --output=/tmp/kr-mac-http-1.json
```

Il runner alterna l'ordine dei pool da 24 e 32 candidati. Registra qualità,
score per pagina, latenza di ogni ricerca, timeout/fallback, preparazione del
modello, ripristino dell'indice e confronto fra formato completo e compatto.
`--queries=100` usa tutti i positivi disponibili nella fixture di base, riportando
il numero effettivo; la diagnosi successiva copre anche i negativi e l'estensione.

Riavviare esternamente con **quattro slot** e ripetere cambiando etichetta e file:

```bash
npm run bench:runtime-validation -- --slots=4 --queries=100 --iterations=3 --output=/tmp/kr-mac-http-4.json
```

Non confrontare soltanto le medie. Separare la prima ricerca dopo la preparazione
(`firstQueryAfterPreparation`) dalle successive, e confrontare p50/p95 a caldo,
tempi di preparazione e memoria. Tenere separati sviluppo e verifica.

## Ollama come riferimento del reranker

Usare il modello BGE Q8 preparato e calibrato già previsto dal progetto:

```bash
unset KNOWLEDGE_RAIL_RERANK_ENDPOINT
export KNOWLEDGE_RAIL_RERANK_PROVIDER=ollama
export KNOWLEDGE_RAIL_RERANK_BASE_URL=http://127.0.0.1:11434
export KNOWLEDGE_RAIL_RERANK_MODEL=knowledgerail-bge-reranker-v2-m3:q8_0
npm run bench:runtime-validation -- --slots=1 --queries=100 --iterations=3 --output=/tmp/kr-mac-ollama.json
```

Qui `slots=1` identifica il riferimento, non configura la concorrenza di Ollama.
Se la calibrazione rifiuta runtime o modello, registrare il motivo: un fallback
non va contato come un reranking più veloce.

## Negativi nel dominio e dimensione del pool

Con ciascuna configurazione del reranker, produrre report distinti:

```bash
node --import tsx benchmarks/coverage-diagnostics.ts --provider=http --translate --rerank-pool=24 --label=mac-http-1-pool24 --output=/tmp/kr-mac-coverage
node --import tsx benchmarks/coverage-diagnostics.ts --provider=http --translate --rerank-pool=32 --label=mac-http-1-pool32 --output=/tmp/kr-mac-coverage
```

Cambiare le etichette per quattro slot e per Ollama. Questi report coprono 136
query; distinguono recupero, falsi gap e falsi sufficienti e registrano gli score
del reranker. Il `--provider=http` qui seleziona gli **embedding**, mentre il
reranker segue le variabili di ambiente configurate sopra.

Il default a 24 candidati si può valutare soltanto se conserva le evidenze attese
e non peggiora i negativi nel dominio sullo split di verifica, oltre al corpus più
ampio previsto dalla milestone. Non scegliere la soglia sui risultati di verifica.
Uno score di rilevanza alto non certifica che la risposta sia presente.

Valutare anche il compromesso fra falsi sufficienti e falsi gap, senza pretendere
zero errori. Dopo ogni diagnosi con reranker applicato a tutte le query:

```bash
node --import tsx benchmarks/coverage-tradeoff-eval.ts --input=/tmp/kr-mac-coverage/mac-http-1-pool32.json --max-false-gap-rate=0.10 --output=/tmp/kr-mac-tradeoff-http-1-pool32.json
```

Il limite del 10% è un'ipotesi di confronto esplicita. Il valutatore sceglie una
soglia sullo sviluppo e la applica agli altri split senza riadattarla. Registra
separatamente errori sui negativi nel dominio, risposte valide perse ed errori
tra i casi dichiarati sufficienti. Non modifica il runtime. Non trasferire una
soglia a un altro modello senza calibrazione; gli split esistenti, già esaminati,
servono per regressione e vanno affiancati da un set nuovo prima dell'accettazione.

## Memoria, disponibilità e freddo reale

- Passare `--service-pids=PID_OLLAMA_RUNNER,PID_LLAMA_SERVER` al runner per campionare
  l'RSS dei processi corretti. L'RSS non è memoria GPU e non si sommano le porzioni
  condivise come se fossero memoria fisica distinta. La memoria unificata va
  osservata sul Mac, registrando anche pressione di memoria e swap.
- Ripetere una prova con entrambi disponibili, con solo embedding, con solo
  reranker e senza entrambi, fermando i servizi esternamente oppure usando endpoint
  locali deliberatamente non in ascolto. Registrare i warning e verificare che
  rimangano recupero lessicale e grafo; il reranker resta utilizzabile se manca
  soltanto il servizio di embedding.
- Il runner distingue prima indicizzazione e ripristino persistito, ma non scarica
  i modelli né svuota la cache del sistema operativo. Per il **freddo fisico** serve
  una sessione separata: modelli non residenti, indici già persistiti, apertura del
  client reale e prima domanda immediata. Registrare preparazione, prima risposta,
  eventuale fallback e domanda successiva. Non confrontare questi tempi con i dati
  a caldo né aumentare il budget semantico per nascondere il timeout.

## P3, separato dalle scelte di runtime

```bash
npm run eval:relational-reranking -- --validate-only
npm run eval:relational-reranking -- --output=/tmp/kr-mac-relational.json
```

Il secondo comando usa il reranker configurato e confronta la stessa fixture
congelata di Linux. È un esperimento su percorsi verificati sintetici, non una
modifica del testo passato al reranker nel retrieval di produzione.
