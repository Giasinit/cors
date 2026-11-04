#!/usr/bin/env python3
"""Build pinned upstream Bombardier and the explicitly extended train mode."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
REV = "2d495aca5b233bec0a5334dc4aa3cbdaef6e1bc5"
OUT = ROOT / "benchmark/assets"
OUT.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="cors-bombardier-build-") as tmp:
    source = Path(tmp) / "source"
    subprocess.run(["git", "clone", "--quiet", "https://github.com/codesenberg/bombardier.git", str(source)], check=True)
    subprocess.run(["git", "checkout", "--quiet", REV], cwd=source, check=True)
    env = dict(os.environ, CGO_ENABLED="0", GOTOOLCHAIN="go1.24.0")
    records = []
    for system, arch in [("linux", "amd64"), ("linux", "arm64")]:
        binary = Path(tmp) / f"bombardier-{system}-{arch}"
        subprocess.run(["go", "build", "-trimpath", "-ldflags", "-s -w", "-o", str(binary), "."],
                       cwd=source, env=dict(env, GOOS=system, GOARCH=arch), check=True)
        raw = binary.read_bytes()
        compressed = gzip.compress(raw, mtime=0)
        (OUT / (binary.name + ".gz")).write_bytes(compressed)
        records.append({"file": binary.name + ".gz", "sha256": hashlib.sha256(raw).hexdigest(),
                        "gzipSha256": hashlib.sha256(compressed).hexdigest(), "bytes": len(raw)})
    local = ROOT / ".vercel/bombardier-local"
    local.parent.mkdir(exist_ok=True)
    subprocess.run(["go", "build", "-trimpath", "-ldflags", "-s -w", "-o", str(local), "."],
                   cwd=source, env=env, check=True)
    extension = (ROOT / 'scripts/bombardier-fleet.go').read_bytes()
    (source / 'fleet_extension.go').write_bytes(extension)
    (source / 'fleet_extension_test.go').write_bytes((ROOT / 'scripts/bombardier-fleet_test.go').read_bytes())
    subprocess.run(['go', 'test', '-run', '^TestTrainFleet', '-count=1', '.'], cwd=source, env=env, check=True)
    fleet_records = []
    for system, arch in [("linux", "amd64"), ("linux", "arm64")]:
        binary = Path(tmp) / f"bombardier-fleet-{system}-{arch}"
        subprocess.run(["go", "build", "-trimpath", "-ldflags", "-s -w", "-o", str(binary), "."],
                       cwd=source, env=dict(env, GOOS=system, GOARCH=arch), check=True)
        raw = binary.read_bytes()
        compressed = gzip.compress(raw, mtime=0)
        (OUT / (binary.name + ".gz")).write_bytes(compressed)
        fleet_records.append({"file": binary.name + ".gz", "sha256": hashlib.sha256(raw).hexdigest(),
                              "gzipSha256": hashlib.sha256(compressed).hexdigest(), "bytes": len(raw)})
    subprocess.run(["go", "build", "-trimpath", "-ldflags", "-s -w", "-o", str(ROOT / '.vercel/bombardier-fleet-local'), "."],
                   cwd=source, env=env, check=True)
    (OUT / "fleet-provenance.json").write_text(json.dumps({
        "source": "https://github.com/codesenberg/bombardier", "commit": REV,
        "modified": True, "extension": "scripts/bombardier-fleet.go",
        "extensionSha256": hashlib.sha256(extension).hexdigest(),
        "toolchain": "go1.24.0", "CGO_ENABLED": "0", "artifacts": fleet_records,
    }, indent=2) + '\n')
    (OUT / "LICENSE").write_bytes((source / "LICENSE").read_bytes())
    (OUT / "provenance.json").write_text(json.dumps({
        "source": "https://github.com/codesenberg/bombardier", "commit": REV,
        "modified": False, "toolchain": "go1.24.0", "CGO_ENABLED": "0", "artifacts": records,
    }, indent=2) + "\n")
