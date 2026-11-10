
import subprocess, pty, os, select, time, re

master, slave = pty.openpty()
proc = subprocess.Popen(
    ["/home/syk4441/.local/bin/agy", "--print-timeout", "600", "-p", "ping"],
    stdin=slave, stdout=slave, stderr=slave,
    cwd="/home/syk4441",
    env={"HOME": "/home/syk4441", "USER": "syk4441", "PATH": "/home/syk4441/.local/bin:/usr/local/bin:/usr/bin:/bin", "XDG_RUNTIME_DIR": "/run/user/1000"},
    close_fds=True
)
os.close(slave)

buf = ""
for _ in range(20):
    r, _, _ = select.select([master], [], [], 0.5)
    if r:
        try:
            chunk = os.read(master, 1024).decode("utf-8", "replace")
            buf += chunk
            if "Enter the authorization code" in buf:
                break
        except:
            break

print("PTY_OUT_START")
print(buf)
print("POLL:", proc.poll())
print("PTY_OUT_END")
proc.kill()
