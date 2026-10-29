"""日中英の確認済み分類例を作成する。

入力文と正解の対応はこのファイル内で明示する。実行時のキーワード分類器ではない。
利用者の会話・ファイル・秘密情報を読み込まず、評価例は別の文として固定する。
出力はローカル学習領域へ保存し、元データと分離条件は追跡可能にする。
"""
import argparse
import hashlib
import json
from pathlib import Path


SYSTEM = """Classify the user's request. Do NOT answer or execute it. Return only one JSON object.
Fields: intent (chat,local_tool,web_research,analyze_image,delegate_external), operation (answer,read,write), language (ja,zh,en), evidence_source (none,workspace,web,runtime), required_capabilities (text,vision,web,file_read,file_write,terminal,review), tools (read_file,list_files,write_file,run_command,web_research,read_image,inspect_kubernetes), delegation:{enabled:boolean,parallel:boolean,requested_agents:string[]}.
Use answer for explanations and quoted requests; read for inspections; write ONLY for actual creation/modification. Never infer write permission from a quoted past request or from progress/status questions. For actual write include file_write and write_file. For web include research:{kind:search,query:string}, weather:{kind:weather,location:string}, exchange:{kind:exchange,currencies:[ISO,ISO]}. For runtime include runtime_requirements:[{tool:string,operation?:string,resource?:string}]. Images need vision/read_image. Delegate ONLY when explicitly requested. Honor execution_mode direct/propose if explicit. Never choose a model/provider. Preserve names and parameters. Classify intent from meaning, not keywords."""


