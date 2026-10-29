"""PythonのPlaywrightでローカル管理サイトを検証し、画面と結果を保存します。

既存Edgeをヘッドレス（Headless）で使い、管理設定・モデルのロード・評価実行は変更しません。
認証値は環境変数またはローカル.envから取得し、ログ・証拠ファイルには保存しません。
"""
import argparse
import base64
import struct
import zlib
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect


def main():
    # 日本語の実行結果をWindowsでもUTF-8で扱います。
    sys.stdout.reconfigure(encoding="utf-8")
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url",default="http://127.0.0.1:8787")
    parser.add_argument("--attachments",action="store_true",help="添付の読取りとモデルへの実送信を検証する")
    args=parser.parse_args()
    parsed=urlsplit(args.base_url)
    # ローカル認証値を外部サイトへ転送しないため、ループバック以外は拒否します。
    if parsed.hostname not in ("127.0.0.1","localhost","::1") or parsed.scheme!="http" or parsed.username or parsed.password:
        parser.error("認証検証はHTTPのローカル管理サイトだけに許可します。")
    root=Path(__file__).resolve().parent.parent
    values=dict(os.environ)
    env_file=Path(values.get("WENTIAN_ENV_FILE",root/".env"))
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8-sig").splitlines():
            if "=" not in line or line.lstrip().startswith("#"): continue
            key,value=line.split("=",1)
            values.setdefault(key.strip().removeprefix("export "),value.strip().strip("\"'"))
    username=values.get("WENTIAN_ADMIN_USERNAME","admin")
    password=values.get("WENTIAN_ADMIN_PASSWORD") or values.get("WENTIAN_API_KEY")
    if not password:
        print("既存の管理者認証値がないため、ログイン検証を停止しました。")
        return 1
    folder=root/"docs/evidence/20261006_control_plane/browser"
    folder.mkdir(parents=True,exist_ok=True)
    result={"baseUrl":args.base_url,"browser":"既存Edge / Playwright","checks":[],"success":False}
    errors=[]
    step="起動"
    try:
        with sync_playwright() as pw:
            # 新しい独立プロファイルを使い、利用者の既存タブ・保存認証・拡張へ影響させません。
            browser=pw.chromium.launch(channel="msedge",headless=True)
            context=browser.new_context(viewport={"width":1440,"height":1000},locale="ja-JP")
            page=context.new_page()
            page.on("pageerror",lambda error:errors.append(type(error).__name__))
            page.goto(args.base_url+"/#improvements",wait_until="domcontentloaded")
            step="既存管理者ログイン"
            page.locator("#loginUser").fill(username)
            page.locator("#loginPassword").fill(password)
            page.locator("#loginForm button").click()
            expect(page.locator("#controlStatus")).to_contain_text("GPU実機検証",timeout=30000)
            # 画面ごとに確認してから撮影し、取得失敗・未反映を成功扱いにしません。
            for view,identifier,text in [
                ("improvements","controlStatus","責務分離"),
                ("lifecycle","residencyStatus","管理所有"),
                ("evaluation","evaluationStatus","受入結果"),
                ("verification","verificationStatus","最終検証"),
                ("evidence","controlEvidence","CPU動作"),
                ("chat","chatLog",""),
                ("routes","routes",""),
            ]:
                step="画面確認: "+view
                page.locator('nav button[data-view="'+view+'"]').click()
                expect(page.locator("#"+identifier)).to_be_visible()
                if text:expect(page.locator("#"+identifier)).to_contain_text(text)
                if view=="evidence":
                    expect(page.locator('a[href="/v1/manager/control-plane/screens/improvements"]')).to_be_visible()
                    image=context.request.get(args.base_url+"/v1/manager/control-plane/screens/improvements")
                    assert image.ok and image.headers.get("content-type","").startswith("image/png")
                if view=="chat":
                    page.get_by_text("難度・実行予算を設定",exact=True).click()
                    expect(page.locator("#chatTokens")).to_be_visible()
                if view=="chat" and args.attachments:
                    # 32x32の赤いPNGとテキストを、その場で生成してファイル選択UIから添付します。
                    def chunk(kind,data):
                        return struct.pack(">I",len(data))+kind+data+struct.pack(">I",zlib.crc32(kind+data)&0xffffffff)
                    png=b"\x89PNG\r\n\x1a\n"+chunk(b"IHDR",struct.pack(">IIBBBBB",32,32,8,2,0,0,0))+chunk(b"IDAT",zlib.compress((b"\0"+b"\xff\0\0"*32)*32))+chunk(b"IEND",b"")
                    page.locator("#chatFiles").set_input_files([
                        {"name":"確認.txt","mimeType":"text/plain","buffer":"添付確認の合言葉は WENTIAN_ATTACHMENT_OK です。".encode()},
                        {"name":"赤い画像.png","mimeType":"image/png","buffer":png},
                    ])
                    expect(page.locator("#chatAttachments")).to_contain_text("送信準備完了",timeout=30000)
                    expect(page.locator("#chatAttachments article")).to_have_count(2)
                    expect(page.locator("#chatAttachments img")).to_be_visible()
                    page.screenshot(path=str(folder/"attachments.png"),full_page=True)
                    result["checks"].append({"view":"attachments","visible":True})
                    # 貼り付けとドロップもブラウザーの実イベントとして入力し、確認後に削除します。
                    page.evaluate("""encoded=>{const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));const data=new DataTransfer();data.items.add(new File([bytes],'貼付画像.png',{type:'image/png'}));document.getElementById('chatInput').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));}""",base64.b64encode(png).decode())
                    expect(page.locator("#chatAttachments article")).to_have_count(3)
                    expect(page.locator("#chatAttachments")).not_to_contain_text("読取り中",timeout=30000)
                    page.get_by_role("button",name="貼付画像.pngを添付から削除").click()
                    page.evaluate("""()=>{const data=new DataTransfer();data.items.add(new File(['DROP_ATTACHMENT_OK'],'ドロップ.txt',{type:'text/plain'}));document.getElementById('chatForm').dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));}""")
                    expect(page.locator("#chatAttachments article")).to_have_count(3)
                    expect(page.locator("#chatAttachments")).not_to_contain_text("読取り中",timeout=30000)
                    page.get_by_role("button",name="ドロップ.txtを添付から削除").click()
                    # 削除後のファイルが送信されないことも、実際の削除ボタンで確認します。
                    page.get_by_role("button",name="確認.txtを添付から削除").click()
                    expect(page.locator("#chatAttachments article")).to_have_count(1)
                    page.locator("#chatFiles").set_input_files({"name":"確認.txt","mimeType":"text/plain","buffer":"合言葉は WENTIAN_ATTACHMENT_OK。".encode()})
                    expect(page.locator("#chatAttachments article")).to_have_count(2)
                    expect(page.locator("#chatAttachments")).not_to_contain_text("読取り中",timeout=30000)
                    sent=[]
                    def capture(request):
                        if request.url.endswith("/v1/chat/completions"):
                            body=request.post_data_json
                            content=[part for message in body["messages"] if isinstance(message["content"],list) for part in message["content"]]
                            sent.append({"visionRequired":body.get("wentian_requires_vision"),"imageParts":sum(p.get("type")=="image_url" for p in content),"documentIncluded":any("WENTIAN_ATTACHMENT_OK" in p.get("text","") for p in content),"messageCount":len(body["messages"])})
                    page.on("request",capture)
                    page.locator("#chatModel").select_option("lmstudio/local-model")
                    page.locator("#chatInput").fill("添付テキストの合言葉と画像の色を、日本語で1行だけ答えてください。")
                    # 一度だけ通信失敗を再現し、添付と本文が残って再送できることを確認します。
                    page.route("**/v1/chat/completions",lambda route:route.fulfill(status=503,json={"error":{"message":"検証用の一時通信エラー"}}),times=1)
                    page.locator("#chatSend").click()
                    expect(page.locator("#chatStatus")).to_have_text("失敗",timeout=30000)
                    expect(page.locator("#chatAttachments article")).to_have_count(2)
                    page.locator("#chatSend").click()
                    expect(page.locator("#chatStatus")).to_have_text("完了",timeout=60000)
                    assert len(sent)==2 and sent[1]["visionRequired"] and sent[1]["imageParts"]==1 and sent[1]["documentIncluded"] and sent[1]["messageCount"]==1
                    expect(page.locator("#chatAttachments article")).to_have_count(0)
                    result["attachmentSend"]={**sent[1],"answerReceived":True,"retryPreservedAttachments":True}
                    page.evaluate("window.scrollTo(0,0)")
                    page.screenshot(path=str(folder/"attachments-response.png"),full_page=True)
                    page.locator("#chatInput").fill("前の添付画像と合言葉をまだ参照できますか。色と合言葉を1行で答えてください。")
                    page.locator("#chatSend").click()
                    expect(page.locator("#chatStatus")).to_have_text("完了",timeout=60000)
                    assert sent[-1]["visionRequired"] and sent[-1]["imageParts"]==1 and sent[-1]["messageCount"]==3
                    result["attachmentSend"]["followupKeptVision"]=True
                    result["attachmentSend"]["pasteAndDrop"]=True
                    result["checks"].append({"view":"attachments-response","visible":True})
                page.screenshot(path=str(folder/(view+".png")),full_page=True)
                result["checks"].append({"view":view,"visible":True})
            # 小さい画面でもナビゲーションと対応状況へ到達できることを確認します。
            page.set_viewport_size({"width":390,"height":844})
            page.locator('nav button[data-view="improvements"]').click()
            expect(page.locator("#controlStatus")).to_be_visible()
            page.screenshot(path=str(folder/"mobile.png"),full_page=True)
            result["checks"].append({"view":"mobile","visible":True})
            result["pageErrors"]=errors
            result["success"]=not errors
            context.close()
            browser.close()
    except Exception as error:
        # ライブラリの例外文には入力値が含まれる場合があるため、型と確認箇所だけ記録します。
        result.update({"failedStep":step,"errorType":type(error).__name__})
    (folder/"report.json").write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps(result,ensure_ascii=False,indent=2))
    return 0 if result["success"] else 1


if __name__=="__main__":
    raise SystemExit(main())
