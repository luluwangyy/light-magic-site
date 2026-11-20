import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Pcm16Chunks,createSpeechSender} from '../web/speech-audio.mjs';
import {mountSpeech,DEFAULT_PHRASES} from '../web/speech.mjs';
import {mountWorkflow} from '../web/workflow-ui.mjs';

const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
let CaptureProcessor;
globalThis.AudioWorkletProcessor=class{
 constructor(){
  this.packets=[];
  this.port={postMessage:(packet,transfer)=>this.packets.push(structuredClone(packet,{transfer}))};
 }
};
globalThis.registerProcessor=(name,processor)=>{assert.equal(name,'local-speech-capture');CaptureProcessor=processor;};
await import('../web/speech-worklet.mjs');
for(const rate of [16000,44100,48000]){
 globalThis.sampleRate=rate;
 const worklet=new CaptureProcessor({processorOptions:{packetMs:100}});
 worklet.port.onmessage({data:{type:'reset',generation:1}});
 const audio=Float32Array.from({length:rate},(_,i)=>Math.sin(i*2*Math.PI*440/rate)*.5);
 for(let i=0;i<audio.length;i+=128){
  globalThis.currentTime=i/rate;
  worklet.process([[audio.subarray(i,i+128)]],[]);
 }
 const {packets}=worklet;
 assert.equal(packets.length,10,'one second produces ten 100 ms PCM packets');
 assert(packets[0].capturedAt>=.1&&packets[0].capturedAt<.1+128/rate,'first packet is available at 100 ms plus at most one audio block');
 assert(packets.every(packet=>packet.pcm.byteLength===3200));
 assert(packets.every(packet=>packet.rms>.34&&packet.rms<.36),'resampling preserves speech-band level');
}
const fallbackWorklet=new CaptureProcessor();
fallbackWorklet.port.onmessage({data:{type:'reset',generation:1}});
const halfPacket=new Float32Array(4800);
fallbackWorklet.process([[halfPacket]],[]);assert.equal(fallbackWorklet.packets.length,0);
fallbackWorklet.process([[halfPacket]],[]);assert.equal(fallbackWorklet.packets[0].pcm.byteLength,6400,'older bridge keeps 200 ms fallback packets');
const resetPcm=new Pcm16Chunks(48000,16000,1600);assert.equal(resetPcm.push(new Float32Array(2400).fill(.9)).length,0);resetPcm.reset();
const cleared=resetPcm.push(new Float32Array(4800))[0];assert([...new Int16Array(cleared.pcm)].every(value=>value===0),'epoch reset discards all older samples');
const clipped=new Pcm16Chunks(16000,16000,3).push(new Float32Array([-2,2,NaN]))[0];assert.deepEqual([...new Int16Array(clipped.pcm)],[-32768,32767,0]);

let request=deferred(),generation=1,expireBefore=0;const sent=[],failures=[];
const sender=createSpeechSender({api:async(action,payload)=>{sent.push({action,payload});return request.promise;},isCurrent:packet=>packet.generation===generation,isFresh:chunk=>chunk.sequence>expireBefore,onFailure:error=>failures.push(error)});
const capture={generation:1,streamId:'one',revision:3,epoch:7},chunk={sequence:1,pcm:new Int16Array(1600).buffer};
const first=sender(chunk,capture),second=sender({...chunk,sequence:2},capture),third=sender({...chunk,sequence:3},capture);
assert.equal(sent.length,1);
assert.equal(sent[0].action,'speech_audio');assert.equal(Buffer.from(sent[0].payload.pcm,'base64').length,3200);assert(!('text' in sent[0].payload));
generation=2;request.reject(Error('old request'));await first;assert.equal(failures.length,0,'stale failed audio cannot tear down a newer epoch');
assert.equal(await second,false,'an old generation cannot drain after a pause or edit');
assert.equal(await third,false);
assert.equal(await sender(chunk,capture),false,'stale worklet generation never reaches API');
const currentCapture={...capture,generation};
request=deferred();
const fresh=sender({...chunk,sequence:4},currentCapture);
const burst=[5,6,7,8].map(sequence=>sender({...chunk,sequence},currentCapture));
request.resolve();
assert.deepEqual(await Promise.all([fresh,...burst]),[true,true,true,true,true],'four queued packets survive a brief render stall in order');
request=deferred();
const slow=sender({...chunk,sequence:9},currentCapture);
const overflow=[10,11,12,13,14].map(sequence=>sender({...chunk,sequence},currentCapture));
assert.equal(await overflow[0],false,'the audio queue stays bounded');
expireBefore=13;request.resolve();
assert(await slow);
assert.deepEqual(await Promise.all(overflow),[false,false,false,false,true],'age is checked again at dispatch');
assert.deepEqual(sent.map(call=>call.payload.sequence),[1,4,5,6,7,8,9,14],'fresh packets stay in order and dropped packets keep their original sequence numbers');

