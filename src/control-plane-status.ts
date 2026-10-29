/** 対応状況（Implementation Status）と検証証拠を固定の許可範囲から読み取ります。 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_EXECUTION_LIMITS } from './execution-budget.js';

/** 未取得を成功と解釈せず、保存されたテスト結果を集計します。生ログは画面へ送信しません。 */
export async function readControlPlaneEvidence(root: string) {
  const folder = path.join(root, 'docs/evidence/20261006_control_plane');
  const tests = await Promise.all(['full-tests-final.log','verify-powershell.log','verify-python.log','admin-ui-tests.log','ui-final-tests.log','budget-history-tests.log','retired-model-tests-final.log','chat-attachments-tests-final.log','chat-agent-tests-final.log','chat-agent-api-tests.log','chat-local-image-tests.log'].map(async name => {
    try { const log=await readFile(path.join(folder,name),'utf8');
      const value=(key:string)=>{const match=log.match(new RegExp('ℹ '+key+' (\\d+)'));return match?Number(match[1]):undefined};
      return {name,tests:value('tests'),passed:value('pass'),failed:value('fail'),skipped:value('skipped'),complete:value('duration_ms')!==undefined};
    } catch {return {name,complete:false};}
  }));
  let benchmark: unknown;
  try {const raw=JSON.parse(await readFile(path.join(folder,'local-benchmark.json'),'utf8'));benchmark={model:raw.model,gpuRequested:raw.gpuRequested,samples:raw.samples,initialRunning:raw.initialRunning,finalRunning:raw.finalRunning};}catch{benchmark=null}
  let browser: unknown = null;
  try { const raw=JSON.parse(await readFile(path.join(folder,'browser/report.json'),'utf8'));
    browser={success:raw.success===true,baseUrl:raw.baseUrl,checks:raw.checks,attachmentSend:raw.attachmentSend,pageErrors:raw.pageErrors??[]};
  } catch { /* 証拠がない場合は画面で未確認を表示します。 */ }
  let chatAgent:unknown=null;
  try{const raw=JSON.parse(await readFile(path.join(folder,'chat-agent-browser/report.json'),'utf8'));chatAgent={success:raw.success===true,checks:raw.checks,pageErrors:raw.pageErrors??[],baseUrl:raw.baseUrl}}catch{ /* 未取得は未確認として返します。 */ }
  let localImage:unknown=null;
  try{const raw=JSON.parse(await readFile(path.join(folder,'chat-local-image-browser/report.json'),'utf8'));localImage={success:raw.success===true,checks:raw.checks,pageErrors:raw.pageErrors??[],model:raw.model}}catch{ /* 未取得は未確認として返します。 */ }
  return {tests,benchmark,browser,chatAgent,localImage};
}

/** 独立検証（Independent Verification）の台帳は本文・機密出力を除いて返します。 */
export async function readVerificationRuns(root:string) {
  const folder=path.join(root,'.wentian/orchestration/runs');
  try {const names=(await readdir(folder)).sort().reverse().slice(0,20);
    return (await Promise.all(names.map(async name=>{try{const m=JSON.parse(await readFile(path.join(folder,name,'manifest.json'),'utf8'));
      return {id:m.task?.taskId??name,status:m.result?.status,updatedAt:m.updatedAt,note:m.result?.note,
        roles:(m.result?.reports??[]).map((r:any)=>({role:r.role,agent:r.agent,model:r.model,success:r.success,attempts:r.attempts})),
        verification:m.result?.acceptance?.status};}catch{return null}}))).filter(Boolean);
  }catch{return []}
}

