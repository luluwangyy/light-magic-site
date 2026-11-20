import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mountWorkflow,isCurrentResponse} from '../web/workflow-ui.mjs';
import {mergeMappingDraft} from '../web/mapping-output.mjs';
class Element{
 constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.disabled=false;this.hidden=false;this.checked=false;this.open=false;this.value='';this.textContent='';this.listeners=new Map();this.classList={toggle(){}};}
 append(...items){this.children.push(...items);}replaceChildren(...items){this.children=items;}setAttribute(key,value){this[key]=value;}addEventListener(name,fn){this.listeners.set(name,fn);}showModal(){this.open=true;}close(){this.open=false;this.listeners.get('close')?.();}
}
const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
const nodes=new Map([...html.matchAll(/id="([^"]+)"/g)].map(match=>[match[1],new Element()]));
const el=id=>{assert(nodes.has(id),'Required DOM id '+id);return nodes.get(id);};
assert.equal([...html.matchAll(/id="([^"]+)"/g)].length,nodes.size,'all DOM IDs are unique');
for(const file of ['app.js','workflow-ui.mjs','custom-motions.mjs']){
 const source=readFileSync(new URL('../web/'+file,import.meta.url),'utf8');
 for(const match of source.matchAll(/\$\('([^']+)'\)/g))el(match[1]);
}
const nav=['session','cues','settings','learn','speech','advanced'].map(view=>{const n=new Element('button');n.dataset.view=view;return n;});
const panels=nav.map(button=>{const n=new Element();n.dataset.panel=button.dataset.view;return n;});
const brand=new Element('a');
globalThis.document={getElementById:el,createElement:tag=>new Element(tag),querySelectorAll:query=>query==='[data-view]'?nav:panels,querySelector:()=>brand};
globalThis.history={replaceState(){}};globalThis.location={hash:''};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
let camera=false,microphone=false,operational=false,pausedLocally=false,learning=false,practicing=false,ui;
let sessionDelay=null,liveDelay=null,liveReplyDelay=null,pauseDelay=null,cameraDelay=null,cameraStarts=0,microphoneStarts=0,resumes=0;
const calls=[],notices=[];
const w={active:false,state:'preview',reason:'Not started',revision:1,epoch:1,camera_ready:false,session_confirmed:false,identity:{host:'127.0.0.1',port:3032,version:'3.3',show_name:'Offline test show'},targets:[{id:'cue:1:888',cue_list:1,cue:'888',label:'Fist',sent:false,confirmed:false}],needs_practice:[{id:'motion_unused',label:'Inactive library motion',observed:false}],blockers:[{kind:'start_session',message:'Start session'}],next_action:'start_session',can_go_live:false};
const state={token:'offline-test',owner:null,armed:false,connected:false,verified:false,config:{host:'127.0.0.1',port:3032,mode:'cue'},workflow:w};
function update(){ui?.onState(state);}
async function api(action,payload={}){
 calls.push({action,payload:structuredClone(payload)});
 if(action==='session_start'){if(sessionDelay)await sessionDelay.promise;w.active=true;w.rehearsal=false;state.owner='browser-test';state.connected=true;state.verified=true;w.blockers=[{kind:'confirm_session',message:'Confirm console'}];w.next_action='confirm_session';}
 else if(action==='start_rehearsal'){w.active=true;w.rehearsal=true;w.state='preview';state.owner='browser-test';state.armed=false;state.connected=false;state.verified=false;w.session_confirmed=false;w.blockers=[{kind:'rehearsal',message:'No cues in rehearsal'}];w.next_action='rehearsal';}
 else if(action==='confirm_session'){assert.deepEqual(payload,{only_host:true,session_ok:true,revision:w.revision,epoch:w.epoch});w.session_confirmed=true;w.blockers=[{kind:'test_target',id:'cue:1:888',message:'Test cue'}];w.next_action='test_target';}
 else if(action==='test_target'){assert.equal(w.state==='live',false);const target=w.targets.find(row=>row.id===payload.id);assert(target);assert.deepEqual(payload,{id:target.id,revision:w.revision,epoch:w.epoch});target.sent=true;w.blockers=[{kind:'confirm_target',id:target.id,message:'Confirm result'}];w.next_action='confirm_target';}
 else if(action==='confirm_target'){assert.equal(payload.worked,true);assert.equal(payload.revision,w.revision);assert.equal(payload.epoch,w.epoch);w.targets.find(row=>row.id===payload.id).confirmed=true;w.blockers=[];w.next_action='go_live';w.can_go_live=true;}
 else if(action==='go_live'){
  if(liveDelay)await liveDelay.promise;
  if(payload.revision!==w.revision||payload.epoch!==w.epoch)throw Error('Stale Live request');
  assert(w.can_go_live);state.armed=true;w.state='live';w.epoch++;w.fresh_gesture_required=true;w.can_go_live=false;
 }
 else if(action==='pause'){if(pauseDelay)await pauseDelay.promise;state.armed=false;w.state='paused';w.epoch++;w.can_go_live=true;}
 else throw Error('Unexpected mock action '+action);
 update();if(action==='go_live'&&liveReplyDelay)await liveReplyDelay.promise;
 return structuredClone(state);
}
ui=mountWorkflow({api,getState:()=>state,client:'browser-test',isCameraRunning:()=>camera,
 startCamera:async()=>{cameraStarts++;if(cameraDelay)await cameraDelay.promise;camera=true;w.camera_ready=true;update();},
 isMicrophoneRunning:()=>microphone,startMicrophone:async()=>{microphoneStarts++;microphone=true;w.microphone_ready=true;update();},
 hasOperationalEdits:()=>operational,saveSettings:async()=>{operational=false;update();},pauseLocal:()=>{pausedLocally=true;},resumeLocal:()=>{resumes++;pausedLocally=false;},isLearning:()=>learning,isPracticing:()=>practicing,notify:(text,error)=>notices.push({text,error})});
update();assert.equal(calls.length,0,'loading and restoring the UI performs no start/test/live action');
await el('startSession').onclick();assert(camera);assert(w.active);assert(pausedLocally);assert.deepEqual(calls.map(c=>c.action),['session_start'],'Start only starts the session and camera callback');
await el('nextAction').onclick();assert(el('sessionConfirm').open);await el('confirmSession').onclick();assert.equal(w.session_confirmed,false,'only-laptop confirmation is explicit');
const staleConfirmations=[
 ()=>{w.identity.show_path='different-show.esf3';},
 ()=>{w.revision++;},
 ()=>{w.epoch++;},
 ()=>{state.token='replacement-bridge';}
];
for(const change of staleConfirmations){
 el('only_host').checked=true;change();update();
 assert(!el('sessionConfirm').open&&el('confirmSession').disabled&&!el('only_host').checked,'close stale console confirmation and clear its acknowledgement');
 assert.match(notices.at(-1).text,/Review the current identity/);
 const before=calls.length;await el('confirmSession').onclick();assert.equal(calls.length,before);
 await el('nextAction').onclick();assert(el('sessionConfirm').open&&!el('only_host').checked);
}
el('only_host').checked=true;await el('confirmSession').onclick();assert(w.session_confirmed);
const firstReadiness=el('readiness').children[0];for(let i=0;i<25;i++)update();assert.strictEqual(el('readiness').children[0],firstReadiness,'unchanged preview frames preserve readiness DOM/focus');
ui.openTarget('cue:1:888');assert.equal(calls.filter(c=>c.action==='test_target').length,0,'opening test dialog sends nothing');assert.equal(el('confirmTargetTest').hidden,true);
await el('sendTargetTest').onclick();assert.equal(w.targets[0].confirmed,false,'sending is not observing');assert.equal(el('confirmTargetTest').hidden,false);
el('targetTestDialog').close();ui.openTarget('cue:1:888');assert.equal(el('sendTargetTest').hidden,true,'a pending same-session test can be confirmed without resending');assert.equal(el('confirmTargetTest').hidden,false);assert.equal(calls.filter(c=>c.action==='test_target').length,1);
await el('confirmTargetTest').onclick();assert(w.targets[0].confirmed);assert.equal(el('arm').disabled,false,'inactive library practice does not block an otherwise ready session');
await el('arm').onclick();assert(state.armed);assert(!pausedLocally);assert.match(el('tracking').textContent,/neutral/);assert.match(notices.at(-1).text,/Hold a mapped gesture/);
await el('stop').onclick();assert(!state.armed);assert(pausedLocally);assert(camera,'Pause keeps camera ready');assert(state.connected,'Pause keeps console connected');assert.equal(el('arm').textContent,'Resume live');
const liveRaceStart=calls.length,oldEpoch=w.epoch;
liveDelay=deferred();const lateLive=el('arm').onclick();
assert(el('arm').disabled,'disable repeat activation while the Live request is in flight');
await el('arm').onclick();
await el('stop').onclick();liveDelay.resolve();await lateLive;liveDelay=null;
assert.deepEqual(calls.slice(liveRaceStart).map(call=>call.action),['go_live','pause']);
assert.deepEqual(calls[liveRaceStart].payload,{revision:w.revision,epoch:oldEpoch},'send the snapshot that authorized the Live click');
assert(!state.armed&&pausedLocally);assert.equal(resumes,1,'a cancelled Live completion cannot release local Pause');
liveReplyDelay=deferred();pauseDelay=deferred();
const liveReply=el('arm').onclick(),pauseReply=el('stop').onclick();
liveReplyDelay.resolve();await liveReply;liveReplyDelay=null;
assert(state.armed&&pausedLocally,'keep the local gate closed while the bridge still reports the previous Live state');
assert.equal(resumes,1);
pauseDelay.resolve();await pauseReply;pauseDelay=null;assert(!state.armed);
state.owner='another-browser';update();
assert(el('arm').disabled&&el('nextAction').hidden,'avoid offering impossible takeover while another tab owns the bridge');
assert.match(el('blockReason').textContent,/Another browser tab/);
assert(!el('stop').disabled,'Pause remains available even without ownership');
state.owner='browser-test';update();
operational=true;update();assert(el('arm').disabled,'operational drafts block live');await el('arm').onclick();assert(!state.armed);operational=false;update();
ui.openTarget('cue:1:888');w.revision++;w.epoch++;update();assert(el('sendTargetTest').disabled,'stale modal cannot test/confirm after operational change');assert(el('confirmTargetTest').hidden);
const beforeStaleTest=calls.length;await el('sendTargetTest').onclick();assert.equal(calls.length,beforeStaleTest);
el('targetTestDialog').close();
w.targets[0].confirmed=false;
w.targets.push({id:'cue:1:1000',cue_list:1,cue:'1000',label:'Open palm',sent:true,confirmed:false});
w.blockers=[{kind:'test_target',id:'cue:1:888'},{kind:'confirm_target',id:'cue:1:1000'}];w.next_action='test_target';update();
assert.equal(el('nextAction').textContent,'Confirm Cue 1000 result','confirm the pending cue before starting an unrelated live test');
await el('nextAction').onclick();assert.equal(el('targetTestTitle').textContent,'List 1 · Cue 1000');
assert(!el('confirmTargetTest').hidden&&el('sendTargetTest').hidden);
el('targetTestDialog').close();w.targets.pop();w.targets[0].confirmed=true;w.blockers=[];w.next_action='go_live';update();
assert(calls.filter(c=>c.action==='test_target').every(c=>c.payload.id==='cue:1:888'));
const beforeRehearsal=calls.length;
await el('startRehearsal').onclick();
assert(w.rehearsal);assert(!state.connected);assert.equal(el('state').textContent,'Rehearsal');
assert(el('arm').hidden&&el('arm').disabled,'rehearsal cannot go live even with old readiness');
assert(el('connect').disabled&&el('testConnection').disabled&&el('manualZoom').disabled,'rehearsal disables Advanced console actions');
assert(!el('startSession').hidden,'normal rehearsal can explicitly start a separate console session');
await el('arm').onclick();assert.throws(()=>ui.openTarget('cue:1:888'),/Rehearsal/);
assert.deepEqual(calls.slice(beforeRehearsal).map(c=>c.action),['start_rehearsal'],'rehearsal invokes neither connect, test, nor live');
state.rehearsal_only=true;update();assert(el('startSession').hidden&&el('startSession').disabled);
await el('startSession').onclick();assert.equal(calls.length,beforeRehearsal+1,'rehearsal-only mode cannot request a console session');
state.rehearsal_only=false;update();await el('startSession').onclick();assert(!w.rehearsal);assert(state.connected);
state.config.input_source='both';w.state='preview';w.active=false;w.camera_ready=false;camera=false;w.microphone_ready=false;microphone=false;update();
sessionDelay=deferred();const startsBeforePause=[cameraStarts,microphoneStarts];
const cancelledStart=el('startSession').onclick();assert(!el('stop').disabled,'allow Pause during initial session creation');
await el('stop').onclick();sessionDelay.resolve();await cancelledStart;sessionDelay=null;
assert.deepEqual([cameraStarts,microphoneStarts],startsBeforePause,'Pause during session creation prevents late permission prompts');
w.active=false;w.state='preview';update();cameraDelay=deferred();const combined=el('startSession').onclick();
await Promise.resolve();await Promise.resolve();
assert(microphone&&!camera,'combined startup opens microphone without waiting for camera');
cameraDelay.resolve();await combined;cameraDelay=null;
w.blockers=[{kind:'microphone',message:'The local speech model is warming up'}];w.next_action='microphone';w.can_go_live=false;update();
assert(el('nextAction').hidden,'warmup is a waiting state with the mic preview already visible');
assert.equal(el('blockReason').textContent,'The local speech model is warming up');
w.blockers=[];w.next_action='go_live';w.can_go_live=true;update();await el('arm').onclick();
assert.match(notices.at(-1).text,/Hold a mapped gesture.*fresh complete phrase/);
await el('stop').onclick();
ui.showView('cues');assert.equal(ui.getView(),'cues');assert(!panels.find(panel=>panel.dataset.panel==='cues').hidden);
state.owner=null;state.connected=false;state.verified=false;w.active=false;w.state='preview';w.session_confirmed=false;
camera=false;microphone=false;w.camera_ready=false;w.microphone_ready=false;
ui.showView('advanced');update();
const startsBeforeProgramming=[cameraStarts,microphoneStarts];
await el('programConsole').onclick();
assert(w.active&&state.connected,'Console can connect without starting a performance session');
assert.deepEqual([cameraStarts,microphoneStarts],startsBeforeProgramming,'direct programming never requests a camera or microphone');
assert.equal(el('programConsole').textContent,'Confirm console & show');
await el('programConsole').onclick();assert(el('sessionConfirm').open);
el('only_host').checked=true;await el('confirmSession').onclick();assert(w.session_confirmed&&el('programConsole').hidden);
const channelTarget={id:'channel_level:9:30',output_type:'channel_level',command:'Chan 9 @ 30',channel:9,level:30,sent:false,confirmed:false};
w.targets=[channelTarget];update();
ui.openTarget(channelTarget.id);
assert.equal(el('targetTestTitle').textContent,'Chan 9 @ 30');
assert.equal(el('sendTargetTest').textContent,'Send test level live');
assert.equal(channelTarget.sent,false,'opening a level test sends nothing');
await el('sendTargetTest').onclick();
assert(channelTarget.sent&&!channelTarget.confirmed);
await el('confirmTargetTest').onclick();assert(channelTarget.confirmed);
const lookTarget={id:'saved-look',output_type:'channel_look',channels:[{channel:7,level:0},{channel:28,zoom:0,color:'#e07822'}]};
w.targets=[lookTarget];update();
const beforeLookReview=calls.length;
ui.openTarget(lookTarget.id);
assert.equal(calls.length,beforeLookReview,'reviewing a channel look sends no commands');
assert.equal(el('targetTestLook').hidden,false);
assert.deepEqual(el('targetTestLookChannels').children.map(item=>item.textContent),['Chan 7 @ 0','Chan 28 · Zoom 0% · Color #e07822']);
await el('sendTargetTest').onclick();assert(lookTarget.sent);
await el('confirmTargetTest').onclick();assert(lookTarget.confirmed);
const response=(revision,epoch,token='bridge')=>({token,workflow:{revision,epoch}});
assert(!isCurrentResponse(response(3,8),response(3,7)),'old in-flight frame cannot overwrite Pause epoch');
assert(!isCurrentResponse(response(3,8),response(2,99)),'old in-flight response cannot overwrite saved revision');
assert(isCurrentResponse(response(3,8),response(4,9)));assert(isCurrentResponse(response(3,8),response(1,1,'new-bridge')),'bridge restart accepts new token');
const app=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const scalar=JSON.parse(app.match(/const scalar=(\[[^;]+\]);/)[1].replaceAll("'",'"'));
const numeric=JSON.parse(app.match(/const numeric=(\[[^;]+\]);/)[1].replaceAll("'",'"'));
const baseline={mode:'cue',notes:'Saved note',close:.1,far:.9,mappings:[{gesture:'Closed_Fist',label:'Fist',cue:'888'}]};
for(const id of scalar){const input=el(id);input.type=['dry_run','reverse'].includes(id)?'checkbox':'text';input.value=baseline[id]??'';}
el('notes').value='My unsaved note';
const row=new Element('tr');row.dataset.gesture='Closed_Fist';const labelInput=new Element('input');labelInput.type='text';labelInput.dataset.field='label';labelInput.value='Fist';const cueInput=new Element('input');cueInput.type='text';cueInput.dataset.field='cue';cueInput.value='888';row.querySelectorAll=()=>[labelInput,cueInput];el('mappings').children=[row];
const currentConfig={...baseline,mode:'motion',close:.2,mappings:[{gesture:'Closed_Fist',label:'Fist',cue:'1000'}]};
const gatherSource=app.slice(app.indexOf('function gather(){'),app.indexOf('function ensureApplied(){'));
const gathered=Function('$','state','cal','scalar','numeric','formBaseline','speech','mergeMappingDraft',gatherSource+';return gather();')(el,{config:currentConfig},{close:.1,far:.9},scalar,numeric,baseline,null,mergeMappingDraft);
assert.equal(gathered.mode,'motion','metadata draft save retains a newly selected learned mode');assert.equal(gathered.mappings[0].cue,'1000','unchanged stale form cue cannot revert a newer mapping');assert.equal(gathered.notes,'My unsaved note');assert.equal(gathered.close,.2,'unchanged form calibration cannot revert newer settings');
console.log('PASS: combined startup and cancellation, explicit confirmation, stable readiness, pending cue priority, stale-modal invalidation, ownership and Live/Pause races. Mock API only.');
