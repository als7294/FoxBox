"""Signed model-update manifests (v0.6, P9).

The app's updater fetches a small manifest published with each release, only when the user allows update checks,
and hands it to the engine (PUT /api/models/manifest). The engine accepts it only with a valid ed25519 signature
from a key listed below. The private key stays on the publisher's machine (~/.config/foxbox/manifest-signing.key,
see scripts/sign_manifest.py) and is never in git.

The signature covers the manifest's canonical JSON: the validated model dumped with its keys sorted, no
whitespace, UTF-8. Signer and engine both use ``canonical()``.
"""
from __future__ import annotations

import base64
import binascii
import json

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from fvwks_contracts.models import ModelManifest, SignedModelManifest

# Key id → raw ed25519 public key, base64. To rotate, add the new key first and retire the old one a release later,
# so apps already out there keep verifying.
PUBLIC_KEYS: dict[str, str] = {
    "foxbox-1": "Bth1JNF1b2bHGE86+hZKOebuTkkSrVX0HzYnI4C5/GE=",
}


def canonical(manifest: ModelManifest) -> bytes:
    return json.dumps(manifest.model_dump(mode="json"), sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False).encode("utf-8")


def verify(signed: SignedModelManifest, keys: dict[str, str] | None = None) -> str:
    """The id of the key that signed the manifest. Raises ValueError unless a trusted key verifies the signature
    (an unknown key id never falls back to the others)."""
    keys = PUBLIC_KEYS if keys is None else keys
    try:
        signature = base64.b64decode(signed.signature, validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("The manifest's signature isn't valid base64.") from None
    if signed.key_id is not None:
        keys = {signed.key_id: keys[signed.key_id]} if signed.key_id in keys else {}
    data = canonical(signed.manifest)
    for key_id, public in keys.items():
        try:
            Ed25519PublicKey.from_public_bytes(base64.b64decode(public)).verify(signature, data)
            return key_id
        except (InvalidSignature, ValueError, binascii.Error):
            continue
    raise ValueError("The manifest isn't signed by a trusted key.")
