"""Generate and persist a strong Wentian API key for the current user."""
from __future__ import annotations
import argparse
import os
from pathlib import Path
import secrets
import subprocess
import sys


def main() -> int:
    """Use the Windows user environment store, or print a shell export elsewhere."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="replace an existing key")
    args = parser.parse_args()
    if os.name == "nt":
        script = os.path.join(os.path.dirname(__file__), "generate-api-key.ps1")
        command = ["pwsh", "-NoProfile", "-File", script]
        if args.force:
            command.append("-Force")
        return subprocess.run(command, check=False).returncode
    profile = Path.home() / (".zprofile" if sys.platform == "darwin" else ".profile")
    current = profile.read_text(encoding="utf-8") if profile.exists() else ""
    if "WENTIAN_API_KEY=" in current and not args.force:
        parser.error("WENTIAN_API_KEY already exists in the user profile; pass --force to replace it")
    key = secrets.token_urlsafe(48)
    lines = [line for line in current.splitlines() if not line.lstrip().startswith("export WENTIAN_API_KEY=")]
    lines.append(f"export WENTIAN_API_KEY='{key}'")
    profile.write_text("\n".join(lines) + "\n", encoding="utf-8")
    try:
        profile.chmod(0o600)
    except OSError:
        pass
    os.environ["WENTIAN_API_KEY"] = key
    print("WENTIAN_API_KEY configured in the current user's shell profile. Restart the shell and Wentian to apply it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
