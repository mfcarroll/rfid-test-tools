#!/usr/bin/env python3
"""Stamp each page's scripts and stylesheet with a hash of their contents, so a browser never mixes a new page
with old cached modules (GitHub Pages lets browsers keep a file for 10 minutes).

    python3 stamp_versions.py                  # rewrite the pages
    python3 stamp_versions.py --check          # exit 1 if a page is out of date (run before pushing)
    python3 stamp_versions.py --page-version   # the deploy workflow: also write HEAD into common/version.js

Each page's module script (<script type="module" src="main.js">) and stylesheet links get "?v=<hash>". The page
also gets an import map that sends every module the script imports, imports of imports included, to
"<module>?v=<hash>". A file's URL changes only when the file does.

--page-version writes HEAD's number on main, hash and UTC commit time into common/version.js before stamping, for
the pages' footer. A commit can't hold its own hash, so only the deploy workflow does this, on the copy it
publishes. --check fails if common/version.js is stamped, so a stamped copy never reaches git.
"""

import datetime
import hashlib
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
IMPORT = re.compile(r"""(?:\bimport\b[^"';]*?\bfrom\s*|\bimport\s*|\bexport\b[^"';]*?\bfrom\s*)["'](\.{1,2}/[^"']+)["']""")
MODULE_SCRIPT = re.compile(r'(<script type="module" src=")([^"?]+)(?:\?v=[0-9a-f]+)?("></script>)')
IMPORT_MAP = re.compile(r'\n?( *)<script type="importmap">.*?</script>', re.S)
STYLESHEET = re.compile(r'(<link rel="stylesheet" href=")([^"?]+)(?:\?v=[0-9a-f]+)?(")')
PAGE_VERSION = os.path.join(ROOT, "common", "version.js")
UNSTAMPED = "export const PAGE = null;"


def file_hash(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()[:10]


def module_graph(scripts):
    """Every local module the page's module scripts import, directly or not. The scripts themselves are left out."""
    found, pending = set(), list(scripts)
    while pending:
        path = pending.pop()
        if path in found or not os.path.isfile(path):
            continue
        found.add(path)
        with open(path, encoding="utf-8") as f:
            text = f.read()
        pending += [os.path.normpath(os.path.join(os.path.dirname(path), spec)) for spec in IMPORT.findall(text)]
    return sorted(found - set(scripts))


def stamp(page):
    page_dir = os.path.dirname(page)
    with open(page, encoding="utf-8") as f:
        html = f.read()
    stamped = IMPORT_MAP.sub("", html)

    def stamp_link(match):
        target = os.path.normpath(os.path.join(page_dir, match.group(2)))
        return f"{match.group(1)}{match.group(2)}?v={file_hash(target)}{match.group(3)}"

    stamped = STYLESHEET.sub(stamp_link, stamped)
    stamped = MODULE_SCRIPT.sub(stamp_link, stamped)
    scripts = [os.path.normpath(os.path.join(page_dir, m.group(2))) for m in MODULE_SCRIPT.finditer(stamped)]
    modules = module_graph(scripts)
    if modules:
        entries = []
        script = MODULE_SCRIPT.search(stamped)
        indent = re.search(r"( *)<script type=\"module\"", stamped).group(1)
        for path in modules:
            url = os.path.relpath(path, page_dir)
            url = url if url.startswith(".") else "./" + url
            entries.append(f'{indent}      "{url}": "{url}?v={file_hash(path)}"')
        import_map = (
            f'{indent}<script type="importmap">\n{indent}  {{\n{indent}    "imports": {{\n'
            + ",\n".join(entries)
            + f"\n{indent}    }}\n{indent}  }}\n{indent}</script>\n"
        )
        start = stamped.rfind("\n", 0, script.start()) + 1
        stamped = stamped[:start] + import_map + stamped[start:]
    return html, stamped


def write_page_version():
    git = lambda *args: subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True, text=True).stdout.strip()
    commit = git("rev-parse", "HEAD")
    number = int(git("rev-list", "--count", "HEAD"))
    time = datetime.datetime.fromtimestamp(int(git("log", "-1", "--format=%ct", "HEAD")), datetime.timezone.utc)
    stamped = f'export const PAGE = {{ number: {number}, commit: "{commit}", time: "{time:%Y-%m-%dT%H:%M:%SZ}" }};'
    with open(PAGE_VERSION, encoding="utf-8") as f:
        text = f.read()
    if UNSTAMPED not in text:
        sys.exit(f"{PAGE_VERSION} has no '{UNSTAMPED}' line to stamp")
    with open(PAGE_VERSION, "w", encoding="utf-8") as f:
        f.write(text.replace(UNSTAMPED, stamped))
    print(f"page version: {number} ({commit[:7]}, {time:%Y-%m-%d %H:%M} UTC)")


def main():
    check = "--check" in sys.argv[1:]
    if "--page-version" in sys.argv[1:]:
        write_page_version()
    stale = []
    for directory, _, files in os.walk(ROOT):
        # Hidden folders and node_modules hold no pages. Test the path below ROOT, which may itself sit in a hidden
        # folder such as a .claude/worktrees checkout.
        parts = os.path.relpath(directory, ROOT).split(os.sep)
        if any(p.startswith(".") and p != "." for p in parts) or "node_modules" in parts:
            continue
        if "index.html" in files:
            page = os.path.join(directory, "index.html")
            html, stamped = stamp(page)
            if html != stamped:
                stale.append(os.path.relpath(page, ROOT))
                if not check:
                    with open(page, "w", encoding="utf-8") as f:
                        f.write(stamped)
    for page in stale:
        print(("out of date: " if check else "stamped: ") + page)
    if check:
        with open(PAGE_VERSION, encoding="utf-8") as f:
            if UNSTAMPED not in f.read():
                stale.append(PAGE_VERSION)
                print(f"stamped by --page-version, restore it with git: {os.path.relpath(PAGE_VERSION, ROOT)}")
    return 1 if check and stale else 0


if __name__ == "__main__":
    sys.exit(main())
