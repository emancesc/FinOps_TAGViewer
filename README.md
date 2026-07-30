# TagsViewer — AWS Resource Tagging Graph

Applicazione web leggera per la **governance del tagging AWS** basata su graph database. Permette di importare risorse da AWS Resource Explorer, applicare automaticamente i tag tramite LLM (Claude o Azure OpenAI), navigare le relazioni architetturali in un grafo 3D interattivo e produrre report di esportazione in formato XLSX e Markdown.

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
┌─────────────────────────────────────────────────────────────┐
│                        Browser (SPA)                        │
│  ┌───────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ Projects  │  │   Upload &   │  │   3D Graph View      │  │
│  │  Manager  │  │   Tagging    │  │   (3d-force-graph    │  │
│  │           │  │   Control    │  │    + Three.js)       │  │
│  └───────────┘  └──────────────┘  └──────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐   │
│  │         Chat Assistente FinOps (SSE streaming)        │   │
│  └───────────────────────────────────────────────────────┘   │
└────────────────────────────┬────────────────────────────────┘
                             │ HTTP / SSE
┌────────────────────────────▼────────────────────────────────┐
│                   Node.js + Express API                      │
│                                                              │
│  /api/projects   /api/documents   /api/graph                 │
│  /api/tagging    /api/chat        /api/export  /api/auth     │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐    │
│  │   Parser    │  │    Tagger    │  │    Exporter      │    │
│  │ (JSON/CSV/  │  │ (batch LLM,  │  │ (ExcelJS XLSX,   │    │
│  │  PDF/DOCX)  │  │  20 res/call)│  │  Markdown)       │    │
│  └─────────────┘  └──────────────┘  └──────────────────┘    │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │                  LLM Abstraction                     │    │
│  │  Claude (Anthropic SDK) │ Azure OpenAI + MSAL SSO   │    │
│  └──────────────────────────────────────────────────────┘    │
└────────────────────────────┬────────────────────────────────┘
                             │ Bolt / neo4j+s
