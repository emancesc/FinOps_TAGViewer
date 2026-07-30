import { Router } from 'express';
import { startDeviceCodeFlow, pollDeviceCode, getAzureToken } from '../services/llm.js';

const router = Router();

// POST /api/auth/azure/start — avvia device-code flow per Azure OpenAI SSO
router.post('/azure/start', async (_req, res) => {
  try {
    const flow = await startDeviceCodeFlow();
    res.json({
      userCode: flow.userCode,
      verificationUri: flow.verificationUri,
      message: flow.message,
      expiresIn: flow.expiresIn,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/auth/azure/status — verifica se il token è già stato ottenuto
router.get('/azure/status', (_req, res) => {
  const token = getAzureToken();
  res.json({ authenticated: !!token, expiresAt: token?.expiresOn || null });
});

export default router;
