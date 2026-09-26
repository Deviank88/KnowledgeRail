# Correzioni e limiti residui — 27 settembre 2026

Working tree locale, Linux x64, Ryzen 9 5950X, Node 24.21.0. Dati della prova:
[risultati](open-issues-2.9.4.json). I punti che richiedono Mac o verifica della
presenza della risposta restano distinti dalle correzioni concluse.

## Risposta compatta e lettura dei passaggi

Il compilatore riduceva le evidenze contando i byte del manifest completo anche
quando lo strumento restituiva la proiezione compatta. Ora la stima usa la stessa
proiezione della risposta richiesta, condivisa con il serializzatore. Non sono
stati aumentati il default di 2.000 token o gli 8 risultati. La stima riguarda il
payload strutturato; testo di accompagnamento ed envelope MCP restano separati.

Prova con Qwen3-Embedding 0.6B e BGE Q8 su llama-server, cinque query della fixture:

| Query | Pagine in formato completo | Pagine in formato compatto | Token stimati compatti |
| --- | ---: | ---: | ---: |
| durability-0 | 4 | 8 | 1.124 |
| durability-1 | 4 | 8 | 1.136 |
| durability-2 | 3 | 8 | 1.111 |
| static-0 | 4 | 8 | 1.095 |
| static-1 | 3 | 8 | 1.159 |

Le evidenze attese sono recuperate in 4/5 query in entrambi i formati. Il caso
residuo è un problema di recupero, non di spazio della risposta. I cursori e gli
ampliamenti restano disponibili quando il budget esclude evidenze. Il gate di
parità dei formati ora usa un budget sufficiente per entrambi: con poco spazio,
conservare più evidenze nella risposta compatta è il comportamento desiderato.

È corretta anche l'identificazione dei passaggi con intestazioni duplicate:
viene confrontato l'intero estratto normalizzato. Se non identifica una sezione
univoca, si restituisce la pagina anziché attribuire il testo a una sezione
arbitraria. Il reranker usa lo stesso criterio. Questo risolve l'ambiguità di
identità; non garantisce che il ranking scelga sempre la sezione migliore.

## Avvio e degradazione semantica

Il preriscaldamento precedente ripristinava l'indice, ma con vettori persistiti
non chiamava il modello di query. Ora prepara anche quel modello con una sola
richiesta condivisa, entro 30 secondi o il timeout inferiore del provider, senza
ricalcolare i documenti. Stato `queryProviderState`: idle/warming/ready/failed.
Il fallimento può essere ritentato; il corpus vuoto non attiva il provider.

La preparazione resta asincrona. Una richiesta immediata può ancora raggiungere
il limite semantico di 1,5 secondi; annullare quella richiesta non annulla la
preparazione condivisa. In quel caso restano lessicale e grafo. È inoltre corretto
un difetto del fallback: il timeout semantico scartava anche il reranker, che ha
un budget indipendente; adesso viene conservato.

La prova locale registra 5,15 s per la prima indicizzazione della fixture e
75 ms per ripristino/preparazione successivi, con stato ready e zero fallback
nelle dieci ricerche successive. I modelli esterni erano già residenti: **non è
una misura del caricamento fisico a freddo né una validazione sul Mac**.

## Falsi sufficienti: protezione del contratto, classificazione ancora aperta

Ogni contesto dichiara `retrieval.answerability="unverified"`, anche quando
`coverageSufficient=true`. In assenza di altri gap, il `nextAction` propone la
lettura di una risorsa per verificare la risposta. Le istruzioni richiedono di
controllare fatti, condizioni e relazioni, riportando come ignoto ciò che non è
supportato. La coverage conserva il significato di controllo euristico del
recupero: non viene presentata come una verifica della risposta.

Questa protezione **non cambia la metrica del classificatore**: sulla fixture
tradotta restano 10 falsi sufficienti su 36 negativi nel dominio e 7 falsi gap su
90 positivi. Non dichiariamo il problema risolto cambiando il nome del segnale.

Sono state confrontate due ipotesi sulla sola parte di sviluppo (18 positivi,
14 negativi). La baseline ha 4 falsi sufficienti e zero falsi gap:

| Regola aggiuntiva | Falsi sufficienti | Falsi gap |
| --- | ---: | ---: |
| Copertura dei termini di contenuto in una pagina almeno 0,6 | 2 | 5 |
| Stessa copertura in un passaggio almeno 0,6 | 1 | 6 |
| Score massimo BGE almeno −4 | 2 | 1 |
| Score massimo BGE almeno 0 | 0 | 7 |

