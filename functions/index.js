const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { GoogleAuth } = require('google-auth-library');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();

const PROJECT_ID = process.env.GCLOUD_PROJECT || 'agy-web-9f33e';
const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

const MODEL_LIST = [
  { id: 'gemini-4-argon', name: 'Gemini 4 Argon (Medium / 고성능 추론)' },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash (High / 초고속 응답)' },
];

function resolveModelName(reqModel) {
  if (reqModel && reqModel.includes('flash')) {
    return 'gemini-3.8-flash';
  }
  return 'gemini-4-argon';
}

function getSystemInstruction(mode) {
  let modeDesc = 'General Coding Assistant';
  if (mode === 'plan') {
    modeDesc = 'Plan Mode: First understand user intent deeply, break the task into clear steps, and outline the architecture before presenting code.';
  } else if (mode === 'accept-edits') {
    modeDesc = 'Accept-Edits Mode: Provide production-ready, clean code snippets and direct replacements immediately.';
  }
  return `You are Antigravity (agy), an AI coding assistant running 24/7 on Firebase Cloud.
Mode: ${modeDesc}
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

    // 3. Overall Usage Stats
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
        res.status(200).json({
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          totalTurns: 0,
          projectId: PROJECT_ID,
        });
      }
      return;
    }

    // 4. Conversation History
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

    // 5. Reset Session
    if (req.method === 'POST' && pathname === '/reset') {
      res.status(200).json({ ok: true, message: '새로운 대화 세션이 시작되었습니다.' });
      return;
    }

    // 6. Resume Session
    if (req.method === 'POST' && pathname === '/resume') {
      const { conversationId } = req.body || {};
      res.status(200).json({ ok: true, conversationId, message: '대화 세션을 불러왔습니다.' });
      return;
    }

    // 7. Chat Streaming
    if (req.method === 'POST' && pathname === '/chat') {
      const message = (req.body.message || '').trim();
      const modelId = req.body.model || 'gemini-4-argon';
      const mode = req.body.mode || 'auto';
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

        contents.push({ role: 'user', parts: [{ text: message }] });

        if (modelName === 'gemini-4-argon' || mode === 'plan') {
          sendEvent({ type: 'thought', content: '질문과 맥락을 깊이 분석하고 있습니다...\n' });
        }

        const endpoint = `https://aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/global/publishers/google/models/${modelName}:streamGenerateContent?alt=sse`;

        const upstreamRes = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents,
            systemInstruction: {
              parts: [{ text: getSystemInstruction(mode) }],
            },
          }),
        });

        if (!upstreamRes.ok) {
          const errText = await upstreamRes.text();
          throw new Error(`Vertex AI 호출 실패 (${upstreamRes.status}): ${errText}`);
        }

        let fullModelText = '';
        let lastUsage = null;
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

        if (lastUsage) {
          sendEvent({ type: 'usage', usage: lastUsage });
          // Update cumulative stats in Firestore asynchronously
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

        // Save turn into Firestore
        try {
          contents.push({ role: 'model', parts: [{ text: fullModelText }] });
          await db.collection('conversations').doc(conversationId).set(
            {
              title: message.slice(0, 60),
              timestamp: Date.now(),
              messages: contents.slice(-20),
            },
            { merge: true }
          );
        } catch {}

        sendEvent({ type: 'done', conversationId });
        res.end();
      } catch (err) {
        console.error('Chat error:', err);
        sendEvent({ type: 'error', content: `클라우드 실행 오류: ${err.message}` });
        sendEvent({ type: 'done', conversationId });
        res.end();
      }
      return;
    }

    res.status(404).send('Not Found');
  }
);
