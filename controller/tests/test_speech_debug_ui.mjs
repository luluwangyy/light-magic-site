import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mountSpeechDebug} from '../web/speech-debug.mjs';

class Element{
 constructor(){this.value='';this.textContent='';this.children=[];this.disabled=false;this.hidden=false;this.listeners=new Map();}
 append(...items){this.children.push(...items);}replaceChildren(...items){this.children=items;}addEventListener(type,handler){this.listeners.set(type,handler);}
}
const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8'),nodes=new Map([...html.matchAll(/id="([^"]+)"/g)].map(match=>[match[1],new Element()]));
const el=id=>{assert(nodes.has(id),'Missing DOM id '+id);return nodes.get(id);};
globalThis.document={getElementById:el,createElement:()=>new Element()};
const state={owner:'browser',armed:true,config:{input_source:'camera'},speech:{ready:false,last_text:'',last_match:null,last_confidence:null},workflow:{revision:4,epoch:8,needs_practice:[{id:'speech_light',observed:false}],confirmed_target_ids:[]}};
const calls=[],notices=[];let debug;
function diagnosis(phrase,pending=null){
 const normalized=phrase.trim().toLowerCase();
 const match=normalized==='light'?{id:'speech_light',phrase:'light',cue_list:1,cue:'320',enabled:true}:
  normalized==='stand down'?{id:'speech_stand_down',phrase:'Stand down',cue_list:1,cue:'888',output_type:'channel_level',channel:9,level:0,enabled:true}:null;
 const target=match?.output_type==='channel_level'?{id:'channel_level:9:0',output_type:'channel_level',channel:9,level:0}:null;
 return {normalized,match,target,can_test:!!match,pending_test:pending,source_mode:'camera',microphone_ready:false,recognition_confirmed:false,last_text:'',last_confidence:null,revision:state.workflow.revision,epoch:state.workflow.epoch,blockers:match?['Speech input is not selected.','Start the microphone.','Recognize the phrase in Preview.']:['No exact saved phrase matched.'],test_blockers:match?[]:['Assign an enabled mapping.']};
}
async function api(action,payload={}){
 calls.push({action,payload});delete state.speech_debug;
 if(action==='speech_debug')state.speech_debug=diagnosis(payload.phrase);
 else if(action==='speech_debug_test'){state.armed=false;state.workflow.epoch++;state.workflow.confirmed_target_ids=[];const id=diagnosis(payload.phrase).target?.id||'cue:1:320';state.speech_debug=diagnosis(payload.phrase,{id,revision:state.workflow.revision,epoch:state.workflow.epoch});}
 else if(action==='confirm_target')state.workflow.confirmed_target_ids=[payload.id];
 else if(action==='claim')state.owner='browser';
 else throw Error('Unexpected API '+action);
 debug?.onState(state);return structuredClone(state);
}
debug=mountSpeechDebug({api,getState:()=>state,client:'browser',notify:(text,error)=>notices.push({text,error})});
await el('speechDebugCheck').onclick();assert.equal(calls.length,0,'blank phrase never sends any API request');assert(el('speechDebugSend').disabled);
el('speechDebugPhrase').value='unknown phrase';el('speechDebugPhrase').listeners.get('input')();await el('speechDebugCheck').onclick();assert.equal(calls.at(-1).action,'speech_debug');assert(el('speechDebugSend').disabled);assert.match(el('speechDebugResult').textContent,/No saved phrase/);
await el('speechDebugSend').onclick();assert.equal(calls.filter(call=>call.action==='speech_debug_test').length,0,'unknown phrase cannot fire through the button handler');
el('speechDebugPhrase').value='light';el('speechDebugPhrase').listeners.get('input')();let prevented=false;el('speechDebugPhrase').listeners.get('keydown')({key:'Enter',preventDefault(){prevented=true;}});
for(let i=0;i<10;i++)await Promise.resolve();assert(prevented);assert.equal(calls.filter(call=>call.action==='speech_debug_test').length,0,'Enter checks only and never fires a cue');
assert.match(el('speechDebugResult').textContent,/Cue 320/);assert.match(el('speechDebugDetails').textContent,/Camera only/);assert.match(el('speechDebugDetails').textContent,/Microphone is off/);assert(!el('speechDebugSend').disabled,'manual test can isolate console path while speech is off');
assert.equal(state.speech.last_match,null);assert.equal(state.workflow.needs_practice[0].observed,false,'typed lookup supplies no microphone evidence');
await el('speechDebugSend').onclick();assert.equal(calls.filter(call=>call.action==='speech_debug_test').length,1);assert.equal(state.armed,false,'explicit manual test pauses automatic output');assert(!el('speechDebugConfirm').hidden);assert(!el('speechDebugConfirm').disabled);
const sent=calls.find(call=>call.action==='speech_debug_test');assert.deepEqual(sent.payload,{phrase:'light',revision:4,epoch:8});
assert.equal(calls.filter(call=>call.action==='practice_confirm').length,0,'typed manual test never confirms recognition');
await el('speechDebugConfirm').onclick();assert.equal(calls.at(-1).action,'confirm_target');assert.deepEqual(calls.at(-1).payload,{id:'cue:1:320',revision:4,epoch:9,worked:true});assert(el('speechDebugConfirm').hidden);
await el('speechDebugCheck').onclick();await el('speechDebugSend').onclick();state.workflow.epoch++;debug.onState(state);assert(el('speechDebugConfirm').disabled,'changed output epoch invalidates physical test confirmation');
const count=calls.length;await el('speechDebugConfirm').onclick();assert.equal(calls.length,count,'stale confirmation button handler sends nothing');
el('speechDebugPhrase').value='other';el('speechDebugPhrase').listeners.get('input')();assert(el('speechDebugSend').disabled);assert(el('speechDebugConfirm').hidden,'editing text discards the old lookup and receipt controls');
el('speechDebugPhrase').value='Stand down';el('speechDebugPhrase').listeners.get('input')();
await el('speechDebugCheck').onclick();
assert.match(el('speechDebugResult').textContent,/Chan 9 @ 0/);
assert.equal(el('speechDebugSend').textContent,'Send matched level live');
await el('speechDebugSend').onclick();await el('speechDebugConfirm').onclick();
assert.equal(calls.at(-1).payload.id,'channel_level:9:0','the typed test confirms the level receipt');
assert.equal(calls.filter(call=>call.action==='practice_confirm').length,0);assert.equal(calls.filter(call=>call.action==='go_live').length,0,'debug never enables automatic output');
console.log('PASS: typed speech lookup, explicit cue and level tests, visible confirmation, stale receipts, and no typed recognition evidence. Mock APIs only.');
