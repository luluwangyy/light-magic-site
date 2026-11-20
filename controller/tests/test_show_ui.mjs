import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {cueStatus, mountShowUI, outputReadout, visionReadout} from '../web/show-ui.mjs';

class Element {
 constructor(tag='div'){this.tag=tag;this.children=[];this.dataset={};this.hidden=false;this.disabled=false;this.textContent='';this.open=false;this.classes=new Set();this.classList={toggle:name=>this.classes.has(name)?!this.classes.delete(name):!!this.classes.add(name)};}
 append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node);}}
 insertBefore(node,reference){node.parentElement=this;this.children.splice(this.children.indexOf(reference),0,node);}
 get lastElementChild(){return this.children.at(-1);}
 querySelectorAll(tag){return this.children.flatMap(child=>[...(child.tag===tag?[child]:[]),...child.querySelectorAll(tag)]);}
 querySelector(tag){return this.querySelectorAll(tag)[0];}
 setAttribute(name,value){this[name]=value;}
 showModal(){this.open=true;}
 close(){this.open=false;}
}
const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
const elements=new Map([...html.matchAll(/id="([^"]+)"/g)].map(match=>[match[1],new Element()]));
const el=id=>{assert(elements.has(id),'missing '+id);return elements.get(id);};
globalThis.document={getElementById:el,createElement:tag=>new Element(tag)};
const rowFor=mapping=>{
 const row=new Element('tr');row.dataset.gesture=mapping.gesture;
 for(const field of ['enabled','gesture','label','cue_list','cue','confidence','hold_s']){
  const cell=new Element('td');if(field!=='gesture'){const input=new Element('input');input.dataset.field=field;cell.append(input);}row.append(cell);
 }
 const cell=new Element('td');cell.append(new Element('button'));row.append(cell);return row;
};
const openPalm={gesture:'Open_Palm',cue:'42',cue_list:1,enabled:true};
const fire={gesture:'Fire_Gesture',cue:'43',cue_list:1,enabled:false};
const fist={gesture:'Closed_Fist',cue:'',cue_list:1,enabled:false};
const state={config:{cue_sheet:'legacy',input_source:'both',mode:'cue',mappings:[openPalm,fire,fist],speech_mappings:[]},
 workflow:{active:true,camera_ready:true,session_confirmed:true,state:'preview',targets:[{id:'cue:1:42',confirmed:true}],needs_practice:[]},armed:false};
for(const mapping of state.config.mappings)el('mappings').append(rowFor(mapping));
const [palmRow,fireRow,fistRow]=el('mappings').children;
let loadCount=0,restoreCount=0,view='',dirty=false;
const ui=mountShowUI({getState:()=>state,showView:next=>{view=next;},hasOperationalEdits:()=>dirty,notify:text=>assert.fail(text),
 loadPreset:async()=>{loadCount++;state.config.cue_sheet='air-obey';state.cue_sheet_backup=true;},
 restorePreset:async()=>{restoreCount++;state.config.cue_sheet='legacy';state.cue_sheet_backup=false;}});
ui.onState();
assert.equal(loadCount,0,'opening the cue sheet never replaces current setup');
assert.equal(el('showPresetCard').hidden,false);assert.equal(el('showRestorePreset').hidden,true);
assert.equal(fireRow.querySelector('input').disabled,false,'the static Fire shape can be explicitly enabled');
assert.equal(fireRow.querySelector('button').disabled,true);
assert.equal(fistRow.querySelector('button').disabled,true);
assert.equal(palmRow.querySelector('button').disabled,false);
const statusNode=palmRow.children.at(-2).children[0];
assert.equal(statusNode.textContent,'Cue verified');
dirty=true;ui.onState();assert.equal(palmRow.querySelector('button').disabled,true);
assert.equal(palmRow.children.at(-2).children[0],statusNode,'polling preserves controls and focus');
assert.match(el('showCueSheetStatus').textContent,/Unsaved/);dirty=false;
el('showCueShortcut').onclick();assert.equal(view,'cues');
el('showLoadPreset').onclick();assert(el('showPresetDialog').open);assert.equal(loadCount,0);
await el('showPresetConfirm').onclick();assert.equal(loadCount,1);assert.equal(el('showPresetCard').hidden,true);
el('showRestorePreset').onclick();assert.match(el('showPresetDetails').textContent,/kept for next time/);
await el('showPresetConfirm').onclick();assert.equal(restoreCount,1);
state.workflow.rehearsal=true;ui.onState();assert.equal(palmRow.querySelector('button').disabled,true);
assert.equal(cueStatus(state,openPalm,'camera').text,'Rehearsal only');
assert.equal(cueStatus(state,{...fire,enabled:true},'camera').text,'Rehearsal only','Fire uses the same rehearsal gate as other poses');

ui.onVision({fire:{active:true},diagnostics:{light:'dim',poseState:'visible',handMode:'wrist crop'}});
assert.equal(el('showCameraHands').textContent,'Wrist crop');assert.equal(el('showCameraPose').textContent,'Fire hand shape recognized');
ui.onVision(null);assert.equal(el('showCameraPose').hidden,true);assert.equal(el('showCameraHands').textContent,'Not tracked');
assert.match(visionReadout({diagnostics:{light:'very dark',poseState:'multiple people'}}).guide,/only the performer.*front light/);
assert.equal(outputReadout(state),'','recognition without a receipt never reads as sent');
state.last_output={kind:'simulated',source:'camera',id:'Open_Palm',cue:'42',cue_list:1};
assert.match(outputReadout(state),/no command sent/);
state.last_output={...state.last_output,kind:'sent',timestamp:'12:30:04'};
assert.equal(outputReadout(state),'Last cue sent: List 1 · Cue 42 · Open palm · 12:30:04');
state.last_output={...state.last_output,source:'manual'};
assert.match(outputReadout(state),/^Last test sent:/);
state.workflow.rehearsal=false;
Object.assign(fist,{cue:'888',output_type:'channel_level',channel:9,level:null,enabled:true});
assert.equal(cueStatus(state,fist,'camera').text,'Unassigned','the old cue cannot substitute for an incomplete level assignment');
fist.level=0;
const levelTarget={id:'channel_level:9:0',output_type:'channel_level',channel:9,level:0,confirmed:false,sent:true};
state.workflow.targets.push(levelTarget);ui.onState();
assert.equal(fistRow.querySelector('button').textContent,'Test level live');
assert(!fistRow.querySelector('button').disabled);
assert.equal(cueStatus(state,fist,'camera').text,'Level check required','old test receipts need a new check');
state.workflow.blockers=[{kind:'confirm_target',id:levelTarget.id}];
assert.equal(cueStatus(state,fist,'camera').text,'Confirm result');
levelTarget.confirmed=true;
assert.equal(cueStatus(state,fist,'camera').text,'Level verified');
state.config.input_source='speech';ui.onState();
assert(fistRow.querySelector('button').disabled,'a shared destination does not enable an inactive camera mapping');
state.last_output={kind:'sent',source:'camera',id:'pose:Closed_Fist',output_type:'channel_level',channel:9,level:0};
assert.equal(outputReadout(state),'Last level sent: Chan 9 @ 0 · Fist');
console.log('PASS: cue sheet switching, Fire and rehearsal gates, stable controls, camera guidance, and cue and level checks and receipts.');
