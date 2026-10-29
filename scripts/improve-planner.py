"""分類モデルの失敗分析・対比例追加・再学習・未使用評価を実施する。

既存45例は開発用評価として保持し、新しい最終評価は学習前に固定する。
最終評価を見た候補の再調整には同じ最終評価を使わず、運用の有効化も別操作にする。
利用者の会話・運用ファイルを教師データとして収集しない。
"""
import argparse
import collections
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import time
import uuid
import subprocess

PROJECT = Path(__file__).resolve().parent.parent
ROOT = PROJECT/'.wentian/planner-quality-improvement'
EVIDENCE = PROJECT/'docs/evidence/planner-improvement/20261008'


def module(name, file):
    """既存エンジンと固定例を、ハイフンを含むファイル名のまま読み込みます。"""
    spec = importlib.util.spec_from_file_location(name, PROJECT/'scripts'/file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def save(file, value):
    """日本語の証拠をUTF-8で保存します。秘密値や環境変数全体は保存しません。"""
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')


def label(language, kind, **values):
    """確認した意図ごとの完全な正解を構築し、操作と能力の不整合を防ぎます。"""
    result = {'intent':'chat','operation':'answer','language':language,'evidence_source':'none',
              'required_capabilities':['text'],'tools':[],
              'delegation':{'enabled':False,'parallel':False,'requested_agents':[]}}
    if kind in ('read','write'):
        result.update(intent='local_tool',operation=kind,evidence_source='workspace',
                      required_capabilities=['file_read'] if kind=='read' else ['file_read','file_write'],
                      tools=['list_files','read_file'] if kind=='read' else ['read_file','write_file'])
    elif kind in ('runtime','kubernetes'):
        tool = 'run_command' if kind=='runtime' else 'inspect_kubernetes'
        result.update(intent='local_tool',operation='read',evidence_source='runtime',required_capabilities=['terminal'],tools=[tool],
                      runtime_requirements=[{'tool':tool}] if kind=='runtime' else [{'tool':tool,'operation':'top','resource':'pods'},{'tool':tool,'operation':'get','resource':'pods'}])
    elif kind=='image':
        result.update(intent='analyze_image',operation='read',required_capabilities=['vision'],tools=['read_image'])
    elif kind in ('search','weather','exchange'):
        result.update(intent='web_research',operation='read',evidence_source='web',required_capabilities=['web'],tools=['web_research'],research=values.pop('research'))
    elif kind in ('delegate-read','delegate-write'):
        agent=values.pop('agent')
        write=kind=='delegate-write'
        result.update(intent='delegate_external',operation='write' if write else 'read',evidence_source='workspace' if write else 'none',
                      required_capabilities=['file_read','file_write'] if write else ['review'],tools=['read_file','write_file'] if write else [],
                      delegation={'enabled':True,'parallel':False,'requested_agents':[agent]})
    result.update(values)
    return result


def final_examples():
    """学習用の置換テンプレートと別に記述した、40場面×3言語の最終評価です。"""
    rows=[]
    def add(kind, texts, **values):
        # 同じ場面の翻訳を一つの評価群にし、学習側へ分割しません。
        group=f'final-{len(rows)//3+1:02d}'
        for language,text in zip(('ja','zh','en'),texts,strict=True):
            extra=dict(values)
            if kind=='search':extra['research']={'kind':'search','query':text}
            rows.append({'input':text,'label':label(language,kind,**extra),'reviewed':True,'split':'evaluation','group':group,'category':kind})
    add('answer', ['こんばんは。少し質問しても構いませんか','晚上好，我可以问个问题吗','Good evening. May I ask you something?'])
    add('answer', ['変数のスコープについて初心者向けに説明してください','请面向初学者解释变量作用域','Explain variable scope for a beginner.'])
    add('answer', ['次の文章を要約してください：毎日少しずつ学ぶことが大切です','概括这段话：每天坚持学习一点很重要','Summarize this sentence: Learning a little every day matters.'])
    add('answer', ['コードを変更する前に、例外処理の設計を相談したい','在改动代码之前，我想讨论异常处理的设计','Before changing any code, I want to discuss exception handling design.'])
    add('answer', ['昨日頼んだ設定変更について、現在の作業状況を説明して','说一下昨天委托的配置变更目前进展如何','Explain the progress of the configuration change I requested yesterday.'])
    add('answer', ['「古いログを削除して」という日本語を中国語に訳してください','把“删除旧日志”这句话翻译成日语','Translate the phrase "delete old logs" into Japanese.'])
    add('answer', ['ファイル作成は実行せず、必要な手順だけ説明してください','不要实际创建文件，只说明所需步骤','Do not create any files; describe the required procedure only.'])
    add('answer', ['私の発言「ログインを実装して」は、どう解釈されましたか','我说的“实现登录”当时被理解成什么了','How was my earlier statement "implement login" interpreted?'])
    add('read', ['docsにある移行資料を探して内容を報告してください。編集は禁止です','找出docs中的迁移资料并汇报内容，禁止编辑','Find the migration documents in docs and report their contents. Editing is prohibited.'])
    add('read', ['設定の読み込み処理がどのファイルにあるか確認してください','确认负责读取配置的是哪个源文件','Determine which source file loads the configuration.'])
    add('read', ['障害ログを調べて原因の候補を挙げてください。修正はまだ不要です','检查故障日志，列出可能原因，暂时不要修复','Inspect the failure logs and list possible causes. Do not fix anything yet.'])
    add('write', ['settings.jsonのタイムアウトを30秒に変更して保存してください','把settings.json中的超时改成30秒并保存','Change the timeout in settings.json to 30 seconds and save it.'])
    add('write', ['検索フォームの入力チェックを実装し、ソースへ反映してください','实现搜索表单的输入校验，并保存到源码','Implement input validation for the search form and save the source changes.'])
    add('write', ['docs/setup.mdへ環境変数の説明を新しく書き加えてください','在docs/setup.md中补充环境变量的说明','Add an explanation of environment variables to docs/setup.md.'])
    add('runtime', ['このPCで実際に利用可能なディスク容量を今測定してください','现在实测这台电脑可用的磁盘容量','Measure the disk space actually available on this PC now.'])
    add('runtime', ['現在起動しているプロセスを実環境から取得してください','从实际环境获取当前启动的进程','Retrieve the processes currently running in the actual environment.'])
    add('runtime', ['現在のメモリ使用状況を、この端末で測って報告してください','在这台终端上测量并报告当前内存使用状况','Measure and report current memory consumption on this machine.'])
    add('kubernetes', ['いま動いているPodのCPUとメモリを実測値で示してください','给出当前运行Pod的CPU和内存实测值','Show measured CPU and memory usage of the pods running now.'])
    add('kubernetes', ['クラスター内のPodが現時点でどれだけ資源を消費しているか取得して','获取集群中Pod此刻消耗了多少资源','Retrieve how many resources the cluster pods are consuming at this moment.'])
    add('kubernetes', ['Podごとの現在の負荷とrequests、limitsを調査してください','调查每个Pod当前负载以及requests和limits','Investigate each pod’s current load, requests, and limits.'])
    add('image', ['添付のエラー画面を見て、読める内容を説明してください','查看附件里的报错画面，解释其中可读的内容','Look at the attached error screen and explain the visible contents.'])
    add('image', ['この写真に表示されたラベルの文字を読み取ってください','读取这张照片标签上的文字','Read the lettering on the label in this photo.'])
    add('image', ['送信した構成図の内容を読み解いてください','解读我发送的架构图','Interpret the architecture diagram I sent.'])
    add('delegate-read', ['Kiloへ読み取り限定で設定レビューを依頼してください。変更禁止です','请Kilo以只读方式审查配置，禁止变更','Ask Kilo to review the configuration in read-only mode. Changes are prohibited.'],agent='kilo')
    add('delegate-read', ['OpenCodeに不具合の原因調査だけを担当させ、修正はさせないで','让OpenCode只调查故障原因，不要让它修复','Have OpenCode investigate the cause of the fault only; do not let it fix it.'],agent='opencode')
    add('delegate-read', ['Kiloにコードを見てもらい改善案だけ報告させてください','让Kilo查看代码，只汇报改进建议','Have Kilo inspect the code and report suggestions only.'],agent='kilo')
    add('delegate-write', ['OpenCodeに検索画面のバグ修正と保存を任せてください','把搜索页面bug的修复和保存交给OpenCode','Delegate fixing and saving the search page bug to OpenCode.'],agent='opencode')
    add('delegate-write', ['Kiloへ設定ファイルの修正を実際に実施するよう依頼して','请Kilo实际执行配置文件的修改','Ask Kilo to actually modify the configuration file.'],agent='kilo')
    add('delegate-write', ['OpenCodeを担当にして、テストファイルを追加してください','由OpenCode负责添加测试文件','Assign OpenCode to add the test files.'],agent='opencode')
    add('search', ['ウェブ上でFastAPIの公式チュートリアルを見つけてください','在网上寻找FastAPI的官方教程','Find the official FastAPI tutorial on the web.'])
    add('search', ['PostgreSQLのバックアップ方法を公式サイトで調べてください','在官网查找PostgreSQL的备份方法','Look up PostgreSQL backup instructions on the official website.'])
    add('search', ['インターネットでRedisのリリース情報を確認してください','在互联网上确认Redis的发布信息','Check Redis release information on the internet.'])
    add('weather', ['今から出かけるので、大阪の今日の天気を調べてください','我要出门，请查一下大阪今天的天气','I am going out; look up today’s weather in Osaka.'],research={'kind':'weather','location':'Osaka'})
    add('weather', ['北京の明日の空模様を確認してください','确认北京明天的天气状况','Check tomorrow’s weather conditions in Beijing.'],research={'kind':'weather','location':'Beijing'})
    add('weather', ['ロンドンの最新の天気予報を取得してください','获取伦敦最新的天气预报','Retrieve the latest weather forecast for London.'],research={'kind':'weather','location':'London'})
    add('exchange', ['いまのEUR/USDの為替相場を確認してください','确认此刻EUR/USD的外汇行情','Check the EUR/USD exchange rate at this moment.'],research={'kind':'exchange','currencies':['EUR','USD']})
    add('exchange', ['最新のCNY/JPY交換レートを調べてください','查找最新的CNY/JPY兑换汇率','Look up the latest CNY/JPY conversion rate.'],research={'kind':'exchange','currencies':['CNY','JPY']})
    add('exchange', ['現在のGBP/JPYの交換比率を教えてください','告诉我当前GBP/JPY兑换比率','Tell me the current GBP/JPY conversion ratio.'],research={'kind':'exchange','currencies':['GBP','JPY']})
    add('read', ['外部へ任せず、あなた自身でREADME.mdを読んでください','不要委托外部，由你自己读取README.md','Do not delegate externally; read README.md yourself.'],execution_mode='direct')
    add('answer', ['修正は実行せず、設定変更の提案だけを示してください','不要执行修改，只提出配置变更建议','Do not apply any edits; propose configuration changes only.'],execution_mode='propose')
    assert len(rows)==120
    return rows


def training_examples():
    """既存例に、操作境界・別表現・パラメーター保持の対比例を追加します。"""
    original=module('quality_original','prepare-planner-dataset.py')
    rows=[{**row,'category':'original'} for row in original.build_rows() if row['split']=='train']
    def add(kind,texts,**values):
        for language,text in zip(('ja','zh','en'),texts,strict=True):
            extra=dict(values)
            if kind=='search':extra['research']={'kind':'search','query':text}
            rows.append({'input':text,'label':label(language,kind,**extra),'reviewed':True,'split':'train','category':kind})
    for target in ['config.yaml','docs/architecture.md','src/auth.ts','logs/service.log','settings.ini','tests/parser.test.ts']:
        add('read',[f'{target}を読み、編集をせずに内容を確認して',f'读取{target}并检查内容，不进行编辑',f'Read {target} and inspect its contents without editing it'])
        add('read',[f'{target}の問題点を報告するだけにして。ファイルはそのままにして',f'仅汇报{target}的问题，保持文件不变',f'Only report issues in {target}; leave the file unchanged'])
        add('write',[f'{target}の不具合を修正して変更を保存して',f'修复{target}的问题并保存变更',f'Fix the issue in {target} and save the changes'])
        add('write',[f'{target}へ必要な実装を追加して',f'向{target}添加所需的实现',f'Add the required implementation to {target}'])
        add('answer',[f'以前お願いした{target}の修正はどこまで進んでいますか',f'之前请求的{target}修复进展到哪里了',f'How far has the previously requested fix to {target} progressed?'])
        add('answer',[f'「{target}を書き換えて」という言葉だけ英訳して',f'只翻译“修改{target}”这句话，不要操作',f'Translate only the words "modify {target}"; take no action'])
    for agent in ['kilo','opencode']:
        for ja,zh,en in [('認証処理','认证处理','authentication'),('入力検証','输入校验','input validation'),('エラー処理','错误处理','error handling'),('設定ロード','配置加载','configuration loading')]:
            add('delegate-read',[f'{agent}に{ja}のレビューだけ頼んで。修正はしないで',f'让{agent}只审查{zh}，不要修改',f'Ask {agent} to review {en} only; do not change anything'],agent=agent)
            add('delegate-read',[f'{agent}へ{ja}の問題の指摘を依頼して、読み取り専用に限定して',f'请{agent}指出{zh}的问题，限定只读',f'Have {agent} identify issues in {en}, restricted to read-only work'],agent=agent)
            add('delegate-write',[f'{agent}に{ja}を実装して保存するよう依頼して',f'请{agent}实现{zh}并保存',f'Ask {agent} to implement {en} and save the work'],agent=agent)
            add('answer',[f'「{agent}に{ja}を修正させて」という引用文の意味を説明して',f'解释引用句“让{agent}修复{zh}”的意思',f'Explain the quoted phrase "have {agent} fix {en}"'])
    for ja,zh,en in [('空き容量','剩余空间','free space'),('CPU負荷','CPU负载','CPU load'),('メモリ消費','内存消耗','memory consumption'),('プロセス一覧','进程列表','process list')]:
        add('runtime',[f'いまこのPCの{ja}を実測して',f'现在实测这台PC的{zh}',f'Measure this PC’s {en} right now'])
        add('runtime',[f'この端末から最新の{ja}を取得して報告して',f'从这台终端获取最新{zh}并汇报',f'Retrieve and report the latest {en} from this terminal'])
        add('answer',[f'{ja}を測定する仕組みを説明して。実行は不要です',f'解释测量{zh}的原理，无需执行',f'Explain how measuring {en} works; no execution is needed'])
    for ja,zh,en in [('Podの負荷','Pod的负载','pod load'),('PodのCPU使用量','Pod的CPU使用量','pod CPU usage'),('Podのメモリ消費','Pod的内存消耗','pod memory consumption')]:
        add('kubernetes',[f'現在の{ja}を実環境で確認して',f'在实际环境中确认当前{zh}',f'Inspect current {en} in the actual environment'])
        add('kubernetes',[f'Kubernetesの{ja}とrequests、limitsを調査して',f'调查Kubernetes的{zh}以及requests和limits',f'Investigate Kubernetes {en}, requests and limits'])
    for ja,zh,en in [('写真','照片','photo'),('エラー画像','错误图片','error image'),('スクリーンショット','截图','screenshot'),('構成図','架构图','architecture diagram')]:
        add('image',[f'添付した{ja}を見て読み取れる内容を説明して',f'查看附件的{zh}，解释可读内容',f'Look at the attached {en} and explain what is visible'])
        add('image',[f'この{ja}に写る文字や図を読み取って',f'读取这张{zh}中的文字和图形',f'Read the text and diagrams shown in this {en}'])
    for topic in ['PEFT','PyTorch','FastAPI','PostgreSQL','Redis','NVIDIA CUDA']:
        add('search',[f'{topic}の使い方をネットで検索して',f'在网上搜索{topic}的用法',f'Search online for how to use {topic}'])
        add('search',[f'ウェブ上から{topic}の公式説明を探してください',f'从网络上寻找{topic}的官方说明',f'Find the official explanation of {topic} on the web'])
    for location,ja,zh,en in [('Tokyo','東京','东京','Tokyo'),('Osaka','大阪','大阪','Osaka'),('Beijing','北京','北京','Beijing'),('London','ロンドン','伦敦','London')]:
        add('weather',[f'{ja}の現在の空模様を調べて',f'查一下{zh}现在的天气状况',f'Look up current weather conditions in {en}'],research={'kind':'weather','location':location})
        add('weather',[f'{ja}へ行くので明日の天気を確認して',f'我要去{zh}，确认一下明天的天气',f'I am visiting {en}; check tomorrow’s weather'],research={'kind':'weather','location':location})
    for a,b in [('USD','JPY'),('EUR','USD'),('CNY','JPY'),('GBP','JPY')]:
        pair=f'{a}/{b}'
        add('exchange',[f'最新の{pair}の交換比率を取得して',f'获取最新的{pair}兑换比率',f'Retrieve the latest {pair} conversion ratio'],research={'kind':'exchange','currencies':[a,b]})
        add('exchange',[f'いま{pair}はいくらで交換できますか',f'现在{pair}可以按什么汇率兑换',f'At what rate can {pair} be exchanged right now?'],research={'kind':'exchange','currencies':[a,b]})
    for target in ['README.md','docs/api.md','src/config.ts']:
        add('read',[f'あなたが直接{target}を調べて。外部エージェントへ回さないで',f'由你直接检查{target}，不要交给外部代理',f'Inspect {target} directly yourself; do not pass it to an external agent'],execution_mode='direct')
        add('answer',[f'{target}の変更案だけ提案して。実際には書き換えないで',f'仅提出{target}的修改建议，不要实际改写',f'Only propose changes to {target}; do not actually edit it'],execution_mode='propose')
    # 入力の一意性を確認し、旧評価例や新最終評価を教師データへ追加しません。
    assert len({row['input'] for row in rows})==len(rows)
    return rows


def prepare():
    """評価セットを学習前に固定し、分離ハッシュ・構成・失敗分析を保存します。"""
    if (ROOT/'dataset-manifest.json').exists():
        raise RuntimeError('既存の固定データを上書きしません。保存済みデータを利用してください。')
    original=module('quality_prepare_original','prepare-planner-dataset.py')
    training=training_examples()
    development=[row for row in original.build_rows() if row['split']=='evaluation']
    final=final_examples()
    sets=[{row['input'] for row in rows} for rows in (training,development,final)]
    assert not (sets[0]&sets[1] or sets[0]&sets[2] or sets[1]&sets[2])
    ROOT.mkdir(parents=True,exist_ok=True)
    cache=PROJECT/'.wentian/gpu-verification/planner/model-cache'
    if cache.exists():shutil.copytree(cache,ROOT/'model-cache',copy_function=os.link)
    manifest={}
    for name,rows in [('training',training),('development',development),('final',final)]:
        file=ROOT/f'{name}.jsonl'
        file.write_text(''.join(json.dumps(row,ensure_ascii=False)+'\n' for row in rows),encoding='utf-8')
        manifest[name]={'count':len(rows),'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),
                        'languages':dict(collections.Counter(row['label']['language'] for row in rows)),
                        'operations':dict(collections.Counter(row['label']['operation'] for row in rows))}
    save(ROOT/'prompt.json',{'system':original.SYSTEM})
    save(ROOT/'dataset-manifest.json',manifest)
    save(EVIDENCE/'dataset-manifest.json',manifest)
    baseline=json.loads((PROJECT/'docs/evidence/gpu/20261008/planner-quality.json').read_text(encoding='utf-8'))
    failed=[row for row in baseline['results'] if not row['correct']]
    save(EVIDENCE/'baseline-analysis.json',{'accuracy':baseline['accuracy'],'unsafeWrites':baseline['unsafeWrites'],
          'errors':[{'input':row['input'],'expected':row['expected'],'prediction':row['prediction']} for row in failed]})
    print(json.dumps(manifest,ensure_ascii=False,indent=2))


def train(size,steps,resume=False):
    """固定データと明示したハイパーパラメーター（Hyperparameters）で比較学習します。"""
    from huggingface_hub import HfApi
    if (ROOT/'final-audit-lock.json').exists():
        raise RuntimeError('最終評価を使用済みです。同じ評価で調整を続けず、新しい評価版を用意してください。')
    gpu=module('quality_gpu_helpers','verify-gpu.py')
    gpu.EVIDENCE=EVIDENCE
    manifest=json.loads((ROOT/'dataset-manifest.json').read_text(encoding='utf-8'))
    for name,expected in manifest.items():
        assert hashlib.sha256((ROOT/f'{name}.jsonl').read_bytes()).hexdigest()==expected['sha256']
    engine=module('quality_training_engine','train-planner.py')
    model=f'Qwen/Qwen2.5-{size}B-Instruct'
    parent=Path(json.loads((ROOT/f'latest-{size}.json').read_text(encoding='utf-8'))['directory']) if resume else None
    pins_path=ROOT/'model-revisions.json'
    pins=json.loads(pins_path.read_text(encoding='utf-8')) if pins_path.exists() else {}
    revision=engine.BASE_REVISION if size=='0.5' else pins.get(size) or HfApi().model_info(model,token=False).sha
    directory=ROOT/'runs'/str(uuid.uuid4())
    directory.mkdir(parents=True)
    (directory/'dataset.jsonl').write_bytes((ROOT/'training.jsonl').read_bytes()+(ROOT/'development.jsonl').read_bytes())
    shutil.copy2(ROOT/'prompt.json',directory/'prompt.json')
    save(ROOT/f'latest-{size}.json',{'directory':str(directory),'model':model,'revision':revision})
    save(directory/'job.json',{'id':directory.name,'status':'running','pid':os.getpid(),'model':model,'revision':revision,'steps':steps,'createdAt':time.strftime('%Y-%m-%dT%H:%M:%S')})
    command=[sys.executable,str(PROJECT/'scripts/train-planner.py'),'train','--directory',str(directory),
             '--steps',str(steps),'--device','cuda','--base-model',model,'--revision',revision,
             '--learning-rate','0.0001','--lora-rank','16','--all-linear','--evaluation-batch-size','4','--allow-download']
    if parent:command.extend(['--resume-adapter',str(parent/'adapter')])
    try:
        gpu.run(f'train-{size}-refined' if parent else f'train-{size}',command,timeout=21600)
        report=json.loads((directory/'report.json').read_text(encoding='utf-8'))
        save(directory/'job.json',{'id':directory.name,'status':'succeeded' if report['passed'] else 'rejected','model':model,'revision':revision,'steps':steps,'createdAt':time.strftime('%Y-%m-%dT%H:%M:%S'),'report':report})
        shutil.copy2(directory/'report.json',EVIDENCE/f'development-{size}.json')
        print(json.dumps({key:report[key] for key in ['accuracy','unsafeWrites','passed','correct','evaluated']},ensure_ascii=False))
    except Exception:
        save(directory/'job.json',{'id':directory.name,'status':'failed','model':model,'revision':revision,'createdAt':time.strftime('%Y-%m-%dT%H:%M:%S')})
        raise


def refine_names():
    """開発評価で判明した識別子の表記だけを補習し、未使用の最終評価は変更しません。"""
    if (ROOT/'final-audit-lock.json').exists():raise RuntimeError('最終評価を使用後の補習は禁止です。')
    if (ROOT/'curriculum-v2.json').exists():raise RuntimeError('補習データを重複追加しません。')
    original=[json.loads(line) for line in (ROOT/'training.jsonl').read_text(encoding='utf-8').splitlines() if line]
    additions=[]
    for row in original:
        delegation=row['label']['delegation']
        if delegation['enabled'] and len(delegation['requested_agents'])==1:
            agent=delegation['requested_agents'][0]
            alias={'kilo':'Kilo','opencode':'OpenCode'}.get(agent)
            if alias and agent in row['input']:
                additions.append({**row,'input':row['input'].replace(agent,alias),'category':'canonical-agent-name'})
    rows=original+additions
    protected={json.loads(line)['input'] for name in ['development','final'] for line in (ROOT/f'{name}.jsonl').read_text(encoding='utf-8').splitlines() if line}
    assert len({row['input'] for row in rows})==len(rows) and not protected.intersection(row['input'] for row in rows)
    manifest=json.loads((ROOT/'dataset-manifest.json').read_text(encoding='utf-8'))
    save(EVIDENCE/'dataset-manifest-v1.json',manifest)
    file=ROOT/'training.jsonl'
    file.write_text(''.join(json.dumps(row,ensure_ascii=False)+'\n' for row in rows),encoding='utf-8')
    manifest['training'].update(count=len(rows),sha256=hashlib.sha256(file.read_bytes()).hexdigest(),
         languages=dict(collections.Counter(row['label']['language'] for row in rows)),
         operations=dict(collections.Counter(row['label']['operation'] for row in rows)))
    prompt=json.loads((ROOT/'prompt.json').read_text(encoding='utf-8'))
    prompt['system']+=' Always normalize requested_agents to lowercase identifiers (kilo, opencode), even when the user capitalizes agent names.'
    save(ROOT/'prompt.json',prompt)
    save(ROOT/'dataset-manifest.json',manifest)
    save(EVIDENCE/'dataset-manifest.json',manifest)
    save(ROOT/'curriculum-v2.json',{'added':len(additions),'reason':'開発評価の残差6件はエージェント名の大文字小文字のみ','finalUnchanged':manifest['final']['sha256']})
    shutil.copy2(EVIDENCE/'development-0.5.json',EVIDENCE/'development-0.5-before-refinement.json')
    save(EVIDENCE/'candidate-0.5-before-refinement.json',json.loads((ROOT/'latest-0.5.json').read_text(encoding='utf-8')))
    print(f'補習例{len(additions)}件を追加し、学習例は{len(rows)}件になりました。最終評価は変更していません。')


def cache_model(size):
    """比較候補の公開重みだけを先に取得します。GPUは占有せず、取得版を固定します。"""
    from huggingface_hub import HfApi,snapshot_download
    engine=module('quality_cache_engine','train-planner.py')
    model=f'Qwen/Qwen2.5-{size}B-Instruct'
    file=ROOT/'model-revisions.json'
    pins=json.loads(file.read_text(encoding='utf-8')) if file.exists() else {}
    revision=engine.BASE_REVISION if size=='0.5' else pins.get(size) or HfApi().model_info(model,token=False).sha
    pins[size]=revision
    save(file,pins)
    snapshot_download(model,revision=revision,cache_dir=ROOT/'model-cache',token=False,
                      allow_patterns=['*.json','*.safetensors','*.txt','*.model','*.tiktoken'],ignore_patterns=['onnx/*','flax/*','original/*'])
    save(EVIDENCE/f'model-{size}.json',{'repository':model,'revision':revision})
    print(f'{size}B比較モデルの取得が完了しました。')


def evaluate(size,suite):
    """開発用評価と未使用の最終評価を区別し、言語・操作別の品質も保存します。"""
    engine=module('quality_evaluation_engine','train-planner.py')
    latest=json.loads((ROOT/f'latest-{size}.json').read_text(encoding='utf-8'))
    directory=Path(latest['directory'])
    development=json.loads((directory/'report.json').read_text(encoding='utf-8'))
    if suite=='final' and not development['passed']:
        raise RuntimeError('開発用評価に合格していない候補へ最終評価を使用しません。')
    manifest=json.loads((ROOT/'dataset-manifest.json').read_text(encoding='utf-8'))
    file=ROOT/f'{suite}.jsonl'
    assert hashlib.sha256(file.read_bytes()).hexdigest()==manifest[suite]['sha256']
    digest=hashlib.sha256((directory/'adapter/adapter_model.safetensors').read_bytes()).hexdigest()
    identity={'size':size,'directory':str(directory),'adapterSha256':digest,
              'configSha256':hashlib.sha256((directory/'training-config.json').read_bytes()).hexdigest(),
              'finalDatasetSha256':manifest['final']['sha256']}
    if suite=='final':
        lock=ROOT/'final-audit-lock.json'
        if lock.exists():assert json.loads(lock.read_text(encoding='utf-8'))==identity
        else:save(lock,identity)
    rows=[json.loads(line) for line in file.read_text(encoding='utf-8').splitlines() if line]
    torch,tokenizer,model,device=engine.load_model(directory,adapter=True,device='cuda')
    model.eval()
    torch.use_deterministic_algorithms(True)
    torch.cuda.reset_peak_memory_stats()
    system=json.loads((directory/'prompt.json').read_text(encoding='utf-8'))['system']
    started=time.monotonic()
    predictions=[]
    # 最終判定は実運用と同じ1入力ずつの生成で行い、バッチ化の数値差を避けます。
    batch_size=1 if suite=='final' else 4
    for index in range(0,len(rows),batch_size):
        batch=rows[index:index+batch_size]
        predictions.extend(engine.generate_batch(torch,tokenizer,model,system,[row['input'] for row in batch]))
        print(f'{suite}評価 {min(index+batch_size,len(rows))}/{len(rows)}',flush=True)
    report=engine.score_predictions(rows,predictions)
    groups={}
    for field in ['language','operation']:
        groups[field]={}
        for value in sorted({row['label'][field] for row in rows}):
            indexes=[index for index,row in enumerate(rows) if row['label'][field]==value]
            groups[field][value]=engine.score_predictions([rows[i] for i in indexes],[predictions[i] for i in indexes])
            groups[field][value].pop('results')
    report.update(identity=identity,groups=groups,device=device,peakAllocatedBytes=torch.cuda.max_memory_allocated(),elapsedSeconds=time.monotonic()-started,
                  eligible=report['passed'] and all(value['accuracy']>=0.9 for value in groups['language'].values()))
    report_path=EVIDENCE/f'{suite}-{size}.json'
    save(report_path,report)
    # 実際のTypeScript検証器も通し、JSONが生成できただけで有効化しません。
    code="""
// 評価出力のスキーマ（Schema）だけを検証し、ツールや外部エージェントは実行しません。
import fs from 'node:fs/promises';
import {validateAgentPlan} from './src/agent-planner.ts';
const report=JSON.parse(await fs.readFile(process.argv[1],'utf8'));
const errors=[];
for(const row of report.results){try{validateAgentPlan(row.prediction,row.input);}catch(error){errors.push({input:row.input,error:String(error)});}}
console.log(JSON.stringify({valid:errors.length===0,errors}));
"""
    result=subprocess.run(['node','--import','tsx','--input-type=module','-e',code,str(report_path)],cwd=PROJECT,capture_output=True,text=True,encoding='utf-8',check=True)
    schema=json.loads(result.stdout)
    report['schemaValidation']=schema
    report['eligible']=report['eligible'] and schema['valid']
    save(report_path,report)
    if suite=='final':save(ROOT/'final-verdict.json',{'size':size,'eligible':report['eligible'],'report':str(report_path),'identity':identity})
    print(json.dumps({key:report[key] for key in ['correct','evaluated','accuracy','unsafeWrites','passed','eligible']},ensure_ascii=False))


def activate():
    """未使用評価に合格した重みだけ配備し、実推論が失敗したら以前の有効状態へ戻します。"""
    verdict=json.loads((ROOT/'final-verdict.json').read_text(encoding='utf-8'))
    if not verdict['eligible']:raise RuntimeError('最終品質基準に未達のモデルは有効化しません。')
    identity=verdict['identity']
    source=Path(identity['directory'])
    assert hashlib.sha256((source/'adapter/adapter_model.safetensors').read_bytes()).hexdigest()==identity['adapterSha256']
    assert hashlib.sha256((source/'training-config.json').read_bytes()).hexdigest()==identity['configSha256']
    production=PROJECT/'.wentian/planner-training'
    active=production/'active.json'
    previous=active.read_bytes() if active.exists() else None
    save(ROOT/'previous-active.json',json.loads(previous) if previous else None)
    target=production/'runs'/source.name
    shutil.copytree(source,target)
    # 不変の取得済み重みだけを共有し、運用キャッシュの既存ファイルを置き換えません。
    def link_cached(source_file,target_file):
        if not Path(target_file).exists():os.link(source_file,target_file)
        return target_file
    shutil.copytree(ROOT/'model-cache',production/'model-cache',dirs_exist_ok=True,copy_function=link_cached)
    report=json.loads(Path(verdict['report']).read_text(encoding='utf-8'))
    config=json.loads((source/'training-config.json').read_text(encoding='utf-8'))
    shutil.copy2(target/'report.json',target/'development-report.json')
    source_report=json.loads((source/'report.json').read_text(encoding='utf-8'))
    report.update(baseModel=config['baseModel'],revision=config['revision'],steps=config['steps'],trainingExamples=source_report['trainingExamples'])
    save(target/'report.json',report)
    save(target/'job.json',{'id':source.name,'status':'succeeded','model':config['baseModel'],'revision':config['revision'],
                          'steps':config['steps'],'createdAt':time.strftime('%Y-%m-%dT%H:%M:%S'),'report':report})
    # 開発用45件と最終120件を別名で保存します。再学習の既定評価は前者です。
    shutil.copy2(ROOT/'final.jsonl',target/'final-evaluation.jsonl')
    shutil.copy2(ROOT/'dataset-manifest.json',target/'quality-dataset-manifest.json')
    save(target/'evaluation-provenance.json',{'development':'evaluation.jsonl','final':'final-evaluation.jsonl',
         'reportedSuite':'final','retrainingDefaultSuite':'development','identity':identity})
    renderer=module('quality_report_renderer','render-planner-training-report.py')
    renderer.render(target)
    code="""
// 通常の有効化条件と実際の分類入口で検収します。回答生成・ツール実行は行いません。
import fs from 'node:fs/promises';
import {PlannerTrainingService} from './src/planner-training.ts';
import {createAgentPlan} from './src/agent-planner.ts';
const service=new PlannerTrainingService();
await service.activate(process.argv[1]);
const checks=[];
for(const [input,language] of [['こんにちは','ja'],['你好！','zh'],['Hello!','en']]){
 const started=Date.now();
 const plan=await createAgentPlan(input,'http://127.0.0.1:9');
 if(plan.classification?.source!=='trained'||plan.operation!=='answer'||plan.intent!=='chat'||plan.language!==language)throw new Error('有効モデルの実分類が不正です。');
 checks.push({input,language,classification:plan.classification,operation:plan.operation,elapsedMs:Date.now()-started});
}
await fs.writeFile(process.argv[2],JSON.stringify({activated:true,id:process.argv[1],checks},null,2));
console.log('最終評価に合格したモデルの有効化と日中英の実分類検収が成功しました。');
"""
    environment=dict(os.environ,PYTHONUTF8='1',PYTHONIOENCODING='utf-8',WENTIAN_TRAINING_PYTHON=sys.executable,
                     WENTIAN_PLANNER_TRAINING_ROOT=str(production),WENTIAN_PLANNER_EXTERNAL_FALLBACK='false')
    try:
        result=subprocess.run(['node','--import','tsx','--input-type=module','-e',code,source.name,str(EVIDENCE/'activation.json')],cwd=PROJECT,
                              env=environment,capture_output=True,text=True,encoding='utf-8',timeout=240)
        (EVIDENCE/'activation.log').write_text(result.stdout+'\n'+result.stderr,encoding='utf-8')
        if result.returncode:raise RuntimeError('実分類の検収に失敗しました。以前の有効状態へ戻します。')
    except Exception:
        if previous is None:active.unlink(missing_ok=True)
        else:active.write_bytes(previous)
        save(EVIDENCE/'activation.json',{'activated':False,'rolledBack':True})
        raise
    print('合格モデルを有効化し、実分類を確認しました。')


def main():
    """段階を明示して実行します。最終評価を学習データへ移す操作は用意しません。"""
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode',choices=['prepare','train','evaluate','activate','cache','refine-names'])
    parser.add_argument('--size',choices=['0.5','1.5','3'],default='0.5')
    parser.add_argument('--steps',type=int,default=2000)
    parser.add_argument('--suite',choices=['development','final'],default='development')
    parser.add_argument('--resume',action='store_true')
    args=parser.parse_args()
    if not 1<=args.steps<=2000:parser.error('学習ステップは1～2000で指定してください。')
    if args.mode=='prepare':prepare()
    elif args.mode=='train':train(args.size,args.steps,args.resume)
    elif args.mode=='evaluate':evaluate(args.size,args.suite)
    elif args.mode=='cache':cache_model(args.size)
    elif args.mode=='refine-names':refine_names()
    else:activate()


if __name__=='__main__':
    main()
