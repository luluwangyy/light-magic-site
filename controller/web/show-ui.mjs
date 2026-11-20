import {outputKind,outputLabel,savedOutputTarget} from './mapping-output.mjs';

const $=id=>document.getElementById(id);

export const SHOW_NAME='How to Make the Air Obey';
export const STAGE_GESTURES=Object.freeze({Open_Palm:'Open palm',Closed_Fist:'Fist',Fire_Gesture:'Fire gesture',Ankh_Pose:'Ankh pose'});
export const STAGE_SPEECH_EFFECTS=Object.freeze({speech_light:'White light',speech_abracadabra:'Transformation state',speech_pass:'Red barrier',speech_command:'Authoritarian state',speech_stand_down:'Lights off / blackout'});
const FIRE='Fire_Gesture';
const nameOf=gesture=>STAGE_GESTURES[gesture]||String(gesture||'').replaceAll('_',' ');
const put=(element,value)=>{if(element&&element.textContent!==value)element.textContent=value;};
const status=(text,tone='neutral')=>({text,tone});

// Describe the saved route only. Unsaved controls and recognition candidates never become receipts.
export function cueStatus(state,mapping,source,{dirty=false}={}){
 const config=state?.config||{},w=state?.workflow||{},identity=source==='camera'?`pose:${mapping.gesture}`:mapping.id;
 if(!outputLabel(mapping))return status('Unassigned');
 if(dirty)return status('Save changes','warning');
 if(!mapping.enabled)return status('Disabled');
 if(w.rehearsal||state?.rehearsal_only)return status('Rehearsal only');
 const selected=config.input_source||'camera';
 if((source==='camera'&&selected==='speech')||(source==='speech'&&selected==='camera'))return status('Input off');
 if(source==='camera'&&config.mode&&config.mode!=='cue')return status('Gesture mode off');
 if(config.dry_run&&w.active)return status('Simulation');
 if(!w.active)return status('Mapped');
 const receipt=savedOutputTarget(state,mapping),kind=outputKind(mapping);
 const title=kind==='look'?'Channel look':kind==='fixture'?'Fixture settings':kind==='level'?'Level':'Cue';
 const pending=receipt&&w.blockers?.some(blocker=>blocker.kind==='confirm_target'&&blocker.id===receipt.id);
 if(!receipt?.confirmed&&!receipt?.skipped)return status(pending?'Confirm result':title+' check required','warning');
 if(!(source==='speech'&&w.speech_practice_skipped)&&w.needs_practice?.some(item=>item.id===identity))return status('Practice needed','warning');
 if(source==='camera'&&w.state==='live'&&state.armed&&w.fresh_gesture_required)return status('Waiting for neutral','warning');
 if(w.state==='live'&&state.armed)return status('Live','good');
 if(receipt.skipped)return status('Look test skipped');
 return status(title+' verified','good');
}

export function canTestMapping(state,mapping,source,dirty){
 const config=state.config,w=state.workflow,input=config.input_source||'camera';
 const selected=source==='camera'?input!=='speech'&&config.mode==='cue':input!=='camera';
 return !!(mapping.enabled&&selected&&!dirty&&savedOutputTarget(state,mapping)&&w?.session_confirmed&&
  !w.rehearsal&&!state.rehearsal_only&&!state.armed&&!config.dry_run&&state.verified!==false);
}

export function visionReadout(report){
 if(!report)return {light:'Not measured',body:'Not tracked',hands:'Not tracked',guide:'Frame the performer with room for both arms.',pose:''};
 const d=report.diagnostics||{},light=({'adequate':'Adequate','dim':'Dim','very dark':'Very dark'})[d.light]||'Not measured';
 const body=({'visible':'Visible','limited':'Partly visible','not detected':'Not detected','disabled':'Hand tracking selected','unavailable':'Unavailable','multiple people':'Multiple people','reacquiring':'Reacquiring'})[d.poseState]||'Not tracked';
 const hands=d.handMode==='wrist crop'?'Wrist crop':d.handMode==='full frame'?(d.smallHands?'Small in frame':'Full frame'):'Not detected';
 const guides=[];
 if(d.personCount>1||d.poseState==='multiple people')guides.push('Keep only the performer in frame.');
 if(d.poseState==='reacquiring')guides.push('Keep the performer still briefly while tracking resumes.');
 if(d.light==='very dark')guides.push('Add gentle front light or move toward the lit area.');
 else if(d.light==='dim')guides.push('Dim light may hide fingers; keep hands in the light.');
 if(d.poseState==='limited'||d.poseState==='not detected')guides.push('Keep shoulders, elbows, and wrists inside the frame.');
 if(d.smallHands&&d.handMode!=='wrist crop')guides.push('Move the camera closer if both extended arms still fit.');
 const blocked=d.personCount>1||d.poseState==='multiple people'||d.poseState==='reacquiring';
 const pose=blocked?'':report.ankh?.active?'Ankh pose recognized':report.fire?.active?'Fire hand shape recognized':report.ankh?.forming?'Ankh forming · hold both arms out':'';
 return {light,body,hands,guide:guides.join(' ')||'Keep the performer and both hands in frame.',pose};
}

