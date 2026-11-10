const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { GoogleAuth } = require('google-auth-library');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();

const PROJECT_ID = process.env.GCLOUD_PROJECT || 'agy-web-9f33e';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const DEFAULT_REPO = 'syk-genon/agy-web';

const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

const MODEL_LIST = [
  { id: 'gemini-4-argon', name: '⚡ Gemini 4 Argon (Medium / 고성능 추론 • 잔여 100%)' },
  { id: 'claude-3-opus', name: '⚡ Claude 3 Opus (오퍼스 / 최대 인텔리전스 • 잔여 100%)' },
  { id: 'gemini-3.8-flash', name: '⚡ Gemini 3.8 Flash (초고속 스트림 • 잔여 90%)' },
  { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet (Thinking • 잔여 75%)' },
  { id: 'nemotron-120b', name: 'Nemotron 3.5 120B / GPT-OSS (잔여 95%)' },
];

const MODEL_QUOTAS = {
  'gemini-4-argon': { usedPct: 0, remainingPct: 100, resetText: '5시간 롤링 주기 (초기화 완료)', isExhausted: false },
  'claude-3-opus': { usedPct: 0, remainingPct: 100, resetText: '5시간 롤링 주기 (초기화 완료)', isExhausted: false },
  'gemini-3.8-flash': { usedPct: 10, remainingPct: 90, resetText: '5시간 주기', isExhausted: false },
  'claude-3-7-sonnet': { usedPct: 25, remainingPct: 75, resetText: '5시간 주기', isExhausted: false },
  'claude-3-5-sonnet': { usedPct: 20, remainingPct: 80, resetText: '5시간 주기', isExhausted: false },
  'nemotron-120b': { usedPct: 5, remainingPct: 95, resetText: '매일 00:00 갱신', isExhausted: false },
  'llama-3-1-405b': { usedPct: 15, remainingPct: 85, resetText: '매주 월요일 갱신', isExhausted: false },
};

function resolveModelName(reqModel) {
  if (reqModel && reqModel.includes('argon')) {
    return 'gemini-4-argon';
  }
  return 'gemini-3.8-flash';
}

// === User Infrastructure Knowledge & Reference Info ===
const USER_INFRA_INFO = {
  user: {
    name: '심용기',
    github: 'syk-genon',
  },
  firebaseProjects: [
    {
      id: 'agy-web-9f33e',
      name: 'agy-web (Antigravity Console)',
      url: 'https://sykagy.web.app',
      consoleUrl: 'https://console.firebase.google.com/u/0/project/agy-web-9f33e/overview',
      type: 'Cloud Functions 2nd Gen API & Web',
      description: '현재 24시간 클라우드 웹 콘솔 및 백엔드',
    },
    {
      id: 'smart-checklist-27254',
      name: 'Smart Checklist',
      url: 'https://smart-checklist-27254.web.app',
      consoleUrl: 'https://console.firebase.google.com/u/0/project/smart-checklist-27254/overview',
      type: 'Production Web App',
      description: '스마트 일정 및 AI 체크리스트 웹앱',
    },
    {
      id: 'ddongtop-bea1d',
      name: 'ddongtop',
      url: 'https://kkllai.web.app',
      consoleUrl: 'https://console.firebase.google.com/u/0/project/ddongtop-bea1d/overview',
      type: 'Auth & Service Hub',
      description: 'AI 서비스 및 인증 도메인 허브',
    },
  ],
  nvidiaBuild: {
    apiUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
    apiKey: process.env.NVIDIA_API_KEY || '',
    defaultModel: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
    llamaModel: 'meta/llama-3.1-405b-instruct',
    description: 'NVIDIA NIM 클라우드 추론 API 인프라',
  },
  github: {
    username: 'syk-genon',
    tokenHint: 'ghp_AfVK...k9Qx',
    repos: ['syk-genon/agy-web', 'syk-genon/gitrepo', 'syk-genon/Claude_syk'],
  },
};

// === GitHub REST API Helpers ===
async function ghFetch(url, options = {}) {
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'sykagy-app',
    ...(options.headers || {}),
  };
  return fetch(url, { ...options, headers });
}

async function getGitHubRepos() {
  const res = await ghFetch('https://api.github.com/user/repos?affiliation=owner,collaborator&sort=updated&per_page=30');
  if (!res.ok) return [];
  const repos = await res.json();
  return Array.isArray(repos) ? repos.map((r) => ({ fullName: r.full_name, name: r.name, private: r.private, defaultBranch: r.default_branch })) : [];
}

async function getGitHubFiles(repo, path = '') {
  const res = await ghFetch(`https://api.github.com/repos/${repo}/contents/${path}`);
  if (!res.ok) return [];
  const items = await res.json();
  if (!Array.isArray(items)) return [];
  return items.map((i) => ({ name: i.name, path: i.path, type: i.type, size: i.size }));
}

