#!/usr/bin/env python3
import json
import os
import pty
import re
import select
import sqlite3
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

API_BASE = "https://sykagy.web.app/api"
REPO = "syk-genon/agy-web"
QUEUE_PATH = ".bridge/queue.json"
SESSIONS_PATH = ".bridge/sessions.json"
STATUS_PATH = ".bridge/status.json"

HOME_DIR = "/home/syk4441"
AGY_BIN = "/home/syk4441/.local/bin/agy"
if not os.path.exists(AGY_BIN):
    AGY_BIN = "/usr/local/bin/agy"

STATE_DIR = Path(HOME_DIR) / ".bridge_state"
STATE_DIR.mkdir(parents=True, exist_ok=True)
LAST_REQ_FILE = STATE_DIR / "last_req_id.txt"
SESSION_MAP_FILE = STATE_DIR / "session_map.json"

ANSI_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\r")

# Global state for interactive OAuth PTY if agy CLI requires login
auth_pty_proc = None
auth_pty_fd = None
auth_oauth_url = None


def strip_ansi(text: str) -> str:
    return ANSI_RE.sub("", text)


def get_env():
    env = os.environ.copy()
    env["HOME"] = HOME_DIR
    env["USER"] = "syk4441"
    env["LOGNAME"] = "syk4441"
    env["PATH"] = f"{HOME_DIR}/.local/bin:/usr/local/bin:/usr/bin:/bin"
    env["XDG_RUNTIME_DIR"] = "/run/user/1000"
    env["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=/run/user/1000/bus"
    return env


def read_bridge_file(file_path: str):
    try:
        url = f"{API_BASE}/github/file?repo={urllib.parse.quote(REPO)}&path={urllib.parse.quote(file_path)}&_t={int(time.time()*1000)}"
        req = urllib.request.Request(url, headers={"User-Agent": "Firebase-VM-Bridge"})
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data and "content" in data:
                return json.loads(data["content"])
    except Exception:
        pass
    return None


def write_bridge_file(file_path: str, obj: dict, msg: str = None) -> bool:
    for _ in range(3):
        try:
            payload = {
                "repo": REPO,
                "path": file_path,
                "content": json.dumps(obj, indent=2, ensure_ascii=False),
                "message": msg or f"chore(firebase-vm): update {file_path}",
            }
            req = urllib.request.Request(
                f"{API_BASE}/github/commit",
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json", "User-Agent": "Firebase-VM-Bridge"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                if resp.status in (200, 201):
                    return True
        except Exception:
            time.sleep(0.5)
    return False


def load_session_map() -> dict:
    if SESSION_MAP_FILE.exists():
        try:
            return json.loads(SESSION_MAP_FILE.read_text("utf-8"))
        except Exception:
            pass
    return {}


def save_session_map(smap: dict):
    try:
        SESSION_MAP_FILE.write_text(json.dumps(smap, indent=2), "utf-8")
    except Exception:
        pass


def get_firebase_vm_sessions():
    """Read local agy conversations from Firebase-VM SQLite DB."""
    db_path = Path(HOME_DIR) / ".gemini" / "antigravity-cli" / "conversation_summaries.db"
    found = []
    if db_path.exists():
        try:
            con = sqlite3.connect(str(db_path))
            cur = con.cursor()
            rows = cur.execute(
                "SELECT conversation_id, title, preview, last_modified_time FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 15"
            ).fetchall()
            for cid, title, preview, lmt in rows:
                found.append(
                    {
                        "conversationId": cid,
                        "title": f"🔥 [Firebase-VM] {title or preview or cid[:8]}",
                        "preview": preview or "",
                        "timestamp": int(time.time() * 1000),
                    }
                )
            con.close()
        except Exception:
            pass
    return found


def sync_vm_sessions_to_cloud():
    store = read_bridge_file(SESSIONS_PATH)
    if not store or "sessionsData" not in store:
        store = {"sessionsList": [], "sessionsData": {}}

    vm_sessions = get_firebase_vm_sessions()
    existing_ids = {s.get("conversationId") for s in store.get("sessionsList", [])}

    changed = False
    for vs in vm_sessions:
        cid = vs["conversationId"]
        if cid not in existing_ids:
            store["sessionsList"].insert(
                0,
                {
                    "conversationId": cid,
                    "title": vs["title"][:36],
                    "timestamp": vs["timestamp"],
                },
            )
            existing_ids.add(cid)
            changed = True
        if cid not in store["sessionsData"] or not store["sessionsData"][cid]:
            store["sessionsData"][cid] = [
                {
                    "id": f"vm_{cid[:8]}",
                    "author": "User",
                    "content": vs.get("preview") or "Firebase-VM (agy-server) 세션 기록",
                    "feedback": f"이 세션(`{cid}`)은 **Firebase-VM (`agy-server`)** 내부의 `agy` CLI에 저장된 세션입니다. 이어서 질문을 입력하시면 `Firebase-VM`의 `agy`에서 바로 실행됩니다.",
                    "model": "gemini-4-argon",
                    "timestamp": vs["timestamp"],
                    "conversationId": cid,
                    "viaFirebaseVm": True,
                }
            ]
            changed = True

    if changed:
        write_bridge_file(SESSIONS_PATH, store, "chore(firebase-vm): sync Firebase-VM local agy sessions")


def is_agy_authenticated() -> bool:
    try:
        chk = subprocess.run(
            [AGY_BIN, "models"],
            cwd=HOME_DIR,
            env=get_env(),
            capture_output=True,
            text=True,
            timeout=8,
        )
        out = chk.stdout + chk.stderr
        return chk.returncode == 0 and "Please sign in" not in out
    except Exception:
        return False


def start_auth_pty():
    global auth_pty_proc, auth_pty_fd, auth_oauth_url
    if auth_pty_proc is not None and auth_pty_proc.poll() is None and auth_oauth_url:
        return auth_oauth_url

    try:
        if auth_pty_fd is not None:
            try:
                os.close(auth_pty_fd)
            except Exception:
                pass
        if auth_pty_proc is not None:
            try:
                auth_pty_proc.kill()
            except Exception:
                pass
    except Exception:
        pass

    master_fd, slave_fd = pty.openpty()
    proc = subprocess.Popen(
        [AGY_BIN],
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        cwd=HOME_DIR,
        env=get_env(),
        close_fds=True,
    )
    os.close(slave_fd)
    auth_pty_proc = proc
    auth_pty_fd = master_fd
    auth_oauth_url = None

    collected = ""
    deadline = time.time() + 12.0
    while time.time() < deadline:
        r, _, _ = select.select([master_fd], [], [], 0.5)
        if r:
            try:
                chunk = os.read(master_fd, 4096).decode("utf-8", "replace")
                collected += chunk
                clean = strip_ansi(collected)
                m = re.search(r"(https://accounts\.google\.com/o/oauth2/auth\S+)", clean)
                if m:
                    auth_oauth_url = m.group(1).strip()
                    if "Enter the authorization code" in clean or len(auth_oauth_url) > 80:
                        break
            except OSError:
                break

    return auth_oauth_url


def submit_auth_code_to_pty(code_str: str) -> tuple[bool, str]:
    global auth_pty_proc, auth_pty_fd, auth_oauth_url
    if auth_pty_proc is None or auth_pty_proc.poll() is not None or auth_pty_fd is None:
        return False, "현재 대기 중인 인증 세션이 없습니다. 다시 질문을 입력해 인증 링크를 새로고침해 주세요."

    try:
        os.write(auth_pty_fd, (code_str.strip() + "\n").encode("utf-8"))
    except Exception as e:
        return False, f"인증 코드 전달 실패: {e}"

    collected = ""
    deadline = time.time() + 15.0
    success = False
    while time.time() < deadline:
        r, _, _ = select.select([auth_pty_fd], [], [], 0.5)
        if r:
            try:
                chunk = os.read(auth_pty_fd, 4096).decode("utf-8", "replace")
                collected += chunk
                clean = strip_ansi(collected)
                if "Authenticated as" in clean or "Welcome" in clean:
                    success = True
                    break
            except OSError:
                break

    if not success and is_agy_authenticated():
        success = True

    try:
        os.close(auth_pty_fd)
    except Exception:
        pass
    try:
        auth_pty_proc.kill()
    except Exception:
        pass
    auth_pty_proc = None
    auth_pty_fd = None
    auth_oauth_url = None

    if success:
        subprocess.run(
            ["systemctl", "--user", "restart", "antigravity-cli-daemon.service"],
            env=get_env(),
            capture_output=True,
        )
        write_bridge_file(
            STATUS_PATH,
            {
                "online": True,
                "vm": "Firebase-VM (agy-server / 35.188.210.15)",
                "agyBin": AGY_BIN,
                "authenticated": True,
                "updatedAt": int(time.time() * 1000),
            },
            "chore(firebase-vm): agy authenticated",
        )
        return True, (
            "### ✅ Firebase-VM (`agy-server`) `agy` CLI 인증 완료!\n"
            "정상적으로 Google 계정에 로그인되었으며 `antigravity-cli-daemon.service` (`Firebase-VM`)도 재시작되었습니다.\n\n"
            "이제 채팅창에 질문을 입력하시면 **`Firebase-VM`의 `agy` CLI**가 직접 실행하여 결과를 반환합니다!"
        )
    else:
        new_url = start_auth_pty()
        return False, (
            f"### ⚠️ 인증 코드 확인 실패\n"
            f"입력하신 코드가 만료되었거나 올바르지 않습니다.\n\n"
            f"새 인증 링크: 👉 **[Google 계정으로 Firebase-VM agy 로그인하기]({new_url})**\n\n"
            f"위 링크에서 발급된 새 인증 코드를 다시 붙여넣어 주세요."
        )


def map_model_for_agy(model_id: str) -> str:
    if not model_id:
        return ""
    m = model_id.lower()
    if "argon" in m:
        return "gemini-4-argon"
    if "flash" in m:
        return "gemini-3.8-flash"
    if "sonnet" in m:
        return "claude-sonnet-5-5-high"
    return model_id


def build_auth_prompt_message(oauth_url: str) -> str:
    return (
        "### 🔐 Firebase-VM (`agy-server`) `agy` CLI 로그인이 필요합니다\n"
        "현재 `Firebase-VM` (`35.188.210.15`, 계정 `syk4441`)의 `agy` CLI OAuth 토큰이 만료되어 재인증 대기 중입니다.\n\n"
        "1. 아래 구글 인증 링크를 클릭해 로그인하세요:\n"
        f"   👉 **[Google 계정으로 Firebase-VM agy 로그인하기]({oauth_url})**\n\n"
        "2. 로그인 후 화면에 표시되는 **인증 코드(Authorization Code, `4/...` 형태)**를 복사하여 **이 웹페이지 하단 채팅창에 그대로 입력하고 등록**해 주시면 즉시 `Firebase-VM`의 `agy`가 로그인됩니다!"
    )


def run_agy_prompt(prompt: str, model_id: str, web_session_id: str) -> tuple[str, str]:
    smap = load_session_map()
    agy_conv_id = smap.get(web_session_id, "")

    vm_convs = {s["conversationId"] for s in get_firebase_vm_sessions()}
    if web_session_id in vm_convs:
        agy_conv_id = web_session_id

    if auth_pty_proc is not None and auth_pty_proc.poll() is None and auth_oauth_url:
        return build_auth_prompt_message(auth_oauth_url), agy_conv_id

    def execute_once(use_model: str, use_conv: str):
        args = [
            AGY_BIN,
            "-p",
            prompt,
            "--output-format",
            "stream-json",
            "--dangerously-skip-permissions",
        ]
        if use_model:
            args.extend(["--model", use_model])
        if use_conv:
            args.extend(["--conversation", use_conv])

        proc = subprocess.Popen(
            args,
            cwd=HOME_DIR,
            env=get_env(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        tokens = []
        tools = []
        detected_conv_id = use_conv
        raw_stdout = []

        for line in proc.stdout:
            raw_stdout.append(line)
            trimmed = line.strip()
            if not trimmed:
                continue
            try:
                evt = json.loads(trimmed)
                ev_type = evt.get("event")
                if ev_type == "init" and evt.get("conversation_id"):
                    detected_conv_id = evt["conversation_id"]
                elif ev_type == "step_update" and evt.get("step_update"):
                    su = evt["step_update"]
                    if su.get("conversation_id"):
                        detected_conv_id = su["conversation_id"]
                    if su.get("text_delta"):
                        tokens.append(su["text_delta"])
                    st = su.get("step_type")
                    if st and st not in ("user_input", "agent_response", "system_message") and su.get("state") == "ACTIVE":
                        if st not in tools:
                            tools.append(st)
                elif ev_type == "result" and evt.get("result"):
                    res_obj = evt["result"]
                    if res_obj.get("conversation_id"):
                        detected_conv_id = res_obj["conversation_id"]
                    if not tokens and res_obj.get("response"):
                        tokens.append(res_obj["response"])
            except Exception:
                pass

        stderr_txt = proc.stderr.read()
        proc.wait(timeout=180)
        full_raw = "".join(raw_stdout) + "\n" + stderr_txt
        return proc.returncode, "".join(tokens).strip(), tools, detected_conv_id, strip_ansi(full_raw).strip()

    mapped_model = map_model_for_agy(model_id)
    code, answer, tools, new_conv_id, raw_out = execute_once(mapped_model, agy_conv_id)

    if "Please sign in" in raw_out or "authorize the application" in raw_out:
        oauth_url = start_auth_pty()
        if oauth_url:
            return build_auth_prompt_message(oauth_url), agy_conv_id
        return f"### 🔐 Firebase-VM (`agy-server`) `agy` 로그인이 필요합니다\n```text\n{raw_out}\n```", agy_conv_id

    if code != 0 and not answer:
        code, answer, tools, new_conv_id, raw_out = execute_once("", agy_conv_id)
        if code != 0 and not answer and agy_conv_id:
            code, answer, tools, new_conv_id, raw_out = execute_once("", "")

    if new_conv_id and web_session_id:
        smap[web_session_id] = new_conv_id
        save_session_map(smap)

    if not answer:
        answer = raw_out or "응답이 비어 있습니다."

    if tools:
        tool_badges = " ".join([f"`🛠 {t}`" for t in tools])
        answer = f"> **Firebase-VM (`agy`) 도구 실행**: {tool_badges}\n\n{answer}"

    return answer, new_conv_id


def process_request(req_item: dict):
    req_id = req_item.get("id")
    content = (req_item.get("content") or "").strip()
    session_id = req_item.get("sessionId") or "bc73f54f-c2e8-497a-a4ad-4a97dc1ffea2"
    model = req_item.get("model") or "gemini-3.8-flash"
    author = req_item.get("author") or "User"

    write_bridge_file(
        QUEUE_PATH,
        {
            "status": "processing",
            "processingSession": "Firebase-VM (agy-server / 35.188.210.15)",
            "request": req_item,
            "receivedAt": int(time.time() * 1000),
        },
        f"chore(firebase-vm): processing {req_id}",
    )

    # Check if user is submitting an OAuth code (e.g. "4/..." or ASCII token without spaces)
    is_code_input = content.startswith("4/") or (
        len(content) >= 20 and " " not in content and content.isascii()
    )
    if auth_pty_proc is not None and auth_pty_proc.poll() is None and is_code_input:
        ok, reply_msg = submit_auth_code_to_pty(content)
        answer = reply_msg
    else:
        answer, agy_cid = run_agy_prompt(content, model, session_id)

    new_note = {
        "id": req_id,
        "author": author,
        "content": content,
        "feedback": answer,
        "model": model,
        "timestamp": int(time.time() * 1000),
        "conversationId": session_id,
        "viaFirebaseVm": True,
    }

    write_bridge_file(
        QUEUE_PATH,
        {
            "status": "completed",
            "lastProcessedId": req_id,
            "completedAt": int(time.time() * 1000),
            "latestNote": new_note,
        },
        f"chore(firebase-vm): completed {req_id}",
    )

    store = read_bridge_file(SESSIONS_PATH)
    if not store or "sessionsData" not in store:
        store = {"sessionsList": [], "sessionsData": {}}
    if session_id not in store["sessionsData"]:
        store["sessionsData"][session_id] = []
    if not any(n.get("id") == req_id for n in store["sessionsData"][session_id]):
        store["sessionsData"][session_id].append(new_note)
    write_bridge_file(SESSIONS_PATH, store, f"feat(firebase-vm): append note {req_id}")


def main():
    print("🚀 Firebase-VM (agy-server) <-> sykagy.web.app Bridge Daemon starting...")
    authed = is_agy_authenticated()
    oauth_url = None
    if not authed:
        oauth_url = start_auth_pty()

    write_bridge_file(
        STATUS_PATH,
        {
            "online": True,
            "vm": "Firebase-VM (agy-server / 35.188.210.15)",
            "agyBin": AGY_BIN,
            "authenticated": authed,
            "authUrl": oauth_url,
            "startedAt": int(time.time() * 1000),
        },
        "chore(firebase-vm): bridge daemon online",
    )

    sync_vm_sessions_to_cloud()

    last_req_id = ""
    if LAST_REQ_FILE.exists():
        last_req_id = LAST_REQ_FILE.read_text("utf-8").strip()

    while True:
        try:
            q = read_bridge_file(QUEUE_PATH)
            if (
                q
                and q.get("status") == "pending"
                and isinstance(q.get("request"), dict)
                and q["request"].get("id")
                and q["request"]["id"] != last_req_id
            ):
                last_req_id = q["request"]["id"]
                LAST_REQ_FILE.write_text(last_req_id, "utf-8")
                process_request(q["request"])
        except Exception as e:
            print(f"[Firebase-VM Bridge Error] {e}", file=sys.stderr)
        time.sleep(1.5)


if __name__ == "__main__":
    main()
