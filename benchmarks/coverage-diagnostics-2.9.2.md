# Diagnosi della coverage — decisione "sufficiente / gap"

Seconda revisione, 26 settembre 2026. Analisi locale sul worktree di `1dbece6`
(package 2.9.1, modifiche `Unreleased`). Script: [`coverage-diagnostics.ts`](coverage-diagnostics.ts).

## Cosa cambia rispetto alla prima versione

La prima versione (25 settembre) è stata rivista da un secondo modello, che ne ha
verificato dati e codice. Le correzioni accettate sono queste:

- **Recupero e sufficienza vanno separati.** `sufficient` valuta le evidenze
  recuperate, mentre `answerable` indica che la risposta esiste nel corpus. In 16 dei
  61 "falsi gap" il pool non conteneva alcuna pagina rilevante: lì il gap è corretto
  e l'errore è del recupero.
- **"Nessuno score supera le soglie" era falso alla lettera.** Qwen raggiunge 0.737
  per `workspace`, sopra 0.72. La decisione non cambia perché il termine era già
  coperto lessicalmente. Il massimo di 0.540 riguardava solo le facet non trovate
  lessicalmente, sulle pagine rilevanti.
- **La calibrazione era giudicata con l'accuracy**, cioè la metrica criticata nello
  stesso rapporto. Ora si usano tassi separati e l'accuracy bilanciata.
- **0.475 è l'accuracy sulle 40 query holdout.** Sulle 100 query originali è 0.39.
- **"Un modello migliore non cambierà la coverage" non è dimostrato.** Vale solo per
  i modelli provati, con questa configurazione e queste query.

Si aggiungono inoltre: la precisazione che la pipeline multilingue prevede la
**traduzione della query nella lingua della knowledge** prima del recupero;
negativi plausibili **nel dominio**; e le correzioni lessicali, misurate con un'ablazione.

## Metodo

- **Corpus**: 59 pagine di documentazione reale in inglese
  (`a5d5e185c41625fbc955340a7d390d5e95fbcb93`).
- **Query**: le 100 originali (20 sviluppo, 40 regressione ispezionata, 40 holdout;
  90 con risposta, 10 fuori dominio) più **36 negativi nel dominio** (12 sviluppo,
  24 holdout, metà in italiano e metà in inglese). I negativi sono domande plausibili
  su KnowledgeRail la cui risposta manca nel corpus (Neo4j, Helm, rotazione della
  credenziale, reranker BGE…). I termini chiave sono stati cercati nel corpus ed
  esclusi se presenti. Sono escluse le domande a cui risponde una dichiarazione
  esplicita del tipo "non disponibile".
- **Traduzione simulata** (`--translate`): le 60 query italiane (54 con risposta, 6
  negative) e i 18 negativi italiani sono sostituiti da una resa inglese fedele, con
  gli identificatori invariati. Simula l'agente chiamante che riscrive la query nella
  lingua della knowledge. Fixture congelata prima di ogni predizione:
  [`coverage-diagnostics-292.json`](fixtures/coverage-diagnostics-292.json), SHA-256
  `bcf2803671c2c768ed434c7cffca30b6d2d0de9abfc31b9f7688ea84e2e6766d`.
- **Due etichette**:
  - `answerable`: la risposta esiste nel corpus (valutazione end-to-end);
  - `evidenceRetrieved`: almeno una pagina giudicata rilevante è nel pool su cui
    decide la coverage (valutazione della sola sufficienza).

  Per la sufficienza i positivi sono le query con evidenza recuperata; i negativi
  sono le query senza risposta più i mancati recuperi.
- **Metriche**: tasso di falsi gap sui positivi, tasso di falsi "sufficiente" sui
  negativi, accuracy bilanciata (media dei due tassi di successo). L'accuracy semplice
  resta solo per continuità con la prima versione.
- **Configurazione**: stessa del benchmark 2.9.2 (8 risultati, budget 8/4000, nessun
  widening, LSH/threshold/int8). Solo lessicale e `qwen3-embedding:0.6b` via Ollama
  0.34.4 (digest `ac6da0df…`, senza prefisso, come nella configurazione del README).
  Nella prima versione anche Potion multilingue 128M e Qwen con prefisso davano
  decisioni identiche al lessicale sulle 100 query originali; non sono stati
  rieseguiti sulla nuova fixture.
