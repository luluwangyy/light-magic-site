import {armsState} from './arms.mjs';
import {HandSelector} from './hand-selection.mjs';
import {learnPose} from './pose-calibration.mjs';
import {mountCustomMotions} from './custom-motions.mjs';
import {mountWorkflow,isCurrentResponse} from './workflow-ui.mjs';
import {mountSpeech} from './speech.mjs';
import {CameraStartCancelled,stopCameraStream,waitForCameraStage} from './camera-lifecycle.mjs';
import {createStageVision} from './stage-vision.mjs';
import {mountShowUI} from './show-ui.mjs';
import {StageInputTracker} from './stage-input.mjs';
import {mountChannelLevel} from './channel-level-ui.mjs';
import {appendOutputFields,mergeMappingDraft,outputKind,outputLabel,outputType,savedOutputTarget} from './mapping-output.mjs';
import {createStagePreview} from './stage-preview.mjs';
import {mountSessionLayout} from './session-layout.mjs';
import {mountSessionDiagnostics} from './session-diagnostics.mjs';
import {mountRehearsalControls} from './rehearsal-controls.mjs';
const $=id=>document.getElementById(id);
const client=crypto.randomUUID();
let token='',state=null,dirty=false,operationalDirty=false,formBaseline=null,cal={close:null,far:null};
const stagePreviewRoot=$('stagePreview');
const stagePreview=createStagePreview(stagePreviewRoot);
const sessionLayout=mountSessionLayout($('appMain'));
const sessionDiagnostics=mountSessionDiagnostics($('sessionDiagnostics'),{client,notify:message});
const rehearsalControls=mountRehearsalControls($('rehearsalControls'),{api,getState:()=>state,client,notify:message});
let manualStagePreview=null;
let channelLooks=[],channelLookAction=null,changingLooks=false;
let stream=null,recognizer=null,running=false,lastVideo=-1,lastFrameSent=0,busy=false,cameraStarting=null,cameraAbort=null;
let rawDistance=null,handCount=0,demoGesture='None',cameraEpoch=0,armsHeld=false;
const handSelector=new HandSelector();
const stageInputTracker=new StageInputTracker();
let latestInput=null,poseCalibration={},browserPoseFallback={};
let customMotions=null,workflowUI=null,speech=null,showUI=null,channelLevel=null,localOutputPaused=true,learningBlock=false,lastEpoch=null,pausePending=false;
let stageVision=null,stageVisionError='',recognizerForStage=null;
let savedCamera='';try{savedCamera=localStorage.getItem('light-magic-camera')||'';}catch{}
try{const stored=JSON.parse(localStorage.getItem('eos-palm-calibration')||'{}');for(const label of ['Closed_Fist','Open_Palm'])if(Array.isArray(stored[label])&&stored[label].length===16&&stored[label].every(value=>Number.isFinite(value)&&value>=0&&value<=10))browserPoseFallback[label]=stored[label];poseCalibration={...browserPoseFallback};handSelector.setCalibration(poseCalibration);}catch{poseCalibration={};}
let lastCameraCue=null;
const stageSheet=()=>state?.config.cue_sheet==='air-obey';
const scalar=['host','port','framing','mode','dry_run','target_type','target','zoom_min','zoom_max','alpha','deadband','rate_hz','hand_loss_s','hand_confidence','cue_interval_s','reverse','notes'];
const numeric=['port','zoom_min','zoom_max','alpha','deadband','rate_hz','hand_loss_s','hand_confidence','cue_interval_s'];
function gestureLabel(name){return name==='None'?'No gesture':name==='Closed_Fist'&&stageSheet()?'Fist':String(name).replaceAll('_',' ').toLowerCase().replace(/^./,letter=>letter.toUpperCase());}
function message(text,error=false){$('message').textContent=text;$('message').className=error?'error':'';}
function palmMapping(){return state?.config.mappings.find(m=>m.enabled&&m.gesture==='Open_Palm');}
function fistMapping(){return state?.config.mappings.find(m=>m.enabled&&m.gesture==='Closed_Fist');}
function palmOutput(){return outputLabel(palmMapping())||'the mapped output';}
function motionMappingsDirty(){return state?.config.mode==='motion'&&!!customMotions?.hasOutputChanges?.();}
function confirmations(){return Object.fromEntries(['only_host','session_ok','cue_ok','zoom_ok'].map(k=>[k,$(k).checked]));}
async function api(action,data={}){
 if(action==='stop'&&state?.workflow?.active){action='pause';data={reason:'Output paused',...data};}
 if(['pause','session_start','start_rehearsal','recheck_cues','load_cue_sheet','restore_cue_sheet','load_channel_looks','undo_channel_looks'].includes(action)){localOutputPaused=true;cancelPendingCamera();speech?.cancelPending?.();}
 if((action==='session_start'||action==='start_rehearsal')&&!Object.keys(state?.config.pose_calibration||{}).length&&Object.keys(browserPoseFallback).length){
  if(state?.owner!==client)await api('claim');
  await api('config',{config:{...state.config,pose_calibration:browserPoseFallback}});
 }
 if(action==='config'){
  const mappings=[data.config?.mappings,data.config?.speech_mappings,data.config?.custom_motions].flatMap(rows=>Array.isArray(rows)?rows:[]);
  if(!state?.mapped_channel_levels_supported&&mappings.some(row=>outputType(row)==='channel_level')){
   throw Error('Restart Light Magic to save channel mappings.');
  }
  if(!state?.fixture_parameters_supported&&mappings.some(row=>outputKind(row)==='fixture')){
   throw Error('Restart Light Magic to save zoom and color mappings.');
  }
  if(!state?.channel_looks_supported&&mappings.some(row=>outputType(row)==='channel_look')){
   throw Error('Restart Light Magic to save multi-channel looks.');
  }
 }
 const requestToken=token,compact=action==='frame'||action==='speech_audio';
 const response=await fetch('/api/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data,token,client,compact})});
 const wire=await response.json();if(requestToken!==token)return state;
 if(!response.ok)throw Error(wire.error||'Bridge request failed');
 const result=wire.compact?{...state,...wire,token}:{...wire,token};
 if(action==='session_start'||action==='start_rehearsal'){
  fill(result.config);
 }
 const accepted=render(result);
 return accepted===false&&action!=='manual_channel_level'?state:result;
}
async function refreshBridgeState(){
 const response=await fetch('/api/state');
 if(!response.ok)throw Error('Bridge unavailable');
 const snapshot=await response.json();
 token=snapshot.token;
 render(snapshot);
}
function perform(fn){return async()=>{try{await fn();}catch(e){message(e.message,true);}};}
function refreshDiagnostics(){
 sessionDiagnostics.update({
  state,client,cameraRunning:running,cameraObservation:latestInput,microphoneRunning:speech?.isRunning?.(),
  localOutputPaused,hasOperationalEdits:operationalDirty||motionMappingsDirty(),
  learning:!!customMotions?.isLearning?.()||!!customMotions?.isPracticing?.(),
 });
}
function refreshStagePreview(){
 const workflow=state?.workflow;
 const match=workflow?.active&&state.owner===client?state.stage_preview:null;
 if(manualStagePreview&&(state.armed||workflow?.state==='live'||manualStagePreview.token!==state?.token||
    manualStagePreview.revision!==workflow?.revision||manualStagePreview.epoch!==workflow?.epoch||
    manualStagePreview.previousMatch!==match?.serial)){
  manualStagePreview=null;
 }
 stagePreview.render(manualStagePreview?.event??match);
}
function previewFixtureOnStage(target,source='manual',input='Fixture settings'){
 const {workflow,token}=state;
 manualStagePreview={
  token,revision:workflow.revision,epoch:workflow.epoch,
  previousMatch:workflow.active&&state.owner===client?state.stage_preview?.serial:undefined,
  event:{source,input,target}
 };
 sessionLayout.showPanel('stage');
 workflowUI.showView('session');
 stagePreviewRoot.focus();
}
function render(s){
 if(!isCurrentResponse(state,s))return false;
 const previous=state;
 if(state?.token&&s.token&&state.token!==s.token){lastEpoch=null;lastCameraCue=null;localOutputPaused=true;}
 state=s;
 $('mappedLevelsUpdate').hidden=!!s.fixture_parameters_supported;
 updateChannelLookControls();
 if(s.workflow&&s.workflow.epoch!==lastEpoch){lastEpoch=s.workflow.epoch;handSelector.reset();stageInputTracker.reset();stageVision?.reset();customMotions?.resetRecognition?.();latestInput=null;demoGesture='None';armsHeld=false;if(s.workflow.state!=='live')localOutputPaused=true;}
 const last=s.last_output;
 if(last&&['camera','motion'].includes(last.source)&&last.serial!==lastCameraCue?.serial)lastCameraCue=last;
 const dispatch=s.cue_dispatch;
 const dispatchOutput=outputLabel(dispatch,{compact:true})||'Output';
 const dispatchText=dispatch?.kind==='waiting'?`${dispatchOutput} waiting for console spacing.${dispatch.source==='camera'?' Keep the pose held.':''}`:
  dispatch?.kind==='dropped'?`${dispatchOutput} not sent. ${dispatch.reason}`:
  `Console command spacing: ${dispatch?.gap_s??2} seconds minimum.`;
 if($('cueDispatchStatus').textContent!==dispatchText)$('cueDispatchStatus').textContent=dispatchText;
 customMotions?.onState(s);speech?.onState(s);
 const diagnostic=s.diagnostics;
 $('testConnection').disabled=!!diagnostic?.running;
 $('testConnection').textContent=diagnostic?.running?'Testing connection…':'Test connection';
 if(diagnostic){
  const endpoint=diagnostic.endpoint||s.config;
  const lines=[`CONNECTION TEST · ${endpoint.host}:${endpoint.port} · ${endpoint.framing==='length'?'OSC 1.0 packet length':'OSC 1.1 SLIP'}`];
  if(diagnostic.started_at)lines.push('Started: '+diagnostic.started_at);
  for(const step of diagnostic.steps||[])lines.push(`${({pass:'PASS',fail:'FAIL',info:'INFO',running:'TESTING'})[step.status]||step.status} · ${step.name}\n  ${step.detail||''}`);
  if(diagnostic.summary)lines.push('\n'+diagnostic.summary);
  $('diagnostics').textContent=lines.join('\n');
  if(!diagnostic.running&&$('message').textContent==='Testing connection…')message(diagnostic.summary);
 }
 $('state').textContent=(s.armed?'Live':'Paused')+' · '+(s.config.dry_run?'Dry run':'Console output');
 $('state').className=s.armed&&!s.config.dry_run?'live':'';
 $('owner').textContent=s.owner===client?'This tab controls the bridge':s.owner?'Another tab controls the bridge':'No browser owner';
 $('connection').textContent=s.verified?'Eos feedback verified':s.connected?'TCP connected · waiting for valid version/show feedback':diagnostic?.summary?.startsWith('Connection works:')?'Connection test passed · control connection is closed':'Control connection closed';
 if(previous?.feedback!==s.feedback)$('feedback').textContent=Object.entries(s.feedback).map(([a,v])=>a+' '+JSON.stringify(v)).join('\n')||'Waiting for Eos version, show, or cue feedback.';
 if(previous?.logs!==s.logs)$('log').textContent=s.logs.slice().reverse().map(x=>`${x.time} ${x.kind.padEnd(7)} ${x.message}`).join('\n');
 $('ownership').textContent=s.pending.length?'Zoom release journal: '+s.pending.map(p=>p.address).join(', '):s.dry_owned?'Dry Run override active':'No owned override';
 $('arm').disabled=s.owner!==client||s.armed||(!s.config.dry_run&&!s.verified)||dirty||motionMappingsDirty()||!!customMotions?.isLearning?.()||!!customMotions?.isPracticing?.();
 const t=s.telemetry;
 $('gestureHeading').textContent=s.config.mode==='motion'?'Learned motion tracking':stageSheet()?'Show gesture tracking':fistMapping()?`Fist → ${outputLabel(fistMapping(),{compact:true})||'—'} · Palm → ${outputLabel(palmMapping(),{compact:true})||'—'}`:`Closed fist → open palm → ${palmOutput()}`;
 if(lastCameraCue){
  $('cameraOutput').textContent=`Last camera ${outputKind(lastCameraCue)==='cue'?'cue':'output'} · ${outputLabel(lastCameraCue)} · ${lastCameraCue.kind==='simulated'?'Simulation':'Sent to Eos'}`;
 }else $('cameraOutput').textContent=s.armed?'No camera output sent yet.':'Camera output is paused.';
 $('hold').value=t.hold||0;
 if(s.config.input_source==='speech'&&$('appMain').dataset.view==='session')$('tracking').textContent='Choose Camera or Camera + speech to use gestures.';
 else if(s.config.mode==='motion')$('tracking').textContent=s.armed?'Perform an enabled named motion. Basic pose cue mappings are paused in this mode.':'Use Practice in the custom-motion panel before enabling and arming a named motion.';
 else if(stageSheet())$('tracking').textContent=s.armed?'Hold a mapped pose briefly. Show a relaxed hand or a different pose before repeating.':'Hold a pose to check it. Rehearsal sends no cues.';
 else if(s.config.mode==='cue'&&s.config.palm_from_fist&&palmMapping())$('tracking').textContent=fistMapping()?`Hold a fist for ${fistMapping().hold_s}s, then open your palm for ${palmMapping().hold_s}s. Each pose fires once.`:s.armed?(t.ready?`Closed fist accepted · open your palm and hold for ${palmMapping().hold_s} seconds`:`Close your fist for 0.3 seconds to prepare ${palmOutput()}`):`Closed fist → open palm → ${palmOutput()}. Start the camera and arm.`;
 else if(s.armed&&s.config.mode==='cue')$('tracking').textContent=t.ready?'Ready · hold a mapped gesture':'Neutral required before the next cue';
 if(t.output!==undefined){$('zoomReadout').textContent=`Raw ${t.distance.toFixed(3)} · Normalized ${(t.normalized*100).toFixed(1)}% · Zoom ${t.output.toFixed(2)}`;$('zoomMeter').value=t.normalized;}
 workflowUI?.onState(s);channelLevel?.onState(s);
 showUI?.onState(s);
 refreshStagePreview();
 refreshDiagnostics();
 rehearsalControls.onState(s);
}
function fill(c){
 if(c.pose_calibration!==undefined&&JSON.stringify(c.pose_calibration)!==JSON.stringify(poseCalibration)){poseCalibration=structuredClone(c.pose_calibration);handSelector.setCalibration(poseCalibration);poseStatus();}
 for(const id of scalar){if($(id).type==='checkbox')$(id).checked=c[id];else $(id).value=c[id]??'';}
 cal={close:c.close,far:c.far};calLabels();
 $('mappings').replaceChildren();
 for(const m of c.mappings){
  const row=document.createElement('tr');row.dataset.gesture=m.gesture;
  for(const field of ['enabled','gesture','label','confidence','hold_s']){
   const td=document.createElement('td');
   if(field==='gesture')td.textContent=gestureLabel(m.gesture);
   else{const input=document.createElement('input');input.dataset.field=field;input.type=field==='enabled'?'checkbox':['confidence','hold_s'].includes(field)?'number':'text';input.step='any';if(field==='enabled')input.checked=m[field];else input.value=m[field];td.append(input);}
   row.append(td);
   if(field==='label')appendOutputFields(row,m,gestureLabel(m.gesture));
  }
  const td=document.createElement('td'),button=document.createElement('button');button.type='button';
  button.dataset.outputTest='';
  button.textContent=`Test ${outputKind(m)} live`;
  button.onclick=perform(async()=>{
   ensureApplied();
   if(!state.workflow?.active)throw Error('Start a session before testing an output.');
   const saved=state.config.mappings.find(mapping=>mapping.gesture===m.gesture),target=savedOutputTarget(state,saved);
   if(!target)throw Error('Save and enable a mapping in the active input mode before testing.');
   workflowUI.openTarget(target.id);
  });
  td.append(button);row.append(td);$('mappings').append(row);
 }
 speech?.fillConfig(c);
 dirty=false;operationalDirty=false;formBaseline=structuredClone(c);
}
function gather(){
 const c={...state.config};
 for(const key of ['close','far'])if(!formBaseline||cal[key]!==formBaseline[key])c[key]=cal[key];
 for(const id of scalar){const value=$(id).type==='checkbox'?$(id).checked:numeric.includes(id)?($(id).value===''?null:Number($(id).value)):$(id).value;if(!formBaseline||value!==formBaseline[id])c[id]=value;}
 c.mappings=[...$('mappings').children].map(row=>{
  const gesture=row.dataset.gesture;
  return mergeMappingDraft(row,state.config.mappings.find(item=>item.gesture===gesture),formBaseline?.mappings.find(item=>item.gesture===gesture));
 });
 if(typeof speech!=='undefined'&&speech){c.speech_mappings=speech.gatherMappings(c);c.speech_backend=speech.gatherBackend?.(c)||c.speech_backend;}
 return c;
}
function ensureApplied(){if(operationalDirty||motionMappingsDirty())throw Error('Save operational settings before testing or going live.');}
function calLabels(){$('closeValue').textContent=cal.close===null?'Not set':cal.close.toFixed(3);$('farValue').textContent=cal.far===null?'Not set':cal.far.toFixed(3);}
async function changed(event){
 dirty=true;const metadata=event?.target?.id==='notes'||event?.target?.dataset?.field==='label';
 if(metadata){$('settingsStatus').textContent='Unsaved notes or labels. Output continues; Save changes when ready.';return;}
 const alreadyDirty=operationalDirty;operationalDirty=true;localOutputPaused=true;$('arm').disabled=true;
 $('settingsStatus').textContent='Output paused for operational edits. Save changes, then complete only the checks affected.';
 if(!alreadyDirty&&!pausePending&&state?.workflow?.active){pausePending=true;try{await api('pause',{reason:'Operational settings are being edited'});}finally{pausePending=false;}}
 workflowUI?.refresh();channelLevel?.onState(state);message('Settings edited. Save changes before resuming output.');
}
for(const id of scalar)$(id).addEventListener('input',perform(changed));
$('mappings').addEventListener('input',perform(changed));
$('claim').onclick=perform(async()=>{await api('claim');message('This tab has control. Configure and apply your lab settings.');});
async function saveSettings(){const wasOperational=operationalDirty;if(state?.owner!==client)await api('claim');const s=await api('config',{config:gather()});fill(s.config);render(s);$('settingsStatus').textContent='Changes saved on this laptop.';message(wasOperational?'Saved. Complete any affected checks in Session, then resume.':'Notes and labels saved. Existing session checks are preserved.');}
$('apply').onclick=perform(saveSettings);
$('saveConnection').onclick=perform(saveSettings);
$('saveCuePacing').onclick=perform(saveSettings);
$('connect').onclick=perform(async()=>{ensureApplied();await api('connect');message('Connecting to the console. Watch for version/show feedback.');});
$('testConnection').onclick=perform(async()=>{
 $('testConnection').disabled=true;
 try{
  const s=await api('diagnostics');
  message(dirty?'Testing the applied console settings. Apply your edits to test a different address.':s.diagnostics?.summary||'Checking the console connection. Cue and Zoom output are untouched.');
 }finally{$('testConnection').disabled=!!state?.diagnostics?.running;}
});
async function stop(){localOutputPaused=true;await api(state?.workflow?.active?'pause':'stop',{reason:'Paused by operator'});message('Output paused. Camera and console stay ready. Return to neutral, then resume when ready.');}
$('stop').onclick=perform(stop);
$('arm').onclick=perform(async()=>{ensureApplied();if(motionMappingsDirty())throw Error('Save your learned-motion mapping edits before arming output.');if(customMotions?.isLearning?.()||customMotions?.isPracticing?.())throw Error('Finish learning or stop Practice before arming live output.');if(!running&&!state.config.dry_run)throw Error('Start the camera before arming live output');await api('arm',confirmations());message(state.config.dry_run?'Dry Run armed. All output is simulated.':state.config.mode==='motion'?'Live named-motion output enabled. Escape or Pause output pauses output.':`Live camera output enabled for ${palmOutput()}. Escape or Pause output pauses output.`);});
$('manualZoom').onclick=perform(async()=>{ensureApplied();await api('manual_zoom',{value:Number($('manualValue').value),...confirmations()});message('Manual Zoom sent. Verify the beam and pink data, then test Release Zoom.');});
$('release').onclick=perform(async()=>{await api('release');message('Release requested. Confirm pink Zoom data disappears in Eos.');});
for(const which of ['Close','Far'])$('set'+which).onclick=perform(async()=>{
 if(running&&(rawDistance===null||handCount!==2))throw Error('Show two confidently tracked hands first');
 if(!running&&!$('demoHands').checked)throw Error('Show two hands or enable Dry Run simulated hands');
 cal[which.toLowerCase()]=running?rawDistance:Number($('demoDistance').value);calLabels();await changed();
});
function download(name,data,type='application/json'){
 const url=URL.createObjectURL(new Blob([data],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
$('save').onclick=()=>download('eos-lab-config.json',JSON.stringify(gather(),null,2));
$('load').onclick=()=>$('loadFile').click();
$('loadFile').onchange=perform(async()=>{const file=$('loadFile').files[0];if(!file)return;localOutputPaused=true;const s=await api('config',{config:JSON.parse(await file.text())});fill(s.config);render(s);message('Settings imported. Complete affected checks in Session before resuming.');$('loadFile').value='';});
$('downloadLog').onclick=()=>download('eos-lab-events.json',JSON.stringify(state.logs,null,2));
function pauseBrowserInput(reason){
 localOutputPaused=true;cancelPendingCamera();speech?.cancelPending?.();
 const w=state?.workflow;
 if(!token||state?.owner!==client||!w)return;
 const body=new Blob([JSON.stringify({token,client,reason,revision:w.revision,epoch:w.epoch})],{type:'application/json'});
 navigator.sendBeacon('/api/input_pause',body);
}
const hiddenPage=()=>pauseBrowserInput('Controller page hidden or closed');
window.addEventListener('pagehide',hiddenPage);
document.addEventListener('visibilitychange',()=>{if(document.hidden){demoGesture='None';customMotions?.onCameraStopped();hiddenPage();}});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){demoGesture='None';perform(workflowUI?.pause||stop)();}});
async function cameras(){const list=await navigator.mediaDevices.enumerateDevices();const selected=$('cameraSelect').value||state?.config.camera_id||savedCamera;$('cameraSelect').replaceChildren(new Option('Default camera',''));for(const d of list.filter(x=>x.kind==='videoinput'))$('cameraSelect').append(new Option(d.label||'Camera',d.deviceId));$('cameraSelect').value=[...$('cameraSelect').options].some(option=>option.value===selected)?selected:'';}
$('cameraRefresh').onclick=perform(async()=>{await cameras();const count=$('cameraSelect').options.length-1;message(`${count} video camera(s) available. Select the webcam, then Start camera.`);});
navigator.mediaDevices?.addEventListener('devicechange',()=>{cameras().catch(e=>message('Camera list refresh failed: '+e.message,true));});
function cancelPendingCamera(){if(cameraAbort&&!running){cameraEpoch++;cameraAbort.abort();}}
async function cameraStop(){localOutputPaused=true;cameraEpoch++;cameraAbort?.abort();running=false;handSelector.reset();stageInputTracker.reset();stageVision?.reset();showUI?.onVision(null);customMotions?.onCameraStopped();if(stream){stopCameraStream(stream);stream=null;}$('video').srcObject=null;$('canvas').getContext('2d').clearRect(0,0,$('canvas').width,$('canvas').height);handCount=0;rawDistance=null;$('cameraNote').textContent='Camera off';if(state?.workflow?.active)await api('camera_status',{ready:false,camera_id:$('cameraSelect').value});else await stop();workflowUI?.refresh();}
$('cameraStop').onclick=perform(cameraStop);
function poseStatus(){$('poseCalibration').textContent=`Closed fist: ${poseCalibration.Closed_Fist?'learned':'not learned'} · Open palm: ${poseCalibration.Open_Palm?'learned':'not learned'}`;}
for(const [id,name] of [['learnFist','Closed_Fist'],['learnPalm','Open_Palm']])$(id).onclick=perform(async()=>{
 if(!running||!latestInput?.features||latestInput.quality<state.config.hand_confidence)throw Error('Keep your whole hand visible in the camera before learning the pose.');
 const features=latestInput.features.slice();
 localOutputPaused=true;
 await api('stop');
 const nextCalibration=learnPose(poseCalibration,name,features);
 await api('config',{config:{...state.config,pose_calibration:nextCalibration}});
 poseCalibration=nextCalibration;browserPoseFallback={...nextCalibration};handSelector.setCalibration(poseCalibration);
 localStorage.setItem('eos-palm-calibration',JSON.stringify(poseCalibration));poseStatus();
 message(poseCalibration.Closed_Fist&&poseCalibration.Open_Palm?'Both hand poses saved. Return to Session, practice each pose in Preview and confirm its match before going live.':name==='Closed_Fist'?'Closed fist saved. Open your palm and choose Learn open palm.':'Open palm saved. Close your fist and choose Learn closed fist.');
});
$('resetPoses').onclick=perform(async()=>{localOutputPaused=true;await api('stop');await api('config',{config:{...state.config,pose_calibration:{}}});poseCalibration={};browserPoseFallback={};localStorage.removeItem('eos-palm-calibration');handSelector.setCalibration(null);poseStatus();message('Learned hand poses cleared. Preview and confirm the current poses in Session before resuming.');});
poseStatus();
$('cameraSelect').onchange=perform(async()=>{savedCamera=$('cameraSelect').value;try{localStorage.setItem('light-magic-camera',savedCamera);}catch{}const wasRunning=running;localOutputPaused=true;if(wasRunning)await cameraStop();if(state?.workflow?.active)await api('camera_status',{ready:false,camera_id:savedCamera});if(wasRunning)await startCamera();});
function startCamera(){if(running)return Promise.resolve();if(cameraStarting)return cameraStarting;const attempt=openCamera().finally(()=>{if(cameraStarting===attempt)cameraStarting=null;});cameraStarting=attempt;return attempt;}
async function openCamera(){
 if(running)return;if(!state?.workflow?.active)throw Error('Start a session before opening the camera.');
 const epoch=++cameraEpoch,abort=new AbortController();cameraAbort=abort;const signal=abort.signal,id=$('cameraSelect').value;
 const show=stageSheet();
 let acquired=null,phase='hand-tracking files';
 const ensureCurrent=()=>{if(signal.aborted||epoch!==cameraEpoch)throw new CameraStartCancelled();};
 const stage=(operation,timeoutMs,timeoutMessage,onLateValue)=>waitForCameraStage(operation,{signal,timeoutMs,timeoutMessage,onLateValue});
 try{
  if(!recognizer||recognizerForStage!==show||(show&&!stageVision)){
   recognizer?.close?.();recognizer=null;stageVision?.close();stageVision=null;stageVisionError='';
   message('Preparing hand tracking: loading bundled model files…');$('cameraNote').textContent='Loading hand-tracking files';
   const {FilesetResolver,GestureRecognizer,PoseLandmarker}=await stage(import('./assets/vision_bundle.mjs'),30000,'Hand-tracking files did not load within 30 seconds. Refresh this page and choose Start camera to retry.');ensureCurrent();
   const vision=await stage(FilesetResolver.forVisionTasks('./assets/wasm'),30000,'Hand-tracking runtime did not load. Refresh this page and choose Start camera to retry.');ensureCurrent();
   phase='hand-tracking recognizer';message('Preparing hand tracking: starting the recognizer…');$('cameraNote').textContent='Starting hand recognizer';
   recognizer=await stage(GestureRecognizer.createFromOptions(vision,{baseOptions:{modelAssetPath:'./assets/gesture_recognizer.task',delegate:'CPU'},runningMode:'VIDEO',numHands:2,minHandDetectionConfidence:show ? .55 : .75,minHandPresenceConfidence:show ? .60 : .75,minTrackingConfidence:show ? .65 : .75}),45000,'The hand recognizer did not start within 45 seconds. Refresh this page and choose Start camera to retry.',late=>late?.close?.());ensureCurrent();
   recognizerForStage=show;
   if(show){
    $('cameraNote').textContent='Loading stage body tracking';
    try{stageVision=await stage(createStageVision({vision,PoseLandmarker,GestureRecognizer}),45000,'Stage body tracking did not load.',late=>late?.close?.());ensureCurrent();}
    catch(error){if(error instanceof CameraStartCancelled)throw error;stageVisionError='Body tracking unavailable. Ankh cannot be detected; restart the camera to retry.';}
   }
  }
  phase='camera permission / opening';message('Opening camera. Allow camera permission if your browser asks. Close another camera app if the camera is busy.');$('cameraNote').textContent='Waiting for camera permission / opening';
  acquired=await stage(navigator.mediaDevices.getUserMedia({audio:false,video:{width:{ideal:show?1280:640},height:{ideal:show?720:480},...(id?{deviceId:{exact:id}}:{})}}),30000,'Camera permission or opening timed out after 30 seconds. Allow camera permission, close other camera apps, then choose Start camera to retry.',stopCameraStream);ensureCurrent();
  const activeTrack=acquired.getVideoTracks()[0];if(!activeTrack)throw Error('The selected device did not provide video. Choose another camera in Settings and retry.');
  phase='video preview';message('Camera opened. Starting the video preview…');$('cameraNote').textContent='Starting video preview';stream=acquired;$('video').srcObject=acquired;
  await stage($('video').play(),10000,'The camera opened but video did not start. Close other camera apps or choose another camera, then retry.');ensureCurrent();
  const activeSettings=activeTrack.getSettings();savedCamera=id||activeSettings.deviceId||'';try{localStorage.setItem('light-magic-camera',savedCamera);}catch{}
  phase='session camera registration';message('Video preview ready. Registering the camera with your session…');$('cameraNote').textContent='Preparing session preview';
  await stage(api('camera_status',{ready:true,camera_id:savedCamera}),10000,'The camera opened, but the session bridge did not respond. Check the local bridge and choose Start camera to retry.',()=>api('camera_status',{ready:false,camera_id:savedCamera}));ensureCurrent();
  if(activeTrack.readyState==='ended')throw Error('The camera disconnected while starting. Reconnect it and choose Start camera to retry.');
  running=true;lastVideo=-1;handSelector.reset();stageInputTracker.reset();stageVision?.reset();lastCameraCue=null;
  activeTrack.addEventListener('ended',()=>{if(running&&stream===acquired)perform(cameraStop)();});
  $('cameraNote').textContent=`${activeTrack.label||'Camera'} · ${activeSettings.width||$('video').videoWidth} × ${activeSettings.height||$('video').videoHeight} · ${stageVision?'body and hand tracking':'hand tracking'}`;
  cameras().catch(error=>message('Camera preview works, but the device list could not refresh: '+error.message,true));
  message(stageVisionError||'Camera ready. Preview sends no camera cues. Complete Session checks before going live.');requestAnimationFrame(cameraLoop);
 }catch(error){
  stopCameraStream(acquired);
  if(stream===acquired){stream=null;running=false;}
  if($('video').srcObject===acquired)$('video').srcObject=null;
  if(epoch===cameraEpoch||!running){$('cameraNote').textContent=error instanceof CameraStartCancelled?'Camera start cancelled':'Camera unavailable · retry Start camera';if(state?.workflow?.active)api('camera_status',{ready:false,camera_id:id}).catch(()=>{});}
  workflowUI?.refresh();
  if(error instanceof CameraStartCancelled)throw error;
  const hint=error.name==='NotAllowedError'?'Allow camera access in your browser, then choose Start camera.':error.name==='NotReadableError'?'Close any other app using this camera, then choose Start camera.':error.name==='OverconstrainedError'||error.name==='NotFoundError'?'Choose an available camera in Settings, then choose Start camera.':'Choose Start camera to retry.';
  throw Error('Could not complete '+phase+': '+error.message+' '+hint);
 }finally{if(cameraAbort===abort)cameraAbort=null;}
}
$('cameraStart').onclick=perform(startCamera);
function displayInput(data){
 latestInput=data;
 $('gesture').textContent=gestureLabel(data.gesture);$('confidence').textContent=Math.round(data.confidence*100)+'% '+(data.scoreLabel||'gesture confidence');
 $('cameraDebug').textContent=`${data.handCount??data.hands.length} hand(s) detected · ${data.method||'Mouse demo'}\n${data.debug||''}`;
 const m=state.config.mappings.find(x=>x.gesture===data.gesture),mapped=outputLabel(m);
 $('mapped').textContent=state.config.mode==='motion'?'Named-motion output · basic pose cues paused':
  data.gesture==='Fire_Gesture'&&!m?.enabled?'Fire shape recognized · assign and enable its output':
  m&&data.confidence>=m.confidence?(mapped?(m.enabled?`→ ${mapped}`:'Detected · output disabled'):'Detected · output unassigned'):
  data.tracking_uncertain?'Hold or reframe for a clearer reading':'No mapped pose';
 if(!state.armed&&data.distance!==null)$('zoomReadout').textContent=`Raw hand distance ${data.distance.toFixed(3)} · ${data.hands.length} hands`;
 refreshDiagnostics();
}
let rejectedFrameEpoch=null;
async function sendFrame(data){
 const w=state?.workflow;
 if(!w?.active||state.owner!==client||state.config.input_source==='speech'||document.hidden||busy||performance.now()-lastFrameSent<65||data.source!=='camera')return;
 const frameEpoch=`${token}:${w.revision}:${w.epoch}`;
 if(frameEpoch===rejectedFrameEpoch)return;
 const live=w.state==='live';
 if(live&&(localOutputPaused||operationalDirty||motionMappingsDirty()||learningBlock||customMotions?.isLearning?.()||customMotions?.isPracticing?.()))return;
 data={...data,revision:w.revision,epoch:w.epoch};
 if(!live)data.motion_candidate=null;
 if(!w.rehearsal||state.armed)data.motion_preview=null;
 busy=true;lastFrameSent=performance.now();
 if(data.motion_candidate)customMotions?.consumeOutput?.();
 if(data.motion_practice)customMotions?.consumePracticeEvidence?.();
 if(data.motion_preview)customMotions?.consumeMotionPreview?.();
 try{await api('frame',data);}
 catch(e){
  rejectedFrameEpoch=frameEpoch;
  try{await refreshBridgeState();}catch{}
  if(state?.owner!==client){message('Browser control ended. Start the console session here to reconnect.');return;}
  const current=state.workflow;
  if(frameEpoch===`${token}:${current?.revision}:${current?.epoch}`){
   message('Camera frame rejected: '+e.message,true);
   pauseBrowserInput('Camera frame rejected: '+e.message);
  }
 }finally{busy=false;}
}
function cameraLoop(){
 if(!running)return;
 try{
 const video=$('video');
 if(video.readyState>=2&&video.currentTime!==lastVideo){
  lastVideo=video.currentTime;
  const now=performance.now(),show=stageSheet(),tracker=show?stageVision:null;
  const trackBody=state.config.mode==='cue'&&state.config.mappings.some(mapping=>mapping.enabled&&mapping.gesture==='Ankh_Pose');
  const report=tracker?.process(video,now,recognizer,{trackBody});
  if(tracker&&!report){requestAnimationFrame(cameraLoop);return;}
  const result=report?.result||recognizer.recognizeForVideo(video,now);
  const visionReport=report||(show?{diagnostics:{poseState:'unavailable',handMode:result.landmarks?.length?'full frame':'none'},ankh:{reason:stageVisionError}}:null);
  showUI?.onVision(visionReport);
  customMotions?.onFrame(result,now);
  const canvas=$('canvas');if(canvas.width!==video.videoWidth)canvas.width=video.videoWidth;if(canvas.height!==video.videoHeight)canvas.height=video.videoHeight;
  const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);
  const pose=report?.ankh?.landmarks;
  if(pose){
   ctx.strokeStyle=report.ankh.active?'#fff':'#a8a8a8';ctx.lineWidth=report.ankh.active?4:3;
   for(const [a,b] of [[11,12],[11,13],[13,15],[12,14],[14,16]]){
    if(![pose[a],pose[b]].every(p=>p&&p.visibility>=.48))continue;
    ctx.beginPath();ctx.moveTo(pose[a].x*canvas.width,pose[a].y*canvas.height);
    ctx.lineTo(pose[b].x*canvas.width,pose[b].y*canvas.height);ctx.stroke();
   }
  }
  const landmarks=result.landmarks||[];
  for(const hand of landmarks){ctx.fillStyle='#eee';for(const p of hand){ctx.beginPath();ctx.arc(p.x*canvas.width,p.y*canvas.height,3,0,Math.PI*2);ctx.fill();}}
  // Presence/detection/tracking thresholds are enforced inside MediaPipe; handedness
  // confidence is an additional per-hand quality filter, not a presence probability.
  const hands=landmarks.map((_,i)=>({confidence:result.handedness[i]?.[0]?.score||0}));
  handCount=hands.filter(h=>h.confidence>=state.config.hand_confidence).length;
  rawDistance=null;
  if(landmarks.length===2&&handCount===2){const a=landmarks[0][9],b=landmarks[1][9];rawDistance=Math.hypot((a.x-b.x)*canvas.width,(a.y-b.y)*canvas.height)/Math.hypot(canvas.width,canvas.height);}
  let selected=handSelector.update(result,state.config,now,video.videoWidth/video.videoHeight);
  const c=state.config;
  if(show)selected=stageInputTracker.update(selected,visionReport,now,
   {waitingForNeutral:state.armed&&state.workflow?.fresh_gesture_required});
  const armsOpen=armsHeld=armsState(armsHeld,rawDistance,c.close,c.far);
  const armsEnabled=c.mappings.some(m=>m.enabled&&m.gesture==='Arms_Open');
  const motionOutput=customMotions?.getOutput()||{};
  const data={...selected,source:'camera',stage_ready:!!report&&!['unavailable','disabled'].includes(report.diagnostics.poseState),gesture:armsEnabled&&armsOpen?'Arms_Open':selected.gesture,confidence:armsEnabled&&armsOpen?Math.min(...hands.map(h=>h.confidence)):selected.confidence,hands,distance:rawDistance,motion_candidate:motionOutput.motionCandidate||null,motion_practice:motionOutput.motionPractice||null,motion_preview:motionOutput.motionPreview||null};
  displayInput(data);sendFrame(data);
 }
 }catch(e){message('Camera error: '+e.message,true);running=false;pauseBrowserInput('Camera error: '+e.message);if(stream)stopCameraStream(stream);stream=null;stageVision?.close();stageVision=null;showUI?.onVision(null);if(state?.workflow?.active&&state.owner===client)api('camera_status',{ready:false,camera_id:$('cameraSelect').value}).catch(()=>{});workflowUI?.refresh();}
 if(running)requestAnimationFrame(cameraLoop);
}
for(const name of ['Arms_Open','Open_Palm','Closed_Fist','Thumb_Up','Victory']){
 const b=document.createElement('button');b.textContent=name.replace('_',' ');
 b.onpointerdown=e=>{if(!state.config.dry_run||running)return;demoGesture=name;b.setPointerCapture(e.pointerId);b.classList.add('held');};
 const reset=()=>{demoGesture='None';b.classList.remove('held');};b.onpointerup=reset;b.onpointercancel=reset;b.onlostpointercapture=reset;$('demoGestures').append(b);
}
setInterval(()=>{if(!running&&state?.config.dry_run){const hands=$('demoHands').checked?[{confidence:1},{confidence:1}]:[];const data={source:'demo',gesture:demoGesture,confidence:demoGesture==='None'?0:1,hands,distance:Number($('demoDistance').value)};displayInput(data);sendFrame(data);}},80);
const librarySaved=s=>{if(!dirty)fill(s.config);render(s);};
customMotions=mountCustomMotions({api,getState:()=>state,isCameraRunning:()=>running,confirmations,notify:message,onConfigApplied:librarySaved,onLibrarySaved:librarySaved,openTarget:id=>workflowUI.openTarget(id),onLearningChanged:active=>{learningBlock=active;if(active)localOutputPaused=true;workflowUI?.refresh();}});
speech=mountSpeech({api,getState:()=>state,client,notify:message,onEdited:event=>changed(event).catch(error=>message(error.message,true)),saveSettings,openTarget:id=>{ensureApplied();workflowUI.openTarget(id);},setInputSource,ensureSaved:ensureApplied,pauseOutputLocal:()=>{localOutputPaused=true;cancelPendingCamera();},onRunningChanged:()=>workflowUI?.refresh(),hasOperationalEdits:()=>operationalDirty||motionMappingsDirty(),hasOutputBlock:()=>localOutputPaused||operationalDirty||motionMappingsDirty()||learningBlock||!!customMotions?.isLearning?.()||!!customMotions?.isPracticing?.()});
async function setInputSource(inputSource){
 if(dirty)await saveSettings();if(state?.owner!==client)await api('claim');localOutputPaused=true;cancelPendingCamera();
 if(inputSource==='speech'&&running)await cameraStop();if(inputSource==='camera'&&speech.isRunning())await speech.stop();
 const result=await api('config',{config:{...state.config,input_source:inputSource}});fill(result.config);render(result);message('Input source saved. Complete any affected checks in Session before going live.');
}
workflowUI=mountWorkflow({api,getState:()=>state,client,isCameraRunning:()=>running,startCamera,isMicrophoneRunning:()=>speech.isRunning(),startMicrophone:()=>speech.start(),setInputSource,hasOperationalEdits:()=>operationalDirty||motionMappingsDirty(),saveSettings,pauseLocal:()=>{localOutputPaused=true;cancelPendingCamera();speech?.cancelPending?.();},resumeLocal:()=>{localOutputPaused=false;handSelector.reset();stageInputTracker.reset();stageVision?.reset();customMotions?.resetRecognition?.();speech?.resetCapture?.();},isLearning:()=>!!customMotions?.isLearning?.(),isPracticing:()=>!!customMotions?.isPracticing?.(),onView:view=>{sessionLayout.setView(view);if(view!=='learn')customMotions?.leaveLearning?.();refreshStagePreview();},notify:message});
async function switchCueSheet(action){
 if(dirty)await saveSettings();
 if(state?.owner!==client)await api('claim');
 const previousSheet=state.config.cue_sheet;
 const {revision,epoch}=state.workflow,wasRunning=running;
 const result=await api(action,{revision,epoch});
 fill(result.config);render(result);
 if(wasRunning&&previousSheet!==result.config.cue_sheet){await cameraStop();await startCamera();}
 const messages={
  load_cue_sheet:'Show cue sheet loaded. Assign cues when ready, or start rehearsal.',
  restore_cue_sheet:'Previous setup restored. Both cue sheets are saved on this laptop.',
  load_channel_looks:'Channel looks saved. Start rehearsal to try the mapped gestures and phrases.',
  undo_channel_looks:'Earlier camera and speech assignments restored.'
 };
 message(messages[action]);
}
function selectedChannelLook(){
 return channelLooks.find(look=>look.id===$('directLookChoice').value);
}
function updateChannelLookControls(){
 const canPreview=!!state?.workflow&&!state.armed&&!changingLooks;
 const canChange=canPreview&&state.channel_looks_supported&&(!state.owner||state.owner===client);
 $('previewDirectLook').disabled=!canPreview||!selectedChannelLook();
 $('loadDirectLooks').disabled=!canChange||!channelLooks.length;
 $('undoDirectLooks').hidden=!state?.channel_look_backup;
 $('undoDirectLooks').disabled=!canChange;
}
async function loadChannelLookPreviews(){
 const choice=$('directLookChoice');
 try{
  const response=await fetch(new URL('./assets/movement-lab-channel-looks.json',import.meta.url));
  if(!response.ok)throw Error('Channel looks unavailable');
  channelLooks=(await response.json()).looks;
  choice.replaceChildren(...channelLooks.map(look=>new Option(`${look.name} · ${look.inputs}`,look.id)));
  choice.disabled=!channelLooks.length;
  choice.onchange=()=>{
   $('directLookDescription').textContent=selectedChannelLook()?.description||'';
   updateChannelLookControls();
  };
  choice.onchange();
 }catch{
  $('directLookDescription').textContent='The Movement Lab looks could not load.';
 }
}
function reviewChannelLookChange(action){
 const restore=action==='undo_channel_looks';
 channelLookAction=action;
 $('directLookTitle').textContent=restore?'Restore earlier assignments?':'Use the Movement Lab looks?';
 $('directLookDetails').textContent=restore?
  'This restores the camera and speech assignments from before the looks were loaded.':
  'This replaces camera and speech assignments with the Movement Lab looks and saves a copy of your earlier assignments. Check the console patch before testing live.';
 $('directLookConfirm').textContent=restore?'Restore assignments':'Use these looks';
 $('directLookDialog').showModal();
}
$('previewDirectLook').onclick=()=>{
 const look=selectedChannelLook();
 if(look&&!$('previewDirectLook').disabled)previewFixtureOnStage({output_type:'channel_look',channels:look.channels},'preset',look.name);
};
$('loadDirectLooks').onclick=()=>reviewChannelLookChange('load_channel_looks');
$('undoDirectLooks').onclick=()=>reviewChannelLookChange('undo_channel_looks');
$('directLookConfirm').onclick=perform(async()=>{
 if(!channelLookAction||changingLooks)return;
 const action=channelLookAction;
 channelLookAction=null;changingLooks=true;
 $('directLookDialog').close();
 updateChannelLookControls();
 try{await switchCueSheet(action);}
 finally{changingLooks=false;updateChannelLookControls();}
});
void loadChannelLookPreviews();
showUI=mountShowUI({getState:()=>state,showView:view=>workflowUI.showView(view),
 loadPreset:()=>switchCueSheet('load_cue_sheet'),restorePreset:()=>switchCueSheet('restore_cue_sheet'),
 notify:message,hasOperationalEdits:()=>operationalDirty||motionMappingsDirty()});
channelLevel=mountChannelLevel({api,getState:()=>state,client,
 hasOperationalEdits:()=>operationalDirty||motionMappingsDirty(),
 pauseLocal:()=>{localOutputPaused=true;},
 openSession:()=>workflowUI.showView('session'),previewOnStage:previewFixtureOnStage});
let polling=false;
setInterval(async()=>{
 if(polling||document.hidden)return;
 polling=true;
 try{
  if(state?.owner===client){
   try{await api('heartbeat');}catch{await refreshBridgeState();}
  }else await refreshBridgeState();
 }catch{
  $('state').textContent='Bridge unavailable';
  message('Bridge unreachable. Output watchdog should release; check Eos.',true);
 }finally{polling=false;}
},400);
try{const r=await fetch('/api/state');const s=await r.json();token=s.token;fill(s.config);render(s);await cameras();await speech.devices();}catch(e){message(e.message,true);}
