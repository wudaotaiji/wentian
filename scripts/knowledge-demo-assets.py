"""架空の知識庫サンプルのPDF・図・スキャン・合成音声を再生成します。

通常の確認は配布済みファイルだけで実施でき、この生成処理は不要です。
再生成にはreportlab、Pillow、PyMuPDFを使用します。音声はWindowsの
インストール済み日本語音声だけを使い、外部サービスへ本文を送信しません。
フォントと出力先は利用者が指定し、既存の出力フォルダーは上書きしません。
"""
import argparse
import sys
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import wave


# パイプやログ保存時も日本語をUTF-8で出力します。
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

SPEECH = [
    ("A", "研修の日程は、11月12日から14日までの3日間にしましょう。参加者は4人です。"),
    ("B", "その日程で決定します。宿泊は2泊です。"),
    ("A", "担当Aが、11月5日までに、規程の上限額を確認して提案書を作ります。"),
    ("B", "交通費はまだ決まっていません。別途確認が必要です。"),
]


def main():
    from PIL import Image, ImageDraw, ImageFont
    import pymupdf as fitz
    from reportlab.pdfgen import canvas
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.lib.utils import ImageReader

    parser = argparse.ArgumentParser(description="Wentianの架空メディア資料を再生成")
    parser.add_argument("--output", required=True)
    parser.add_argument("--font", required=True)
    parser.add_argument("--template", default=str(Path(__file__).resolve().parent.parent / "examples/knowledge/demo"))
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.mkdir(parents=False, exist_ok=False)
    template = Path(args.template).resolve()
    # 元のテキスト資料だけを複製します。過去の生成物を再帰的に複製しません。
    for source in template.iterdir():
        if source.is_file() and source.suffix in (".md", ".txt", ".csv", ".json") and source.name not in ("manifest.json", "acceptance-media.json", "audio-metadata.json"):
            shutil.copyfile(source, output / source.name)
    pdfmetrics.registerFont(TTFont("Demo", args.font, subfontIndex=0))
    def font(size):
        return ImageFont.truetype(args.font, size, index=0)
    def text(draw, xy, content, size=30, color="#18324a"):
        draw.text(xy, content, font=font(size), fill=color)

    # 文字レイヤーと本当の表セルを持つPDF。行と列の対応を確認できます。
    pdf = canvas.Canvas(str(output / "07-policy-table.pdf"), pagesize=(595, 842))
    pdf.setTitle("架空資料・星見出張規程 版1")
    def line(y, content, size=11):
        pdf.setFont("Demo", size)
        pdf.drawString(42, y, content)
    line(790, "星見プロジェクト 出張規程 / 版1", 19)
    line(761, "架空の検証資料 / 適用開始 2026-11-01", 11)
    line(723, "参加者4人・2泊3日の研修を想定。交通費は別途実費です。")
    rows = [["項目", "一人あたり", "回数", "4人の小計"], ["宿泊費上限", "12,000円 / 泊", "2泊", "96,000円"], ["日当", "2,000円 / 日", "3日", "24,000円"], ["上限合計", "交通費を除く", "", "120,000円"]]
    widths = [120, 150, 85, 155]
    for index, row in enumerate(rows):
        y = 670 - index * 45
        x = 42
        for width, value in zip(widths, row):
            pdf.setFillColorRGB(*(0.9, 0.94, 0.97) if index == 0 else (1, 1, 1))
            pdf.rect(x, y, width, 45, fill=1, stroke=1)
            pdf.setFillColorRGB(0.09, 0.17, 0.23)
            pdf.setFont("Demo", 11)
            pdf.drawString(x + 8, y + 17, value)
            x += width
    line(480, "タクシーの利用には事前承認が必要です。")
    line(454, "宿泊費が上限を超える場合は予約前に責任者の承認を得ます。")
    line(410, "氏名・ホテル名・交通費の金額・予約完了は未確認です。")
    line(366, "中国語の研修計画と照合し、事実と提案を分けてください。")
    line(55, "DEMO-POLICY / 版1 / 1ページ", 9)
    pdf.save()

    # 図だけのPNG。矢印と工程の対応をVisionで読めるかを確認します。
    image = Image.new("RGB", (1500, 1250), "#f4f7fb")
    draw = ImageDraw.Draw(image)
    text(draw, (80, 45), "星見プロジェクト：資料から成果への流れ", 43)
    text(draw, (80, 110), "架空の検証図 / 五つの工程を順番に確認", 27)
    labels = ["1  資料追加", "2  根拠付き回答", "3  提案書作成", "4  根拠検証", "5  知識庫へ再保存"]
    for index, label in enumerate(labels):
        y = 200 + index * 195
        draw.rounded_rectangle((150, y, 1350, y + 125), radius=22, fill="#ffffff", outline="#276c9b", width=4)
        text(draw, (210, y + 38), label, 37)
        if index < 4:
            draw.line((750, y + 132, 750, y + 178), fill="#276c9b", width=6)
            draw.polygon([(738, y + 163), (762, y + 163), (750, y + 183)], fill="#276c9b")
    image.save(output / "08-workflow.png")

    # スキャン相当のPDF。画像しか格納せず、文字レイヤーは意図的に持ちません。
    scan = Image.new("RGB", (1240, 1754), "#fffdf8")
    draw = ImageDraw.Draw(scan)
    text(draw, (90, 90), "研修申請チェックシート", 52)
    text(draw, (90, 170), "架空のスキャン資料 / 文書ID DEMO-CHECK", 29)
    scan_rows = ["申請日：2026年11月2日", "予約状況：未予約", "交通費：未確定", "承認者の実名：未確認", "確認担当：担当A", "申請書の提出期限：11月5日"]
    for index, row in enumerate(scan_rows):
        y = 310 + index * 155
        draw.line((90, y + 90, 1150, y + 90), fill="#a3adb5", width=2)
        text(draw, (105, y + 15), row, 36)
    text(draw, (90, 1470), "この資料は予約完了の証拠ではありません。", 31)
    pdf = canvas.Canvas(str(output / "09-scan-checklist.pdf"), pagesize=(595, 842))
    pdf.setTitle("架空資料・画像だけの申請チェックシート")
    pdf.drawImage(ImageReader(scan), 0, 0, width=595, height=842)
    pdf.save()

    # Windowsの合成音声を二つ使い、参照文字列と実音声を同時に提供します。
    with tempfile.TemporaryDirectory(prefix="wentian-demo-speech-") as temporary:
        temporary = Path(temporary)
        payload = temporary / "speech.json"
        payload.write_text(json.dumps({"directory": str(temporary), "rows": SPEECH}, ensure_ascii=False), encoding="utf-8")
        command = r"""
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Speech
$data=Get-Content -Raw -Encoding UTF8 -LiteralPath $env:WENTIAN_DEMO_SPEECH_INPUT | ConvertFrom-Json
$synth=New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices=@($synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'ja-JP' } | ForEach-Object { $_.VoiceInfo.Name })
if($voices.Count -lt 2){throw '日本語の合成音声を二つ準備してください。'}
for($i=0;$i -lt $data.rows.Count;$i++){
  $synth.SelectVoice($voices[$i % 2])
  $synth.SetOutputToWaveFile((Join-Path $data.directory ($i.ToString()+'.wav')))
  $synth.Speak([string]$data.rows[$i][1])
  $synth.SetOutputToNull()
}
$synth.Dispose()
$voices[0..1] | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $data.directory 'voices.json')
"""
        environment = {**os.environ, "WENTIAN_DEMO_SPEECH_INPUT": str(payload)}
        speech_result = subprocess.run([shutil.which("pwsh") or "powershell", "-NoProfile", "-NonInteractive", "-Command", command], env=environment, check=False, capture_output=True)
        if speech_result.returncode:
            raise RuntimeError(speech_result.stderr.decode("utf-8", errors="replace"))
        segments = []
        with wave.open(str(output / "10-meeting-ja.wav"), "wb") as target:
            position = 0
            expected = None
            for index, (speaker, content) in enumerate(SPEECH):
                with wave.open(str(temporary / (str(index) + ".wav")), "rb") as source:
                    audio_format = (source.getnchannels(), source.getsampwidth(), source.getframerate())
                    if expected and expected != audio_format:
                        raise ValueError("合成音声の形式が一致しません。")
                    if expected is None:
                        target.setnchannels(audio_format[0])
                        target.setsampwidth(audio_format[1])
                        target.setframerate(audio_format[2])
                    expected = audio_format
                    duration = source.getnframes() / audio_format[2]
                    target.writeframes(source.readframes(source.getnframes()))
                    segments.append({"speaker": speaker, "start": round(position, 3), "end": round(position + duration, 3), "text": content})
                    gap = b"\x00" * int(audio_format[2] * 0.5) * audio_format[0] * audio_format[1]
                    target.writeframes(gap)
                    position += duration + 0.5
        voices = json.loads((temporary / "voices.json").read_text(encoding="utf-8-sig"))
    (output / "audio-metadata.json").write_text(json.dumps({"synthetic": True, "voices": voices, "segments": segments, "note": "A/Bは採点用ラベル。モデルの出力ラベルとの対応は人間が照合します。"}, ensure_ascii=False, indent=2), encoding="utf-8")
    (output / "11-meeting-groundtruth.md").write_text("# 合成会議音声の照合用原稿\n\nこれは人間用の採点資料です。音声認識の試験前に知識庫へ入れないでください。\n\n" + "\n\n".join("話者" + s["speaker"] + "：" + s["text"] for s in segments), encoding="utf-8")

    basic = json.loads((output / "acceptance-basic.json").read_text(encoding="utf-8"))
    basic["materials"][0].update(file="07-policy-table.pdf", contentType="application/pdf", features=["table", "text"])
    basic["materials"] += [
        {"id": "diagram", "file": "08-workflow.png", "title": "資料から成果への工程図", "contentType": "image/png", "language": "ja", "features": ["diagram"]},
        {"id": "scan", "file": "09-scan-checklist.pdf", "title": "申請チェックシート", "contentType": "application/pdf", "language": "ja", "features": ["scan"]},
        {"id": "audio", "file": "10-meeting-ja.wav", "title": "合成会議音声", "contentType": "audio/wav", "language": "ja", "features": ["audio"]},
    ]
    basic["cases"][0]["question"] += " 図の五工程、スキャンの予約状況、会議音声で決まった日程と作業担当・期限も、それぞれの資料から引用して確認してください。"
    (output / "acceptance-media.json").write_text(json.dumps(basic, ensure_ascii=False, indent=2), encoding="utf-8")
    # PDFを再読込・画像化し、文字PDFと画像PDFの違いを機械的に検証します。
    previews = output / "previews"
    previews.mkdir()
    for name in ["07-policy-table.pdf", "09-scan-checklist.pdf"]:
        with fitz.open(output / name) as document:
            extracted = "".join(page.get_text() for page in document)
            if (name.startswith("07") and "12,000" not in extracted) or (name.startswith("09") and extracted.strip()):
                raise ValueError("PDFの文字レイヤーが想定と一致しません。")
            document[0].get_pixmap(matrix=fitz.Matrix(1.4, 1.4)).save(str(previews / (name + ".png")))
    files = [{"name": p.name, "bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(output.iterdir()) if p.is_file() and p.name != "manifest.json"]
    (output / "manifest.json").write_text(json.dumps({"version": 1, "synthetic": True, "files": files}, ensure_ascii=False, indent=2), encoding="utf-8")
    print("架空のPDF・図・スキャン・合成会議音声と照合原稿を生成しました。")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("メディア生成に失敗しました。依存、フォント、日本語音声、新規出力先を確認してください。")
        raise SystemExit(1)
