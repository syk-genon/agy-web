
import urllib.request, json, subprocess, os

url = "https://sykagy.web.app/api/github/file?repo=syk-genon/agy-web&path=.bridge/firebase_vm_bridge.py&_t=2"
req = urllib.request.Request(url, headers={"User-Agent": "Installer"})
with urllib.request.urlopen(req, timeout=15) as r:
    code = json.loads(r.read().decode("utf-8"))["content"]

with open("/home/syk4441/firebase_vm_bridge.py", "w", encoding="utf-8") as f:
    f.write(code)
os.chmod("/home/syk4441/firebase_vm_bridge.py", 0o755)
subprocess.run(["chown", "syk4441:syk4441", "/home/syk4441/firebase_vm_bridge.py"])
subprocess.run(["pkill", "-f", "agy -p"])
subprocess.run(["systemctl", "restart", "firebase-vm-bridge.service"])
print("FIREBASE_VM_BRIDGE_RESTARTED_OK")