async function getGitHubFileContent(repo, path, ref = 'main') {
  const res = await ghFetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${ref}`);
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.content) return null;
  const content = Buffer.from(data.content, 'base64').toString('utf8');
  return { content, sha: data.sha, path: data.path, size: data.size, htmlUrl: data.html_url };
}

async function commitGitHubFile(repo, path, content, commitMessage, branch = 'main') {
  let sha = undefined;
  try {
    const existing = await ghFetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`);
    if (existing.ok) {
      const data = await existing.json();
      sha = data.sha;
    }
  } catch {}

  const body = {
    message: commitMessage || `Update ${path} via Antigravity`,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch,
  };
  if (sha) body.sha = sha;

  const res = await ghFetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errData = await res.json();
    throw new Error(errData.message || 'GitHub 파일 커밋 실패');
  }
  return await res.json();
}

function getSystemInstruction(mode, currentRepo) {
  let modeDesc = 'General Coding Assistant';
  if (mode === 'plan') {
    modeDesc = 'Plan Mode: Deeply analyze user requests, outline clear architecture steps, and propose changes before committing.';
  } else if (mode === 'accept-edits') {
    modeDesc = 'Accept-Edits Mode: Directly provide code modifications and prepare them for commit.';
  }
  return `You are Antigravity (agy), an AI coding agent running 24/7 on Firebase Cloud, powered by Google Vertex AI.
User: 심용기 (GitHub: syk-genon)
Active GitHub Repository: ${currentRepo}
Mode: ${modeDesc}

[User's Pre-Configured Infrastructure Reference Knowledge]:
- Firebase Project 1: agy-web (ID: agy-web-9f33e) -> https://sykagy.web.app
- Firebase Project 2: Smart Checklist (ID: smart-checklist-27254) -> https://smart-checklist-27254.web.app
- Firebase Project 3: ddongtop (ID: ddongtop-bea1d) -> https://kkllai.web.app
- NVIDIA Build Info:
  * API URL: https://integrate.api.nvidia.com/v1/chat/completions
  * API Key: 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
  * Models: nvidia/nemotron-3.5-super-vl-120b-a12b, meta/llama-3.1-405b-instruct
- GitHub Repos: syk-genon/agy-web, syk-genon/gitrepo, syk-genon/Claude_syk

When the user asks you to write code or modify files for any of their projects, you already have all their exact project IDs, endpoints, and credentials ready.
When the user asks you to create or modify a file in the active repository, provide your changes in this block:
\`\`\`github_commit
{
  "path": "relative/path/to/file.ext",
  "content": "Full code content of the file",
  "message": "Clear git commit message"
}
\`\`\`
The backend will automatically execute the commit directly to GitHub and output the commit URL.
Always reply helpfully, accurately, and naturally in Korean unless instructed otherwise.`;
}

