
import subprocess, urllib.request, json

out = {}
def run(cmd):
    try:
        return subprocess.check_output(cmd, shell=True, stderr=subprocess.STDOUT, timeout=10).decode("utf-8", "replace")
    except Exception as e:
        return str(e) + "\n" + getattr(e, "output", b"").decode("utf-8", "replace")

out["free"] = run("free -h")
out["ps_agy"] = run("ps aux | grep -E \"agy|python3\"")
out["journal"] = run("journalctl -u firebase-vm-bridge.service -n 30 --no-pager")

req = urllib.request.Request(
    "https://sykagy.web.app/api/github/commit",
    data=json.dumps({
        "repo": "syk-genon/agy-web",
        "path": ".bridge/check_proc.json",
        "content": json.dumps(out, indent=2, ensure_ascii=False),
        "message": "check proc"
    }).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="POST"
)
urllib.request.urlopen(req, timeout=15)
