#!/usr/bin/env python3
"""Remove one legacy, dedicated English-site block from a Caddyfile.

The rest of the input is emitted byte-for-byte. A shared/multi-host block is
rejected rather than edited because changing it could affect another site.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

DOMAIN = "english-47-120-37-63.sslip.io"
HEADER = re.compile(
    rf"^\s*(?:https?://)?{re.escape(DOMAIN)}(?::(?:80|443))?\s*\{{\s*(?:#.*)?$"
)


def brace_delta(line: str) -> int:
    delta = 0
    quoted = False
    escaped = False
    for char in line:
        if escaped:
            escaped = False
            continue
        if char == "\\" and quoted:
            escaped = True
            continue
        if char == '"':
            quoted = not quoted
            continue
        if char == "#" and not quoted:
            break
        if not quoted:
            if char == "{":
                delta += 1
            elif char == "}":
                delta -= 1
    return delta


class RewriteError(ValueError):
    pass


def rewrite(lines: list[str]) -> str:
    output: list[str] = []
    removing = False
    depth = 0
    removed = 0

    for line in lines:
        visible = line.split("#", 1)[0]
        if not removing and HEADER.match(line.rstrip("\r\n")):
            removed += 1
            if removed > 1:
                raise RewriteError("multiple dedicated legacy site blocks found; refusing automatic edit")
            removing = True
            depth = brace_delta(line)
            if depth <= 0:
                removing = False
            continue

        if removing:
            depth += brace_delta(line)
            if depth < 0:
                raise RewriteError("unbalanced legacy site block")
            if depth == 0:
                removing = False
            continue

        if DOMAIN in visible:
            raise RewriteError(
                "the English hostname appears outside a dedicated single-host block; "
                "refusing to risk another site"
            )
        output.append(line)

    if removing:
        raise RewriteError("unterminated legacy site block")

    return "".join(output)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: rewrite-caddy.py /etc/caddy/Caddyfile", file=sys.stderr)
        return 2

    source = Path(sys.argv[1])
    if source != Path("/etc/caddy/Caddyfile"):
        print("refusing to read a non-canonical Caddyfile path", file=sys.stderr)
        return 2

    lines = source.read_text(encoding="utf-8").splitlines(keepends=True)
    try:
        rewritten = rewrite(lines)
    except RewriteError as error:
        print(str(error), file=sys.stderr)
        return 3

    sys.stdout.write(rewritten)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