def build_rows():
    """各カテゴリーの意味を確認して割り当てた正解を返す。評価文は学習へ混ぜない。"""
    rows = []

    def add(texts, label, split="train"):
        # 日本語・中国語・英語は内容確認済みのグループとして明示し、文字種で推測しない。
        for language, sentences in texts.items():
            for sentence in sentences:
                value = {"intent": "chat", "operation": "answer", "language": language, "evidence_source": "none", "required_capabilities": ["text"], "tools": [], "delegation": {"enabled": False, "parallel": False, "requested_agents": []}, **label}
                rows.append({"input": sentence, "label": value, "reviewed": True, "split": split})

    add({"ja": ["こんにちは", "おはようございます", "こんばんは！", "ありがとう", "よろしくお願いします", "Pythonとは何ですか", "再帰関数の考え方を説明して", "CPUとGPUの違いを教えて", "データベースの正規化を説明して", "Dockerとは何か教えて", "この文章を英語に訳して：今日は晴れです", "SQLのJOINを例で説明して", "プログラミングの学び方を相談したい", "次に何をするべきか一緒に考えて", "学習と推論の違いは何ですか", "さようなら"],
         "zh": ["你好！", "早上好", "晚上好", "谢谢你", "请多指教", "什么是Python", "解释一下递归函数", "CPU和GPU有什么区别", "数据库规范化是什么意思", "Docker是什么", "把这句话翻译成日语：今天天气好", "举例解释SQL的JOIN", "我想学习编程，怎么开始", "帮我想想下一步应该做什么", "训练和推理有什么区别", "再见"],
         "en": ["Hello!", "Good morning", "Good evening", "Thank you", "Nice to meet you", "What is Python?", "Explain recursive functions", "What is the difference between CPU and GPU?", "Explain database normalization", "What is Docker?", "Translate this into Japanese: Have a nice day", "Explain SQL joins with an example", "How should I start learning programming?", "Help me think about the next step", "What is the difference between training and inference?", "Goodbye"]}, {})
    add({"ja": ["README.mdを読んで概要を教えて", "package.jsonの依存関係を確認して", "srcフォルダーのファイルを一覧にして", "設定ファイルがどこにあるか調べて", "docsの仕様書を探して", "ソースコードの構成を調べて", "実装を変更せずコードをレビューして", "ログファイルを読んで失敗原因を教えて", "このリポジトリにテストがあるか確認して", "requirements.txtの内容を確認して"],
         "zh": ["读取README.md并总结", "检查package.json里的依赖", "列出src目录里的文件", "查找配置文件在哪里", "寻找docs里的设计说明", "看看源代码的结构", "只审查代码，不要修改", "读取日志分析失败原因", "确认这个仓库是否包含测试", "查看requirements.txt的内容"],
         "en": ["Read README.md and summarize it", "Inspect dependencies in package.json", "List files in the src directory", "Find the configuration files", "Locate the specifications in docs", "Inspect the source code structure", "Review the code without changing it", "Read the log file and explain the failure", "Check whether this repository contains tests", "Inspect requirements.txt"]},
        {"intent": "local_tool", "operation": "read", "evidence_source": "workspace", "required_capabilities": ["file_read"], "tools": ["list_files", "read_file"]})
    add({"ja": ["README.mdを更新して", "ログイン画面を作成して", "このバグを修正して", "Pythonスクリプトをファイルとして作って", "テストコードを追加して", "設定ファイルを書き換えて", "この機能を実装して", "仕様書をMarkdownファイルに保存して", "CSVを読み込むプログラムを作って", "既存コードをリファクタリングして", "サイトのメニュー項目を追加して", "エラー処理を改善して"],
         "zh": ["更新README.md", "创建登录页面", "修复这个bug", "把Python脚本写入文件", "添加测试代码", "修改配置文件", "实现这个功能", "把设计说明保存为Markdown文件", "写一个读取CSV的程序", "重构现有代码", "给网站增加一个菜单项", "改进错误处理"],
         "en": ["Update README.md", "Create a login page", "Fix this bug", "Write the Python script to a file", "Add test code", "Modify the configuration file", "Implement this feature", "Save the specification as a Markdown file", "Create a program that reads CSV files", "Refactor the existing code", "Add a menu item to the website", "Improve error handling"]},
        {"intent": "local_tool", "operation": "write", "evidence_source": "workspace", "required_capabilities": ["file_read", "file_write"], "tools": ["read_file", "write_file"]})
    add({"ja": ["以前依頼した実装は完了しましたか", "昨日の修正の進捗を説明して", "『ファイルを作って』という表現の意味を教えて", "コードは書かず設計方針を説明して", "修正方法の例を文章で教えて", "『実装して』は英語で何と言いますか", "サイトを作る手順だけ説明して", "実装前に利点と欠点を相談したい", "引用文『設定を書き換えて』を要約して", "変更済みだという説明はどういう意味ですか"],
         "zh": ["之前委托的实现完成了吗", "解释昨天修复工作的进展", "解释一下“创建文件”这句话的意思", "不要写代码，只解释设计思路", "用文字描述修复方法", "“实现功能”用英语怎么说", "只讲一下创建网站的步骤", "实现之前我想讨论优缺点", "总结引用文字“修改配置文件”", "你说已经修改是什么意思"],
         "en": ["Has the implementation I requested earlier been completed?", "Explain the progress of yesterday's fix", "Explain the phrase 'create a file'", "Do not write code; explain the design", "Describe the fix in words only", "Translate the words 'implement the feature' into Japanese", "Only explain the steps for building a website", "Discuss pros and cons before implementation", "Summarize the quoted text 'modify the configuration file'", "What do you mean when you say it was changed?"]}, {})
    # 変数を含むWeb検索は、問い合わせ全文を検索クエリーとして明示する。
    searches = {"ja": ["Pythonの最新情報をウェブで調べて", "LoRAの公式資料を検索して", "今週のAIニュースを調べて", "Dockerの公式インストール手順を探して", "東京の観光情報を検索して", "Kubernetesの新機能をウェブで確認して"],
                "zh": ["上网查一下Python的最新信息", "搜索LoRA的官方文档", "查一下本周的AI新闻", "查找Docker的官方安装说明", "搜索东京的旅游信息", "上网确认Kubernetes的新功能"],
                "en": ["Search the web for the latest Python information", "Find the official LoRA documentation", "Look up this week's AI news", "Find Docker's official installation instructions", "Search for tourist information about Tokyo", "Look up the new features of Kubernetes online"]}
    for language, sentences in searches.items():
        for sentence in sentences:
            add({language: [sentence]}, {"intent": "web_research", "operation": "read", "evidence_source": "web", "required_capabilities": ["web"], "tools": ["web_research"], "research": {"kind": "search", "query": sentence}})
    for location, ja, zh, en in [("Tokyo", "東京", "东京", "Tokyo"), ("Osaka", "大阪", "大阪", "Osaka"), ("Beijing", "北京", "北京", "Beijing"), ("Shanghai", "上海", "上海", "Shanghai"), ("London", "ロンドン", "伦敦", "London"), ("New York", "ニューヨーク", "纽约", "New York")]:
        add({"ja": [f"今日の{ja}の天気を調べて", f"明日の{ja}の天気予報を確認して"], "zh": [f"查一下今天{zh}的天气", f"明天{zh}的天气怎么样"], "en": [f"Check the weather in {en} today", f"What is the weather forecast for {en} tomorrow?"]},
            {"intent": "web_research", "operation": "read", "evidence_source": "web", "required_capabilities": ["web"], "tools": ["web_research"], "research": {"kind": "weather", "location": location}})
    for currencies in [("USD", "JPY"), ("EUR", "USD"), ("CNY", "JPY"), ("GBP", "JPY")]:
        pair = "/".join(currencies)
        add({"ja": [f"現在の{pair}為替レートを確認して", f"今日の{pair}相場を調べて"], "zh": [f"查一下当前{pair}的汇率", f"今天{pair}汇率是多少"], "en": [f"Check the current {pair} exchange rate", f"What is today's {pair} exchange rate?"]},
            {"intent": "web_research", "operation": "read", "evidence_source": "web", "required_capabilities": ["web"], "tools": ["web_research"], "research": {"kind": "exchange", "currencies": list(currencies)}})
    add({"ja": ["KubernetesのPod使用量を確認して", "現在のPodのCPUとメモリ使用量を調べて", "クラスターのPodリソース利用率を教えて", "稼働中Podのrequestsとlimitsを確認して", "Kubernetesの実際のPod負荷を調査して", "開発クラスターのPod使用率を実測して"],
         "zh": ["检查Kubernetes的Pod资源使用量", "查一下当前Pod的CPU和内存使用量", "告诉我集群Pod的资源利用率", "确认运行中Pod的requests和limits", "调查Kubernetes实际的Pod负载", "实测开发集群的Pod资源使用率"],
         "en": ["Check Kubernetes pod resource usage", "Inspect current pod CPU and memory consumption", "Show resource utilization of cluster pods", "Check requests and limits of running pods", "Measure the actual Kubernetes pod load", "Measure pod utilization in the development cluster"]},
        {"intent": "local_tool", "operation": "read", "evidence_source": "runtime", "required_capabilities": ["terminal"], "tools": ["inspect_kubernetes"], "runtime_requirements": [{"tool": "inspect_kubernetes", "operation": "top", "resource": "pods"}, {"tool": "inspect_kubernetes", "operation": "get", "resource": "pods"}]})
    add({"ja": ["このPCの現在のCPU使用率を測って", "実際の空きディスク容量を確認して", "稼働中のプロセス一覧を取得して", "現在のメモリ使用量を調べて", "8787番ポートが待ち受けているか確認して", "今動いているDockerコンテナを確認して"],
         "zh": ["测一下这台电脑当前CPU使用率", "检查实际的磁盘剩余空间", "获取正在运行的进程列表", "检查当前内存使用量", "确认8787端口是否监听", "查看现在运行中的Docker容器"],
         "en": ["Measure this computer's current CPU usage", "Check actual free disk space", "Get the list of running processes", "Inspect current memory usage", "Check whether port 8787 is listening", "Inspect currently running Docker containers"]},
        {"intent": "local_tool", "operation": "read", "evidence_source": "runtime", "required_capabilities": ["terminal"], "tools": ["run_command"], "runtime_requirements": [{"tool": "run_command"}]})
    add({"ja": ["この画像を説明して", "添付画像に何が写っていますか", "スクリーンショットのエラーを読んで", "この図の内容を分析して", "添付写真の内容を教えて", "画像から文字を読み取って"],
         "zh": ["描述这张图片", "附件图片里面有什么", "读取截图中的错误信息", "分析这张图的内容", "告诉我附件照片的内容", "识别图片中的文字"],
         "en": ["Describe this image", "What is shown in the attached picture?", "Read the error in this screenshot", "Analyze this diagram", "Explain the contents of the attached photo", "Read the text in the image"]},
        {"intent": "analyze_image", "operation": "read", "required_capabilities": ["vision"], "tools": ["read_image"]})
    for agent in ["kilo", "opencode"]:
        add({"ja": [f"{agent}にコードのレビューを依頼して", f"{agent}にこの設計を評価してもらって", f"{agent}へ読み取り専用の調査を任せて"],
             "zh": [f"让{agent}审查代码", f"请{agent}评估这个设计", f"把只读调查交给{agent}"],
             "en": [f"Ask {agent} to review the code", f"Have {agent} evaluate this design", f"Delegate the read-only investigation to {agent}"]},
            {"intent": "delegate_external", "operation": "read", "required_capabilities": ["review"], "tools": [], "delegation": {"enabled": True, "parallel": False, "requested_agents": [agent]}})
        add({"ja": [f"{agent}にこの不具合を修正させて", f"{agent}へログイン機能の実装を依頼して", f"{agent}にREADME.mdを更新させて"],
             "zh": [f"让{agent}修复这个问题", f"把登录功能的实现交给{agent}", f"让{agent}更新README.md"],
             "en": [f"Have {agent} fix this issue", f"Delegate implementation of login to {agent}", f"Ask {agent} to update README.md"]},
            {"intent": "delegate_external", "operation": "write", "evidence_source": "workspace", "required_capabilities": ["file_read", "file_write"], "tools": ["read_file", "write_file"], "delegation": {"enabled": True, "parallel": False, "requested_agents": [agent]}})

    # 以下は言い換えテンプレートから生成せず、実用場面を想定して別途書いた固定評価例。
    add({"ja": ["お疲れさまです。相談してもいいですか", "モデルを取得するとはどういう意味ですか", "先ほどの『修正して』という依頼の状況を説明して"], "zh": ["嗨，能帮我解答一个问题吗", "下载模型到底是什么意思", "我之前说修复bug，你能解释当时的处理过程吗"], "en": ["Hi there, can I ask a question?", "Could you clarify what downloading model weights means?", "I previously asked for a fix; explain what happened then"]}, {}, "evaluation")
    add({"ja": ["READMEの記述を調査して、変更せず報告してください", "src内に認証を扱うコードがあるか探してください"], "zh": ["请看看README写了什么，保持文件原样", "在src里找出认证相关的源文件"], "en": ["Investigate the README contents and report without edits", "Locate the authentication source files under src"]},
        {"intent": "local_tool", "operation": "read", "evidence_source": "workspace", "required_capabilities": ["file_read"], "tools": ["list_files", "read_file"]}, "evaluation")
    add({"ja": ["READMEに新しい起動手順を追記してください", "画面の入力不具合を直し、修正版を保存してください"], "zh": ["把新的启动步骤补充到README中", "修好页面的输入问题并保存修改"], "en": ["Append the new startup instructions to README", "Repair the page input bug and save the corrected code"]},
        {"intent": "local_tool", "operation": "write", "evidence_source": "workspace", "required_capabilities": ["file_read", "file_write"], "tools": ["read_file", "write_file"]}, "evaluation")
    add({"ja": ["稼働中のPodが今どれだけメモリを使っているか測定して"], "zh": ["实测正在运行的Pod现在占用多少内存"], "en": ["Measure how much memory the running pods are using right now"]},
        {"intent": "local_tool", "operation": "read", "evidence_source": "runtime", "required_capabilities": ["terminal"], "tools": ["inspect_kubernetes"], "runtime_requirements": [{"tool": "inspect_kubernetes", "operation": "top", "resource": "pods"}, {"tool": "inspect_kubernetes", "operation": "get", "resource": "pods"}]}, "evaluation")
    add({"ja": ["このマシンのストレージ残量を今確認して"], "zh": ["现在检查一下这台机器还剩多少磁盘空间"], "en": ["Check how much storage is available on this machine now"]},
        {"intent": "local_tool", "operation": "read", "evidence_source": "runtime", "required_capabilities": ["terminal"], "tools": ["run_command"], "runtime_requirements": [{"tool": "run_command"}]}, "evaluation")
    add({"ja": ["送ったスクリーンショットに表示された文字を解説して"], "zh": ["说明一下我发的截图中显示的文字"], "en": ["Explain the text visible in the screenshot I sent"]}, {"intent": "analyze_image", "operation": "read", "required_capabilities": ["vision"], "tools": ["read_image"]}, "evaluation")
    add({"ja": ["Kiloに修正せずソースの問題点を指摘してもらって"], "zh": ["让Kilo指出源码中的问题，不要修改"], "en": ["Have Kilo identify source code problems without making changes"]},
        {"intent": "delegate_external", "operation": "read", "required_capabilities": ["review"], "tools": [], "delegation": {"enabled": True, "parallel": False, "requested_agents": ["kilo"]}}, "evaluation")
    add({"ja": ["OpenCodeに入力欄の不具合修正を担当させて"], "zh": ["把输入框的bug修复任务交给OpenCode"], "en": ["Assign the input field bug fix to OpenCode"]},
        {"intent": "delegate_external", "operation": "write", "evidence_source": "workspace", "required_capabilities": ["file_read", "file_write"], "tools": ["read_file", "write_file"], "delegation": {"enabled": True, "parallel": False, "requested_agents": ["opencode"]}}, "evaluation")
    for lang, sentence in [("ja", "今日の東京の空模様を確認できますか"), ("zh", "能查一下今天东京的天气情况吗"), ("en", "Could you check today's weather conditions in Tokyo?")]:
        add({lang: [sentence]}, {"intent": "web_research", "operation": "read", "evidence_source": "web", "required_capabilities": ["web"], "tools": ["web_research"], "research": {"kind": "weather", "location": "Tokyo"}}, "evaluation")
    for lang, sentence in [("ja", "最新のUSD/JPYの交換比率を調べて"), ("zh", "请查当前USD/JPY兑换比率"), ("en", "Look up the latest conversion rate for USD/JPY")]:
        add({lang: [sentence]}, {"intent": "web_research", "operation": "read", "evidence_source": "web", "required_capabilities": ["web"], "tools": ["web_research"], "research": {"kind": "exchange", "currencies": ["USD", "JPY"]}}, "evaluation")
    for lang, sentence in [("ja", "ウェブでPEFTの使い方を調べて"), ("zh", "上网查找PEFT的使用方法"), ("en", "Search online for instructions on using PEFT")]:
        add({lang: [sentence]}, {"intent": "web_research", "operation": "read", "evidence_source": "web", "required_capabilities": ["web"], "tools": ["web_research"], "research": {"kind": "search", "query": sentence}}, "evaluation")
    return rows


def main():
    """指定した保存先へデータと短い学習専用プロンプトを出力する。既存ジョブは変更しない。"""
    parser = argparse.ArgumentParser(description="分類用の確認済みデータセットを準備します。")
    parser.add_argument("--directory", type=Path, required=True)
    args = parser.parse_args()
    rows = build_rows()
    if len({row["input"] for row in rows}) != len(rows):
        raise ValueError("入力文が重複しています。")
    args.directory.mkdir(parents=True, exist_ok=True)
    content = json.dumps(rows, ensure_ascii=False, indent=2)
    (args.directory / "dataset.json").write_text(content, encoding="utf-8")
    (args.directory / "training-prompt.json").write_text(json.dumps({"system": SYSTEM}, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"examples": len(rows), "training": sum(row["split"] == "train" for row in rows), "evaluation": sum(row["split"] == "evaluation" for row in rows), "sha256": hashlib.sha256(content.encode()).hexdigest()}, ensure_ascii=False))


if __name__ == "__main__":
    main()
