#!/usr/bin/env python3
"""Check public package structure, local links and high-confidence privacy leaks."""
import json
import re
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
EXCLUDED = {".git", "node_modules", ".wrangler", "__pycache__", ".build", ".local-demo"}
REQUIRED = ["README.md", "AGENTS.md", "LICENSE", "NOTICE.md", "verification.md",
            "voting-snapshot/README.md", "voting-snapshot/src/worker.js",
            "original-voting-site/README.md", "original-voting-site/api/worker.js",
            "original-voting-site/source-manifest.json"]


def main():
    issues = []
    for name in REQUIRED:
        if not (ROOT / name).is_file():
            issues.append(f"Missing deliverable: {name}")
    checked = 0
    for path in ROOT.rglob("*"):
        if not path.is_file() or EXCLUDED.intersection(path.relative_to(ROOT).parts):
            continue
        if path.suffix not in {".md", ".json", ".jsonc", ".py", ".js", ".mjs", ".html", ".svg", ".yaml", ".yml", ".sql"}:
            continue
        checked += 1
        content = path.read_text()
        if path.name == "check_package.py":
            continue
        for marker in ("/Users/keikurosawa", "crazycthun@gmail", "asperformias000@", "login_challenge=", "creem_sk_"):
            if marker in content:
                issues.append(f"Private marker {marker!r} in {path.relative_to(ROOT)}")
        if path.suffix == ".json":
            try:
                json.loads(content)
            except ValueError as error:
                issues.append(f"Invalid JSON {path.relative_to(ROOT)}: {error}")
        if path.suffix == ".md":
            for raw in re.findall(r"!?\[[^\]]*\]\(([^)]+)\)", content):
                target = raw.strip().split(' "', 1)[0].strip("<>")
                if re.match(r"^[a-z][a-z0-9+.-]*:", target) or target.startswith("#"):
                    continue
                local = unquote(target.split("#", 1)[0])
                if local and not (path.parent / local).exists():
                    issues.append(f"Broken relative link in {path.relative_to(ROOT)}: {target}")
    if issues:
        print("\n".join(issues))
        raise SystemExit(1)
    print(f"Package checks passed: {checked} text artifacts, all required deliverables and local links.")
    print("Privacy scan is limited and heuristic; public facts were separately assembled from an allowlist.")


if __name__ == "__main__":
    main()
