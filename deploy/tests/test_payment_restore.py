from __future__ import annotations

import hashlib
import contextlib
import pathlib
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest


DEPLOY = pathlib.Path(__file__).resolve().parents[1]
HELPER = DEPLOY / "scripts" / "check-payment-restore.py"
SCHEMA = """
CREATE TABLE users (
 id TEXT PRIMARY KEY, username TEXT, password_hash TEXT, role TEXT, active INTEGER,
 must_change_password INTEGER, created_at INTEGER, auth_version INTEGER,
 email TEXT, email_verified_at INTEGER, display_name TEXT, updated_at INTEGER, last_login_at INTEGER
);
CREATE TABLE user_memberships (
 user_id TEXT PRIMARY KEY, access_kind TEXT, trial_started_at INTEGER,
 trial_ends_at INTEGER, paid_until INTEGER, updated_at INTEGER
);
CREATE TABLE payment_orders (
 id TEXT PRIMARY KEY, user_id TEXT, amount_fen INTEGER, duration_days INTEGER,
 provider_mode TEXT, app_id TEXT, seller_id TEXT, status TEXT, created_at INTEGER,
 expires_at INTEGER, paid_at INTEGER, provider_trade_no TEXT, credited_until INTEGER,
 last_checked_at INTEGER, updated_at INTEGER
);
INSERT INTO users VALUES ('u1','student','hashed','user',1,0,100,1,'student@example.test',100,'Student',100,100);
INSERT INTO user_memberships VALUES ('u1','metered',100,86400100,2678400100,100);
"""


@contextlib.contextmanager
def database(path: pathlib.Path):
    db = sqlite3.connect(path)
    try:
        with db:
            yield db
    finally:
        db.close()


class PaymentRestoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="payment-restore-test-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = pathlib.Path(self.temporary.name)
        self.current = self.directory / "app.db"
        self.backup = self.directory / "backup.sqlite3"
        with database(self.current) as db:
            db.executescript(SCHEMA)

    def change(self, query: str, parameters: tuple = ()) -> None:
        with database(self.current) as db:
            db.execute(query, parameters)

    def order(self, *, mode: str = "live", status: str = "pending", order_id: str = "order1") -> None:
        self.change("INSERT INTO payment_orders VALUES (?,?,100,30,?,'app','seller',?,100,200,?,?,?,150,150)",
                    (order_id, "u1", mode, status, 150 if status == "paid" else None,
                     "trade-" + order_id if status == "paid" else None,
                     2678400100 if status == "paid" else None))

    def snapshot(self) -> None:
        with database(self.current) as source, database(self.backup) as target:
            source.backup(target)

    def run_check(self, target: pathlib.Path | str | None = None) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, str(HELPER), str(self.current), str(target or self.backup)],
                              text=True, capture_output=True, timeout=10, check=False)

    def assert_allowed(self, target: pathlib.Path | str | None = None) -> None:
        result = self.run_check(target)
        self.assertEqual(result.returncode, 0, result.stderr)

    def assert_refused(self, target: pathlib.Path | str | None = None) -> None:
        result = self.run_check(target)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("REFUSED", result.stderr)
        self.assertNotIn("student@example.test", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_legacy_no_live_orders_and_first_install_remain_recoverable(self) -> None:
        self.order(mode="sandbox", status="paid")
        self.order(mode="test", status="pending", order_id="test-order")
        with database(self.backup) as db:
            db.execute("CREATE TABLE legacy (id INTEGER)")
        self.assert_allowed()
        self.assert_allowed("NO_DATABASE")
        self.current.unlink()
        self.assert_allowed("NO_DATABASE")
        with database(self.current) as db:
            db.execute("CREATE TABLE legacy (id INTEGER)")
        self.assert_allowed()

    def test_exact_snapshot_preserves_pending_paid_and_closed_orders_without_writes(self) -> None:
        for status in ("pending", "paid", "closed"):
            self.order(status=status, order_id=status)
        self.snapshot()
        before = {path.name: hashlib.sha256(path.read_bytes()).digest() for path in self.directory.iterdir()}
        self.assert_allowed()
        after = {path.name: hashlib.sha256(path.read_bytes()).digest() for path in self.directory.iterdir()}
        self.assertEqual(before, after)

    def test_any_new_live_order_blocks_old_and_no_database_targets(self) -> None:
        for status in ("pending", "paid", "closed"):
            with self.subTest(status=status):
                self.change("DELETE FROM payment_orders")
                self.snapshot()
                self.order(status=status)
                self.assert_refused()
                self.assert_refused("NO_DATABASE")

    def test_existing_order_changes_are_not_rolled_back(self) -> None:
        self.order()
        self.snapshot()
        changes = (
            ("status", "paid"), ("provider_trade_no", "received-trade"),
            ("credited_until", 3000000000), ("amount_fen", 1), ("duration_days", 60),
            ("seller_id", "other-seller"), ("app_id", "other-app"),
            ("last_checked_at", 151), ("expires_at", 250),
        )
        for column, value in changes:
            with self.subTest(column=column):
                shutil.copyfile(self.backup, self.current)
                self.change(f'UPDATE payment_orders SET "{column}" = ?', (value,))
                self.assert_refused()

    def test_owner_and_entitlements_cannot_be_reassigned_or_rewound(self) -> None:
        self.order(status="paid")
        self.snapshot()
        changes = (
            ("user_memberships", "paid_until", 4000000000),
            ("user_memberships", "trial_ends_at", 90000000),
            ("user_memberships", "access_kind", "legacy_free"),
            ("users", "email", "new@example.test"),
            ("users", "username", "new-owner"), ("users", "password_hash", "reset-hash"),
            ("users", "role", "admin"), ("users", "active", 0),
            ("users", "auth_version", 2), ("users", "email_verified_at", 200),
        )
        for table, column, value in changes:
            with self.subTest(table=table, column=column):
                shutil.copyfile(self.backup, self.current)
                self.change(f'UPDATE "{table}" SET "{column}" = ?', (value,))
                self.assert_refused()
        for table in ("users", "user_memberships"):
            with self.subTest(missing_table=table):
                shutil.copyfile(self.backup, self.current)
                self.change(f'DROP TABLE "{table}"')
                self.assert_refused()

    def test_cosmetic_profile_and_login_timestamps_are_not_payment_identity(self) -> None:
        self.order(status="paid")
        self.snapshot()
        self.change("UPDATE users SET display_name='New display', last_login_at=999, updated_at=999")
        self.assert_allowed()

    def test_uncheckpointed_wal_payment_is_seen_without_modifying_input_sidecars(self) -> None:
        self.snapshot()
        db = sqlite3.connect(self.current)
        self.addCleanup(db.close)
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA wal_autocheckpoint=0")
        db.execute("INSERT INTO payment_orders VALUES ('wal-order','u1',100,30,'live','app','seller','pending',100,200,NULL,NULL,NULL,NULL,100)")
        db.commit()
        before = {path.name: hashlib.sha256(path.read_bytes()).digest() for path in self.directory.iterdir()}
        self.assert_refused()
        after = {path.name: hashlib.sha256(path.read_bytes()).digest() for path in self.directory.iterdir()}
        self.assertEqual(before, after)
        with database(self.backup) as target:
            db.backup(target)
        self.assert_allowed()

    def test_old_backup_missing_payment_tables_is_rejected_when_live_orders_exist(self) -> None:
        self.order()
        with database(self.backup) as db:
            db.execute("CREATE TABLE legacy (id INTEGER)")
        self.assert_refused()

    def test_unsafe_paths_and_corrupt_data_fail_closed(self) -> None:
        self.order()
        self.snapshot()
        linked = self.directory / "linked.sqlite3"
        linked.symlink_to(self.backup)
        self.assert_refused(linked)
        self.backup.write_bytes(b"not a database")
        self.assert_refused()
        self.current.unlink()
        pathlib.Path(str(self.current) + "-wal").write_bytes(b"orphan WAL")
        self.assert_refused("NO_DATABASE")

    def test_shell_guards_run_after_stop_under_lock_before_any_switch(self) -> None:
        restore = (DEPLOY / "scripts" / "restore-sqlite.sh").read_text()
        trap = restore.index("trap on_exit EXIT")
        stop = restore.index('/usr/bin/systemctl stop "$SERVICE_NAME"', trap)
        check = restore.index('/usr/bin/python3 "$PAYMENT_RESTORE_CHECK" "$DATABASE_PATH" "$locked_backup_path"', stop)
        self.assertLess(restore.index('/usr/bin/flock -w 60 9'), stop)
        self.assertLess(check, restore.index("mutation_started=1", check))
        self.assertLess(check, restore.index('restored_temp="$(/usr/bin/mktemp', check))
        self.assertIn('"$DATABASE_PATH" "$previous_payment_snapshot" || return 1', restore)
        rollback = (DEPLOY / "scripts" / "rollback-release.sh").read_text()
        trap = rollback.index("trap on_exit EXIT")
        stop = rollback.index('/usr/bin/systemctl stop "$SERVICE_NAME"', trap)
        lock = rollback.index('/usr/bin/flock -w 60 8', stop)
        check = rollback.index('"$PAYMENT_RESTORE_CHECK" "$DATABASE_PATH" "$database_before"', lock)
        self.assertLess(stop, lock)
        self.assertLess(lock, check)
        self.assertLess(check, rollback.index("transaction_armed=1", check))
        self.assertLess(check, rollback.index('set_current_target "$previous_target"', check))
        self.assertIn('if [[ "$restore_database" -eq 1 ]]; then\n  /usr/bin/python3', rollback)
        self.assertIn('ETP_DEPLOY_LOCK_HELD=1 ETP_DATABASE_LOCK_HELD=1', rollback)
        recovery = rollback[rollback.index("recover_entry_state() {"):rollback.index("on_exit() {")]
        self.assertLess(recovery.index('"$DATABASE_PATH" "$entry_database_backup"'), recovery.index("set_current_target"))
        self.assertIn('if [[ "$restore_database" -eq 1 ]]; then', recovery)


if __name__ == "__main__":
    unittest.main()
