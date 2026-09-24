# Prove di reranker piccoli: Ollama e riferimento HTTP — 2.9.2

24 settembre 2026. Ollama locale 0.34.3, macOS, package KnowledgeRail 2.9.1 con
modifiche Unreleased. Nessun rilascio, cambio della configurazione MCP o del server
Ollama. Il rapporto distingue compatibilità, qualità su corpus congelato e latenza live.

## Esito attuale e decisione accettata

Il reranker resta opzionale **tramite Ollama**. Configurarlo nell'`env` MCP lo attiva
automaticamente, come gli embeddings. Su richiesta esplicita dell'utente non ha un
timeout KnowledgeRail predefinito: si attende il completamento dello scoring e il
suo tempo non consuma il budget separato degli embeddings. Configurazione assente,
errori del servizio, modello incompatibile o score invalidi mantengono il recupero
senza reranker. Un limite positivo resta solo un override amministrativo esplicito.

BGE v2 M3 Q8, 568M parametri e circa 636 MB, è il modello verificato. Il percorso
nativo implementato è limitato a Ollama 0.34.3 e alla conversione con checksum
verificato, preparata dallo script distribuito. Le conclusioni iniziali negative
su Qwen e sul formato BGE sono conservate sotto come storia della diagnosi; la
successiva verifica dello score BGE le supera per questo preciso percorso.
Nessun server aggiuntivo è necessario. Nessun cambio alla configurazione MCP reale
né rilascio 2.9.2 è stato effettuato.

## Protocollo e risultati

Modelli installati esplicitamente con `ollama pull`, senza caricare modelli più grandi:

| Modello | Download pesi | Digest manifest locale | Score disponibili su 22 coppie |
| --- | ---: | --- | ---: |
| `dengcao/Qwen3-Reranker-0.6B:Q8_0` | 639.150.816 byte | `c9da58824943d42f581f2012013dd469bae26bbc9cc04b54fcbefdc34110e7e8` | 0 |
| `dengcao/Qwen3-Reranker-0.6B:F16` | 1.197.629.792 byte | `d9cf33bea10fd318434af5b09425a3b7d1b9988b130899612bf3836aed13c013` | 3 |

Per ogni modello: due coppie italiane di controllo (pertinente/estranea) e 20 coppie
del corpus congelato. Campione deterministico: chiavi ordinate, prima coppia di
ciascuna query distinta fino a 20; nessuna selezione in funzione della risposta.
Il file sorgente delle coppie ha SHA-256
`5ebcd5fdc9181ebe90755391b9e108a8a45d370427f5e8eddaf92e227db630cd`.
Non è un campione bilanciato o un giudizio indipendente di qualità.

