
import subprocess, urllib.request, json

out = {}
def run(cmd):
    try:
        return subprocess.check_output(cmd, shell=True, stderr=subprocess.STDOUT, timeout=10).decode("utf-8", "replace")
    except Exception as e:
        return str(e) + "\n" + getattr(e, "output", b"").decode("utf-8", "replace")

out["status"] = run("systemctl status firebase-vm-bridge.service")
out["journal"] = run("journalctl -u firebase-vm-bridge.service -n 50 --no-pager")
out["ps"] = run("ps aux | grep -E \"python3|agy\"")

req = urllib.request.Request(
    "https://sykagy.web.app/api/github/commit",
    data=json.dumps({
        "repo": "syk-genon/agy-web",
        "path": ".bridge/service_diag.json",
        "content": json.dumps(out, indent=2, ensure_ascii=False),
        "message": "diag: bridge service logs"
    }).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="POST"
)
urllib.request.urlopen(req, timeout=15)
print("SERVICE_DIAG_SENT")
