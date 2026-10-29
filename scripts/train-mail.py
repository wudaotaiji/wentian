"""Mail Solutions の確認済みメールから分類・抽出モデルを学習する固定ワーカー。

分類は文字エヌグラム（Character n-gram）の TF-IDF とロジスティック回帰を使う。
抽出は正解値の前後に現れる文字列を教師例として学び、行単位のパターンを作る。
外部コマンドやネットワークを呼ばず、指定された実行フォルダーだけを読み書きする。
"""

import argparse
import hashlib
import json
import re
from collections import Counter, defaultdict
from pathlib import Path


def read_rows(directory):
    """版を固定した JSONL を読み、破損した行を黙って飛ばさない。"""
    lines = (directory / "dataset.jsonl").read_text(encoding="utf-8").splitlines()
    rows = [json.loads(line) for line in lines if line.strip()]
    if not rows or any(row.get("reviewed") is not True for row in rows):
        raise ValueError("確認済みの学習データが必要です。")
    return rows


def split_rows(rows):
    """会話・重複グループをまたがず、固定分割か決定的な自動分割を使う。"""
    # 会話と重複群のどちらかが一致する行を連結します。片方だけで分割すると
    # 同じ会話の別メールが評価へ混入するため、連結成分を分割の単位にします。
    parents = list(range(len(rows)))

    def find(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    seen = {}
    for index, row in enumerate(rows):
        for field in ("thread_id", "duplicate_group_id", "mail_id"):
            if not row.get(field):
                continue
            key = (field, str(row[field]))
            if key in seen:
                left, right = find(index), find(seen[key])
                parents[max(left, right)] = min(left, right)
            else:
                seen[key] = index
    groups = defaultdict(list)
    for index, row in enumerate(rows):
        groups[str(rows[find(index)]["mail_id"])].append(row)
    explicit = any("split" in row for row in rows)
    if explicit:
        if any(row.get("split") not in ("train", "evaluation") for row in rows):
            raise ValueError("分割は全件で train または evaluation を指定してください。")
        if any(len({row["split"] for row in members}) != 1 for members in groups.values()):
            raise ValueError("同じ会話・重複群が学習と評価にまたがっています。")
        training = [row for row in rows if row["split"] == "train"]
        evaluation = [row for row in rows if row["split"] == "evaluation"]
    else:
        ordered = sorted(groups, key=lambda key: hashlib.sha256(key.encode()).hexdigest())
        evaluation_keys = set(ordered[:max(3, len(ordered) // 5)])
        training = [row for key, members in groups.items() if key not in evaluation_keys for row in members]
        evaluation = [row for key, members in groups.items() if key in evaluation_keys for row in members]
    if len(training) < 8 or len(evaluation) < 3:
        raise ValueError("学習8件以上、独立評価3件以上が必要です。")
    return training, evaluation


def mail_text(row):
    """件名と本文を結合し、長文でも学習・推論の入力長を一定にする。"""
    return (str(row.get("subject", "")) + "\n" + str(row.get("body", "")))[:20000]


def train_classification(directory, training, evaluation):
    """分類経路全体を一つのラベルとして予測する初期モデルを作る。"""
    import joblib
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import Pipeline
    from sklearn.metrics import classification_report, f1_score

    labels = ["/".join(row["label_path"]) for row in training]
    classes = set(labels)
    if len(classes) < 2:
        raise ValueError("分類学習には異なる正解分類が2種類以上必要です。")
    if any("/".join(row["label_path"]) not in classes for row in evaluation):
        raise ValueError("評価データに学習未登録の分類が含まれています。")
    model = Pipeline([
        ("features", TfidfVectorizer(analyzer="char", ngram_range=(2, 5), max_features=50000, min_df=1)),
        ("classifier", LogisticRegression(max_iter=1000, class_weight="balanced", random_state=42)),
    ])
    model.fit([mail_text(row) for row in training], labels)
    expected = ["/".join(row["label_path"]) for row in evaluation]
    predicted = list(model.predict([mail_text(row) for row in evaluation]))
    score = float(f1_score(expected, predicted, average="macro", zero_division=0))
    details = classification_report(expected, predicted, output_dict=True, zero_division=0)
    joblib.dump(model, directory / "model.joblib")
    return {"metric": "macro_f1", "score": score, "details": details,
            "predictions": [{"mail_id": row["mail_id"], "expected": gold, "predicted": result}
                            for row, gold, result in zip(evaluation, expected, predicted, strict=True)]}


def learned_patterns(rows):
    """注釈された値を含む行から、値の直前・直後の文字列を学習する。"""
    patterns = defaultdict(Counter)
    for row in rows:
        lines = mail_text(row).splitlines()
        for field, value in row["fields"].items():
            if not isinstance(value, str) or not value.strip():
                continue
            for line in lines:
                offset = line.find(value)
                if offset < 0:
                    continue
                left = line[:offset].strip()[-36:]
                right = line[offset + len(value):].strip()[:36]
                if left or right:
                    patterns[field][(left, right)] += 1
                break
    return {field: [{"left": left, "right": right, "count": count}
                    for (left, right), count in matches.most_common(100)]
            for field, matches in patterns.items()}


def extract(text, model):
    """学習した行の手掛かりに一致した値と根拠行を返す。推測値は作らない。"""
    result = {}
    for field, patterns in model.items():
        for pattern in patterns:
            left, right = pattern["left"], pattern["right"]
            for line in text.splitlines():
                start = line.find(left) + len(left) if left and left in line else (0 if not left else -1)
                if start < 0:
                    continue
                end = line.find(right, start) if right else len(line)
                if end < start:
                    continue
                value = line[start:end].strip(" \t:：-–")
                if value and len(value) <= 300:
                    result[field] = {"value": value, "evidence": line[:500]}
                    break
            if field in result:
                break
    return result


def train_extraction(directory, training, evaluation):
    """技術者・案件の項目別に書式の手掛かりを学び、独立データで一致率を測る。"""
    models = {}
    for kind in {row["kind"] for row in training}:
        models[kind] = learned_patterns([row for row in training if row["kind"] == kind])
    if any(row["kind"] not in models for row in evaluation):
        raise ValueError("評価データの種類に対応する学習例がありません。")
    total = correct = 0
    predictions = []
    for row in evaluation:
        fields = extract(mail_text(row), models[row["kind"]])
        for field, expected in row["fields"].items():
            total += 1
            correct += int(fields.get(field, {}).get("value") == expected)
        predictions.append({"mail_id": row["mail_id"], "expected": row["fields"], "predicted": fields})
    if total < 3:
        raise ValueError("評価用の正解項目が3件以上必要です。")
    (directory / "model.json").write_text(json.dumps(models, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"metric": "field_exact_match", "score": correct / total, "evaluated_fields": total,
            "correct_fields": correct, "predictions": predictions}


def train(directory, task):
    """データ版と成果物のハッシュを記録し、合格可否は評価結果だけで決める。"""
    rows = read_rows(directory)
    training, evaluation = split_rows(rows)
    if task == "classification":
        result = train_classification(directory, training, evaluation)
    else:
        result = train_extraction(directory, training, evaluation)
    report = {"task": task, "training": len(training), "evaluation": len(evaluation),
              "metric": result["metric"], "score": result["score"],
              "passed": result["score"] >= 0.70, "details": result.get("details"),
              "evaluated_fields": result.get("evaluated_fields"), "correct_fields": result.get("correct_fields")}
    (directory / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (directory / "predictions.jsonl").write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in result["predictions"]), encoding="utf-8")
    artifacts = ["dataset.jsonl", "report.json", "predictions.jsonl",
                 "model.joblib" if task == "classification" else "model.json"]
    manifest = {name: hashlib.sha256((directory / name).read_bytes()).hexdigest() for name in artifacts}
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


def infer(directory, task):
    """標準入力のメールだけを予測し、学習用ファイルを書き換えない。"""
    import sys
    payload = json.load(sys.stdin)
    text = mail_text(payload)
    if task == "classification":
        import joblib
        model = joblib.load(directory / "model.joblib")
        probabilities = model.predict_proba([text])[0]
        order = probabilities.argsort()[::-1]
        classes = model.named_steps["classifier"].classes_
        result = {"label_path": str(classes[order[0]]).split("/"),
                  "score": float(probabilities[order[0]]),
                  "candidates": [{"label_path": str(classes[index]).split("/"), "score": float(probabilities[index])}
                                 for index in order[:3]]}
    else:
        kind = payload.get("kind")
        models = json.loads((directory / "model.json").read_text(encoding="utf-8"))
        if kind not in models:
            raise ValueError("学習済みの抽出対象を指定してください。")
        result = {"kind": kind, "fields": extract(text, models[kind])}
    print(json.dumps(result, ensure_ascii=False))


def main():
    """任意スクリプトを実行できない固定の操作とタスクだけを受け付ける。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("train", "infer"))
    parser.add_argument("--directory", required=True, type=Path)
    parser.add_argument("--task", required=True, choices=("classification", "extraction"))
    args = parser.parse_args()
    if args.operation == "train":
        train(args.directory, args.task)
    else:
        infer(args.directory, args.task)


if __name__ == "__main__":
    main()
