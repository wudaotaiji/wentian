"""自動保守から呼び出す、エージェント接続設定の検査・更新用ブリッジです。

単一エージェントの既知の設定だけを対象にし、既定では変更案と指紋を返します。
--apply時には元設定をバックアップしてから反映します。秘密値は出力しません。
無料モデルの実際の提供状況と応答確認は呼出元のTypeScriptが担当します。
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import os
import tomllib
from urllib.parse import urlsplit
from datetime import datetime
from pathlib import Path
try:
    import yaml
except ModuleNotFoundError as error:
    # 原因と復旧手順を明示し、設定変更に入る前に停止します。
    raise SystemExit("ModuleNotFoundError: PyYAML / yaml が未導入です。py -3 -m pip install -r scripts/requirements-agent-maintenance.txt を実行してください。") from error

AGENTS = {"goose", "claude", "crush", "opencode", "kilo", "cline", "hermes", "openclaw", "codex"}


def parse_jsonc(text: str) -> dict:
    """JSONCの文字列を保護してコメントを除き、末尾カンマを許容して解析します。"""
    output, index, in_string, escaped, line_comment, block_comment = [], 0, False, False, False, False
    while index < len(text):
        char = text[index]
        following = text[index + 1] if index + 1 < len(text) else ""
        if line_comment:
            if char in "\r\n":
                line_comment = False
                output.append(char)
            index += 1
            continue
        if block_comment:
            if char == "*" and following == "/":
                block_comment = False
                index += 2
            else:
                index += 1
            continue
        if in_string:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            output.append(char)
        elif char == "/" and following == "/":
            line_comment = True
            index += 2
            continue
        elif char == "/" and following == "*":
            block_comment = True
            index += 2
            continue
        else:
            output.append(char)
        index += 1
    # コメントを除いたJSONの末尾カンマのみを取り除きます。
    import re
    return json.loads(re.sub(r",\s*([}\]])", r"\1", "".join(output)))


def parse_settings(source: Path, raw: bytes) -> dict:
    """整形だけの変化と実設定の変化を区別するため、構造として解析します。"""
    text = raw.decode("utf-8-sig")
    if source.suffix == ".toml":
        return tomllib.loads(text)
    return (yaml.safe_load(text) or {}) if source.suffix == ".yaml" else parse_jsonc(text)


MISSING = object()


def restore_fields(before, applied, current):
    """保守が変更した項目だけを三者比較し、無関係なCLI更新は保持します。"""
    if before == applied or current == before:
        return current
    if isinstance(applied, dict) and isinstance(current, dict) and (isinstance(before, dict) or before is MISSING):
        original = before if isinstance(before, dict) else {}
        result = copy.deepcopy(current)
        for key in set(original) | set(applied):
            restored = restore_fields(original.get(key, MISSING), applied.get(key, MISSING), current.get(key, MISSING))
            if restored is MISSING:
                result.pop(key, None)
            else:
                result[key] = restored
        return result
    if current != applied:
        raise RuntimeError("接続設定の並行変更を検出したため復元を停止しました。")
    return copy.deepcopy(before) if before is not MISSING else MISSING


def targets(home: Path, agent: str) -> list[Path]:
    """履歴・認証秘密ファイルを除き、対応済みの接続設定を列挙します。"""
    fixed = {
        "codex": [str(Path(os.environ.get("CODEX_HOME", str(home / ".codex"))) / "config.toml")],
        "goose": ["AppData/Roaming/Block/goose/config/config.yaml", "AppData/Roaming/Block/goose/config/custom_providers/wentian-local.json"],
        "claude": [".claude/settings.json"],
        "crush": ["AppData/Local/crush/crush.json"],
        "opencode": [".config/opencode/opencode.jsonc"], "kilo": [".config/kilo/kilo.jsonc"],
        "cline": [".cline/data/settings/providers.json", ".cline/data/globalState.json"],
        "hermes": ["AppData/Local/hermes/config.yaml", ".hermes/config.yaml"],
        "openclaw": [".openclaw/openclaw.json", ".openclaw/agents/main/agent/models.json"],
    }
    paths = [home / p for p in fixed[agent]]
    if agent == "openclaw":
        paths += list((home / ".openclaw/agents").glob("*/agent/models.json"))
    if agent == "claude":
        # ローカルモデル用プロファイルを奪わず、ローカルLLM用プロファイルのみ整合させます。
        for p in (home / ".claude").glob("settings*.json"):
            if p in paths:
                continue
            try:
                value = parse_jsonc(p.read_text(encoding="utf-8-sig"))
                if "127.0.0.1" in value.get("env", {}).get("ANTHROPIC_BASE_URL", ""):
                    paths.append(p)
            except (ValueError, OSError):
                pass
    return sorted(set(paths))


def configure(value: dict, agent: str, source: Path, mode: str, model: str, base_url: str, gateway: bool = False) -> dict:
    """各CLIのスキーマに従い、主モデルと補助モデルの接続先を整合させます。"""
    result = copy.deepcopy(value)
    # Agent本来の接続を使う場合は認証・プロバイダー設定を保持し、モデルは起動引数で指定します。
    if mode == "native":
        return result
    if agent == "codex":
        raise ValueError("Codexは現在のネイティブ接続のモデルだけを選択できます。")
    endpoint = base_url.rstrip("/")
    # Gateway（ゲートウェイ / Gateway）の認証値は環境から取得し、コマンド引数や応答へ出しません。
    api_key = os.environ.get("WENTIAN_API_KEY", "dummy") if gateway else "dummy"
    if agent in {"opencode", "kilo"}:
        result["model"] = model if mode != "local" else "wentian-local/" + model
        # タイトル生成や要約の補助モデルが有料モデルへ戻らないよう同じ候補に固定します。
        result["small_model"] = result["model"]
        if mode == "local":
            result.setdefault("provider", {})["wentian-local"] = {"npm": "@ai-sdk/openai-compatible", "name": "Wentian" if gateway else "LM Studio", "options": {"baseURL": endpoint, "apiKey": api_key}, "models": {model: {"name": model, "limit": {"context": 131072, "output": 8192}}}}
    elif agent == "claude":
        env = result.setdefault("env", {})
        env["ANTHROPIC_BASE_URL"] = endpoint.removesuffix("/v1")
        # 認証不要の上流でもSDKの初期化には空でない値が必要な場合があります。
        env["ANTHROPIC_AUTH_TOKEN"] = api_key
        for key in ("ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"):
            env[key] = model
        env["CLAUDE_CODE_EFFORT_LEVEL"] = "medium"
        result.update(model=model, effortLevel="medium")
    elif agent == "goose":
        if source.suffix == ".yaml":
            result["active_provider"] = "wentian-local"
            # CLIとデスクトップの両方で既定モデルを揃えます。
            # 実行コマンドにもモデルを渡し、古い環境設定への暗黙の復帰を防ぎます。
            if "GOOSE_PROVIDER" in result:
                result["GOOSE_PROVIDER"] = "wentian-local"
            if "GOOSE_MODEL" in result:
                result["GOOSE_MODEL"] = model
            result.setdefault("providers", {}).setdefault("wentian-local", {})["model"] = model
        else:
            result.update(name="wentian-local", engine="openai", display_name="Wentian" if gateway else "LM Studio", base_url=endpoint, requires_auth=False, supports_streaming=True)
            result["models"] = [{"name": model, "context_limit": 32768, "reasoning": False}]
    elif agent == "hermes":
        result["model"] = {**(result.get("model") if isinstance(result.get("model"), dict) else {}), "default": model, "provider": "custom", "base_url": endpoint}
        result.setdefault("providers", {})["wentian-internal"] = {"base_url": endpoint, "api_key": api_key}
        # 主接続失敗時に、別の有料サービスへ自動迂回する設定は使用しません。
        result.pop("fallback_model", None)
        result.pop("fallback_providers", None)
    elif agent == "openclaw":
        provider = {"baseUrl": endpoint, "api": "openai-completions", "apiKey": api_key, "models": [{"id": model, "name": model, "contextWindow": 131072, "maxTokens": 8192, "input": ["text"]}]}
        if source.name == "openclaw.json":
            result.setdefault("models", {}).setdefault("providers", {})["wentian-local"] = provider
            result.setdefault("agents", {}).setdefault("defaults", {})["model"] = {"primary": "wentian-local/" + model}
            for item in result.get("agents", {}).get("list", []):
                item["model"] = {"primary": "wentian-local/" + model}
        else:
            result.setdefault("providers", {})["wentian-local"] = provider
    elif agent == "crush":
        provider, name = model.split("/", 1) if mode != "local" else ("wentian-local", model)
        if mode == "local":
            result.setdefault("providers", {})[provider] = {"type": "openai-compat", "base_url": endpoint, "api_key": api_key, "models": [{"id": model, "name": model, "context_window": 131072, "default_max_tokens": 8192, "cost_per_1m_in": 0, "cost_per_1m_out": 0}]}
        for size in ("large", "small"):
            result.setdefault("models", {})[size] = {"model": name, "provider": provider, "max_tokens": 8192}
    elif agent == "cline":
        provider = "cline" if mode == "free" else "openai"
        if source.name == "providers.json":
            result["lastUsedProvider"] = provider
            entry = result.setdefault("providers", {}).setdefault(provider, {})
            entry.setdefault("settings", {}).update(provider=provider, model=model)
            if mode == "local":
                entry["settings"]["baseUrl"] = endpoint
                entry["settings"]["apiKey"] = api_key
        else:
            for prefix in ("actMode", "planMode"):
                result[prefix + "ApiProvider"] = provider
                result[prefix + ("ClineModelId" if mode == "free" else "OpenAiModelId")] = model
            if mode == "local":
                result["openAiBaseUrl"] = endpoint
    return result


def main() -> None:
    """変更前後の指紋を返し、必要な場合だけ安全な退避・反映を行います。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent", required=True, choices=sorted(AGENTS))
    parser.add_argument("--mode", required=True, choices=["free", "local", "native"])
    parser.add_argument("--gateway", action="store_true", help="Wentian内部モデルとGateway認証を使用します。")
    parser.add_argument("--model", required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:1234/v1")
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument("--report-root", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--rollback", type=Path)
    args = parser.parse_args()
    if args.rollback:
        # 復元対象は、このエージェントの設定と保守専用バックアップ内に限定します。
        backup = args.rollback.resolve()
        if not backup.is_relative_to(args.report_root.resolve()):
            raise ValueError("保守領域外のバックアップを拒否しました。")
        manifest = json.loads((backup / "manifest.json").read_text(encoding="utf-8"))
        allowed = {p.resolve() for p in targets(args.home, args.agent)}
        restores = []
        for item in manifest:
            source = Path(item["path"]).resolve()
            if source not in allowed:
                raise ValueError("対応設定外の復元を拒否しました。")
            current = source.read_bytes()
            saved = (backup / item["backup"]).resolve() if item["backup"] else None
            if saved and saved.parent != backup:
                raise ValueError("不正な退避ファイルを拒否しました。")
            restored_raw = saved.read_bytes() if saved else None
            if hashlib.sha256(current).hexdigest() != item["appliedHash"]:
                applied = (backup / item.get("applied", "missing")).resolve()
                # CLIによる改行・インデント・キー順序の整形は、設定変更と区別します。
                if applied.parent != backup or not applied.is_file():
                    raise RuntimeError("設定の並行変更を検出したため復元を停止しました。")
                current_value, applied_value = parse_settings(source, current), parse_settings(source, applied.read_bytes())
                if current_value != applied_value:
                    result = restore_fields(parse_settings(source, restored_raw) if restored_raw is not None else {}, applied_value, current_value)
                    restored_raw = (yaml.safe_dump(result, allow_unicode=True, sort_keys=False) if source.suffix == ".yaml" else json.dumps(result, ensure_ascii=False, indent=2) + "\n").encode("utf-8") if result or saved else None
            restores.append((source, current, restored_raw))
        for source, expected, restored_raw in restores:
            # 三者比較後に追加の並行変更があれば、そのファイルを上書きしません。
            if source.read_bytes() != expected:
                raise RuntimeError("設定の並行変更を検出したため復元を停止しました。")
            if restored_raw is not None:
                temp = source.with_name(source.name + ".wentian-maintenance.tmp")
                temp.write_bytes(restored_raw); os.replace(temp, source)
            else:
                source.unlink()
        print(json.dumps({"restored": True}))
        return
    # 誤って有料モデルを保守処理へ渡した場合にも、設定変更の前に拒否します。
    if args.mode == "free" and not (args.model.endswith(("-free", ":free", "/free")) or args.model.startswith("cline-free/")):
        raise ValueError("無料モデルと確認できないIDを拒否しました。")
    # ローカル推論サーバー（Local Inference Server）のみ許可します。
    # ポートは利用者が選択でき、OllamaとLM Studioを同じ手順で設定できます。
    endpoint = urlsplit(args.base_url)
    if endpoint.scheme not in ("http", "https") or endpoint.hostname not in ("127.0.0.1", "localhost", "::1") or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment or endpoint.path.rstrip("/") != "/v1":
        raise ValueError("認証情報を含まないローカルLLMの /v1 接続先を指定してください。")
    plans, digest = [], hashlib.sha256()
    for source in targets(args.home, args.agent):
        raw = source.read_bytes() if source.exists() else None
        text = raw.decode("utf-8-sig") if raw is not None else "{}"
        value = parse_settings(source, raw) if raw is not None else {}
        result = configure(value, args.agent, source, args.mode, args.model, args.base_url, args.gateway)
        # 意味が同一ならYAMLのコメントや既存の整形を保持します。
        rendered = text if result == value else (yaml.safe_dump(result, allow_unicode=True, sort_keys=False) if source.suffix == ".yaml" else json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        digest.update(str(source).encode()); digest.update(json.dumps(value, sort_keys=True, ensure_ascii=False).encode("utf-8"))
        if rendered != text:
            plans.append((source, raw, rendered))
    backup = None
    if args.apply and plans:
        backup = args.report_root / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        backup.mkdir(parents=True, exist_ok=False)
        manifest = []
        for index, (source, raw, rendered) in enumerate(plans):
            if (source.read_bytes() if source.exists() else None) != raw:
                raise RuntimeError("設定の並行変更を検出したため停止しました。")
            backup_name = f"{index:02d}.backup"
            applied_name = f"{index:02d}.applied"
            if raw is not None:
                (backup / backup_name).write_bytes(raw)
            (backup / applied_name).write_bytes(rendered.encode("utf-8"))
            manifest.append({"path": str(source), "backup": backup_name if raw is not None else None, "applied": applied_name, "appliedHash": hashlib.sha256(rendered.encode("utf-8")).hexdigest()})
            # 途中の反映が失敗しても、変更済みファイルを戻せる台帳を先に保存します。
            (backup / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
            source.parent.mkdir(parents=True, exist_ok=True)
            temp = source.with_name(source.name + ".wentian-maintenance.tmp")
            temp.write_bytes(rendered.encode("utf-8")); os.replace(temp, source)
        (backup / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.apply:
        digest = hashlib.sha256()
        for source in targets(args.home, args.agent):
            value = parse_settings(source, source.read_bytes()) if source.exists() else {}
            digest.update(str(source).encode()); digest.update(json.dumps(value, sort_keys=True, ensure_ascii=False).encode("utf-8"))
    print(json.dumps({"fingerprint": digest.hexdigest(), "changedFiles": [str(p[0]) for p in plans], "applied": args.apply, "backup": str(backup) if backup else None}, ensure_ascii=False))


if __name__ == "__main__":
    main()
