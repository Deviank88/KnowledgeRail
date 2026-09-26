# Prova dal vivo del contratto di lingua (client MCP reale)

26 settembre 2026. Working tree non committato basato su `1dbece6`, con il contratto di
lingua descritto nel README ("Knowledge language") e le correzioni di questo rapporto.

**Aggiornamento del 27 settembre:** le misure qui riportate restano lo storico
della prova. Il limite al lavoro sugli archi introdotto nella seconda prova è stato
poi ritirato, perché può perdere evidenze negli hub; si veda la
[verifica successiva](graph-hub-quality-2.9.2.md#follow-up-cap-removed-from-production--2026-09-27).
La correzione di `truncated_frontier` resta attiva. Falsi sufficienti nel dominio,
prima risposta compatta e avvio a freddo restano questioni aperte.

## Configurazione

- **Client**: Claude Code (Opus 5.5) collegato a KnowledgeRail come server MCP stdio
  (`claude mcp add --scope local … dist/index.js --root <workspace>`). L'agente che
  traduce le domande è lo stesso modello che esegue la prova: nessun harness dedicato.
- **Embedding**: `qwen3-embedding:0.6b` via Ollama 0.34.4 (1.024 dimensioni).
- **Reranker**: come deciso nella milestone 2.9.4 — BGE-reranker-v2-m3 Q8 (lo stesso
  GGUF di Ollama, `sha256-4bf51534…`) su llama-server b11200 CUDA, 1 slot, tramite
  `KNOWLEDGE_RAIL_RERANK_ENDPOINT`. Verificato che ogni query nuova riordini 32 candidati.
- **Chiamate**: `knowledge_context mode=task` con i default (risposta compatta, 8 evidenze,
  budget 2.000 token), `objective` nella lingua dell'utente, `query` tradotta al momento
  dall'agente, `query_language` dichiarata. Si misura la **prima risposta**; i `nextAction`
  di allargamento non sono stati seguiti. Linux, RTX 5080.

## Due workspace

| | A — documentazione KnowledgeRail | B — knowledge reale di un progetto cliente |
|---|---|---|
| Pagine | 59, in inglese | 151 (copia locale; contenuti non pubblicati) |
| Lingua dichiarata | `en` (adozione con blocco immediato) | `it` (adozione con blocco immediato) |
| Stima per pagina all'adozione | 55 en, 4 incerte | **107 it, 26 en, 18 incerte**: knowledge mista |
| Domande | 78 in italiano dalle fixture (54 con risposta, 6 fuori dominio, 18 negativi nel dominio) | 42 in inglese scritte dall'agente dal wiki e congelate prima della prova (30 con risposta: 22 su pagine italiane e 8 su pagine inglesi; 12 negativi nel dominio) |
| Traduzione | italiano → inglese, dal vivo | inglese → italiano, dal vivo |

Nel workspace B le 18 pagine incerte sono pagine davvero bilingui (per esempio 175 parole
funzionali inglesi e 163 italiane nella stessa pagina) oppure tabelle senza prosa.

## Controlli del contratto (workspace A)

| Caso | Esito |
|---|---|
| `init` senza lingua | Stato non dichiarato; `nextAction` verso `action=language` |
| Chiamata senza `query_language` | `query_language_required`, nessun recupero; il `nextAction` conserva l'`objective` |
| `query_language=it` su knowledge `en` | `query_language_required` (`mismatch`) |
| Cambio della lingua bloccata | Rifiutato, lingua invariata |
| Chiamate con `query_language` corretto (122 nei due workspace) | Tutte accettate; `languageContract` presente in ogni risposta |

## Risultati del recupero (prima risposta)

| Workspace | Pagina rilevante fra le evidenze | Pagina rilevante al primo posto |
|---|---:|---:|
| A — 54 domande con risposta | **48 / 54** | 36 / 54 |
| B — 30 domande con risposta | **27 / 30** | 23 / 30 |
| B — di cui su pagine italiane | 21 / 22 | — |
| B — di cui su pagine inglesi | 6 / 8 | — |

Nel workspace B i due mancati recuperi su pagine inglesi sono l'effetto atteso della
knowledge mista: la query tradotta in italiano non raggiunge una pagina scritta in
inglese. Dichiarare la lingua non converte le pagine, come il sondaggio segnala.

## Sufficienza

| Workspace | Con risposta giudicate sufficienti | Fuori dominio sufficienti | Negativi nel dominio sufficienti |
|---|---:|---:|---:|
| A | 46 / 54 (5 senza pagina rilevante fra quelle mostrate) | 0 / 6 | 4 / 18 |
| B | 0 / 30 | — | 0 / 12 |

Nel workspace B nessuna risposta è sufficiente perché **ogni query riporta
`truncated_frontier`**: con 151 pagine l'esplorazione del grafo tronca la frontiera e il
gap blocca la sufficienza. Escludendo quel gap e i limiti di visualizzazione, 29 domande su
30 non avrebbero altri gap, mentre 10 negativi su 12 conserverebbero un gap reale (entità
assente). Il segnale di sufficienza, così com'è, non è utilizzabile su questa knowledge.

## Difetti trovati e corretti durante la prova

1. **`--root` sostituito dalle MCP Roots del client** (difetto preesistente). Dopo
   `initialized` il server ricalcolava il workspace senza la root esplicita, quindi Claude
   Code lo spostava sulla propria cartella di lavoro: il primo `init` ha scritto nel
   repository sbagliato (file rimossi). Ora la root esplicita resta fissata; test aggiunto.
2. **"Qual è"** produceva l'entità obbligatoria `Qual`: aggiunte le forme elise `qual`,
   `cos`, `dov`, `com` alle parole funzionali.
3. **L'anteprima di `action=language`** riportava la lingua proposta come se fosse già
   in vigore. Ora riporta la lingua effettiva, la proposta in `proposed` e un `nextAction`
   per l'applicazione.
4. **Un cambio rifiutato** elencava le pagine "discordanti" rispetto alla lingua richiesta;
   ora rispetto a quella che resta in vigore.
5. **`nextAction` di `search`/`graph`** proponeva parametri non pertinenti al modo.
6. **Profilo portoghese del rilevatore**: tolte le parole condivise con inglese e italiano
   (`as`, `do`, `no`, `da`). Migliora il caso riprodotto dal test; sul workspace B non
   cambia i conteggi, perché lì le pagine incerte sono davvero bilingui.

## Seconda prova dal vivo: correzioni 2.9.4 e knowledge tradotta (workspace B)

Stessa sera, dopo il riavvio della sessione, con `dist/` ricostruito. Sono cambiate due cose:

- **Codice (milestone 2.9.4).** La cache del reranker ora è per coppia domanda/documento
  (P1). Il grafo ha un limite al lavoro sugli archi, e `truncated_frontier` chiede di
  allargare la ricerca finché il budget del grafo può crescere; al budget massimo diventa
  un avviso di coverage e non più un gap (P2).
- **Knowledge.** Su richiesta dell'utente le 30 pagine inglesi o miste (più un indice)
  sono state tradotte in italiano, prima nella copia locale e poi nell'originale.
  Identificatori, codice, titoli usati come destinazione dei link e nomi di file sono
  invariati. La stima per pagina passa da 108 it / 27 en / 19 incerte a 139 it / 2 en /
  13 incerte (tabelle senza prosa). Le pagine in inglese rimaste sono `SCHEMA.md`, lasciata
  apposta, e l'indice, tradotto dopo il sondaggio.

Protocollo invariato: stesse 42 domande e stesse query italiane della prima prova,
`objective` in inglese, `query_language: "it"`, prima risposta. Anche questa volta la
prima chiamata a freddo è ricaduta sul solo lessicale ed è stata ripetuta a caldo; le altre
41 sono semantiche.

| Workspace B, 30 domande con risposta | Prima prova | Seconda prova |
|---|---:|---:|
| Pagina rilevante fra le evidenze | 27 | 27 |
| — su pagine già italiane (22) | 21 | **22** |
| — su pagine prima inglesi (8) | 6 | 5 |
| Pagina rilevante al primo posto | 23 | 24 |
| Giudicate sufficienti | **0** | **29** |
| Sufficienti senza la pagina rilevante fra le evidenze | 0 | 2 |

| Workspace B, 12 negativi nel dominio | Prima prova | Seconda prova |
|---|---:|---:|
| Giudicati sufficienti (errore) | 0 | 2 |

Lettura:

- **La sufficienza torna utilizzabile.** Prima nessuna risposta poteva essere sufficiente,
  perché `truncated_frontier` compariva sempre; ora 29 domande con risposta su 30 lo sono.
  I 10 negativi correttamente insufficienti riportano come gap l'entità assente (per
  esempio `entity:DocuSign`), non più la troncatura.
