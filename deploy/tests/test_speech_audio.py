import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("verify_speech_audio", Path(__file__).parents[1] / "scripts" / "verify-speech-audio.py")
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)


class SpeechAudioBundleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.manifest = {"manifestVersion": 1, "expectedTexts": 1, "expectedAssets": 5,
                         "voices": [], "assets": [], "previews": []}
        for voice in ("01", "02", "03", "04", "05"):
            self.manifest["voices"].append({"id": voice, "name": voice})
            for group, prefix, text in (("assets", "voices", "Hello."), ("previews", "previews", "A preview.")):
                key = hashlib.sha256(text.encode()).hexdigest()
                relative = f"{prefix}/{voice}/{key}.mp3"
                audio = b"ID3\x00fixture-" + voice.encode()
                target = self.root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(audio)
                self.manifest[group].append({"voiceId": voice, "textKey": key, "originalText": text, "spokenText": text,
                    "path": relative, "sha256": hashlib.sha256(audio).hexdigest(), "duration": 1.0,
                    "sampleRate": 24000, "format": "mp3", "qaStatus": "passed"})
        self.save()

    def tearDown(self):
        self.tmp.cleanup()

    def save(self):
        (self.root / "manifest.json").write_text(json.dumps(self.manifest))

    def test_accepts_complete_checked_package(self):
        result = validator.verify(self.root)
        self.assertEqual((result["texts"], result["assets"], result["previews"]), (1, 5, 5))

    def test_tampering_cannot_be_staged(self):
        (self.root / self.manifest["assets"][0]["path"]).write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "checksum"):
            validator.verify(self.root)

    def test_rejects_symlink_audio(self):
        target = self.root / self.manifest["assets"][0]["path"]
        target.unlink()
        target.symlink_to(self.root / "manifest.json")
        with self.assertRaisesRegex(ValueError, "symlinks"):
            validator.verify(self.root)

    def test_rejects_unlisted_files(self):
        (self.root / ".env").write_text("sensitive")
        with self.assertRaisesRegex(ValueError, "unlisted"):
            validator.verify(self.root)

    def test_rejects_partial_voice_coverage(self):
        removed = self.manifest["assets"].pop()
        (self.root / removed["path"]).unlink()
        self.save()
        with self.assertRaisesRegex(ValueError, "all five"):
            validator.verify(self.root)

    def test_unreviewed_cannot_be_staged(self):
        self.manifest["assets"][0]["qaStatus"] = "review"
        self.save()
        with self.assertRaisesRegex(ValueError, "unreviewed"):
            validator.verify(self.root)

    def test_rejects_path_traversal(self):
        self.manifest["assets"][0]["path"] = "../../private.mp3"
        self.save()
        with self.assertRaisesRegex(ValueError, "path"):
            validator.verify(self.root)
    def test_rejects_text_mismatch(self):
        self.manifest["assets"][0]["originalText"] = "Changed content."
        self.save()
        with self.assertRaisesRegex(ValueError, "text hash"):
            validator.verify(self.root)

    def test_rejects_missing_entire_text_even_when_remaining_voices_are_complete(self):
        self.manifest["expectedTexts"] = 2
        self.manifest["expectedAssets"] = 10
        self.save()
        with self.assertRaisesRegex(ValueError, "incomplete declared"):
            validator.verify(self.root)

    def test_rejects_missing_expected_coverage(self):
        del self.manifest["expectedTexts"]
        self.save()
        with self.assertRaisesRegex(ValueError, "declared speech coverage"):
            validator.verify(self.root)

    def test_voice_metadata_matches_server_contract(self):
        original = json.dumps(self.manifest)
        for mutation in ("order", "empty-name", "long-name", "control-name", "not-object"):
            with self.subTest(mutation=mutation):
                self.manifest = json.loads(original)
                if mutation == "order": self.manifest["voices"].reverse()
                elif mutation == "empty-name": self.manifest["voices"][0]["name"] = " "
                elif mutation == "long-name": self.manifest["voices"][0]["name"] = "x" * 81
                elif mutation == "control-name": self.manifest["voices"][0]["name"] = "Voice\x00"
                else: self.manifest["voices"][0] = "01"
                self.save()
                with self.assertRaises(ValueError): validator.verify(self.root)

    def test_rejects_invalid_json_shapes_and_boolean_numbers(self):
        original = json.dumps(self.manifest)
        for mutation in ("root-list", "voice-list", "asset-null", "boolean-version", "boolean-duration", "boolean-count"):
            with self.subTest(mutation=mutation):
                self.manifest = json.loads(original)
                if mutation == "root-list": self.manifest = []
                elif mutation == "voice-list": self.manifest["voices"] = {}
                elif mutation == "asset-null": self.manifest["assets"][0] = None
                elif mutation == "boolean-version": self.manifest["manifestVersion"] = True
                elif mutation == "boolean-duration": self.manifest["assets"][0]["duration"] = True
                else: self.manifest["expectedTexts"] = True
                self.save()
                with self.assertRaises(ValueError): validator.verify(self.root)

    def test_rejects_hard_links_before_release_chown_can_affect_other_paths(self):
        target = self.root / self.manifest["assets"][0]["path"]
        sibling = self.root / "linked-outside-audio.mp3"
        os.link(target, sibling)
        with self.assertRaisesRegex(ValueError, "hard links"):
            validator.verify(self.root)

    def test_rejects_oversized_manifest_before_parsing(self):
        with (self.root / "manifest.json").open("wb") as stream:
            stream.truncate(validator.MAX_MANIFEST_BYTES + 1)
        with self.assertRaisesRegex(ValueError, "bounded"):
            validator.verify(self.root)

    @unittest.skipUnless(shutil.which("bash") and shutil.which("realpath"), "Bash and realpath required")
    def test_code_only_staging_keeps_selected_audio_when_current_switches(self):
        stage = (Path(__file__).parents[1] / "scripts" / "stage-release.sh").read_text()
        pin_lines = [line for line in stage.splitlines() if 'speech_audio_bundle="$(/usr/bin/realpath' in line]
        self.assertEqual(len(pin_lines), 1)
        with tempfile.TemporaryDirectory() as work:
            folder = Path(work)
            old = folder / "old" / "server" / "audio"
            new = folder / "new" / "server" / "audio"
            old.mkdir(parents=True)
            new.mkdir(parents=True)
            (old / "selected-version").write_text("old")
            (new / "selected-version").write_text("new")
            current = folder / "current"
            current.symlink_to(folder / "old", target_is_directory=True)
            copied = folder / "copied"
            # macOS realpath resolves existing paths but lacks GNU's -e/-- flags.
            pin = pin_lines[0].replace("/usr/bin/realpath", shutil.which("realpath"))
            if sys.platform == "darwin": pin = pin.replace(" -e -- ", " ")
            script = '\n'.join([
                'set -euo pipefail', 'speech_audio_bundle="$1"', pin,
                'rm -- "$2"', 'ln -s -- "$3" "$2"', 'cp -a -- "$speech_audio_bundle" "$4"'
            ])
            result = subprocess.run([shutil.which("bash"), "-c", script, "stage-audio-test",
                str(current / "server" / "audio"), str(current), str(folder / "new"), str(copied)],
                capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((current / "server" / "audio" / "selected-version").read_text(), "new")
            self.assertEqual((copied / "selected-version").read_text(), "old")


if __name__ == "__main__":
    unittest.main()
