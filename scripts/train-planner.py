"""Wentian分類モデルのLoRA学習・評価・推論。

学習例は管理画面で確認済みのJSONLのみ使用する。会話履歴や資格情報は探索しない。
ダウンロードは --allow-download 指定時だけ許可し、リモートコードは実行しない。
評価結果とアダプター（Adapter）を保存するが、有効化は管理者の別操作にする。
"""
import argparse
import hashlib
import json
import os
import random
import platform
import shutil
import subprocess
import time
from pathlib import Path
import sys
import re

BASE_MODEL = "Qwen/Qwen2.5-0.5B-Instruct"
BASE_REVISION = "7ae557604adf67be50417f59c2c2f167def9a775"
SUPPORTED_MODELS = (BASE_MODEL, "Qwen/Qwen2.5-1.5B-Instruct", "Qwen/Qwen2.5-3B-Instruct")


def split_examples(rows):
    """同一入力の混入を拒否し、入力ハッシュで決定的に評価用20%を分離する。"""
    unique = {}
    for row in rows:
        if not isinstance(row, dict) or row.get("reviewed") is not True:
            raise ValueError("未確認の分類例は学習できません。")
        text = row.get("input")
        label = row.get("label")
        if not isinstance(text, str) or not text.strip() or not isinstance(label, dict):
            raise ValueError("分類例の形式が不正です。")
        if text in unique:
            raise ValueError("同じ入力が重複しています。")
        unique[text] = row
    if len(unique) < 25:
        raise ValueError("分類例は25件以上必要です。")
    if any("split" in row for row in unique.values()):
        if any(row.get("split") not in ("train", "evaluation") for row in unique.values()):
            raise ValueError("固定分割と自動分割を混在させないでください。")
        training = [row for row in unique.values() if row["split"] == "train"]
        evaluation = [row for row in unique.values() if row["split"] == "evaluation"]
        if len(training) < 20 or len(evaluation) < 5:
            raise ValueError("固定分割には学習20件以上、独立評価5件以上が必要です。")
        return training, evaluation
    ordered = sorted(unique.values(), key=lambda row: hashlib.sha256(row["input"].encode()).hexdigest())
    count = max(5, len(ordered) // 5)
    return ordered[count:], ordered[:count]


def score_predictions(rows, predictions):
    """JSON構造と実行に関わる項目を照合する。誤った書き込み判定は1件でも不合格。"""
    correct = 0
    unsafe_writes = 0
    results = []
    fields = ("intent", "operation", "language", "execution_mode", "evidence_source", "research", "runtime_requirements")
    for row, raw in zip(rows, predictions, strict=True):
        try:
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise ValueError("オブジェクトではありません。")
            expected = row["label"]
            predicted_write = value.get("operation") == "write" or "write_file" in value.get("tools", []) or "file_write" in value.get("required_capabilities", [])
            if expected["operation"] != "write" and predicted_write:
                unsafe_writes += 1
            matches = all(value.get(field) == expected.get(field) for field in fields)
            matches = matches and set(value.get("tools", [])) == set(expected.get("tools", []))
            matches = matches and set(value.get("required_capabilities", [])) == set(expected.get("required_capabilities", []))
            matches = matches and value.get("delegation", {}).get("enabled", False) == expected.get("delegation", {}).get("enabled", False)
            matches = matches and value.get("delegation", {}).get("parallel", False) == expected.get("delegation", {}).get("parallel", False)
            matches = matches and sorted(value.get("delegation", {}).get("requested_agents", [])) == sorted(expected.get("delegation", {}).get("requested_agents", []))
            matches = matches and "model" not in value and "provider" not in value
        except (ValueError, TypeError, AttributeError):
            value = None
            matches = False
        correct += int(matches)
        results.append({"inputHash": hashlib.sha256(row["input"].encode()).hexdigest(), "input": row["input"], "expected": row["label"], "correct": matches, "prediction": value, "raw": raw})
    accuracy = correct / len(rows) if rows else 0
    return {"evaluated": len(rows), "correct": correct, "accuracy": accuracy, "unsafeWrites": unsafe_writes,
            "passed": len(rows) >= 5 and accuracy >= 0.9 and unsafe_writes == 0, "results": results}


def load_model(directory, allow_download=False, adapter=False, device="auto"):
    """重い依存は実学習・推論時だけ読み込む。単体試験ではモデルを取得しない。"""
    # 決定的演算（Deterministic Algorithms）の設定はCUDA初期化より前に必要です。
    # 通常の管理画面・CLI起動でも同じ条件とし、外部の環境変数設定に依存しません。
    os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    selected = "cuda" if device == "auto" and torch.cuda.is_available() else "cpu" if device == "auto" else device
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    if selected == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA対応GPUを検出できません。CPUまたは実行端末を確認してください。")
    cache = directory.parent.parent / "model-cache"
    # 比較学習したモデルの版を保存設定から復元します。任意リポジトリやリモートコードは許可しません。
    config_path = directory / "training-config.json"
    config = json.loads(config_path.read_text(encoding="utf-8")) if config_path.exists() else {}
    base_model, revision = config.get("baseModel", BASE_MODEL), config.get("revision", BASE_REVISION)
    if base_model not in SUPPORTED_MODELS or not isinstance(revision, str) or not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("基盤モデルまたは固定リビジョン（Revision）が不正です。")
    # ネットワーク許可は呼び出しごとに固定し、環境変数の設定漏れで取得しない。
    tokenizer = AutoTokenizer.from_pretrained(base_model, revision=revision, cache_dir=cache, local_files_only=not allow_download, trust_remote_code=False)
    model = AutoModelForCausalLM.from_pretrained(base_model, revision=revision, cache_dir=cache, local_files_only=not allow_download, trust_remote_code=False,
                                               torch_dtype=torch.float32 if selected == "cpu" else torch.float16, low_cpu_mem_usage=True, attn_implementation="sdpa")
    tokenizer.pad_token = tokenizer.eos_token
    model.to(selected)
    if adapter:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, directory / "adapter", local_files_only=True)
    return torch, tokenizer, model, selected


