import Anthropic from '@anthropic-ai/sdk';
import { AzureOpenAI } from 'openai';
import { PublicClientApplication, DeviceCodeRequest } from '@azure/msal-node';

// ---------------------------------------------------------------------------
// Stato globale token Azure (in-memory, non persistito)
// ---------------------------------------------------------------------------
let _azureToken = null;
let _msalApp = null;
let _deviceCodePending = null;

function getMsalApp() {
  if (!_msalApp) {
    _msalApp = new PublicClientApplication({
      auth: {
        clientId: process.env.AZURE_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
      },
    });
  }
  return _msalApp;
}

export async function startDeviceCodeFlow() {
  const app = getMsalApp();
  const request = {
    scopes: [process.env.AZURE_OPENAI_SCOPE || 'https://cognitiveservices.azure.com/.default'],
    deviceCodeCallback: (response) => { _deviceCodePending = response; },
  };
  // Avvia in background
  app.acquireTokenByDeviceCode(request)
    .then(result => { _azureToken = result; _deviceCodePending = null; })
    .catch(err => console.error('[MSAL] device code error:', err.message));

  // Aspetta che il callback sia stato chiamato (max 5s)
  let waited = 0;
  while (!_deviceCodePending && waited < 5000) {
    await new Promise(r => setTimeout(r, 200));
    waited += 200;
  }
  return _deviceCodePending;
}

export function getAzureToken() { return _azureToken; }

// ---------------------------------------------------------------------------
// Astrazione LLM
// ---------------------------------------------------------------------------
class ClaudeLLM {
  constructor() {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async complete(systemPrompt, userMessage) {
    const msg = await this.client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });
    return msg.content[0].text;
  }

  async *streamChat(systemPrompt, messages) {
    const stream = this.client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages,
    });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text;
      }
    }
  }
}

class AzureOpenAILLM {
  _getClient() {
    if (process.env.AZURE_OPENAI_API_KEY) {
      return new AzureOpenAI({
        endpoint: process.env.AZURE_OPENAI_ENDPOINT,
        apiKey: process.env.AZURE_OPENAI_API_KEY,
        apiVersion: '2024-02-01',
      });
    }
    if (_azureToken) {
      return new AzureOpenAI({
        endpoint: process.env.AZURE_OPENAI_ENDPOINT,
        apiKey: _azureToken.accessToken,
        apiVersion: '2024-02-01',
      });
    }
    throw new Error('Azure OpenAI non configurato: imposta AZURE_OPENAI_API_KEY o completa il flusso SSO');
  }

  async complete(systemPrompt, userMessage) {
    const client = this._getClient();
    const response = await client.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    });
    return response.choices[0].message.content;
  }

  async *streamChat(systemPrompt, messages) {
    const client = this._getClient();
    const stream = await client.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o',
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      stream: true,
    });
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (text) yield text;
    }
  }
}

const _claude = new ClaudeLLM();
const _azure = new AzureOpenAILLM();

export function getLLM(provider = 'claude') {
  return provider === 'azure-openai' ? _azure : _claude;
}
