# TagsViewer — AWS Resource Tagging Graph

Applicazione web per la **governance del tagging AWS** basata su graph database. Importa risorse da AWS Resource Explorer o da file XLSX di estrazione, applica automaticamente i tag tramite LLM (Claude via AWS Bedrock, Azure OpenAI o Anthropic direct), confronta risorse on-prem di assessment con le risorse delivery AWS nel grafo 3D e produce report in formato XLSX e Markdown.

---

## Indice

- [Architettura](#architettura)
- [Funzionalità](#funzionalità)
- [Stack tecnologico](#stack-tecnologico)
- [Prerequisiti](#prerequisiti)
- [Installazione e deploy](#installazione-e-deploy)
- [Configurazione](#configurazione)
- [Avvio](#avvio)
- [Flusso operativo](#flusso-operativo)
- [API Reference](#api-reference)
- [Schema Neo4j](#schema-neo4j)
- [Struttura del progetto](#struttura-del-progetto)

---

## Architettura

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              Browser (SPA)                               │
│  ┌──────────┐  ┌─────────────────┐  ┌───────────────────────────────┐   │
│  │ Projects │  │  Upload &       │  │  3D Graph View                │   │
│  │ Manager  │  │  Tagging XLSX   │  │  (delivery+assessment nodes,  │   │
│  │          │  │  Column Config  │  │   comparison filters)         │   │
│  └──────────┘  └─────────────────┘  └───────────────────────────────┘   │
│  ┌───────────────────────┐  ┌───────────────┐  ┌─────────────────────┐  │
│  │  Chat Assistente      │  │ Task Progress │  │ Strategie Tagging   │  │
│  │  FinOps (SSE stream)  │  │ Widget (SSE)  │  │ (regole bulk-apply) │  │
│  └───────────────────────┘  └───────────────┘  └─────────────────────┘  │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ HTTP / SSE
┌──────────────────────────────────▼───────────────────────────────────────┐
│                          Node.js + Express API                           │
│                                                                          │
│  /api/projects  /api/documents  /api/graph  /api/tagging                 │
│  /api/chat      /api/export     /api/auth   /api/strategies              │
│                                                                          │
│  ┌────────────┐  ┌───────────────────┐  ┌─────────────┐  ┌───────────┐  │
│  │  Parser    │  │  Tagger (LLM      │  │ XlsxTagger  │  │ Exporter  │  │
│  │ JSON/CSV/  │  │  batch 20/call +  │  │ (XLSX in →  │  │ (ExcelJS  │  │
│  │ PDF/DOCX/  │  │  progress SSE)    │  │  XLSX out,  │  │  Markdown)│  │
│  │ XLSX assess│  │                   │  │  batch 15)  │  │           │  │
│  └────────────┘  └───────────────────┘  └─────────────┘  └───────────┘  │
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐   │
│  │                       LLM Abstraction                             │   │
│  │  AWS Bedrock (Claude, SSO IAM) │ Azure OpenAI + MSAL device-code │   │
│  │  Anthropic direct (API Key)   │ Ollama locale (GPU, gratuito)    │   │
│  └───────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ Bolt / neo4j+s
┌──────────────────────────────────▼───────────────────────────────────────┐
│                            Neo4j Graph DB                                │
│   (:Project) ─[:HAS_RESOURCE]──► (:Resource {nodeType: delivery|assess}) │
│   (:Project) ─[:HAS_DOCUMENT]──► (:Document)                             │
│   (:Resource)─[:DEPENDS_ON]────► (:Resource)                             │
│   (:Resource)─[:PART_OF]───────► (:Resource)                             │
└──────────────────────────────────────────────────────────────────────────┘
```

### Componenti principali

| Componente | Responsabilità |
|---|---|
| **Express Router** | 8 router REST + SSE per chat e progress stream |
| **Parser** | Normalizza JSON/CSV (Resource Explorer), PDF, DOCX, XLSX assessment in strutture uniformi; XLSX assessment crea nodi `nodeType: assessment` |
| **Tagger** | Orchesta le chiamate LLM in batch da 20 risorse su risorse Neo4j, traccia il progresso in memoria via SSE |
| **XlsxTagger** | Pipeline XLSX-centric: legge il file di estrazione, filtra righe `Taggable=Y`, invia batch da 15 righe al LLM, riscrive il file con i tag `cineca:` valorizzati |
| **LLM Service** | Astrazione su AWS Bedrock (SSO IAM), Claude (Anthropic SDK) e Azure OpenAI con device-code MSAL |
| **Graph Service** | Query Cypher con filtri per status, servizio, `nodeType` (delivery vs assessment) |
| **Strategies** | Regole di valorizzazione tag: condizione su campo risorsa → imposta valore tag su tutte le risorse matching con tag `[?]` |
| **Exporter** | Genera XLSX colorato per stato (ExcelJS) e Markdown riepilogativo |
| **Chat SSE** | Stream asincrono risposta LLM; applica automaticamente i tag aggiornati suggeriti nella risposta |
| **Task Widget** | Pannello SSE floating che mostra avanzamento batch, errori e durata per ogni job di tagging |
| **3D Graph** | Rendering Three.js tramite `3d-force-graph`; nodi delivery (sfere colorate per status) + nodi assessment (cubi viola); filtri tipo nodo e proprietà |

---

## Funzionalità

### Gestione Progetti
- Crea un **progetto per ogni account AWS** (nome, Account ID, regione, LLM provider)
- Dashboard con contatori per stato (pending / tagged / uncertain / confirmed / assessment) e barra di progresso
- Cambia LLM provider per progetto in qualsiasi momento via PATCH

### Importazione Documenti (4 tipi)

| Tipo | Formato | Cosa fa |
|---|---|---|
| **Estrazione AWS Resource Explorer** (`resource_export`) | JSON, CSV | Crea nodi `nodeType: delivery` con ARN, tipo, regione, tag esistenti |
| **File da taggare** (`tagging_target`) | XLSX | File di estrazione AWS da completare con tag `cineca:*`; auto-rileva colonne tag/note/Taggable |
| **Linee guida** (`guideline`) | PDF, DOCX, TXT, MD | Testo inviato come contesto al LLM |
| **Assessment pre-migrazione** (`assessment`) | XLSX, PDF, DOCX | XLSX: crea nodi `nodeType: assessment` (cubi viola nel grafo) per comparazione on-prem↔AWS; altri formati: testo come contesto |

### Pipeline XLSX Tagging (`tagging_target`)
- **Configurazione colonne dinamica** per progetto: selezione foglio, colonna `Taggable`, checkbox set di colonne tag `cineca:*`, colonne note read-only
- **Template prompt editabile** con placeholder `{{context_documents}}`, `{{tag_columns_list}}`, `{{resources_json}}`
- **Worker paralleli configurabili** (1–5): le righe taggabili vengono divise in segmenti disgiunti elaborati contemporaneamente — con 3 worker la velocità è ~3×; i risultati vengono scritti nel file XLSX solo al termine (no conflitti)
- Pipeline: legge XLSX → filtra righe `Taggable=Y` → divide in N segmenti → N batch-loop paralleli → merge aggiornamenti celle → scrive XLSX completato
- Progresso in tempo reale via SSE (stesso Task Widget)

### Tagging automatico LLM (via Neo4j)
- Processo in background, fire-and-forget
- Batch da 20 risorse per chiamata LLM
- Ogni risorsa riceve: tag proposti nel namespace `cineca:`, confidence score (0–1), stato, reasoning
- Soglia di incertezza: `uncertain` se confidence < 0.7
- **Re-tagging singola risorsa** con hint aggiuntivo dell'utente

### Widget Task Progress
- Pannello floating in basso a destra, visibile non appena il tagging parte
- Aggiornamento in tempo reale via SSE ogni 1.5 secondi
- Per ogni job mostra: batch corrente (`N/M`), risorse processate, barra di avanzamento, tempo trascorso ed **ETA stimata** (`~Xm Ys`) calcolata dalla velocità media dei batch precedenti
- **Pausa / Resume**: bottone ⏸ durante l'esecuzione; il processo si sospende tra un batch e l'altro (senza perdere lo stato) e riprende con ▶
- **Worker paralleli**: icona ⚡ con conteggio quando il tagging usa più worker simultanei
- **Early abort su errori permanenti**: dopo 3 errori LLM consecutivi (es. API key scaduta, credito esaurito) il processo si interrompe automaticamente invece di continuare tutti i batch
- Errori per batch espandibili (dettaglio messaggio)
- Stato finale: completato, completato con errori parziali, errore critico

### Grafo 3D interattivo — Confronto Assessment vs Delivery

```
 Colori nodi delivery (sfere):
  ● grigio   — pending
  ● blu      — tagged
  ● arancio  — uncertain
  ● verde    — confirmed
  ● viola chiaro — XLSX tagged

 Forma nodi assessment (cubi):
  ■ viola    — nodi da file assessment (on-prem / pianificati)
```

- **Filtro tipo nodo**: Tutti | Solo Delivery | Solo Assessment
- **Filtro proprietà**: `chiave=valore` (esatto) o `chiave~=parziale` — es. `cineca:Service=LDAP` o `service~=EC2`
- **Dimensione nodo** proporzionale al numero di tag assegnati
- Frecce direzionali sugli archi con etichetta relazione
- Click su nodo → pannello editing tag inline con conferma / ri-tagging LLM

### Strategie di Tagging (`🎯 Strategie`)
- Definisci regole condizionali: *se `resourceType` contiene `EC2::Instance` → imposta `Tag:cineca:ManagedBy` = `Terraform`*
- Campi condizione: `resourceType`, `service`, `region`, `name`
- Operatori: `è uguale a` / `contiene` / `inizia con`
- Attiva/disattiva ogni regola con checkbox
- **Applica Strategie**: aggiorna in bulk tutte le risorse delivery dove il tag è `[?]` o assente e la condizione matcha
- Utile per valorizzare tag incerti dopo comparazione con i dati di assessment

### Chat Assistente FinOps
- Streaming SSE in tempo reale
- Carica automaticamente il contesto delle risorse `uncertain` del progetto
- Include linee guida e assessment caricati come contesto
- Se la risposta LLM contiene un blocco JSON con tag aggiornati, li applica automaticamente al grafo
- Storico conversazione (ultimi 10 scambi)

### Esportazione
- **XLSX**: un foglio per tutte le risorse, un tag per colonna, colorazione per stato, foglio riepilogativo
- **Markdown**: documento raggruppato per servizio AWS con tag, confidence, reasoning e metadati di progetto

---

## Stack tecnologico

| Layer | Tecnologia |
|---|---|
| Runtime | Node.js 20+ (ES Modules) |
| Web framework | Express 4 |
| Graph DB | Neo4j 5 (Community / AuraDB Free) |
| LLM — Bedrock | `@aws-sdk/client-bedrock-runtime` + `@aws-sdk/credential-providers` |
| LLM — Claude | `@anthropic-ai/sdk` |
| LLM — Azure | `openai` SDK (Azure-compatible) + `@azure/msal-node` |
| Parsing PDF | `pdf-parse` |
| Parsing DOCX | `mammoth` |
| Parsing CSV | `csv-parse` |
| XLSX read/write | `xlsx` (SheetJS) + `exceljs` (export colorato) |
| Ollama | REST API nativa (`fetch`) — nessun SDK aggiuntivo |
| Upload file | `multer` 2 |
| Frontend | Vanilla JS (ES Modules, no bundler) |
| Grafo 3D | `3d-force-graph` + `Three.js` via CDN |
| UUID | `uuid` |

---

## Ollama — modello locale (opzione gratuita)

Ollama permette di eseguire modelli LLM localmente senza API key né costi per token. È l'opzione consigliata in ambienti con restrizioni di rete o per test. Con una GPU NVIDIA dedicata si ottengono prestazioni paragonabili ai servizi cloud.

### Installazione

```bash
# Windows / macOS / Linux: scarica da https://ollama.com/download
# oppure su Linux:
curl -fsSL https://ollama.com/install.sh | sh
```

### Scelta del modello in base alla VRAM disponibile

Il criterio fondamentale è che il modello entri **completamente in VRAM** — un modello parzialmente su CPU è 4–6× più lento.

| VRAM GPU | Modello consigliato | Dimensione | Token/s stimati |
|---|---|---|---|
| 4–6 GB | `mistral:7b-instruct-q4_K_M` | 4.1 GB | 30–50 tok/s |
| 6–8 GB | `mistral:7b-instruct-q4_K_M` | 4.1 GB | 40–60 tok/s |
| 8–12 GB | `llama3.1:8b-instruct-q4_K_M` | 5.0 GB | 50–80 tok/s |
| Solo CPU | `llama3.2:3b` | 2.0 GB | 5–15 tok/s |

```bash
# GPU con 6 GB VRAM (es. RTX 3060 Laptop) — entra tutto in GPU
ollama pull mistral:7b-instruct-q4_K_M

# Verifica modelli disponibili e dove girano (CPU/GPU %)
ollama list
ollama ps   # mostra il modello caricato con la % CPU/GPU
```

> **Diagnostica GPU**: `ollama ps` mostra `PROCESSOR = 0%/100% CPU/GPU` se tutto è in GPU.  
> Se la % CPU è alta (> 20%), il modello è troppo grande per la VRAM disponibile → scegli un modello più piccolo.

### Avvio ottimizzato con parallelismo GPU

Ollama di default serve una richiesta LLM alla volta. Per sfruttare i **worker paralleli** di TagsViewer è necessario avviarlo con parallelismo abilitato.

**Windows (PowerShell):**
```powershell
# Termina il servizio Ollama corrente se in esecuzione
Stop-Process -Name "ollama" -Force -ErrorAction SilentlyContinue

# Riavvia con 2 richieste parallele e Flash Attention (~25% più veloce)
$env:OLLAMA_NUM_PARALLEL = "2"
$env:OLLAMA_FLASH_ATTENTION = "1"
ollama serve
```

**Linux / macOS:**
```bash
# Aggiungi al proprio .bashrc / .zshrc per renderlo persistente
export OLLAMA_NUM_PARALLEL=2
export OLLAMA_FLASH_ATTENTION=1
ollama serve
```

> Con `OLLAMA_NUM_PARALLEL=2` e 2 worker attivi in TagsViewer, le due chiamate LLM vengono eseguite **veramente in parallelo** — le prestazioni raddoppiano rispetto al default sequenziale.

### Parametri GPU nelle chiamate API

TagsViewer invia automaticamente i seguenti parametri Ollama ad ogni richiesta:

| Parametro | Valore | Effetto |
|---|---|---|
| `num_gpu` | 999 | Ollama carica in VRAM tutti i layer che ci entrano |
| `num_ctx` | 20480 (configurabile) | Finestra di contesto: 20K token ≈ 80K caratteri — bilancia qualità e uso VRAM KV cache |

`OLLAMA_NUM_CTX` nel `.env` permette di ridurre il contesto se la VRAM è scarsa (es. 8192 per GPU da 4 GB).

### Configurazione in TagsViewer

1. Crea un nuovo progetto e seleziona **"Ollama (modello locale)"** come LLM provider
2. Specifica il nome del modello (es. `mistral:7b-instruct-q4_K_M`)
3. Configura i worker paralleli nella sezione "Configurazione Colonne" del file XLSX (valore consigliato: **2** con `OLLAMA_NUM_PARALLEL=2`)
4. Tutti i tag e la chat useranno il modello locale — nessuna chiamata a servizi esterni

> **Prestazioni attese** con RTX 3060 Laptop (6 GB VRAM) + `mistral:7b-instruct-q4_K_M` + 2 worker:  
> ~30–50 tok/s → circa **40–70 righe/minuto** → 5107 righe in **~1–2 ore** (contro 5–6 ore con modello parzialmente su CPU).

---

## Prerequisiti

- **Node.js** 20 o superiore (`node --version`)
- **Neo4j** in una delle configurazioni:
  - **Locale**: Neo4j Community Edition — URI: `bolt://localhost:7687`
  - **Cloud**: [AuraDB Free](https://neo4j.com/cloud/platform/aura-graph-database/) — URI: `neo4j+s://xxxxxxxx.databases.neo4j.io`
- Almeno uno tra:
  - **Ollama** installato localmente con un modello compatibile con la VRAM disponibile — opzione gratuita consigliata per ambienti con restrizioni di rete (vedi [sezione Ollama](#ollama--modello-locale-opzione-gratuita))
  - **AWS CLI** configurato con SSO (profilo con permessi `bedrock:InvokeModel`)
  - **Anthropic API Key** — da [console.anthropic.com](https://console.anthropic.com)
  - **Azure OpenAI** endpoint (API Key o credenziali SSO aziendali via MSAL)

---

## Installazione e deploy

### 1. Clona il repository

```bash
git clone https://github.com/emancesc/FinOps_TAGViewer.git
cd FinOps_TAGViewer
```

### 2. Installa le dipendenze

```bash
npm install
```

### 3. Configura Neo4j

**Opzione A — Neo4j locale**

1. Installa Neo4j Community Edition
2. Avvia il database (porta Bolt: 7687)
3. Imposta la password che userai nel file `.env`

**Opzione B — AuraDB Free (cloud)**

1. Registrati su [neo4j.com/cloud](https://neo4j.com/cloud/platform/aura-graph-database/)
2. Crea una istanza Free
3. Usa l'URI `neo4j+s://...` nel file `.env`

### 4. Configura le variabili d'ambiente

```bash
cp .env.example .env
```

Edita `.env` con i tuoi valori (vedi sezione [Configurazione](#configurazione)).

---

## Configurazione

Copia `.env.example` in `.env` e compila i valori:

```env
# Porta del server web
PORT=3000

# ── Neo4j ──────────────────────────────────────────────────────────
NEO4J_URI=bolt://localhost:7687
# NEO4J_URI=neo4j+s://xxxxxxxx.databases.neo4j.io  # AuraDB
NEO4J_USER=neo4j
NEO4J_PASSWORD=la_tua_password_neo4j

# ── LLM provider default (per nuovi progetti) ──────────────────────
# Valori: 'bedrock' | 'claude' | 'azure-openai'
LLM_PROVIDER=claude

# ── Claude Anthropic (API Key diretta) ─────────────────────────────
ANTHROPIC_API_KEY=sk-ant-...

# ── AWS Bedrock (Claude via SSO IAM) ───────────────────────────────
# Profilo AWS CLI configurato con SSO (aws configure sso)
# AWS_PROFILE=nome-profilo
# BEDROCK_REGION=us-east-1
# BEDROCK_MODEL_ID=anthropic.claude-sonnet-4-6

# ── Azure OpenAI ───────────────────────────────────────────────────
# Metodo 1: API Key diretta
# AZURE_OPENAI_ENDPOINT=https://YOUR_RESOURCE.openai.azure.com
# AZURE_OPENAI_API_KEY=your_azure_openai_key
# AZURE_OPENAI_DEPLOYMENT=gpt-4o

# Metodo 2: SSO via MSAL device-code (lascia API_KEY vuota)
# AZURE_TENANT_ID=your-tenant-id
# AZURE_CLIENT_ID=your-client-app-id
# AZURE_OPENAI_SCOPE=https://cognitiveservices.azure.com/.default
```

> Non è necessario configurare tutti i provider. Il provider viene scelto per ogni progetto e può essere cambiato in qualsiasi momento.

---

## Avvio

### 1. (Solo Bedrock) Rinnova la sessione SSO AWS

```bash
aws sso login --profile nome-profilo
```

### 2. Avvia il server

```bash
# Produzione
node server.js

# Sviluppo (ricarica su salvataggio)
node --watch server.js
```

Apri il browser su `http://localhost:3000`

### Output atteso

```
Neo4j connected
TagsViewer running at http://localhost:3000
```

---

## Flusso operativo

### Flusso A — XLSX Tagging (consigliato per delivery AWS)

```
1. Crea Progetto        → Nome, Account AWS ID, regione, LLM provider
        ↓
2. Carica Documenti     → [guideline] Tagging Strategy, HLD (PDF/DOCX)
                          [assessment] File assessment on-prem (XLSX)
                              → crea nodi assessment nel grafo (cubi viola)
                          [tagging_target] File XLSX estrazione AWS da completare
                              → auto-rileva colonne Tag:cineca:* e Taggable
        ↓
3. Configura Colonne    → Seleziona foglio, colonna Taggable, colonne tag
                          Personalizza il prompt template se necessario
        ↓
4. Avvia XLSX Tagging   → Filtra righe Taggable=Y, batch da 15 al LLM
                          Task Widget mostra progresso in tempo reale
        ↓
5. Scarica XLSX         → File completato con colonne cineca:* valorizzate
        ↓
6. Grafo 3D             → Confronta nodi assessment (cubi viola) vs delivery (sfere)
                          Filtro "Assessment" / "Delivery" / "Tutti"
                          Filtro proprietà: cineca:Service=LDAP
        ↓
7. Strategie Tagging    → Definisci regole per tag [?] incerti
                          Applica bulk a tutte le risorse matching
```

### Flusso B — Tagging via Neo4j (resource_export)

```
1. Crea Progetto
        ↓
2. Carica Documenti     → [resource_export] JSON/CSV da AWS Resource Explorer
                          [guideline] Tagging Strategy
                          [assessment] Assessment on-prem (XLSX)
        ↓
3. Avvia Tagging LLM    → Bottone "▶ Avvia Tagging"
                          Batch da 20 risorse, Widget progresso SSE
        ↓
4. Grafo 3D             → Filtra per status, servizio, tipo nodo
                          Click nodo → modifica/conferma tag
                          Chat Assistente → risolvi "uncertain"
        ↓
5. Esporta              → XLSX colorato + Markdown riepilogativo
```

---

## API Reference

### Projects

| Metodo | Path | Descrizione |
|---|---|---|
| GET | `/api/projects` | Lista tutti i progetti |
| POST | `/api/projects` | Crea progetto (`name`, `accountId`, `region`, `llmProvider`) |
| GET | `/api/projects/:id` | Dettaglio progetto con contatori |
| PATCH | `/api/projects/:id` | Aggiorna `name`, `llmProvider`, `status` |
| PATCH | `/api/projects/:id/column-config` | Salva configurazione colonne XLSX (`columnConfig`, `promptTemplate`, `taggingTargetFile`) |
| DELETE | `/api/projects/:id` | Elimina progetto e tutte le risorse/documenti |

### Documents

| Metodo | Path | Descrizione |
|---|---|---|
| GET | `/api/documents/:projectId` | Lista documenti del progetto |
| POST | `/api/documents/:projectId` | Upload documento (`multipart/form-data`, campo `file` + `docType`) |
| DELETE | `/api/documents/:projectId/:docId` | Elimina documento |

**`docType`**: `resource_export` \| `guideline` \| `assessment` \| `tagging_target`

### Graph

| Metodo | Path | Descrizione |
|---|---|---|
| GET | `/api/graph/:projectId` | Nodi + archi (query: `?filter=status&filterValue=uncertain&nodeType=assessment`) |
| GET | `/api/graph/:projectId/stats` | Contatori per stato, per servizio e per `nodeType` |
| PATCH | `/api/graph/:projectId/resource/:resourceId` | Aggiorna `proposedTags`, `status`, `notes` |

**Parametri query `GET /api/graph/:id`**:
- `filter=status` + `filterValue=pending|tagged|uncertain|confirmed|assessment`
- `filter=service` + `filterValue=EC2` (o qualsiasi servizio)
- `nodeType=delivery|assessment|all`

### Tagging

| Metodo | Path | Descrizione |
|---|---|---|
| POST | `/api/tagging/:projectId/run` | Avvia tagging LLM su tutte le risorse `pending` |
| GET | `/api/tagging/:projectId/progress` | **SSE** — progresso real-time (batch, count, errori) |
| GET | `/api/tagging/:projectId/status` | Snapshot contatori `pending/tagged/uncertain/confirmed` |
| POST | `/api/tagging/:projectId/resource/:resourceId` | Ri-tagga singola risorsa (body: `{ guidance }`) |
| PATCH | `/api/tagging/:projectId/resource/:resourceId/confirm` | Conferma manuale tag (body: `{ tags }`) |
| POST | `/api/tagging/:projectId/detect-columns` | Auto-rileva colonne del file `tagging_target` (body: `{ storedAs }`) |
| POST | `/api/tagging/:projectId/run-xlsx` | Avvia pipeline XLSX tagging (fire-and-forget) |
| POST | `/api/tagging/:projectId/pause-xlsx` | Sospende il tagging XLSX tra un batch e il successivo |
| POST | `/api/tagging/:projectId/resume-xlsx` | Riprende il tagging XLSX sospeso |
| GET | `/api/tagging/:projectId/progress-xlsx` | **SSE** — progresso pipeline XLSX |
| GET | `/api/tagging/:projectId/result-xlsx` | Download XLSX completato |

**Formato eventi SSE progress**:
```json
{ "status": "running", "total": 120, "processed": 40, "batch": 2, "batchTotal": 6,
  "startedAt": 1722330000000, "etaMs": 150000, "errors": [] }

{ "status": "paused", "total": 120, "processed": 40, "batch": 2, "batchTotal": 6,
  "startedAt": 1722330000000, "etaMs": null, "errors": [] }

{ "status": "done", "total": 120, "processed": 120, "endedAt": 1722330240000, "errors": [] }
```

> **`etaMs`**: millisecondi stimati al completamento, calcolati dalla velocità media dei batch precedenti. `null` se il processo è in pausa o non ancora avviato.

### Strategies

| Metodo | Path | Descrizione |
|---|---|---|
| GET | `/api/strategies/:projectId` | Lista strategie del progetto |
| POST | `/api/strategies/:projectId` | Crea strategia (`name`, `conditionField`, `conditionOp`, `conditionValue`, `tagColumn`, `tagValue`) |
| PATCH | `/api/strategies/:projectId/:strategyId` | Aggiorna (tipicamente `{ enabled: true/false }`) |
| DELETE | `/api/strategies/:projectId/:strategyId` | Elimina strategia |
| POST | `/api/strategies/:projectId/apply` | Applica tutte le strategie abilitate; ritorna `{ updated: N }` |

**Campi `conditionField`**: `resourceType` \| `service` \| `region` \| `name`  
**Valori `conditionOp`**: `equals` \| `contains` \| `startsWith`

### Chat (SSE)

| Metodo | Path | Descrizione |
|---|---|---|
| POST | `/api/chat/:projectId` | Stream SSE della risposta LLM (body: `{ message, history? }`) |

**Formato eventi SSE chat**:
```
data: {"type":"chunk","text":"..."}
data: {"type":"graph_updated","count":3}
data: {"type":"done"}
data: {"type":"error","message":"..."}
```

### Export

| Metodo | Path | Descrizione |
|---|---|---|
| GET | `/api/export/:projectId/xlsx` | Download XLSX con tutte le risorse taggate |
| GET | `/api/export/:projectId/summary` | Download Markdown riepilogativo |

### Auth

| Metodo | Path | Descrizione |
|---|---|---|
| POST | `/api/auth/azure/start` | Avvia device-code flow MSAL per Azure OpenAI |
| GET | `/api/auth/azure/status` | Verifica stato token Azure |
| GET | `/api/auth/bedrock/status` | Verifica sessione SSO AWS attiva |
| POST | `/api/auth/bedrock/login` | Avvia `aws sso login` (apre browser) |

---

## Schema Neo4j

### Nodi

```cypher
(:Project {
  id: String,               // UUID
  name: String,
  accountId: String,        // AWS Account ID (12 cifre)
  region: String,           // es. eu-south-1
  llmProvider: String,      // 'bedrock' | 'claude' | 'azure-openai'
  columnConfig: String,     // JSON — config colonne XLSX per tagging_target
  promptTemplate: String,   // template prompt XLSX tagging
  taggingTargetFile: String,// nome file tagging_target in uploads/
  tagStrategies: String,    // JSON — array regole di valorizzazione tag
  createdAt: DateTime,
  status: String            // 'active' | 'archived'
})

(:Resource {
  id: String,               // UUID
  projectId: String,
  arn: String,              // Amazon Resource Name (vuoto per nodi assessment)
  resourceType: String,     // es. AWS::EC2::Instance | OnPrem::Resource
  service: String,          // es. EC2, RDS, S3, OnPrem
  resourceId: String,       // es. i-1234567890abcdef0
  name: String,
  region: String,
  accountId: String,
  rawTags: String,          // JSON — tag originali da AWS
  proposedTags: String,     // JSON — tag proposti da LLM o da XLSX pipeline
  confidence: Float,        // 0.0 – 1.0
  status: String,           // 'pending' | 'tagged' | 'uncertain' | 'confirmed' | 'assessment'
  nodeType: String,         // 'delivery' | 'assessment'
  notes: String             // reasoning LLM, dati extra assessment (JSON), note manuali
})

(:Document {
  id: String,
  projectId: String,
  type: String,             // 'resource_export' | 'guideline' | 'assessment' | 'tagging_target'
  filename: String,
  storedAs: String,         // nome file in uploads/
  resourceCount: Int,
  uploadedAt: DateTime
})
```

### Relazioni

```cypher
(Project)-[:HAS_RESOURCE]->(Resource)
(Project)-[:HAS_DOCUMENT]->(Document)
(Resource)-[:DEPENDS_ON]->(Resource)   // dipendenza diretta (inferita da servizio/regione)
(Resource)-[:PART_OF]->(Resource)      // gerarchia
(Resource)-[:SAME_APP]->(Resource)     // stessa applicazione
(Resource)-[:SAME_ENV]->(Resource)     // stesso environment
```

### Differenza nodi delivery vs assessment

| Proprietà | `nodeType: delivery` | `nodeType: assessment` |
|---|---|---|
| Sorgente | AWS Resource Explorer / XLSX estrazione | XLSX assessment pre-migrazione |
| ARN | valorizzato | vuoto |
| `resourceType` | `AWS::EC2::Instance` ecc. | `OnPrem::Resource` o tipo rilevato |
| `status` iniziale | `pending` | `assessment` |
| Grafo 3D | sfera, colore per status | cubo viola (`#a78bfa`) |

### Indici e constraint

```cypher
CONSTRAINT project_id  FOR (p:Project)  REQUIRE p.id IS UNIQUE
CONSTRAINT resource_id FOR (r:Resource) REQUIRE r.id IS UNIQUE
CONSTRAINT document_id FOR (d:Document) REQUIRE d.id IS UNIQUE
```

I constraint vengono creati automaticamente all'avvio del server.

---

## Struttura del progetto

```
FinOps_TAGViewer/
├── server.js                        # Entry point Express
├── package.json
├── .env.example                     # Template variabili d'ambiente
├── .gitignore
│
├── src/
│   ├── routes/
│   │   ├── projects.js              # CRUD progetti + column-config
│   │   ├── documents.js             # Upload e parsing documenti
│   │   ├── graph.js                 # Query grafo Neo4j + filtri nodeType
│   │   ├── tagging.js               # Tagging LLM + XLSX pipeline + SSE progress
│   │   ├── strategies.js            # CRUD strategie + apply bulk
│   │   ├── chat.js                  # Chat SSE con contesto risorse
│   │   ├── export.js                # Download XLSX e Markdown
│   │   └── auth.js                  # MSAL Azure + AWS SSO Bedrock
│   │
│   ├── services/
│   │   ├── db.js                    # Neo4j driver, initDb, runQuery
│   │   ├── parser.js                # Parse JSON/CSV/PDF/DOCX/XLSX → risorse
│   │   │                            # XLSX assessment → nodi nodeType: assessment
│   │   ├── llm.js                   # Astrazione Bedrock + Claude + Azure OpenAI
│   │   ├── tagger.js                # Batch tagging Neo4j + progress tracker
│   │   ├── xlsxTagger.js            # Pipeline XLSX in/out con colonne dinamiche
│   │   └── exporter.js              # Generazione XLSX e Markdown
│   │
│   └── prompts/
│       ├── tag_resources.js         # Prompt tagging batch Neo4j
│       └── chat_system.js           # System prompt chat assistente
│
├── public/                          # Frontend SPA (no bundler)
│   ├── index.html
│   ├── css/style.css                # Design system dark theme
│   └── js/
│       ├── api.js                   # Fetch wrapper globale (window.api)
│       ├── app.js                   # SPA router, gestione progetto corrente
│       ├── views/
│       │   ├── projects.js          # Lista progetti + modal creazione
│       │   ├── upload.js            # Upload documenti + XLSX column config + tagging
│       │   ├── graph.js             # Grafo 3D con filtri delivery/assessment
│       │   ├── export.js            # Pannello esportazione
│       │   └── strategies.js        # Editor regole valorizzazione tag
│       └── components/
│           ├── chat.js              # Chat panel SSE floating
│           └── tasks.js             # Task progress widget SSE floating
│
└── uploads/                         # File caricati (gitignored)
```

---

## Limitazioni note

- Il token Azure MSAL è in-memory: si perde al riavvio del server
- La sessione SSO AWS scade periodicamente; rieseguire `aws sso login` per rinnovarla
- Il ruolo AWS deve includere `bedrock:InvokeModel` sulla regione `BEDROCK_REGION` configurata
- Le relazioni architetturali tra nodi delivery sono inferite da euristiche (servizio + regione), non da dependency data reale
- Il confronto assessment↔delivery è visivo (grafo + filtri); il linking automatico dei nodi è manuale via relazioni Neo4j
- Il contenuto dei documenti guideline/assessment viene troncato a 50.000 caratteri per i limiti di contesto LLM
- Supporto multi-utente non presente; la progress map è in-memory e condivisa tra sessioni

---

## Licenza

Uso interno CINECA. Non distribuire.
