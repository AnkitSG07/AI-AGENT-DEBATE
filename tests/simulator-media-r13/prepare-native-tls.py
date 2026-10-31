#!/usr/bin/env python3
"""Prepare isolated emulator TLS. Private test keys never enter the repository."""
from pathlib import Path
import json
import os
import shutil
import subprocess

repo = Path(__file__).resolve().parents[2]
output = Path(os.environ.get('SH_NATIVE_MEDIA_OUTPUT', str(repo.parent / 'native-media-fixture'))).resolve()
tls = Path(os.environ.get('SH_NATIVE_MEDIA_TLS', str(output / 'tls'))).resolve()
if tls == repo or repo in tls.parents:
    raise SystemExit('Keep generated private test keys outside the source repository.')
tls.mkdir(parents=True, exist_ok=True)
tls.chmod(0o700)
asset = repo / 'android/operatorhub/app/src/androidTest/assets/native-media-ca.crt'
required = [tls / name for name in ['ca.crt', 'ca.key', 'server.crt', 'server.key']]

def run(*args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode:
        raise SystemExit('Local test TLS preparation failed: ' + result.stderr.strip())

reused = all(path.is_file() for path in required)
if reused:
    run('openssl', 'verify', '-CAfile', str(tls / 'ca.crt'), str(tls / 'server.crt'))
    run('openssl', 'x509', '-in', str(tls / 'server.crt'), '-checkend', '60', '-noout')
elif any(path.exists() for path in required):
    raise SystemExit('Incomplete existing fixture certificates; choose a new SH_NATIVE_MEDIA_TLS directory.')
else:
    (tls / 'server.cnf').write_text(
        '[ext]\nsubjectAltName=DNS:sh-r13-simulator.livekit.cloud\n'
        'basicConstraints=critical,CA:FALSE\n'
        'keyUsage=critical,digitalSignature,keyEncipherment\n'
        'extendedKeyUsage=serverAuth\n')
    run('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', str(tls / 'ca.key'), '-out', str(tls / 'ca.crt'), '-days', '7',
        '-subj', '/CN=SH Chat isolated emulator test CA',
        '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign')
    run('openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', str(tls / 'server.key'), '-out', str(tls / 'server.csr'),
        '-subj', '/CN=sh-r13-simulator.livekit.cloud')
    run('openssl', 'x509', '-req', '-in', str(tls / 'server.csr'),
        '-CA', str(tls / 'ca.crt'), '-CAkey', str(tls / 'ca.key'), '-CAcreateserial',
        '-out', str(tls / 'server.crt'), '-days', '7', '-extfile', str(tls / 'server.cnf'), '-extensions', 'ext')
for path in tls.glob('*.key'):
    path.chmod(0o600)
asset.parent.mkdir(parents=True, exist_ok=True)
shutil.copyfile(tls / 'ca.crt', asset)
print(json.dumps({'ready': True, 'reused': reused, 'certificate': str(tls / 'ca.crt'),
                  'androidTestAsset': str(asset), 'privateKeysInSource': False}))
