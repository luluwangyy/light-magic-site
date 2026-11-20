import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mountChannelLevel} from '../web/channel-level-ui.mjs';

class Element{
 constructor(){this.value='';this.textContent='';this.disabled=false;this.hidden=false;this.open=false;this.listeners=new Map();}
 addEventListener(type,handler){this.listeners.set(type,handler);}
 showModal(){this.open=true;}
 close(){this.open=false;this.listeners.get('close')?.();}
}
const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
const nodes=new Map([...html.matchAll(/id="([^"]+)"/g)].map(match=>[match[1],new Element()]));
const el=id=>{assert(nodes.has(id),'Missing DOM element '+id);return nodes.get(id);};
globalThis.document={getElementById:el};

const workflow={active:true,state:'preview',revision:2,epoch:7,session_confirmed:true,
 identity:{host:'192.0.2.1',port:3032,version:'3.3',show_name:'Test show'}};
const state={token:'bridge',owner:'browser',armed:false,connected:true,verified:true,
 config:{dry_run:false},workflow,pending:[],cue_dispatch:{wait_s:0},channel_level_supported:true};
const calls=[];
const stagePreviews=[];
let pauseCount=0,openCount=0,dirty=false,write=async payload=>({channel_level:{channel:payload.channel,level:payload.level}});
const ui=mountChannelLevel({getState:()=>state,client:'browser',hasOperationalEdits:()=>dirty,
 pauseLocal:()=>{pauseCount++;},openSession:()=>{openCount++;},
 previewOnStage:target=>stagePreviews.push(target),
 api:async(action,payload)=>{calls.push({action,payload});return write(payload);}});
const review=()=>el('reviewChannelLevel').onclick(),send=()=>el('sendChannelLevel').onclick();
const dialog=el('channelLevelDialog'),status=()=>el('channelLevelStatus').textContent;
function enter(channel,level){
 el('manualChannel').value=channel;el('manualChannelLevel').value=level;
 el('manualChannelLevel').listeners.get('input')();
}

state.channel_level_supported=false;enter('9','30');
assert(el('reviewChannelLevel').disabled);assert.match(status(),/Restart Light Magic/);
state.channel_level_supported=true;ui.onState(state);

for(const [channel,level] of [['','30'],['1e1','30'],['1.5','30'],['0','30'],['100000','30'],
 ['9',''],['9','Full'],['9','-1'],['9','101']]){
 enter(channel,level);assert(el('reviewChannelLevel').disabled);review();assert(!dialog.open);
}
assert.equal(calls.length,0,'invalid values never contact the bridge');
enter('09','030.5');
assert.equal(el('channelLevelPreview').textContent,'Chan 9 @ 30.5');
review();assert(dialog.open);assert.equal(el('channelLevelCommand').textContent,'Chan 9 @ 30.5');
assert.match(el('channelLevelDestination').textContent,/192\.0\.2\.1.*Test show/);
assert.match(el('channelLevelDestination').textContent,/Pause stops new output.*level stays in effect/);
dialog.close();await send();assert.equal(calls.length,0,'review and Back send nothing');
review();await send();assert(!dialog.open);
assert.deepEqual(calls,[{action:'manual_channel_level',payload:{channel:9,level:30.5,confirmed:true,revision:2,epoch:7}}]);
assert.equal(pauseCount,1);
assert.match(status(),/written to Eos.*Verify the result/);

review();enter('10','0');assert(!dialog.open,'editing either input invalidates the exact reviewed command');
await send();assert.equal(calls.length,1);
for(const change of [()=>{workflow.epoch++;},()=>{workflow.revision++;},
 ()=>{state.token='new-bridge';},()=>{workflow.identity.show_path='new-show.esf3';}]){
 review();assert(dialog.open);change();ui.onState(state);assert(!dialog.open);await send();
 assert.equal(calls.length,1,'old session review cannot send');
}

for(const [block,restore] of [
 [()=>{state.armed=true;},()=>{state.armed=false;}],
 [()=>{state.config.dry_run=true;},()=>{state.config.dry_run=false;}],
 [()=>{workflow.rehearsal=true;},()=>{workflow.rehearsal=false;}],
 [()=>{state.rehearsal_only=true;},()=>{state.rehearsal_only=false;}],
 [()=>{state.owner='other-browser';},()=>{state.owner='browser';}],
 [()=>{state.pending=[{}];},()=>{state.pending=[];}],
 [()=>{dirty=true;},()=>{dirty=false;}]
]){
 block();ui.onState(state);assert(el('reviewChannelLevel').disabled);review();assert(!dialog.open);restore();
}
review();assert(dialog.open);
state.connected=false;ui.onState(state);
assert(!dialog.open&&el('reviewChannelLevel').disabled);
assert.match(status(),/Connect to Eos.*panel below/);assert(el('channelLevelSession').hidden);
state.connected=true;ui.onState(state);await send();assert.equal(calls.length,1,'reconnect requires a fresh review');
state.owner='other-browser';ui.onState(state);assert(!el('channelLevelSession').hidden);
el('channelLevelSession').onclick();assert.equal(openCount,1);state.owner='browser';ui.onState(state);

state.cue_dispatch.wait_s=.5;review();assert(dialog.open&&el('sendChannelLevel').disabled);
await send();assert.equal(calls.length,1,'console spacing blocks the explicit send');
state.cue_dispatch.wait_s=0;ui.onState(state);
assert(dialog.open&&!el('sendChannelLevel').disabled);
write=async()=>{throw Error('The Eos write timed out.');};await send();
assert.match(status(),/timed out.*Check Eos/);
assert.equal(calls.at(-1).payload.level,0,'zero is a valid level');
assert.equal(calls.length,2,'a failed write does not retry');

let finish;
write=payload=>new Promise(resolve=>{finish=()=>resolve({channel_level:{channel:payload.channel,level:payload.level}});});
review();const pending=send();await send();assert.equal(calls.length,3,'duplicate click while a write is pending sends once');
workflow.epoch++;ui.onState(state);finish();await pending;
assert.match(status(),/No write confirmation/);

enter('28','');
el('manualChannelZoom').value='0';
el('manualSetColor').checked=true;
el('manualChannelColor').value='#E07822';
el('manualSetColor').listeners.get('input')();
assert(el('reviewChannelLevel').disabled,'an older bridge cannot receive fixture parameters');
state.fixture_parameters_supported=true;
ui.onState(state);
assert.equal(el('channelLevelPreview').textContent,'Chan 28 · Zoom 0% · Color #e07822');
el('previewChannelOnStage').onclick();
assert.deepEqual(stagePreviews,[{output_type:'channel_level',channel:28,level:null,zoom:0,color:'#e07822'}]);
assert.equal(calls.length,3,'stage preview uses no API write');
review();assert(dialog.open);
el('manualChannelColor').value='#2266ff';
el('manualChannelColor').listeners.get('input')();
assert(!dialog.open,'changing a color invalidates the reviewed action');
write=async payload=>({channel_level:{channel:payload.channel,level:payload.level,zoom:payload.zoom,color:payload.color}});
review();await send();
assert.deepEqual(calls.at(-1).payload,{channel:28,level:null,zoom:0,color:'#2266ff',confirmed:true,revision:workflow.revision,epoch:workflow.epoch});
assert.match(status(),/written to Eos/);
console.log('PASS: fixture review, optional zoom and color, stage preview, explicit send, stale snapshots, and write acknowledgement. Mock API only.');