export function outputReadout(state){
 const output=state?.last_output,label=outputLabel(output);
 if(!label)return '';
 const kind=output.kind;
 if(kind==='simulated')return `Last simulation: ${label} · no command sent`;
 if(kind!=='sent')return '';
 const c=state.config||{},id=String(output.id||'').replace(/^pose:/,'');
 const name=output.source==='camera'?nameOf(id):output.source==='speech'?c.speech_mappings?.find(m=>m.id===id)?.phrase:output.source==='motion'?c.custom_motions?.find(m=>m.id===id)?.name:'';
 const test=output.source==='manual';
 const stamp=String(output.timestamp||'').match(/(?:^|T)(\d{2}:\d{2}:\d{2})/);
 const outputName=outputKind(output)==='fixture'?'fixture settings':outputKind(output);
 return `${test?'Last test sent':'Last '+outputName+' sent'}: ${label}${name?' · '+name:''}${stamp?' · '+stamp[1]:''}`;
}

export function mountShowUI({getState,showView,loadPreset,restorePreset,notify,hasOperationalEdits=()=>false}){
 const cameraCells=new WeakMap();
 let switchTo='',pending=false,nextDiagnosticAt=0;
 const dialog=$('showPresetDialog');
 function openPreset(which){
  switchTo=which;const restore=which==='restore';
  put($('showPresetTitle'),restore?'Restore the previous setup?':'Load the show cue sheet?');
  put($('showPresetDetails'),restore?'This pauses output and restores your previous setup. Your show cue assignments are kept for next time.':'This pauses output and loads the nine show triggers. Cue numbers start blank the first time. Your current setup is kept on this laptop.');
  put($('showPresetConfirm'),restore?'Restore setup':'Load cue sheet');
  dialog.showModal();
 }
 $('showCueShortcut').onclick=()=>showView('cues');
 $('showLoadPreset').onclick=()=>openPreset('load');
 $('showRestorePreset').onclick=()=>openPreset('restore');
 $('showPresetConfirm').onclick=async()=>{
  if(pending)return;
  const action=switchTo==='restore'?restorePreset:loadPreset;if(!action)return;
  pending=true;$('showPresetConfirm').disabled=true;
  try{await action();dialog.close();onState(getState());}
  catch(error){notify(error.message,true);}
  finally{pending=false;$('showPresetConfirm').disabled=false;}
 };
 $('showTuning').onclick=()=>{
  const expanded=$('showCameraTable').classList.toggle('show-tuning');
  $('showTuning').setAttribute('aria-expanded',String(expanded));
  put($('showTuning'),expanded?'Hide recognition settings':'Show recognition settings');
 };

 function cameraRow(row,mapping,s,dirty){
  let cells=cameraCells.get(row);
  if(!cells){
   const cell=document.createElement('td'),badge=document.createElement('span');badge.className='cue-badge';cell.append(badge);row.insertBefore(cell,row.lastElementChild);
   const title=row.children[1],button=row.lastElementChild.children[0],name=nameOf(mapping.gesture);
   put(title,name);title.setAttribute('role','rowheader');
   for(const input of row.querySelectorAll('input')){
    const field=input.dataset.field,labels={enabled:'Enable',label:'Lighting action',confidence:'Threshold',hold_s:'Hold seconds'};
    if(labels[field])input.setAttribute('aria-label',`${labels[field]} for ${name}`);
    if(field==='confidence'||field==='hold_s')input.parentElement.dataset.showTuning='';
   }
   cells={badge,button};cameraCells.set(row,cells);
  }
  const next=cueStatus(s,mapping,'camera',{dirty});
  put(cells.badge,next.text);cells.badge.dataset.tone=next.tone;
  if(cells.button){
   const type=outputKind(mapping);
   put(cells.button,`Test ${type} live`);
   cells.button.setAttribute('aria-label',`Test ${type} for ${nameOf(mapping.gesture)} live`);
   cells.button.disabled=!canTestMapping(s,mapping,'camera',dirty);
  }
 }

 function onState(s=getState()){
  if(!s?.config)return;
  const c=s.config,stage=c.cue_sheet==='air-obey',dirty=hasOperationalEdits();
  const mappings=c.mappings||[],phrases=c.speech_mappings||[];
  const assigned=[...mappings,...phrases].filter(m=>outputLabel(m)).length;
  put($('showCueSheetTitle'),stage?SHOW_NAME:'Current setup');
  put($('showCueSummary'),`${stage?SHOW_NAME+' · ':''}${assigned} ${assigned===1?'output assignment':'output assignments'} saved${dirty?' · Unsaved changes':''}.`);
  put($('showCueSheetStatus'),dirty?'Unsaved changes. Save output assignments before testing or going live.':'Assign an Eos cue or choose a channel and set its intensity, zoom, or color. Blank settings leave that parameter unchanged.');
  $('showPresetCard').hidden=stage||!loadPreset;
  $('showRestorePreset').hidden=!stage||!s.cue_sheet_backup||!restorePreset;
  $('showFireNotice').hidden=!stage;
  const receipt=outputReadout(s);
  $('showLastOutput').hidden=!receipt;put($('showLastOutput'),receipt);
  const byGesture=new Map((c.mappings||[]).map(mapping=>[mapping.gesture,mapping]));
  for(const row of $('mappings').children){const mapping=byGesture.get(row.dataset.gesture);if(mapping)cameraRow(row,mapping,s,dirty);}
  if(!s.workflow?.camera_ready||c.input_source==='speech')onVision(null);
 }

 function onVision(report){
  const v=visionReadout(report),now=performance.now();
  if(!report||now>=nextDiagnosticAt){
   nextDiagnosticAt=report?now+250:0;
   put($('showCameraLight'),v.light);put($('showCameraBody'),v.body);put($('showCameraHands'),v.hands);put($('showCameraGuide'),v.guide);
  }
  $('showCameraPose').hidden=!v.pose;put($('showCameraPose'),v.pose);
 }

 return {onState,onVision};
}
