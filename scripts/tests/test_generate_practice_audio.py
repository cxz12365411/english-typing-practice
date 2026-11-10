"""Offline regression checks for accepted-audio provenance and crop boundaries.

Run: python3 -m unittest discover -s scripts/tests -p 'test_*.py'
Uses temporary WAVs, mocked ASR, and real ffmpeg encoding checks; never calls a speech model.
"""
import copy
import importlib.util
import json
import math
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import wave


SPEC = importlib.util.spec_from_file_location(
    "generate_practice_audio", Path(__file__).resolve().parents[1] / "generate-practice-audio.py"
)
GEN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GEN)
SAMPLE_RATE = 24000
REAL_ENCODE = GEN.encode


def pcm(*sections):
    values = []
    for seconds, amplitude in sections:
        values.extend([amplitude] * round(seconds * SAMPLE_RATE))
    return struct.pack(f"<{len(values)}h", *values)


def write_wav(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(SAMPLE_RATE)
        target.writeframes(data)


def read_pcm(path):
    with wave.open(str(path)) as source:
        return source.readframes(source.getnframes())


def qa(text, status="passed", timestamps=None):
    return {
        "transcript": text,
        "status": status,
        "differences": [] if status == "passed" else [{"expected": "boat", "heard": text}],
        "segments": [{"words": timestamps or []}],
    }


class AudioAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="speech-qa-regression-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.out = self.root / "output"
        self.addCleanup(patch.stopall)
        patch.multiple(GEN, ROOT=self.root, OUT=self.out, MODEL_SHA="fixture-asr-sha").start()
        # An accidentally unmocked inference must fail instead of contacting the
        # running local service or loading the real Whisper weights.
        self.request = patch.object(GEN, "request_audio", side_effect=AssertionError("unexpected inference")).start()
        self.transcribe = patch.object(GEN, "transcribe", side_effect=AssertionError("unexpected ASR")).start()
        patch.object(GEN, "encode", side_effect=self.fake_encode).start()
        patch("builtins.print").start()
        self.clean_pcm = pcm((0.1, 0), (0.8, 2000), (0.1, 0))
        self.item = self.make_item("boat")
        self.profile = {
            "id": "01", "name": "Fixture voice", "rawFile": "01.wav", "duration": 1.0,
            "reference": {"path": "references/01.wav", "sha256": "fixture-reference-sha", "text": "Reference."},
        }

    @staticmethod
    def fake_encode(raw, target, _signal):
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"ID3-fixture-" + GEN.sha(raw.read_bytes()).encode())
        return 0

    @staticmethod
    def make_item(text):
        return {
            "textKey": GEN.sha(text.encode()), "originalText": text, "spokenText": text,
            "itemKeys": [f"fixture-{text}"], "kind": "word",
        }

    def record_path(self, item=None):
        return self.out / "records" / "01" / f"{(item or self.item)['textKey']}.json"

    def accepted_record(self, data=None):
        raw = self.out / "raw" / "01" / f"{self.item['textKey']}.wav"
        target = self.out / "bundle" / "voices" / "01" / f"{self.item['textKey']}.mp3"
        write_wav(raw, data if data is not None else self.clean_pcm)
        sig = GEN.signal(raw)
        self.fake_encode(raw, target, sig)
        record = {
            **self.item, "voiceId": "01", "fingerprint": GEN.generation_fingerprint(self.profile, self.item),
            "referenceSha256": self.profile["reference"]["sha256"],
            "path": f"voices/01/{self.item['textKey']}.mp3", "format": "mp3", "sampleRate": SAMPLE_RATE,
            "encodingVersion": GEN.ENCODING_VERSION,
            "duration": sig["duration"], "signal": sig, "qa": qa(self.item["spokenText"]),
            "qaStatus": "passed", "qaVersion": GEN.QA_VERSION, "qaRulesSignature": GEN.qa_signature(),
            "asrWeightsSha256": GEN.MODEL_SHA, "auditProblems": [], "contextCrop": {"leadIn": "Hello."},
            "rawSha256": GEN.sha(raw.read_bytes()), "sha256": GEN.sha(target.read_bytes()),
            "bytes": target.stat().st_size,
        }
        GEN.atomic_json(self.record_path(), record)
        return record

    def prepare_preview(self):
        source = self.root / "out" / "breeze-voices-20261110"
        raw = source / self.profile["rawFile"]
        write_wav(raw, self.clean_pcm)
        self.profile["rawSha256"] = GEN.sha(raw.read_bytes())
        GEN.atomic_json(source / "manifest.json", {"text": "Hello preview."})
        GEN.atomic_json(source / "qa-01.json", {"sha256": self.profile["rawSha256"], "transcript": "Hello preview."})

    def contextual_record(self, context_status="passed"):
        target_item = self.item
        anchors = [self.make_item("come"), self.make_item("give")]
        try:
            for item, amplitude in zip(anchors, (3000, 4000)):
                self.item = item
                self.accepted_record(pcm((0.1, 0), (0.8, amplitude), (0.1, 0)))
        finally:
            self.item = target_item
        self.record_path().unlink(missing_ok=True)
        self.transcribe.reset_mock()

        def recognize(_path, expected):
            if expected == target_item["spokenText"]:
                return qa("bought", status="review")
            self.assertEqual(expected, "come. boat. give. boat. come.")
            heard = expected if context_status == "passed" else "come. bought. give. bought. come."
            return qa(heard, status=context_status)

        self.transcribe.side_effect = recognize
        with patch.object(GEN, "prefaced_audio", return_value=(self.clean_pcm, 0, {}, {"leadIn": "Hello."})):
            record = GEN.job(self.profile, self.item, retries=0)
        return record, [target_item, *anchors]

    def test_high_energy_at_either_edge_never_passes_even_with_exact_transcript(self):
        cases = {
            "start": (pcm((0.9, 2000), (0.1, 0)), "startBoundaryRisk"),
            "end": (pcm((0.1, 0), (0.9, 2000)), "endBoundaryRisk"),
        }
        self.transcribe.side_effect = lambda _path, expected: qa(expected)
        for name, (data, risk) in cases.items():
            with self.subTest(edge=name), patch.object(
                GEN, "prefaced_audio", return_value=(data, 0, {}, {"leadIn": "Hello."})
            ):
                result = GEN.job(self.profile, self.item, retries=0)
                self.assertEqual(result["qaStatus"], "review")
                self.assertTrue(result["signal"][risk])
                self.assertEqual(result["qa"]["status"], "passed")
                self.assertFalse(GEN.clean_signal(result["signal"]))

    def test_audit_rechecks_real_boundaries_and_catches_unprotected_legacy_first_word(self):
        cases = {
            "start": (pcm((0.9, 2000), (0.1, 0)), "audio-boundary-or-clipping-review", False),
            "end": (pcm((0.1, 0), (0.9, 2000)), "audio-boundary-or-clipping-review", False),
            # A single zero sample can hide an abrupt first phoneme from a
            # first-sample check; legacy first clips require the 10 ms audit.
            "legacy": (b"\0\0" + pcm((0.9, 2000), (0.1, 0))[2:], "unprotected-first-phoneme-review", True),
        }
        for name, (data, problem, legacy) in cases.items():
            with self.subTest(edge=name):
                record = self.accepted_record(data)
                if legacy:
                    record.pop("contextCrop")
                    record.update(generationMode="word-batch-v1", batchIndex=0)
                    GEN.atomic_json(self.record_path(), record)
                summary = GEN.audit_records([self.profile], [self.item])
                current = json.loads(self.record_path().read_text())
                self.assertEqual(summary["passed"], 0)
                self.assertEqual(current["qaStatus"], "review")
                self.assertIn(problem, current["auditProblems"])

    def test_nontranscript_audit_failure_cannot_return_from_cache_or_be_reclassified(self):
        for status in ("passed", "review"):
            with self.subTest(previous_status=status):
                record = self.accepted_record()
                record.update(qaStatus=status, auditProblems=["audio-boundary-or-clipping-review"])
                GEN.atomic_json(self.record_path(), record)
                with patch.object(GEN, "prefaced_audio", side_effect=RuntimeError("regeneration required")) as regenerate:
                    result = GEN.job(self.profile, self.item, retries=0)
                regenerate.assert_called_once()
                self.assertEqual(result["qaStatus"], "failed")
                self.assertIn("regeneration required", result["error"])

    def test_hello_is_removed_by_measured_silence_and_cropped_content_is_rechecked(self):
        full_pcm = pcm((0.08, 0), (0.27, 4000), (0.30, 0), (0.45, 2000), (0.30, 0))
        timestamps = [{"word": "Hello", "start": 0.08, "end": 0.35}, {"word": "boat", "start": 0.65, "end": 1.1}]
        self.request.side_effect = None
        self.request.return_value = (full_pcm, 0, {"text": "Hello. boat."})
        for heard, expected_status in (("boat", "passed"), ("bought", "review")):
            with self.subTest(cropped_transcript=heard):
                self.record_path().unlink(missing_ok=True)
                calls = []

                def recognize(path, expected):
                    calls.append((Path(path), expected))
                    if expected == "Hello. boat.":
                        return qa(expected, timestamps=timestamps)
                    self.assertEqual(expected, "boat")
                    return qa(heard, status=expected_status)

                self.transcribe.side_effect = recognize
                result = GEN.job(self.profile, self.item, retries=0)
                self.assertEqual(result["qaStatus"], expected_status)
                self.assertEqual([expected for _, expected in calls], ["Hello. boat.", "boat"])
                raw = self.out / "raw" / "01" / f"{self.item['textKey']}.wav"
                cropped = read_pcm(raw)
                cut = result["contextCrop"]["cutSample"]
                self.assertEqual(cropped, full_pcm[cut * 2:])
                self.assertEqual(read_pcm(calls[0][0]), full_pcm)
                samples = struct.unpack(f"<{len(cropped) // 2}h", cropped)
                self.assertEqual(set(samples), {0, 2000})
                self.assertEqual(samples.count(2000), round(0.45 * SAMPLE_RATE))

    def test_word_batch_skips_hello_and_retains_each_words_own_clip(self):
        items = [self.item, self.make_item("train")]
        data = pcm((0.08, 0), (0.27, 4000), (0.30, 0), (0.45, 2000), (0.30, 0), (0.45, 3000), (0.30, 0))
        timestamps = [
            {"word": "Hello", "start": 0.08, "end": 0.35},
            {"word": "boat", "start": 0.65, "end": 1.1},
            {"word": "train", "start": 1.4, "end": 1.85},
        ]
        self.request.side_effect = None
        self.request.return_value = (data, 0, {"text": "Hello. boat. train."})
        self.transcribe.side_effect = lambda _path, expected: qa(expected, timestamps=timestamps if expected.startswith("Hello.") else [])
        with patch.object(GEN, "job", side_effect=AssertionError("unexpected batch fallback")):
            results = GEN.word_batch(self.profile, items, retries=0)
        self.assertEqual([result["qaStatus"] for result in results], ["passed", "passed"])
        self.assertEqual([result["batchIndex"] for result in results], [0, 1])
        self.assertEqual([call.args[1] for call in self.transcribe.call_args_list], ["Hello. boat. train.", "boat", "train"])
        for item, amplitude in zip(items, (2000, 3000)):
            clip = read_pcm(self.out / "raw" / "01" / f"{item['textKey']}.wav")
            samples = struct.unpack(f"<{len(clip) // 2}h", clip)
            self.assertEqual(set(samples), {0, amplitude})
            self.assertEqual(samples.count(amplitude), round(0.45 * SAMPLE_RATE))

    def test_manifest_only_exports_current_accepted_text_reference_and_qa(self):
        self.prepare_preview()
        record = self.accepted_record()
        self.assertEqual(len(GEN.manifest([self.profile], [self.item])["assets"]), 1)
        changes = {
            "old QA version": {"qaVersion": GEN.QA_VERSION - 1},
            "old QA rules": {"qaRulesSignature": "stale-signature"},
            "changed original": {"originalText": "Boat"},
            "changed spoken text": {"spokenText": "bought"},
            "unresolved audit": {"auditProblems": ["audio-boundary-or-clipping-review"]},
        }
        for name, changed in changes.items():
            with self.subTest(invalid=name):
                GEN.atomic_json(self.record_path(), {**record, **changed})
                self.assertEqual(GEN.manifest([self.profile], [self.item])["assets"], [])
        GEN.atomic_json(self.record_path(), record)
        changed_profile = copy.deepcopy(self.profile)
        changed_profile["reference"]["sha256"] = "different-reference-sha"
        self.assertEqual(GEN.manifest([changed_profile], [self.item])["assets"], [])
        with patch.object(GEN, "MODEL_SHA", "changed-model-sha"):
            self.assertEqual(GEN.manifest([self.profile], [self.item])["assets"], [])
        GEN.atomic_json(self.out / "qa-equivalences.json", {"groups": [["fixture", "fixture-spelling"]]})
        self.assertEqual(GEN.manifest([self.profile], [self.item])["assets"], [])

    def test_audit_does_not_relabel_an_old_transcript_as_new_asr_weights(self):
        record = self.accepted_record()
        with patch.object(GEN, "MODEL_SHA", "changed-model-sha"):
            summary = GEN.audit_records([self.profile], [self.item])
        current = json.loads(self.record_path().read_text())
        self.assertEqual(summary["passed"], 0)
        self.assertEqual(current["qaStatus"], "review")
        self.assertIn("asr-model-changed-retranscription-required", current["auditProblems"])
        self.assertEqual(current["asrWeightsSha256"], record["asrWeightsSha256"])
        self.assertEqual(current["qaRulesSignature"], record["qaRulesSignature"])
        self.transcribe.assert_not_called()

    def test_contextual_support_preserves_isolated_transcript_and_delivered_pcm(self):
        self.prepare_preview()
        record, items = self.contextual_record()
        raw = self.out / "raw" / "01" / f"{self.item['textKey']}.wav"
        context = record["qa"]["contextCheck"]
        self.assertEqual(record["qaStatus"], "passed")
        self.assertEqual(record["qa"]["status"], "review")
        self.assertEqual(record["qa"]["transcript"], "bought")
        self.assertEqual(context["qa"]["transcript"], "come. boat. give. boat. come.")
        self.assertEqual([call.args[1] for call in self.transcribe.call_args_list], ["boat", "come. boat. give. boat. come."])
        self.assertEqual(read_pcm(raw), self.clean_pcm)
        self.assertEqual(context["targetRawSha256"], GEN.sha(raw.read_bytes()))
        self.assertEqual(context["targetPcmSha256"], GEN.sha(self.clean_pcm))
        anchor_pcm = {word: read_pcm(self.out / "raw" / "01" / f"{GEN.sha(word.encode())}.wav") for word in ("come", "give")}
        expected = (b"\0\0" * 7200).join([anchor_pcm["come"], self.clean_pcm, anchor_pcm["give"], self.clean_pcm, anchor_pcm["come"]])
        self.assertEqual(read_pcm(self.out / context["file"]), expected)
        self.assertTrue(GEN.context_check_valid(record, raw, self.profile))
        self.assertEqual(GEN.audit_records([self.profile], items)["passed"], 3)
        self.assertEqual(len(GEN.manifest([self.profile], items)["assets"]), 3)
        with patch.object(GEN, "prefaced_audio", side_effect=AssertionError("valid proof should use cache")) as regenerate:
            cached = GEN.job(self.profile, self.item, retries=0)
        regenerate.assert_not_called()
        self.assertEqual(cached["qa"]["transcript"], "bought")

    def test_changed_context_proof_cannot_be_exported_or_revived_from_cache(self):
        self.prepare_preview()
        for changed in ("target", "anchor", "composite", "composite-rehashed", "transcript"):
            with self.subTest(changed=changed):
                record, items = self.contextual_record()
                self.assertEqual(record["qaStatus"], "passed")
                raw = self.out / "raw" / "01" / f"{self.item['textKey']}.wav"
                context = record["qa"]["contextCheck"]
                if changed == "transcript":
                    context["qa"]["transcript"] = "come. wrong. give. wrong. come."
                else:
                    target = raw if changed == "target" else (
                        self.out / "raw" / "01" / f"{GEN.sha(b'come')}.wav" if changed == "anchor"
                        else self.out / context["file"]
                    )
                    data = bytearray(target.read_bytes())
                    data[len(data) // 2] ^= 1
                    target.write_bytes(data)
                    if changed == "composite-rehashed":
                        # A matching file digest alone cannot prove that the
                        # repeated target PCM is exactly the delivered audio.
                        context["compositeSha256"] = GEN.sha(data)
                GEN.atomic_json(self.record_path(), record)
                self.assertFalse(GEN.context_check_valid(record, raw, self.profile))
                assets = GEN.manifest([self.profile], items)["assets"]
                self.assertNotIn(self.item["textKey"], [asset["textKey"] for asset in assets])
                with patch.object(GEN, "prefaced_audio", side_effect=RuntimeError("regeneration required")) as regenerate:
                    result = GEN.job(self.profile, self.item, retries=0)
                regenerate.assert_called_once()
                self.assertEqual(result["qaStatus"], "failed")
                GEN.atomic_json(self.record_path(), record)
                GEN.audit_records([self.profile], items)
                audited = json.loads(self.record_path().read_text())
                self.assertEqual(audited["qaStatus"], "review")
                self.assertEqual(audited["qa"]["transcript"], "bought")

    def test_failed_context_transcript_keeps_original_review_and_requires_regeneration(self):
        self.prepare_preview()
        record, items = self.contextual_record(context_status="review")
        self.assertEqual(record["qaStatus"], "review")
        self.assertEqual(record["qa"]["transcript"], "bought")
        self.assertEqual(record["qa"]["contextCheck"]["status"], "review")
        self.assertEqual(record["qa"]["contextCheck"]["qa"]["transcript"], "come. bought. give. bought. come.")
        raw = self.out / "raw" / "01" / f"{self.item['textKey']}.wav"
        self.assertFalse(GEN.context_check_valid(record, raw, self.profile))
        GEN.audit_records([self.profile], items)
        audited = json.loads(self.record_path().read_text())
        self.assertEqual(audited["qaStatus"], "review")
        self.assertIn("context-proof-invalid", audited["auditProblems"])
        self.assertIn("transcript-review", audited["auditProblems"])
        self.assertNotIn(self.item["textKey"], [asset["textKey"] for asset in GEN.manifest([self.profile], items)["assets"]])
        with patch.object(GEN, "prefaced_audio", side_effect=RuntimeError("regeneration required")) as regenerate:
            result = GEN.job(self.profile, self.item, retries=0)
        regenerate.assert_called_once()
        self.assertEqual(result["qaStatus"], "failed")

    def test_context_proof_rejects_stale_anchor_qa_without_silently_rewriting_it(self):
        self.prepare_preview()
        changes = {
            "ASR weights": {"asrWeightsSha256": "older-asr-weights"},
            "QA version": {"qaVersion": GEN.QA_VERSION - 1},
            "QA signature": {"qaRulesSignature": "older-qa-signature"},
        }
        for changed, update in changes.items():
            with self.subTest(changed=changed):
                record, items = self.contextual_record()
                anchor_path = self.out / "records" / "01" / f"{GEN.sha(b'come')}.json"
                anchor = json.loads(anchor_path.read_text())
                anchor.update(update)
                GEN.atomic_json(anchor_path, anchor)
                raw = self.out / "raw" / "01" / f"{self.item['textKey']}.wav"
                self.assertFalse(GEN.context_check_valid(record, raw, self.profile))
                assets = GEN.manifest([self.profile], items)["assets"]
                self.assertNotIn(self.item["textKey"], [asset["textKey"] for asset in assets])
                with patch.object(GEN, "prefaced_audio", side_effect=RuntimeError("regeneration required")) as regenerate:
                    result = GEN.job(self.profile, self.item, retries=0)
                regenerate.assert_called_once()
                self.assertEqual(result["qaStatus"], "failed")
                self.assertEqual(json.loads(anchor_path.read_text()), anchor)
                if changed == "ASR weights":
                    GEN.atomic_json(self.record_path(), record)
                    GEN.audit_records([self.profile], items)
                    self.assertEqual(json.loads(self.record_path().read_text())["qaStatus"], "review")
                    self.assertEqual(json.loads(anchor_path.read_text())["asrWeightsSha256"], "older-asr-weights")

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required for the real encoding regression")
    def test_real_encoding_lifts_quiet_audio_and_keeps_peak_and_timing_limits(self):
        # The quiet case deliberately needs about 23 dB. It must fail against
        # the former 12 dB cap, while the proposed 24 dB cap reaches -23 dBFS.
        frames = SAMPLE_RATE * 2
        quiet = [
            round(240 * math.sin(2 * math.pi * 440 * index / SAMPLE_RATE)
                  * min(1, index / 2400, (frames - 1 - index) / 2400))
            for index in range(frames)
        ]
        high_crest = quiet.copy()
        high_crest[frames // 2:frames // 2 + 48] = [
            round(30000 * math.sin(2 * math.pi * 1000 * index / SAMPLE_RATE))
            for index in range(48)
        ]
        for name, values in (("quiet", quiet), ("high-crest", high_crest)):
            with self.subTest(signal=name):
                raw = self.out / "encoding-fixtures" / f"{name}.wav"
                target = raw.with_suffix(".mp3")
                decoded = raw.with_name(f"{name}-decoded.wav")
                write_wav(raw, struct.pack(f"<{len(values)}h", *values))
                before_sha = GEN.sha(raw.read_bytes())
                original = GEN.signal(raw)
                initial_gain = min(24, -23 - original["rmsDbfs"], -2 - original["peakDbfs"])
                gain = REAL_ENCODE(raw, target, original)
                self.assertLessEqual(gain, initial_gain + 1e-6)
                if name == "quiet":
                    self.assertGreater(gain, 12)
                    self.assertLessEqual(gain, 24)
                    self.assertLessEqual(original["rmsDbfs"] + gain, -23 + 1e-6)
                else:
                    self.assertLess(gain, 0)
                    self.assertLessEqual(original["peakDbfs"] + gain, -2 + 1e-6)
                    self.assertLess(original["rmsDbfs"] + gain, -23)
                subprocess.run([
                    "ffmpeg", "-nostdin", "-y", "-v", "error", "-xerror", "-i", str(target),
                    "-c:a", "pcm_s16le", str(decoded),
                ], check=True, capture_output=True, timeout=30)
                with wave.open(str(decoded)) as output:
                    self.assertEqual(output.getframerate(), SAMPLE_RATE)
                    self.assertEqual(output.getnchannels(), 1)
                    self.assertEqual(output.getsampwidth(), 2)
                    padding = output.getnframes() - frames
                    self.assertGreaterEqual(padding, 0)
                    self.assertLessEqual(padding, 47)
                if padding:
                    decoded_pcm = read_pcm(decoded)
                    tail = [sample / 32768 for sample in struct.unpack(f"<{padding}h", decoded_pcm[-padding * 2:])]
                    self.assertLessEqual(max(map(abs, tail)), 10 ** (-50 / 20))
                    self.assertLessEqual(math.sqrt(sum(value * value for value in tail) / padding), 10 ** (-60 / 20))
                actual = GEN.signal(decoded)
                self.assertEqual(actual["clippedSamples"], 0)
                self.assertLessEqual(actual["peakDbfs"], -2 + 1e-4)
                self.assertEqual(GEN.sha(raw.read_bytes()), before_sha)
                if name == "quiet":
                    self.assertAlmostEqual(actual["rmsDbfs"], -23, delta=1.0)
        self.request.assert_not_called()
        self.transcribe.assert_not_called()

    def test_encoder_rejects_three_decoded_peak_overshoots_without_replacing_output(self):
        raw = self.out / "encoding-fixtures" / "overshoot.wav"
        target = raw.with_suffix(".mp3")
        write_wav(raw, self.clean_pcm)
        target.write_bytes(b"previous-accepted-mp3")
        raw_before = raw.read_bytes()
        gains, decoded = [], []

        def run_ffmpeg(args, **_kwargs):
            if "-af" in args:
                self.assertEqual(args[args.index("-i") + 1], str(raw))
                gains.append(float(args[args.index("-af") + 1].removeprefix("volume=").removesuffix("dB")))
                Path(args[-1]).write_bytes(b"new-unaccepted-mp3")
                return subprocess.CompletedProcess(args, 0)
            decoded.append(args)
            return subprocess.CompletedProcess(args, 0, stdout=struct.pack("<f", 1.0) * SAMPLE_RATE, stderr=b"")

        with patch.object(GEN.subprocess, "run", side_effect=run_ffmpeg):
            with self.assertRaisesRegex(ValueError, "peak remained above -2 dBFS"):
                REAL_ENCODE(raw, target, GEN.signal(raw))
        self.assertEqual(len(gains), 3)
        self.assertEqual(len(decoded), 3)
        self.assertGreater(gains[0], gains[1])
        self.assertGreater(gains[1], gains[2])
        self.assertEqual(target.read_bytes(), b"previous-accepted-mp3")
        self.assertEqual(raw.read_bytes(), raw_before)
        self.request.assert_not_called()
        self.transcribe.assert_not_called()

    def test_old_encoding_is_excluded_then_upgraded_without_tts_or_raw_changes(self):
        self.prepare_preview()
        record = self.accepted_record()
        record.update(encodingVersion=1, gainDb=12, generationMode="word-batch-v2-leadin", batchIndex=0)
        GEN.atomic_json(self.record_path(), record)
        raw = self.out / "raw" / "01" / f"{self.item['textKey']}.wav"
        mp3 = self.out / "bundle" / record["path"]
        raw_before = raw.read_bytes()
        self.assertEqual(GEN.manifest([self.profile], [self.item])["assets"], [])
        self.assertEqual(GEN.audit_records([self.profile], [self.item])["passed"], 0)
        audited = json.loads(self.record_path().read_text())
        self.assertEqual(audited["qaStatus"], "review")
        self.assertEqual(audited["auditProblems"], ["encoding-version-mismatch"])

        def reencode(source, destination, _sig):
            self.assertEqual(source, raw)
            self.assertEqual(destination, mp3)
            destination.write_bytes(b"ID3-upgraded-from-original-wav")
            return 21.5

        with patch.object(GEN, "encode", side_effect=reencode) as encode, patch.object(
            GEN, "prefaced_audio", side_effect=AssertionError("upgrade must not generate audio")
        ) as generate:
            result = GEN.job(self.profile, self.item, retries=0)
        encode.assert_called_once()
        generate.assert_not_called()
        self.request.assert_not_called()
        self.transcribe.assert_not_called()
        self.assertEqual(raw.read_bytes(), raw_before)
        self.assertEqual(result["encodingVersion"], GEN.ENCODING_VERSION)
        self.assertEqual(result["qaStatus"], "passed")
        self.assertEqual(result["auditProblems"], [])
        self.assertEqual(result["gainDb"], 21.5)
        self.assertEqual(result["sha256"], GEN.sha(mp3.read_bytes()))
        self.assertEqual(result["qa"], record["qa"])
        self.assertEqual(result["batchIndex"], 0)
        self.assertEqual(result["generationMode"], "word-batch-v2-leadin")
        self.assertEqual(result["encodingHistory"], [{"encodingVersion": 1, "gainDb": 12, "sha256": record["sha256"]}])
        self.assertEqual(len(GEN.manifest([self.profile], [self.item])["assets"]), 1)

    def test_encoding_upgrade_refuses_bad_hashes_and_expired_qa(self):
        changes = {
            "raw hash": {"rawSha256": "0" * 64},
            "MP3 hash": {"sha256": "0" * 64},
            "QA version": {"qaVersion": GEN.QA_VERSION - 1},
            "QA rules": {"qaRulesSignature": "outdated"},
            "ASR weights": {"asrWeightsSha256": "outdated"},
            "other review problem": {"auditProblems": ["encoding-version-mismatch", "transcript-review"]},
        }
        for changed, updates in changes.items():
            with self.subTest(changed=changed):
                record = self.accepted_record()
                record.update(encodingVersion=1, **updates)
                GEN.atomic_json(self.record_path(), record)
                raw = self.out / "raw" / "01" / f"{self.item['textKey']}.wav"
                mp3 = self.out / "bundle" / record["path"]
                before = {path: path.read_bytes() for path in (raw, mp3, self.record_path())}
                with patch.object(GEN, "encode", side_effect=AssertionError("invalid asset cannot be upgraded")) as encode:
                    result = GEN.upgrade_encoding(self.profile, self.item, record, raw, mp3, self.record_path())
                encode.assert_not_called()
                self.assertEqual(result["encodingVersion"], 1)
                for path, content in before.items():
                    self.assertEqual(path.read_bytes(), content)
        self.request.assert_not_called()
        self.transcribe.assert_not_called()

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required for the padding regression")
    def test_real_short_mp3_retains_all_samples_with_only_quiet_subframe_padding(self):
        frames = 17880  # The observed libmp3lame boundary that retains 23 samples.
        values = [
            round(3000 * math.sin(2 * math.pi * 440 * index / SAMPLE_RATE)
                  * min(1, index / 1200, (frames - 1 - index) / 1200))
            for index in range(frames)
        ]
        raw = self.out / "encoding-fixtures" / "short-boundary.wav"
        target = raw.with_suffix(".mp3")
        write_wav(raw, struct.pack(f"<{frames}h", *values))
        before = raw.read_bytes()
        REAL_ENCODE(raw, target, GEN.signal(raw))
        decoded = subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-xerror", "-i", str(target),
            "-f", "f32le", "-c:a", "pcm_f32le", "-",
        ], check=True, capture_output=True, timeout=30)
        samples = struct.unpack(f"<{len(decoded.stdout) // 4}f", decoded.stdout)
        self.assertGreaterEqual(len(samples), frames)
        self.assertLessEqual(len(samples) - frames, 47)
        tail = samples[frames:]
        if tail:
            self.assertLessEqual(max(map(abs, tail)), 10 ** (-50 / 20))
            self.assertLessEqual(math.sqrt(sum(value * value for value in tail) / len(tail)), 10 ** (-60 / 20))
        self.assertLessEqual(20 * math.log10(max(map(abs, samples))), -2 + 1e-4)
        self.assertEqual(raw.read_bytes(), before)
        self.request.assert_not_called()
        self.transcribe.assert_not_called()

    def test_encoder_rejects_truncation_excess_padding_and_energetic_padding(self):
        raw = self.out / "encoding-fixtures" / "invalid-padding.wav"
        target = raw.with_suffix(".mp3")
        write_wav(raw, self.clean_pcm)
        before = raw.read_bytes()
        cases = {
            "truncated": [0.1] * (SAMPLE_RATE - 1),
            "too many samples": [0.1] * SAMPLE_RATE + [0.0] * 48,
            "tail peak": [0.1] * SAMPLE_RATE + [0.004] + [0.0] * 46,
            "tail RMS": [0.1] * SAMPLE_RATE + [0.002] * 47,
        }
        for name, samples in cases.items():
            with self.subTest(invalid=name):
                target.write_bytes(b"previous-accepted-mp3")

                def run_ffmpeg(args, **_kwargs):
                    if "-af" in args:
                        Path(args[-1]).write_bytes(b"new-unaccepted-mp3")
                        return subprocess.CompletedProcess(args, 0)
                    return subprocess.CompletedProcess(args, 0, stdout=struct.pack(f"<{len(samples)}f", *samples), stderr=b"")

                with patch.object(GEN.subprocess, "run", side_effect=run_ffmpeg):
                    with self.assertRaisesRegex(ValueError, "duration or samples invalid|non-quiet trailing padding"):
                        REAL_ENCODE(raw, target, GEN.signal(raw))
                self.assertEqual(target.read_bytes(), b"previous-accepted-mp3")
                self.assertEqual(raw.read_bytes(), before)

    def test_preview_old_or_corrupted_encoding_is_rebuilt_then_reused_without_tts(self):
        self.prepare_preview()
        self.accepted_record()
        GEN.manifest([self.profile], [self.item])
        metadata = self.out / "preview-encoding.json"
        baseline = json.loads(metadata.read_text())
        raw = self.root / "out" / "breeze-voices-20261110" / self.profile["rawFile"]
        raw_before = raw.read_bytes()
        for reason in ("missing metadata", "old encoding", "bad MP3 hash", "bad raw hash"):
            with self.subTest(reason=reason):
                current = copy.deepcopy(baseline)
                if reason == "missing metadata":
                    metadata.unlink(missing_ok=True)
                else:
                    if reason == "old encoding":
                        current[0]["encodingVersion"] = 1
                    elif reason == "bad MP3 hash":
                        current[0]["sha256"] = "0" * 64
                    else:
                        current[0]["rawSha256"] = "0" * 64
                    GEN.atomic_json(metadata, current)
                with patch.object(GEN, "encode", side_effect=self.fake_encode) as encode:
                    manifest = GEN.manifest([self.profile], [self.item])
                encode.assert_called_once()
                self.assertEqual(encode.call_args.args[0], raw)
                updated = json.loads(metadata.read_text())[0]
                self.assertEqual(updated["encodingVersion"], GEN.ENCODING_VERSION)
                self.assertEqual(updated["rawSha256"], self.profile["rawSha256"])
                self.assertEqual(updated["sha256"], manifest["previews"][0]["sha256"])
                with patch.object(GEN, "encode", side_effect=AssertionError("valid preview should be cached")) as encode:
                    GEN.manifest([self.profile], [self.item])
                encode.assert_not_called()
                self.assertEqual(raw.read_bytes(), raw_before)
        self.request.assert_not_called()
        self.transcribe.assert_not_called()


if __name__ == "__main__":
    unittest.main()
