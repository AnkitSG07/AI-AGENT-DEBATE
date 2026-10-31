#!/usr/bin/env python3
"""Download checksum-pinned public tools for the isolated R13 media simulator.

Python 3.12+. No service account, project credentials, enrollment or Meta secrets
are read. Nothing is installed system-wide and no downloaded script is executed.
"""
from pathlib import Path
import base64
import hashlib
import io
import json
import tarfile
import urllib.request

root = Path(__file__).resolve().parents[3] / "tooling" / "r13-media"
root.mkdir(parents=True, exist_ok=True)
artifacts = [
    {"name": "livekit_1.13.11_linux_amd64.tar.gz", "url": "https://github.com/livekit/livekit/releases/download/v1.13.11/livekit_1.13.11_linux_amd64.tar.gz",
     "sha256": "1e9ee90ca301e1842b2887fc77cb122759756a9c8aeb4334ee91de3325ec43fb", "extract": "server"},
    {"name": "livekit-client-2.23.0.tgz", "url": "https://registry.npmjs.org/livekit-client/-/livekit-client-2.23.0.tgz",
     "sha512": "j9Kg86nJjBjNFUD+ukp2jwMCGa0k+YD5gU//RzAM+ZY3pbG631QCte7fQjwqWMmtBzhDJL9nKYuOLMv/9IbAxg==", "extract": "client"},
    {"name": "cloud-firestore-emulator-v1.19.8.jar", "url": "https://storage.googleapis.com/firebase-preview-drop/emulator/cloud-firestore-emulator-v1.19.8.jar",
     "sha256": "9d43599ed6151199e8d604dc87fac51218e49e5f3a48519b1ae560bbe5e3382d"},
]
verified = []
for entry in artifacts:
    destination = root / entry["name"]
    data = destination.read_bytes() if destination.exists() else urllib.request.urlopen(entry["url"], timeout=90).read()
    if "sha256" in entry:
        if hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise RuntimeError(f"Checksum mismatch: {entry['name']}")
    else:
        if base64.b64encode(hashlib.sha512(data).digest()).decode() != entry["sha512"]:
            raise RuntimeError(f"Integrity mismatch: {entry['name']}")
    if not destination.exists():
        destination.write_bytes(data)
    if "extract" in entry:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            archive.extractall(root / entry["extract"], filter="data")
    verified.append({"name": entry["name"], "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "source": entry["url"]})
manifest = {"artifacts": verified, "toolingDirectory": str(root),
            "firestoreJar": str(root / "cloud-firestore-emulator-v1.19.8.jar"),
            "livekitServer": str(root / "server/livekit-server")}
(root / "verified-tools.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps(manifest, indent=2))
