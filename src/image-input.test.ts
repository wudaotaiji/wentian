import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { imageMessageContent, loadImageAttachment, parseImagePromptInput, standaloneImagePath, validateImageAttachments } from './image-input.js';

test('引用符付き絶対画像パスだけをドラッグ＆ドロップ入力として判定する', () => {
  assert.equal(standaloneImagePath('"C:\\temp\\screen.png"'), 'C:\\temp\\screen.png');
  assert.equal(standaloneImagePath('C:\\temp\\photo.JPEG'), 'C:\\temp\\photo.JPEG');
  assert.equal(standaloneImagePath('この C:\\temp\\screen.png を見て'), undefined);
  assert.equal(standaloneImagePath('relative.png'), undefined);
  assert.equal(standaloneImagePath('C:\\temp\\notes.txt'), undefined);
});

test('引用符付き画像パスの直後に続く質問文を分離する', () => {
  assert.deepEqual(
    parseImagePromptInput('"C:\\Users\\user name\\screen.png"何の画像ですか教えて'),
    { imagePath: 'C:\\Users\\user name\\screen.png', prompt: '何の画像ですか教えて' },
  );
  assert.deepEqual(
    parseImagePromptInput('"C:\\temp\\screen.png" 用中文说明'),
    { imagePath: 'C:\\temp\\screen.png', prompt: '用中文说明' },
  );
});

test('PNG画像をData URLとして読み込む', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wentian-image-test-'));
  const imagePath = path.join(directory, 'sample.png');
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const image = await loadImageAttachment(`"${imagePath}"`);
  assert.equal(image.mimeType, 'image/png');
  assert.match(image.dataUrl, /^data:image\/png;base64,/);
  assert.equal(imageMessageContent('確認', [image])[1].type, 'image_url');
});

test('未対応形式と5枚以上の添付を拒否する', async () => {
  await assert.rejects(() => loadImageAttachment('sample.exe'), /見つかりません/);
  const dummy = { path: 'x', name: 'x.png', mimeType: 'image/png', sizeBytes: 1, dataUrl: 'data:image/png;base64,eA==' };
  assert.throws(() => validateImageAttachments(Array(5).fill(dummy)), /最大4枚/);
});
