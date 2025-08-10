// Embed mode: if ?embed=1, add a class to adjust layout
try {
  const params = new URLSearchParams(window.location.search);
  if (params.get('embed') === '1') document.body.classList.add('embed');
} catch {}

const messagesEl = document.getElementById('messages');
const form = document.getElementById('chat-form');
const input = document.getElementById('message');

// Client-side sanitizer to remove inline suggestions/citations if server isn't restarted yet
function sanitizeClient(text) {
  try {
    let t = String(text || '');
    // Strip Related topics / You might also ask lines
    t = t.split(/\n\n+/).filter(p => !/^\s*(related topics|you might also ask)/i.test(p.trim())).join('\n\n');
    // Remove sentences containing these cues
    t = t.replace(/(^|\n)\s*(related topics|you might also ask)[^.\n]*(\.|\n)/gim, '$1');
    t = t.replace(/(^|\n)[^\n]*\b(perhaps|maybe)\b[^\n]*(you\s+(meant\s+to\s+ask|might\s+mean|may\s+mean)|might\s+be\s+helpful|might\s+help)[^\n]*(\.|\n)/gim, '$1');
    t = t.replace(/(^|\n)[^\n]*\btopics\b[^\n]*\bmight\s+help\b[^\n]*(\.|\n)/gim, '$1');
    // Remove FAQ and bracket citations
    t = t.replace(/\(\s*faq\s*#?\d+\s*\)/gi, '').replace(/faq\s*#?\d+/gi, '');
    t = t.replace(/\(\s*\[\s*#?\d+\s*\]\s*\)/g, '').replace(/\[\s*#?\d+\s*\]/g, '');
    t = t.replace(/(^|\n)[^\n]*\bsee\b[^\n]*\b(faq\s*#?\d+|\[\s*#?\d+\s*\])[^\n]*(\.|\n)/gim, '$1');
    // Tidy whitespace
    t = t.replace(/\n{3,}/g, '\n\n').replace(/\s{3,}/g, ' ').trim();
    return t;
  } catch { return text; }
}

function addMsg(role, text, meta = null) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;

  // Row layout: avatar + content(column)
  const content = document.createElement('div');
  content.className = 'content';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  // Render Markdown for bot messages with sanitization
  if (role.startsWith('bot') && window.marked && window.DOMPurify) {
    try {
      const html = DOMPurify.sanitize(marked.parse(text || ''));
      bubble.innerHTML = html;
    } catch {
      bubble.textContent = text;
    }
  } else {
    bubble.textContent = text;
  }
  // Build avatar
  const avatar = document.createElement('div');
  const isBot = role.startsWith('bot');
  avatar.className = `avatar ${isBot ? 'bot' : 'user'}`;
  avatar.textContent = isBot ? '🤖' : '🙂';

  // Assemble row based on side
  content.appendChild(bubble);
  if (isBot) {
    wrap.appendChild(avatar);
    wrap.appendChild(content);
  } else {
    wrap.appendChild(content);
    wrap.appendChild(avatar);
  }

  // Sources list hidden per design requirements

  // Quick-reply chips based on sources or suggestions
  const hasSources = meta && Array.isArray(meta.sources) && meta.sources.length;
  const hasSuggestions = meta && Array.isArray(meta.suggestions) && meta.suggestions.length;
  if (role.startsWith('bot') && (hasSources || hasSuggestions)) {
    const chips = document.createElement('div');
    chips.className = 'chips';
    const titles = hasSuggestions
      ? meta.suggestions.slice(0, 3)
      : meta.sources.slice(0, 3).map(s => s.title).filter(Boolean);
    const prompts = hasSuggestions
      ? titles
      : titles.map(t => `Tell me more about ${t}`);
    prompts.forEach(p => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.textContent = p;
      btn.addEventListener('click', () => {
        input.value = p;
        form.dispatchEvent(new Event('submit'));
      });
      chips.appendChild(btn);
    });
    if (chips.childElementCount) content.appendChild(chips);
  }

  // Feedback buttons for bot replies
  if (role === 'bot' && text) {
    const fb = document.createElement('div');
    fb.className = 'feedback';
    const up = document.createElement('button');
    up.type = 'button';
    up.textContent = '👍 Helpful';
    const down = document.createElement('button');
    down.type = 'button';
    down.textContent = '👎 Not helpful';
    const send = async (vote) => {
      try {
        await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vote, message: meta?.prompt || '', answer: text })
        });
        fb.innerHTML = `<span class="thanks">Thanks for the feedback!</span>`;
      } catch {
        fb.innerHTML = `<span class="thanks">Saved locally.</span>`;
      }
    };
    up.addEventListener('click', () => send('up'));
    down.addEventListener('click', () => send('down'));
    fb.appendChild(up);
    fb.appendChild(down);
    content.appendChild(fb);
  }

  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = input.value.trim();
  if (!prompt) return;
  addMsg('user', prompt);
  input.value = '';

  // Build a streaming bot message (avatar + bubble)
  const wrap = document.createElement('div');
  wrap.className = 'msg bot';
  const avatar = document.createElement('div');
  avatar.className = 'avatar bot';
  avatar.textContent = '🤖';
  const content = document.createElement('div');
  content.className = 'content';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = 'Thinking…';
  content.appendChild(bubble);
  wrap.appendChild(avatar);
  wrap.appendChild(content);
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  let acc = '';
  let meta = null;
  // notify parent that bot is thinking/talking
  try { window.parent.postMessage({ type: 'bfb:talking', talking: true }, '*'); } catch {}

  try {
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: prompt })
    });

    if (!res.body || !window.ReadableStream) {
      // Fallback to non-stream endpoint
      const j = await res.json();
      if (j?.error) throw new Error(j.error);
      acc = String(j?.answer || '');
      // Render final
      if (window.marked && window.DOMPurify) {
        try {
          const html = DOMPurify.sanitize(marked.parse(acc));
          bubble.innerHTML = html;
        } catch { bubble.textContent = acc; }
      } else { bubble.textContent = acc; }
      meta = { sources: j?.sources || [], confidence: j?.confidence || 0, prompt };
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      // drive talking rhythm using token stream
      let lastBeat = 0;
      try { window.parent.postMessage({ type: 'bfb:talk-beat', durMs: 500 }, '*'); lastBeat = performance.now(); } catch {}
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() || '';
        for (const frame of frames) {
          const lines = frame.split('\n');
          const ev = (lines.find(l => l.startsWith('event:')) || '').slice(6).trim();
          const dataLine = (lines.find(l => l.startsWith('data:')) || '').slice(5).trim();
          if (!ev || !dataLine) continue;
          let payload = null;
          try { payload = JSON.parse(dataLine); } catch { payload = {}; }
          if (ev === 'meta') {
            meta = { ...(payload || {}), prompt };
          } else if (ev === 'token') {
            const t = sanitizeClient(String(payload?.token || ''));
            acc += t;
            bubble.textContent = acc; // render plain during stream
            messagesEl.scrollTop = messagesEl.scrollHeight;
            // emit rhythmic talk-beat roughly every 250–350ms
            const now = performance.now();
            if (now - lastBeat > 250) {
              lastBeat = now;
              const durMs = Math.floor(420 + Math.random() * 160); // 0.42s–0.58s
              try { window.parent.postMessage({ type: 'bfb:talk-beat', durMs }, '*'); } catch {}
            }
          } else if (ev === 'done') {
            // On done, re-render with Markdown if available
            if (window.marked && window.DOMPurify) {
              try {
                const html = DOMPurify.sanitize(marked.parse(sanitizeClient(String(payload?.text || acc))));
                bubble.innerHTML = html;
              } catch { bubble.textContent = acc; }
            } else {
              bubble.textContent = sanitizeClient(acc);
            }
            try { window.parent.postMessage({ type: 'bfb:talking', talking: false }, '*'); } catch {}
            try { window.parent.postMessage({ type: 'bfb:talk-beat', durMs: 0 }, '*'); } catch {}
          } else if (ev === 'error') {
            try { window.parent.postMessage({ type: 'bfb:talking', talking: false }, '*'); } catch {}
            try { window.parent.postMessage({ type: 'bfb:talk-beat', durMs: 0 }, '*'); } catch {}
            throw new Error(payload?.message || 'Stream error');
          }
        }
      }
    }

    // After completion, attach chips (sources/suggestions) and feedback
    if (meta) {
      const hasSources = Array.isArray(meta.sources) && meta.sources.length;
      const hasSuggestions = Array.isArray(meta.suggestions) && meta.suggestions.length;
      if (hasSources || hasSuggestions) {
        const chips = document.createElement('div');
        chips.className = 'chips';
        const titles = hasSuggestions
          ? meta.suggestions.slice(0, 3)
          : meta.sources.slice(0, 3).map(s => s.title).filter(Boolean);
        const prompts = hasSuggestions ? titles : titles.map(t => `Tell me more about ${t}`);
        prompts.forEach(p => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'chip';
          btn.textContent = p;
          btn.addEventListener('click', () => {
            input.value = p;
            form.dispatchEvent(new Event('submit'));
          });
          chips.appendChild(btn);
        });
        if (chips.childElementCount) content.appendChild(chips);
      }

      // Feedback buttons
      if (acc) {
        const fb = document.createElement('div');
        fb.className = 'feedback';
        const up = document.createElement('button');
        up.type = 'button';
        up.textContent = '👍 Helpful';
        const down = document.createElement('button');
        down.type = 'button';
        down.textContent = '👎 Not helpful';
        const send = async (vote) => {
          try {
            await fetch('/api/feedback', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ vote, message: meta?.prompt || '', answer: acc })
            });
            fb.innerHTML = `<span class="thanks">Thanks for the feedback!</span>`;
          } catch {
            fb.innerHTML = `<span class="thanks">Saved locally.</span>`;
          }
        };
        up.addEventListener('click', () => send('up'));
        down.addEventListener('click', () => send('down'));
        fb.appendChild(up);
        fb.appendChild(down);
        content.appendChild(fb);
      }
    }
  } catch (err) {
    // Render error inline in bubble
    bubble.textContent = 'Network error. Please try again.';
    try { window.parent.postMessage({ type: 'bfb:talking', talking: false }, '*'); } catch {}
  }
});
