import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnoseVideo } from './video-generation.js';
import { diagnoseMedia } from './media-production.js';

const engine=fileURLToPath(new URL('../.wentian/video-engine',import.meta.url));
/** 制作機能（Media Capabilities）はLLM自身の学習済み知識と分離して通知します。 */
export async function readMediaCapabilitySnapshot(options:{audioRoot?:string;videoRoot?:string;python?:string}={}){
 const audio=options.audioRoot||process.env.WENTIAN_AUDIO_MODEL_ROOT||path.join(engine,'audio-models');
 const video=options.videoRoot||process.env.WENTIAN_VIDEO_MODEL_PATH||path.join(engine,'model');
 const models:Record<string,{prepared:boolean;verificationOnly?:boolean}>={};
 for(const kind of ['music','sound','transcribe','video']){
  const directory=kind==='video'?video:path.join(audio,kind);
  try{const marker=JSON.parse(await readFile(path.join(directory,'wentian-model.json'),'utf8'));const files=Object.entries(marker.files||{});
   const complete=files.length>0&&(await Promise.all(files.map(async([name,size])=>{const target=path.resolve(directory,name);if(!target.startsWith(path.resolve(directory)+path.sep)||typeof size!=='number')return false;try{const file=await stat(target);return file.isFile()&&file.size===size}catch{return false}}))).every(Boolean);
   models[kind]={prepared:complete,...(kind==='video'?{verificationOnly:marker.verificationOnly===true}:{})};
  }catch{models[kind]={prepared:false}}
 }
 let pythonPrepared=false;try{pythonPrepared=(await stat(options.python||process.env.WENTIAN_VIDEO_PYTHON||path.join(engine,process.platform==='win32'?'Scripts/python.exe':'bin/python'))).isFile()}catch{/* 未準備は機能未実装と区別します。 */}
 return {implemented:true,observedAt:new Date().toISOString(),pythonPrepared,models,executionDiagnosed:false,pages:{studio:'/media-studio',video:'/videos',examples:'/media-studio#examples'}};
}

/** 現在のライブラリ・音声・モデルを診断します。モデル取得や生成は開始しません。 */
export async function inspectMediaCapabilities(){
 const [media,video,snapshot]=await Promise.all([diagnoseMedia(),diagnoseVideo(),readMediaCapabilitySnapshot()]);
 return {...snapshot,executionDiagnosed:true,media,video};
}

let cached: {key:string;expires:number;value:Promise<Awaited<ReturnType<typeof inspectMediaCapabilities>>>}|undefined;
/** 同じ会話プロセスでは短時間だけ診断を再利用し、毎回Pythonを起動しません。 */
async function currentInspection(snapshot:Awaited<ReturnType<typeof readMediaCapabilitySnapshot>>){
 const key=JSON.stringify([snapshot.models,snapshot.pythonPrepared,process.env.WENTIAN_VIDEO_PYTHON,process.env.WENTIAN_VIDEO_MODEL_PATH,process.env.WENTIAN_AUDIO_MODEL_ROOT,process.env.WENTIAN_VIDEO_DEVICE,process.env.WENTIAN_AUDIO_DEVICE]);
 if(!cached||cached.key!==key||cached.expires<Date.now())cached={key,expires:Date.now()+60000,value:inspectMediaCapabilities()};
 return cached.value;
}

/** CLI／Web会話で同じ自己能力説明を使用し、過去の一般的な否定回答を引き継がせません。 */
export async function mediaAgentContext(snapshot?:Awaited<ReturnType<typeof readMediaCapabilitySnapshot>>){
 const provided=snapshot!==undefined;
 snapshot??=await readMediaCapabilitySnapshot();
 const inspection=provided?undefined:await currentInspection(snapshot);
 return `\nWentianに実装済みの制作能力（LLM自身の学習済み能力とは別）: ナレーション・日中英のOS音声、MusicGen BGM、AudioLDM効果音、Whisper文字起こし、音声・動画取り込み、最大6音声トラックの切取・配置・音量・反復・フェード、動画速度・解像度・字幕・音声合成、無音／音声付きMP4、WAV・MP3・TXT・SRT・JSONの保存、画面での再生・取得・削除、モデル自動保守。ComfyUIは不要です。
「私はテキストしか扱えないので動画・音声制作機能がない」と答えないでください。Wentianの制作機能と、この会話で呼べるツールを区別してください。利用可否を質問されたらinspect_media_capabilitiesで現在の実行環境を診断してから説明してください。診断に失敗した場合も機能未実装とは断定せず、確認できた状態と未確認事項を示してください。
起動環境のファイル検査結果（生成成功とは異なります）: ${JSON.stringify(snapshot)}
会話開始時に取得した現在の実行診断（最大60秒のキャッシュ）: ${inspection?JSON.stringify(inspection):'この文脈では未取得。診断ツールで確認してください。'}
実行診断が渡されている場合は追加確認の許可を求めず、結果を説明してください。利用可能な音声機能を具体的に案内し、動画が検証用ならその制限を回答本文に必ず含めてください。
videoのverificationOnly=trueはランダム重みの動作確認用であり、文章に沿った実用品質の動画は生成できません。音声の準備状況とは別に説明してください。本番動画モデルへの自動切替や追加取得を行わないでください。BGM・効果音モデルの非商用条件は制作画面に表示しています。
この会話の制作関連ツールは診断用です。生成・編集の直接実行ツールは現在公開していないので、生成したと主張しないでください。実制作は制作画面 /media-studio、動画生成 /videos、保存した制作例 /media-studio#examples を案内してください。CLIでは接続中GatewayのURLを先頭に付けて案内してください。`;
}