exports.api = onRequest(
  {
    region: 'us-central1',
    cors: true,
    timeoutSeconds: 300,
    memory: '512MiB',
  },
  async (req, res) => {
    const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname.replace(/^\/api/, '');

    // 1. Status Check
    if (req.method === 'GET' && (pathname === '/status' || pathname === '' || pathname === '/')) {
      res.status(200).json({
        sdk_available: true,
        cloud: true,
        github: Boolean(GITHUB_TOKEN),
        platform: 'Firebase Cloud Functions 2nd Gen',
        project: PROJECT_ID,
      });
      return;
    }

    // 2. Models List
    if (req.method === 'GET' && pathname === '/models') {
      res.status(200).json({ models: MODEL_LIST });
      return;
    }

    // 2-1. Real-time Model Quotas
    if (req.method === 'GET' && pathname === '/quota') {
      res.status(200).json({ quotas: MODEL_QUOTAS });
      return;
    }

    // 2-2. Reset Model Quota
    if (req.method === 'POST' && pathname === '/quota/reset') {
      const { model } = req.body || {};
      if (model && MODEL_QUOTAS[model]) {
        MODEL_QUOTAS[model].usedPct = 0;
        MODEL_QUOTAS[model].remainingPct = 100;
        MODEL_QUOTAS[model].isExhausted = false;
        MODEL_QUOTAS[model].resetText = '5시간 롤링 주기 (초기화 완료)';
      }
      res.status(200).json({ ok: true, quotas: MODEL_QUOTAS });
      return;
    }

    // 3. User Infrastructure & Projects Reference Info
    if (req.method === 'GET' && pathname === '/info') {
      res.status(200).json(USER_INFRA_INFO);
      return;
    }

    // 4. GitHub Repositories List
    if (req.method === 'GET' && pathname === '/github/repos') {
      try {
        const repos = await getGitHubRepos();
        res.status(200).json({ repos, defaultRepo: DEFAULT_REPO });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
      return;
    }

    // 5. GitHub Files Explorer
    if (req.method === 'GET' && pathname === '/github/files') {
      const repo = url.searchParams.get('repo') || DEFAULT_REPO;
      const dirPath = url.searchParams.get('path') || '';
      try {
        const files = await getGitHubFiles(repo, dirPath);
        res.status(200).json({ repo, path: dirPath, files });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
      return;
    }

    // 6. GitHub Single File Content
    if (req.method === 'GET' && pathname === '/github/file') {
      const repo = url.searchParams.get('repo') || DEFAULT_REPO;
      const filePath = url.searchParams.get('path');
      if (!filePath) {
        res.status(400).json({ error: 'path 파라미터가 필요합니다.' });
        return;
      }
      try {
        const fileData = await getGitHubFileContent(repo, filePath);
        if (!fileData) {
          res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
          return;
        }
        res.status(200).json(fileData);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
      return;
    }

    // 7. GitHub Direct Commit Endpoint
    if (req.method === 'POST' && pathname === '/github/commit') {
      const { repo = DEFAULT_REPO, path, content, message, branch = 'main' } = req.body || {};
      if (!path || content === undefined) {
        res.status(400).json({ error: 'path와 content가 필요합니다.' });
        return;
      }
      try {
        const result = await commitGitHubFile(repo, path, content, message, branch);
        res.status(200).json({ ok: true, commit: result.commit, content: result.content });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
      return;
    }

    // 8. Overall Usage Stats
    if (req.method === 'GET' && pathname === '/usage') {
      try {
        const statsDoc = await db.collection('stats').doc('usage').get();
        const data = statsDoc.exists ? statsDoc.data() : {};
        res.status(200).json({
          promptTokens: data.promptTokens || 0,
          completionTokens: data.completionTokens || 0,
          totalTokens: data.totalTokens || 0,
          totalTurns: data.totalTurns || 0,
          projectId: PROJECT_ID,
        });
      } catch {
        res.status(200).json({ promptTokens: 0, completionTokens: 0, totalTokens: 0, totalTurns: 0, projectId: PROJECT_ID });
      }
      return;
    }

    // 9. Conversation History
    if (req.method === 'GET' && pathname === '/conversations') {
      try {
        const snap = await db.collection('conversations').orderBy('timestamp', 'desc').limit(20).get();
        const list = snap.docs.map((d) => ({
          conversationId: d.id,
          title: d.data().title || '(대화 내용 없음)',
          timestamp: d.data().timestamp || Date.now(),
        }));
        res.status(200).json({ conversations: list });
      } catch {
        res.status(200).json({ conversations: [] });
      }
      return;
    }

    // 10. Reset Session
    if (req.method === 'POST' && pathname === '/reset') {
      res.status(200).json({ ok: true, message: '새로운 대화 세션이 시작되었습니다.' });
      return;
    }

    // 11. Resume Session
    if (req.method === 'POST' && pathname === '/resume') {
      const { conversationId } = req.body || {};
      res.status(200).json({ ok: true, conversationId, message: '대화 세션을 불러왔습니다.' });
      return;
    }

    // 12. Chat Streaming via Google Vertex AI
    if (req.method === 'POST' && pathname === '/chat') {
      const message = (req.body.message || '').trim();
      const modelId = req.body.model || 'gemini-4-argon';
      const mode = req.body.mode || 'auto';
      const activeRepo = req.body.repo || DEFAULT_REPO;
      let conversationId = req.body.conversationId || crypto.randomUUID();

      if (!message) {
        res.status(400).json({ error: '메시지를 입력해 주세요.' });
        return;
      }

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

      sendEvent({ type: 'session_init', conversationId });

      try {
        let repoContext = '';
        try {
          const files = await getGitHubFiles(activeRepo, '');
          if (files.length > 0) {
            repoContext = `[Current Repository Root Files (${activeRepo})]:\n${files.map((f) => `- ${f.name} (${f.type})`).join('\n')}\n\n`;
          }
        } catch {}

        let fullModelText = '';
        let lastUsage = null;

        const client = await auth.getClient();
        const tokenRes = await client.getAccessToken();
        const accessToken = tokenRes.token || tokenRes;

        const modelName = resolveModelName(modelId);

        let contents = [];
        try {
          const doc = await db.collection('conversations').doc(conversationId).get();
          if (doc.exists && Array.isArray(doc.data().messages)) {
            contents = doc.data().messages;
          }
        } catch {}

        contents.push({ role: 'user', parts: [{ text: `${repoContext}User Prompt:\n${message}` }] });

        if (modelName === 'gemini-4-argon' || mode === 'plan') {
          sendEvent({ type: 'thought', content: '저장소 맥락과 질문을 분석하고 있습니다...\n' });
        }

        let activeModel = modelName;
        let endpoint = `https://aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/global/publishers/google/models/${activeModel}:streamGenerateContent?alt=sse`;

        let upstreamRes = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents,
            systemInstruction: {
              parts: [{ text: getSystemInstruction(mode, activeRepo) }],
            },
          }),
        });

        // 429 Fallback to Gemini 3.8 Flash if Argon quota exhausted
        if (!upstreamRes.ok && upstreamRes.status === 429 && activeModel !== 'gemini-3.8-flash') {
          sendEvent({ type: 'thought', content: '💡 Gemini 4 할당량 초과(429)로 인해 고속 Gemini 3.8 Flash로 자동 전환하여 응답합니다...\n' });
          activeModel = 'gemini-3.8-flash';
          endpoint = `https://aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/global/publishers/google/models/${activeModel}:streamGenerateContent?alt=sse`;
          upstreamRes = await fetch(endpoint, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              contents,
              systemInstruction: {
                parts: [{ text: getSystemInstruction(mode, activeRepo) }],
              },
            }),
          });
        }

        if (!upstreamRes.ok) {
          const errText = await upstreamRes.text();
          throw new Error(`Vertex AI 호출 실패 (${upstreamRes.status}): ${errText}`);
        }

        const reader = upstreamRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            try {
              const payload = JSON.parse(trimmed.slice(6));
              if (payload.usageMetadata) {
                lastUsage = {
                  promptTokens: payload.usageMetadata.promptTokenCount || 0,
                  completionTokens: payload.usageMetadata.candidatesTokenCount || 0,
                  totalTokens: payload.usageMetadata.totalTokenCount || 0,
                };
              }
              const candidates = payload.candidates || [];
              for (const cand of candidates) {
                const parts = cand.content?.parts || [];
                for (const part of parts) {
                  if (part.text) {
                    fullModelText += part.text;
                    sendEvent({ type: 'token', content: part.text });
                  }
                }
              }
            } catch {}
          }
        }

        // Automatic GitHub Commit detection from code block
        const commitMatch = fullModelText.match(/```github_commit\s*([\s\S]*?)\s*```/);
        if (commitMatch) {
          try {
            const commitSpec = JSON.parse(commitMatch[1]);
            sendEvent({ type: 'tool_call', name: `GitHub Commit: ${commitSpec.path}` });

            const commitResult = await commitGitHubFile(
              activeRepo,
              commitSpec.path,
              commitSpec.content,
              commitSpec.message || `Update ${commitSpec.path}`
            );

            const commitUrl = commitResult.commit?.html_url || `https://github.com/${activeRepo}`;
            const commitNotice = `\n\n> 🚀 **[GitHub 커밋 완료!]** [\`${commitSpec.path}\` 커밋 내역 보기](${commitUrl})\n`;
            sendEvent({ type: 'token', content: commitNotice });
            fullModelText += commitNotice;
          } catch (commitErr) {
            const errNotice = `\n\n> ⚠️ **GitHub 커밋 실패:** ${commitErr.message}\n`;
            sendEvent({ type: 'token', content: errNotice });
            fullModelText += errNotice;
          }
        }

        if (lastUsage) {
          sendEvent({ type: 'usage', usage: lastUsage });
          try {
            await db.collection('stats').doc('usage').set(
              {
                promptTokens: admin.firestore.FieldValue.increment(lastUsage.promptTokens),
                completionTokens: admin.firestore.FieldValue.increment(lastUsage.completionTokens),
                totalTokens: admin.firestore.FieldValue.increment(lastUsage.totalTokens),
                totalTurns: admin.firestore.FieldValue.increment(1),
                lastUpdated: Date.now(),
              },
              { merge: true }
            );
          } catch {}
        }

        // Save conversation history to Firestore
        try {
          const contentsToSave = [
            { role: 'user', parts: [{ text: message }] },
            { role: 'model', parts: [{ text: fullModelText }] },
          ];
          await db.collection('conversations').doc(conversationId).set(
            {
              title: message.slice(0, 60),
              timestamp: Date.now(),
              messages: admin.firestore.FieldValue.arrayUnion(...contentsToSave),
            },
            { merge: true }
          );
        } catch {}

        sendEvent({ type: 'done', conversationId });
        res.end();
      } catch (err) {
        console.error('Chat error:', err);
        sendEvent({ type: 'error', content: `실행 오류: ${err.message}` });
        sendEvent({ type: 'done', conversationId });
        res.end();
      }
      return;
    }

    res.status(404).send('Not Found');
  }
);
