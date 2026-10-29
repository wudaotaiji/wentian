import { MeetingHub } from './hub.js';
import { serviceKey, type WentianPluginDefinition } from '../plugin-kernel.js';
export const MEETINGS_SERVICE=serviceKey<{create:(limit:number,audit:(entry:Record<string,unknown>)=>void)=>MeetingHub}>('wentian.meetings/1');
export const meetingsPlugin:WentianPluginDefinition={id:'core.meetings',kind:'ui',version:'1.0.0',provides:[MEETINGS_SERVICE],setup(context){context.provide(MEETINGS_SERVICE,{create:(limit,audit)=>new MeetingHub(limit,audit)});}};
