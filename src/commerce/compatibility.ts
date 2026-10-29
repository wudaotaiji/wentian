import {check,integer,text,type Build,type Part} from './model.js';

export type CompatibilityStatus='compatible'|'incompatible'|'conditional'|'unknown';
export interface Evaluation {ruleId:string;version:string;status:CompatibilityStatus;parts:string[];observations:Record<string,unknown>;sources:Array<{url:string;verifiedAt:string}>;reason:string;resolution:string}
/** 型番と出典を入力データに保持し、欠落した仕様を推測で補わないルールエンジン（Rule Engine）です。 */
export function evaluateBuild(build:Build,catalog:Part[]){
  const selected=build.parts.map(item=>({...item,part:catalog.find(p=>p.id===item.id)!}));
  const results:Evaluation[]=[];
  const first=(category:Part['category'])=>selected.find(p=>p.part?.category===category)?.part;
  const cpu=first('cpu'),board=first('motherboard'),memory=first('memory'),gpu=first('gpu'),psu=first('psu'),box=first('case'),cooler=first('cooler'),storage=first('storage');
  const add=(id:string,parts:(Part|undefined)[],fields:Array<[Part|undefined,string]>,predicate:(values:any[])=>boolean,reason:string,resolution:string,conditional=false)=>{
    const observations=Object.fromEntries(fields.map(([p,k])=>[(p?.id||'missing')+'.'+k,p?.spec[k]??null]));
    const complete=parts.every(Boolean)&&fields.every(([p,k])=>p?.spec[k]!==undefined)&&parts.every(p=>p?.source&&p.verifiedAt);
    const status:CompatibilityStatus=!complete?'unknown':predicate(fields.map(([p,k])=>p!.spec[k]))?'compatible':conditional?'conditional':'incompatible';
    results.push({ruleId:id,version:'1',status,parts:parts.filter(Boolean).map(p=>p!.id),observations,sources:parts.filter(Boolean).map(p=>({url:p!.source,verifiedAt:p!.verifiedAt})),reason:status==='unknown'?'仕様または出典が不足しています。':status==='compatible'?'確認済みの条件に適合します。':reason,resolution:status==='compatible'?'':status==='unknown'?'メーカー資料と対象型番を確認してください。':resolution});
  };
  add('cpu.socket',[cpu,board],[[cpu,'socket'],[board,'socket']],([a,b])=>a===b,'CPUソケットが一致しません。','対応ソケットの部品を選択してください。');
  add('cpu.support',[cpu,board],[[board,'supportedCpus']],([list])=>Array.isArray(list)&&list.includes(cpu?.id),'CPU対応一覧に対象型番がありません。','メーカーの対応一覧を確認してください。');
  add('cpu.bios',[cpu,board],[[board,'biosRevision'],[cpu,'minimumBiosRevision']],([a,b])=>typeof a==='number'&&typeof b==='number'&&a>=b,'BIOS更新が必要です。','メーカーの更新手順と対応版を確認してください。',true);
  for(const m of selected.filter(p=>p.part?.category==='memory')){
    add('memory.generation',[m.part,board],[[m.part,'generation'],[board,'memoryGeneration']],([a,b])=>a===b,'メモリ世代が一致しません。','対応するDDR世代を選択してください。');
    add('memory.form',[m.part,board],[[m.part,'form'],[board,'memoryForm']],([a,b])=>a===b,'メモリ形状が一致しません。','DIMM形状を確認してください。');
  }
  const mem=selected.filter(p=>p.part?.category==='memory');
  add('memory.capacity',[memory,board],[[board,'maxMemoryGb'],...mem.map(m=>[m.part,'capacityGb'] as [Part,string])],([max,...capacities])=>capacities.reduce((n,c,i)=>n+Number(c)*mem[i].quantity,0)<=Number(max),'メモリ容量の上限を超えています。','容量を減らしてください。');
  add('memory.slots',[memory,board],[[board,'memorySlots']],([slots])=>mem.reduce((n,m)=>n+m.quantity,0)<=Number(slots),'メモリスロットが不足しています。','枚数を減らしてください。');
  add('case.board',[box,board],[[box,'boardForms'],[board,'form']],([forms,form])=>Array.isArray(forms)&&forms.includes(form),'ケースが基板の規格に対応しません。','対応するフォームファクターを選択してください。');
  for(const dimension of ['lengthMm','heightMm','slots'] as const)add('gpu.'+dimension,[gpu,box],[[gpu,dimension],[box,'gpuMax'+dimension[0].toUpperCase()+dimension.slice(1)]],([a,b])=>Number(a)<=Number(b),'GPU寸法またはスロット数がケースの上限を超えます。','ケーブル余裕を含むケース制限を確認してください。');
  add('cooler.socket',[cooler,cpu],[[cooler,'sockets'],[cpu,'socket']],([sockets,socket])=>Array.isArray(sockets)&&sockets.includes(socket),'CPUクーラーがソケットに対応しません。','対応する取付方式を選択してください。');
  add('cooler.height',[cooler,box],[[cooler,'heightMm'],[box,'coolerMaxHeightMm']],([a,b])=>Number(a)<=Number(b),'クーラーの高さがケース上限を超えます。','ケース寸法と取付条件を確認してください。');
  for(const disk of selected.filter(p=>p.part?.category==='storage')){
    add('storage.interface',[disk.part,board],[[disk.part,'interface'],[board,'storageInterfaces']],([a,b])=>Array.isArray(b)&&b.includes(a),'ストレージ接続方式が非対応です。','プロトコルと端子を確認してください。');
    add('storage.form',[disk.part,board],[[disk.part,'form'],[board,'storageForms']],([a,b])=>Array.isArray(b)&&b.includes(a),'ストレージ形状が非対応です。','対応する寸法とキーを確認してください。');
  }
  add('storage.ports',[storage,board],[[board,'storagePorts']],([ports])=>selected.filter(p=>p.part.category==='storage').reduce((n,p)=>n+p.quantity,0)<=Number(ports),'ストレージ用端子が不足しています。','端子共有条件も確認してください。');
  add('expansion.lanes',[gpu,board],[[gpu,'requiredLanes'],[board,'gpuLanes']],([a,b])=>Number(a)<=Number(b),'GPUに割り当てるPCIeレーンが不足します。','拡張端子の帯域を確認してください。');
  add('power.connectors',[psu,gpu],[[psu,'gpuConnectors'],[gpu,'powerConnectors']],([supply,required])=>Array.isArray(supply)&&Array.isArray(required)&&required.every((r:string)=>supply.filter((s:string)=>s===r).length>=required.filter((s:string)=>s===r).length),'必要な電源コネクタが不足しています。','メーカー推奨のコネクタを確認してください。');
  add('power.capacity',[psu,...selected.map(p=>p.part)],[[psu,'watts'],...selected.filter(p=>p.part.category!=='psu').map(p=>[p.part,'estimatedWatts'] as [Part,string])],([capacity,...watts])=>Number(capacity)>=Math.ceil(watts.reduce((n,w,i)=>n+Number(w)*selected.filter(p=>p.part.category!=='psu')[i].quantity,0)*1.3),'推定電力と30%の余裕に対して電源容量が不足します。','測定条件とメーカー推奨電源を確認してください。');
  add('board.sharedPorts',[board],[[board,'sharedPortsVerified']],([v])=>v===true,'端子共有の制約が未確認です。','マザーボードの端子共有表を確認してください。',true);
  // 明示接続（Explicit Connection）は画面座標から独立し、規格・方向・資源数を検証します。
  const used=new Map<string,number>(),connections=build.connections||[];
  for(const connection of connections){
    const from=firstEndpoint(connection.from),to=firstEndpoint(connection.to);
    const valid=from&&to&&connection.from.partId!==connection.to.partId&&from.port.protocol===to.port.protocol&&from.port.direction!=='input'&&to.port.direction!=='output';
    for(const endpoint of [connection.from,connection.to])used.set(endpoint.partId+'/'+endpoint.portId,(used.get(endpoint.partId+'/'+endpoint.portId)||0)+connection.quantity);
    results.push({ruleId:'connection.'+connection.id,version:'1',status:valid?'compatible':'incompatible',parts:[connection.from.partId,connection.to.partId],observations:{from:connection.from,to:connection.to,quantity:connection.quantity},sources:[from?.part,to?.part].filter(Boolean).map(part=>({url:part!.source,verifiedAt:part!.verifiedAt})),reason:valid?'接続規格と方向が一致します。':'接続先がないか、規格・方向が一致しません。',resolution:valid?'':'対応する接続先を選び直してください。'});
  }
  function firstEndpoint(endpoint:{partId:string;portId:string}){const item=selected.find(p=>p.id===endpoint.partId),port=item?.part?.ports?.find(p=>p.id===endpoint.portId);return item&&port?{part:item.part,port,quantity:item.quantity}:undefined}
  for(const item of selected)for(const port of item.part?.ports||[]){const count=used.get(item.id+'/'+port.id)||0,capacity=port.capacity*item.quantity;const status:CompatibilityStatus=count>capacity?'incompatible':port.required&&count===0?'unknown':'compatible';results.push({ruleId:'port.'+item.id+'.'+port.id,version:'1',status,parts:[item.id],observations:{used:count,capacity,required:port.required},sources:[{url:item.part.source,verifiedAt:item.part.verifiedAt}],reason:status==='incompatible'?'接続資源の上限を超えています。':status==='unknown'?'必須端子が未接続です。':'端子の使用数は上限以内です。',resolution:status==='compatible'?'':'接続数と必要端子を確認してください。'})}
  const missing=(['cpu','gpu','motherboard','memory','storage','psu','case','cooler'] as const).filter(c=>!first(c));
  const status=missing.length?'incomplete':results.some(r=>r.status==='incompatible')?'incompatible':results.some(r=>r.status==='unknown')?'unknown':results.some(r=>r.status==='conditional')?'conditional':'compatible';
  return {buildRevision:build.revision,ruleVersion:'2',dataVersion:catalog.map(p=>JSON.stringify([p.id,p.spec,p.ports,p.source,p.verifiedAt])).join('|'),status,missing,results,performance:{status:'unavailable',reason:'測定条件に一致するベンチマーク資料が未登録です。FPS・AI速度は推定しません。'},powerMargin:0.3};
}

