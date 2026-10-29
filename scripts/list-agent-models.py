"""Agentの既存設定から、モデル名・プロバイダー名だけを読み取ります。

認証ファイル、会話履歴、APIキー、接続URLは出力しません。設定は変更せず、
一覧取得専用の補助処理としてTypeScriptとPowerShellから共通利用します。
"""
from __future__ import annotations
import argparse
import json
import os
import re
import tomllib
from pathlib import Path
from importlib.util import spec_from_file_location, module_from_spec


def list_models(agent: str, home: Path) -> list[dict]:
    """既知スキーマのモデル項目だけを扱い、任意の文字列を候補にしません。"""
    spec = spec_from_file_location("connection_bridge", Path(__file__).with_name("maintain-agent-connection.py"))
    bridge = module_from_spec(spec)
    spec.loader.exec_module(bridge)
    found: dict[tuple[str, str], dict] = {}

    def add(model, provider=None):
        # これはモデル識別子の入力検証であり、自然言語の意図分類ではありません。
        if isinstance(model, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9/_.:@+\-]{0,255}", model):
            provider = provider if isinstance(provider, str) and re.fullmatch(r"[A-Za-z0-9_.-]+", provider) else None
            found[(provider or "", model)] = {"model": model, **({"provider": provider} if provider else {})}

    if agent == "codex":
        source = Path(os.environ.get("CODEX_HOME", str(home / ".codex"))) / "config.toml"
        if source.exists():
            value = tomllib.loads(source.read_text(encoding="utf-8-sig"))
            add(value.get("model"), value.get("model_provider"))
        return list(found.values())

    sources = bridge.targets(home, agent)
    if agent == "goose":
        sources += list((home / "AppData/Roaming/Block/goose/config/custom_providers").glob("*.json"))
    for source in sorted(set(sources)):
        if not source.is_file():
            continue
        try:
            value = bridge.parse_settings(source, source.read_bytes())
        except (ValueError, OSError):
            continue
        if agent == "goose":
            provider = value.get("GOOSE_PROVIDER") or value.get("active_provider")
            add(value.get("GOOSE_MODEL"), provider)
            for name, item in value.get("providers", {}).items():
                if isinstance(item, dict):
                    add(item.get("model"), name)
                    for model in item.get("models", []):
                        add(model.get("name") if isinstance(model, dict) else model, name)
            for item in value.get("models", []):
                add(item.get("name") if isinstance(item, dict) else item, value.get("name"))
        elif agent == "claude":
            add(value.get("model"))
            env = value.get("env", {})
            for name in ("ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"):
                add(env.get(name))
        elif agent == "hermes":
            model = value.get("model")
            add(model.get("default"), model.get("provider")) if isinstance(model, dict) else add(model)
        elif agent == "crush":
            for entry in value.get("models", {}).values():
                if isinstance(entry, dict):
                    model, provider = entry.get("model"), entry.get("provider")
                    add(f"{provider}/{model}" if provider and model else model)
            for provider, entry in value.get("providers", {}).items():
                if isinstance(entry, dict):
                    for model in entry.get("models", []):
                        model = model.get("id") if isinstance(model, dict) else model
                        if isinstance(model, str):
                            add(f"{provider}/{model}")
        elif agent == "openclaw":
            providers = value.get("models", {}).get("providers", {}) or value.get("providers", {})
            for provider, entry in providers.items():
                for model in entry.get("models", []):
                    add(f"{provider}/{model['id']}" if isinstance(model, dict) and model.get("id") else None)
        elif agent in ("opencode", "kilo"):
            add(value.get("model"))
    return list(found.values())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent", required=True)
    parser.add_argument("--home", type=Path, default=Path.home())
    args = parser.parse_args()
    print(json.dumps({"models": list_models(args.agent, args.home)}, ensure_ascii=False))
