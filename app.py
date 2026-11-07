import asyncio
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

try:
    from google.antigravity import Agent, CapabilitiesConfig, LocalAgentConfig
    SDK_AVAILABLE = True
except ImportError:
    Agent = None
    CapabilitiesConfig = None
    LocalAgentConfig = None
    SDK_AVAILABLE = False

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"


class AgentSessionManager:
    """Manages a persistent Antigravity Agent instance for multi-turn web chat."""

    def __init__(self) -> None:
        self._agent: Optional["Agent"] = None
        self._lock = asyncio.Lock()
        self.system_instructions = (
            "You are Antigravity (agy), a helpful AI coding assistant accessed via Web UI. "
            "Respond clearly in Korean unless requested otherwise."
        )

    async def get_or_create_agent(self) -> "Agent":
        if not SDK_AVAILABLE:
            raise RuntimeError(
                "google-antigravity 패키지가 설치되어 있지 않습니다. "
                "터미널에서 'pip install google-antigravity'를 실행해 주세요."
            )
        if self._agent is None:
            config = LocalAgentConfig(
                system_instructions=self.system_instructions,
                capabilities=CapabilitiesConfig(),
            )
            agent = Agent(config)
            await agent.__aenter__()
            self._agent = agent
        return self._agent

    async def reset(self) -> None:
        async with self._lock:
            if self._agent is not None:
                try:
                    await self._agent.__aexit__(None, None, None)
                except Exception:
                    pass
                self._agent = None

    async def shutdown(self) -> None:
        await self.reset()


session_manager = AgentSessionManager()


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await session_manager.shutdown()


app = FastAPI(title="Antigravity (agy) Web UI", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


class ChatRequest(BaseModel):
    message: str


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/status")
async def status():
    return JSONResponse(
        {
            "sdk_available": SDK_AVAILABLE,
            "agent_active": session_manager._agent is not None,
            "cwd": os.getcwd(),
        }
    )


@app.post("/api/reset")
async def reset_session():
    await session_manager.reset()
    return JSONResponse({"ok": True, "message": "새로운 대화 세션이 시작되었습니다."})


@app.post("/api/chat")
async def chat_stream(req: ChatRequest, request: Request):
    user_message = req.message.strip()
    if not user_message:
        return JSONResponse({"error": "메시지를 입력해 주세요."}, status_code=400)

    async def event_generator():
        queue: asyncio.Queue[Optional[dict]] = asyncio.Queue()

        async def run_agent_turn():
            try:
                async with session_manager._lock:
                    agent = await session_manager.get_or_create_agent()
                    response = await agent.chat(user_message)

                    async def stream_thoughts():
                        if hasattr(response, "thoughts"):
                            async for thought in response.thoughts:
                                await queue.put({"type": "thought", "content": str(thought)})

                    async def stream_tools():
                        if hasattr(response, "tool_calls"):
                            async for call in response.tool_calls:
                                await queue.put(
                                    {
                                        "type": "tool_call",
                                        "name": getattr(call, "name", "tool"),
                                        "args": getattr(call, "args", {}),
                                    }
                                )

                    async def stream_tokens():
                        async for token in response:
                            await queue.put({"type": "token", "content": str(token)})

                    await asyncio.gather(
                        stream_thoughts(),
                        stream_tools(),
                        stream_tokens(),
                    )
                await queue.put({"type": "done"})
            except Exception as exc:
                await queue.put({"type": "error", "content": str(exc)})
            finally:
                await queue.put(None)

        task = asyncio.create_task(run_agent_turn())
        try:
            while True:
                if await request.is_disconnected():
                    task.cancel()
                    break
                item = await queue.get()
                if item is None:
                    break
                yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
