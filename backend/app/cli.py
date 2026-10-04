"""Command-line access to the storage core.

    python -m app.cli init                              (first run: set the master password)
    python -m app.cli change-master-password
    python -m app.cli reset-master-password             (uses the master recovery key)
    python -m app.cli create-drive NAME [--no-password]
    python -m app.cli drives
    python -m app.cli put DRIVE PATH [--as NAME]
    python -m app.cli ls DRIVE
    python -m app.cli get DRIVE NAME OUT
    python -m app.cli rm DRIVE NAME
    python -m app.cli drive-password DRIVE [--remove]   (add, change or remove a drive's password)
    python -m app.cli reset-password DRIVE              (uses the drive's recovery key)
    python -m app.cli rm-drive DRIVE
    python -m app.cli backup
    python -m app.cli restore [--overwrite]

The master password is read from TGDRIVE_MASTER_PASSWORD if set, a drive
password from TGDRIVE_PASSWORD; otherwise both are prompted for.
"""
from __future__ import annotations

import argparse
import asyncio
import getpass
import os
import sys

from . import crypto, db
from .config import Config
from .storage import Drive, NoVault, Storage, StorageError, iter_file, restore_database


def _password(prompt: str = "Drive password: ", env: str = "TGDRIVE_PASSWORD") -> str:
    return os.environ.get(env) or getpass.getpass(prompt)


def _new_password(prompt: str = "New password: ") -> str:
    if os.environ.get("TGDRIVE_NEW_PASSWORD"):
        return os.environ["TGDRIVE_NEW_PASSWORD"]
    a = getpass.getpass(prompt)
    if a != getpass.getpass("Repeat: "):
        raise SystemExit("passwords do not match")
    if len(a) < 8:
        raise SystemExit("use at least 8 characters")
    return a


def _show_recovery(what: str, key: str) -> None:
    print(f"RECOVERY KEY for {what} (shown once, store it somewhere safe):")
    print(f"  {key}")


async def _unlock_vault(store: Storage) -> crypto.VaultKeys:
    return await store.unlock_vault(_password("Master password: ", "TGDRIVE_MASTER_PASSWORD"))


async def _open(store: Storage, vault: crypto.VaultKeys, name: str) -> Drive:
    if store.drive_info(name).protected:
        return await store.unlock(vault, name, _password())
    return store.open_drive(vault, name)


async def run(args: argparse.Namespace) -> None:
    cfg = Config.from_env()
    transport = cfg.make_transport()
    try:
        if args.cmd == "restore":
            os.makedirs(os.path.dirname(os.path.abspath(cfg.db_path)), exist_ok=True)
            await restore_database(transport, cfg.db_path, cfg.backup_passphrase, args.overwrite)
            print(f"restored {cfg.db_path}")
            return

        os.makedirs(os.path.dirname(os.path.abspath(cfg.db_path)), exist_ok=True)
        store = Storage(db.connect(cfg.db_path), transport,
                        backup_passphrase=cfg.backup_passphrase, thumb_dir=cfg.thumb_dir)

        if args.cmd == "init":
            if store.vault_exists():
                raise SystemExit("tgdrive is already set up")
            _, recovery = await store.setup_vault(_new_password("Master password: "))
            print("master password set\n")
            _show_recovery("the master password", recovery)
            await store.backup()
            return
        if args.cmd == "backup":
            print(f"snapshot stored ({await store.backup()} bytes)")
            return
        if args.cmd == "reset-master-password":
            vault = store.unlock_vault_with_recovery(_password("Master recovery key: ", "TGDRIVE_RECOVERY_KEY"))
            await store.set_vault_password(vault, _new_password("New master password: "))
            await store.backup()
            print("master password updated")
            return

        vault = await _unlock_vault(store)
        if args.cmd == "change-master-password":
            await store.set_vault_password(vault, _new_password("New master password: "))
            await store.backup()
            print("master password updated")
        elif args.cmd == "drives":
            for d in store.list_drives():
                print(f"{'password' if d.protected else 'open':8}  {d.name}")
        elif args.cmd == "create-drive":
            password = None if args.no_password else _new_password("Drive password: ")
            _, recovery = await store.create_drive(vault, args.name, password)
            print(f"created drive '{args.name}'\n")
            if recovery:
                _show_recovery(f"drive '{args.name}'", recovery)
            await store.backup()
        elif args.cmd == "reset-password":
            drive = store.unlock_with_recovery(args.drive, _password("Recovery key: ", "TGDRIVE_RECOVERY_KEY"))
            await store.set_password(vault, drive, _new_password())
            await store.backup()
            print("password updated")
        elif args.cmd == "drive-password":
            drive = await _open(store, vault, args.drive)
            recovery = await store.set_password(vault, drive, None if args.remove else _new_password())
            await store.backup()
            print("password removed" if args.remove else "password set")
            if recovery:
                _show_recovery(f"drive '{args.drive}'", recovery)
        else:
            drive = await _open(store, vault, args.drive)
            if args.cmd == "ls":
                for e in store.list(drive):
                    print(f"{e.kind:4} {e.size:>14,}  {e.name}")
            elif args.cmd == "put":
                name = args.name or os.path.basename(args.path)
                await store.upload(drive, None, name, iter_file(args.path))
                await store.backup()
                print(f"stored {name}")
            elif args.cmd in ("get", "rm"):
                entry = store.find(drive, None, args.name)
                if entry is None:
                    raise StorageError(f"not found: {args.name}")
                if args.cmd == "get":
                    with open(args.out, "wb") as f:
                        async for data in store.download(drive, entry.id):
                            f.write(data)
                    print(f"wrote {args.out}")
                else:
                    await store.delete(drive, entry.id)
                    await store.backup()
                    print(f"deleted {args.name}")
            elif args.cmd == "rm-drive":
                await store.delete_drive(drive)
                await store.backup()
                print(f"deleted drive '{args.drive}'")
    finally:
        await transport.close()


def main() -> None:
    p = argparse.ArgumentParser(prog="tgdrive")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init")
    sub.add_parser("change-master-password")
    sub.add_parser("reset-master-password")
    sub.add_parser("drives")
    s = sub.add_parser("create-drive"); s.add_argument("name"); s.add_argument("--no-password", action="store_true")
    sub.add_parser("reset-password").add_argument("drive")
    s = sub.add_parser("drive-password"); s.add_argument("drive"); s.add_argument("--remove", action="store_true")
    sub.add_parser("backup")
    sub.add_parser("restore").add_argument("--overwrite", action="store_true")
    sub.add_parser("ls").add_argument("drive")
    sub.add_parser("rm-drive").add_argument("drive")
    s = sub.add_parser("put"); s.add_argument("drive"); s.add_argument("path"); s.add_argument("--as", dest="name")
    s = sub.add_parser("get"); s.add_argument("drive"); s.add_argument("name"); s.add_argument("out")
    s = sub.add_parser("rm"); s.add_argument("drive"); s.add_argument("name")
    try:
        asyncio.run(run(p.parse_args()))
    except crypto.BadKey:
        sys.exit("wrong password or key")
    except NoVault:
        sys.exit("tgdrive is not set up yet: run `python -m app.cli init`")
    except (StorageError, FileExistsError) as e:
        sys.exit(str(e))


if __name__ == "__main__":
    main()
