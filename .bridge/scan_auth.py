
import os, subprocess, json

out = {}
for root, dirs, files in os.walk("/home/syk4441/.gemini"):
    for f in files:
        p = os.path.join(root, f)
        try:
            sz = os.path.getsize(p)
            out[p] = sz
        except:
            pass

for root, dirs, files in os.walk("/home/syk4441/.config"):
    for f in files:
        p = os.path.join(root, f)
        try:
            sz = os.path.getsize(p)
            out[p] = sz
        except:
            pass

print("SCAN_START")
print(json.dumps(out, indent=2))
print("SCAN_END")
