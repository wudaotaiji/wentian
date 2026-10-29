import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType } from 'docx';
import ExcelJS,{type PaperSize} from 'exceljs';
import pptxgen from 'pptxgenjs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import type { KnowledgeArtifact } from './knowledge-workflow.js';

/** 成果本文と根拠を再編集できるOffice形式へ変換し、画像だけの成果物にしません。 */
export async function exportKnowledgeOffice(artifact:KnowledgeArtifact,format:'docx'|'xlsx'|'pptx'):Promise<Buffer>{
  const status=artifact.status==='ai_reviewed'?'AI根拠検証済み・人間未承認':'未確認・暫定成果';
  if(format==='docx'){
    const children:Array<Paragraph|Table>=[new Paragraph({text:artifact.title,heading:HeadingLevel.TITLE}),new Paragraph(status),new Paragraph({text:'依頼',heading:HeadingLevel.HEADING_1}),new Paragraph(artifact.question)];
    for(const claim of artifact.claims){const review=artifact.reviews.find(r=>r.id===claim.id)!;children.push(new Paragraph({text:claim.id+' / '+claim.kind,heading:HeadingLevel.HEADING_1}),new Paragraph({children:[new TextRun(claim.text)],spacing:{after:160}}),new Paragraph('検証: '+review.verdict+' / '+review.reason));for(const citation of claim.citations){const hit=artifact.evidence.find(h=>h.chunkId===citation.chunkId)!;children.push(new Paragraph('出典: '+hit.title+' / '+hit.url+' / 改訂 '+hit.revision),new Paragraph({children:[new TextRun({text:citation.quote,italics:true})]}))}}
    children.push(new Paragraph({text:'根拠確認一覧',heading:HeadingLevel.HEADING_1}),new Table({width:{size:100,type:WidthType.PERCENTAGE},rows:[['主張','状態','検証理由'],...artifact.reviews.map(r=>[r.id,r.verdict,r.reason])].map(row=>new TableRow({children:row.map(text=>new TableCell({children:[new Paragraph(text)]}))}))}));
    if(artifact.unresolved.length)children.push(new Paragraph({text:'未確認事項',heading:HeadingLevel.HEADING_1}),...artifact.unresolved.map(text=>new Paragraph(text)));
    return Packer.toBuffer(new Document({title:artifact.title,styles:{default:{document:{run:{font:'Yu Gothic',size:21}}}},sections:[{properties:{page:{size:{width:11906,height:16838},margin:{top:1000,bottom:1000,left:1000,right:1000}}},children}]}));
  }
  if(format==='xlsx'){
    const book=new ExcelJS.Workbook();book.creator='Wentian';book.calcProperties.fullCalcOnLoad=true;
    const summary=book.addWorksheet('Summary'),claims=book.addWorksheet('Claims'),sources=book.addWorksheet('Sources');
    summary.addRow([artifact.title]);summary.addRow([status]);const verdicts=['supported','contradicted','insufficient'];
    verdicts.forEach((verdict,index)=>summary.addRow([verdict,{formula:`COUNTIF(Claims!D2:D${artifact.claims.length+1},"${verdict}")`,result:artifact.reviews.filter(r=>r.verdict===verdict).length}]));
    summary.columns=[{width:34},{width:18}];summary.getRow(1).font={bold:true,size:16};
    claims.addRow(['主張ID','区分','本文','検証状態','検証理由','引用元ID','引用']);
    for(const claim of artifact.claims){const review=artifact.reviews.find(r=>r.id===claim.id)!;claims.addRow([claim.id,claim.kind,claim.text,review.verdict,review.reason,claim.citations.map(c=>c.chunkId).join('\n'),claim.citations.map(c=>c.quote).join('\n')])}
    sources.addRow(['資料ID','資料名','URL','改訂','開始行','終了行','本文ハッシュ']);for(const hit of artifact.evidence)sources.addRow([hit.documentId,hit.title,hit.url,hit.revision,hit.lineStart,hit.lineEnd,hit.contentHash]);
    for(const sheet of[claims,sources]){sheet.views=[{state:'frozen',ySplit:1}];sheet.getRow(1).font={bold:true};sheet.columns.forEach((column,index)=>{column.width=index===2?65:24});sheet.eachRow(row=>{row.alignment={wrapText:true,vertical:'top'}});sheet.autoFilter={from:{row:1,column:1},to:{row:sheet.rowCount,column:sheet.columnCount}}}
    if(artifact.unresolved.length){const unresolved=book.addWorksheet('Unresolved');unresolved.addRow(['未確認事項']);for(const text of artifact.unresolved)unresolved.addRow([text]);unresolved.getColumn(1).width=90;unresolved.eachRow(row=>{row.alignment={wrapText:true,vertical:'top'}})}
    // 表の列やグラフを横方向の別ページへ分断せず、縦方向の改ページだけを許可します。
    // PDF変換側で補正せず、再編集できる元のブックにも印刷範囲を保持します。
    // ExcelJSの列挙にA3が無いため、ExcelのA3用紙番号8だけを型注釈で補います。
    const a3PaperSize=8 as unknown as PaperSize;
    for(const sheet of book.worksheets){
      sheet.pageSetup={paperSize:sheet===claims||sheet===sources?a3PaperSize:9,orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0,
        printArea:sheet===summary?'A1:L20':`A1:${sheet.getColumn(sheet.columnCount).letter}${sheet.rowCount}`,
        ...(sheet===summary?{}:{printTitlesRow:'1:1'})};
    }
    const buffer=Buffer.from(await book.xlsx.writeBuffer());
    // ExcelJSが生成する編集可能なセルへ、標準OOXMLの棒グラフを追加します。
    const files=unzipSync(buffer),counts=verdicts.map(v=>artifact.reviews.filter(r=>r.verdict===v).length);
    const categories=verdicts.map((v,i)=>`<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join(''),values=counts.map((n,i)=>`<c:pt idx="${i}"><c:v>${n}</c:v></c:pt>`).join('');
    files['xl/charts/chart1.xml']=strToU8(`<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>根拠確認</c:v></c:tx><c:cat><c:strRef><c:f>Summary!$A$3:$A$5</c:f><c:strCache><c:ptCount val="3"/>${categories}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Summary!$B$3:$B$5</c:f><c:numCache><c:formatCode>0</c:formatCode><c:ptCount val="3"/>${values}</c:numCache></c:numRef></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:crossAx val="1"/></c:valAx></c:plotArea><c:plotVisOnly val="1"/></c:chart></c:chartSpace>`);
    files['xl/drawings/drawing1.xml']=strToU8('<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>11</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>19</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="1" name="根拠確認"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>');
    files['xl/drawings/_rels/drawing1.xml.rels']=strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>');
    files['xl/worksheets/_rels/sheet1.xml.rels']=strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdKnowledgeChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>');
    files['xl/worksheets/sheet1.xml']=strToU8(strFromU8(files['xl/worksheets/sheet1.xml']).replace('</worksheet>','<drawing r:id="rIdKnowledgeChart"/></worksheet>'));
    files['[Content_Types].xml']=strToU8(strFromU8(files['[Content_Types].xml']).replace('</Types>','<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>'));
    return Buffer.from(zipSync(files));
  }
  // パッケージのCommonJS型宣言とESM実行時の既定エクスポートを合わせます。
  const Pptx=pptxgen as unknown as typeof pptxgen.default;
  const deck=new Pptx();deck.layout='LAYOUT_WIDE';deck.author='Wentian';deck.subject=status;deck.title=artifact.title;
  const pages=[{title:artifact.title,body:status+'\n\n'+artifact.question},...artifact.claims.flatMap(claim=>{const review=artifact.reviews.find(r=>r.id===claim.id)!;return[{title:claim.id+' / '+claim.kind,body:claim.text+'\n\n検証: '+review.verdict+'\n'+review.reason},...claim.citations.map(c=>{const hit=artifact.evidence.find(h=>h.chunkId===c.chunkId)!;return{title:'出典 / '+hit.title,body:c.quote+'\n\n'+hit.url+' / 改訂 '+hit.revision}})]})];
  if(artifact.unresolved.length)pages.push({title:'未確認事項',body:artifact.unresolved.join('\n\n')});
  let count=0;
  for(const page of pages){const chars=Array.from(page.body);for(let offset=0;offset<chars.length;offset+=350){if(++count>300)throw new Error('PowerPointは300ページ以内に成果を分けてください。');const slide=deck.addSlide();slide.background={color:'F7F9FC'};slide.addText(page.title,{x:0.6,y:0.3,w:12,h:1.2,fontSize:page.title.length>90?18:27,fontFace:'Yu Gothic',bold:true,color:'18324A',breakLine:false});slide.addText(chars.slice(offset,offset+350).join(''),{x:0.7,y:1.7,w:11.9,h:4.6,fontSize:18,fontFace:'Yu Gothic',color:'243746',valign:'top',breakLine:false});slide.addText(status+' / '+count,{x:0.7,y:6.9,w:12,h:0.3,fontSize:10,color:'526579'})}}
  const chart=deck.addSlide();chart.addText('根拠確認の状態',{x:0.6,y:0.4,w:12,h:0.6,fontSize:27});chart.addChart(deck.ChartType.bar,[{name:'主張数',labels:['supported','contradicted','insufficient'],values:['supported','contradicted','insufficient'].map(v=>artifact.reviews.filter(r=>r.verdict===v).length)}],{x:1,y:1.5,w:11,h:4.8,showLegend:false,showValue:true});
  return Buffer.from(await deck.write({outputType:'nodebuffer'}) as Buffer);
}
