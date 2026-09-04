from __future__ import annotations

import pathlib
import py_compile
import importlib.util
import unittest


DEPLOY = pathlib.Path(__file__).resolve().parents[1]


class DeploymentAssetTests(unittest.TestCase):
    def test_every_shell_script_uses_strict_mode(self) -> None:
        scripts = sorted((DEPLOY / "scripts").glob("*.sh"))
        self.assertGreaterEqual(len(scripts), 10)
        for script in scripts:
            lines = script.read_text(encoding="utf-8").splitlines()
            self.assertEqual(lines[0], "#!/usr/bin/env bash", script.name)
            self.assertEqual(lines[1], "set -euo pipefail", script.name)

    def test_python_caddy_rewriter_compiles(self) -> None:
        rewriter_path = DEPLOY / "scripts" / "rewrite-caddy.py"
        py_compile.compile(str(rewriter_path), doraise=True)
        spec = importlib.util.spec_from_file_location("rewrite_caddy", rewriter_path)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        original = """robot-47-120-37-63.sslip.io {
    reverse_proxy 127.0.0.1:3000
}

english-47-120-37-63.sslip.io {
    root * /var/www/english-typing-practice/current
    try_files {path} /index.html
    header {
        X-Test \"literal { brace }\"
    }
}
"""
        rewritten = module.rewrite(original.splitlines(keepends=True))
        self.assertIn("robot-47-120-37-63.sslip.io", rewritten)
        self.assertIn("reverse_proxy 127.0.0.1:3000", rewritten)
        self.assertNotIn("english-47-120-37-63.sslip.io", rewritten)

        shared = "english-47-120-37-63.sslip.io, example.com {\n}\n"
        with self.assertRaises(module.RewriteError):
            module.rewrite(shared.splitlines(keepends=True))

    def test_service_security_and_runtime_contract(self) -> None:
        service = (DEPLOY / "systemd" / "englishapp.service").read_text(encoding="utf-8")
        for required in (
            "User=englishapp",
            "Group=englishapp",
            "WorkingDirectory=/opt/english-typing-practice/current/server",
            "EnvironmentFile=/etc/english-typing-practice/env",
            "ExecStart=/usr/bin/node dist/index.js",
            "MemoryMax=384M",
            "ProtectSystem=strict",
            "ReadWritePaths=/var/lib/english-typing-practice",
        ):
            self.assertIn(required, service)
        backup_service = (DEPLOY / "systemd" / "englishapp-backup@.service").read_text(encoding="utf-8")
        self.assertIn("/var/lib/english-typing-practice-locks/database.lock", backup_service)
        env_example = (DEPLOY / "env.example").read_text(encoding="utf-8")
        self.assertIn("TRUST_PROXY=loopback", env_example)
        self.assertNotIn("TRUST_PROXY=true", env_example)
        self.assertIn("GUEST_TOKEN_SECRET=__GENERATED_BY_PROVISION_HOST__", env_example)

    def test_caddy_routes_api_without_stripping_prefix(self) -> None:
        caddy = (DEPLOY / "caddy" / "english-typing-practice.caddy").read_text(encoding="utf-8")
        self.assertIn("@api path /api /api/*", caddy)
        self.assertIn("reverse_proxy 127.0.0.1:8091", caddy)
        self.assertNotIn("handle_path /api", caddy)
        self.assertIn("/opt/english-typing-practice/current/web/dist", caddy)
        self.assertIn("Content-Security-Policy", caddy)
        self.assertIn('Content-Type "application/manifest+json; charset=utf-8"', caddy)
        self.assertIn("\tlog\n", caddy)
        self.assertNotIn("output file", caddy)

    def test_retention_contract(self) -> None:
        backup = (DEPLOY / "scripts" / "backup-sqlite.sh").read_text(encoding="utf-8")
        self.assertIn("daily) readonly retention=7", backup)
        self.assertIn("weekly) readonly retention=4", backup)
        self.assertIn(".backup", backup)
        self.assertIn("PRAGMA integrity_check", backup)
        self.assertIn("?immutable=1", backup)
        self.assertIn('"${temporary}-wal" "${temporary}-shm"', backup)
        self.assertIn("database-before", backup)
        self.assertIn("rollback-entry-database", backup)
        self.assertIn('"$backup_class" == "pre-restore"', backup)
        self.assertIn("retaining deployment-referenced snapshot", backup)

    def test_runtime_and_web_filesystem_identities_are_separate(self) -> None:
        provision = (DEPLOY / "scripts" / "provision-host.sh").read_text(encoding="utf-8")
        deploy = (DEPLOY / "scripts" / "deploy-release.sh").read_text(encoding="utf-8")
        self.assertIn('readonly BUILD_USER="englishbuild"', provision)
        self.assertIn('readonly WEB_USER="caddy"', provision)
        self.assertIn('0755 -o root -g root "$APP_ROOT" "${APP_ROOT}/releases"', provision)
        self.assertIn("Caddy must not belong to the API runtime group", provision)
        self.assertIn('readonly DEPLOYMENT_ROOT="/var/lib/english-typing-practice-deployments"', provision)
        self.assertIn('readonly LOCK_ROOT="/var/lib/english-typing-practice-locks"', provision)
        self.assertIn('0750 -o root -g "$APP_GROUP" "$BACKUP_ROOT"', provision)
        self.assertIn("TRUST_PROXY=true", provision)
        self.assertIn("TRUST_PROXY=loopback", provision)
        self.assertIn("env.before-loopback-migration", provision)
        self.assertIn("env.before-guest-secret", provision)
        self.assertIn("generated a persistent guest CSRF signing secret", provision)
        self.assertIn("require_env_value TRUST_PROXY loopback", deploy)
        self.assertIn("environment must define GUEST_TOKEN_SECRET exactly once", deploy)
        self.assertIn("database ownership or mode is not englishapp:englishapp 0600", deploy)
        self.assertIn('/usr/bin/chown -R root:englishapp "$staging_dir/server"', deploy)
        self.assertIn('/usr/bin/chown -R root:caddy "$staging_dir/web"', deploy)
        self.assertIn('/usr/bin/chmod 0755 "$staging_dir"', deploy)
        self.assertIn('/usr/bin/chmod 0750 {} +', deploy)
        self.assertIn('/usr/bin/chmod 0640 {} +', deploy)
        self.assertIn("Caddy unexpectedly reads API server code", deploy)
        self.assertIn("Caddy unexpectedly reads the application environment", deploy)
        self.assertIn("Caddy unexpectedly traverses persistent application data", deploy)
        self.assertIn("API account unexpectedly reads Caddy-only Web assets", deploy)

    def test_build_executes_npm_as_unprivileged_user(self) -> None:
        stage = (DEPLOY / "scripts" / "stage-release.sh").read_text(encoding="utf-8")
        self.assertIn('readonly RUNUSER="$(command -v runuser || true)"', stage)
        self.assertIn('"$RUNUSER" --user "$BUILD_USER" -- /bin/bash -c', stage)
        self.assertNotIn("/usr/bin/runuser", stage)
        runuser_index = stage.index('"$RUNUSER" --user "$BUILD_USER" -- /bin/bash -c')
        self.assertGreater(stage.index("/usr/bin/npm ci", runuser_index), runuser_index)
        self.assertGreater(stage.index("/usr/bin/npm run build", runuser_index), runuser_index)
        self.assertGreater(stage.index("/usr/bin/npm prune", runuser_index), runuser_index)

    def test_deploy_is_recoverable_before_service_stop(self) -> None:
        deploy = (DEPLOY / "scripts" / "deploy-release.sh").read_text(encoding="utf-8")
        state_index = deploy.index('/usr/bin/install -d -m 0700 -o root -g root "$state_dir"')
        robot_index = deploy.index('robot-regression.sh" capture')
        restart_arm_index = deploy.index("restart_old_service_armed=1", robot_index)
        stop_index = deploy.index('/usr/bin/systemctl stop "$SERVICE_NAME"', restart_arm_index)
        backup_index = deploy.index('backup-sqlite.sh" pre-migration')
        armed_index = deploy.index("rollback_armed=1")
        self.assertLess(state_index, robot_index)
        self.assertLess(robot_index, restart_arm_index)
        self.assertLess(restart_arm_index, stop_index)
        self.assertLess(stop_index, backup_index)
        self.assertLess(backup_index, armed_index)
        self.assertIn("trap on_exit EXIT", deploy)
        self.assertIn("restarting the unchanged old API", deploy)
        self.assertIn("ETP_EXPECT_ROLE=admin", deploy)
        self.assertIn("ETP_EXPECT_MUST_CHANGE=true", deploy)
        self.assertLess(deploy.index("ETP_EXPECT_ROLE=admin"), deploy.index("INITIAL_ADMIN_TEMP_PASSWORD"))

    def test_restore_locks_records_state_and_revalidates_before_mutation(self) -> None:
        restore = (DEPLOY / "scripts" / "restore-sqlite.sh").read_text(encoding="utf-8")
        lock_index = restore.index('/usr/bin/flock -w 60 9')
        state_index = restore.index('service-was-active')
        trap_index = restore.index("trap on_exit EXIT")
        stop_index = restore.index('/usr/bin/systemctl stop "$SERVICE_NAME"', trap_index)
        second_validation = restore.index('locked_backup_path=', stop_index)
        mutation_index = restore.index("mutation_started=1", second_validation)
        self.assertLess(lock_index, state_index)
        self.assertLess(state_index, trap_index)
        self.assertLess(trap_index, stop_index)
        self.assertLess(stop_index, second_validation)
        self.assertLess(second_validation, mutation_index)
        self.assertGreaterEqual(restore.count("/usr/bin/sqlite3 -readonly"), 3)
        self.assertIn('sqlite3 -readonly "$locked_backup_path" ".backup', restore)
        self.assertIn("reinstate_previous_database", restore)

    def test_caddy_changes_are_atomic_metadata_preserving_and_recoverable(self) -> None:
        activate = (DEPLOY / "scripts" / "activate-caddy-site.sh").read_text(encoding="utf-8")
        restore = (DEPLOY / "scripts" / "restore-caddy-state.sh").read_text(encoding="utf-8")
        for script in (activate, restore):
            self.assertIn("/etc/caddy/.", script)
            self.assertIn("/usr/bin/mv -Tf", script)
            self.assertIn("/usr/bin/chown --reference", script)
            self.assertIn("/usr/bin/chmod --reference", script)
            self.assertIn("trap 'exit 129' HUP", script)
            self.assertIn("trap 'exit 130' INT", script)
            self.assertIn("trap 'exit 143' TERM", script)
        self.assertIn("caddy-change-started", activate)
        self.assertIn("Caddyfile.after.sha256", activate)
        self.assertIn("caddy-site.after.sha256", activate)
        self.assertLess(activate.index('write_hash "$CADDY_MAIN"'), activate.index('/dev/null "$activated_marker"'))
        self.assertIn("restore_prior_config", activate)
        self.assertIn("configuration that was active on entry", restore)
        self.assertIn("--check-only", restore)
        self.assertIn("refusing to overwrite later operator/robot changes", restore)
        self.assertLess(restore.index("refusing to overwrite later operator/robot changes"), restore.index("readonly current_main="))

    def test_rollback_is_a_recoverable_transaction(self) -> None:
        rollback = (DEPLOY / "scripts" / "rollback-release.sh").read_text(encoding="utf-8")
        preflight = rollback.index('restore-caddy-state.sh" "$release_id" --check-only')
        attempt = rollback.index("rollback-attempt.XXXXXX", preflight)
        trap = rollback.index("trap on_exit EXIT", attempt)
        stop = rollback.index('/usr/bin/systemctl stop "$SERVICE_NAME"', trap)
        snapshot = rollback.index('backup-sqlite.sh" pre-restore', stop)
        transaction_arm = rollback.index("transaction_armed=1", snapshot)
        link_switch = rollback.index('set_current_target "$previous_target"', transaction_arm)
        caddy_restore = rollback.index('restore-caddy-state.sh" "$release_id"', link_switch)
        caddy_parent_arm = rollback.rindex("caddy_changed=1", link_switch, caddy_restore)
        self.assertLess(preflight, attempt)
        self.assertLess(attempt, trap)
        self.assertLess(trap, stop)
        self.assertLess(stop, snapshot)
        self.assertLess(snapshot, transaction_arm)
        self.assertLess(transaction_arm, link_switch)
        self.assertLess(link_switch, caddy_parent_arm)
        self.assertLess(caddy_parent_arm, caddy_restore)
        self.assertIn("recover_entry_state", rollback)
        self.assertIn("restore_entry_caddy", rollback)
        self.assertIn("rollback entry-state recovery", rollback)

    def test_rollback_signal_fault_windows_do_not_publish_false_completion(self) -> None:
        rollback = (DEPLOY / "scripts" / "rollback-release.sh").read_text(encoding="utf-8")
        attempt_success = rollback.index('/dev/null "${attempt_dir}/rollback-succeeded"')
        committed = rollback.index("rollback_committed=1", attempt_success)
        trap_off = rollback.index("trap - EXIT HUP INT TERM", committed)
        final_temp = rollback.index('rollback_complete_temp="$(/usr/bin/mktemp', trap_off)
        final_publish = rollback.index('"${state_dir}/rollback-complete"', final_temp)
        self.assertLess(attempt_success, committed)
        self.assertLess(committed, trap_off)
        self.assertLess(trap_off, final_temp)
        self.assertLess(final_temp, final_publish)

        # Fault-inject the two formerly unsafe signal windows using the script's
        # ordered commit events: recovery can never coexist with final completion.
        def inject(after_event: str) -> tuple[str, bool]:
            live = "rollback-target"
            complete = False
            trap_armed = True
            for event in ("attempt-success", "commit-memory", "trap-off", "final-publish"):
                if event == "commit-memory":
                    trap_armed = False
                elif event == "final-publish":
                    complete = True
                if event == after_event:
                    if trap_armed:
                        live = "entry-restored"
                    return live, complete
            raise AssertionError(after_event)

        self.assertEqual(inject("attempt-success"), ("entry-restored", False))
        self.assertEqual(inject("trap-off"), ("rollback-target", False))
        self.assertEqual(inject("final-publish"), ("rollback-target", True))

        # If the child changed Caddy and the parent is signalled before the call
        # returns, the pre-call arm guarantees the entry snapshot is restored.
        caddy_arm = rollback.index("caddy_changed=1", rollback.index('set_current_target "$previous_target"'))
        caddy_call = rollback.index('restore-caddy-state.sh" "$release_id"', caddy_arm)
        self.assertLess(caddy_arm, caddy_call)
        self.assertIn('"${attempt_dir}/Caddyfile.entry" "$expected_main"', rollback)
        self.assertIn('"${attempt_dir}/caddy-site.entry" "$expected_site"', rollback)
        self.assertIn('"${state_dir}/rollback-complete" "${attempt_dir}/rollback-succeeded"', rollback)

    def test_robot_and_guest_acceptance_contract(self) -> None:
        robot = (DEPLOY / "scripts" / "robot-regression.sh").read_text(encoding="utf-8")
        acceptance = (DEPLOY / "scripts" / "acceptance-test.sh").read_text(encoding="utf-8")
        self.assertIn('readonly ROBOT_LOCAL_URL="http://127.0.0.1:8080/"', robot)
        self.assertIn('"sha256": hashlib.sha256(body).hexdigest()', robot)
        self.assertIn('"marker": marker', robot)
        self.assertIn("robot public marker/fingerprint", robot)
        self.assertIn('payload.get("user") is None', acceptance)
        self.assertIn("guest CSRF bootstrap did not set", acceptance)
        self.assertIn('user.get("role") == expected_role', acceptance)
        self.assertIn('user.get("mustChangePassword") is expected', acceptance)
        self.assertIn("logout did not revoke", acceptance)

    def test_success_cleanup_protects_live_and_incomplete_references(self) -> None:
        deploy = (DEPLOY / "scripts" / "deploy-release.sh").read_text(encoding="utf-8")
        prune = (DEPLOY / "scripts" / "prune-deployments.sh").read_text(encoding="utf-8")
        success_index = deploy.index("deployed-success")
        credential_output = deploy.index("INITIAL_ADMIN_TEMP_PASSWORD", success_index)
        incoming_delete_index = deploy.index('/usr/bin/find "$incoming"', success_index)
        prune_index = deploy.index("prune-deployments.sh", incoming_delete_index)
        self.assertLess(success_index, credential_output)
        self.assertLess(credential_output, incoming_delete_index)
        self.assertLess(incoming_delete_index, prune_index)
        self.assertIn("initial-admin-password.recovery", deploy)
        self.assertIn("WARNING: retention cleanup failed", deploy)
        self.assertIn("readonly RETAIN_COUNT=5", prune)
        self.assertIn('protect_link_target "$CURRENT_LINK"', prune)
        self.assertIn('protect_link_target "$PREVIOUS_LINK"', prune)
        self.assertIn('if [[ "$terminal" -eq 0 ]]', prune)
        self.assertIn("database-before", prune)
        self.assertIn("still_referenced", prune)


if __name__ == "__main__":
    unittest.main()
