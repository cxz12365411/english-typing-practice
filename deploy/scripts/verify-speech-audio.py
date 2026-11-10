#!/usr/bin/env python3
"""Validate a complete immutable five-voice bundle before staging or activation."""
import hashlib
import json
import math
import re
import sys
from pathlib import Path

VOICE_IDS = ("01", "02", "03", "04", "05")
MAX_MANIFEST_BYTES = 32 * 1024 * 1024


def js_length(value):
    return len(value.encode("utf-16-le")) // 2


def verify(directory):
    root = Path(directory)
    if not root.is_dir() or root.is_symlink():
        raise ValueError("audio root must be a real directory")
    manifest_path = root / "manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ValueError("manifest.json must be a regular file")
    if manifest_path.stat().st_nlink != 1 or manifest_path.stat().st_size > MAX_MANIFEST_BYTES:
        raise ValueError("manifest.json must be bounded and not hard-linked")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or type(manifest.get("manifestVersion")) is not int or manifest.get("manifestVersion") != 1:
        raise ValueError("unsupported audio manifest version")
    voice_ids = set(VOICE_IDS)
    voices = manifest.get("voices", [])
    if not isinstance(voices, list) or len(voices) != 5:
        raise ValueError("bundle must contain exactly voices 01-05 in order")
    for expected, voice in zip(VOICE_IDS, voices):
        if not isinstance(voice, dict) or voice.get("id") != expected:
            raise ValueError("bundle must contain exactly voices 01-05 in order")
        name = voice.get("name")
        if not isinstance(name, str) or not name.strip() or js_length(name) > 80 or re.search(r"[\x00-\x1f\x7f]", name):
            raise ValueError("invalid voice name")
    expected_texts = manifest.get("expectedTexts")
    expected_assets = manifest.get("expectedAssets")
    if type(expected_texts) is not int or not 0 < expected_texts <= 20_000 or type(expected_assets) is not int or expected_assets != expected_texts * 5:
        raise ValueError("invalid declared speech coverage")
    allowed_files = {"manifest.json"}
    coverage = {}
    previews = set()
    total_bytes = 0
    for group in ("assets", "previews"):
        entries = manifest.get(group)
        if not isinstance(entries, list) or not entries or len(entries) > 100_000:
            raise ValueError("missing audio entries: " + group)
        if group == "previews" and len(entries) != 5:
            raise ValueError("exactly five voice previews are required")
        for entry in entries:
            if not isinstance(entry, dict):
                raise ValueError("invalid audio entry")
            voice = entry.get("voiceId")
            text = entry.get("originalText")
            text_key = entry.get("textKey", "")
            digest = entry.get("sha256", "")
            if not isinstance(voice, str) or voice not in voice_ids or not isinstance(text, str) or not text or js_length(text) > 20_000:
                raise ValueError("invalid audio identity")
            if hashlib.sha256(text.encode("utf-8")).hexdigest() != text_key:
                raise ValueError("original text hash mismatch")
            if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
                raise ValueError("invalid content hash")
            if entry.get("spokenText") != text.replace("____", "blank"):
                raise ValueError("unexpected speech preprocessing")
            if entry.get("format") != "mp3" or entry.get("sampleRate") != 24000:
                raise ValueError("unexpected audio format")
            duration = entry.get("duration")
            if type(duration) not in (float, int) or not math.isfinite(duration) or not 0 < duration <= 300:
                raise ValueError("invalid audio duration")
            if entry.get("qaStatus") != "passed":
                raise ValueError("unreviewed audio cannot be deployed")
            prefix = "voices" if group == "assets" else "previews"
            relative = f"{prefix}/{voice}/{text_key}.mp3"
            if entry.get("path") != relative or relative in allowed_files:
                raise ValueError("invalid or duplicate audio path")
            candidate = root / relative
            if any(p.is_symlink() for p in (candidate, candidate.parent, candidate.parent.parent)):
                raise ValueError("audio symlinks are not allowed")
            if not candidate.is_file() or not 0 < candidate.stat().st_size <= 16 * 1024 * 1024:
                raise ValueError("missing or oversized audio file")
            if candidate.stat().st_nlink != 1:
                raise ValueError("audio hard links are not allowed")
            with candidate.open("rb") as stream:
                checksum = hashlib.sha256()
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    checksum.update(block)
                content_hash = checksum.hexdigest()
            if content_hash != digest:
                raise ValueError("audio checksum mismatch: " + relative)
            total_bytes += candidate.stat().st_size
            allowed_files.add(relative)
            if group == "assets":
                coverage.setdefault(text_key, set()).add(voice)
            elif voice in previews:
                raise ValueError("duplicate voice preview")
            else:
                previews.add(voice)
    if previews != voice_ids or any(ids != voice_ids for ids in coverage.values()):
        raise ValueError("every text and preview must have all five voices")
    if len(coverage) != expected_texts or len(manifest["assets"]) != expected_assets:
        raise ValueError("incomplete declared speech coverage")
    # No hidden executable, secret, extra metadata, device, or links enter the release.
    for candidate in root.rglob("*"):
        if candidate.is_symlink() or not (candidate.is_file() or candidate.is_dir()):
            raise ValueError("non-regular bundle content")
        if candidate.is_file() and candidate.relative_to(root).as_posix() not in allowed_files:
            raise ValueError("unlisted bundle file: " + candidate.relative_to(root).as_posix())
    return {"voices": 5, "texts": len(coverage), "assets": len(manifest["assets"]),
            "previews": len(previews), "bytes": total_bytes,
            "manifestSha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest()}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("usage: verify-speech-audio.py <bundle-directory>")
        print(json.dumps(verify(sys.argv[1]), sort_keys=True))
    except (ValueError, OSError, TypeError, KeyError) as error:
        print("Invalid speech audio bundle: " + str(error), file=sys.stderr)
        sys.exit(1)
