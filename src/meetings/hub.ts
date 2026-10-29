import { randomUUID } from 'node:crypto';

export interface MeetingPerson { id: string; userId: string; name: string }
interface Peer extends MeetingPerson { send: (value: unknown) => void }
interface Request { id: string; from: string; to: string; expires: number }
interface Grant extends Request { scope: string }
export interface MeetingRecordingConsent { id:string; owner:string; userId:string; mode:'video'|'audio'; model:string; automatic:boolean; language:string; participants:string[]; approved:string[]; active:boolean; expires:number }
export class MeetingHub {
  private endedRecordings=new Map<string,{room:string;userId:string;expires:number}>();
  private recordings = new Map<string,MeetingRecordingConsent>();
  private rooms = new Map<string, Map<string, Peer>>();
  private requests = new Map<string, { room: string; value: Request }>();
  private grants = new Map<string, { room: string; value: Grant }>();
  constructor(readonly limit = 6, private audit: (entry: Record<string, unknown>) => void = () => {}, private now = Date.now) {}
  peers(room: string) { return [...(this.rooms.get(room)?.values() || [])].map(({ id, userId, name }) => ({ id, userId, name })); }
  recordingPermission(room:string,peer:string,session:string,userId:string) {
    this.sweep();const entry=this.recordings.get(room);
    if(!entry?.active||entry.id!==session||entry.owner!==peer||entry.userId!==userId)throw new Error('全参加者が承認した録画申請が必要です。');
    return structuredClone(entry);
  }
  canUploadRecording(room:string,session:string,userId:string){this.sweep();const entry=this.recordings.get(room),ended=this.endedRecordings.get(session);return Boolean(entry?.id===session&&entry.active&&entry.userId===userId||ended?.room===room&&ended.userId===userId&&ended.expires>this.now());}
  private broadcast(room:string,value:unknown){for(const peer of this.rooms.get(room)?.values()||[])peer.send(value);}
  private endRecording(room:string,reason:string){const entry=this.recordings.get(room);if(!entry)return;this.recordings.delete(room);if(entry.active)this.endedRecordings.set(entry.id,{room,userId:entry.userId,expires:this.now()+30000});this.broadcast(room,{type:'recording-ended',id:entry.id,reason});this.event(room,'recording-ended',{session:entry.id,reason});}
  private send(room: string, id: string, value: unknown) { this.rooms.get(room)?.get(id)?.send(value); }
  private event(room: string, action: string, detail: Record<string, unknown>) { this.audit({ at: new Date(this.now()).toISOString(), room, action, ...detail }); }
  join(room: string, userId: string, name: string, send: Peer['send']) {
    const members = this.rooms.get(room) || new Map<string, Peer>();
    if (members.size >= this.limit) throw new Error('会議の参加人数が上限に達しました。');
    this.endRecording(room,'participants_changed');
    const peer: Peer = { id: randomUUID(), userId, name, send };
    this.rooms.set(room, members);members.set(peer.id, peer);
    send({ type: 'welcome', self: peer.id, peers: this.peers(room).filter(p => p.id !== peer.id) });
    for (const other of members.values()) if (other.id !== peer.id) other.send({ type: 'joined', peer: { id: peer.id, userId, name } });
    this.event(room, 'joined', { userId });return peer.id;
  }
  leave(room: string, id: string) {
    const peer = this.rooms.get(room)?.get(id);if (!peer) return;
    this.endRecording(room,'participants_changed');
    for (const [requestId, request] of [...this.requests]) if (request.room === room && [request.value.from,request.value.to].includes(id)) this.revoke(room,id,requestId,'disconnected');
    for (const [grantId, grant] of [...this.grants]) if (grant.room === room && [grant.value.from,grant.value.to].includes(id)) this.revoke(room,id,grantId,'disconnected');
    this.rooms.get(room)!.delete(id);
    for (const other of this.rooms.get(room)!.values()) other.send({ type: 'left', id });
    if (!this.rooms.get(room)!.size) this.rooms.delete(room);
    this.event(room,'left',{userId:peer.userId});
  }
  private revoke(room: string, actor: string, id: string, reason: string) {
    const entry = this.grants.get(id) || this.requests.get(id);
    if (!entry || entry.room !== room || ![entry.value.from,entry.value.to].includes(actor)) throw new Error('この操作許可は変更できません。');
    this.grants.delete(id);this.requests.delete(id);
    for (const peer of [entry.value.from,entry.value.to]) this.send(room,peer,{type:'control-ended',id,reason});
    this.event(room,'control-ended',{actor:this.rooms.get(room)?.get(actor)?.userId,reason});
  }
  sweep() {
    for(const [id,entry]of this.endedRecordings)if(entry.expires<=this.now())this.endedRecordings.delete(id);
    for(const [room,entry] of this.recordings)if(entry.expires<=this.now())this.endRecording(room,'expired');
    for(const [id,entry] of [...this.requests,...this.grants])if(entry.value.expires <= this.now())this.revoke(entry.room,entry.value.to,id,'expired');
  }
  message(room: string, id: string, message: any) {
    this.sweep();const peers=this.rooms.get(room),actor=peers?.get(id);if(!actor)throw new Error('会議に参加していません。');
    if(message?.type==='request-recording'){
      if(this.recordings.has(room))throw new Error('この会議は録画申請中または録画中です。');
      if(!['video','audio'].includes(message.mode)||typeof message.automatic!=='boolean'||typeof message.model!=='string'||message.model.length>256||!['auto','ja','zh','en'].includes(message.language))throw new Error('録画設定が不正です。');
      const entry:MeetingRecordingConsent={id:randomUUID(),owner:id,userId:actor.userId,mode:message.mode,model:message.model,automatic:message.automatic,language:message.language,participants:[...peers!.keys()],approved:[id],active:false,expires:this.now()+60000};
      this.recordings.set(room,entry);this.broadcast(room,{type:'recording-request',...entry,name:actor.name});
      this.activateRecording(room);return;
    }
    if(message?.type==='approve-recording'){
      const entry=this.recordings.get(room);if(!entry||entry.id!==message.id||!entry.participants.includes(id)||entry.active)throw new Error('有効な録画申請を確認してください。');
      if(!entry.approved.includes(id))entry.approved.push(id);this.activateRecording(room);return;
    }
    if(message?.type==='stop-recording'){const entry=this.recordings.get(room);if(!entry||entry.id!==message.id)throw new Error('有効な録画を選択してください。');this.endRecording(room,'revoked');return;}
    if(message?.type==='signal'){
      if(typeof message.to!=='string'||message.to===id||!peers!.has(message.to))throw new Error('同じ会議の相手を指定してください。');
      if(message.description){if(!['offer','answer'].includes(message.description.type)||typeof message.description.sdp!=='string'||message.description.sdp.length>64000)throw new Error('接続情報が不正です。');}
      else if(message.candidate){if(typeof message.candidate.candidate!=='string'||message.candidate.candidate.length>4096)throw new Error('候補情報が不正です。');}
      else throw new Error('接続情報がありません。');
      this.send(room,message.to,{type:'signal',from:id,...(message.description?{description:message.description}:{candidate:message.candidate})});return;
    }
    if(message?.type==='request-control'){
      if(message.to===id||!peers!.has(message.to))throw new Error('操作を申請する相手を選択してください。');
      if([...this.requests.values(),...this.grants.values()].some(e=>e.room===room&&[e.value.from,e.value.to].some(peer=>[id,message.to].includes(peer))))throw new Error('相手は別の操作申請または遠隔支援に対応中です。');
      const value={id:randomUUID(),from:id,to:message.to,expires:this.now()+30000};this.requests.set(value.id,{room,value});
      this.send(room,value.to,{type:'control-request',...value,name:actor.name});this.send(room,id,{type:'control-pending',...value});this.event(room,'control-request',{userId:actor.userId,target:peers!.get(value.to)!.userId});return;
    }
    if(message?.type==='approve-control'){
      const request=this.requests.get(message.id);if(!request||request.room!==room||request.value.to!==id)throw new Error('本人が有効な申請を承認してください。');
      if(typeof message.scope!=='string'||!message.scope.trim()||message.scope.length>200)throw new Error('共有対象を確認してください。');
      const value={...request.value,expires:this.now()+300000,scope:message.scope};this.requests.delete(value.id);this.grants.set(value.id,{room,value});
      for(const peer of [value.from,value.to])this.send(room,peer,{type:'control-granted',...value});
      this.event(room,'control-approved',{userId:actor.userId,controller:peers!.get(value.from)!.userId,scope:value.scope});return;
    }
    if(message?.type==='revoke-control'){this.revoke(room,id,message.id,'revoked');return;}
    throw new Error('会議メッセージの種類が不正です。');
  }
  private activateRecording(room:string){const entry=this.recordings.get(room);if(entry&&!entry.active&&entry.participants.every(id=>entry.approved.includes(id))){entry.active=true;entry.expires=this.now()+4*60*60*1000;this.broadcast(room,{type:'recording-ready',...entry});this.event(room,'recording-approved',{session:entry.id,participants:entry.participants.length});}}
}