def generate(torch, tokenizer, model, system, text):
    """サンプリング（Sampling）を無効にし、入力の黙った切り詰めを拒否する。"""
    return generate_batch(torch, tokenizer, model, system, [text])[0]


def generate_batch(torch, tokenizer, model, system, texts):
    """評価は左パディング（Left Padding）と明示マスクでまとめ、生成条件を統一します。"""
    tokenizer.padding_side = "left"
    conversations = [[{"role":"system","content":system}, {"role":"user","content":text}] for text in texts]
    tokens = tokenizer.apply_chat_template(conversations, tokenize=True, add_generation_prompt=True, return_tensors="pt", return_dict=True, padding=True).to(model.device)
    if tokens["input_ids"].shape[1] > 3584:
        raise ValueError("分類入力が文脈上限を超えています。")
    with torch.no_grad():
        output = model.generate(**tokens, max_new_tokens=512, do_sample=False, pad_token_id=tokenizer.pad_token_id)
    return [text.strip() for text in tokenizer.batch_decode(output[:, tokens["input_ids"].shape[1]:], skip_special_tokens=True)]


def train(args):
    """入力ラベル以外を損失計算から除外し、学習後に未学習例で生成評価する。"""
    directory = args.directory.resolve()
    rows = [json.loads(line) for line in (directory / "dataset.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    training, evaluation = split_examples(rows)
    system = json.loads((directory / "prompt.json").read_text(encoding="utf-8"))["system"]
    started = time.time()
    # 実行時点のソースと全依存版を固定保存し、将来のコード変更後も同じ手法を再実行できるようにする。
    (directory / "source").mkdir(exist_ok=True)
    shutil.copy2(__file__, directory / "source" / "train-planner.py")
    freeze = subprocess.run([sys.executable, "-m", "pip", "freeze"], check=True, capture_output=True, text=True).stdout
    (directory / "requirements.lock.txt").write_text(freeze, encoding="utf-8")
    for name, data in [("training.jsonl", training), ("evaluation.jsonl", evaluation)]:
        (directory / name).write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in data), encoding="utf-8")
    base_model = getattr(args, "base_model", BASE_MODEL)
    revision = getattr(args, "revision", None) or BASE_REVISION
    rank, learning_rate = getattr(args,"lora_rank",8), getattr(args,"learning_rate",2e-4)
    targets = "all-linear" if getattr(args,"all_linear",False) else ["q_proj","v_proj"]
    config = {"baseModel": base_model, "revision": revision, "seed": 42, "steps": args.steps, "device": args.device,
              "method": "LoRA", "rank": rank, "alpha": rank*2, "dropout": 0.05, "targetModules": targets, "learningRate": learning_rate,
              "optimizer": "AdamW", "batchSize": 1, "evaluationBatchSize": getattr(args,"evaluation_batch_size",1), "maxSequenceTokens": 4096, "maxNewTokens": 512, "trainingExamples": len(training), "split": "explicit" if "split" in training[0] else "input-sha256-20pct"}
    (directory / "training-config.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
    environment = {"python": sys.version, "platform": platform.platform(), "cpu": platform.processor(), "logicalCores": os.cpu_count()}
    (directory / "environment.json").write_text(json.dumps(environment, indent=2), encoding="utf-8")
    torch, tokenizer, model, selected = load_model(directory, args.allow_download, device=args.device)
    from peft import LoraConfig, get_peft_model
    torch.manual_seed(42)
    torch.use_deterministic_algorithms(True)
    resume_adapter = getattr(args, "resume_adapter", None)
    if resume_adapter:
        # 補習は既存重みから開始します。親重みのハッシュを残し、最初からの学習と区別します。
        from peft import PeftModel
        parent = Path(resume_adapter).resolve()
        # 親アダプターも成果物へ保存し、外部の一時フォルダーがなくても補習を再現できるようにします。
        shutil.copytree(parent,directory/"parent-adapter")
        parent = directory/"parent-adapter"
        config["parentAdapterPath"] = "parent-adapter"
        config["parentAdapterSha256"] = hashlib.sha256((parent/"adapter_model.safetensors").read_bytes()).hexdigest()
        (directory/"training-config.json").write_text(json.dumps(config,indent=2),encoding="utf-8")
        model = PeftModel.from_pretrained(model,parent,is_trainable=True,local_files_only=True)
    else:
        model = get_peft_model(model, LoraConfig(r=rank, lora_alpha=rank*2, lora_dropout=0.05, target_modules=targets, task_type="CAUSAL_LM"))
    optimizer = torch.optim.AdamW([parameter for parameter in model.parameters() if parameter.requires_grad], lr=learning_rate)
    encoded = []
    for row in training:
        messages = [{"role": "system", "content": system}, {"role": "user", "content": row["input"]}]
        prefix = tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=True)
        full = tokenizer.apply_chat_template(messages + [{"role": "assistant", "content": json.dumps(row["label"], ensure_ascii=False)}], tokenize=True)
        if len(full) > 4096 or full[:len(prefix)] != prefix:
            raise ValueError("学習例が文脈上限を超えたか、チャットテンプレート（Chat Template）が不整合です。")
        encoded.append((full, [-100] * len(prefix) + full[len(prefix):]))
    model.train()
    model.config.use_cache = False
    losses = []
    sampler = random.Random(42)
    indices = list(range(len(encoded)))
    for step in range(args.steps):
        if step % len(encoded) == 0:
            sampler.shuffle(indices)
        tokens, labels = encoded[indices[step % len(encoded)]]
        optimizer.zero_grad(set_to_none=True)
        output = model(input_ids=torch.tensor([tokens], device=selected), labels=torch.tensor([labels], device=selected))
        if not torch.isfinite(output.loss):
            raise RuntimeError("損失が非有限値になりました。学習を停止します。")
        output.loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        losses.append(float(output.loss.detach().cpu()))
        with (directory / "losses.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"step": step + 1, "loss": losses[-1], "elapsedSeconds": round(time.time() - started, 3)}) + "\n")
        if (step + 1) % 200 == 0:
            # 中間成果も保存するが、評価未完了のチェックポイント（Checkpoint）は有効化しない。
            model.save_pretrained(directory / "checkpoints" / f"step-{step+1}", safe_serialization=True)
        print(f"学習ステップ {step + 1}/{args.steps} 損失={losses[-1]:.4f}", file=sys.stderr, flush=True)
    model.save_pretrained(directory / "adapter", safe_serialization=True)
    tokenizer.save_pretrained(directory / "adapter")
    model.eval()
    model.config.use_cache = True
    predictions = []
    batch_size = getattr(args, "evaluation_batch_size", 1)
    for index in range(0, len(evaluation), batch_size):
        batch = evaluation[index:index+batch_size]
        generated = generate_batch(torch, tokenizer, model, system, [row["input"] for row in batch])
        predictions.extend(generated)
        with (directory / "predictions.jsonl").open("a", encoding="utf-8") as stream:
            for row, prediction in zip(batch, generated, strict=True):
                stream.write(json.dumps({"input": row["input"], "expected": row["label"], "raw": prediction}, ensure_ascii=False) + "\n")
        print(f"独立評価 {min(index+batch_size,len(evaluation))}/{len(evaluation)}", file=sys.stderr, flush=True)
    report = score_predictions(evaluation, predictions)
    report.update({"baseModel": base_model, "trainingExamples": len(training), "steps": args.steps, "device": selected,
                   "datasetSha256": hashlib.sha256((directory / "dataset.jsonl").read_bytes()).hexdigest(), "finalLoss": losses[-1], "revision": revision, "elapsedSeconds": time.time() - started})
    (directory / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"passed": report["passed"], "accuracy": report["accuracy"]}))


