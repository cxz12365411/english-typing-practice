#!/usr/bin/env python3
"""Refuse a database rewind that would change recorded live payment ownership.

The caller must stop the API and hold both deployment and database locks until
the restore completes. This helper never writes either input. It reads a private
copy of the current database plus its WAL, so crash-left WAL transactions count
without SQLite creating or changing sidecars beside the live database.
"""
from __future__ import annotations

import contextlib
import pathlib
import shutil
import sqlite3
import stat
import sys
import tempfile


class UnsafeRestore(Exception):
    pass


IDENTITY_COLUMNS = (
    "id", "username", "password_hash", "role", "active", "must_change_password",
    "created_at", "auth_version", "email", "email_verified_at",
)
ORDER_COLUMNS = {
    "id", "user_id", "provider_mode", "app_id", "seller_id", "status", "amount_fen",
    "duration_days", "created_at", "expires_at", "paid_at", "provider_trade_no",
    "credited_until", "last_checked_at", "updated_at",
}
MEMBERSHIP_COLUMNS = {
    "user_id", "access_kind", "trial_started_at", "trial_ends_at", "paid_until", "updated_at",
}


def file_identity(path: pathlib.Path, *, optional: bool = False) -> tuple[int, ...] | None:
    if not path.is_absolute():
        raise UnsafeRestore("database inputs must use absolute paths")
    try:
        info = path.lstat()
    except FileNotFoundError:
        if optional:
            return None
        raise UnsafeRestore("a required database file is missing") from None
    if not stat.S_ISREG(info.st_mode):
        raise UnsafeRestore("database inputs must be absolute regular, non-symlink files")
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


def has_table(db: sqlite3.Connection, name: str) -> bool:
    return db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)).fetchone() is not None


def live_orders(db: sqlite3.Connection) -> dict[str, dict]:
    if not has_table(db, "payment_orders"):
        return {}
    rows = db.execute("SELECT * FROM payment_orders WHERE provider_mode = 'live'").fetchall()
    orders = {}
    for row in rows:
        value = dict(row)
        if not ORDER_COLUMNS.issubset(value) or not value["id"] or value["id"] in orders:
            raise UnsafeRestore("live payment metadata is incomplete")
        orders[value["id"]] = value
    return orders


def related_record(db: sqlite3.Connection, table: str, key: str, user_id: str) -> dict:
    if not has_table(db, table):
        raise UnsafeRestore("a live payment owner or membership record is missing")
    rows = db.execute(f'SELECT * FROM "{table}" WHERE "{key}" = ?', (user_id,)).fetchall()
    if len(rows) != 1:
        raise UnsafeRestore("a live payment owner or membership record is missing")
    value = dict(rows[0])
    required = IDENTITY_COLUMNS if table == "users" else MEMBERSHIP_COLUMNS
    if not set(required).issubset(value):
        raise UnsafeRestore("live payment ownership metadata is incomplete")
    if table == "users":
        # Login timestamps and cosmetic display names are not payment identity.
        return {column: value[column] for column in IDENTITY_COLUMNS}
    return value


def compare_snapshots(current: sqlite3.Connection, target: sqlite3.Connection | None) -> None:
    current_orders = live_orders(current)
    if not current_orders:
        return  # Legacy databases and sandbox-only development remain recoverable.
    if target is None:
        raise UnsafeRestore("live payment orders exist; refusing to remove the database")
    if current_orders != live_orders(target):
        raise UnsafeRestore("live payment orders differ from the backup (including pending orders)")
    for user_id in {row["user_id"] for row in current_orders.values()}:
        for table, key in (("users", "id"), ("user_memberships", "user_id")):
            if related_record(current, table, key, user_id) != related_record(target, table, key, user_id):
                raise UnsafeRestore("live payment membership or account identity differs from the backup")


def check_restore(current_path: pathlib.Path, target_path: pathlib.Path | None) -> None:
    current_identity = file_identity(current_path, optional=True)
    wal_path = pathlib.Path(str(current_path) + "-wal")
    wal_identity = file_identity(wal_path, optional=True)
    if current_identity is None:
        if wal_identity is not None:
            raise UnsafeRestore("an orphan current database WAL requires manual recovery")
        return
    if target_path is not None:
        target_identity = file_identity(target_path)

    with tempfile.TemporaryDirectory(prefix="englishapp-payment-restore-") as directory, contextlib.ExitStack() as stack:
        private_path = pathlib.Path(directory) / "current.sqlite3"
        shutil.copyfile(current_path, private_path)
        if wal_identity is not None:
            shutil.copyfile(wal_path, pathlib.Path(str(private_path) + "-wal"))
        if (file_identity(current_path) != current_identity or
                file_identity(wal_path, optional=True) != wal_identity):
            raise UnsafeRestore("the current database changed while being checked")
        current = stack.enter_context(contextlib.closing(sqlite3.connect(private_path.as_uri() + "?mode=ro", uri=True)))
        current.row_factory = sqlite3.Row
        current.execute("PRAGMA query_only = ON")
        target = None
        if target_path is not None:
            # Managed backups are complete closed snapshots; immutable avoids
            # sidecar writes beside them and must never be used on current+WAL.
            target = stack.enter_context(contextlib.closing(sqlite3.connect(target_path.as_uri() + "?mode=ro&immutable=1", uri=True)))
            target.row_factory = sqlite3.Row
            target.execute("PRAGMA query_only = ON")
        compare_snapshots(current, target)
        if (file_identity(current_path) != current_identity or
                file_identity(wal_path, optional=True) != wal_identity):
            raise UnsafeRestore("the current database changed while being checked")
        if target_path is not None and file_identity(target_path) != target_identity:
            raise UnsafeRestore("the backup changed while being checked")


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: check-payment-restore.py <current.db> <backup.sqlite3|NO_DATABASE>", file=sys.stderr)
        return 2
    try:
        check_restore(pathlib.Path(sys.argv[1]), None if sys.argv[2] == "NO_DATABASE" else pathlib.Path(sys.argv[2]))
    except (UnsafeRestore, OSError, sqlite3.Error) as error:
        reason = str(error) if isinstance(error, UnsafeRestore) else "database inputs could not be safely read"
        print(f"[englishapp-payment-restore] REFUSED: {reason}. Keep the current database; reconcile payments manually before any rewind.", file=sys.stderr)
        return 1
    print("[englishapp-payment-restore] live payment history and ownership are preserved", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
