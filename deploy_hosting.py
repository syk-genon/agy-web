#!/usr/bin/env python3
import gzip
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
STATIC_DIR = REPO_ROOT / "static"
PROJECT_ID = "agy-web-9f33e"
SITE_ID = "sykagy"


def get_access_token() -> str:
    token_path = Path("/home/syk4441/.gemini/antigravity-cli/antigravity-oauth-token")
    if token_path.exists():
        try:
            data = json.loads(token_path.read_text("utf-8"))
            return data["token"]["access_token"]
        except Exception:
            pass
    try:
        import subprocess
        out = subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True)
        return out.strip()
    except Exception:
        pass
    return None


def deploy_hosting():
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
                    "run": {
                        "serviceId": "api",
                        "region": "us-central1",
                    },
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
