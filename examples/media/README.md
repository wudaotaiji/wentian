# 保存した制作例

制作画面 `/media-studio#examples` の「保存した制作例」から再生・ダウンロードできます。こちらのファイルは通常の作品削除では消えません。`manifest.json` に全12例の説明と形式を保存しています。

| 内容 | ファイル |
|---|---|
| 制作に使った文章・指示 | [文章](production-text.txt) |
| 日本語ナレーション | [WAV](speech-ja.wav) / [MP3](speech-ja.mp3) |
| 中国語ナレーション | [WAV](speech-zh.wav) / [MP3](speech-zh.mp3) |
| 英語ナレーション | [WAV](speech-en.wav) / [MP3](speech-en.mp3) |
| AI BGM・1秒 | [WAV](ai-music.wav) / [MP3](ai-music.mp3) |
| AI 効果音・1秒 | [WAV](ai-sound.wav) / [MP3](ai-sound.mp3) |
| 音声編集・2トラック | [WAV](audio-mix.wav) / [MP3](audio-mix.mp3) |
| 音声・字幕付き動画 | [MP4](video-with-audio.mp4) / [字幕](video-with-audio.srt) |
| 無音動画 | [MP4](video-silent.mp4) |
| 小型モデル・文章から動画 | [MP4](tiny-video-text.mp4) |
| 小型モデル・画像から動画 | [MP4](tiny-video-image.mp4) |
| 文字起こし | [本文](transcribe.txt) / [字幕](transcribe.srt) / [JSON](transcribe.json) |

動画編集例は青色の検証用素材です。小型モデルの動画はランダム重みによるノイズ状の動画であり、文章に沿った実用映像ではありません。AI効果音は2ステップの動作確認用です。BGMのモデルはCC-BY-NC 4.0、効果音モデルはCC-BY-NC-SA 4.0です。

検証後に再保存する場合は `pwsh -File scripts/preserve-media-examples.ps1` または `python scripts/preserve-media-examples.py` を使用します。
