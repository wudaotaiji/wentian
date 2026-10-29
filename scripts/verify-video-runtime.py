"""運用設定と同じ動画・音声ワーカーを隔離フォルダーで実行し、LLMとの共存を検証します。"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time


def main():
    """秘密値は表示せず、制作に必要な設定だけを引き継いで実映像と音声を検査します。"""
    root=Path(__file__).resolve().parents[1]
    environment=dict(os.environ,PYTHONUTF8='1',PYTHONIOENCODING='utf-8')
    # 本番と同じ.envから制作関連の設定だけを読み、他機能の認証情報は扱いません。
    for line in (root/'.env').read_text(encoding='utf-8-sig').splitlines():
        key,separator,value=line.partition('=')
        if separator and key.startswith(('WENTIAN_VIDEO_','WENTIAN_AUDIO_','WENTIAN_FFMPEG','WENTIAN_FFPROBE')):
            environment[key]=value.strip().strip('"')
    python=environment['WENTIAN_VIDEO_PYTHON']
    evidence=root/'docs/evidence/video-runtime/20261008'
    evidence.mkdir(parents=True,exist_ok=True)
    work=root/'.wentian/video-runtime-verification'/time.strftime('%Y%m%d-%H%M%S')
    work.mkdir(parents=True)
    def run(name,script,arguments):
        # 完全なコマンドと終了コードを保存し、標準出力は進捗ログとして分離します。
        command=[python,str(root/'scripts'/script),*arguments]
        with (evidence/f'{name}.log').open('w',encoding='utf-8') as log:
            result=subprocess.run(command,cwd=root,env=environment,stdout=log,stderr=subprocess.STDOUT,timeout=1800)
        (evidence/f'{name}-command.json').write_text(json.dumps({'argv':command,'exitCode':result.returncode},ensure_ascii=False,indent=2),encoding='utf-8')
        if result.returncode:raise RuntimeError(f'{name}の実処理に失敗しました。証拠ログを確認してください。')
    audio=work/'audio'
    audio.mkdir()
    (audio/'request.json').write_text(json.dumps({'kind':'speech','text':'これは動画の音声動作確認です。','voice':'Microsoft Haruka Desktop','rate':0,'volume':100},ensure_ascii=False),encoding='utf-8')
    run('speech','media-worker.py',['--job',str(audio)])
    print('実際の日本語ナレーションを作成しました。',flush=True)
    video=work/'video'
    video.mkdir()
    (video/'request.json').write_text(json.dumps({'prompt':'A red ball on a wooden table, gentle camera movement','negativePrompt':'','width':256,'height':256,'frames':9,'fps':8,'steps':2,'seed':42,'audioVolume':1}),encoding='utf-8')
    shutil.copy2(audio/'output.wav',video/'soundtrack.audio')
    print('既存LLMを稼働させたまま、省メモリー動画生成と音声合成を検証します。',flush=True)
    run('video','video-worker.py',['--job',str(video)])
    probe=subprocess.run([environment['WENTIAN_FFPROBE'],'-v','error','-show_streams','-show_format','-of','json',str(video/'output.mp4')],capture_output=True,text=True,encoding='utf-8',check=True)
    detail=json.loads(probe.stdout)
    assert {'audio','video'}.issubset({stream['codec_type'] for stream in detail['streams']})
    # メタ情報だけで成功扱いせず、全フレームと音声を最後までデコードします。
    subprocess.run([environment['WENTIAN_FFMPEG'],'-v','error','-i',str(video/'output.mp4'),'-f','null','-'],capture_output=True,check=True)
    (evidence/'result.json').write_text(json.dumps({'passed':True,'directory':str(work),'probe':detail},ensure_ascii=False,indent=2),encoding='utf-8')
    print('音声付きMP4の実生成と全デコードが成功しました。',flush=True)


if __name__=='__main__':
    main()
