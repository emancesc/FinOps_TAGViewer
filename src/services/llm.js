import Anthropic from '@anthropic-ai/sdk';
import { AzureOpenAI } from 'openai';
import { PublicClientApplication } from '@azure/msal-node';
import { BedrockRuntimeClient, InvokeModelWithResponseStreamCommand, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { fromSSO } from '@aws-sdk/credential-providers';

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

// ---------------------------------------------------------------------------
// AWS Bedrock (Claude via SSO IAM)
// ---------------------------------------------------------------------------
class BedrockLLM {
  _getClient() {
    const region = process.env.BEDROCK_REGION || 'us-east-1';
    const profile = process.env.AWS_PROFILE || 'idm-dev';
    const credentials = fromSSO({ profile });
    return new BedrockRuntimeClient({ region, credentials });
  }

  _modelId() {
    return process.env.BEDROCK_MODEL_ID || 'anthropic.claude-sonnet-4-5';
  }

  async complete(systemPrompt, userMessage) {
    const client = this._getClient();
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });
    const cmd = new InvokeModelCommand({
      modelId: this._modelId(),
      contentType: 'application/json',
      accept: 'application/json',
      body,
    });
    const response = await client.send(cmd);
    const parsed = JSON.parse(new TextDecoder().decode(response.body));
    return parsed.content[0].text;
  }

  async *streamChat(systemPrompt, messages) {
    const client = this._getClient();
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 4096,
      system: systemPrompt,
      messages,
    });
    const cmd = new InvokeModelWithResponseStreamCommand({
      modelId: this._modelId(),
      contentType: 'application/json',
      accept: 'application/json',
      body,
    });
    const response = await client.send(cmd);
    for await (const event of response.body) {
      if (event.chunk?.bytes) {
        const chunk = JSON.parse(new TextDecoder().decode(event.chunk.bytes));
        if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
          yield chunk.delta.text;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// GitHub Models (Claude via GitHub PAT — gratuito)
// ---------------------------------------------------------------------------
class GitHubModelsLLM {
  _getClient() {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error('GITHUB_TOKEN non configurato nel .env');
    return new AzureOpenAI({
      endpoint: 'https://models.inference.ai.azure.com',
      apiKey: token,
      apiVersion: '',   // GitHub Models non usa apiVersion
      defaultHeaders: { 'Authorization': `Bearer ${token}` },
    });
  }

  _model() {
    return process.env.GITHUB_MODEL || 'claude-3-7-sonnet';
  }

  async complete(systemPrompt, userMessage) {
    const client = this._getClient();
    const response = await client.chat.completions.create({
      model: this._model(),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 4096,
    });
    return response.choices[0].message.content;
  }

  async *streamChat(systemPrompt, messages) {
    const client = this._getClient();
    const stream = await client.chat.completions.create({
      model: this._model(),
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      max_tokens: 4096,
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
const _bedrock = new BedrockLLM();
const _github = new GitHubModelsLLM();

export function getLLM(provider) {
  const p = provider || process.env.LLM_PROVIDER || 'claude';
  if (p === 'azure-openai') return _azure;
  if (p === 'bedrock') return _bedrock;
  if (p === 'github') return _github;
  return _claude;
}
