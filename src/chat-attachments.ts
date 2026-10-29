/** 会話添付（Chat Attachments）は本文だけを抽出し、元ファイルをディスクへ保存しません。 */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENT_TEXT_BYTES = 128 * 1024;
const textExtensions=new Set(['txt','md','csv','json','log','yaml','yml','xml','html','py','ps1','js','ts','tsx','jsx','css','sql','sh','c','cpp','h','rs','go','java','toml','ini']);

/** Officeの圧縮ファイルは、展開サイズ・件数・暗号化を読み込み前に検査します。 */
function checkOfficeArchive(data:Buffer):void {
 let end=-1;for(let i=data.length-22;i>=Math.max(0,data.length-65557);i--)if(data.readUInt32LE(i)===0x06054b50){end=i;break}
 if(end<0)throw new Error('Officeファイルの形式が不正です。');
 const count=data.readUInt16LE(end+10);let cursor=data.readUInt32LE(end+16),expanded=0;
 if(count>512||cursor===0xffffffff)throw new Error('Officeファイルの内容が大きすぎます。');
 for(let i=0;i<count;i++){
  if(cursor+46>data.length||data.readUInt32LE(cursor)!==0x02014b50)throw new Error('Officeファイルの構造が不正です。');
  if(data.readUInt16LE(cursor+8)&1)throw new Error('パスワード保護されたファイルには対応していません。');
  expanded+=data.readUInt32LE(cursor+24);if(expanded>20*1024*1024)throw new Error('Officeファイルの展開内容が大きすぎます。');
  cursor+=46+data.readUInt16LE(cursor+28)+data.readUInt16LE(cursor+30)+data.readUInt16LE(cursor+32);
 }
}

