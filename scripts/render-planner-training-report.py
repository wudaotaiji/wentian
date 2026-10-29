"""分類学習のログ・評価・重みを検収可能な図表と再現パッケージへまとめる。

描画にはMatplotlibを使用する。PNG/SVGは単独で共有可能、HTMLは画像を内包する。
学習成績はreport.jsonをそのまま使い、閾値を下げたり不正解を除外したりしない。
"""
import argparse
import base64
from collections import Counter
import hashlib
import html
import json
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile


def digest(file):
    """大きな重みファイルも一定メモリでSHA256を計算する。"""
    value = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def render(directory):
    """実測ログから損失曲線・混同行列・言語別成績を生成し、全個別結果も残す。"""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    report = json.loads((directory / "report.json").read_text(encoding="utf-8"))
    losses = [json.loads(line) for line in (directory / "losses.jsonl").read_text(encoding="utf-8").splitlines() if line]
    plt.rcParams.update({"figure.dpi": 140, "font.size": 10})
    images = []

    def save_plot(name, figure):
        """編集用SVGと共有用PNGを両方保存し、HTML内の図も同じデータから作る。"""
        figure.tight_layout()
        figure.savefig(directory / (name + ".png"))
        figure.savefig(directory / (name + ".svg"))
        images.append(base64.b64encode((directory / (name + ".png")).read_bytes()).decode())
        plt.close(figure)

    figure, axis = plt.subplots(figsize=(9, 3.4))
    axis.plot([row["step"] for row in losses], [row["loss"] for row in losses], alpha=0.25, linewidth=0.7, label="Measured loss")
    averaged = [sum(row["loss"] for row in losses[max(0, index-19):index+1]) / len(losses[max(0, index-19):index+1]) for index in range(len(losses))]
    axis.plot([row["step"] for row in losses], averaged, linewidth=1.6, label="20-step moving average")
    axis.set(xlabel="Training step", ylabel="Cross-entropy loss", title="Classifier fine-tuning: learning curve")
    axis.legend(); axis.grid(alpha=0.2)
    save_plot("loss-curve", figure)

    def category(value):
        """自然言語を再分類せず、保存済みの構造化ラベルを軸名へ変換する。"""
        return f"{value.get('intent', 'invalid')}:{value.get('operation', 'invalid')}" if isinstance(value, dict) else "invalid"

    categories = sorted({category(row["expected"]) for row in report["results"]} | {category(row["prediction"]) for row in report["results"]})
    matrix = [[0 for _ in categories] for _ in categories]
    for row in report["results"]:
        matrix[categories.index(category(row["expected"]))][categories.index(category(row["prediction"]))] += 1
    figure, axis = plt.subplots(figsize=(9, 6.5))
    image = axis.imshow(matrix, cmap="Blues")
    axis.set_xticks(range(len(categories)), categories, rotation=40, ha="right")
    axis.set_yticks(range(len(categories)), categories)
    axis.set(xlabel="Predicted intent / operation", ylabel="Expected intent / operation", title="Independent evaluation: confusion matrix")
    for y, values in enumerate(matrix):
        for x, count in enumerate(values):
            axis.text(x, y, str(count), ha="center", va="center", color="white" if count > max(max(row) for row in matrix) / 2 else "black")
    figure.colorbar(image, ax=axis, label="Examples")
    save_plot("confusion-matrix", figure)

    totals = Counter(row["expected"].get("language", "unknown") for row in report["results"])
    correct = Counter(row["expected"].get("language", "unknown") for row in report["results"] if row["correct"])
    figure, axis = plt.subplots(figsize=(9, 3.4))
    languages = sorted(totals)
    values = [correct[language] / totals[language] for language in languages]
    axis.bar(languages, values, color="#3775d6")
    axis.set(ylim=(0, 1.15), ylabel="Exact-plan accuracy", title="Independent evaluation: accuracy by language")
    for index, language in enumerate(languages):
        axis.text(index, values[index] + 0.03, f"{correct[language]}/{totals[language]} = {values[index]:.1%}", ha="center")
    save_plot("language-accuracy", figure)

    rows = []
    for item in report["results"]:
        expected = html.escape(json.dumps(item["expected"], ensure_ascii=False, indent=2))
        prediction = html.escape(json.dumps(item["prediction"], ensure_ascii=False, indent=2))
        rows.append(f'<tr data-correct="{str(item["correct"]).lower()}"><td>{"成功" if item["correct"] else "不正解"}</td><td>{html.escape(item["input"])}</td><td><details><summary>正解・予測を比較</summary><strong>正解</strong><pre>{expected}</pre><strong>予測</strong><pre>{prediction}</pre></details></td></tr>')
    figures = "".join(f'<img alt="実測結果のグラフ" src="data:image/png;base64,{image}">' for image in images)
    page = f'''<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wentian 分類モデル実学習レポート</title><style>body{{font:16px system-ui;max-width:1100px;margin:32px auto;padding:0 20px;color:#17243b;background:#f5f7fc}}section,article{{background:white;border:1px solid #d5dbea;border-radius:12px;padding:22px;margin:20px 0}}.cards{{display:flex;gap:16px;flex-wrap:wrap}}.cards article{{flex:1}}strong.metric{{font-size:30px}}img{{width:100%;height:auto}}table{{width:100%;border-collapse:collapse}}td,th{{padding:12px;border-bottom:1px solid #dde3ee;text-align:left;vertical-align:top}}tr[data-correct=false]{{background:#fff0f0}}pre{{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f4f9;padding:12px;font-size:12px}}button{{padding:10px 18px}}h1{{font-size:28px}}</style></head><body>
<h1>Wentian 分類モデル実学習レポート</h1><p>ジョブ: {html.escape(directory.name)} ／ 学習手法: LoRA（低ランク適応 / Low-Rank Adaptation）</p>
<div class="cards"><article>独立評価の正解率<br><strong class="metric">{report["accuracy"]:.1%}</strong><p>{report["correct"]}/{report["evaluated"]}件</p></article><article>誤書込み判定<br><strong class="metric">{report["unsafeWrites"]}件</strong></article><article>判定<br><strong class="metric">{"合格" if report["passed"] else "不合格"}</strong></article></div>
<section><h2>学習と評価の実測結果</h2>{figures}</section><section><h2>個別結果を確認</h2><p>評価例は学習に使用していません。正解率はこの評価セットに対する値です。</p><button onclick="for(const row of document.querySelectorAll('tr[data-correct=true]'))row.hidden=!row.hidden">不正解だけを表示／解除</button><table><thead><tr><th>判定</th><th>入力</th><th>比較</th></tr></thead><tbody>{''.join(rows)}</tbody></table></section>
<section><h2>再現条件</h2><pre>{html.escape((directory / 'training-config.json').read_text(encoding='utf-8'))}</pre><p>データ、分割、プロンプト、全依存版、実行時ソース、重み、SHA256一覧を同じジョブフォルダーに保存しています。</p></section></body></html>'''
    (directory / "report.html").write_text(page, encoding="utf-8")

    # 描画時の依存も別台帳へ残し、学習開始時のlockファイルは上書きしない。
    freeze = subprocess.run([sys.executable, "-m", "pip", "freeze"], check=True, capture_output=True, text=True).stdout
    (directory / "report-requirements.lock.txt").write_text(freeze, encoding="utf-8")
    # 基盤重みはZIPへ重複格納せず、固定リビジョンと実ファイルのハッシュで照合できるようにする。
    snapshot = directory.parent.parent / "model-cache" / ("models--" + report["baseModel"].replace("/", "--")) / "snapshots" / report["revision"]
    base_files = [{"path": str(file.relative_to(snapshot)).replace('\\', '/'), "bytes": file.stat().st_size, "sha256": digest(file)} for file in sorted(snapshot.rglob("*")) if file.is_file()]
    (directory / "base-model-manifest.json").write_text(json.dumps({"model": report["baseModel"], "revision": report["revision"], "files": base_files}, ensure_ascii=False, indent=2), encoding="utf-8")
    for name in ["render-planner-training-report.py", "render-planner-training-report.ps1", "reproduce-planner-training.py", "reproduce-planner-training.ps1", "prepare-planner-dataset.py", "prepare-planner-dataset.ps1", "finish-planner-training.py", "finish-planner-training.ps1"]:
        source = Path(__file__).with_name(name)
        if source.exists():
            shutil.copy2(source, directory / "source" / name)
    # 学習重みを含む全成果物のダイジェストを残す。取得済み基盤重みは別キャッシュのまま維持する。
    inventory = [{"path": str(file.relative_to(directory)).replace('\\', '/'), "bytes": file.stat().st_size, "sha256": digest(file)} for file in sorted(directory.rglob("*")) if file.is_file() and file.name not in ("model-manifest.json", "reproduction.zip")]
    (directory / "model-manifest.json").write_text(json.dumps({"files": inventory, "baseModel": report["baseModel"], "revision": report["revision"]}, ensure_ascii=False, indent=2), encoding="utf-8")
    with zipfile.ZipFile(directory / "reproduction.zip", "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for file in sorted(directory.rglob("*")):
            if file.is_file() and file.name != "reproduction.zip":
                bundle.write(file, file.relative_to(directory))
    return {"report": str(directory / "report.html"), "package": str(directory / "reproduction.zip"), "files": len(inventory)}


def main():
    """対象ジョブの成果物だけを描画し、学習結果自体は変更しない。"""
    parser = argparse.ArgumentParser(description="分類学習成果を図表付きレポートとして保存します。")
    parser.add_argument("--directory", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(render(args.directory.resolve()), ensure_ascii=False))


if __name__ == "__main__":
    main()