def main():
    """固定のtrain/infer操作だけを受け付け、任意のコマンドは実行しない。"""
    parser = argparse.ArgumentParser(description="Wentianの分類用LLMを学習・評価・推論します。")
    parser.add_argument("operation", choices=["train", "infer"])
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--steps", type=int, default=100)
    parser.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    parser.add_argument("--allow-download", action="store_true")
    parser.add_argument("--base-model", choices=SUPPORTED_MODELS, default=BASE_MODEL)
    parser.add_argument("--revision", help="比較モデルの40桁の固定リビジョン（Revision）。")
    parser.add_argument("--learning-rate", type=float, default=2e-4)
    parser.add_argument("--lora-rank", type=int, choices=[8,16,32], default=8)
    parser.add_argument("--all-linear", action="store_true")
    parser.add_argument("--evaluation-batch-size", type=int, choices=[1,2,4,8], default=1)
    parser.add_argument("--resume-adapter", type=Path, help="補習を開始する既存アダプター（Adapter）。")
    args = parser.parse_args()
    if not 1 <= args.steps <= 2000:
        parser.error("学習ステップは1〜2000です。")
    if not 0 < args.learning_rate <= 0.001 or (args.base_model != BASE_MODEL and not args.revision):
        parser.error("学習率は0より大きく0.001以下、比較モデルには固定リビジョンが必要です。")
    if args.operation == "train":
        train(args)
    else:
        payload = json.load(sys.stdin)
        torch, tokenizer, model, _ = load_model(args.directory.resolve(), adapter=True, device=args.device)
        model.eval()
        # 学習時と同じ固定プロンプトを使い、通常Gateway向けの長い規則との差異を混入させない。
        trained_system = json.loads((args.directory / "prompt.json").read_text(encoding="utf-8"))["system"]
        print(generate(torch, tokenizer, model, trained_system, payload["input"]))


if __name__ == "__main__":
    main()
