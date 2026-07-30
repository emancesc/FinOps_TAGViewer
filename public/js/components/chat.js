// Floating chat component (SSE streaming)
let _chatHistory = [];
let _chatProjectId = null;

window.initChat = function(projectId) {
  _chatProjectId = projectId;
  _chatHistory = [];
  document.getElementById('chatMessages').innerHTML = `
    <div class="chat-msg assistant">Ciao! Sono il tuo assistente FinOps. Posso aiutarti a decidere i tag per le risorse AWS del progetto. Chiedi pure!</div>`;
};

document.getElementById('chatToggle').addEventListener('click', () => {
  document.getElementById('chatPanel').classList.toggle('hidden');
});
document.getElementById('chatClose').addEventListener('click', () => {
  document.getElementById('chatPanel').classList.add('hidden');
});

document.getElementById('chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('chatInput');
  const msg = input.value.trim();
  if (!msg || !_chatProjectId) return;
  input.value = '';

  appendMsg(msg, 'user');
  _chatHistory.push({ role: 'user', content: msg });

  const assistantEl = appendMsg('', 'assistant');
  const cursor = document.createElement('span');
  cursor.className = 'spinner'; cursor.style.display = 'inline-block'; cursor.style.marginLeft = '6px';
  assistantEl.appendChild(cursor);

  let fullText = '';
  try {
    const res = await fetch(`/api/chat/${_chatProjectId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, history: _chatHistory.slice(-8) }),
    });

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let event;
        try { event = JSON.parse(line.slice(6)); } catch { continue; }

        if (event.type === 'chunk') {
          fullText += event.text;
          assistantEl.textContent = renderMarkdown(fullText);
          assistantEl.appendChild(cursor);
          scrollToBottom();
        } else if (event.type === 'graph_updated') {
          window.toast(`Grafo aggiornato: ${event.count} risorse`, 'success');
        } else if (event.type === 'error') {
          assistantEl.textContent = '⚠ Errore: ' + event.message;
        }
      }
    }
  } catch (err) {
    assistantEl.textContent = '⚠ Errore di rete: ' + err.message;
  } finally {
    cursor.remove();
  }

  _chatHistory.push({ role: 'assistant', content: fullText });
  scrollToBottom();
});

function appendMsg(text, role) {
  const el = document.createElement('div');
  el.className = `chat-msg ${role}`;
  el.textContent = text;
  document.getElementById('chatMessages').appendChild(el);
  scrollToBottom();
  return el;
}

function scrollToBottom() {
  const el = document.getElementById('chatMessages');
  el.scrollTop = el.scrollHeight;
}

function renderMarkdown(text) {
  // Minimal markdown: bold, code inline, newlines
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')   // strip ** (textContent doesn't render HTML)
    .replace(/`(.*?)`/g, '$1');
}
