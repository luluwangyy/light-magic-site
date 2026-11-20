// Offline integration checks. This fake DOM and bridge never open a camera or socket.
import assert from 'node:assert/strict';
import {mountCustomMotions} from '../web/custom-motions.mjs';
import {createMotionTemplate,extractMotionFrame} from '../web/motion-learning.mjs';

let now=1000;
Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>now}});
const copy=value=>JSON.parse(JSON.stringify(value));
class Element {
 constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.checked=false;this.disabled=false;this.hidden=false;this.textContent='';this._value='';this.classList={toggle(){}};this.listeners=new Map();}
 get value(){return this._value;}set value(value){this._value=String(value);}
 append(...children){this.children.push(...children);}
 replaceChildren(...children){this.children=[...children];}
 setAttribute(name,value){this[name]=value;}
 addEventListener(name,fn){this.listeners.set(name,fn);}
 focus(){}
 querySelectorAll(selector){
  const matches=node=>selector.split(',').some(part=>part.startsWith('[data-')?Object.hasOwn(node.dataset,part.slice(6,-1).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())):node.tagName===part.toUpperCase());
  const found=[];for(const child of this.children){if(matches(child))found.push(child);found.push(...child.querySelectorAll(selector));}return found;
 }
}
globalThis.Option=class extends Element{constructor(text,value){super('option');this.textContent=text;this.value=value;}};
function world(){
 const points=Array.from({length:21},()=>({x:0,y:0,z:0}));
 for(const[index,x]of[[5,-.04],[9,-.013],[13,.013],[17,.038]])for(const[offset,y]of[[0,.08],[1,.12],[2,.15],[3,.175]])points[index+offset]={x,y,z:0};return points;
}
function raw(t){return {landmarks:[Array.from({length:21},()=>({x:.35+.17*Math.sin(2*Math.PI*t),y:.45-.14*Math.sin(Math.PI*t),z:0}))],worldLandmarks:[world()],handedness:[[{categoryName:'Left',score:.99}]]};}
const template=createMotionTemplate(Array.from({length:41},(_,i)=>({timeMs:i*50,features:extractMotionFrame(raw(i/40))})));
const motion={id:'motion_wave_0001',name:'Wave',enabled:true,cue_list:1,cue:'1000',threshold:.85,cooldown_s:2,feature_version:'hand-v1',templates:[template]};

function fixture({mode='motion',live=false,rehearsal=false,competing=false}={}){
 const elements=new Map(),listeners=new Map(),calls=[],busyChanges=[],saved=[];
 const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
 const editor=get('motionEditor');
 for(const [id,field] of Object.entries({motionName:'name',motionOutputType:'output_type',motionCueList:'cue_list',
  motionCue:'cue',motionChannel:'channel',motionLevel:'level',motionZoom:'zoom',motionColor:'color'})){
  const input=get(id);input.dataset.field=field;editor.append(input);
 }
 globalThis.document={hidden:false,getElementById:get,createElement:tag=>new Element(tag),addEventListener:(event,fn)=>listeners.set(event,fn),removeEventListener:event=>listeners.delete(event)};
 let state={armed:live,verified:true,connected:true,config:{mode,hand_confidence:.75,custom_motions:[copy(motion),...(competing?[{...copy(motion),id:'motion_other_002',name:'Overlapping motion'}]:[])]},workflow:{active:true,state:live?'live':'preview',rehearsal,revision:5,epoch:8,camera_ready:true,session_confirmed:true,targets:[{id:'cue:1:1000',sent:true,confirmed:true}],needs_practice:[{id:motion.id,label:'Wave',observed:false}]}};
 let controller,holdPause=false,resolvePause=null,holdConfig=false,resolveConfig=null,camera=true;
 const respond=(action,data)=>{
  if(action==='pause'){state.armed=false;state.workflow.state='paused';state.workflow.epoch++;}
  if(action==='config')state.config=copy(data.config);
  if(action==='test_target')state.workflow.targets.find(t=>t.id===data.id).sent=true;
  if(action==='confirm_target')state.workflow.targets.find(t=>t.id===data.id).confirmed=true;
  if(action==='practice_confirm')state.workflow.needs_practice=state.workflow.needs_practice.filter(t=>t.id!==data.id);
  controller?.onState(state);return state;
 };
 const api=async(action,data={})=>{
  calls.push({action,data:copy(data)});
  if(action==='pause'&&holdPause)return new Promise(resolve=>{resolvePause=()=>resolve(respond(action,data));});
  if(action==='config'&&holdConfig)return new Promise(resolve=>{resolveConfig=()=>resolve(respond(action,data));});
  return respond(action,data);
 };
 controller=mountCustomMotions({api,getState:()=>state,isCameraRunning:()=>camera,notify:()=>{},onLibrarySaved:result=>saved.push(result),onLearningChanged:active=>busyChanges.push(active)});
 controller.onState(state);
 const row=()=>get('customMotionRows').children.find(r=>r.dataset.motionId===motion.id);
 const control=field=>row().querySelectorAll('[data-field]').find(input=>input.dataset.field===field);
 const button=text=>row().querySelectorAll('button').find(b=>b.textContent===text);
 return {controller,get,calls,busyChanges,saved,row,control,button,state,listeners,hold:()=>{holdPause=true;},resolve:()=>{holdPause=false;resolvePause();},holdSave:()=>{holdConfig=true;},resolveSave:()=>{holdConfig=false;resolveConfig();},setCamera:value=>{camera=value;},refresh:()=>controller.onState(state)};
}
function feed(f,start=now,duration=2300,fn=t=>raw(Math.min(1,t))){
 for(let elapsed=0;elapsed<=duration;elapsed+=100){now=start+elapsed;f.controller.onFrame(fn(elapsed/2000),now);}
}
async function practice(f){f.get('motionSelect').value=motion.id;f.get('motionSelect').onchange();await f.get('motionPractice').onclick();}

