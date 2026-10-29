import os from 'node:os';
import { activeCliLanguage } from './cli-language.js';

/** LLMの言語判断がない内部処理では設定言語を使い、文字種から依頼の言語を推測しません。 */
export function responseLanguage(_prompt: string): 'zh' | 'ja' | 'en' {
  const configured = process.env.WENTIAN_RESPONSE_LANGUAGE || activeCliLanguage();
  return configured === 'zh' || configured === 'en' ? configured : 'ja';
}


/** 秘密情報を含まない実行環境だけをLLMのシステムコンテキストへ提供します。 */
export function safeRuntimeContext(cwd = process.cwd()): string {
  return `実行環境: OS=${os.platform()} ${os.release()}, architecture=${os.arch()}, current_directory=${cwd}, current_time=${new Date().toISOString()}`;
}