export async function extractChatAttachment(input:unknown):Promise<{name:string;text:string;bytes:number}> {
 const value=input as {name?:unknown;base64?:unknown};
 if(typeof value?.name!=='string'||!value.name||value.name.length>200||/[\\/\x00-\x1f]/.test(value.name)||typeof value.base64!=='string')throw new Error('ファイルの指定が不正です。');
 if(value.base64.length>Math.ceil(MAX_ATTACHMENT_BYTES/3)*4||value.base64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(value.base64))throw new Error('ファイルの容量または形式が不正です。');
 const data=Buffer.from(value.base64,'base64');if(!data.length||data.length>MAX_ATTACHMENT_BYTES)throw new Error('ファイルは1件5 MiB以内で指定してください。');
 const extension=value.name.toLowerCase().split('.').at(-1)!;let text='';
 const limit=(content:string)=>{if(Buffer.byteLength(content,'utf8')>MAX_ATTACHMENT_TEXT_BYTES)throw new Error('抽出した本文が長すぎます。ファイルを分割してください。');return content;};
 if(textExtensions.has(extension)){
  // BOM付きUTF-16とUTF-8を優先し、従来のWindows日本語テキストも読み取ります。
  if(data[0]===0xff&&data[1]===0xfe)text=new TextDecoder('utf-16le',{fatal:true}).decode(data);
  else if(data[0]===0xfe&&data[1]===0xff)text=new TextDecoder('utf-16be',{fatal:true}).decode(data);
  else{try{text=new TextDecoder('utf-8',{fatal:true}).decode(data)}catch{text=new TextDecoder('shift_jis',{fatal:true}).decode(data)}}
  if(text.includes('\0'))throw new Error('バイナリファイルはテキストとして添付できません。');
 }else if(extension==='pdf'){
  if(!data.subarray(0,5).equals(Buffer.from('%PDF-')))throw new Error('PDFの形式が不正です。');
  // 会話添付も同じブラウザー経路を使い、従来の本文・ページ上限を維持します。
  // 会話から認識モデルへ勝手に送らず、スキャンだけのPDFは従来どおり画像添付を案内します。
  const {extractBrowserPdf}=await import('./knowledge-pdf.js');
  text=limit((await extractBrowserPdf(data,AbortSignal.timeout(60000),async()=>{throw new Error('会話添付の本文抽出ではOCRを実行しません。');},undefined,{textOnly:true,maxPages:100,maxTextBytes:MAX_ATTACHMENT_TEXT_BYTES})).content);
 }else if(extension==='docx'||extension==='xlsx'){
  checkOfficeArchive(data);
  const {unzipSync}=await import('fflate');const {XMLParser}=await import('fast-xml-parser');
  // 本文・表データのXMLだけを展開し、外部ファイル・画像・マクロは読み込みません。
  const parts=unzipSync(data,{filter:file=>file.name==='word/document.xml'||/^xl\/(sharedStrings\.xml|workbook\.xml|_rels\/workbook\.xml\.rels|worksheets\/sheet[0-9]+\.xml)$/.test(file.name)});
  const parser=new XMLParser({ignoreAttributes:false,removeNSPrefix:true,parseTagValue:false,processEntities:false,trimValues:false});
  const xml=(name:string)=>{const bytes=parts[name];if(!bytes)throw new Error('Officeファイルの本文が見つかりません。');const source=new TextDecoder().decode(bytes);if(/<!DOCTYPE|<!ENTITY/i.test(source))throw new Error('Office本文に未対応のXML宣言があります。');return parser.parse(source)};
  const array=(value:any):any[]=>value===undefined?[]:Array.isArray(value)?value:[value];
  const decode=(value:string)=>value.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-f]+|#[0-9]+);/gi,(_,entity:string)=>{const known:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};if(known[entity])return known[entity];const n=entity.startsWith('#x')?parseInt(entity.slice(2),16):Number(entity.slice(1));return n>0&&n<=0x10ffff?String.fromCodePoint(n):'�'});
  const strings=(node:any):string=>{if(node===undefined||node===null)return '';if(typeof node!=='object')return decode(String(node));if(Array.isArray(node))return node.map(strings).join('');if(node.t!==undefined)return strings(node.t);if(node['#text']!==undefined)return strings(node['#text']);return Object.entries(node).filter(([key])=>!key.startsWith('@_')).map(([,value])=>strings(value)).join('')};
  if(extension==='docx'){
   const walk=(node:any):void=>{if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(walk);return}for(const [key,value]of Object.entries(node)){if(key==='p')for(const paragraph of array(value))text=limit(text+strings(paragraph)+'\n');else walk(value)}};
   walk(xml('word/document.xml'));
  }else{
   const workbook=xml('xl/workbook.xml').workbook;
   const relationships=array(xml('xl/_rels/workbook.xml.rels').Relationships?.Relationship);
   const shared=parts['xl/sharedStrings.xml']?array(xml('xl/sharedStrings.xml').sst?.si).map(strings):[];
   for(const sheet of array(workbook?.sheets?.sheet)){
    const relation=relationships.find(r=>r['@_Id']===sheet['@_id']);const target=String(relation?.['@_Target']||'');
    const filename=target.startsWith('/xl/')?target.slice(1):'xl/'+target.replace(/^\.\//,'');if(!/^xl\/worksheets\/sheet[0-9]+\.xml$/.test(filename))continue;
    text=limit(text+'\nシート: '+decode(sheet['@_name']||'')+'\n');
    for(const row of array(xml(filename).worksheet?.sheetData?.row)){
     const cells=array(row.c).map(cell=>{const type=cell['@_t'];const value=type==='s'?shared[Number(cell.v)]??'':type==='inlineStr'?strings(cell.is):decode(String(cell.v??''));return String(cell['@_r']||'')+': '+value});
     text=limit(text+cells.join('\t')+'\n');
    }
   }
  }
 }else throw new Error('対応形式はPDF・DOCX・XLSX・テキスト・CSV・コードファイルです。');
 text=limit(text.trim());if(!text)throw new Error('本文を抽出できませんでした。スキャンPDFはページ画像として添付してください。');
 return{name:value.name,text,bytes:data.length};
}
