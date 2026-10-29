"""GPU実機試験を隔離領域で実行し、結果と完全なコマンドを保存します。

運用データ・有効モデルは変更しません。モデル取得は明示した公開モデルのみです。
大容量モデルの取得と推論は個別のモードで実施し、失敗を成功へ読み替えません。
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import threading
import runpy
import shutil

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / '.wentian/gpu-verification'
EVIDENCE = ROOT / 'docs/evidence/gpu/20261008'


def module(name, file):
    """ハイフン付き既存スクリプトを変更せず読み込みます。"""
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def run(name, arguments, timeout=1800, stdin=None, extra_env=None):
    """標準出力・標準エラーと終了状態を記録し、失敗時は次の試験へ進みません。"""
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, PYTHONUTF8='1', PYTHONIOENCODING='utf-8')
    env.update(extra_env or {})
    started = time.time()
    samples = []
    finished = threading.Event()

    def monitor():
        """試験中の全GPU使用量を計測します。他アプリ分も含む値であることを記録します。"""
        while not finished.is_set():
            status = subprocess.run(['nvidia-smi', '--query-gpu=memory.used,memory.free,utilization.gpu', '--format=csv,noheader,nounits'], capture_output=True, text=True)
            if status.returncode == 0:
                samples.append({'elapsedSeconds': round(time.time()-started, 2), 'usedFreeMiBAndUtilizationPercent': status.stdout.strip()})
            finished.wait(2)

    watcher = threading.Thread(target=monitor, daemon=True)
    watcher.start()
    try:
        with (EVIDENCE / f'{name}.log').open('w', encoding='utf-8') as output:
            result = subprocess.run(arguments, cwd=ROOT, env=env, input=stdin, text=True,
                                    stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
    finally:
        finished.set()
        watcher.join(timeout=10)
        (EVIDENCE / f'{name}-gpu.json').write_text(json.dumps(samples, indent=2), encoding='utf-8')
    record = {'command': subprocess.list2cmdline(arguments), 'exitCode': result.returncode,
              'elapsedSeconds': time.time()-started}
    (EVIDENCE / f'{name}.json').write_text(json.dumps(record, indent=2), encoding='utf-8')
    print(f'{name}: 終了コード={result.returncode}', flush=True)
    if result.returncode:
        raise RuntimeError(f'{name}が失敗しました。ログを確認してください。')


def prepare():
    """リポジトリ内の固定分類例を試験領域へコピーし、運用領域から分離します。"""
    data = module('prepare_gpu_data', 'prepare-planner-dataset.py')
    directory = WORK / 'planner/runs' / time.strftime('gpu-training-%Y%m%d-%H%M%S')
    directory.mkdir(parents=True, exist_ok=True)
    rows = data.build_rows()
    (directory / 'dataset.jsonl').write_text(''.join(json.dumps(row, ensure_ascii=False)+'\n' for row in rows), encoding='utf-8')
    (directory / 'prompt.json').write_text(json.dumps({'system': data.SYSTEM}), encoding='utf-8')
    return directory


def probe():
    """GPU上の実演算と逆伝播、メモリー解放を実測します。認識のみで合格にしません。"""
    import torch
    assert torch.cuda.is_available(), 'CUDA（CUDA）を利用できません。'
    torch.manual_seed(42)
    tensor = torch.randn(512, 512, device='cuda', requires_grad=True)
    loss = (tensor @ tensor.T).square().mean()
    loss.backward()
    torch.cuda.synchronize()
    assert torch.isfinite(loss) and torch.isfinite(tensor.grad).all()
    result = {'torch': torch.__version__, 'cuda': torch.version.cuda, 'gpu': torch.cuda.get_device_name(),
              'totalBytes': torch.cuda.get_device_properties(0).total_memory,
              'peakAllocatedBytes': torch.cuda.max_memory_allocated(), 'loss': loss.item()}
    del tensor, loss
    torch.cuda.empty_cache()
    result['allocatedAfterReleaseBytes'] = torch.cuda.memory_allocated()
    # 共有RAMも使い切らないよう、物理容量を大幅に超える単一要求の拒否を確認します。
    # CUDA割当失敗後も小さい実演算が成功することを確認し、回復可能性を測定します。
    try:
        impossible = torch.empty(2**38, dtype=torch.float32, device='cuda')
    except torch.cuda.OutOfMemoryError:
        result['oversizedAllocationRejected'] = True
    else:
        del impossible
        raise AssertionError('想定外に巨大GPU割当が成功しました。')
    recovery = torch.ones(16, device='cuda') * 2
    torch.cuda.synchronize()
    assert recovery.sum().item() == 32
    result['operationAfterAllocationFailure'] = True
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    (EVIDENCE / 'cuda-probe.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print('CUDA実演算・逆伝播・解放の確認が完了しました。', flush=True)


def planner(steps, download):
    """実LoRA学習・独立評価・アダプター再読込・GPU推論を順に検証します。"""
    directory = prepare()
    arguments = [sys.executable, str(ROOT/'scripts/train-planner.py'), 'train', '--directory', str(directory), '--steps', str(steps), '--device', 'cuda']
    if download:
        arguments.append('--allow-download')
    run('planner-train', arguments, 21600)
    assert (directory/'adapter/adapter_model.safetensors').stat().st_size > 0
    report = json.loads((directory/'report.json').read_text(encoding='utf-8'))
    assert report['device'] == 'cuda' and report['evaluated'] >= 5
    run('planner-infer', [sys.executable, str(ROOT/'scripts/train-planner.py'), 'infer', '--directory', str(directory)],
        stdin=json.dumps({'system':'', 'input':'こんにちは'}))
    print(f"GPU処理完了。独立評価の精度={report['accuracy']:.3f}、品質合格={report['passed']}", flush=True)


def download_models():
    """固定した公開モデルの安全な重み形式だけを取得し、取得時の版と容量を記録します。"""
    from huggingface_hub import HfApi, snapshot_download
    repositories = {'music': 'facebook/musicgen-small', 'sound': 'cvssp/audioldm-s-full-v2',
                    'transcribe': 'openai/whisper-tiny', 'video': 'Lightricks/LTX-Video',
                    'video-tiny': 'optimum-intel-internal-testing/tiny-random-ltx-video'}
    results = []
    for kind, repository in repositories.items():
        target = WORK / 'models' / kind
        info = HfApi().model_info(repository, token=False, files_metadata=True)
        files = [file for file in info.siblings if file.rfilename.endswith(('.safetensors', '.json', '.txt', '.model', '.tiktoken'))
                 and not file.rfilename.startswith(('onnx/', 'flax/', 'original/'))]
        if kind.startswith('video'):
            files = [file for file in files if file.rfilename == 'model_index.json' or file.rfilename.startswith(('scheduler/', 'tokenizer/', 'text_encoder/', 'transformer/', 'vae/'))]
        size = sum(file.size or 0 for file in files)
        print(f'{kind}のモデル取得を開始します。容量={size/1e9:.2f}GB', flush=True)
        snapshot_download(repository, revision=info.sha, token=False, local_dir=target,
                          allow_patterns=[file.rfilename for file in files])
        record = {'repository': repository, 'revision': info.sha, 'bytes': size,
                  'files': {file.rfilename: (target/file.rfilename).stat().st_size for file in files}}
        if kind == 'video-tiny':
            record['verificationOnly'] = True
        (target/'wentian-model.json').write_text(json.dumps(record, indent=2), encoding='utf-8')
        results.append(record)
        EVIDENCE.mkdir(parents=True, exist_ok=True)
        (EVIDENCE/'downloaded-models.json').write_text(json.dumps(results, indent=2), encoding='utf-8')


def worker(kind, directory):
    """実ワーカーを同一プロセスで起動し、CUDA上のモデル実行を観測します。"""
    import torch
    assert torch.cuda.is_available()
    observed = set()

    def observe(layer, arguments, output):
        # モデル名だけで判定せず、実際のCUDAテンソルを生成した層を記録します。
        values = [output] if isinstance(output, torch.Tensor) else output if isinstance(output, (tuple, list)) else []
        if any(isinstance(value, torch.Tensor) and value.is_cuda for value in values):
            observed.add(type(layer).__name__)

    hook = torch.nn.modules.module.register_module_forward_hook(observe)
    torch.cuda.reset_peak_memory_stats()
    sys.argv = [f'{kind}-worker.py', '--job', str(directory)]
    code = 0
    try:
        runpy.run_path(str(ROOT/'scripts'/f'{kind}-worker.py'), run_name='__main__')
    except SystemExit as error:
        code = error.code or 0
    finally:
        hook.remove()
        trace = {'cudaLayers': sorted(observed), 'peakAllocatedBytes': torch.cuda.max_memory_allocated(),
                 'exitCode': code, 'device': torch.cuda.get_device_name()}
        (directory/'gpu-trace.json').write_text(json.dumps(trace, indent=2), encoding='utf-8')
    if code:
        raise SystemExit(code)
    assert observed and trace['peakAllocatedBytes'] > 1024**2, '実CUDA推論の証拠がありません。'


def media(video_model, only):
    """GPU音声生成・文字起こし・文章／画像動画生成とファイル復号を検証します。"""
    from PIL import Image
    import imageio.v2 as imageio
    import wave
    import math
    import struct
    models = WORK/'models'
    timestamp = time.strftime('%Y%m%d-%H%M%S')
    environment = {'WENTIAN_AUDIO_MODEL_ROOT': str(models), 'WENTIAN_AUDIO_DEVICE': 'cuda:0',
                   'WENTIAN_VIDEO_DEVICE': 'cuda:0', 'WENTIAN_VIDEO_MODEL_PATH': str(models/video_model),
                   'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1'}
    results = []
    kinds = ['music', 'sound', 'transcribe'] if only == 'audio' else ['video-text', 'video-image'] if only == 'video' else ['music', 'sound', 'transcribe', 'video-text', 'video-image']
    for kind in kinds:
        directory = WORK/'media'/timestamp/kind
        directory.mkdir(parents=True, exist_ok=True)
        if kind.startswith('video'):
            request = {'prompt':'A small red ball on a wooden table', 'negativePrompt':'', 'width':256,
                       'height':256, 'frames':9, 'fps':8, 'steps':2, 'seed':42}
            if kind == 'video-image':
                Image.new('RGB', (256,256), (40,80,120)).save(directory/'input.image', format='PNG')
        else:
            request = {'kind':kind, 'prompt':'Soft piano music' if kind == 'music' else 'Ocean waves',
                       'duration':2, 'steps':2, 'seed':42, 'language':'en'}
            if kind == 'transcribe':
                # 個人情報を含む音声は使わず、決定的な試験信号の入出力処理を確認します。
                with wave.open(str(directory/'source.audio'), 'wb') as audio:
                    audio.setparams((1,2,16000,0,'NONE','not compressed'))
                    audio.writeframes(b''.join(struct.pack('<h', int(1000*math.sin(2*math.pi*440*i/16000))) for i in range(32000)))
        (directory/'request.json').write_text(json.dumps(request), encoding='utf-8')
        selected = 'video' if kind.startswith('video') else 'media'
        run(f'{video_model}-{kind}', [sys.executable, str(Path(__file__).resolve()), 'worker', '--worker', selected, '--directory', str(directory)],
            timeout=3600, extra_env=environment)
        trace = json.loads((directory/'gpu-trace.json').read_text(encoding='utf-8'))
        if selected == 'video':
            reader = imageio.get_reader(directory/'output.mp4')
            count = 0
            for frame in reader:
                assert frame.shape[:2] == (256,256)
                count += 1
            reader.close()
            assert count == 9, count
            detail = {'frames':count, 'bytes':(directory/'output.mp4').stat().st_size}
        elif kind == 'transcribe':
            detail = json.loads((directory/'output.json').read_text(encoding='utf-8'))
            assert (directory/'output.srt').is_file()
        else:
            with wave.open(str(directory/'output.wav')) as audio:
                detail = {'duration':audio.getnframes()/audio.getframerate(), 'channels':audio.getnchannels()}
            assert abs(detail['duration']-2)<0.15
            assert (directory/'output.mp3').stat().st_size>0
        results.append({'kind':kind, 'directory':str(directory.relative_to(ROOT)), 'trace':trace, 'output':detail})
        (EVIDENCE/f'{video_model}-media-results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')


def lifecycle():
    """実GPU学習の停止とGPU不在時の失敗を、実際の管理サービス経由で確認します。"""
    prepare_module = module('gpu_lifecycle_data', 'prepare-planner-dataset.py')
    root = WORK/'lifecycle'/time.strftime('%Y%m%d-%H%M%S')
    root.mkdir(parents=True, exist_ok=True)
    # 取得済みキャッシュをハードリンク（Hard Link）で共有し、ネットワークと重複容量を使いません。
    shutil.copytree(WORK/'planner/model-cache', root/'model-cache', copy_function=os.link)
    (root/'training-prompt.json').write_text(json.dumps({'system':prepare_module.SYSTEM}), encoding='utf-8')
    rows = prepare_module.build_rows()
    (root/'fixture.json').write_text(json.dumps(rows), encoding='utf-8')
    # シェル展開を避け、検証コードと引数を直接Nodeへ渡します。
    code = r'''
// 実学習の停止と失敗状態を隔離領域で検証します。運用モデルは変更しません。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {PlannerTrainingService} from './src/planner-training.ts';
const root=process.argv[1];
const service=new PlannerTrainingService(root);
const rows=JSON.parse(await fs.readFile(path.join(root,'fixture.json'),'utf8'));
await service.importExamples(rows);
const job=await service.start({steps:2000,device:'cuda'});
await assert.rejects(service.activate(job.id));
const until=Date.now()+240000;
let observed=false;
while(Date.now()<until){
 const state=await service.status();
 const current=state.runs.find(r=>r.id===job.id);
 if(current?.progress?.step>=1){observed=true;break;}
 if(!state.running)throw new Error('停止試験前にGPU学習が失敗しました。'+current?.error);
 await new Promise(resolve=>setTimeout(resolve,500));
}
try{assert.ok(observed,'GPU学習の開始を確認できません。');}finally{await service.stop();}
const stopped=await service.status();
assert.equal(stopped.running,false);
assert.equal(stopped.runs.find(r=>r.id===job.id).status,'failed');
assert.equal(stopped.active,null);
// 停止表示だけで合格にせず、停止後に損失ログが増えないことも確認します。
const losses=path.join(root,'runs',job.id,'losses.jsonl');
const before=await fs.readFile(losses,'utf8');
await new Promise(resolve=>setTimeout(resolve,1500));
assert.equal(await fs.readFile(losses,'utf8'),before);
await assert.rejects(service.activate(job.id));
// GPUを隠す環境変数はこのNodeプロセスの子だけへ適用します。
process.env.CUDA_VISIBLE_DEVICES='-1';
const failure=await service.start({steps:1,device:'cuda'});
const limit=Date.now()+120000;
while((await service.status()).running&&Date.now()<limit)await new Promise(resolve=>setTimeout(resolve,500));
const unavailable=await service.status();
assert.equal(unavailable.running,false);
const failed=unavailable.runs.find(r=>r.id===failure.id);
assert.equal(failed.status,'failed');
assert.match(failed.error,/CUDA/);
await assert.rejects(service.activate(failure.id));
await fs.writeFile(path.join(root,'result.json'),JSON.stringify({gpuTrainingObserved:observed,stop:stopped,gpuUnavailable:unavailable},null,2));
console.log('実GPU学習停止・失敗保存・有効化拒否の試験が成功しました。');
'''
    run('planner-lifecycle', ['node','--import','tsx','--input-type=module','-e',code,str(root)],
        timeout=600, extra_env={'WENTIAN_TRAINING_PYTHON':sys.executable})
    import psutil
    # Pythonランチャー（Launcher）の孫プロセスまで確認し、停止後のGPU占有を見逃しません。
    for process in psutil.process_iter(['pid', 'name', 'cmdline']):
        try:
            command = ' '.join(process.info['cmdline'] or [])
            assert not ('train-planner.py' in command and str(root) in command), f"学習プロセスが残っています: {process.pid}"
        except (psutil.AccessDenied, psutil.NoSuchProcess):
            continue


def boundaries():
    """保存重み・チェックポイント・入力長制限・自動デバイス選択を実モデルで確認します。"""
    import torch
    from safetensors.torch import load_file
    engine = module('gpu_boundary_engine', 'train-planner.py')
    directory = next(p for p in (WORK/'planner/runs').iterdir()
                     if (p/'report.json').is_file() and json.loads((p/'report.json').read_text(encoding='utf-8'))['steps'] == 200)
    weights = load_file(str(directory/'adapter/adapter_model.safetensors'))
    assert all(torch.isfinite(value).all() for value in weights.values())
    assert any('lora_B' in key and value.abs().sum().item()>0 for key,value in weights.items())
    checkpoint = load_file(str(directory/'checkpoints/step-200/adapter_model.safetensors'))
    assert weights.keys() == checkpoint.keys()
    assert all(torch.equal(weights[key], checkpoint[key]) for key in weights)
    torch, tokenizer, model, selected = engine.load_model(directory, adapter=True, device='auto')
    model.eval()
    assert selected == 'cuda' and next(model.parameters()).is_cuda
    system = json.loads((directory/'prompt.json').read_text(encoding='utf-8'))['system']
    predictions = [engine.generate(torch, tokenizer, model, system, 'こんにちは') for _ in range(2)]
    assert predictions[0] == predictions[1]
    json.loads(predictions[0])
    try:
        engine.generate(torch, tokenizer, model, system, 'hello '*10000)
    except ValueError as error:
        assert '文脈上限' in str(error)
    else:
        raise AssertionError('上限超過のGPU推論入力が拒否されませんでした。')
    peak = torch.cuda.max_memory_allocated()
    del model
    torch.cuda.empty_cache()
    torch, tokenizer, cpu, selected = engine.load_model(directory, device='cpu')
    assert selected == 'cpu' and not next(cpu.parameters()).is_cuda
    del cpu
    result = {'finiteAdapterWeights': True, 'adapterUpdated': True, 'checkpointMatchesFinal': True,
              'autoSelectedCuda': True, 'repeatedInferenceMatches': True, 'oversizedInputRejected': True,
              'explicitCpuRespected': True, 'peakCudaAllocatedBytes': peak, 'prediction': json.loads(predictions[0])}
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    (EVIDENCE/'planner-boundaries.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print('GPU推論・保存重み・入力制限・CPU明示指定の試験が成功しました。', flush=True)


def capacity():
    """公開された4096トークン上限近くの実学習を、独立した試験ジョブで確認します。"""
    from transformers import AutoTokenizer
    engine = module('gpu_capacity_engine', 'train-planner.py')
    source = module('gpu_capacity_examples', 'prepare-planner-dataset.py')
    directory = prepare()
    system = 'Classify the request. Return only the correct JSON object.'
    tokenizer = AutoTokenizer.from_pretrained(engine.BASE_MODEL, revision=engine.BASE_REVISION,
                                              cache_dir=WORK/'planner/model-cache', local_files_only=True, trust_remote_code=False)
    label = source.build_rows()[0]['label']
    rows, lengths = [], []
    for index in range(20):
        low, high = 1, 3900
        def encoded(count):
            text = 'あ ' * count + str(index)
            return tokenizer.apply_chat_template([{'role':'system','content':system}, {'role':'user','content':text},
                                                   {'role':'assistant','content':json.dumps(label,ensure_ascii=False)}], tokenize=True)
        while low < high:
            middle = (low+high+1)//2
            if len(encoded(middle)) <= 4096:
                low = middle
            else:
                high = middle-1
        text = 'あ '*low+str(index)
        assert len(text) <= 8000
        lengths.append(len(encoded(low)))
        rows.append({'input':text,'label':label,'reviewed':True,'split':'train'})
    assert min(lengths) >= 4094
    rows.extend([{**row,'split':'evaluation'} for row in source.build_rows()[:5]])
    (directory/'dataset.jsonl').write_text(''.join(json.dumps(row,ensure_ascii=False)+'\n' for row in rows),encoding='utf-8')
    (directory/'prompt.json').write_text(json.dumps({'system':system}),encoding='utf-8')
    run('planner-capacity', [sys.executable,str(ROOT/'scripts/train-planner.py'),'train','--directory',str(directory),'--steps','1','--device','cuda'], timeout=1200)
    report = json.loads((directory/'report.json').read_text(encoding='utf-8'))
    result = {'directory':str(directory.relative_to(ROOT)), 'trainingTokenLengths':lengths,
              'device':report['device'], 'finalLoss':report['finalLoss'], 'qualityPassed':report['passed']}
    (EVIDENCE/'planner-capacity-result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')


def summarize():
    """実ファイルから最終証拠を集約し、過去の失敗試行と最終結果を区別します。"""
    import wave
    import imageio.v2 as imageio
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    trained = next(p for p in (WORK/'planner/runs').iterdir() if (p/'report.json').is_file()
                   and json.loads((p/'report.json').read_text(encoding='utf-8'))['steps'] == 200)
    shutil.copy2(trained/'report.json', EVIDENCE/'planner-quality.json')
    quality = json.loads((trained/'report.json').read_text(encoding='utf-8'))
    lifecycle_result = sorted((WORK/'lifecycle').glob('*/result.json'))[-1]
    shutil.copy2(lifecycle_result, EVIDENCE/'planner-lifecycle-result.json')
    outputs = {}
    for trace_file in sorted((WORK/'media').glob('*/*/gpu-trace.json')):
        directory = trace_file.parent
        kind = directory.name
        trace = json.loads(trace_file.read_text(encoding='utf-8'))
        assert trace['exitCode'] == 0 and trace['cudaLayers']
        if kind.startswith('video'):
            reader = imageio.get_reader(directory/'output.mp4')
            frames = list(reader.iter_data())
            reader.close()
            assert len(frames) == 9 and frames[0].shape[:2] == (256,256)
            imageio.imwrite(EVIDENCE/f'{kind}-first-frame.png', frames[0])
            output = {'frames':len(frames),'width':256,'height':256,'bytes':(directory/'output.mp4').stat().st_size}
        elif kind == 'transcribe':
            output = json.loads((directory/'output.json').read_text(encoding='utf-8'))
        else:
            with wave.open(str(directory/'output.wav')) as audio:
                output = {'durationSeconds':audio.getnframes()/audio.getframerate(),'channels':audio.getnchannels()}
            assert abs(output['durationSeconds']-2)<0.15 and (directory/'output.mp3').stat().st_size>0
        outputs[kind] = {'directory':str(directory.relative_to(ROOT)), 'gpuTrace':trace, 'output':output}
    assert set(outputs) == {'music','sound','transcribe','video-text','video-image'}
    summary = {'gpu':json.loads((EVIDENCE/'cuda-probe.json').read_text(encoding='utf-8')),
               'plannerTraining':{key:quality[key] for key in ['steps','trainingExamples','evaluated','accuracy','unsafeWrites','passed','finalLoss','elapsedSeconds','datasetSha256']},
               'plannerDirectory':str(trained.relative_to(ROOT)), 'media':outputs,
               'containerGpu':'利用者の指定で基盤を導入しないため未実施',
               'productionModelActivated':False}
    (EVIDENCE/'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2),encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def main():
    """個別試験を選択し、明示しない重い取得・学習を開始しません。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['probe', 'planner', 'download', 'media', 'worker', 'lifecycle', 'boundaries', 'capacity', 'summary'])
    parser.add_argument('--steps', type=int, default=100)
    parser.add_argument('--allow-download', action='store_true')
    parser.add_argument('--video-model', choices=['video', 'video-tiny'], default='video')
    parser.add_argument('--worker', choices=['video', 'media'])
    parser.add_argument('--directory', type=Path)
    parser.add_argument('--only', choices=['all', 'audio', 'video'], default='all')
    args = parser.parse_args()
    if args.mode == 'probe':
        probe()
    elif args.mode == 'planner':
        planner(args.steps, args.allow_download)
    elif args.mode == 'download':
        download_models()
    elif args.mode == 'media':
        media(args.video_model, args.only)
    elif args.mode == 'lifecycle':
        lifecycle()
    elif args.mode == 'boundaries':
        boundaries()
    elif args.mode == 'capacity':
        capacity()
    elif args.mode == 'summary':
        summarize()
    else:
        if not args.worker or not args.directory:
            parser.error('ワーカーと試験保存先が必要です。')
        worker(args.worker, args.directory)


if __name__ == '__main__':
    main()
