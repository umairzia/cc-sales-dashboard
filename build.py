#!/usr/bin/env python3
"""Inline src/ + vendor/ into one self-contained, offline dashboard.html.

    python3 build.py            # writes ./dashboard.html
    python3 build.py --check    # exits 1 if dashboard.html is out of date

The build is deterministic (no timestamps) so the committed dashboard.html only
changes when the source does. It also refuses to emit a file that references
anything over the network.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
OUT = ROOT / "dashboard.html"

# Strict Content-Security-Policy for the built file: no network of any kind.
# connect-src 'none' blocks fetch/XHR/WebSocket; img-src allows only the
# in-page canvas patterns; scripts and styles must be inline (they are).
CSP = (
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
    "img-src data: blob:; font-src 'none'; connect-src 'none'; media-src 'none'; "
    "object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'"
)

SCRIPT_RE = re.compile(r'<script src="([^"]+)"></script>')
STYLE_RE = re.compile(r'<link rel="stylesheet" href="([^"]+)">')
EXTERNAL_RE = re.compile(
    r"""(?:\b(?:src|href|action|poster|data)\s*=\s*["']?\s*(?:https?:)?//)"""
    r"""|(?:\bfetch\s*\(\s*["'`]\s*(?:https?:)?//)"""
    r"""|(?:@import\s+(?:url\()?["']?\s*(?:https?:)?//)"""
    r"""|(?:url\(\s*["']?\s*(?:https?:)?//)""",
    re.IGNORECASE,
)


def read(rel: str) -> str:
    path = (SRC / rel).resolve()
    if ROOT not in path.parents:
        raise SystemExit(f"refusing to inline a file outside the repo: {rel}")
    return path.read_text(encoding="utf-8")


def inline_script(js: str) -> str:
    # A literal "</script" inside JS would end the inline element early.
    return js.replace("</script", "<\\/script")


def build() -> str:
    html = read("index.html")
    html = html.replace(
        "<!-- build:csp -->",
        f'<meta http-equiv="Content-Security-Policy" content="{CSP}">',
    )
    html = STYLE_RE.sub(lambda m: "<style>\n" + read(m.group(1)) + "</style>", html)
    html = SCRIPT_RE.sub(lambda m: "<script>\n" + inline_script(read(m.group(1))) + "\n</script>", html)

    leftovers = SCRIPT_RE.findall(html) + STYLE_RE.findall(html)
    if leftovers:
        raise SystemExit(f"un-inlined assets remain: {leftovers}")
    hits = sorted({m.group(0) for m in EXTERNAL_RE.finditer(html)})
    if hits:
        raise SystemExit(f"external references found in build output: {hits}")
    return html


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="fail if dashboard.html is stale")
    args = ap.parse_args()
    html = build()
    if args.check:
        current = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        if current != html:
            print("dashboard.html is out of date: run python3 build.py", file=sys.stderr)
            return 1
        print("dashboard.html is up to date")
        return 0
    OUT.write_text(html, encoding="utf-8", newline="\n")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(html.encode('utf-8')) / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
