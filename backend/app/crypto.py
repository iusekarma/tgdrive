"""Key hierarchy and authenticated encryption.

    master password --Argon2id--> KEK --wraps--+
                                               +--> vault key
    master recovery key (random) -------wraps--+        |
                                                       HKDF
                                      +-----------------+-----------------+
                               open-drive key                      binding key
                                      |                                   |
                       wraps the master key of            HKDF(Argon2id(drive password),
                       drives without a password           binding key) wraps the master
                                                           key of password drives
    drive recovery key (random) --wraps--> drive master key  (password drives only)

    drive master key --HKDF--> file-key wrapping key, name key
    per-file random key --AES-256-GCM--> chunks and the thumbnail

Nothing here is ever stored unwrapped. The passwords and recovery keys
exist only outside the system.
"""
from __future__ import annotations

import base64
import os
import struct

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.argon2 import Argon2id
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

KEY_LEN = 32
NONCE_LEN = 12
TAG_LEN = 16
CHUNK_OVERHEAD = NONCE_LEN + TAG_LEN
SALT_LEN = 16

# Stored per drive, so these can be raised later without breaking old drives.
KDF_PARAMS = {"alg": "argon2id", "t": 3, "m_kib": 65536, "p": 4}

SNAPSHOT_PLAIN = b"TGD1"
SNAPSHOT_ENCRYPTED = b"TGD2"


class BadKey(Exception):
    """Wrong password / recovery key, or the ciphertext was modified."""


def _seal(key: bytes, plaintext: bytes, aad: bytes) -> bytes:
    nonce = os.urandom(NONCE_LEN)
    return nonce + AESGCM(key).encrypt(nonce, plaintext, aad)


def _open(key: bytes, blob: bytes, aad: bytes) -> bytes:
    try:
        return AESGCM(key).decrypt(blob[:NONCE_LEN], blob[NONCE_LEN:], aad)
    except (InvalidTag, ValueError):
        raise BadKey("decryption failed") from None


def _kdf(password: str, salt: bytes, params: dict) -> bytes:
    if params.get("alg") != "argon2id":
        raise ValueError(f"unsupported KDF: {params.get('alg')}")
    return Argon2id(
        salt=salt,
        length=KEY_LEN,
        iterations=params["t"],
        lanes=params["p"],
        memory_cost=params["m_kib"],
    ).derive(password.encode("utf-8"))


def _hkdf(key: bytes, info: bytes, salt: bytes | None = None) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=KEY_LEN, salt=salt, info=info).derive(key)


# --- recovery key -----------------------------------------------------------

def _format_recovery(raw: bytes) -> str:
    s = base64.b32encode(raw).decode().rstrip("=")
    return "-".join(s[i:i + 4] for i in range(0, len(s), 4))


def _parse_recovery(text: str) -> bytes:
    s = "".join(text.split()).replace("-", "").upper()
    s += "=" * (-len(s) % 8)
    try:
        raw = base64.b32decode(s)
    except Exception:
        raise BadKey("malformed recovery key") from None
    if len(raw) != KEY_LEN:
        raise BadKey("malformed recovery key")
    return raw


# --- vault ------------------------------------------------------------------

def new_vault_key() -> bytes:
    return os.urandom(KEY_LEN)


def wrap_vault_with_password(vault_key: bytes, password: str) -> tuple[bytes, dict, bytes]:
    """Returns (salt, kdf_params, wrapped_key)."""
    salt = os.urandom(SALT_LEN)
    params = dict(KDF_PARAMS)
    return salt, params, _seal(_kdf(password, salt, params), vault_key, b"tgdrive/vault-key/pw")


def unwrap_vault_with_password(password: str, salt: bytes, params: dict, wrapped: bytes) -> bytes:
    return _open(_kdf(password, salt, params), wrapped, b"tgdrive/vault-key/pw")


def wrap_vault_with_recovery(vault_key: bytes) -> tuple[str, bytes]:
    """Returns (recovery_key_to_show_once, wrapped_key)."""
    raw = os.urandom(KEY_LEN)
    kek = _hkdf(raw, b"tgdrive/vault-recovery")
    return _format_recovery(raw), _seal(kek, vault_key, b"tgdrive/vault-key/rk")


def unwrap_vault_with_recovery(recovery_key: str, wrapped: bytes) -> bytes:
    kek = _hkdf(_parse_recovery(recovery_key), b"tgdrive/vault-recovery")
    return _open(kek, wrapped, b"tgdrive/vault-key/rk")


class VaultKeys:
    """Subkeys of the unlocked vault. Lives in memory only."""

    def __init__(self, vault_key: bytes):
        self.vault_key = vault_key
        self._open = _hkdf(vault_key, b"tgdrive/open-drives")
        self._binding = _hkdf(vault_key, b"tgdrive/drive-binding")

    def wrap_open(self, drive_id: str, master_key: bytes) -> bytes:
        return _seal(self._open, master_key, b"tgdrive/drive-key/open|" + drive_id.encode())

    def unwrap_open(self, drive_id: str, wrapped: bytes) -> bytes:
        return _open(self._open, wrapped, b"tgdrive/drive-key/open|" + drive_id.encode())

    def bind(self, drive_id: str, password_kek: bytes) -> bytes:
        """A drive password alone opens nothing: its KEK is mixed with the vault."""
        return _hkdf(password_kek, b"tgdrive/drive-key/bound|" + drive_id.encode(), salt=self._binding)


