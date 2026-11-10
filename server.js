const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'static')));

// 모델별 독립 쿼터 설정 및 상태 (5시간 윈도우 슬라이딩)
const MODEL_QUOTAS = {
  'claude-3-opus': {
    name: 'Claude 3 Opus',
    max5h: 15,
    used5h: 15,
    maxWeekly: 100,
    usedWeekly: 98,
    type: 'antigravity',
    resetHours: 2.25
  },
  'claude-3-7-sonnet': {
    name: 'Claude 3.7 Sonnet',
    max5h: 45,
    used5h: 18,
    maxWeekly: 300,
    usedWeekly: 156,
    type: 'antigravity',
    resetHours: 3.5
  },
  'gemini-3-8-flash': {
    name: 'Gemini 3.8 Flash',
    max5h: 150,
    used5h: 22,
    maxWeekly: 1500,
    usedWeekly: 330,
    type: 'google',
    resetHours: 4.1
  },
  'gemini-4-argon': {
    name: 'Gemini 4 Argon',
    max5h: 50,
    used5h: 50,
    maxWeekly: 400,
    usedWeekly: 376,
    type: 'google',
    resetHours: 1.67
  },
  'nvidia-llama-405b': {
    name: 'OSS Llama 3.1 405B',
    max5h: 1000, // NVIDIA Build API Credits
    used5h: 68,
    unit: 'Credits',
    rpmLimit: 40,
    type: 'nvidia',
    resetHours: 24
  },
  'nvidia-nemotron-120b': {
    name: 'OSS Nemotron 120B',
    max5h: 1000,
    used5h: 42,
    unit: 'Credits',
    rpmLimit: 40,
    type: 'nvidia',
    resetHours: 24
  }
};

// 메시지 저장소
let messages = [];

// 모델별 실시간 쿼터 조회 API
app.get('/api/quota', (req, res) => {
  const model = req.query.model || 'claude-3-7-sonnet';
  const q = MODEL_QUOTAS[model] || MODEL_QUOTAS['claude-3-7-sonnet'];
  
  res.json({
    model,
    name: q.name,
    type: q.type,
    unit: q.unit || '회',
    max5h: q.max5h,
    used5h: q.used5h,
    remaining5h: Math.max(0, q.max5h - q.used5h),
    percent5h: Math.round(((q.max5h - q.used5h) / q.max5h) * 100),
    maxWeekly: q.maxWeekly || null,
    remainingWeekly: q.maxWeekly ? (q.maxWeekly - q.usedWeekly) : null,
    resetInHours: q.resetHours,
    allQuotas: MODEL_QUOTAS
  });
});

// 댓글 피드 목록 조회
app.get('/api/messages', (req, res) => {
  res.json({ messages });
});

// Non-streaming 댓글 질문 및 답변 처리
app.post('/api/ask', async (req, res) => {
  const { text, model = 'claude-3-7-sonnet', isVmCommand = false } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: '질문 내용을 입력해주세요.' });
  }

  // 해당 모델 쿼터 차감
  if (MODEL_QUOTAS[model]) {
    MODEL_QUOTAS[model].used5h = Math.min(MODEL_QUOTAS[model].max5h, MODEL_QUOTAS[model].used5h + 1);
    if (MODEL_QUOTAS[model].usedWeekly) {
      MODEL_QUOTAS[model].usedWeekly += 1;
    }
  }

  const msgId = 'msg_' + Date.now();
  const userMsg = {
    id: msgId,
    model,
    modelName: (MODEL_QUOTAS[model] && MODEL_QUOTAS[model].name) || model,
    question: text,
    createdAt: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    isVmCommand: Boolean(isVmCommand),
    answer: null
  };

  // VM 터미널 명령 처리인 경우
  if (isVmCommand || text.startsWith('!') || text.startsWith('/sh ')) {
    const cmd = text.replace(/^(!|\/sh\s+)/, '');
    userMsg.answer = `[VM Terminal Result (hostname: ace, /home/antigravity)]\n$ ${cmd}\n(명령 실행 완료: 정상 종료 status 0)`;
  } else {
    // 일반 모델 Non-streaming 답변 완성 시뮬레이션
    userMsg.answer = `[${userMsg.modelName}] 답변이 완성되었습니다.\n\n요청하신 \"${text}\"에 대해 분석을 완료했습니다. 백엔드에서 답변 생성 후 스트리밍 없이 단일 댓글 블록으로 렌더링되었습니다.`;
  }

  messages.unshift(userMsg);
  const currentQ = MODEL_QUOTAS[model];

  res.json({
    success: true,
    message: userMsg,
    quota: {
      remaining5h: Math.max(0, currentQ.max5h - currentQ.used5h),
      max5h: currentQ.max5h,
      percent5h: Math.round(((currentQ.max5h - currentQ.used5h) / currentQ.max5h) * 100),
      resetInHours: currentQ.resetHours
    }
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