- **Sensibilità alle soglie**: calcolata in modo esatto traslando gli score e
  richiamando `assessRetrievalCoverage`. Per ogni query si verifica che le soglie di
  default riproducano decisione e gap del runtime. La selezione massimizza l'accuracy
  bilanciata sulla split di sviluppo; a parità vincono le soglie più severe.
- **Hardware**: Linux x64, RTX 5080, Node 24.21.0. Output grezzi in
  `benchmarks/results/coverage-diagnostics/{baseline,ablation,fixed}` (esclusi da Git).

## Risultati prima delle correzioni

### 1. La traduzione prevista non esiste nel codice, e senza di essa l'italiano fallisce

Nessuna parte di KnowledgeRail traduce la query, e nessuna istruzione ai client la
richiede: la policy di lingua in `templates.ts` e `server.ts` riguarda solo la
scrittura delle pagine. Con query italiane su documentazione inglese:

| Query con risposta (90) | Senza traduzione | Con traduzione simulata |
|---|---:|---:|
| pagina rilevante nel pool | 74 (16 mancati recuperi, tutti italiani) | **90** |
| giudicate sufficienti | 29 (0 delle 54 italiane) | 75 |

I 61 falsi gap end-to-end senza traduzione si scompongono così: **16 errori di
recupero** e 45 errori di sufficienza (38 su query italiane, 7 su query inglesi). Con
la traduzione simulata non restano errori di recupero e gli errori di sufficienza
scendono a 15.

### 2. Semantica: nessun effetto sulle decisioni con i modelli provati

Con Qwen 0.6B, decisioni e gap coincidono con il solo lessicale **su 136 query su 136**,
sia con sia senza traduzione. Un solo concetto supera la soglia: `workspace` a 0.737,
in tre query (`workspace-1`, `boundary-extension-0`, `indomain-notion`). In tutti e tre
i casi era già coperto lessicalmente.

Distribuzione degli score massimi (p50 / max), senza traduzione:

| Insieme | Score |
|---|---:|
| Facet non trovate lessicalmente, sulle pagine rilevanti recuperate | 0.34 / 0.51 |
| Facet delle query fuori dominio, nel pool | 0.40 / 0.58 |
| Facet dei negativi nel dominio, nel pool | **0.51 / 0.74** |

Su questo corpus una parola isolata dà score **più alti** sulle domande nel dominio ma
senza risposta che sulle evidenze pertinenti: la similarità fra parola e passaggio
riflette il vocabolario condiviso, non la presenza della risposta.

La calibrazione ha effetti diversi nei due scenari:

- **Senza traduzione**, le soglie scelte sullo sviluppo (facet 0.40, entità 0.90)
  alzano l'accuracy bilanciata perché recuperano parte delle query italiane, ma
  aumentano i falsi "sufficiente". È un compromesso, non una correzione.
- **Con traduzione**, la scelta cade su 0.90/0.90, cioè semantica di fatto spenta:
  nessuna soglia migliora la decisione lessicale.

I valori esatti sono nella tabella dello sweep più sotto.

### 3. I negativi nel dominio sono il punto debole

I 10 negativi fuori dominio sono sempre riconosciuti. Dei 36 negativi nel dominio,
invece, 4 risultano "sufficienti" senza traduzione e **9 con traduzione**. La regola
"≥ 60% delle parole della query presenti nel pool" verifica che il vocabolario sia
sovrapposto, non che la risposta ci sia. Esempi: rotazione della credenziale,
pgvector, Docker, cifratura a riposo.

## Correzioni lessicali e ablazione

Difetti confermati: parole interrogative e modali a inizio frase trattate come entità
(`Quali`, `Come`, `Devo`…); troncamento sugli accenti (`Perch`); composti minuscoli con
trattino trattati come identificatori obbligatori (`production-ready`, `code-backed`,
`always-on`…); varianti con punteggiatura (`esecuzione:`) contate come facet.

