#!/usr/bin/env python3
"""Syntax and import check for static/js without node (macOS only).

    python3 tests/check_js.py

Each module's import/export lines are stripped and the rest is parsed with
JavaScriptCore via `osascript -l JavaScript` + `new Function()`, which can't
parse module syntax itself. Named imports are checked against the target
module's exports."""
import glob
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "js")
EXPORT_DECL = re.compile(r"^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)", re.M)
EXPORT_LIST = re.compile(r"^export\s*\{([^}]*)\}", re.M)
NAMED_IMPORT = re.compile(r'import\s*\{([^}]*)\}\s*from\s*"([^"]+)"', re.S)
STAR_IMPORT = re.compile(r'import\s*\*\s*as\s*\w+\s*from\s*"([^"]+)"')


def exports_of(src):
    names = set(EXPORT_DECL.findall(src))
    for group in EXPORT_LIST.findall(src):
        names.update(p.split(" as ")[-1].strip() for p in group.split(",") if p.strip())
    return names


def parse_error(body):
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as tmp:
        tmp.write(body)
    try:
        script = (f'var s=$.NSString.stringWithContentsOfFileEncodingError("{tmp.name}",4,null).js;'
                  'try{new Function(s);"ok"}catch(e){e.toString()}')
        out = subprocess.run(["osascript", "-l", "JavaScript", "-e", script],
                             capture_output=True, text=True).stdout.strip()
    finally:
        os.unlink(tmp.name)
    return None if out == "ok" else out


def main():
    files = sorted(glob.glob(os.path.join(ROOT, "**", "*.js"), recursive=True))
    sources = {f: open(f, encoding="utf-8").read() for f in files}
    exports = {f: exports_of(src) for f, src in sources.items()}
    problems = []
    for f, src in sources.items():
        rel = os.path.relpath(f, ROOT)
        resolve = lambda path: os.path.normpath(os.path.join(os.path.dirname(f), path))
        for names, path in NAMED_IMPORT.findall(src):
            target = resolve(path)
            if target not in exports:
                problems.append(f"{rel}: missing module {path}")
                continue
            for name in names.split(","):
                name = name.strip().split(" as ")[0].strip()
                if name and name not in exports[target]:
                    problems.append(f"{rel}: {path} has no export {name}")
        for path in STAR_IMPORT.findall(src):
            if resolve(path) not in exports:
                problems.append(f"{rel}: missing module {path}")
        body = re.sub(r"^import\b[^;]*;", "", src, flags=re.M)
        body = re.sub(r"^export\s*\{[^}]*\};?", "", body, flags=re.M)
        body = re.sub(r"^export\s+(default\s+)?", "", body, flags=re.M)
        error = parse_error(body)
        if error:
            problems.append(f"{rel}: {error}")
    for p in problems:
        print(p)
    print(f"checked {len(files)} files; {len(problems)} problems")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
