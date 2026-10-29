"""検証成果物（Verification Artifacts）を制作画面のサンプル集として保存します。

既知の検証ファイルだけをコピーし、実際のモデル・素材の性質を説明文へ記録します。
既存作品や認証情報を読みません。サンプル一覧は保存完了後に原子的に公開します。
"""
import json
import os
from pathlib import Path
import shutil


def main():
    root = Path(__file__).resolve().parent.parent
    evidence = root / "docs/evidence/media-production/20261007"
    output = root / "examples/media"
    output.mkdir(parents=True, exist_ok=True)
    examples = []
    def preserve(identifier, title, kind, description, source, formats):
        files = {}
        for extension in formats:
            original = source.with_suffix("." + extension)
            target = output / (identifier + "." + extension)
            shutil.copyfile(original, target)
            files[extension] = target.name
        examples.append({"id": identifier, "title": title, "type": kind, "description": description, "files": files})
    for language, label in [("ja", "日本語"), ("zh", "中国語"), ("en", "英語")]:
        preserve("speech-" + language, label + "ナレーション", "audio", "PC標準の音声による実際の読み上げ。48kHz・ステレオ。", evidence / ("speech-" + language), ["wav", "mp3"])
    preserve("ai-music", "AI BGM・ピアノ", "audio", "MusicGen SmallをCPUで実生成した1秒の試聴用。モデルはCC-BY-NC 4.0。", evidence / "ai-music", ["wav", "mp3"])
    preserve("ai-sound", "AI 効果音・雨", "audio", "AudioLDM Small v2をCPU・2ステップで実生成した1秒の動作確認用。品質評価用ではありません。モデルはCC-BY-NC-SA 4.0。", evidence / "ai-sound", ["wav", "mp3"])
    preserve("audio-mix", "音声編集・2トラック", "audio", "日本語と中国語の音声を、配置・切取・音量・反復・フェード指定で合成した4秒の音声。", evidence / "audio-mix", ["wav", "mp3"])
    preserve("video-with-audio", "動画・音声・字幕の合成", "video", "検証用の青色映像へナレーションと字幕を合成。0.25倍速・512×320・4秒。AIが生成した風景映像ではありません。", evidence / "video-with-audio", ["mp4", "srt"])
    preserve("video-silent", "無音動画の編集", "video", "青色の検証用映像を編集した4秒のMP4。音声トラックを持ちません。", evidence / "video-silent", ["mp4"])
    for kind, label in [("text", "文章から"), ("image", "画像から")]:
        preserve("tiny-video-" + kind, "小型動画モデル・" + label, "video", "約1MBのランダム重みの検証モデルによる実推論。ノイズ状の動画であり、文章に沿った実用映像ではありません。", root / "docs/evidence/video-generation/20261007" / ("verification-" + kind), ["mp4"])
    preserve("transcribe", "文字起こし・字幕", "text", "英語ナレーションをWhisper Tinyで実際に文字起こしした結果。字幕の時刻は区間単位です。", evidence / "transcribe", ["txt", "srt", "json"])
    text = "検証で使用した文章と設定\n\n日本語：こんにちは。動画と音声の制作を確認しています。\n中国語：你好。正在确认视频和音频制作功能。\n英語：Hello. We are testing video and audio production.\n\nBGMの指示：Gentle piano melody\n効果音の指示：Rain falling on a roof\n動画の字幕：動画と音声の合成テスト\n\nAI音声は1秒の短い動作確認用です。小型動画モデルはランダム重みのため、意味のある映像を生成しません。\n"
    (output / "production-text.txt").write_text(text, encoding="utf-8")
    examples.append({"id": "production-text", "title": "制作に使った文章・指示", "type": "text", "description": "読み上げ本文、BGM・効果音の指示、字幕本文を保存しています。", "files": {"txt": "production-text.txt"}})
    temporary = output / "manifest.partial.json"
    temporary.write_text(json.dumps({"examples": examples}, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, output / "manifest.json")
    print(f"検証例を{len(examples)}件保存しました。制作画面から再生・取得できます。")


if __name__ == "__main__":
    main()