/** 実装有無と稼働設定は別の状態として表示し、将来の項目を完了にしません。 */
export function controlPlaneFeatures(residencyEnabled:boolean) {
  return {limits:DEFAULT_EXECUTION_LIMITS,features:[
    ['personal-cloud-project','Personal Cloud','初期実装','PC登録・配備・操作ジョブを実装済み。複数端末の復旧、資格情報の復元・失効伝播、本番運用の検証は別途必要。','/personal-cloud'],
    ['node-federation-project','ノード連合','初期実装','ノードコア、署名通信、A2A連合を初期実装。NAT越え、多者同期、失効伝播、障害復旧の本番検証は未完了。','/v1/manager/control-plane/document'],
    ['wtc-project','WTCトークン（別プロジェクト）','ローカル検証済み','発行契約は独立WTCプロジェクトで実装・隔離EVM検証済み。主ネット発行・換金サービス・注文決済は未実施。','/wallet'],
    ['wallet','非保管ウォレット','実装済み','ETH・ERC-20の残高確認、外部ウォレット署名、送金・確認数を実配信画面で検証済み。','/wallet'],
    ['kubernetes-vm-project','Kubernetes・VM','設計段階','ローカルKubernetes／VM基盤は設計段階。Personal CloudのDocker／Podman実行は、クラスタ構築や接続を意味しない。','/v1/manager/control-plane/document'],
    ['boundaries','責務分離','実装済み','計画は必要能力、選択はルーター、資源評価はマネージャー。','models'],
    ['registry','モデル能力登録','実装済み','検出結果とモデル別の登録能力を統合。','models'],
    ['telemetry','性能履歴と復元','実装済み','タスク別の初回応答・生成速度・成功率を保存。','models'],
    ['memory','文脈長を含むメモリ評価','実装済み','入力・出力・バッチ・画像・追加KVキャッシュを評価。','models'],
    ['routing','予測と自動昇格・降格','実装済み','非ストリームの構造不合格で昇格。次回タスクごとに再選択。','routes'],
    ['attachments','会話のファイル・画像添付','実装済み','選択・ドロップ・貼付け、送信前の確認と削除。画像は対応モデルへ。','chat'],
    ['chat-agent','Plan / Actとツール会話','実装済み','PlanでWeb・ファイル調査、Actで許可パスへ書込み。管理者認証が必要。','chat'],
    ['local-image','指定したローカル画像の読取り','実装済み','引用符付きの絶対ファイルを読取り許可し、実画像を画像対応モデルへ渡す。','chat'],
    ['quality','難度と品質予算','実装済み','品質・難度と実行予算を会話画面で指定。','chat'],
    ['budget','実行とゴールの停止予算','実装済み','試行・時間・トークン・費用・再計画を制限。','/workbench#tasks'],
    ['residency','駐留・予熱・LRU退避',residencyEnabled?'有効':'無効','管理対象のみ退避。利用中と他アプリのモデルを保護。','lifecycle'],
    ['diversity','独立モデルによる最終検証','実装済み','同じモデル・系統と未確定モデルは最終検証に使わない。','verification'],
    ['evaluation','基礎評価と利用者受入','実装済み','固定正解3問と受入結果を記録。幅広い意味品質の評価は継続課題。','evaluation'],
    ['recommendation','個人向けモデル候補','実装済み','タスク履歴と資源適格性から候補を表示。','models'],
    ['semantic','幅広い課題の意味品質評価','未対応','現在は構造検査・固定正解の基礎評価と利用者受入。','evaluation'],
    ['gpu','GPU実機検証','環境制約','測定したPCはCPU推論。GPUのVRAM・断片化検証は未完了。','evidence'],
    ['queue','モデル別資源・待ち行列計測','未対応','現在の資源値はシステム全体の観測。','evidence'],
    ['prediction','次タスクを予測した予熱','未対応','現在は指定モデルの予熱と駐留維持。','lifecycle'],
    ['protocol','全互換APIへの統一予算','一部対応','チャット補完とゴールが対象。他の互換APIは対象外。','chat'],
    ['production','本番適用','設定依存','この画面の状態は現在のGateway。実機証拠の採取日時とは区別。','overview'],
  ].map(([id,title,status,description,view])=>({id,title,status,description,view}))};
}
