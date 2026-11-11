#!/usr/bin/env python3
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
STATIC_DIR = REPO_ROOT / "static"
PROJECT_ID = "agy-web-9f33e"
SITE_ID = "sykagy"


def should_skip_deploy() -> bool:
    try:
        last_msg = subprocess.check_output(
            ["git", "log", "-1", "--pretty=%B"], cwd=REPO_ROOT, text=True, timeout=5
        ).strip()
        # Skip automatic deploy for internal bridge queue/session syncing commits
        if last_msg.startswith("chore(firebase-vm)") or last_msg.startswith("feat(bridge)"):
            print(f"⏩ [Deploy Skip]: Internal bridge commit ('{last_msg[:40]}...'). Skipping deploy.")
            return True
    except Exception:
        pass
    return False


def get_access_token() -> str:
    token_path = Path("/home/syk4441/.gemini/antigravity-cli/antigravity-oauth-token")
    if token_path.exists():
        try:
            data = json.loads(token_path.read_text("utf-8"))
            return data["token"]["access_token"]
        except Exception:
            pass
    try:
        out = subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True, timeout=10)
        return out.strip()
    except Exception:
        pass
    return None


def ensure_static_files():
    if not STATIC_DIR.exists():
        STATIC_DIR.mkdir(parents=True, exist_ok=True)

    # Use index.html or notes.html as source
    source_file = None
    for cand in ["notes.html", "index.html", "comments.html"]:
        p = STATIC_DIR / cand
        if p.exists() and p.stat().st_size > 1000:
            source_file = p
            break

    if source_file:
        for target in ["index.html", "notes.html", "comments.html"]:
            dest = STATIC_DIR / target
            if not dest.exists() or dest.stat().st_size == 0 or dest.stat().st_size != source_file.stat().st_size:
                shutil.copy(source_file, dest)

    # Always ensure 404.html redirect page exists
    f404 = STATIC_DIR / "404.html"
    if not f404.exists():
        f404.write_text("""<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="0; url=/">
  <title>BlackNote Redirecting...</title>
  <script>window.location.replace('/');</script>
</head>
<body style="background:#08090b; color:#888; font-family:sans-serif; text-align:center; padding-top:20vh;">
  <p>BlackNote로 이동 중입니다...</p>
</body>
</html>
""", "utf-8")


def deploy_hosting():
    if should_skip_deploy():
        return

    # Pull latest from origin if possible
    try:
        subprocess.run(["git", "pull", "--rebase"], cwd=REPO_ROOT, timeout=10, capture_output=True)
    except Exception:
        pass

    # Ensure notes.html, comments.html, 404.html always exist so users NEVER get 404!
    ensure_static_files()

    token = get_access_token()
    if not token:
        print("❌ [Deploy Error]: Could not find a valid OAuth token.")
        sys.exit(1)

    headers = {
        "Authorization": f"Bearer {token}",
        "X-Goog-User-Project": PROJECT_ID,
        "Content-Type": "application/json",
    }

    print(f"🚀 Deploying '{STATIC_DIR}' to Firebase Hosting ({SITE_ID})...")

    # 1. Create version with rewrites config
    config = {
        "config": {
            "rewrites": [
                {
                    "glob": "/api/**",
                    "function": "api",
                }
            ]
        }
    }
    create_url = f"https://firebasehosting.googleapis.com/v1beta1/sites/{SITE_ID}/versions"
    req = urllib.request.Request(create_url, data=json.dumps(config).encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            v_data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"❌ Failed to create version: {e.code} {e.read().decode('utf-8')}")
        sys.exit(1)

    version_name = v_data["name"]
    print(f"  ✔ Created version: {version_name}")

    # 2. Collect and compress files
    files_map = {}
    gz_content_map = {}
    for p in STATIC_DIR.rglob("*"):
        if p.is_file():
            rel = "/" + p.relative_to(STATIC_DIR).as_posix()
            raw = p.read_bytes()
            gz = gzip.compress(raw, 9)
            h = hashlib.sha256(gz).hexdigest()
            files_map[rel] = h
            gz_content_map[h] = gz

    # 3. Populate files
    pop_url = f"https://firebasehosting.googleapis.com/v1beta1/{version_name}:populateFiles"
    pop_req = urllib.request.Request(
        pop_url,
        data=json.dumps({"files": files_map}).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(pop_req, timeout=15) as resp:
        pop_res = json.loads(resp.read().decode("utf-8"))

    upload_url = pop_res.get("uploadUrl")
    required = pop_res.get("uploadRequiredHashes", [])

    # 4. Upload missing hashes
    if required:
        print(f"  ⬆ Uploading {len(required)} files...")
        for h in required:
            up_req = urllib.request.Request(
                f"{upload_url}/{h}",
                data=gz_content_map[h],
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/octet-stream",
                    "X-Goog-User-Project": PROJECT_ID,
                },
                method="POST",
            )
            with urllib.request.urlopen(up_req, timeout=30) as up_resp:
                pass
    else:
        print("  ✔ All files matched existing cache.")

    # 5. Finalize version
    fin_url = f"https://firebasehosting.googleapis.com/v1beta1/{version_name}?update_mask=status"
    fin_req = urllib.request.Request(
        fin_url,
        data=json.dumps({"status": "FINALIZED"}).encode("utf-8"),
        headers=headers,
        method="PATCH",
    )
    with urllib.request.urlopen(fin_req, timeout=15) as resp:
        pass
    print("  ✔ Version finalized.")

    # 6. Release version
    rel_url = f"https://firebasehosting.googleapis.com/v1beta1/sites/{SITE_ID}/releases?versionName={version_name}"
    rel_req = urllib.request.Request(rel_url, data=b"{}", headers=headers, method="POST")
    with urllib.request.urlopen(rel_req, timeout=15) as resp:
        release_res = json.loads(resp.read().decode("utf-8"))
    print(f"✅ Successfully released to https://{SITE_ID}.web.app! Release: {release_res.get('name')}")


if __name__ == "__main__":
    deploy_hosting()
