"""調査済みのメールサーバーとBusinessRecordsを接続します。

秘密値はWindowsの暗号化保管から読み、初期BusinessRecordsアカウントも画面へ表示しません。
初期取り込みは直近5UIDに限定し、メールサーバー上の既読状態や本文は変更しません。
BusinessRecordsへの業務登録は行わず、画面での人手確認と送信操作に委ねます。
"""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--serve-ses", action="store_true")
    arguments = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    ses_path = Path(required_setting("WENTIAN_BUSINESS_RECORDS_SCRIPT"))
    if arguments.serve_ses:
        # アプリ本来の保存先と初期化処理を使います。ブラウザーは開きません。
        import importlib.util
        spec = importlib.util.spec_from_file_location("wentian_ses_runtime", ses_path)
        ses = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(ses)
        ses.initialize_database()
        ses.ThreadingServer(("127.0.0.1", 8765), ses.Handler).serve_forever()
        return


def required_setting(name):
    """接続先や認証は利用者が指定し、個人・組織の既定値を持ちません。"""
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(name + " を環境変数へ設定してください。")
    return value


def connect():
    import importlib.util
    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location("mail_connection_verify", root / "scripts/verify-mail-operations.py")
    verification = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verification)
    # 外部アプリの初期アカウントを探さず、利用者が選んだ認証を使用します。
    username = required_setting("WENTIAN_MAIL_SES_USERNAME")
    password = required_setting("WENTIAN_MAIL_SES_PASSWORD")
    host = required_setting("WENTIAN_MAIL_IMAP_HOST")
    user = required_setting("WENTIAN_MAIL_IMAP_USER")
    # 値を引数へ入れず、子プロセスの標準入力へ渡して暗号化保管します。
    vault_file = root / ".wentian/mail-secrets.json"
    vault = json.loads(vault_file.read_text(encoding="utf-8")) if vault_file.exists() else {}
    if "WENTIAN_MAIL_SES_PASSWORD" not in vault:
        subprocess.run([sys.executable, str(root / "scripts/mail-secrets.py"), "set", "--name", "WENTIAN_MAIL_SES_PASSWORD", "--stdin"], input=password, text=True, check=True, capture_output=True)
    runtime = root / ".wentian/mail-operations"
    runtime.mkdir(parents=True, exist_ok=True)
    with socket.socket() as probe:
        available = probe.connect_ex(("127.0.0.1", 8765)) == 0
    if not available:
        with (runtime / "ses-server.log").open("ab") as log:
            process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--serve-ses"], cwd=root, stdout=log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
        (runtime / "ses-runtime.json").write_text(json.dumps({"pid": process.pid, "url": "http://127.0.0.1:8765/"}), encoding="utf-8")
        for _ in range(100):
            with socket.socket() as probe:
                if probe.connect_ex(("127.0.0.1", 8765)) == 0:
                    break
            if process.poll() is not None:
                raise RuntimeError("BusinessRecordsの起動に失敗しました。専用ログを確認してください。")
            time.sleep(0.1)
        else:
            raise RuntimeError("BusinessRecordsの起動待ちが終了しました。")
    # アプリの公開サービス経由で設定します。SQLiteを直接書き換えません。
    code = """
    import {MailOperationsService} from './src/mail-operations.ts';
    import {imapClient} from './src/mail-connectors.ts';
    const service=new MailOperationsService();
    try {
      const host=process.env.WENTIAN_MAIL_IMAP_HOST,user=process.env.WENTIAN_MAIL_IMAP_USER;
      let source=service.sources().find(item=>item.host===host&&item.user===user);
      if(!source)source=service.saveSource({name:'受信メール',type:'imap',host,port:993,user,tls:'implicit',auth:'password',secretEnv:'WENTIAN_MAIL_IMAP_PASSWORD',folders:['INBOX'],enabled:false,intervalSeconds:300,batchSize:50},'接続準備');
      const config=service.settings();config.ses={...config.ses,enabled:true,mode:'business-records',baseUrl:'http://127.0.0.1:8765/',username:config.ses.username||process.env.MAIL_SES_USERNAME,passwordEnv:'WENTIAN_MAIL_SES_PASSWORD'};
      service.saveSettings(config,'接続準備');
      await service.connectionTest('ses','接続準備');
      const client=imapClient(source);client.on('error',()=>{});let imported=0;
      try{await client.connect();const lock=await client.getMailboxLock('INBOX',{readOnly:true});try{
        if(!client.mailbox)throw new Error('受信トレイを開けません。');
        const validity=String(client.mailbox.uidValidity),max=Number(client.mailbox.uidNext)-1;
        if(max>0){const items=await client.fetchAll(Math.max(1,max-4)+':'+max,{uid:true,size:true},{uid:true});for(const item of items){if(item.size>20*1024*1024)continue;const fetched=await client.fetchOne(item.uid,{uid:true,source:true},{uid:true});if(!fetched||!fetched.source)throw new Error('原文を取得できません。');const result=await service.ingest(source.id,fetched.source,source.id+':INBOX:'+validity+':'+item.uid,{folder:'INBOX',uid:item.uid,uidValidity:validity},'初期取り込み');if(!result.duplicate)imported++;}}
        // 初期取得時点を新着同期の起点として記録し、その後に届くメールを取りこぼしません。
        const current=service.repository.require('source',source.id);
        if(current.checkpoints.INBOX?.validity!==validity)service.repository.transaction(()=>service.repository.put('source',{...current,checkpoints:{...current.checkpoints,INBOX:{validity,backfill:0,target:max,incremental:max}},lastSync:new Date().toISOString()}));
      }finally{lock.release();}}finally{await client.logout().catch(()=>client.close());}
      console.log(JSON.stringify({imapConnected:true,imported,sesConnected:true,automaticSync:false}));
    }finally{await service.close();}
    """
    environment = {**os.environ, "WENTIAN_INSTALL_ROOT": str(root), "MAIL_SES_USERNAME": username, "WENTIAN_MAIL_IMAP_HOST": host, "WENTIAN_MAIL_IMAP_USER": user}
    subprocess.run(["node", "--import", "tsx", "--input-type=module", "-e", code], cwd=root, env=environment, check=True)


if __name__ == "__main__":
    # サーバー起動と接続準備を分け、子プロセスが接続準備を再実行しないようにします。
    if "--serve-ses" in sys.argv:
        main()
    else:
        connect()
