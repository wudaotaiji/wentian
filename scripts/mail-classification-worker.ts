import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 分類学習ワーカーはブラウザーと独立して実行し、人手で確認済みのメールだけを扱います。 */
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
process.env.WENTIAN_INSTALL_ROOT=root;
const directory=path.join(root,'.wentian','mail-operations');
mkdirSync(directory,{recursive:true});
const lock=path.join(directory,'classification-worker.lock');
let descriptor:number|undefined;
try{
  // 二重起動を避け、異常終了で残ったロックだけを持ち主PIDで判別して回収します。
  try{descriptor=openSync(lock,'wx');writeFileSync(descriptor,String(process.pid));}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const previous=Number(readFileSync(lock,'utf8'));try{if(Number.isSafeInteger(previous)&&previous>0){process.kill(previous,0);console.log('分類学習ワーカーは既に実行中です。');process.exit(0);}}catch{/* 終了済みのPIDを指すロックを回収します。 */}unlinkSync(lock);descriptor=openSync(lock,'wx');writeFileSync(descriptor,String(process.pid));}
  const {MailOperationsService}=await import('../src/mail-operations.js');
  const service=new MailOperationsService();
  console.log('分類学習ワーカーを開始しました。人手で確認した例を監視します。');
  const stop=()=>{void service.close().finally(()=>{if(descriptor!==undefined)try{unlinkSync(lock);}catch{/* 終了処理時の掃除です。 */}process.exit(0);});};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  for(;;){
    try{await service.tick();}catch(error){console.error('分類学習の確認に失敗しました。',error instanceof Error?error.message:'原因を確認してください。');}
    await new Promise(resolve=>setTimeout(resolve,15000));
  }
}catch(error){console.error('分類学習ワーカーを開始できません。',error instanceof Error?error.message:'原因を確認してください。');process.exitCode=1;}
finally{if(descriptor!==undefined)try{unlinkSync(lock);}catch{/* 正常終了時にロックが残るのを防ぎます。 */}}
