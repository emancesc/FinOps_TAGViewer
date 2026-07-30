import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb } from './src/services/db.js';

import projectsRouter from './src/routes/projects.js';
import documentsRouter from './src/routes/documents.js';
import graphRouter from './src/routes/graph.js';
import taggingRouter from './src/routes/tagging.js';
import chatRouter from './src/routes/chat.js';
import exportRouter from './src/routes/export.js';
import authRouter from './src/routes/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/projects',   projectsRouter);
app.use('/api/documents',  documentsRouter);
app.use('/api/graph',      graphRouter);
app.use('/api/tagging',    taggingRouter);
app.use('/api/chat',       chatRouter);
app.use('/api/export',     exportRouter);
app.use('/api/auth',       authRouter);

// SPA fallback
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

await initDb();
app.listen(PORT, () =>
  console.log(`TagsViewer running at http://localhost:${PORT}`)
);