{
 const f=fixture({live:true});
 f.control('name').value='New label';f.row().oninput();
 assert.equal(f.controller.hasUnsavedChanges(),true,'A label draft still needs saving');
 assert.equal(f.controller.hasOutputChanges(),false,'A label draft is not an operational change');
 assert.equal(f.calls.length,0,'A label edit does not pause the session');
 feed(f,now+100);
 assert.equal(f.controller.getOutput().motionCandidate?.id,motion.id,'A label draft does not block a live camera candidate');
 await f.button('Save mapping').onclick();
 assert.deepEqual(f.calls.map(c=>c.action),['config'],'Saving a label does not call stop/pause or reconnect');
 assert.equal(f.state.workflow.state,'live');assert.equal(f.state.workflow.session_confirmed,true);
 assert.equal(f.state.config.mode,'motion');assert.equal(f.saved.length,1);
 assert.deepEqual(f.busyChanges,[],'A label-only save must not latch the main session pause');f.controller.destroy();
}
{
 const f=fixture({live:true});f.hold();
 f.control('cue').value='888';f.row().oninput();
 assert.equal(f.controller.hasOutputChanges(),true,'A destination draft is operational');
 assert.equal(f.controller.isOutputPaused(),true,'An output edit blocks local frames before pause returns');
 assert.deepEqual(f.controller.getOutput(),{motionCandidate:null,motionPractice:null,motionPreview:null});
 assert.equal(f.calls[0].action,'pause');f.resolve();await Promise.resolve();await Promise.resolve();
 assert.equal(f.state.workflow.state,'paused');f.controller.destroy();
}
{
 const f=fixture({rehearsal:true});
 feed(f,now+100);
 const output=f.controller.getOutput();
 assert.equal(output.motionPreview?.id,motion.id,'Rehearsal recognises enabled learned motions without starting practice');
 assert.equal(output.motionCandidate,null,'Rehearsal never creates a live candidate');
 assert.equal(output.motionPractice,null,'Automatic rehearsal matches cannot confirm practice');
 f.controller.consumeMotionPreview();
 assert.equal(f.controller.getOutput().motionPreview,null,'Each preview match is consumed once');
 f.state.workflow.epoch++;
 f.refresh();
 feed(f,now+100);
 assert.equal(f.controller.getOutput().motionPreview?.id,motion.id);
 f.state.workflow.rehearsal=false;
 f.refresh();
 assert.equal(f.controller.getOutput().motionPreview,null,'Leaving rehearsal drops any queued match');
 assert.deepEqual(f.calls,[],'Automatic motion preview needs no separate workflow action');
 f.controller.destroy();
}
{
 const f=fixture({live:true});f.hold();
 f.get('motionSelect').value=motion.id;f.get('motionSelect').onchange();
 const starting=f.get('motionPractice').onclick();
 assert.equal(f.controller.isOutputPaused(),true,'Starting practice immediately gates live output');
 f.resolve();await starting;assert.equal(f.controller.isPracticing(),true);
 feed(f,now+100);
 const output=f.controller.getOutput();
 assert.equal(output.motionCandidate,null,'Practice never exposes a live cue candidate');
 assert.equal(output.motionPractice?.id,motion.id,'A full demonstrated path is sent as practice evidence');
 assert.equal(f.get('motionConfirmPractice').disabled,true,'A local match alone cannot authorize practice confirmation');
 await f.get('motionConfirmPractice').onclick();
 assert.equal(f.calls.filter(c=>c.action==='practice_confirm').length,0);
 f.controller.consumePracticeEvidence();assert.equal(f.controller.getOutput().motionPractice,null);
 f.state.workflow.needs_practice[0].observed=true;f.refresh();
 assert.equal(f.get('motionConfirmPractice').disabled,false,'The bridge must acknowledge current evidence');
 await f.get('motionConfirmPractice').onclick();
 const confirm=f.calls.find(c=>c.action==='practice_confirm');
 assert.deepEqual(confirm.data,{id:motion.id,revision:5,epoch:9,observed:true});
 assert.ok(f.calls.every(c=>['pause','practice_confirm'].includes(c.action)),'Practice sends no cue, frame, or arm operation itself');
 f.controller.leaveLearning();assert.equal(f.controller.isOutputPaused(),false);assert.equal(f.state.workflow.state,'paused');f.controller.destroy();
}
{
 const f=fixture();await practice(f);feed(f,now+100);
 assert.ok(f.controller.getOutput().motionPractice);
 f.state.workflow.epoch++;f.refresh();assert.equal(f.controller.getOutput().motionPractice,null,'A new epoch drops queued practice evidence');
 feed(f,now+100,1000,t=>raw(.5+Math.min(.5,t)));
 assert.equal(f.controller.getOutput().motionPractice,null,'Old movement history cannot finish after an epoch change');f.controller.destroy();
}
{
 const f=fixture();await practice(f);feed(f,now+100,3500,()=>raw(0));
 assert.equal(f.controller.getOutput().motionPractice,null,'A held pose is not motion proof');f.controller.destroy();
}
{
 const f=fixture({competing:true});await practice(f);feed(f,now+100);
 assert.equal(f.controller.getOutput().motionPractice,null,'An overlapping enabled trigger cannot earn practice proof');f.controller.destroy();
}
{
 const f=fixture();f.hold();f.get('motionSelect').value=motion.id;f.get('motionSelect').onchange();
 const starting=f.get('motionPractice').onclick();f.setCamera(false);f.controller.onCameraStopped();f.resolve();await starting;
 assert.equal(f.controller.isPracticing(),false,'Camera loss while waiting for pause cannot restart practice');f.controller.destroy();
}
{
 const f=fixture();f.state.workflow.targets[0].confirmed=false;f.refresh();
 await f.button('Test cue').onclick();await f.button('Cue worked').onclick();
 assert.deepEqual(f.calls.map(c=>c.action),['pause','test_target','confirm_target']);
 assert.equal(f.calls[2].data.worked,true);assert.equal(f.calls[2].data.epoch,f.state.workflow.epoch);f.controller.destroy();
}
{
 const f=fixture();
 f.control('output_type').value='channel_level';f.control('output_type').listeners.get('input')();
 f.control('channel').value='28';f.control('zoom').value='0';f.control('color').value='#E07822';
 f.row().oninput();
 assert(f.controller.hasOutputChanges());
 await f.button('Save mapping').onclick();
 const mapped=f.state.config.custom_motions[0];
 assert.equal(mapped.zoom,0);assert.equal(mapped.color,'#e07822');assert.equal(mapped.level,undefined);
 assert.equal(f.get('motionOutputType').value,'channel_level');assert.equal(f.get('motionZoom').value,'0');
 assert(f.button('Test fixture').disabled,'an old cue receipt does not verify changed output');
 f.state.workflow.targets.push({id:'channel-settings',output_type:'channel_level',channel:28,zoom:0,color:'#e07822'});
 f.refresh();
 await f.button('Test fixture').onclick();
 await f.button('Output worked').onclick();
 assert.equal(f.calls.at(-2).data.id,'channel-settings');assert.equal(f.calls.at(-1).data.id,'channel-settings');
 f.controller.destroy();
}
{
 const f=fixture({mode:'cue'});await practice(f);f.controller.leaveLearning();
 assert.equal(f.state.config.mode,'cue','Learning does not silently select the learned-motion preset');
 assert.ok(f.calls.every(c=>c.action==='pause'));f.controller.destroy();
}
{
 const interval=globalThis.setInterval,clear=globalThis.clearInterval;let tick;
 globalThis.setInterval=fn=>{tick=fn;return 1;};globalThis.clearInterval=()=>{};
 try{
  const f=fixture({mode:'cue'});f.get('motionSelect').value=motion.id;f.get('motionSelect').onchange();f.get('motionDuration').value='1';f.holdSave();
  f.get('motionOutputType').value='channel_level';f.get('motionOutputType').listeners.get('input')();
  f.get('motionCue').value='';f.get('motionChannel').value='28';f.get('motionColor').value='#1100aa';
  await f.get('motionLearn').onclick();now+=2000;tick();
  const start=now;for(let i=0;i<=10;i++){now=start+i*100;f.controller.onFrame(raw(i/10),now);tick();}
  assert.equal(f.calls.at(-1).action,'config','A valid recorded demonstration reaches the save');
  f.controller.leaveLearning();f.resolveSave();await Promise.resolve();await Promise.resolve();await Promise.resolve();
  assert.equal(f.controller.isPracticing(),false,'Leaving Learn during an in-flight save must not restart practice');
  assert.equal(f.calls.filter(c=>c.action==='pause').length,1,'Finishing the save does not silently start another practice operation');
  assert.equal(f.state.config.mode,'cue');
  const updated=f.state.config.custom_motions[0];
  assert.equal(updated.templates.length,2);assert.equal(updated.channel,28);assert.equal(updated.color,'#1100aa');assert.equal(updated.cue,'');
  f.controller.destroy();
 }finally{globalThis.setInterval=interval;globalThis.clearInterval=clear;}
}
console.log('Custom motion workflow checks passed: pause-before-await, selective saves, practice evidence/confirmation, epochs, ambiguity, camera loss, explicit cue checks and preset isolation.');