Varianti misurate:
- **A**: entità con classi Unicode; parole funzionali IT/EN escluse dalle entità;
  composti minuscoli con trattino trattati come prosa, salvo se tra virgolette o apici
  inversi.
- **B**: A + esclusione dalle facet dei token con delimitatori.
- **C**: B + parole funzionali escluse anche dalle facet.

Solo lessicale. Con Qwen, senza traduzione, la variante C ha dato decisioni identiche
al lessicale su 136 query su 136.

| Scenario | Variante | Falsi gap | Falsi sufficienti | Bilanciata (tutte) | Sviluppo | Holdout |
|---|---|---:|---:|---:|---:|---:|
| tradotto | baseline | 15/90 | 9/46 | 0.819 | 0.829 | 0.813 |
| tradotto | **A** | **7/90** | 10/46 | **0.852** | **0.857** | **0.823** |
| tradotto | B | 7/90 | 11/46 | 0.842 | 0.821 | 0.823 |
| tradotto | C | 10/90 | 11/46 | 0.825 | 0.794 | 0.810 |
| originale | baseline | 45/74 | 4/62 | 0.664 | 0.444 | 0.695 |
| originale | **A** | 36/74 | 5/62 | **0.716** | **0.552** | **0.709** |
| originale | B | 36/74 | 5/62 | 0.716 | 0.552 | 0.709 |
| originale | C | 38/74 | 5/62 | 0.703 | 0.516 | 0.694 |

Con A senza la regola sui trattini, la variante tradotta resta identica alla baseline:
la regola sui trattini da sola vale 8 falsi gap in meno.

**Adottata: A**, la migliore sullo sviluppo in entrambi gli scenari. Le due varianti
scartate sono state misurate e non entrano nel runtime:

- **Filtro sui delimitatori (B)**: nessun guadagno; un negativo in più diventa
  sufficiente (`re-indexing` non abbassa più il rapporto).
- **Parole funzionali tolte dalle facet (C)**: nello scenario tradotto rompe 3 query con
  risposta (`static-1`, `usage-0`, `usage-extension-1`); in quello originale ne rompe 3 e
  ne corregge 1. La soglia del 60% stava in piedi grazie a parole
  come "can", "do", "during": è un segnale della fragilità del rapporto, non un motivo
  per tenere le parole funzionali come evidenza.

Costo di A: il composto `response-time` produceva per caso un gap corretto su un
negativo; come prosa non lo produce più (+1 falso "sufficiente").

Verifiche su A: 3 nuovi test unitari, che falliscono sul codice originale; `npm run verify`
(igiene, type-check, 93 file di test) e i 19 quality gate passano; `eval:coverage` dà
output identico. Quella valutazione inietta però score semantici sintetici di 0.95,
quindi verifica la logica di combinazione e non le distribuzioni reali dei modelli.

## Risultati dopo le correzioni (variante A)

| Scenario | Configurazione | Con risposta sufficienti | Negativi nel dominio sufficienti | Falsi gap | Falsi sufficienti | Bilanciata | Holdout |
|---|---|---:|---:|---:|---:|---:|---:|
| originale | lessicale = Qwen | 38/90 | 5/36 | 36/74 | 5/62 | 0.716 | 0.709 |
| tradotto | lessicale = Qwen | **83/90** | 10/36 | **7/90** | 10/46 | **0.852** | 0.823 |

Per confronto con la prima versione, l'accuracy semplice sulle 100 query originali:

| Scenario | Tutte le 100 | Holdout (40) |
|---|---:|---:|
| baseline, senza traduzione | 0.39 | 0.475 |
| A, senza traduzione | 0.48 | 0.525 |
| baseline, tradotto | 0.85 | 0.825 |
| A, tradotto | 0.93 | 0.875 |

Anche dopo le correzioni Qwen non cambia alcuna decisione (136 su 136 identiche in
entrambi gli scenari).

Sweep delle soglie con Qwen, tassi sulle evidenze recuperate:

| Scenario | Soglie | Falsi gap | Falsi sufficienti | Bilanciata | Holdout |
|---|---|---:|---:|---:|---:|
| originale | default 0.72/0.80 | 36/74 | 5/62 | 0.716 | 0.709 |
| originale | scelte sullo sviluppo: 0.40/0.90 | 9/74 | 17/62 | 0.802 | 0.810 |
| tradotto | default = scelte (0.90/0.90) | 7/90 | 10/46 | 0.852 | 0.823 |