/** 部品カタログ（Catalog）と構成の入力を検証します。単一部品と数量制約をサーバーでも強制します。 */
export function validatePart(input:any):Part {
  check(['cpu','gpu','motherboard','memory','storage','psu','case','cooler'].includes(input?.category),'invalid_category','部品カテゴリを選択してください。');
  check(input.spec&&typeof input.spec==='object'&&!Array.isArray(input.spec)&&JSON.stringify(input.spec).length<12000,'invalid_spec','部品仕様を確認してください。');
  for(const value of Object.values(input.spec))check(typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)&&value>=0||Array.isArray(value)&&value.every(x=>typeof x==='string'),'invalid_spec','部品仕様の値が不正です。');
  const numeric=new Set(['biosRevision','minimumBiosRevision','maxMemoryGb','memorySlots','capacityGb','lengthMm','heightMm','slots','gpuMaxLengthMm','gpuMaxHeightMm','gpuMaxSlots','coolerMaxHeightMm','storagePorts','requiredLanes','gpuLanes','watts','estimatedWatts']);
  const lists=new Set(['supportedCpus','boardForms','sockets','storageInterfaces','storageForms','gpuConnectors','powerConnectors']);
  for(const [key,value] of Object.entries(input.spec)){if(numeric.has(key))check(typeof value==='number'&&Number.isFinite(value)&&value>=0,'invalid_spec',`${key}は非負の数値で指定してください。`);if(lists.has(key))check(Array.isArray(value),'invalid_spec',`${key}は一覧で指定してください。`);if(key==='sharedPortsVerified')check(typeof value==='boolean','invalid_spec','端子共有の確認状態は真偽値で指定してください。')}
  const source=text(input.source,'出典URL');check(/^https:\/\//.test(source),'invalid_source','HTTPSの出典を指定してください。');check(Number.isFinite(Date.parse(input.verifiedAt)),'invalid_date','確認日時を指定してください。');
  check(input.ports===undefined||Array.isArray(input.ports)&&input.ports.length<=32,'invalid_ports','端子は32件以内です。');
  const ports=input.ports?.map((port:any)=>{check(['input','output','bidirectional'].includes(port.direction),'invalid_port','端子の方向を指定してください。');return {id:text(port.id,'端子ID',100),protocol:text(port.protocol,'接続規格',100),direction:port.direction,capacity:integer(port.capacity,'接続可能数',1,32),required:port.required===true}});
  check(!ports||new Set(ports.map((p:any)=>p.id)).size===ports.length,'duplicate_port','端子IDが重複しています。');
  return {id:text(input.id,'部品ID',100),category:input.category,name:text(input.name,'部品名',200),spec:input.spec,source,verifiedAt:input.verifiedAt,...(ports?{ports}:{})};
}
export function validateBuild(input:any,catalog:Part[],owner:string,id:string,revision:number):Build {
  check(Array.isArray(input?.parts)&&input.parts.length<=32,'invalid_parts','部品を32件以内で指定してください。');
  const seen=new Set<string>(),counts=new Map<string,number>();
  const parts=input.parts.map((p:any)=>{const part=catalog.find(c=>c.id===p.id);check(part,'part_not_found','部品が見つかりません。');check(!seen.has(part.id),'duplicate_part','同じ部品は数量で指定してください。');seen.add(part.id);const quantity=integer(p.quantity,'数量',1,16);counts.set(part.category,(counts.get(part.category)||0)+quantity);return {id:part.id,quantity}});
  for(const category of ['cpu','gpu','motherboard','psu','case','cooler'])check((counts.get(category)||0)<=1,'quantity_constraint','このカテゴリは1個までです。');
  const positions:Build['positions']={};for(const [key,value] of Object.entries(input.positions||{})){check(seen.has(key),'invalid_position','未選択部品の座標です。');const p=value as any;check(Number.isFinite(p?.x)&&Number.isFinite(p?.y)&&p.x>=0&&p.y>=0&&p.x<=1200&&p.y<=1200,'invalid_position','座標を確認してください。');positions[key]={x:p.x,y:p.y}}
  check(input.connections===undefined||Array.isArray(input.connections)&&input.connections.length<=64,'invalid_connections','接続は64件以内です。');
  const connections:NonNullable<Build['connections']>=(input.connections||[]).map((connection:any)=>({id:text(connection.id,'接続ID',100),from:{partId:text(connection.from?.partId,'接続元部品',100),portId:text(connection.from?.portId,'接続元端子',100)},to:{partId:text(connection.to?.partId,'接続先部品',100),portId:text(connection.to?.portId,'接続先端子',100)},quantity:integer(connection.quantity,'接続数',1,32)}));
  check(new Set(connections.map(c=>c.id)).size===connections.length,'duplicate_connection','接続IDが重複しています。');
  const result:Build={id,owner,revision,title:text(input.title,'構成名',150),purpose:text(input.purpose||'general','用途',1000),budget:integer(input.budget||0,'予算'),parts,positions,public:input.public===true,...(input.connections!==undefined?{connections}:{})};
  const connectionErrors=evaluateBuild(result,catalog).results.filter(r=>(r.ruleId.startsWith('connection.')||r.ruleId.startsWith('port.'))&&r.status==='incompatible');
  check(!connectionErrors.length,'connection_invalid','接続規格・方向・使用数を確認してください。',409);
  return result;
}