- **I 2 negativi giudicati sufficienti non sono equivalenti.** Uno è un errore netto:
  un servizio esterno che non esiste nella knowledge non viene riconosciuto come entità
  mancante. L'altro ha un'etichetta discutibile: la knowledge contiene campi collegati
  alla certificazione energetica, ma la risposta non li mostrava. Il limite dei falsi
  "sufficiente" nel dominio era già noto e prima era nascosto dal gap sempre presente.
- **Sufficiente non vuol dire risposta mostrata.** In 2 dei 29 casi sufficienti la pagina
  etichettata come rilevante non è fra le evidenze. In uno dei due i passaggi mostrati
  contengono comunque la risposta (due riepiloghi della stessa ristrutturazione), e
  l'etichetta indica una sola pagina.
- **Traduzione e recupero.** A livello di recupero la traduzione aiuta. Con il runtime,
  sulle 8 domande delle pagine prima inglesi, la pagina giusta sta fra i primi 8 risultati
  in 8 casi su 8 (prima 7) ed è prima nel canale lessicale in 6 casi (prima 2). La risposta
  compatta predefinita (budget di 2.000 token) mostra però circa 2 pagine: quando la pagina
  giusta è terza resta fuori. Per questo il conteggio sulle pagine ex-inglesi resta 5 su 8,
  e la differenza con il 6 su 8 della prima prova è entro il rumore di un campione così
  piccolo. Il `nextAction` di ogni risposta propone l'allargamento (16 evidenze, 4.000 token).

