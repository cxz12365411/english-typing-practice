from __future__ import annotations

import hashlib
import os
import pathlib
import re
import shutil
import sqlite3
import subprocess
import tempfile
import unittest


DEPLOY = pathlib.Path(__file__).resolve().parents[1]


def find_bash() -> str | None:
    if os.name == "nt":
        # Prefer Git Bash: the Windows system32 bash.exe is a WSL launcher.
        git = shutil.which("git")
        if git:
            candidate = pathlib.Path(git).resolve().parents[1] / "bin" / "bash.exe"
            if candidate.is_file():
                return str(candidate)
        return None
    return shutil.which("bash")


BASH = find_bash()


class DeploymentRegressionTests(unittest.TestCase):
    @unittest.skipUnless(BASH, "Bash is required for deployment parser tests")
    def test_email_limit_parser_rejects_integer_overflow(self) -> None:
        check = (DEPLOY / "scripts" / "check-email-config.sh").read_text(encoding="utf-8")
        match = re.search(r"^parse_email_limit\(\) \{\n.*?^\}", check, re.M | re.S)
        self.assertIsNotNone(match)
        assert match is not None
        script = (
            "set -euo pipefail\n"
            'die() { printf "%s\\n" "$*" >&2; exit 1; }\n'
            + match.group(0)
            + '\nparse_email_limit "$1" "$2" EMAIL_LIMIT "out of range"\n'
        )

        for value, maximum, expected in (
            ("1", 10000, "1"),
            ("10000", 10000, "10000"),
            ("000180", 10000, "180"),
            ("08", 20, "8"),
            ("20", 20, "20"),
            ("21", 20, None),
            ("0", 10000, None),
            ("0000", 10000, None),
            ("10001", 10000, None),
            ("18446744073709551796", 10000, None),
            ("18446744073709551636", 180, None),
            ("18446744073709551626", 20, None),
            ("9" * 200, 10000, None),
            ("-1", 10000, None),
            ("1e2", 10000, None),
            ("", 10000, None),
        ):
            with self.subTest(value=value, maximum=maximum):
                result = subprocess.run(
                    [BASH, "-c", script, "email-limit-test", value, str(maximum)],
                    text=True,
                    capture_output=True,
                    timeout=10,
                    check=False,
                )
                if expected is None:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(result.stdout, "")
                else:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stdout.strip(), expected)

    @unittest.skipUnless(BASH, "Bash is required for deployment syntax checks")
    def test_shell_scripts_parse(self) -> None:
        for script in sorted((DEPLOY / "scripts").glob("*.sh")):
            with self.subTest(script=script.name):
                result = subprocess.run(
                    [BASH, "-n", script.as_posix()],
                    text=True,
                    capture_output=True,
                    timeout=10,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_snapshot_reads_and_copy_do_not_create_source_sidecars(self) -> None:
        restore = (DEPLOY / "scripts" / "restore-sqlite.sh").read_text(encoding="utf-8")
        rollback = (DEPLOY / "scripts" / "rollback-release.sh").read_text(encoding="utf-8")
        for name in ("backup_path", "locked_backup_path", "restored_temp"):
            self.assertIn(f'"file:${{{name}}}?immutable=1"', restore)
        self.assertIn('"file:${database_before}?immutable=1"', rollback)
        self.assertNotRegex(restore, r'sqlite3 -readonly "\$(?:backup_path|locked_backup_path|restored_temp)"')

        with tempfile.TemporaryDirectory(prefix="englishapp-backup-test-") as directory:
            source = pathlib.Path(directory) / "snapshot.sqlite3"
            copy = pathlib.Path(directory) / "restored.sqlite3"
            database = sqlite3.connect(source)
            try:
                database.execute("PRAGMA journal_mode=WAL")
                database.execute("CREATE TABLE samples (value INTEGER PRIMARY KEY)")
                database.execute("INSERT INTO samples VALUES (42)")
                database.commit()
            finally:
                database.close()
            self.assertEqual(source.read_bytes()[18:20], b"\x02\x02")
            digest = hashlib.sha256(source.read_bytes()).digest()

            snapshot = sqlite3.connect(source.as_uri() + "?immutable=1", uri=True)
            restored = sqlite3.connect(copy)
            try:
                self.assertEqual(snapshot.execute("PRAGMA integrity_check").fetchone(), ("ok",))
                self.assertEqual(snapshot.execute("PRAGMA foreign_key_check").fetchall(), [])
                snapshot.backup(restored)
                self.assertEqual(restored.execute("SELECT value FROM samples").fetchall(), [(42,)])
                for suffix in ("-wal", "-shm"):
                    self.assertFalse(pathlib.Path(str(source) + suffix).exists())
            finally:
                restored.close()
                snapshot.close()
            self.assertEqual(hashlib.sha256(source.read_bytes()).digest(), digest)

    def test_restore_completion_follows_commit_and_trap_disarm(self) -> None:
        restore = (DEPLOY / "scripts" / "restore-sqlite.sh").read_text(encoding="utf-8")
        committed = restore.index("restore_committed=1")
        trap_off = restore.index("trap - EXIT HUP INT TERM", committed)
        temporary_marker = restore.index('restore_complete_temp="$(/usr/bin/mktemp', trap_off)
        final_marker = restore.index('"${quarantine_dir}/restore-complete"', temporary_marker)
        self.assertLess(committed, trap_off)
        self.assertLess(trap_off, temporary_marker)
        self.assertLess(temporary_marker, final_marker)
        self.assertNotIn('"${quarantine_dir}/restore-complete"', restore[:committed])

    def test_successful_backup_and_restore_clean_temporary_sidecars(self) -> None:
        backup = (DEPLOY / "scripts" / "backup-sqlite.sh").read_text(encoding="utf-8")
        restore = (DEPLOY / "scripts" / "restore-sqlite.sh").read_text(encoding="utf-8")
        self.assertIn('cleanup\ntrap - EXIT\nprintf', backup)
        self.assertIn('"${restored_temp}-wal" "${restored_temp}-shm"', restore)


if __name__ == "__main__":
    unittest.main()
