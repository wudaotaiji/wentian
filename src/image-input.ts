import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_COUNT = 4;
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
};

export type ImageAttachment = {
  path: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
};

/**
 * 端末へドラッグ＆ドロップされた「画像パスだけ」の入力を判定します。
 * 通常文章に含まれるパスを誤って添付しないよう、入力全体が絶対パスの場合だけ認識します。
 */
export function parseImagePromptInput(input: string): { imagePath: string; prompt: string } | undefined {
  const trimmed = input.trim();
  // 空白を含むWindowsパスは引用符で囲まれるため、先頭の閉じ引用符までをパスとして分離します。
  const quoted = trimmed.match(/^(?:"([^"]+)"|'([^']+)')\s*(.*)$/s);
  const candidate = quoted ? (quoted[1] || quoted[2]) : trimmed;
  const prompt = quoted ? quoted[3].trim() : '';
  if (!path.isAbsolute(candidate)) return undefined;
  if (!MIME_BY_EXTENSION[path.extname(candidate).toLowerCase()]) return undefined;
  return { imagePath: candidate, prompt };
}

/** 互換APIとして、質問文を伴わない単独画像パスだけを返します。 */
export function standaloneImagePath(input: string): string | undefined {
  const parsed = parseImagePromptInput(input);
  return parsed && !parsed.prompt ? parsed.imagePath : undefined;
}

/** ドラッグ＆ドロップ時に付く引用符を除き、許可画像だけを安全に読み込みます。 */
export async function loadImageAttachment(inputPath: string): Promise<ImageAttachment> {
  const normalized = inputPath.trim().replace(/^["']|["']$/g, '');
  if (!normalized) throw new Error('画像ファイル名を指定してください。');
  const resolved = await realpath(path.resolve(normalized)).catch(() => { throw new Error(`画像ファイルが見つかりません: ${normalized}`); });
  const extension = path.extname(resolved).toLowerCase();
  const mimeType = MIME_BY_EXTENSION[extension];
  if (!mimeType) throw new Error('対応画像形式はPNG、JPEG、WebP、GIFです。');
  const metadata = await stat(resolved);
  if (!metadata.isFile()) throw new Error('画像には通常ファイルを指定してください。');
  if (metadata.size <= 0 || metadata.size > MAX_IMAGE_BYTES) throw new Error('画像は1枚あたり10 MiB以下にしてください。');
  const bytes = await readFile(resolved);
  const validSignature = mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : mimeType === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : mimeType === 'image/gif' ? ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
        : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!validSignature) throw new Error('拡張子と画像ファイルの実形式が一致しません。');
  // 高解像度PNGはVision推論時間が急増するため、Windowsでは長辺1024pxへ縮小します。
  // 元ファイルは変更せず、Wentian一時ディレクトリへPNGコピーを生成します。
  if (mimeType === 'image/png' && bytes.length >= 24) {
    const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
    if (Math.max(width, height) > 1024 && process.platform === 'win32') {
      const directory = path.join(os.tmpdir(), 'wentian-images'); await mkdir(directory, { recursive: true });
      const optimizedPath = path.join(directory, `optimized-${Date.now()}-${path.basename(resolved)}`);
      const command = [
        'Add-Type -AssemblyName System.Drawing',
        '$source=[System.Drawing.Image]::FromFile($env:WENTIAN_IMAGE_SOURCE)',
        '$ratio=[Math]::Min(1024.0/$source.Width,1024.0/$source.Height)',
        '$width=[Math]::Max(1,[int]($source.Width*$ratio));$height=[Math]::Max(1,[int]($source.Height*$ratio))',
        '$target=New-Object System.Drawing.Bitmap $width,$height',
        '$graphics=[System.Drawing.Graphics]::FromImage($target)',
        '$graphics.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
        'try{$graphics.DrawImage($source,0,0,$width,$height);$target.Save($env:WENTIAN_IMAGE_TARGET,[System.Drawing.Imaging.ImageFormat]::Png)}finally{$graphics.Dispose();$target.Dispose();$source.Dispose()}',
      ].join(';');
      await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command], { env: { ...process.env, WENTIAN_IMAGE_SOURCE: resolved, WENTIAN_IMAGE_TARGET: optimizedPath }, windowsHide: true, timeout: 30_000 });
      const optimized = await loadImageAttachment(optimizedPath);
      return { ...optimized, name: path.basename(resolved) };
    }
  }
  return { path: resolved, name: path.basename(resolved), mimeType, sizeBytes: bytes.length, dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}` };
}

/** 添付数と合計サイズを検査し、誤操作による巨大リクエストを防ぎます。 */
export function validateImageAttachments(images: ImageAttachment[]): void {
  if (images.length > MAX_IMAGE_COUNT) throw new Error(`画像は最大${MAX_IMAGE_COUNT}枚です。`);
  const total = images.reduce((sum, image) => sum + image.sizeBytes, 0);
  if (total > MAX_TOTAL_IMAGE_BYTES) throw new Error('画像の合計サイズは20 MiB以下にしてください。');
}

/** Windowsクリップボードの画像を一時PNGへ保存します。秘密情報をログへ出力しません。 */
export async function loadClipboardImage(): Promise<ImageAttachment> {
  if (process.platform !== 'win32') throw new Error('クリップボード画像は現在Windowsだけに対応しています。');
  const directory = path.join(os.tmpdir(), 'wentian-clipboard');
  await mkdir(directory, { recursive: true });
  const outputPath = path.join(directory, `clipboard-${Date.now()}.png`);
  // 引数へパスを埋め込まず環境変数で渡し、シェル文字によるコマンド注入を防ぎます。
  const command = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$image=[System.Windows.Forms.Clipboard]::GetImage()',
    'if($null -eq $image){Write-Error "クリップボードに画像がありません。";exit 2}',
    'try{$image.Save($env:WENTIAN_CLIPBOARD_IMAGE,[System.Drawing.Imaging.ImageFormat]::Png)}finally{$image.Dispose()}',
  ].join(';');
  await execFileAsync('powershell.exe', ['-NoProfile', '-Sta', '-Command', command], {
    env: { ...process.env, WENTIAN_CLIPBOARD_IMAGE: outputPath }, windowsHide: true, timeout: 15_000,
  }).catch(() => { throw new Error('クリップボードに画像がありません。画像をコピーしてから再実行してください。'); });
  return loadImageAttachment(outputPath);
}

export function imageMessageContent(prompt: string, images: ImageAttachment[]) {
  return [
    { type: 'text', text: prompt || '添付画像を分析してください。' },
    ...images.map(image => ({ type: 'image_url', image_url: { url: image.dataUrl, detail: 'auto' } })),
  ];
}
