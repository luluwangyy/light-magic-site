import {extractMotionFrame, createMotionTemplate, MotionMatcher} from './motion-learning.mjs';
import {appendOutputFields,bindColorPicker,mergeMappingDraft,mountChannelLookEditor,outputKind,outputLabel,outputType,savedOutputTarget,setChannelLookEditorDisabled} from './mapping-output.mjs';

const $=id=>document.getElementById(id);
const clone=value=>JSON.parse(JSON.stringify(value));
const cuePattern=/^[0-9]{1,5}(?:\.[0-9]{1,3})?$/;
const editorFields={name:'motionName',output_type:'motionOutputType',cue_list:'motionCueList',cue:'motionCue',channel:'motionChannel',level:'motionLevel',zoom:'motionZoom',color:'motionColor'};
const cueFields=['motionCueList','motionCue'];
const fixtureFields=['motionChannel','motionLevel','motionZoom','motionColor'];

export function mountCustomMotions({api,getState,isCameraRunning,notify,onLibrarySaved,onSelectLearnedMode,onLearningChanged,openTarget}) {
 let signature='',selectedId='',stage=null,timer=null,samples=[],lastValid=0,lastSample=0,pending=null;
 let practiceId=null,previewMatches=0,lastOutput=null,lastOutputTime=0,lastMatchTime=0,lastAnalyze=0,undo=null;
 let lastMotionPreview=null,lastMotionPreviewTime=0;
 let lastWorkflowKey='',lastMode='',wasLive=false,enforcingPause=false,pausePending=false,savePending=false,lastBusy=false;
 let practiceEvidence=null,practiceEvidenceTime=0,practiceRequest=0,recordingRequest=0,disposed=false;
 const outputMatcher=new MotionMatcher(),previewMatcher=new MotionMatcher();
 const motions=()=>getState()?.config.custom_motions||[];
 const workflow=()=>getState()?.workflow;
 const isLive=()=>workflow()?.active?workflow().state==='live':!!getState()?.armed;
 const isRehearsing=()=>workflow()?.active&&workflow().rehearsal&&!isLive();
 const busy=()=>!!stage||!!practiceId||pausePending||savePending;
 const say=(text,error=false)=>{$('customMotionStatus').textContent=text;$('customMotionStatus').classList.toggle('motion-error',error);notify?.(text,error);};
 const wrap=fn=>async()=>{try{await fn();}catch(error){say(error.message,true);}};
 const sourceName=id=>motions().find(m=>m.id===id)?.name||'Learned motion';
 const syncEditorColor=bindColorPicker($('motionColor'),$('motionColorPicker'));
 const lookEditor=mountChannelLookEditor($('motionEditor'),$('motionChannelLook'));

 function rowDraft(row,motion,validate=false){
  const draft=mergeMappingDraft(row,motion,motion,{validate});
  draft.name=draft.name.trim();
  if(typeof draft.cue==='string')draft.cue=draft.cue.trim();
  return draft;
 }
 function rowChanged(row,motion,includeName=true){
  const draft=rowDraft(row,motion);
  return Object.keys(draft).some(key=>(includeName||key!=='name')&&draft[key]!==motion[key]);
 }
 function hasUnsavedChanges(){
  return [...$('customMotionRows').children].some(row=>{const motion=motions().find(m=>m.id===row.dataset.motionId);return motion&&rowChanged(row,motion);});
 }
 function hasOutputChanges(){
  return [...$('customMotionRows').children].some(row=>{const motion=motions().find(m=>m.id===row.dataset.motionId);return motion&&rowChanged(row,motion,false);});
 }
 // A library save briefly blocks candidates, but a label-only save must not
 // latch the main session's output pause. Only recording/practice requests do.
 function reportBusy(){const next=!!stage||!!practiceId||pausePending;if(next!==lastBusy){lastBusy=next;onLearningChanged?.(next);}}
 function resetRecognition(){
  lastOutput=null;lastMotionPreview=null;practiceEvidence=null;practiceEvidenceTime=0;outputMatcher.reset();previewMatcher.reset();lastAnalyze=0;
  previewMatches=0;lastMatchTime=0;$('motionSimilarity').value=0;
 }
 function setPracticeMatchers(){
  if(!practiceId)return;
  // Competing enabled triggers remain in practice, so overlap cannot earn proof.
  previewMatcher.setMotions(clone(motions().filter(m=>m.enabled||m.id===practiceId)).map(m=>({...m,enabled:true})));
 }
 async function pauseOutput(reason){
  pausePending=true;resetRecognition();reportBusy();updateControls();
  try{return await api('pause',{reason});}
  finally{pausePending=false;reportBusy();updateControls();}
 }
 function mappingEdited(){
  if(!hasOutputChanges())return;
  resetRecognition();
  if(getState()?.config.mode!=='motion')return;
  $('arm').disabled=true;
  if(isLive()&&!enforcingPause){
   enforcingPause=true;
   pauseOutput('Learned-motion mapping edited').then(()=>say('Output paused. Save the changed mapping, practise it, and check its output before going live.')).catch(error=>say(error.message,true)).finally(()=>{enforcingPause=false;});
  }
 }
 function updatePracticeConfirmation(){
  const button=$('motionConfirmPractice');if(!button)return;
  const receipt=workflow()?.needs_practice?.find(item=>item.id===practiceId);
  button.disabled=!practiceId||!!stage||pausePending||savePending||!receipt?.observed;
  button.textContent=practiceId&&!receipt&&workflow()?.active?'Practice up to date':receipt?.observed?'Confirm this motion worked':'Match the motion to confirm practice';
 }
 function updateControls(){
  const editing=!!stage||pausePending||savePending;
  for(const id of [...Object.values(editorFields),'motionSelect','motionColorPicker','motionDuration','motionLearn','motionPractice','motionUseMode'])$(id).disabled=editing;
  lookEditor.setDisabled(editing);
  $('motionCancel').hidden=!stage;$('motionUndo').hidden=!undo;
  for(const control of $('customMotionRows').querySelectorAll('button,input,select'))control.disabled=editing;
  for(const row of $('customMotionRows').children)setChannelLookEditorDisabled(row,editing);
  for(const button of $('customMotionRows').querySelectorAll('[data-test-motion]')){
   const motion=motions().find(item=>item.id===button.dataset.testMotion);
   button.disabled=editing||!savedOutputTarget(getState(),motion);
  }
  for(const button of $('customMotionRows').querySelectorAll('[data-confirm-motion]')){
   const motion=motions().find(item=>item.id===button.dataset.confirmMotion);
   const target=savedOutputTarget(getState(),motion);
   button.disabled=editing||!target?.sent||target.confirmed;
  }
  updatePracticeConfirmation();reportBusy();
 }
 function stopTimer(){if(timer){clearInterval(timer);timer=null;}}
 function cancelRecording(reason='Learning cancelled. No example was saved.'){
  if(!stage)return;
  const saving=stage==='saving';recordingRequest++;
  stopTimer();stage=null;pending=null;samples=[];resetRecognition();
  $('motionRecordProgress').value=0;updateControls();say(saving?'The save is already in progress. Practice will stay stopped when it finishes.':reason,true);
 }
 function stopPractice(reason='Practice stopped. No cues were sent.'){
  practiceRequest++;practiceId=null;resetRecognition();$('motionPracticeResult').textContent=reason;updateControls();
 }
 function showEditorOutput(){
  const type=$('motionOutputType').value;
  const fixture=type==='channel_level';
  for(const id of cueFields){$(id).hidden=type!=='cue';$(id+'Field').hidden=type!=='cue';}
  for(const id of fixtureFields){$(id).hidden=!fixture;$(id+'Field').hidden=!fixture;}
  $('motionChannelLook').hidden=type!=='channel_look';
 }
 function selectMotion(id){
  if(practiceId&&id!==practiceId)stopPractice();
  selectedId=id||'';const found=motions().find(m=>m.id===selectedId);
  for(const [field,inputId] of Object.entries(editorFields)){
   $(inputId).value=field==='output_type'?outputType(found):found?.[field]??(field==='cue_list'?1:'');
  }
  syncEditorColor();lookEditor.set(found?.channels);showEditorOutput();
  $('motionDuration').value=found?.templates?.[0]?.duration_s?Math.min(6,Math.max(1,Number(found.templates[0].duration_s).toFixed(1))):3;
  $('motionExampleCount').textContent=found?`${found.templates.length} / 3 examples learned. Learn again to add another demonstration.`:'Name the new trigger and choose its output.';
  updatePracticeConfirmation();
 }
 function validateMeta(draft,id=''){
  const name=String(draft.name??'').trim(),cue=String(draft.cue??'').trim();
  if(!name||name.length>80)throw Error('Enter a trigger name of 1–80 characters.');
  if(motions().some(m=>m.id!==id&&m.name.toLocaleLowerCase()===name.toLocaleLowerCase()))throw Error('Choose a different trigger name; this name is already used.');
  if(outputType(draft)==='cue'){
   const list=draft.cue_list;
   if(!Number.isInteger(list)||list<1||list>999)throw Error('Enter a valid cue list number.');
   if(!cuePattern.test(cue)||Number(cue)<=0)throw Error('Enter an existing cue number for this named trigger.');
  }else if(!outputLabel(draft)){
   throw Error(outputType(draft)==='channel_look'?'Add at least one channel to this look.':'Choose a channel and enter intensity, zoom, or a color such as #e07822.');
  }
  return {...draft,name,cue};
 }
 async function applyMotions(next,extra={}){
  savePending=true;stopPractice();resetRecognition();updateControls();
  try{
   // Save only the library change. The bridge retains unrelated setup checks.
   const result=await api('config',{config:{...getState().config,...extra,custom_motions:next}});
   onLibrarySaved?.(result);onState(result);return result;
  }finally{savePending=false;updateControls();}
 }
 function input(type,value,label){const el=document.createElement('input');el.type=type;el.setAttribute('aria-label',label);if(type==='checkbox')el.checked=!!value;else el.value=value;return el;}
 function renderRows(){
  const rows=$('customMotionRows');rows.replaceChildren();const select=$('motionSelect');select.replaceChildren(new Option('＋ New trigger',''));
  for(const motion of motions()){
   select.append(new Option(motion.name,motion.id));
   const row=document.createElement('tr');row.dataset.motionId=motion.id;
   const enabled=input('checkbox',motion.enabled,`Enable ${motion.name}`),name=input('text',motion.name,`Trigger name: ${motion.name}`);name.maxLength=80;
   enabled.dataset.field='enabled';name.dataset.field='name';
   for(const element of [enabled,name]){
    const cell=document.createElement('td');cell.append(element);row.append(cell);
   }
   appendOutputFields(row,motion,motion.name);
   const threshold=input('number',motion.threshold,`Similarity threshold: ${motion.name}`);
   threshold.dataset.field='threshold';threshold.min=.7;threshold.max=.98;threshold.step=.01;
   const thresholdCell=document.createElement('td');thresholdCell.append(threshold);row.append(thresholdCell);
   row.oninput=mappingEdited;
   const count=document.createElement('td');count.textContent=String(motion.templates.length);row.append(count);
   const actions=document.createElement('td');actions.className='motion-actions';
   const addButton=(text,fn)=>{const b=document.createElement('button');b.textContent=text;b.onclick=wrap(fn);actions.append(b);return b;};
   addButton('Save mapping',async()=>{
    const updated=validateMeta(rowDraft(row,motion,true),motion.id);
    if(!Number.isFinite(updated.threshold)||updated.threshold<.7||updated.threshold>.98)throw Error('Similarity must be between 0.70 and 0.98.');
    selectedId=motion.id;
    await applyMotions(motions().map(m=>m.id===motion.id?updated:m));selectMotion(selectedId);
    say(`Saved ${updated.name}. Follow the session checks for any changed output.`);
   });
   addButton('Practice',async()=>{select.value=motion.id;selectMotion(motion.id);await startPractice(motion.id);});
   const kind=outputKind(motion);
   const test=addButton(kind==='look'?'Review look':`Test ${kind}`,async()=>{
    if(rowChanged(row,motion))throw Error('Save this mapping before testing its output.');
    stopPractice();await pauseOutput('Manual learned-motion output test');
    const target=savedOutputTarget(getState(),motion),session=workflow();
    if(!target)throw Error('Enable this mapping and start a console session to test it.');
    if(kind==='look')return openTarget(target.id);
    await api('test_target',{id:target.id,revision:session.revision,epoch:session.epoch});
    say(`Test sent for ${motion.name}. Confirm the visible result for ${outputLabel(target)||outputLabel(motion)}.`);
   });test.dataset.testMotion=motion.id;
   const confirm=addButton(kind==='cue'?'Cue worked':'Output worked',async()=>{
    if(rowChanged(row,motion))throw Error('Save this mapping before confirming the result.');
    const session=workflow();
    const target=savedOutputTarget(getState(),motion);
    if(!target?.sent)throw Error('Test the saved output before confirming its visible result.');
    await api('confirm_target',{id:target.id,worked:true,revision:session.revision,epoch:session.epoch});
    say(`Confirmed ${outputLabel(target)||outputLabel(motion)}.`);
   });confirm.dataset.confirmMotion=motion.id;
   addButton('Add example',async()=>{select.value=motion.id;selectMotion(motion.id);$('motionLearn').focus();say(`Selected ${motion.name}. Repeat the same motion and press Learn demonstration.`);});
   addButton('Delete',async()=>{
    const removed=clone(motion);await applyMotions(motions().filter(m=>m.id!==motion.id));undo=removed;
    if(selectedId===motion.id){selectedId='';selectMotion('');}updateControls();say(`Deleted ${removed.name}. Undo delete is available.`);
   });
   const receipt=document.createElement('small');receipt.dataset.testedId=motion.id;receipt.className='motion-test-receipt';actions.append(receipt);
   row.append(actions);rows.append(row);
  }
  if(!motions().length){const row=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=8;cell.textContent='No custom motions learned yet.';row.append(cell);rows.append(row);}
  if(!motions().some(m=>m.id===selectedId))selectedId='';select.value=selectedId;updateControls();
 }
 function onState(state){
  const modeChanged=lastMode!==state.config.mode,session=state.workflow;
  const key=session?`${session.revision}:${session.epoch}:${Boolean(session.rehearsal)}`:'';
  const live=session?.active?session.state==='live':!!state.armed;
  if(key!==lastWorkflowKey||modeChanged||(wasLive&&!live))resetRecognition();
  lastWorkflowKey=key;lastMode=state.config.mode;wasLive=live;
  if(modeChanged&&practiceId)stopPractice('Practice stopped because the output preset changed.');
  if(live&&(stage||practiceId||pausePending)&&!enforcingPause){
   enforcingPause=true;
   pauseOutput('Learning or practice requires paused output').catch(error=>say(error.message,true)).finally(()=>{enforcingPause=false;});
  }
  const nextSignature=JSON.stringify(state.config.custom_motions||[]);
  if(nextSignature!==signature){
   signature=nextSignature;outputMatcher.setMotions(clone(motions()));
   if(practiceId&&!motions().some(m=>m.id===practiceId))stopPractice('This motion was removed from the library.');
   else setPracticeMatchers();
   lastOutput=null;lastMotionPreview=null;renderRows();
  }
  for(const receipt of $('customMotionRows').querySelectorAll('[data-tested-id]')){
   const motion=motions().find(m=>m.id===receipt.dataset.testedId),target=savedOutputTarget(state,motion);
   receipt.textContent=target?.confirmed?'Output confirmed':target?.sent?'Test sent · confirm the visible result':'Check this output in the session before going live';
  }
  $('customMotionMode').textContent=state.config.mode==='motion'?`${live?'Live':session?.state==='paused'?'Paused':'Preview'} · learned-motion preset`:'Learning and practice keep your current preset. Choose the learned-motion preset explicitly when ready.';
  if(busy())$('arm').disabled=true;
  updateControls();
 }
 async function startPractice(id){
  if(stage)return;
  if(!isCameraRunning())throw Error('Start the camera before practising a motion.');
  const motion=motions().find(m=>m.id===id);if(!motion)throw Error('Select a learned trigger to practise.');
  if(hasUnsavedChanges())throw Error('Save mapping edits before practising the saved motion.');
  const request=++practiceRequest;
  await pauseOutput(`Practising ${motion.name}`);
  if(request!==practiceRequest||disposed||document.hidden||!isCameraRunning())return;
  practiceId=id;resetRecognition();setPracticeMatchers();updateControls();
  $('motionPracticeResult').textContent=`Practice only: ${motion.name}. No cue will be sent.`;
  say(`Practice ${motion.name}. Perform the whole recorded motion, then confirm the match. Practice sends no cues.`);
 }
 async function confirmPractice(){
  const session=workflow(),id=practiceId,receipt=session?.needs_practice?.find(item=>item.id===id);
  if(!id||!receipt?.observed)throw Error('Perform a matching motion first. Wait for the bridge to receive it, then confirm practice.');
  await api('practice_confirm',{id,revision:session.revision,epoch:session.epoch,observed:true});
  say(`Practice confirmed for ${sourceName(id)}. Follow the remaining session checks before going live.`);
  updatePracticeConfirmation();
 }
 async function finishRecording(){
  if(stage!=='recording')return;
  const meta=pending;stage='saving';stopTimer();updateControls();
  try{
   const template=createMotionTemplate(samples),existing=motions().find(m=>m.id===meta.id);
   const entry={id:meta.id,...meta.meta,enabled:false,threshold:existing?.threshold??.85,cooldown_s:existing?.cooldown_s??2,feature_version:'hand-v1',templates:[...(existing?.templates||[]),template]};
   selectedId=entry.id;await applyMotions(existing?motions().map(m=>m.id===entry.id?entry:m):[...motions(),entry]);
   if(meta.request!==recordingRequest||disposed||document.hidden||!isCameraRunning()){
    if(pending?.request===meta.request){stage=null;pending=null;samples=[];updateControls();}
    return;
   }
   stage=null;pending=null;samples=[];$('motionRecordProgress').value=1;updateControls();selectMotion(selectedId);await startPractice(selectedId);
   say(`Learned ${entry.name} (${entry.templates.length} example${entry.templates.length===1?'':'s'}). Saved disabled. Practise now; 2–3 examples help cover natural variation. Your current preset is unchanged.`);
  }catch(error){stage=null;pending=null;samples=[];updateControls();say(error.message,true);}
 }
 async function startRecording(){
  if(stage||pausePending||savePending)return;if(!isCameraRunning())throw Error('Start the camera before learning a motion.');
  const meta=validateMeta(mergeMappingDraft($('motionEditor'),{},{}),selectedId),duration=Number($('motionDuration').value);
  if(!Number.isFinite(duration)||duration<1||duration>6)throw Error('Choose a recording length from 1 to 6 seconds.');
  const existing=motions().find(m=>m.id===selectedId);
  if(existing?.templates.length>=3)throw Error('This trigger already has three examples. Create another trigger to learn a different motion.');
  if(!existing&&motions().length>=20)throw Error('The local library supports up to 20 named triggers.');
  stopPractice();const request=practiceRequest;await pauseOutput('Recording a learned motion');
  if(request!==practiceRequest||disposed||document.hidden||!isCameraRunning())return;
  pending={id:existing?.id||'motion_'+crypto.randomUUID(),meta,duration,start:performance.now()+2000,request:++recordingRequest};
  stage='countdown';samples=[];lastValid=0;lastSample=0;$('motionRecordProgress').value=0;updateControls();
  say('Learning starts in 2 seconds. Keep your hand(s) in view and get ready. Lighting output is paused.');
  timer=setInterval(()=>{
   if(!stage)return;
   if(!isCameraRunning()||document.hidden){cancelRecording('Learning stopped because the camera or controller tab became unavailable.');return;}
   const now=performance.now();
   if(stage==='countdown'){
    const remaining=Math.max(0,(pending.start-now)/1000);$('motionRecordState').textContent=remaining>0?`Get ready… ${Math.ceil(remaining)}`:'Recording — perform your motion now';
    if(now>=pending.start){stage='recording';lastValid=now;lastSample=0;samples=[];say(`Recording ${meta.name}. Perform the full motion now.`);}
   }else if(stage==='recording'){
    const elapsed=(now-pending.start)/1000;$('motionRecordState').textContent=`Recording ${elapsed.toFixed(1)} / ${pending.duration.toFixed(1)} seconds`;
    $('motionRecordProgress').value=Math.min(1,elapsed/pending.duration);
    if(now-lastValid>350){cancelRecording('Hand tracking was lost. No example was saved. Keep the hand(s) in view and try Learn again.');return;}
    if(elapsed>=pending.duration)finishRecording();
   }
  },80);
 }
 function onFrame(rawResult,nowMs){
  const state=getState();if(!state||disposed)return;
  const features=extractMotionFrame(rawResult,state.config.hand_confidence||.75);
  if(!features){lastOutput=null;lastMotionPreview=null;}
  if(stage==='recording'){if(features){lastValid=nowMs;if(nowMs-lastSample>=65&&nowMs<=pending.start+pending.duration*1000){samples.push({timeMs:nowMs,features});lastSample=nowMs;}}return;}
  if(stage||pausePending||savePending||nowMs-lastAnalyze<100)return;lastAnalyze=nowMs;
  if(practiceId){
   const result=previewMatcher.update(features,nowMs),best=result.best;$('motionSimilarity').value=best?.similarity||0;
   const matched=result.candidate?.id===practiceId&&!result.ambiguous;
   if(matched){
    previewMatches++;lastMatchTime=nowMs;
    const session=workflow();
    practiceEvidence={id:practiceId,similarity:result.candidate.similarity,revision:session?.revision,epoch:session?.epoch};practiceEvidenceTime=nowMs;
   }
   $('motionPracticeResult').textContent=result.ambiguous?'Similar motions overlap. Make them more distinct before confirming practice.':`${previewMatches&&nowMs-lastMatchTime<1800?'Matched · ':''}${sourceName(practiceId)} · ${Math.round((best?.similarity||0)*100)}% similarity · ${previewMatches} match${previewMatches===1?'':'es'} · practice only, no cue sent`;
  }else if(state.config.mode==='motion'&&(isLive()||isRehearsing())){
   const result=outputMatcher.update(features,nowMs),best=result.best;$('motionSimilarity').value=best?.similarity||0;
   $('motionPracticeResult').textContent=result.ambiguous?'Similar motions overlap. No cue sent. Make these motions more distinct or disable one.':best?`Watching ${best.name}: ${Math.round(best.similarity*100)}% similarity${result.candidate?' · motion recognised':''}`:'Waiting for a learned motion';
   if(result.candidate){
    const candidate={id:result.candidate.id,similarity:result.candidate.similarity};
    if(isLive()){lastOutput=candidate;lastOutputTime=nowMs;}
    else {lastMotionPreview=candidate;lastMotionPreviewTime=nowMs;}
   }
  }
 }
 function getOutput(){
  const state=getState(),session=workflow(),now=performance.now();
  if(practiceEvidence&&(now-practiceEvidenceTime>1500||practiceEvidence.revision!==session?.revision||practiceEvidence.epoch!==session?.epoch))practiceEvidence=null;
  const changed=hasOutputChanges();
  const motionPractice=practiceId&&!stage&&!pausePending&&!savePending&&!isLive()&&!changed&&practiceEvidence?{id:practiceEvidence.id,similarity:practiceEvidence.similarity}:null;
  const matching=state?.config.mode==='motion'&&!busy()&&!changed;
  if(!matching||!isLive()||now-lastOutputTime>500)lastOutput=null;
  if(!matching||!isRehearsing()||now-lastMotionPreviewTime>500)lastMotionPreview=null;
  const candidate=lastOutput;
  return {motionCandidate:candidate&&motions().some(m=>m.id===candidate.id&&m.enabled)?candidate:null,motionPractice,motionPreview:lastMotionPreview};
 }
 function onCameraStopped(){
  practiceRequest++;
  if(stage)cancelRecording('Learning cancelled because the camera stopped. No example was saved.');
  stopPractice('Camera stopped. Start it to practise or learn a motion.');
 }
 const visibilityChanged=()=>{if(document.hidden){practiceRequest++;if(stage)cancelRecording('Learning cancelled because the controller tab was hidden.');stopPractice('Practice stopped because the controller tab was hidden.');}};
 $('motionSelect').onchange=()=>selectMotion($('motionSelect').value);
 $('motionOutputType').addEventListener('input',showEditorOutput);
 $('motionLearn').onclick=wrap(startRecording);$('motionCancel').onclick=()=>cancelRecording();
 $('motionPractice').onclick=wrap(async()=>startPractice(selectedId));$('motionStopPractice').onclick=()=>stopPractice();
 if($('motionConfirmPractice'))$('motionConfirmPractice').onclick=wrap(confirmPractice);
 $('motionUseMode').onclick=wrap(async()=>{
  if(hasUnsavedChanges())throw Error('Save edited mappings before choosing the learned-motion preset.');
  if(!motions().some(m=>m.enabled))throw Error('Enable at least one learned trigger using its Use checkbox and Save mapping first.');
  stopPractice();
  if(onSelectLearnedMode)await onSelectLearnedMode();else await applyMotions(motions(),{mode:'motion'});
  say('Learned-motion preset selected. Complete the session checks, then choose Go Live.');
 });
 $('motionUndo').onclick=wrap(async()=>{
  if(!undo)return;const restored={...undo,enabled:false};if(motions().some(m=>m.id===restored.id))throw Error('This trigger is already in the library.');
  await applyMotions([...motions(),restored]);selectedId=restored.id;undo=null;renderRows();selectMotion(selectedId);say(`Restored ${restored.name}; it remains disabled until you enable it.`);
 });
 document.addEventListener('visibilitychange',visibilityChanged);
 renderRows();selectMotion('');
 return {
  onState,onFrame,onCameraStopped,getOutput,resetRecognition,hasUnsavedChanges,hasOutputChanges,
  consumeOutput:()=>{lastOutput=null;},consumePracticeEvidence:()=>{practiceEvidence=null;},consumeMotionPreview:()=>{lastMotionPreview=null;},
  isLearning:()=>!!stage||pausePending||savePending,isPracticing:()=>!!practiceId,isOutputPaused:busy,
  wantsFrames:()=>!!stage||!!practiceId||getState()?.config.mode==='motion',
  stopPractice,leaveLearning:()=>{practiceRequest++;if(stage)cancelRecording();stopPractice();},
  destroy:()=>{disposed=true;practiceRequest++;stopTimer();stage=null;practiceId=null;pausePending=false;savePending=false;resetRecognition();document.removeEventListener('visibilitychange',visibilityChanged);reportBusy();}
 };
}