# --- drive master key -------------------------------------------------------

def wrap_with_password(drive_id: str, master_key: bytes, password: str,
                       vault: VaultKeys | None = None) -> tuple[bytes, dict, bytes]:
    """Returns (salt, kdf_params, wrapped_key). Without a vault this is the
    legacy, password-only wrapping, kept so old drives can still be opened."""
    salt = os.urandom(SALT_LEN)
    params = dict(KDF_PARAMS)
    kek = _kdf(password, salt, params)
    if vault is None:
        return salt, params, _seal(kek, master_key, b"tgdrive/drive-key/pw|" + drive_id.encode())
    return salt, params, _seal(vault.bind(drive_id, kek), master_key, b"tgdrive/drive-key/bound|" + drive_id.encode())


def unwrap_with_password(drive_id: str, password: str, salt: bytes, params: dict, wrapped: bytes,
                         vault: VaultKeys | None = None) -> bytes:
    kek = _kdf(password, salt, params)
    if vault is None:
        return _open(kek, wrapped, b"tgdrive/drive-key/pw|" + drive_id.encode())
    return _open(vault.bind(drive_id, kek), wrapped, b"tgdrive/drive-key/bound|" + drive_id.encode())


def wrap_with_recovery(drive_id: str, master_key: bytes) -> tuple[str, bytes]:
    """Returns (recovery_key_to_show_once, wrapped_key)."""
    raw = os.urandom(KEY_LEN)
    kek = _hkdf(raw, b"tgdrive/recovery")
    return _format_recovery(raw), _seal(kek, master_key, b"tgdrive/drive-key/rk|" + drive_id.encode())


def unwrap_with_recovery(drive_id: str, recovery_key: str, wrapped: bytes) -> bytes:
    kek = _hkdf(_parse_recovery(recovery_key), b"tgdrive/recovery")
    return _open(kek, wrapped, b"tgdrive/drive-key/rk|" + drive_id.encode())


def new_master_key() -> bytes:
    return os.urandom(KEY_LEN)


class DriveKeys:
    """Subkeys of an unlocked drive. Lives in memory only."""

    def __init__(self, master_key: bytes):
        self.master_key = master_key
        self._file_wrap = _hkdf(master_key, b"tgdrive/file-keys")
        self._names = _hkdf(master_key, b"tgdrive/names")

    def new_file_key(self, node_id: str) -> tuple[bytes, bytes]:
        """Returns (file_key, wrapped_file_key)."""
        key = os.urandom(KEY_LEN)
        return key, _seal(self._file_wrap, key, b"tgdrive/file-key|" + node_id.encode())

    def unwrap_file_key(self, node_id: str, wrapped: bytes) -> bytes:
        return _open(self._file_wrap, wrapped, b"tgdrive/file-key|" + node_id.encode())

    def encrypt_name(self, node_id: str, name: str) -> bytes:
        return _seal(self._names, name.encode("utf-8"), b"tgdrive/name|" + node_id.encode())

    def decrypt_name(self, node_id: str, blob: bytes) -> str:
        return _open(self._names, blob, b"tgdrive/name|" + node_id.encode()).decode("utf-8")


# --- thumbnails -------------------------------------------------------------

def encrypt_thumbnail(file_key: bytes, node_id: str, data: bytes) -> bytes:
    return _seal(file_key, data, b"tgdrive/thumbnail|" + node_id.encode())


def decrypt_thumbnail(file_key: bytes, node_id: str, blob: bytes) -> bytes:
    return _open(file_key, blob, b"tgdrive/thumbnail|" + node_id.encode())


# --- chunks -----------------------------------------------------------------

def _chunk_aad(node_id: str, idx: int, final: bool) -> bytes:
    # Binds each chunk to its file, its position, and whether it is the last
    # one, so blobs cannot be swapped, reordered or truncated undetected.
    return b"tgdrive/chunk|" + node_id.encode() + b"|" + struct.pack(">QB", idx, int(final))


def encrypt_chunk(file_key: bytes, node_id: str, idx: int, final: bool, data: bytes) -> bytes:
    return _seal(file_key, data, _chunk_aad(node_id, idx, final))


def decrypt_chunk(file_key: bytes, node_id: str, idx: int, final: bool, blob: bytes) -> bytes:
    return _open(file_key, blob, _chunk_aad(node_id, idx, final))


# --- database snapshot ------------------------------------------------------

def seal_snapshot(data: bytes, passphrase: str | None) -> bytes:
    if not passphrase:
        return SNAPSHOT_PLAIN + data
    salt = os.urandom(SALT_LEN)
    kek = _kdf(passphrase, salt, KDF_PARAMS)
    return SNAPSHOT_ENCRYPTED + salt + _seal(kek, data, b"tgdrive/snapshot")


def open_snapshot(blob: bytes, passphrase: str | None) -> bytes:
    magic, body = blob[:4], blob[4:]
    if magic == SNAPSHOT_PLAIN:
        return body
    if magic == SNAPSHOT_ENCRYPTED:
        if not passphrase:
            raise BadKey("snapshot is encrypted; set TGDRIVE_BACKUP_PASSPHRASE")
        kek = _kdf(passphrase, body[:SALT_LEN], KDF_PARAMS)
        return _open(kek, body[SALT_LEN:], b"tgdrive/snapshot")
    raise ValueError("not a tgdrive snapshot")
