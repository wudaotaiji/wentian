import test from 'node:test';
import assert from 'node:assert/strict';
import {zipSync,strToU8} from 'fflate';
import {readFile} from 'node:fs/promises';
import {extractChatAttachment,MAX_ATTACHMENT_BYTES} from './chat-attachments.js';
const file=(name:string,data:Buffer|Uint8Array|string)=>({name,base64:Buffer.from(data).toString('base64')});

test('会話ファイルはUTF-8の本文を抽出し、不正容量・形式・バイナリを拒否する',async()=>{
 assert.equal((await extractChatAttachment(file('資料.txt','こんにちは。添付本文です。'))).text,'こんにちは。添付本文です。');
 await assert.rejects(()=>extractChatAttachment(file('../秘密.txt','本文')),/指定/);
 await assert.rejects(()=>extractChatAttachment(file('大きい.txt',Buffer.alloc(MAX_ATTACHMENT_BYTES+1))),/容量|5 MiB/);
 await assert.rejects(()=>extractChatAttachment(file('実行.exe','MZ')),/対応形式/);
 await assert.rejects(()=>extractChatAttachment(file('空.txt','')),/5 MiB/);
 await assert.rejects(()=>extractChatAttachment(file('画像.txt',Buffer.from([0,1,2]))),/バイナリ/);
});

test('Wordの段落とExcelのセル値を抽出し、式・マクロを実行しない',async()=>{
 const docx=zipSync({'word/document.xml':strToU8('<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>資料 &amp; 確認</w:t></w:r></w:p><w:p><w:r><w:t>二段落</w:t></w:r></w:p></w:body></w:document>')});
 assert.equal((await extractChatAttachment(file('資料.docx',docx))).text,'資料 & 確認\n二段落');
 const xlsx=zipSync({'xl/workbook.xml':strToU8('<workbook xmlns:r="urn:rels"><sheets><sheet name="売上" sheetId="1" r:id="rId1"/></sheets></workbook>'),'xl/_rels/workbook.xml.rels':strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),'xl/sharedStrings.xml':strToU8('<sst><si><t>商品</t></si></sst>'),'xl/worksheets/sheet1.xml':strToU8('<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><f>1+2</f><v>3</v></c></row></sheetData></worksheet>')});
 assert.match((await extractChatAttachment(file('売上.xlsx',xlsx))).text,/シート: 売上\nA1: 商品\tB1: 3/);
});

test('PDFの実文書からテキストを抽出する',async()=>{
 // オフセットと相互参照（Cross Reference）を作り、パーサーを通る実PDFを生成します。
 const content='BT /F1 12 Tf 20 50 Td (ATTACHMENT_PDF_OK) Tj ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
 let pdf='%PDF-1.4\n';const offsets=[0];objects.forEach((body,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${body}\nendobj\n`});
 const offset=Buffer.byteLength(pdf);pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`;
 assert.match((await extractChatAttachment(file('確認.pdf',pdf))).text,/ATTACHMENT_PDF_OK/);
});

test('会話のスキャンPDFはページ見出しだけで本文抽出成功にしない',async()=>{
 const data=await readFile('examples/knowledge/demo/09-scan-checklist.pdf');
 await assert.rejects(extractChatAttachment(file('スキャン.pdf',data)),/本文を抽出できません/);
});
