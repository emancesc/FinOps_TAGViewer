import { Router } from 'express';
import { startDeviceCodeFlow, getAzureToken } from '../services/llm.js';
import { execFile } from 'child_process';

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

// GET /api/auth/bedrock/status — verifica se la sessione SSO AWS è attiva
router.get('/bedrock/status', (_req, res) => {
  const profile = process.env.AWS_PROFILE || 'idm-dev';
  execFile('aws', ['sts', 'get-caller-identity', '--profile', profile, '--output', 'json'], (err, stdout) => {
    if (err) {
      return res.json({ authenticated: false, error: 'Sessione SSO scaduta o non avviata. Esegui: aws sso login --profile ' + profile });
    }
    try {
      const identity = JSON.parse(stdout);
      res.json({ authenticated: true, account: identity.Account, arn: identity.Arn });
    } catch {
      res.json({ authenticated: false, error: 'Risposta AWS non valida' });
    }
  });
});

// POST /api/auth/bedrock/login — avvia SSO login (apre browser)
router.post('/bedrock/login', (_req, res) => {
  const profile = process.env.AWS_PROFILE || 'idm-dev';
  execFile('aws', ['sso', 'login', '--profile', profile], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

export default router;