Usati prompt raw e istruzione della
[scheda ufficiale Qwen](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B),
`POST /api/generate`, `logprobs=true`, `top_logprobs=20`, un token generato,
temperatura 0, repeat penalty 1, seed 292, contesto 4096 e keep-alive 15 minuti.
Lo score richiede i logaritmi delle probabilità degli esatti token `yes` e `no`
nella stessa posizione: `sigmoid(logP(yes) - logP(no))`.
Il limite API a 20 alternative è documentato nel
[codice Ollama](https://github.com/ollama/ollama/blob/main/server/routes.go).

- Q8: 22 risposte `,`, alternative con probabilità uguali, nessuno score utilizzabile.
  I controlli preliminari hanno riprodotto l'anomalia anche con CPU, senza logprobs
  e con chat; non è quindi attribuibile al solo Metal o alla richiesta di logprobs.
- F16: nelle due coppie di controllo distingue `Yes` da `No`. Nel campione complessivo
  entrambi i token esatti necessari allo score compaiono solo in 3 risposte su 22.
  Una risposta testuale corretta non fornisce automaticamente lo score del modello.
- Le probabilità mancanti restano mancanti: nessuna sostituzione con zero,
  conversione arbitraria di maiuscole o risposta sì/no trasformata in score binario.
  Non sono state attribuite metriche di ranking o latenze operative a questi esiti.

La causa completa dell'anomalia Q8 non è isolata; la prova non dimostra che ogni
conversione del modello o ogni versione di Ollama fallisca. F16 mostra attività
utile, ma questo contratto di scoring non è affidabile nel campione. Non è stata
aggiunta una nuova configurazione runtime basata su risposte parziali.

## Alternativa non Qwen: BGE Reranker v2 M3

Su richiesta dell'utente è stato provato
[`qllama/bge-reranker-v2-m3:q8_0`](https://ollama.com/qllama/bge-reranker-v2-m3:q8_0),
567.753.729 parametri, 635.674.568 byte installati, manifest
`06e0e64a6f61718d27f8ad90abb04d62ffdb0af416f270b273aabd43cbfb91cd`.
È un cross-encoder BGE/XLM-R multilingue, distinto dalla famiglia Qwen. La
[scheda BAAI](https://huggingface.co/BAAI/bge-reranker-v2-m3) descrive lo score della
coppia query/documento prodotto dalla testa di classificazione.

La conversione contiene i quattro tensori `cls.*`, inclusa l'uscita scalare, ma
non dichiara `bert.pooling_type`. Su Ollama le richieste provocano errore HTTP 500
con assertion `n_outputs_max <= cparams.n_outputs_max`. Una copia locale distinta,
`kr292-bge-reranker-v2-m3-q8-rank`, aggiunge soltanto `bert.pooling_type=4` (RANK).
I byte dei tensori sono verificati identici con SHA-256; nessuna modifica al modello
originale o al server Ollama. Blob originale `4bf51534d8d1aebced4de6eca4a8a39bd207170b42e3dcffa7718d194771a713`,
copia `092f088dd16882bb872e09ac18b624534c6d53780006e31be6fefcc621246fc2`.

Con la copia, `/api/embeddings` risponde e il primo valore cambia coerentemente
fra un documento pertinente (8,79) e uno estraneo (-10,99). Tuttavia la risposta
ha 1024 valori, con una coda non nulla non spiegata dal classificatore scalare;
inizialmente non era identificato un contratto di scoring valido. `/api/embed`
normalizza il vettore, mentre `/api/rerank` restituisce 404. La verifica successiva
riportata sotto identifica il logit esatto e limita esplicitamente la compatibilità. Memoria dichiarata dalla copia su
`/api/ps`: 696.610.979 byte, contesto 2048, insieme agli embeddings.

Per isolare il modello è stato avviato temporaneamente `llama-server`, già incluso
nell'installazione locale di Ollama, con endpoint HTTP `/rerank` separato sulla
porta 18092. Versione 0.4.1-dev, commit `391fac164`. Questo endpoint restituisce
correttamente un risultato indicizzato per documento ed è compatibile con
`HttpRerankProvider` esistente; **non è una chiamata all'API Ollama**. La relativa
[interfaccia è documentata da llama.cpp](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).

Configurazione: stesso GGUF Q8, pooling rank, contesto/batch/ubatch 2048, uno slot,
quattro thread, 99 layer GPU. Il batch iniziale 512 ha rifiutato un input da 515
token: corretto a 2048, senza accorciare il documento. Tutte le 3.457 coppie
congelate hanno prodotto score finiti con indici completi, in 100 richieste e circa
120,74 secondi complessivi. Non è la latenza di una singola richiesta KnowledgeRail.
RSS campionato del processo di riferimento: 1.377.024 KiB, non picco garantito.
La matrice e i raw sono in `benchmarks/results/ollama-reranker-292/bge-reference/`.

### Qualità e latenza del riferimento BGE

Rieseguita la matrice congelata: 100 query, 18 varianti, cinque ripetizioni con
ordine ruotato; stessi embedding reali e nuovi score reali BGE. Questo confronto
misura il ranking, separatamente dalle chiamate live. Il runtime rimane
`20b639c92f4be5a158380054fee25a1cc5f2818d1500d65a84c8fd45592d9ed7`.

| Variante | nDCG@8 sulle 40 parafrasi | Recall delle evidenze mostrate | Recall del pool |
| --- | ---: | ---: | ---: |
| LSH senza reranker | 0,6396 | 0,850 | 0,925 |
| LSH + BGE | 0,7010 | 0,875 | 0,925 |
| Esatta/HNSW senza reranker | 0,6189 | 0,850 | 1,000 |
| Esatta/HNSW + BGE | 0,7346 | 0,950 | 1,000 |

Variante scelta sullo sviluppo: esatta + reranking 32, non sul risultato finale.
Il delta rispetto al baseline LSH è +0,0950, IC95% [-0,0147; +0,2086]: il campione
non esclude un effetto nullo. Tredici query migliorano e cinque regrediscono.
Con LSH migliorano dieci query e ne regrediscono cinque. Le parafrasi riusano
giudizi già esistenti: nessuna validazione umana indipendente o garanzia generale.
Questi sono i pool di confronto già congelati; nessun nuovo limite o default
di retrieval viene scelto da questa prova.

Il flag complessivo `coverage.sufficient` non cambia nelle 100 query rispetto al
motore corrispondente senza reranker. La coverage dell'estratto mostrato e le lacune
di presentazione possono invece cambiare (nove query LSH, dodici esatta): non si
dichiara che l'intero oggetto coverage sia invariato. Lo score non verifica la
verità del contenuto: anche la frase falsa «la capitale della Francia è Berlino»
riceve un alto score di rilevanza. Validità e provenienza restano controlli distinti.

La successiva prova HTTP usa `HttpRerankProvider` e `RerankSession` reali, venti
query con pool di confronto 32/64: 40 chiamate entro budget 500 ms, altre 40 con
budget di completamento 30 s. Nessuna delle prime 40 applica reranking; le altre
40 riescono, mediana 1.895,97 ms, p95 2.631,40 ms, massimo 2.783,80 ms. Il modello
è residente. Le chiamate dopo una cancellazione possono includere lavoro ancora
in corso sul server: è parte del comportamento osservato del provider. Un tentativo
di latenza sovrapposto alla matrice è stato interrotto e scartato; il risultato
riportato è stato raccolto dopo la conclusione della matrice.

Controllo CPU con quattro thread e GPU layers 0, usando il **GGUF originale** e
`--pooling rank` esplicito: successo su tre documenti EN (~42 ms), due IT (~48 ms)
e un pool congelato di 32 documenti (8.021,94 ms). È prova di esecuzione CPU, non
equivalenza numerica perfetta fra backend o latenza su Windows/Linux. Per esempio,
la coppia pertinente EN ha score 8,60 su GPU e 8,64 su CPU. Il server temporaneo
è stato chiuso dopo le prove; nessun servizio aggiuntivo è avviato in automatico.

L'esempio iniziale README del servizio HTTP separato è stato sostituito dal percorso
Ollama richiesto esplicitamente dall'utente. Le misure di questa sezione restano del
servizio di riferimento, non dell'adapter Ollama successivo.

## Memoria osservata e portabilità

`/api/ps` ha riportato il reranker Q8 a 1.155.604.152 byte e F16 a 1.714.086.215 byte,
entrambi con contesto 4096. Gli embedding, già configurati con contesto 32768, erano
a 5.776.426.925 byte. Nel campione finale embeddings e F16 risultavano residenti
insieme, con embedding di prova valido a 1024 dimensioni. La Q8 è stata scaricata
dalla memoria al termine dei test; i due download rimangono installati.

Sono allocazioni dichiarate da Ollama (`size`/`size_vram`), non RSS attribuito né
requisiti universali di RAM. I pesi piccoli non escludono overhead del contesto.
La prova macOS non certifica prestazioni Windows/Linux; l'integrazione HTTP
esistente resta indipendente dal backend hardware.

## Riproduzione e fallback

```sh
ollama pull dengcao/Qwen3-Reranker-0.6B:Q8_0
ollama pull dengcao/Qwen3-Reranker-0.6B:F16
python3 benchmarks/ollama-reranker-probe.py \
  --model dengcao/Qwen3-Reranker-0.6B:Q8_0 \
  --model dengcao/Qwen3-Reranker-0.6B:F16 \
  --pairs benchmarks/results/retrieval-extension-292/ollama-reranker-pairs.json \
  --output benchmarks/results/ollama-reranker-292/new-probe.json
```

Lo script rifiuta la sovrascrittura del risultato. Senza `--pairs` esegue soltanto
le due coppie di controllo. I raw sono ignorati da Git in
`benchmarks/results/ollama-reranker-292/`: risposte preliminari Q8/F16, ablation,
`bounded-probe.json`, campioni di residenza, test e manifest con hash. I benchmark
storici del cross-encoder CPU e del runtime semplificato restano separati.

## Integrazione nativa Ollama successiva

Il codice upstream chiarisce il significato dell'uscita: `send_rerank` di
[llama.cpp](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server-context.cpp)
usava lo stesso primo valore del pooling RANK. La route legacy
[Ollama `/api/embeddings`](https://github.com/ollama/ollama/blob/main/server/routes.go)
lo restituisce senza normalizzazione. Non si applica coseno e non si sceglie una
componente arbitraria di un normale embedding. La coppia `query</s>document`, con
BOS/EOS aggiunti dal tokenizer, replica il formato del riferimento; il doppio
separatore provato inizialmente non era equivalente.

L'adapter verifica versione, digest GGUF e metadati RANK prima di ogni pool, accetta
solo l'uscita scalare o la forma 1024 del runtime misurato e usa esclusivamente il
logit classificatore. Risposte non valide, input con token speciali riservati e
modelli/versioni differenti falliscono senza applicare ranking parziale. Le
richieste ai documenti sono sequenziali, con la coda condivisa del provider.
La modifica locale dei pesi è limitata al metadato mancante: lo script controlla
SHA256 prima/dopo, preserva i tensori e importa un nome distinto. Due esecuzioni
reali hanno verificato preparazione e riuso idempotente del modello già preparato.

**Parità nativa completa:** tutte le 3.457 coppie congelate su 100 query hanno
prodotto score esattamente identici al riferimento, differenza massima **0**, nessuna
variazione dell'ordine dei documenti. Usato `OllamaRerankProvider` reale con tutte le
chiamate a Ollama, senza riusare score nella generazione. Raw in
`native-ollama/reranker-scores.json` e `native-ollama/parity.json` sotto la directory
risultati. Questo lega gli score Ollama alla matrice di qualità precedente, senza
attribuire al nuovo runtime il vecchio hash né presentare un nuovo corpus.

Il README contiene preparazione e configurazione MCP diretta: base URL nativa e
nome del modello bastano, senza flag aggiuntivo di attivazione. `budgetMs=0` indica
assenza di deadline; gli esperimenti a 500 ms o 30 s non sono il default finale.
Le verifiche automatiche coprono attivazione, incompatibilità, forma/limiti della
risposta, errori/cancellazioni, score completi, modello cambiato e budget embedding
separato. Le misure finali e la verifica dell'intera suite sono registrate sotto.

### Validazione finale senza deadline

Quaranta chiamate reali tramite `OllamaRerankProvider`/`RerankSession`, su venti query
con pool congelati richiesti 32/64 (32–47 documenti effettivi), completano **40/40**
con `budgetMs=0`: mediana **1.307,83 ms**, p95 **1.675,02 ms**, massimo **1.732,23 ms**.
Modello residente, nessun benchmark parallelo durante questa misura; embedding e
coverage non sono inclusi nei tempi. Il risultato non è una garanzia di latenza su
altro hardware né richiede di troncare il recupero a questi pool sperimentali.

Il precedente esperimento nativo con budget alternati 500 ms/30 s è conservato in
`live-budget.json`: 0/40 applicazioni a 500 ms e 12/40 a 30 s, con timeout, errori
provider e successive chiamate rifiutate dal circuito della coda. Il log del server
mostra anche una lunga pausa tra operazioni; la causa non è isolata. Non si eliminano
questi fallimenti e non si usano per stimare il percorso normale senza cancellazioni.
Il run successivo senza deadline (`live-unlimited.json`) è separato e completo.

Coesistenza verificata dopo l'integrazione: embedding valido a 1024 dimensioni e
score BGE valido nello stesso Ollama. `/api/ps` riporta BGE a 696.610.979 byte e
qwen3-embedding a 5.776.426.925 byte (contesto embeddings già impostato a 32768).
Ollama riusa lo stesso runner del precedente alias con gli stessi pesi. Sono
allocazioni dichiarate, non RSS universale. La copia GGUF temporanea è stata
rimossa dopo l'import verificato; i modelli installati rimangono disponibili.

Verifica finale: **93 file di test passati**, typecheck e repository hygiene,
**19 gate di qualità passati**, build e package smoke riusciti. Pacchetto: 689 file,
1.094.100 byte compressi, 4.208.186 byte non compressi; lo smoke controlla anche
l'inclusione dello script di preparazione. Il test ibrido mantiene embeddings e
coverage quando il reranker dura più del budget semantico. README, milestone e wiki
allineati al comportamento finale; nessuna pubblicazione/version bump.

Runtime finale SHA256: `93ed926b4229f01f49a2a8f570243d504e8898595a80b8582b072597cffe035b`.
Sorgenti esatti, log e identità sono in `native-ollama/`; i raw precedenti conservano
la loro provenienza e non vengono rietichettati come esecuzioni di questo runtime.
