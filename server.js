const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile, execFileSync } = require('child_process');

const PORT = process.env.PORT || 8000;
const STATIC_DIR = path.join(__dirname, 'static');
const WORKSPACE_DIR = path.resolve(__dirname, '..');

function resolveAgyBinary() {
  if (process.env.AGY_BIN) return process.env.AGY_BIN;
  if (process.platform === 'win32') {
    const winPath = path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe');
    if (fs.existsSync(winPath)) return winPath;
  }
  return 'agy';
}

const AGY_BIN = resolveAgyBinary();
console.log(`[Config] Using agy binary: ${AGY_BIN}`);
console.log(`[Config] Working directory: ${WORKSPACE_DIR}`);

let currentConversationId = null;
let cachedModels = null;

function checkAgyAvailable() {
  try {
    execFileSync(AGY_BIN, ['--help'], { stdio: 'ignore', timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

function fetchModels() {
  if (cachedModels) return Promise.resolve(cachedModels);
  return new Promise((resolve) => {
    execFile(AGY_BIN, ['models'], { timeout: 8000 }, (err, stdout) => {
      if (err || !stdout) {
        return resolve([
          { id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
          { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
          { id: 'claude-sonnet-5-5-high', name: 'Claude Sonnet 5.5 (High)' },
        ]);
      }
      const lines = stdout.split(/\r?\n/);
      const list = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('Fetching')) continue;
        const parts = trimmed.split(/\t+/);
        if (parts.length >= 2) {
          list.push({ id: parts[0].trim(), name: parts[1].trim() });
        } else if (parts.length === 1 && !parts[0].includes(' ')) {
          list.push({ id: parts[0].trim(), name: parts[0].trim() });
        }
      }
      cachedModels = list.length > 0 ? list : [
        { id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
        { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' }
      ];
      resolve(cachedModels);
    });
  });
}

function getConversationHistory() {
  const historyPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'history.jsonl');
  if (!fs.existsSync(historyPath)) return [];
  try {
    const raw = fs.readFileSync(historyPath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const seen = new Map();

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const item = JSON.parse(lines[i]);
        if (item.conversationId && !seen.has(item.conversationId)) {
          seen.set(item.conversationId, {
            conversationId: item.conversationId,
            title: item.display ? item.display.slice(0, 80).replace(/\n/g, ' ') : '(대화 내용 없음)',
            timestamp: item.timestamp || Date.now(),
          });
        }
      } catch {}
      if (seen.size >= 30) break;
    }
    return Array.from(seen.values());
  } catch (err) {
    console.error('Failed to read history.jsonl:', err);
    return [];
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const htmlPath = path.join(STATIC_DIR, 'index.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(htmlPath).pipe(res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    const ok = checkAgyAvailable();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        sdk_available: ok,
        agent_active: Boolean(currentConversationId),
        conversation_id: currentConversationId,
        cwd: WORKSPACE_DIR,
      })
    );
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/models') {
    const models = await fetchModels();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ models }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/conversations') {
    const history = getConversationHistory();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ conversations: history, currentId: currentConversationId }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/reset') {
    currentConversationId = null;
    console.log('[Session] Reset conversation session');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, message: '새로운 대화 세션이 시작되었습니다.' }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/resume') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      try {
        const { conversationId } = JSON.parse(body || '{}');
        if (!conversationId) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '대화 ID가 제공되지 않았습니다.' }));
          return;
        }
        currentConversationId = conversationId;
        console.log(`[Session] Resumed conversation: ${conversationId}`);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, conversationId, message: `대화 세션(${conversationId.slice(0, 8)}...)을 불러왔습니다.` }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '잘못된 JSON 형식입니다.' }));
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      let message = '';
      let selectedModel = '';
      let selectedMode = '';
      let reqConversationId = '';

      try {
        const parsed = JSON.parse(body || '{}');
        message = (parsed.message || '').trim();
        selectedModel = (parsed.model || '').trim();
        selectedMode = (parsed.mode || '').trim();
        reqConversationId = (parsed.conversationId || '').trim();
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '잘못된 요청 형식입니다.' }));
        return;
      }

      if (!message) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '메시지를 입력해 주세요.' }));
        return;
      }

      if (reqConversationId) {
        currentConversationId = reqConversationId;
      }

      console.log(`[Chat] Prompt: "${message}" | Model: ${selectedModel || 'default'} | Mode: ${selectedMode || 'default'} | Conv: ${currentConversationId || 'new'}`);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const sendEvent = (obj) => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify(obj)}\n\n`);
        }
      };

      const args = ['-p', message, '--output-format', 'stream-json'];

      if (selectedModel) {
        args.push('--model', selectedModel);
      }
      if (selectedMode) {
        args.push('--mode', selectedMode);
      }
      if (currentConversationId) {
        args.push('--conversation', currentConversationId);
      }

      const child = spawn(AGY_BIN, args, {
        cwd: WORKSPACE_DIR,
        env: process.env,
        windowsHide: true,
      });

      let stdoutBuffer = '';
      let stderrText = '';
      let receivedTokens = false;

      child.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString('utf8');
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const evt = JSON.parse(trimmed);
            if (evt.event === 'init' && evt.conversation_id) {
              currentConversationId = evt.conversation_id;
              sendEvent({ type: 'session_init', conversationId: currentConversationId });
            } else if (evt.event === 'step_update' && evt.step_update) {
              const su = evt.step_update;
              if (su.conversation_id) {
                currentConversationId = su.conversation_id;
              }
              if (su.thinking_delta) {
                sendEvent({ type: 'thought', content: su.thinking_delta });
              }
              if (su.text_delta) {
                receivedTokens = true;
                sendEvent({ type: 'token', content: su.text_delta });
              }
              if (
                su.step_type &&
                su.step_type !== 'user_input' &&
                su.step_type !== 'agent_response' &&
                su.step_type !== 'system_message' &&
                su.state === 'ACTIVE'
              ) {
                sendEvent({ type: 'tool_call', name: su.step_type });
              }
            } else if (evt.event === 'result' && evt.result) {
              if (evt.result.conversation_id) {
                currentConversationId = evt.result.conversation_id;
              }
              if (!receivedTokens && evt.result.response) {
                sendEvent({ type: 'token', content: evt.result.response });
              }
              if (evt.result.status && evt.result.status !== 'SUCCESS' && evt.result.error) {
                sendEvent({ type: 'error', content: evt.result.error });
              }
            }
          } catch {
            // Ignore non-JSON lines
          }
        }
      });

      child.stderr.on('data', (chunk) => {
        stderrText += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        console.error(`[Error] agy process error:`, err);
        sendEvent({ type: 'error', content: `agy 실행 오류: ${err.message}` });
        res.end();
      });

      child.on('close', (code) => {
        console.log(`[Chat] agy process closed with code ${code}`);
        if (code !== 0 && stderrText.trim()) {
          console.error(`[Error] stderr: ${stderrText}`);
          sendEvent({ type: 'error', content: stderrText.trim() });
        }
        sendEvent({ type: 'done', conversationId: currentConversationId });
        res.end();
      });

      res.on('close', () => {
        if (!res.writableEnded && child.exitCode === null && !child.killed) {
          console.log('[Chat] Client aborted connection, terminating child');
          child.kill();
        }
      });
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`🚀 Antigravity (agy) Web Server running at http://127.0.0.1:${PORT}`);
});