Nessuna di queste regole è attivata. Il minimo score BGE di un positivo è −4,97,
mentre un negativo raggiunge −0,91: una soglia scalare non separa perfettamente le
due classi. La perfezione non è un requisito: il criterio è ridurre gli errori
mantenendo un numero utile di risposte corrette.
Il confronto BGE usa gli stessi pesi Q8 sul servizio locale già misurato, 32
candidati al massimo per query. Le fixture e i campioni sono già stati ispezionati;
occorre ancora una valutazione indipendente della risposta completa dell'agente.

### Compromesso fra precisione e risposte perse

In seguito alla precisazione dell'utente, è stato rivalutato il compromesso senza
richiedere zero nuovi falsi gap. Il
[valutatore delle soglie](coverage-tradeoff-eval.ts) sceglie sulla sola parte di
sviluppo, da una griglia fissa, il minor tasso di falsi sufficienti nel dominio
entro un limite dichiarato ai falsi gap. Il 10% usato qui è un'ipotesi di analisi,
non un requisito approvato né una garanzia sul resto del corpus. La soglia scelta
è BGE ≥ −4; non viene modificata guardando gli altri split.

| Misura su tutte le 136 query | Attuale | Con la soglia candidata |
| --- | ---: | ---: |
| Falsi sufficienti sui 36 negativi nel dominio | 10/36 (27,8%) | 6/36 (16,7%) |
| Falsi gap sui 90 positivi | 7/90 (7,8%) | 15/90 (16,7%) |
| Errori fra i casi dichiarati sufficienti | 10/93 (10,8%) | 6/81 (7,4%) |

La candidata migliora la precisione, ma scarta 8 risposte valide per evitare 4
falsi sufficienti e non porta l'errore nel dominio a pochi punti percentuali.
Sul solo split di verifica, i falsi sufficienti scendono da 6 a 4 e i falsi gap
salgono da 5 a 8. Non la rendiamo il default: il motivo è questo compromesso,
non il fatto che un sistema debba essere infallibile.

[Risultati, griglia e osservazioni per query](coverage-tradeoff-2.9.4.json).
Gli split sono già stati ispezionati nelle diagnosi precedenti: questa è una
validazione di regressione, non un nuovo test cieco. Inoltre 36 negativi sono
pochi per certificare una bassa percentuale di errore in produzione. Il tasso
di errori tra i sufficienti dipende dalla proporzione di domande con risposta:
non va confuso con il tasso sui negativi o sulle pagine recuperate.

È corretto separatamente il falso requisito di più fonti per espressioni come
`connect folders as sources` o `collega cartelle come fonti`. Le richieste esplicite
di fonti multiple e gli override del chiamante rimangono validi.

## P3: prerequisito pronto ed esperimento misurato

La [fixture relazionale](fixtures/relational-reranking-294.json) è stata fissata
prima degli score. Ha 24 query: 12 sviluppo e 12 verifica, con componenti del
grafo disgiunte. Ogni split contiene 9 domande con risposta e 3 relazioni assenti;
comprende percorsi inversi, due salti, distrattori simili e query inglesi/italiane.
SHA-256: `342e78fa813d53a00e18ddbe49056dc48446035bc894221f53ad9b4330674fa3`.

Il [valutatore](relational-reranking-eval.ts) confronta testo semplice e un percorso
verificato sul grafo della fixture, entrambi entro 2.048 caratteri. Con BGE Q8:

| Split | MRR testo | MRR con percorso | nDCG@3 testo | nDCG@3 con percorso |
| --- | ---: | ---: | ---: | ---: |
| Sviluppo | 0,735 | 1,000 | 0,722 | 1,000 |
| Verifica | 0,717 | 1,000 | 0,667 | 1,000 |

[Score e classifiche per query](relational-reranking-2.9.4.json). I negativi non
ricevono un recall fittizio; ranking e risposta restano problemi distinti.
Il prefisso relazionale è ancora un esperimento nel benchmark: prima di inserirlo
nel runtime occorrono percorsi estratti dal recupero reale e verifica di assenza
di regressioni sul corpus ordinario. Non è stata introdotta una scansione globale
o un nuovo taglio degli archi.

## Verifica

638 test, tutti i 19 quality gate, controllo dei tipi e smoke test del pacchetto
installabile superati. Sono coperti:
budget compatto, lettura successiva quando la coverage passa, identità dei passaggi,
preriscaldamento condiviso/cancellazione/ritento e conservazione del reranker nel
fallback. Il retrieval ibrido resta attivo. Le misure Mac sono descritte nel
[protocollo operativo](runtime-validation-2.9.4.md).
