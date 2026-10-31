#!/usr/bin/env python3
"""Sign the R13 release with the existing SH Chat identity; never creates a key.

Passwords are read by apksigner from SH_CHAT_STORE_PASSWORD and
SH_CHAT_KEY_PASSWORD. No key, password, or signed APK is written into Git.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import zipfile

PACKAGE = "com.smarthandicrafts.operatorhub"
VERSION = "1.0-r13"
VERSION_CODE = "13"
ORIGINAL_CERTIFICATE = "c1ca4799a7c1ff26ed2e188f3622d6b3b6144450ba656fde6f438629e75c4382"


def run(tool, *arguments):
    result = subprocess.run([str(tool), *map(str, arguments)], capture_output=True, text=True)
    if result.returncode:
        # Tool output is not echoed: signer diagnostics may include credential
        # file paths or aliases. The invocation itself never contains passwords.
        raise RuntimeError(f"{Path(tool).name} failed with exit code {result.returncode}.")
    return result.stdout


def tools_at(directory):
    directory = Path(directory).resolve()
    found = {name: directory / name for name in ("aapt", "apksigner", "zipalign")}
    if any(not item.is_file() for item in found.values()):
        raise RuntimeError("Use an installed Android build-tools directory containing aapt, apksigner and zipalign.")
    return found


def verify_release_identity(apk, tools):
    badging = run(tools["aapt"], "dump", "badging", apk)
    match = re.search(r"^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'", badging, re.M)
    if not match or match.groups() != (PACKAGE, VERSION_CODE, VERSION):
        raise RuntimeError("The input is not the production SH Chat R13 package/version.")
    if "application-debuggable" in badging:
        raise RuntimeError("Refusing a debuggable package as a production release.")
    with zipfile.ZipFile(apk) as archive:
        names = archive.namelist()
        if any(name.startswith("assets/simulation/") for name in names):
            raise RuntimeError("Refusing an APK containing the local simulation fixture.")


def verify_signature(apk, tools):
    verification = run(tools["apksigner"], "verify", "--verbose", "--print-certs", apk)
    hashes = re.findall(r"^Signer #\d+ certificate SHA-256 digest: ([0-9a-fA-F]+)$", verification, re.M)
    if len(hashes) != 1 or hashes[0].lower() != ORIGINAL_CERTIFICATE:
        raise RuntimeError("The signing certificate does not match the installed SH Chat identity. No update was published.")
    run(tools["zipalign"], "-c", "-P", "16", "4", apk)
    return hashes[0].lower()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", required=True, type=Path, help="R13 release APK, never the .simulation package")
    parser.add_argument("--build-tools", required=True, type=Path, help="Installed Android build-tools directory")
    parser.add_argument("--keystore", type=Path, help="Original private keystore; not copied or uploaded")
    parser.add_argument("--alias", default=os.environ.get("SH_CHAT_SIGNING_ALIAS"), help="Original key alias")
    parser.add_argument("--output", type=Path, help="New signed APK path; an existing file is never overwritten")
    parser.add_argument("--verify-only", action="store_true", help="Check an already signed R13 APK without using a private key")
    args = parser.parse_args()
    apk = args.apk.resolve(strict=True)
    tools = tools_at(args.build_tools)
    verify_release_identity(apk, tools)
    if args.verify_only:
        certificate = verify_signature(apk, tools)
        print(json.dumps({"ok": True, "apk": apk.name, "certificateSha256": certificate}))
        return
    if not args.keystore or not args.keystore.is_file() or not args.alias:
        raise RuntimeError("The original keystore and key alias are required; no replacement identity will be generated.")
    if not os.environ.get("SH_CHAT_STORE_PASSWORD") or not os.environ.get("SH_CHAT_KEY_PASSWORD"):
        raise RuntimeError("Set SH_CHAT_STORE_PASSWORD and SH_CHAT_KEY_PASSWORD through your private signing environment.")
    if not args.output:
        raise RuntimeError("Specify a new --output path for the verified signed update.")
    output = args.output.resolve()
    manifest_path = output.with_suffix(".verification.json")
    if output.exists() or manifest_path.exists():
        raise RuntimeError("The output or verification file already exists; choose a new output path.")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="sh-chat-sign-", dir=output.parent) as private_directory:
        temporary = Path(private_directory)
        aligned, signed = temporary / "aligned.apk", temporary / "signed.apk"
        run(tools["zipalign"], "-P", "16", "4", apk, aligned)
        run(tools["apksigner"], "sign", "--ks", args.keystore.resolve(), "--ks-key-alias", args.alias,
            "--ks-pass", "env:SH_CHAT_STORE_PASSWORD", "--key-pass", "env:SH_CHAT_KEY_PASSWORD",
            "--out", signed, aligned)
        verify_release_identity(signed, tools)
        certificate = verify_signature(signed, tools)
        manifest = {"ok": True, "package": PACKAGE, "versionName": VERSION, "versionCode": int(VERSION_CODE),
                    "certificateSha256": certificate, "unsignedSha256": hashlib.sha256(apk.read_bytes()).hexdigest(),
                    "signedSha256": hashlib.sha256(signed.read_bytes()).hexdigest(),
                    "signedBytes": signed.stat().st_size, "zipAlignment16KiBPassed": True,
                    "signatureVerified": True, "signingIdentityMatchesExistingApp": True,
                    "deviceUpgradeTest": "not_run", "productionAcceptance": "separate_required_gate"}
        staged_manifest = temporary / "verification.json"
        staged_manifest.write_text(json.dumps(manifest, indent=2) + "\n")
        # Same-filesystem exclusive links publish complete verified bytes without
        # overwriting another signing process's output after the earlier check.
        os.link(staged_manifest, manifest_path)
        try:
            os.link(signed, output)
        except OSError:
            if manifest_path.stat().st_ino == staged_manifest.stat().st_ino:
                manifest_path.unlink()
            raise
    print(json.dumps({"ok": True, "apk": output.name, "verification": manifest_path.name,
                      "sha256": manifest["signedSha256"]}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, zipfile.BadZipFile) as error:
        print(f"Signing stopped: {error}", file=sys.stderr)
        sys.exit(1)