## Questioni aperte

1. ~~`truncated_frontier` rende insufficiente ogni query~~ **Risolta** con P2 della milestone
   2.9.4 (vedi la seconda prova).
2. ~~Knowledge mista~~ **Risolta per questa knowledge** traducendo le pagine nella lingua
   dichiarata. Il caso generale (knowledge davvero multilingue) resta aperto: il contratto
   presuppone una sola lingua.
3. **Avvio a freddo.** La prima query dopo l'avvio ha superato il budget semantico (1,5 s)
   ed è ricaduta sul solo lessicale; le successive erano semantiche.
4. **Falsi "sufficiente" nel dominio**: 4 su 18 nel workspace A, in linea con la diagnosi
   della coverage; nel workspace B, dopo P2, 1 errore netto e 1 caso dubbio su 12.
7. **La risposta compatta mostra poche pagine** (in media circa 2 su 8 recuperate): quando
   la pagina giusta è terza, serve l'allargamento proposto dal `nextAction`.
5. **"sources" in inglese** attiva il requisito di più fonti anche quando la domanda
   significa "come sorgenti".
6. In due casi la pagina era giusta ma il passaggio selezionato non era la sezione che
   risponde.

## Limiti

- Le traduzioni sono prodotte dal vivo dall'agente, ma non sono indipendenti: lo stesso
  agente conosce il corpus A, aveva scritto le rese della fixture e ha scritto le domande B.
- Giudizi di rilevanza scritti dall'agente; per B basati sull'apertura delle pagine.
- Solo la prima risposta; campioni piccoli (54 e 30 domande con risposta).
- Una sola configurazione di modelli e una sola macchina.

## Dati

Risultati per query in `~/.cache/knowledgerail-eval/runs/` (A: `en-live.jsonl`; B:
`it-live.jsonl` e, per la seconda prova, `it-live-294.jsonl`, con la fixture delle domande `silverfir-questions.json`, SHA-256
`ef3d8bf1b61fa8e9f284088cf24af971776391b629a4e54ac1a508e89c0de73f`). I dati di B contengono
materiale del cliente e restano fuori dal repository.
