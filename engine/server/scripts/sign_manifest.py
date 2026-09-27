"""Sign a FoxBox model-update manifest (P9), for the release process. Run from engine/:

    uv run --all-packages python server/scripts/sign_manifest.py --generate-key          # once per publisher
    uv run --all-packages python server/scripts/sign_manifest.py models.json -o models.signed.json

The private key lives at ~/.config/foxbox/manifest-signing.key (mode 0600), outside every repository, and never goes
into git. The engine trusts only the public keys listed in fvwks_server/manifest.py (PUBLIC_KEYS); --generate-key
prints the line to add there. The signature covers the manifest's canonical JSON (fvwks_server.manifest.canonical),
so what the engine verifies is exactly what was signed.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from fvwks_contracts.models import ModelManifest, SignedModelManifest
from fvwks_server.manifest import PUBLIC_KEYS, canonical, verify

DEFAULT_KEY = Path.home() / ".config" / "foxbox" / "manifest-signing.key"
DEFAULT_KEY_ID = "foxbox-1"


def _inside_git(path: Path) -> bool:
    probe = path if path.is_dir() else path.parent
    while not probe.exists():
        probe = probe.parent
    out = subprocess.run(["git", "-C", str(probe), "rev-parse", "--is-inside-work-tree"], capture_output=True,
                         text=True)
    return out.returncode == 0 and out.stdout.strip() == "true"


def public_key_b64(key: Ed25519PrivateKey) -> str:
    raw = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return base64.b64encode(raw).decode()


def generate_key(path: Path, key_id: str) -> str:
    """Create the private key (refusing to overwrite one, or to write inside a git work tree). Returns the public
    key, base64."""
    if path.exists():
        raise SystemExit(f"{path} already exists; not overwriting a signing key.")
    if _inside_git(path):
        raise SystemExit(f"{path} is inside a git work tree; keep the signing key outside every repository.")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    key = Ed25519PrivateKey.generate()
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                            serialization.NoEncryption())
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(pem)
    public = public_key_b64(key)
    print(f"Wrote {path} (0600). Add this to PUBLIC_KEYS in fvwks_server/manifest.py:", file=sys.stderr)
    print(f'    "{key_id}": "{public}",', file=sys.stderr)
    return public


def sign(manifest: ModelManifest, key_path: Path, key_id: str) -> SignedModelManifest:
    key = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise SystemExit(f"{key_path} isn't an ed25519 key.")
    signature = base64.b64encode(key.sign(canonical(manifest))).decode()
    return SignedModelManifest(manifest=manifest, signature=signature, key_id=key_id)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Sign a FoxBox model-update manifest (ed25519).")
    ap.add_argument("manifest", nargs="?", type=Path, help="the manifest JSON to sign")
    ap.add_argument("-o", "--out", type=Path, help="where to write the signed manifest (default: stdout)")
    ap.add_argument("--key", type=Path, default=DEFAULT_KEY, help=f"private key (default: {DEFAULT_KEY})")
    ap.add_argument("--key-id", default=DEFAULT_KEY_ID, help=f"key id the engine knows (default: {DEFAULT_KEY_ID})")
    ap.add_argument("--generate-key", action="store_true", help="create the private key, print its public key")
    args = ap.parse_args(argv)
    if args.generate_key:
        generate_key(args.key.expanduser(), args.key_id)
        return 0
    if args.manifest is None:
        ap.error("give the manifest JSON to sign (or --generate-key)")
    manifest = ModelManifest.model_validate(json.loads(args.manifest.read_text()))
    signed = sign(manifest, args.key.expanduser(), args.key_id)
    text = json.dumps(signed.model_dump(mode="json"), indent=2, ensure_ascii=False) + "\n"
    if args.out:
        args.out.write_text(text)
    else:
        sys.stdout.write(text)
    try:
        verify(signed)
    except ValueError:
        known = ", ".join(PUBLIC_KEYS) or "none"
        print(f"warning: the engine won't accept this yet: key {args.key_id!r} isn't in PUBLIC_KEYS ({known}).",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
