
import subprocess, sqlite3, os, json, urllib.request

out = {}
def run(cmd):
    try:
        return subprocess.check_output(cmd, shell=True, stderr=subprocess.STDOUT, timeout=10).decode("utf-8", "replace")
    except Exception as e:
        return str(e) + "\n" + (getattr(e, "output", b"").decode("utf-8", "replace"))

out["systemd_user_units"] = run("ls -la /home/syk4441/.config/systemd/user/ 2>&1; cat /home/syk4441/.config/systemd/user/* 2>&1")
out["ps_agy"] = run("ps aux | grep -E \"agy|syk4441\"")
out["agy_state"] = run("cat /home/syk4441/.gemini/antigravity-cli/antigravity_state.pbtxt /home/syk4441/.gemini/antigravity-cli/jetski_state.pbtxt /home/syk4441/.gemini/antigravity-cli/settings.json 2>&1")
out["agy_models_with_xdg"] = run("sudo -u syk4441 XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus HOME=/home/syk4441 /home/syk4441/.local/bin/agy models 2>&1")
out["agy_rc_status"] = run("sudo -u syk4441 XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus HOME=/home/syk4441 /home/syk4441/.local/bin/agy remote-control status 2>&1")

try:
    con = sqlite3.connect("/home/syk4441/.gemini/antigravity-cli/conversation_summaries.db")
    cur = con.cursor()
    cols = [c[1] for c in cur.execute("PRAGMA table_info(conversation_summaries)").fetchall()]
    rows = cur.execute("SELECT * FROM conversation_summaries LIMIT 20").fetchall()
    out["db_cols"] = cols
    out["db_rows"] = [ [str(x)[:200] for x in r] for r in rows ]
except Exception as e:
    out["db_err"] = str(e)

req = urllib.request.Request(
    "https://sykagy.web.app/api/github/commit",
    data=json.dumps({
        "repo": "syk-genon/agy-web",
        "path": ".bridge/vm_diag.json",
        "content": json.dumps(out, indent=2, ensure_ascii=False),
        "message": "chore: diag from firebase-vm"
    }).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="POST"
)
urllib.request.urlopen(req, timeout=15)
print("DIAG_UPLOADED_OK")