┌────────────────────────────▼────────────────────────────────┐
│                        Neo4j Graph DB                        │
│   (:Project) ─[:HAS_RESOURCE]──► (:Resource)                 │
│   (:Project) ─[:HAS_DOCUMENT]──► (:Document)                 │
│   (:Resource)─[:DEPENDS_ON]────► (:Resource)                 │
│   (:Resource)─[:PART_OF]───────► (:Resource)                 │
└─────────────────────────────────────────────────────────────┘
```

### Componenti principali

| Componente | Responsabilità |
|---|---|
| **Express Router** | 7 router REST + SSE per lo streaming della chat |
| **Parser** | Normalizza JSON/CSV (Resource Explorer), PDF, DOCX, XLSX in strutture uniformi |
| **Tagger** | Orchesta le chiamate LLM in batch da 20 risorse, scrive i risultati in Neo4j |
| **LLM Service** | Astrazione su Claude (Anthropic SDK) e Azure OpenAI con device-code MSAL |
| **Graph Service** | Query Cypher per nodi, archi e statistiche; espone i dati al frontend |
| **Exporter** | Genera XLSX colorato per stato (ExcelJS) e Markdown riepilogativo |
| **Chat SSE** | Stream asincrono della risposta LLM; applica automaticamente i tag aggiornati suggeriti nella risposta |
| **3D Graph** | Rendering Three.js tramite `3d-force-graph`; click su nodo apre pannello di editing tag |

---

## Funzionalità

### Gestione Progetti
- Crea un **progetto per ogni account AWS** (nome, Account ID, regione, LLM provider)
- Dashboard con contatori per stato (pending / tagged / uncertain / confirmed) e barra di progresso
- Cambia LLM provider per progetto in qualsiasi momento

### Importazione Documenti (3 tipi)
| Tipo | Formato accettato | Cosa estrae |
|---|---|---|
| **Estrazione AWS Resource Explorer** | JSON, CSV | Risorse con ARN, tipo, regione, tag esistenti |
| **Linee guida** (HLD, Tagging Strategy) | PDF, DOCX, TXT, MD | Testo inviato come contesto al LLM |
| **Assessment** (on-prem / cloud design) | PDF, DOCX, XLSX | Testo inviato come contesto al LLM |

### Tagging automatico LLM
- Processo in background, fire-and-forget
- Batch da 20 risorse per chiamata LLM
- Ogni risorsa riceve: tag proposti nel namespace `cineca:`, confidence score (0–1), stato, reasoning
- Soglia di incertezza configurabile nel prompt (`uncertain` se confidence < 0.7)
- **Re-tagging singola risorsa** con hint aggiuntivo dell'utente

### Grafo 3D interattivo
- Force-directed graph 3D con Three.js (`3d-force-graph`)
- **Colori nodi per stato**: grigio (pending), blu (tagged), arancio (uncertain), verde (confirmed)
- **Dimensione nodo** proporzionale al numero di tag assegnati
- Frecce direzionali sugli archi con etichetta relazione (DEPENDS_ON, PART_OF, SAME_APP, SAME_ENV)
- **Filtri**: per stato o per servizio AWS
- Click su nodo → pannello editing tag inline con conferma / ri-tagging LLM

### Chat Assistente FinOps
- Streaming SSE in tempo reale
- Carica automaticamente il contesto delle risorse `uncertain` del progetto
- Include le linee guida caricate come contesto
- Se la risposta LLM contiene un blocco JSON con tag aggiornati, li applica automaticamente al grafo
- Storico conversazione (ultimi 10 scambi)

### Esportazione
- **XLSX**: un foglio per tutte le risorse, un tag per colonna, colorazione per stato, foglio riepilogativo
- **Markdown**: documento raggruppato per servizio AWS con tag, confidence, reasoning e metadati di progetto

### Autenticazione Azure OpenAI (SSO)
- Device-code flow MSAL: l'utente apre `microsoft.com/devicelogin`, inserisce il codice e si autentica con le credenziali aziendali
- Il token viene catturato automaticamente e usato per tutte le chiamate Azure OpenAI successive
- Alternativa: API Key diretta nella variabile d'ambiente

---

## Stack tecnologico

| Layer | Tecnologia |
|---|---|
| Runtime | Node.js 20+ (ES Modules) |
| Web framework | Express 4 |
| Graph DB | Neo4j 5 (Community / AuraDB Free) |
| LLM - Claude | `@anthropic-ai/sdk` |
| LLM - Azure | `openai` SDK (Azure-compatible) + `@azure/msal-node` |
| Parsing PDF | `pdf-parse` |
| Parsing DOCX | `mammoth` |
| Parsing CSV | `csv-parse` |
| Export XLSX | `exceljs` |
| Upload file | `multer` 2 |
| Frontend | Vanilla JS (ES Modules, no bundler) |
| Grafo 3D | `3d-force-graph` (Three.js) via CDN |

---

## Prerequisiti

- **Node.js** 20 o superiore (`node --version`)
- **Neo4j** in una delle configurazioni:
  - **Locale**: [Neo4j Desktop](https://neo4j.com/download/) (Community Edition inclusa) — URI: `bolt://localhost:7687`
  - **Cloud**: [AuraDB Free](https://neo4j.com/cloud/platform/aura-graph-database/) — URI: `neo4j+s://xxxxxxxx.databases.neo4j.io`
- Almeno uno tra:
  - **Anthropic API Key** — da [console.anthropic.com](https://console.anthropic.com)
  - **Azure OpenAI** endpoint (API Key o credenziali SSO aziendali)

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

**Opzione A — Neo4j Desktop (locale, raccomandato per sviluppo)**

1. Scarica e installa [Neo4j Desktop](https://neo4j.com/download/)
2. Crea un nuovo progetto e avvia un database locale
3. Imposta la password che userai nel file `.env`
4. Verifica che il database sia in stato **Running** (porta Bolt: 7687)

**Opzione B — AuraDB Free (cloud, zero infrastruttura)**

1. Registrati su [neo4j.com/cloud](https://neo4j.com/cloud/platform/aura-graph-database/)
2. Crea una istanza Free (200k nodi, 400k relazioni)
3. Scarica il file di credenziali generato alla creazione
4. Usa l'URI `neo4j+s://...` nel file `.env`

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
# Locale:
NEO4J_URI=bolt://localhost:7687
# AuraDB Free (cloud):
# NEO4J_URI=neo4j+s://xxxxxxxx.databases.neo4j.io

NEO4J_USER=neo4j
NEO4J_PASSWORD=la_tua_password_neo4j

# ── Claude (Anthropic) ─────────────────────────────────────────────
ANTHROPIC_API_KEY=sk-ant-...

# ── Azure OpenAI ───────────────────────────────────────────────────
# Metodo 1: API Key diretta
AZURE_OPENAI_ENDPOINT=https://YOUR_RESOURCE.openai.azure.com
AZURE_OPENAI_API_KEY=your_azure_openai_key
AZURE_OPENAI_DEPLOYMENT=gpt-4o

# Metodo 2: SSO via MSAL (device-code) — lascia API_KEY vuota
AZURE_TENANT_ID=your-tenant-id
AZURE_CLIENT_ID=your-client-app-id
AZURE_OPENAI_SCOPE=https://cognitiveservices.azure.com/.default
```

> **Nota**: non è necessario configurare entrambi i provider. Il provider viene scelto per ogni progetto nell'interfaccia.

---

## Avvio

### Modalità produzione

```bash
node server.js
```

### Modalità sviluppo (ricarica automatica su salvataggio)

```bash
node --watch server.js
```

Apri il browser su `http://localhost:3000`

### Output atteso all'avvio

```
Neo4j connected
TagsViewer running at http://localhost:3000
```

Se Neo4j non è raggiungibile, il server stampa un errore di connessione e si interrompe.

---

## Flusso operativo

```
1. Crea Progetto          → Nome, Account AWS ID, regione, LLM provider
         ↓
2. Carica Documenti       → Estrazione Resource Explorer (JSON/CSV)
                            + Tagging Strategy / HLD (PDF/DOCX)
                            + Assessment (PDF/DOCX)
         ↓
3. Avvia Tagging LLM      → Bottone "▶ Avvia Tagging"
                            Elaborazione in background, batch da 20 risorse
                            Aggiorna automaticamente stati e tag nel grafo
         ↓
4. Esplora Grafo 3D       → Naviga, filtra per stato/servizio
                            Clicca nodo → modifica/conferma tag
                            Ri-tagga singola risorsa con hint
         ↓
5. Chat Assistente         → Risolvi risorse "uncertain"
                            Il LLM legge il contesto del progetto e
                            aggiorna i tag direttamente nel grafo
         ↓
6. Esporta                 → XLSX colorato + Markdown riepilogativo
```

### Autenticazione Azure OpenAI con SSO

Se il progetto usa `azure-openai` e non è configurata `AZURE_OPENAI_API_KEY`:

```bash
# 1. Avvia il flow da terminale o chiama l'endpoint
POST /api/auth/azure/start

# Risposta:
{
  "userCode": "ABCD-1234",
  "verificationUri": "https://microsoft.com/devicelogin",
  "message": "Vai su https://microsoft.com/devicelogin e inserisci il codice ABCD-1234"
}

# 2. L'utente si autentica sul browser con le credenziali aziendali
# 3. Il token viene acquisito automaticamente
# 4. Verifica stato:
GET /api/auth/azure/status
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
| DELETE | `/api/projects/:id` | Elimina progetto e tutte le risorse/documenti |

### Documents

| Metodo | Path | Descrizione |
|---|---|---|
| GET | `/api/documents/:projectId` | Lista documenti del progetto |
| POST | `/api/documents/:projectId` | Upload documento (`multipart/form-data`, campo `file` + `docType`) |
| DELETE | `/api/documents/:projectId/:docId` | Elimina documento |

**`docType`**: `resource_export` \| `guideline` \| `assessment`

### Graph

| Metodo | Path | Descrizione |
|---|---|---|
| GET | `/api/graph/:projectId` | Nodi + archi (query: `?filter=status&filterValue=uncertain`) |
| GET | `/api/graph/:projectId/stats` | Contatori per stato e per servizio |
| PATCH | `/api/graph/:projectId/resource/:resourceId` | Aggiorna `proposedTags`, `status`, `notes` |

### Tagging

| Metodo | Path | Descrizione |
|---|---|---|
| POST | `/api/tagging/:projectId/run` | Avvia tagging LLM su tutte le risorse `pending` |
| GET | `/api/tagging/:projectId/status` | Contatori `pending/tagged/uncertain/confirmed` |
| POST | `/api/tagging/:projectId/resource/:resourceId` | Ri-tagga singola risorsa (body: `{ guidance }`) |
| PATCH | `/api/tagging/:projectId/resource/:resourceId/confirm` | Conferma manuale tag (body: `{ tags }`) |

### Chat (SSE)

| Metodo | Path | Descrizione |
|---|---|---|
| POST | `/api/chat/:projectId` | Stream SSE della risposta LLM (body: `{ message, resourceIds?, history? }`) |

**Formato eventi SSE**:
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
| POST | `/api/auth/azure/start` | Avvia device-code flow MSAL |
| GET | `/api/auth/azure/status` | Verifica stato autenticazione Azure |

---

## Schema Neo4j

### Nodi

```cypher
(:Project {
  id: String,           // UUID
  name: String,
  accountId: String,    // AWS Account ID (12 cifre)
  region: String,       // es. eu-west-1
  llmProvider: String,  // 'claude' | 'azure-openai'
  createdAt: DateTime,
  status: String        // 'active' | 'archived'
})

(:Resource {
  id: String,           // UUID
  projectId: String,
  arn: String,          // Amazon Resource Name completo
  resourceType: String, // es. AWS::EC2::Instance
  service: String,      // es. EC2, RDS, S3
  resourceId: String,   // es. i-1234567890abcdef0
  name: String,
  region: String,
  accountId: String,
  rawTags: String,      // JSON — tag originali da AWS
  proposedTags: String, // JSON — tag proposti da LLM
  confidence: Float,    // 0.0 - 1.0
  status: String,       // 'pending' | 'tagged' | 'uncertain' | 'confirmed'
  notes: String         // reasoning LLM o note manuali
})

(:Document {
  id: String,
  projectId: String,
  type: String,         // 'resource_export' | 'guideline' | 'assessment'
  filename: String,
  storedAs: String,     // nome file in uploads/
  resourceCount: Int,
  uploadedAt: DateTime
})
```

### Relazioni

```cypher
(Project)-[:HAS_RESOURCE]->(Resource)
(Project)-[:HAS_DOCUMENT]->(Document)
(Resource)-[:DEPENDS_ON]->(Resource)   // dipendenza diretta
(Resource)-[:PART_OF]->(Resource)      // gerarchia
(Resource)-[:SAME_APP]->(Resource)     // stessa applicazione
(Resource)-[:SAME_ENV]->(Resource)     // stesso environment
```

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
│   │   ├── projects.js              # CRUD progetti
│   │   ├── documents.js             # Upload e parsing documenti
│   │   ├── graph.js                 # Query grafo Neo4j
│   │   ├── tagging.js               # Orchestrazione tagging LLM
│   │   ├── chat.js                  # Chat SSE con contesto risorse
│   │   ├── export.js                # Download XLSX e Markdown
│   │   └── auth.js                  # MSAL device-code flow Azure
│   │
│   ├── services/
│   │   ├── db.js                    # Neo4j driver, initDb, runQuery
│   │   ├── parser.js                # Parse JSON/CSV/PDF/DOCX → risorse
│   │   ├── llm.js                   # Astrazione Claude + Azure OpenAI
│   │   ├── tagger.js                # Batch tagging + ingestion Neo4j
│   │   └── exporter.js             # Generazione XLSX e Markdown
│   │
│   └── prompts/
│       ├── tag_resources.js         # Prompt tagging batch
│       └── chat_system.js          # System prompt chat assistente
│
├── public/                          # Frontend SPA (no bundler)
│   ├── index.html
│   ├── css/style.css                # Design system dark theme
│   └── js/
│       ├── api.js                   # Fetch wrapper globale (window.api)
│       ├── app.js                   # SPA router, gestione progetto corrente
│       ├── views/
│       │   ├── projects.js          # Lista progetti + modal creazione
│       │   ├── upload.js            # Upload documenti + stato tagging
│       │   ├── graph.js             # Grafo 3D (3d-force-graph)
│       │   └── export.js            # Pannello esportazione
│       └── components/
│           └── chat.js              # Chat panel SSE floating
│
└── uploads/                         # File caricati (gitignored)
```

---

## Limitazioni note e sviluppi futuri

- Il token Azure MSAL è in-memory: si perde al riavvio del server (aggiungere persistenza con cache cifrata)
- Le relazioni architetturali inferite automaticamente (DEPENDS_ON, ecc.) sono basate su euristiche per tipo di servizio e regione; l'import di relazioni esplicite da AWS Config Rules migliorerà la precisione
- Il contenuto testuale dei documenti guideline/assessment viene troncato a 50.000 caratteri per rispettare i limiti di contesto LLM
- Supporto multi-utente non presente: aggiungere sessioni o autenticazione base se l'applicazione è esposta su rete condivisa

---

## Licenza

Uso interno CINECA. Non distribuire.