Senza traduzione, abbassare la soglia delle facet funziona come un surrogato grezzo
della traduzione, ma triplica i falsi "sufficiente" (5 → 17 su 62, inclusi i mancati
recuperi). Con la traduzione il surrogato non serve e non aiuta.

## Conclusioni

1. Il valore 0.475 della prima versione mescolava tre cause distinte: la mancata
   traduzione (un passaggio previsto dal design ma non implementato), gli errori di
   recupero e gli errori di sufficienza.
2. Con la pipeline prevista simulata e le correzioni lessicali, il recupero trova una
   pagina rilevante per **90 query su 90** e i falsi gap scendono a **7 su 90**.
3. Il problema principale che resta è il **falso "sufficiente" sulle domande
   plausibili ma senza risposta**: 10 su 36. Il test di sovrapposizione lessicale non
   lo può risolvere per costruzione.
4. Con i modelli provati (Qwen3 0.6B; nella prima versione anche Potion 128M e Qwen
   con prefisso, sulle 100 query originali) la coverage semantica non cambia alcuna
   decisione, e la similarità parola-passaggio non separa i negativi nel dominio.
   Non si può escludere che altri modelli o un metodo diverso si comportino
   diversamente; è ciò che va misurato.

## Limiti

- Etichette, traduzioni e negativi sono scritti dall'agente, senza annotazione umana
  indipendente. L'autore aveva già visto il corpus e la prima diagnosi.
- I negativi sono 36: le stime sui falsi "sufficiente" hanno intervalli ampi.
- Un solo corpus, in inglese.
- I giudizi di rilevanza non sono esaustivi: un "mancato recupero" potrebbe contenere
  una pagina pertinente non giudicata.
- `evidenceRetrieved` richiede almeno una pagina giudicata rilevante nel pool, non la
  completezza della risposta.
- Le soglie sono state scelte su 14 negativi di sviluppo (tradotto) o 18 (originale,
  inclusi i mancati recuperi).

## Prossimi passi (ipotesi da confrontare, non soluzioni validate)

1. **Implementare la traduzione della query.** Prima serve decidere chi la esegue e
   come si conosce la lingua della knowledge. Per esempio: il workspace dichiara la
   lingua e lo strumento chiede all'agente di passare `query` in quella lingua, così
   KnowledgeRail resta senza LLM. La modalità `--translate` di questo script è il
   riferimento per misurarla.
2. **Rafforzare prima la valutazione della sufficienza**: più negativi nel dominio,
   un campione validato da una persona, un corpus in italiano.
3. **Confrontare sullo stesso protocollo tre metodi per la sufficienza**, misurando
   soprattutto i falsi "sufficiente" nel dominio:
   - similarità fra query intera e passaggio, calibrata per modello;
   - score di un cross-encoder come segnale di presenza della risposta;
   - facet fornite dall'agente chiamante.

## Riproduzione

```bash
# lessicale, con e senza traduzione simulata
node --import tsx benchmarks/coverage-diagnostics.ts --provider=lexical [--translate] --output=<dir>
# Qwen via Ollama
KNOWLEDGE_RAIL_EMBEDDING_BASE_URL=http://localhost:11434/v1 \
KNOWLEDGE_RAIL_EMBEDDING_MODEL=qwen3-embedding:0.6b \
KNOWLEDGE_RAIL_EMBEDDING_DIMENSIONS=1024 KNOWLEDGE_RAIL_EMBEDDING_TIMEOUT_MS=120000 \
  node --import tsx benchmarks/coverage-diagnostics.ts --provider=http --label=qwen3-0.6b [--translate] --output=<dir>
# modello statico
node --import tsx benchmarks/coverage-diagnostics.ts \
  --provider=static:potion-multilingual-128M --assets=/path/to/models [--translate]
```

La baseline si ottiene eseguendo lo stesso script su un worktree del commit di
partenza. Il primo caricamento del modello in Ollama può superare il timeout di
default di 30 s.