class Element {
 constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.disabled=false;this.hidden=false;this.checked=false;this.open=false;this.value='';this.textContent='';this.listeners=new Map();this.classList={toggle(){}};}
 append(...items){this.children.push(...items);}replaceChildren(...items){this.children=items;}setAttribute(key,value){this[key]=value;}getAttribute(key){return this[key];}addEventListener(name,fn){this.listeners.set(name,fn);}showModal(){this.open=true;}close(){this.open=false;this.listeners.get('close')?.();}
 get options(){return this.children;}
 querySelector(selector){if(selector==='button')return this.children.flatMap(item=>item.children).find(item=>item.tagName==='BUTTON');if(selector==='[data-speech-status]')return this.children.find(item=>'speechStatus' in item.dataset);return null;}
 querySelectorAll(selector){return selector==='[data-field]'?this.children.flatMap(item=>item.children).filter(item=>item.dataset.field):[];}
}
const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
const nodes=new Map([...html.matchAll(/id="([^"]+)"/g)].map(match=>[match[1],new Element()]));
const el=id=>{assert(nodes.has(id),'DOM id '+id);return nodes.get(id);};
const documentListeners=new Map(),windowListeners=new Map();
const nav=['session','settings','learn','speech','advanced'].map(view=>{const node=new Element('button');node.dataset.view=view;return node;});
const panels=nav.map(button=>{const node=new Element();node.dataset.panel=button.dataset.view;return node;});
globalThis.document={hidden:false,getElementById:el,createElement:tag=>new Element(tag),addEventListener:(name,fn)=>documentListeners.set(name,fn),querySelectorAll:query=>query==='[data-view]'?nav:panels,querySelector:()=>new Element('a')};
globalThis.history={replaceState(){}};globalThis.location={hash:''};
globalThis.Option=class extends Element{constructor(label,value){super('option');this.textContent=label;this.value=value;}};
let stoppedTracks=0;const activeStreams=[];
const mediaStream=()=>{const track={readyState:'live',stop(){stoppedTracks++;this.readyState='ended';},addEventListener(){}};const stream={getTracks:()=>[track],getAudioTracks:()=>[track]};activeStreams.push(stream);return stream;};
let permission=()=>Promise.resolve(mediaStream());
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:()=>permission(),enumerateDevices:async()=>[{kind:'audioinput',deviceId:'mic',label:'Lab microphone'}]}}});
const graphNodes=[];
class GraphNode{connect(){}disconnect(){}}
class FakeWorklet extends GraphNode{constructor(context,name,options){super();this.options=options;this.port={postMessage:message=>{this.lastReset=message;},onmessage:null};graphNodes.push(this);}}
class Context {
 constructor(){this.state='running';this.currentTime=1;this.audioWorklet={addModule:async()=>{}};this.destination={};}
 async resume(){}async close(){this.state='closed';}createMediaStreamSource(){return new GraphNode();}createGain(){const node=new GraphNode();node.gain={value:1};return node;}
}
globalThis.window={AudioContext:Context,AudioWorkletNode:FakeWorklet,addEventListener:(name,fn)=>windowListeners.set(name,fn)};globalThis.AudioWorkletNode=FakeWorklet;
const state={token:'bridge',owner:'browser',armed:false,verified:false,connected:false,config:{input_source:'speech',microphone_id:'',speech_mappings:structuredClone(DEFAULT_PHRASES),mode:'cue'},speech:{ready:false,stream_id:null},workflow:{revision:1,epoch:1,active:false,state:'preview',targets:[],needs_practice:[],blockers:[],identity:{}}};
let speech,outputBlocked=false;const calls=[],notices=[],openedTargets=[];
async function api(action,payload={}){
 calls.push({action,payload});
 if(action==='speech_start'){state.workflow.epoch++;state.speech={ready:true,stream_id:'stream-'+calls.length,audio_packet_ms:100};}
 if(action==='speech_stop'&&payload.stream_id===state.speech.stream_id){state.speech.ready=false;state.speech.stream_id=null;state.workflow.epoch++;}
 if(action==='claim')state.owner='browser';
 if(action==='practice_confirm')state.workflow.needs_practice=state.workflow.needs_practice.filter(item=>item.id!==payload.id);
 speech?.onState(state);return structuredClone(state);
}
speech=mountSpeech({api,getState:()=>state,client:'browser',notify:(text,error)=>notices.push({text,error}),onEdited(){},saveSettings(){},openTarget:id=>openedTargets.push(id),hasOutputBlock:()=>outputBlocked,setInputSource:async input=>{state.config.input_source=input;state.armed=false;state.workflow.epoch++;speech.onState(state);}});
speech.fillConfig(state.config);assert.equal(el('speechMappings').children.length,5);assert.equal(calls.length,0,'loading speech UI never opens microphone');
assert.deepEqual(speech.gatherMappings(),DEFAULT_PHRASES);assert(el('speechMappings').children.every(row=>row.querySelector('[data-speech-status]').textContent==='Unassigned'));
{
 const original=structuredClone(state);
 state.speech_aliases={speech_light:['white lights'],speech_abracadabra:['magic shift'],speech_pass:['shield up']};
 const first=state.config.speech_mappings[0],second=state.config.speech_mappings[1],third=state.config.speech_mappings[2];
 Object.assign(second,{enabled:true});Object.assign(third,{cue:'2',enabled:false});
 speech.fillConfig(state.config);
 const note=el('speechMappings').children[0].children[1].children[1];
 assert.equal(note.textContent,'Also say “white lights”');assert(!note.hidden);
 assert(!el('speechShortCommandSetup').hidden,'setup help appears when no alternate has an enabled output');
 assert(el('speechShortCommandList').hidden,'unassigned and disabled commands are omitted from Speech');
 Object.assign(first,{enabled:true,cue:'1'});speech.onState(state);
 const list=el('speechShortCommandList');
 assert(!list.hidden);assert.equal(list.children.length,1);
 assert.deepEqual(list.children[0].children.map(child=>child.textContent),['“white lights”',first.phrase]);
 assert(el('speechShortCommandSetup').hidden);
 assert.equal(calls.length,0,'displaying aliases does not contact the controller');
 delete state.speech_aliases;
 Object.assign(state,original);speech.fillConfig(state.config);
 assert(el('speechShortCommands').hidden);
}
{
 const original=structuredClone(state),row=el('speechMappings').children[0];
 const fields=Object.fromEntries(row.querySelectorAll('[data-field]').map(field=>[field.dataset.field,field]));
 const descendant=(root,match)=>root.children.find(match)||root.children.map(child=>descendant(child,match)).find(Boolean);
 const add=descendant(row,element=>element.textContent==='Add channel');
 const rows=descendant(row,element=>element.className==='channel-look-rows');
 const lookField=(index,key)=>descendant(rows.children[index],element=>element.dataset.lookField===key);
 fields.output_type.value='channel_look';fields.output_type.listeners.get('input')();
 fields.enabled.checked=true;
 add.onclick();lookField(0,'channel').value='28';lookField(0,'zoom').value='0';
 add.onclick();lookField(1,'channel').value='28';lookField(1,'level').value='0';
 assert.throws(()=>speech.gatherMappings(),/appears twice/,'duplicates cannot be sent');
 lookField(1,'channel').value='7';
 const expected=[{channel:7,level:0},{channel:28,zoom:0}];
 assert.deepEqual(speech.gatherMappings()[0].channels,expected,'zero settings remain explicit and rows save in channel order');
 add.onclick();
 assert.deepEqual(speech.gatherMappings()[0].channels,expected,'an untouched empty row does not change the output');
 state.config.speech_mappings=speech.gatherMappings();
 state.verified=true;Object.assign(state.workflow,{active:true,session_confirmed:true,targets:[
  {id:'different-width',output_type:'channel_look',channels:[{channel:7,level:0},{channel:28,zoom:10}]},
  {id:'saved-look',output_type:'channel_look',channels:[...expected].reverse()}
 ]});
 speech.fillConfig(state.config);
 const savedRow=el('speechMappings').children[0],test=savedRow.children.at(-1).children[0];
 assert.equal(test.textContent,'Test look live');assert(!test.disabled);
 await test.onclick();assert.equal(openedTargets.pop(),'saved-look','the live test uses the exact saved look');
 Object.assign(state,original);speech.fillConfig(state.config);
}
{
 const row=el('speechMappings').children[0];
 const fields=Object.fromEntries(row.querySelectorAll('[data-field]').map(field=>[field.dataset.field,field]));
 const select=value=>{fields.output_type.value=value;fields.output_type.listeners.get('input')();};
 assert(!fields.cue.hidden&&fields.level.hidden,'legacy mappings start with the cue fields visible');
 fields.enabled.checked=true;fields.cue.value='999';select('channel_level');
 assert(fields.cue.hidden&&!fields.channel.hidden&&!fields.level.hidden);
 assert.equal(speech.gatherMappings()[0].level,undefined,'an untouched blank level stays unassigned');
 fields.channel.value='9';fields.level.value='0';
 assert.deepEqual(speech.gatherMappings()[0],{...DEFAULT_PHRASES[0],enabled:true,cue:'999',output_type:'channel_level',channel:9,level:0});
 select('cue');assert.equal(fields.cue.value,'999','switching back restores the cue draft');
 assert.equal(speech.gatherMappings()[0].level,0,'switching retains the hidden level draft');
 select('channel_level');
 const original=structuredClone(state);
 state.config.speech_mappings=speech.gatherMappings();
 state.verified=true;Object.assign(state.workflow,{active:true,session_confirmed:true,
  targets:[{id:'channel_level:9:0.0',output_type:'channel_level',channel:9,level:0,confirmed:true}]});
 state.speech.last_match=DEFAULT_PHRASES[0].id;speech.fillConfig(state.config);
 const savedRow=el('speechMappings').children[0],test=savedRow.querySelector('button');
 assert.match(el('speechMatch').textContent,/Chan 9 @ 0/);assert.equal(test.textContent,'Test level live');assert(!test.disabled);
 await test.onclick();assert.deepEqual(openedTargets,['channel_level:9:0.0'],'test uses the bridge target ID');
 const laterConfig=structuredClone(state.config),blankConfig=structuredClone(state.config);
 Object.assign(blankConfig.speech_mappings[0],{channel:'',level:null});
 speech.fillConfig(blankConfig);
 assert.equal(speech.gatherMappings(laterConfig)[0].channel,9,'an untouched blank field cannot overwrite a newer saved channel');
 assert.equal(speech.gatherMappings(laterConfig)[0].level,0,'an untouched blank level cannot overwrite a newer saved zero');
 Object.assign(state,original);speech.fillConfig(state.config);
}
{
 const original=structuredClone(state),row=el('speechMappings').children[0];
 const fields=Object.fromEntries(row.querySelectorAll('[data-field]').map(field=>[field.dataset.field,field]));
 fields.output_type.value='channel_level';fields.output_type.listeners.get('input')();
 assert(!fields.zoom.hidden&&!fields.color.hidden);
 fields.enabled.checked=true;fields.channel.value='28';fields.zoom.value='0';
 const picker=row.children.flatMap(cell=>cell.children).find(input=>input.type==='color');
 picker.value='#E07822';picker.listeners.get('input')();
 state.config.speech_mappings=speech.gatherMappings();
 const mapped=state.config.speech_mappings[0];
 assert.equal(mapped.zoom,0);assert.equal(mapped.color,'#e07822');assert.equal(mapped.level,undefined);
 state.verified=true;
 Object.assign(state.workflow,{active:true,session_confirmed:true,targets:[
  {id:'other-color',output_type:'channel_level',channel:28,zoom:0,color:'#ee3300',confirmed:true},
  {id:'other-zoom',output_type:'channel_level',channel:28,zoom:30,color:'#e07822',confirmed:true},
  {id:'saved-fixture',output_type:'channel_level',channel:28,zoom:0,color:'#e07822',confirmed:true}
 ]});
 state.speech.last_match=mapped.id;speech.fillConfig(state.config);
 const savedRow=el('speechMappings').children[0],test=savedRow.querySelector('button');
 assert.match(el('speechMatch').textContent,/Chan 28 · Zoom 0% · Color #e07822/);
 assert.equal(test.textContent,'Test fixture live');assert(!test.disabled);
 await test.onclick();assert.equal(openedTargets.at(-1),'saved-fixture');
 const savedFields=Object.fromEntries(savedRow.querySelectorAll('[data-field]').map(field=>[field.dataset.field,field]));
 savedFields.color.value='';
 assert.equal(speech.gatherMappings()[0].color,null,'clearing color omits the parameter on the next send');
 assert.equal(speech.gatherMappings()[0].zoom,0,'clearing color preserves a zoom of zero');
 Object.assign(state,original);speech.fillConfig(state.config);
}
assert.equal(speech.gatherBackend(),'auto');
state.config.speech_backend='vosk';assert.equal(speech.gatherBackend(),'vosk','an unchanged engine selector cannot revert a newer saved preference');
el('speechBackend').value='enhanced';assert.equal(speech.gatherBackend(),'enhanced');el('speechBackend').value='auto';delete state.config.speech_backend;
await speech.start();assert(speech.isRunning());const worklet=graphNodes.at(-1),oldGeneration=worklet.lastReset.generation;
assert.equal(worklet.options.processorOptions.packetMs,100,'capture uses the bridge worker packet duration');
{
 const originalSpeech=structuredClone(state.speech),originalMapping={...state.config.speech_mappings[0]};
 Object.assign(state.config.speech_mappings[0],{cue:'1',enabled:true});
 state.speech_aliases={speech_light:['white lights']};
 Object.assign(state.speech,{last_text:'white rights',last_outcome:'No complete phrase matched'});speech.onState(state);
 assert.equal(el('speechTranscript').textContent,'white rights','transcript is the text the recognizer actually heard');
 assert.match(el('speechMatch').textContent,/Try a short command below/);
 state.speech.last_match='speech_light';state.speech.last_text='white lights';state.speech.last_outcome='Matched';speech.onState(state);
 assert.equal(el('speechTranscript').textContent,'white lights');
 assert.equal(el('speechMatch').textContent,'Matched','recognized alternate has no miss suggestion');
 state.speech=originalSpeech;state.config.speech_mappings[0]=originalMapping;delete state.speech_aliases;speech.onState(state);
}
const micPacket={pcm:new Int16Array(1600).buffer,rms:.1,capturedAt:.99};
worklet.port.onmessage({data:{...micPacket,generation:oldGeneration,sequence:1,capturedAt:.5}});await flush();
assert.equal(calls.filter(call=>call.action==='speech_audio').length,0,'old audio is dropped after a main-thread stall');
worklet.port.onmessage({data:{...micPacket,generation:oldGeneration,sequence:2,capturedAt:.7}});await flush();
assert.equal(calls.filter(call=>call.action==='speech_audio').length,1,'audio survives a 300 ms camera stall');
assert.equal(el('showSpeechPreviewLevel').value,el('speechLevel').value,'Session and Speech show the same microphone signal');
state.armed=true;outputBlocked=true;worklet.port.onmessage({data:{...micPacket,generation:oldGeneration,sequence:3}});await flush();assert.equal(calls.filter(call=>call.action==='speech_audio').length,1,'operational draft blocks live audio before Pause response');state.armed=false;outputBlocked=false;
state.workflow.epoch++;speech.onState(state);const currentGeneration=worklet.lastReset.generation;assert(currentGeneration>oldGeneration);
worklet.port.onmessage({data:{...micPacket,generation:oldGeneration,sequence:4}});await flush();assert.equal(calls.filter(call=>call.action==='speech_audio').length,1,'queued old generation dropped');
worklet.port.onmessage({data:{...micPacket,generation:currentGeneration,sequence:5,rms:0}});await flush();assert.equal(calls.filter(call=>call.action==='speech_audio').at(-1).payload.epoch,state.workflow.epoch);
await speech.stop();assert(!speech.isRunning());assert(stoppedTracks>=1);assert.equal(worklet.port.onmessage,null);
permission=()=>pendingPermission.promise;const pendingPermission=deferred(),opening=speech.start();await flush();await speech.stop();await assert.rejects(opening,/cancelled/);const beforeLate=stoppedTracks;pendingPermission.resolve(mediaStream());await flush();assert(stoppedTracks>beforeLate,'late permission after cancellation releases microphone');
permission=()=>Promise.resolve(mediaStream());await speech.start();assert(speech.isRunning());state.speech.ready=false;speech.onState(state);await flush();assert(!speech.isRunning(),'server decoder failure releases local capture and permits retry');await speech.start();assert(speech.isRunning(),'a failed server recognizer does not block a fresh Start');state.token='new-bridge';speech.onState(state);await flush();assert(!speech.isRunning(),'bridge restart closes old capture without recursion');
state.config.input_source='camera';state.armed=true;speech.onState(state);assert(!el('speechUseBoth').hidden);assert.match(el('speechInputWarning').textContent,/input source is Camera/);
await el('speechUseBoth').onclick();assert.equal(state.config.input_source,'both');assert(!state.armed,'enabling speech pauses output');assert(speech.isRunning());assert.equal(calls.filter(call=>call.action==='go_live').length,0,'enabling speech never goes live automatically');
state.speech.last_match='speech_light';state.workflow.needs_practice=[{id:'speech_light',observed:false}];speech.onState(state);assert(el('speechConfirmPractice').disabled,'recognized text without current evidence cannot confirm');
state.workflow.needs_practice[0].observed=true;speech.onState(state);assert(!el('speechConfirmPractice').disabled);await el('speechConfirmPractice').onclick();assert.equal(calls.at(-1).action,'practice_confirm');assert.deepEqual(calls.at(-1).payload,{id:'speech_light',observed:true,revision:state.workflow.revision,epoch:state.workflow.epoch});
assert(el('speechConfirmPractice').disabled);await speech.stop();

let cameraStarts=0,microphoneStarts=0,liveCalls=0,workflow;
state.token='new-bridge';state.owner='browser';state.config.input_source='speech';state.workflow={...state.workflow,active:false,can_go_live:false,camera_ready:false,microphone_ready:false,blockers:[],next_action:'start_session'};
const workflowApi=async(action)=>{if(action==='session_start'){state.workflow.active=true;state.workflow.next_action='settings';}if(action==='go_live'){liveCalls++;state.armed=true;state.workflow.state='live';}workflow.onState(state);return structuredClone(state);};
workflow=mountWorkflow({api:workflowApi,getState:()=>state,client:'browser',isCameraRunning:()=>false,startCamera:async()=>cameraStarts++,isMicrophoneRunning:()=>microphoneStarts>0,startMicrophone:async()=>{microphoneStarts++;state.workflow.microphone_ready=true;},setInputSource:async input=>{state.config.input_source=input;},hasOperationalEdits:()=>false,saveSettings(){},pauseLocal(){},resumeLocal(){},isLearning:()=>false,isPracticing:()=>false,notify:(text,error)=>notices.push({text,error})});
workflow.onState(state);await el('startSession').onclick();assert.equal(cameraStarts,0,'speech-only Start never requests the camera');assert.equal(microphoneStarts,1);
state.workflow.can_go_live=true;state.workflow.blockers=[];state.workflow.next_action='go_live';state.verified=true;state.connected=true;state.workflow.session_confirmed=true;workflow.onState(state);assert(!el('arm').disabled,'speech-only readiness does not require camera');await el('arm').onclick();assert.equal(liveCalls,1);assert.match(notices.at(-1).text,/fresh complete phrase/);
state.config.input_source='both';state.workflow.state='paused';state.armed=false;workflow.onState(state);assert(el('arm').disabled,'combined input still requires camera');

console.log('PASS: local PCM framing/resampling, generation resets, bounded fresh packet handoff, late permission cleanup, microphone lifecycle, bridge restart, unassigned mappings, and speech-only startup/live without camera. No real microphone or network used.');
