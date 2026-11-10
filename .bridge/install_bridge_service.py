
import urllib.request, json, subprocess, os

url = "https://sykagy.web.app/api/github/file?repo=syk-genon/agy-web&path=.bridge/firebase_vm_bridge.py"
req = urllib.request.Request(url, headers={"User-Agent": "Installer"})
with urllib.request.urlopen(req, timeout=15) as r:
    code = json.loads(r.read().decode("utf-8"))["content"]

with open("/home/syk4441/firebase_vm_bridge.py", "w", encoding="utf-8") as f:
    f.write(code)
os.chmod("/home/syk4441/firebase_vm_bridge.py", 0o755)
subprocess.run(["chown", "syk4441:syk4441", "/home/syk4441/firebase_vm_bridge.py"])

service_unit = """[Unit]
Description=Firebase-VM agy CLI <-> sykagy.web.app Bridge Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=syk4441
Group=syk4441
WorkingDirectory=/home/syk4441
Environment=HOME=/home/syk4441
Environment=USER=syk4441
Environment=PATH=/home/syk4441/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=XDG_RUNTIME_DIR=/run/user/1000
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
ExecStart=/usr/bin/python3 -u /home/syk4441/firebase_vm_bridge.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
"""

with open("/etc/systemd/system/firebase-vm-bridge.service", "w", encoding="utf-8") as f:
    f.write(service_unit)

subprocess.run(["systemctl", "daemon-reload"])
subprocess.run(["systemctl", "enable", "firebase-vm-bridge.service"])
subprocess.run(["systemctl", "restart", "firebase-vm-bridge.service"])
print("FIREBASE_VM_BRIDGE_INSTALLED_OK")
