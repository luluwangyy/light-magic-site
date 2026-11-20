import {channelLookRows,outputKind,outputLabel} from './mapping-output.mjs';

const $=id=>document.getElementById(id);
const title=gesture=>String(gesture||'').replaceAll('_',' ');
const outputName=target=>outputLabel(target,{compact:true})||target.command;
const outputTitle=target=>outputLabel(target)||target.command;

export function isCurrentResponse(current,next){
 if(!current?.workflow||!next?.workflow||(current.token&&next.token&&current.token!==next.token))return true;
 if(Number.isFinite(current.state_serial)&&Number.isFinite(next.state_serial)&&next.state_serial<current.state_serial)return false;
 const before=current.workflow,after=next.workflow;
 return after.revision>before.revision||(after.revision===before.revision&&after.epoch>=before.epoch);
}

export function mountWorkflow({api,getState,client,isCameraRunning,startCamera,isMicrophoneRunning=()=>false,startMicrophone=async()=>{},setInputSource=async()=>{},hasOperationalEdits,saveSettings,pauseLocal,resumeLocal,isLearning,isPracticing,onView,notify}){
 let view='session',starting=null,goingLive=null,changingSource=false,confirmation=null,test=null,sessionStartedHere=false,readinessSignature='';
 const workflow=()=>getState()?.workflow;
 const sourceMode=()=>getState()?.config.input_source||'camera';
 const needsCamera=()=>sourceMode()!=='speech';
 const needsSpeech=()=>sourceMode()!=='camera';
 const make=(tag,text)=>{const element=document.createElement(tag);if(text!==undefined)element.textContent=text;return element;};
 const action=(text,handler)=>{const button=make('button',text);button.type='button';button.onclick=run(handler);return button;};
 const run=handler=>async()=>{try{await handler();}catch(error){notify(error.message,true);}};
 function showView(next){
  const changed=next!==view;
  view=next;
  for(const panel of document.querySelectorAll('[data-panel]'))panel.hidden=panel.dataset.panel!==next;
  for(const button of document.querySelectorAll('[data-view]')){const selected=button.dataset.view===next;button.classList.toggle('active',selected);button.setAttribute('aria-current',selected?'page':'false');}
  $('appMain').dataset.inputSource=sourceMode();$('appMain').dataset.view=next;
  onView?.(next);history.replaceState(null,'','#'+next);
  if(changed)globalThis.scrollTo?.(0,0);
 }
 for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>showView(button.dataset.view);
 document.querySelector('.brand').onclick=event=>{event.preventDefault();showView('session');};
 $('inputSource').onchange=run(async()=>{
  const next=$('inputSource').value;changingSource=true;onState(getState());
  try{if(hasOperationalEdits())await saveSettings();await setInputSource(next);showView(view);}
  finally{changingSource=false;onState(getState());}
 });
 function identityText(identity){
  const i=identity||{},lines=[(i.host||getState()?.config.host||'No console address')+':'+(i.port||getState()?.config.port||'')];
  lines.push('Eos '+(i.version||'version not received'));
  lines.push('Show: '+(i.show_name||i.show_path||'No show identity received'));
  return lines.join('\n');
 }
 const identityKey=({host,port,framing,version,show_name,show_path}={})=>JSON.stringify([host,port,framing,version,show_name,show_path]);
 async function pause(reason='Paused by operator'){
  pauseLocal();
  const startup=starting;
  if(startup)startup.cancelled=true;
  if(goingLive)goingLive.cancelled=true;
  await api('pause',{reason});
  notify(startup?'Startup paused. Start any missing inputs from Session when ready.':workflow()?.rehearsal?'Rehearsal stays open. No cue output is enabled.':'Output paused. Your inputs and console stay ready.');
 }
 async function begin(rehearsal=false,startInputs=true){
  if(starting||goingLive||changingSource)return;
  if(!rehearsal&&getState()?.rehearsal_only)throw Error('This copy of Light Magic is for rehearsal only.');
  if(hasOperationalEdits())throw Error('Save your operational settings before starting a session.');
  const attempt={cancelled:false};starting=attempt;
  pauseLocal();onState(getState());notify(rehearsal?'Starting rehearsal. No console connection or cue output.':'Starting your console session. No cue will be sent.');
  try{
   await api(rehearsal?'start_rehearsal':'session_start');sessionStartedHere=true;
   $('only_host').checked=false;$('session_ok').checked=false;
   if(attempt.cancelled)return;
   if(!startInputs){notify('Console session started. Confirm the console and show when feedback arrives.');return;}
   const inputs=[];
   if(needsCamera())inputs.push(Promise.resolve().then(startCamera));
   if(needsSpeech())inputs.push(Promise.resolve().then(startMicrophone));
   const results=await Promise.allSettled(inputs);
   if(attempt.cancelled)return;
   const problems=results.filter(result=>result.status==='rejected').map(result=>result.reason.message);
   if(problems.length)throw Error(problems.join(' '));
   notify(rehearsal?'Rehearsal is ready. Perform a gesture or speak a phrase to check recognition. No cues can be sent.':'Preview is ready. Confirm the console and complete the checks below. Preview sends no automatic cues.');
  }finally{starting=null;onState(getState());}
 }
 function openSessionConfirmation(){
  const state=getState(),w=state?.workflow;
  if(state?.owner!==client||!w?.active||w.rehearsal)throw Error('Start a console session in this browser before confirming.');
  if(!state.verified||!w.identity?.version||!(w.identity.show_name||w.identity.show_path))throw Error('Wait for Eos version and show feedback, or reconnect in Console.');
  const {revision,epoch}=w;
  confirmation={token:state.token,revision,epoch,identity:identityKey(w.identity)};
  $('confirmIdentity').textContent=identityText(w.identity);
  $('only_host').checked=false;$('confirmSession').disabled=false;
  $('sessionConfirm').showModal();
 }
 function currentConfirmation(request,state){
  const w=state?.workflow;
  return state?.owner===client&&state.verified&&state.token===request.token&&w?.active&&!w.rehearsal&&
   w.revision===request.revision&&w.epoch===request.epoch&&identityKey(w.identity)===request.identity;
 }
 function invalidateConfirmation(){
  confirmation=null;$('only_host').checked=false;$('confirmSession').disabled=true;
  $('sessionConfirm').close();
  notify('The console, show or session changed. Review the current identity before confirming.',true);
 }
 $('sessionConfirm').addEventListener('close',()=>{if(!$('sessionConfirm').open)confirmation=null;});
 $('confirmSession').onclick=run(async()=>{
  const request=confirmation;
  if(!request||$('confirmSession').disabled)return;
  if(!currentConfirmation(request,getState())){invalidateConfirmation();return;}
  if(!$('only_host').checked)throw Error('Confirm that this is the only laptop controlling the console.');
  $('confirmSession').disabled=true;
  try{
   await api('confirm_session',{only_host:true,session_ok:true,revision:request.revision,epoch:request.epoch});
   if(confirmation!==request)return;
   confirmation=null;$('sessionConfirm').close();
   notify(view==='advanced'?'Console confirmed. You can review channel settings.':'Console confirmed. Complete the remaining checks in Session.');
  }finally{if(confirmation===request)$('confirmSession').disabled=false;}
 });
 function openTarget(id){
  const w=workflow(),target=w?.targets.find(item=>item.id===id);
  if(w?.rehearsal||getState()?.rehearsal_only)throw Error('Start a console session before testing live output. Rehearsal sends no output.');
  if(getState()?.owner!==client)throw Error('Use the browser that controls this session to test an output.');
  if(!target)throw Error('Save and enable this mapping before testing its output.');
  if(hasOperationalEdits())throw Error('Save operational changes before testing live output.');
  if(!w.session_confirmed)throw Error('Confirm the console session before testing live output.');
  const awaiting=(w.blockers||[]).some(item=>item.kind==='confirm_target'&&item.id===id);
  test={id,token:getState()?.token,revision:w.revision,epoch:w.epoch,sent:awaiting};
  const kind=outputKind(target);
  $('targetTestTitle').textContent=outputTitle(target);
  $('sendTargetTest').textContent=`Send test ${kind} live`;
  const details=$('targetTestLook'),channels=$('targetTestLookChannels');
  if(details&&channels){
   details.hidden=kind!=='look';
   details.open=kind==='look';
   const rows=kind==='look'?channelLookRows(target.channels)||[]:[];
   channels.replaceChildren(...rows.map(row=>make('li',outputLabel({...row,output_type:'channel_level'}))));
  }
  $('targetTestDescription').textContent=awaiting?'Check the console and lights, then confirm the result you saw.':
   'This sends the output to Eos at '+(w.identity?.host||getState().config.host)+'. '+
   (kind==='cue'?'':'The settings may remain as manual values on Eos. ')+'Confirm the visible result after the test.';
  $('targetTestState').textContent=awaiting?'A test command was sent with these settings. Confirm only if you saw the intended result.':'No test sent yet.';$('sendTargetTest').hidden=awaiting;$('sendTargetTest').disabled=false;$('confirmTargetTest').hidden=!awaiting;$('rejectTargetTest').hidden=!awaiting;
  $('targetTestDialog').showModal();
 }
 const skipLookTests=$('skipLookTests');
 if(skipLookTests)skipLookTests.onclick=run(async()=>{
  const w=workflow();
  await api('skip_look_tests',{revision:w.revision,epoch:w.epoch});
  notify('Look tests skipped for this console session. No output sent.');
 });
 const skipSpeechButtons=Array.from(document.querySelectorAll('[data-skip-speech-practice]'));
 for(const button of skipSpeechButtons)button.onclick=run(async()=>{
  const w=workflow();
  await api('skip_speech_practice',{revision:w.revision,epoch:w.epoch});
  notify('Speech practice skipped for this session. No output sent.');
 });
 const startGestureHold=$('startGestureHold');
 if(startGestureHold)startGestureHold.onclick=run(async()=>{
  const {revision,epoch}=workflow();
  await api('start_gesture_hold',{revision,epoch});
  notify('Hold the mapped gesture now. No command was sent by this button.');
 });
 const debugGesture=$('gestureDebugSelect'),sendDebugGesture=$('gestureDebugSend'),debugStatus=$('gestureDebugStatus');
 let debugMappingSignature='',debugBusy=false;
 if(sendDebugGesture)sendDebugGesture.onclick=async()=>{
  if(debugBusy||sendDebugGesture.disabled)return;
  debugBusy=true;sendDebugGesture.disabled=true;
  try{
   const {revision,epoch}=workflow();
   const state=await api('gesture_debug',{gesture:debugGesture.value,revision,epoch});
   debugStatus.textContent=`${outputLabel(state.last_output)||'Mapped output'} sent to Eos by the debug button.`;
  }catch(error){debugStatus.textContent=error.message;}
  finally{debugBusy=false;onState(getState());}
 };
 $('sendTargetTest').onclick=run(async()=>{
  const request=test;if(!request)return;
  pauseLocal();$('sendTargetTest').disabled=true;
  try{
   await api('test_target',{id:request.id,revision:request.revision,epoch:request.epoch});
   if(test!==request)return;
   request.sent=true;$('targetTestState').textContent='Test sent. Confirm that you saw the intended lighting result.';$('sendTargetTest').hidden=true;$('confirmTargetTest').hidden=false;$('rejectTargetTest').hidden=false;
  }finally{if(test===request)$('sendTargetTest').disabled=false;}
 });
 $('confirmTargetTest').onclick=run(async()=>{
  const request=test;
  if(!request?.sent)throw Error('Send the test before confirming its visible result.');
  await api('confirm_target',{id:request.id,worked:true,revision:request.revision,epoch:request.epoch});
  if(test!==request)return;
  $('targetTestDialog').close();test=null;notify('Output confirmed for this session.');
 });
 $('rejectTargetTest').onclick=()=>{$('targetTestState').textContent='Result not confirmed. Check the mapping and console, then send the test again.';if(test)test.sent=false;$('confirmTargetTest').hidden=true;$('rejectTargetTest').hidden=true;$('sendTargetTest').hidden=false;};
 $('targetTestDialog').addEventListener('close',()=>{test=null;});
 $('startSession').onclick=run(()=>begin(false));
 $('startRehearsal').onclick=run(()=>begin(true));
 $('programConsole').onclick=run(async()=>{
  const state=getState(),w=state?.workflow;
  if(!state||starting||goingLive||changingSource)return;
  if(state.owner&&state.owner!==client)throw Error('The console session is open in another tab.');
  if(state.armed)throw Error('Pause output before changing channel settings.');
  if(state.rehearsal_only)throw Error('Console output is unavailable in this rehearsal copy.');
  if(hasOperationalEdits())throw Error('Save your settings before connecting to Eos.');
  if(state.owner!==client||!w?.active||w.rehearsal){await begin(false,false);return;}
  if(!state.connected||!state.verified){await api('connect');notify('Connecting to Eos. Wait for console and show feedback.');return;}
  if(!w.session_confirmed)openSessionConfirmation();
 });
 $('stop').onclick=run(()=>pause());
 $('arm').onclick=run(async()=>{
  if(starting||goingLive||changingSource)return;
  const state=getState(),w=state?.workflow;
  if(!w?.active)throw Error('Start your session first.');
  if(w.rehearsal||state.rehearsal_only)throw Error('Start a console session before going live.');
  if(hasOperationalEdits())throw Error('Save operational changes before going live.');
  if(isLearning()||isPracticing())throw Error('Finish learning or stop Practice, then return to Session.');
  if(needsCamera()&&!isCameraRunning())throw Error('Start the camera before going live.');
  if(needsSpeech()&&!isMicrophoneRunning())throw Error('Start the microphone before going live.');
  if(state.owner!==client||!w.can_go_live)throw Error(w.reason||'Complete the session checks before going live.');
  const {revision,epoch}=w,attempt={cancelled:false};
  goingLive=attempt;onState(state);
  try{
   await api('go_live',{revision,epoch});
   const current=getState();
   if(attempt.cancelled||document.hidden||hasOperationalEdits()||current?.owner!==client||!current.armed||current.workflow?.state!=='live')return;
   resumeLocal();
   const cueMode=getState()?.config.mode==='cue';
   const gestureInstruction=cueMode?'Hold a mapped gesture until the progress bar fills.':'Return to neutral briefly, then perform a fresh complete gesture.';
   const instruction=needsCamera()&&needsSpeech()?gestureInstruction+' Leave a brief silence before saying a fresh complete phrase.':needsCamera()?gestureInstruction:'Pause briefly, then say a fresh complete phrase.';
   notify('Live. '+instruction+' Use Pause output or Escape to pause.');
  }catch(error){if(!attempt.cancelled)throw error;}
  finally{goingLive=null;onState(getState());}
 });
 $('recheckCues').onclick=run(async()=>{pauseLocal();await api('recheck_cues');notify('Cue checks cleared. Test and confirm each destination again.');showView('session');});
 $('confirmZoom').onclick=run(async()=>{await api('confirm_zoom',{worked:true});notify('Zoom range and release confirmed. Return to Session for any remaining checks.');});
 function addReadiness(list,label,detail,done,buttons=[]){
  const row=make('li');row.className=done?'done':'warn';const text=make('div');text.append(make('strong',label),make('small',detail));row.append(text);
  if(buttons.length){const actions=make('div');actions.className='check-actions';actions.append(...buttons);row.append(actions);}list.append(row);
 }
 async function confirmPractice(item){const w=workflow();await api('practice_confirm',{id:item.id,revision:w.revision,epoch:w.epoch,observed:true});notify('Practice confirmed: '+item.label+'.');}
 function getNextAction(s){
  const w=s.workflow,rehearsal=w.rehearsal||s.rehearsal_only;
  if(s.owner&&s.owner!==client)return {reason:'Another browser tab controls this session. Return to that tab, or close it before starting here.'};
  if(hasOperationalEdits())return {label:'Save changes',reason:'Operational settings have unsaved changes. Save them before output can resume.',run:saveSettings};
  if(isLearning())return {label:'Return to Learn',reason:'Learning is active. Finish or cancel the demonstration before going live.',run:()=>showView('learn')};
  if(isPracticing())return {label:'Return to practice',reason:'Practice sends no cues. Finish practice before going live.',run:()=>showView('learn')};
  if(s.owner!==client)return rehearsal?{label:'Start rehearsal here',reason:'Start your selected inputs in this browser.',run:()=>begin(true)}:{label:'Start console session',reason:'Start a console session to connect your selected inputs and console.',run:()=>begin(false)};
  if(needsCamera()&&(!isCameraRunning()||!w.camera_ready))return {label:'Start camera',reason:'The camera is not ready. Start it to preview the performer.',run:startCamera};
  if(needsCamera()&&w.next_action==='camera'){
   const reason=w.blockers?.find(item=>item.kind==='camera')?.message||'Waiting for current camera frames. Keep this page visible and the camera running.';
   const settings=/restart the camera/i.test(reason);
   return settings?{label:'Open camera settings',reason,run:()=>showView('settings')}:{reason};
  }
  if(needsSpeech()&&(!isMicrophoneRunning()||!w.microphone_ready))return {label:'Start microphone',reason:'Start the microphone to recognise phrases locally.',run:startMicrophone};
  if(needsSpeech()&&w.next_action==='microphone')return {reason:w.blockers?.find(item=>item.kind==='microphone')?.message||'Waiting for current microphone audio. Keep this page visible.'};
  if(rehearsal)return null;
  if(!s.connected||!s.verified)return {label:'Reconnect console',reason:'Waiting for readable console and show identity. Check Ethernet and the saved console address.',run:async()=>{await api('connect');notify('Connecting to the saved console. No cue is sent.');}};
  if(!w.session_confirmed)return {label:'Confirm console & show',reason:'Confirm the displayed console and show, and that this is the only control laptop.',run:openSessionConfirmation};
  if(w.next_action==='release')return {label:'Release Zoom override',reason:w.blockers[0].message,run:async()=>{await api('release');notify('Release requested. Check that the console override is released.');}};
  if(w.next_action==='settings'||w.next_action==='confirm_zoom'){
   const blocker=w.blockers[0],advanced=w.next_action==='confirm_zoom'||s.config.mode==='zoom'||s.config.dry_run||/spacing|calibrat/i.test(blocker?.message||'');
   return {label:w.next_action==='confirm_zoom'?'Check Zoom & release':advanced?'Review settings':'Open cue sheet',reason:blocker?.message||'Review the session settings.',run:()=>showView(advanced?'advanced':'cues')};
  }
  const pendingTarget=w.blockers?.find(item=>item.kind==='confirm_target');
  const target=w.targets?.find(item=>item.id===pendingTarget?.id)||w.targets?.find(item=>!item.confirmed);
  if(target){const awaiting=pendingTarget?.id===target.id,name=outputName(target);return {label:awaiting?'Confirm '+name+' result':'Test '+name+' live',reason:awaiting?'A test was sent. Confirm the intended visible result to continue.':name+' needs a live test and your confirmation of its visible result.',run:()=>openTarget(target.id)};}
  if(w.can_go_live)return null;
  const practice=w.needs_practice?.find(item=>w.blockers?.some(blocker=>blocker.kind==='practice'&&blocker.id===item.id));
  if(practice){
   const speech=practice.id.startsWith('speech_');
   return {label:practice.observed?'Confirm practice result':speech?'Say '+practice.label:practice.id.startsWith('motion_')?'Practice '+title(practice.label):'Show '+title(practice.label),reason:practice.observed?'A recent match was observed. Confirm that it was the intended phrase or movement.':(speech?'Say “'+practice.label+'”':'Perform '+title(practice.label))+' in Preview. No cue is sent.',run:practice.observed?()=>confirmPractice(practice):async()=>{if(speech){showView('speech');if(!isMicrophoneRunning())await startMicrophone();}else if(practice.id.startsWith('motion_')){showView('learn');$('motionSelect').value=practice.id;$('motionSelect').onchange?.();await $('motionPractice').onclick?.();}notify((speech?'Say “'+practice.label+'”':'Preview '+title(practice.label)+' in the camera')+', then confirm the observed match.');}};
  }
  const blocker=w.blockers?.[0];
  return {label:'Open Console',reason:blocker?.message||w.reason||'Complete the remaining checks before going live.',run:()=>showView('advanced')};
 }
 function onState(s){
  if(!s)return;const w=s.workflow||{active:false,targets:[],needs_practice:[],identity:{}},active=!!w.active,rehearsal=active&&!!(w.rehearsal||s.rehearsal_only);
  const owned=s.owner===client,locked=!!s.owner&&!owned;
  const busy=!!starting||!!goingLive||changingSource;
  const consoleSession=owned&&active&&!rehearsal;
  const identityReady=consoleSession&&s.connected&&s.verified&&w.identity?.version&&(w.identity.show_name||w.identity.show_path);
  const consoleStatus=$('consoleProgramStatus'),programConsole=$('programConsole');
  programConsole.hidden=!!s.rehearsal_only||(!!identityReady&&w.session_confirmed);
  programConsole.disabled=busy||locked||!!s.armed||hasOperationalEdits()||!!(consoleSession&&s.connected&&s.verified&&!identityReady);
  programConsole.textContent=identityReady?'Confirm console & show':consoleSession?'Reconnect Eos':'Connect to Eos';
  consoleStatus.textContent=s.rehearsal_only?'Console output is unavailable in this rehearsal copy.':locked?'This session is open in another tab.':identityReady?
   (w.identity.show_name||w.identity.show_path)+' · Eos '+w.identity.version:
   consoleSession&&s.connected?'Waiting for Eos version and show feedback.':'Connect to Eos to change channel settings.';
  $('inputSource').value=sourceMode();$('inputSource').disabled=locked||busy;$('appMain').dataset.inputSource=sourceMode();
  $('speechSourceWarning').hidden=sourceMode()!=='camera'||!(s.config.speech_mappings||[]).some(mapping=>mapping.enabled&&outputLabel(mapping));
  $('speechSourceWarning').textContent='Speech mappings are enabled, but the input source is Camera. Choose Camera + speech or Speech only above to include spoken phrases.';
  $('sessionWorkflow').hidden=!active;$('startSession').hidden=s.rehearsal_only||(active&&!rehearsal);$('startSession').disabled=busy||locked||!!s.rehearsal_only;
  $('startRehearsal').hidden=rehearsal||w.state==='live';$('startRehearsal').disabled=busy||locked;$('rehearsalHelp').hidden=active;
  $('state').textContent=!active?'Not started':rehearsal?'Rehearsal':w.state==='live'?'Live':w.state==='paused'?'Paused':'Preview';$('state').className='state-pill '+(rehearsal?'rehearsal':w.state==='live'?'live':w.state==='paused'?'paused':'');
  $('previewBadge').textContent=w.state==='live'&&!rehearsal?
   (needsCamera()&&w.fresh_gesture_required?'Camera waiting for neutral':'Live output'):'Preview · no cues';
  $('sessionTitle').textContent=!active?'Start your session':rehearsal?'Rehearsal':w.state==='live'?'Live session':w.state==='paused'?'Output paused':'Session checks';
  $('sessionSummary').textContent=s.rehearsal_only?'Check the performer’s movements and phrases. Console output is unavailable in this rehearsal copy.':!active?'Choose how to rehearse or connect to your saved console. Starting never fires a cue.':rehearsal?'Check the performer’s movements and phrases with no cue output. When you want to control lighting, start a console session and complete its checks.':w.state==='live'?'Enabled phrases and movements can send their mapped output. Pause keeps your selected inputs and connection ready.':w.state==='paused'?(w.reason||'Output is paused. Complete any changed checks, then resume.'):'Your selected inputs are in Preview. Complete these checks before going live.';
  $('owner').textContent=s.owner===client?'This browser has control':s.owner?'Another browser has control':'No session owner';
  $('sessionIdentity').hidden=rehearsal;$('sessionIdentity').textContent=rehearsal?'':identityText(w.identity).replaceAll('\n',' · ');
  if(rehearsal)$('connection').textContent='Console output is disabled in rehearsal';
  if(confirmation&&$('sessionConfirm').open&&!currentConfirmation(confirmation,s))invalidateConfirmation();
  if(w.session_confirmed){$('only_host').checked=true;$('session_ok').checked=true;}
  else $('session_ok').checked=false;
  const activePractice=(w.needs_practice||[]).filter(item=>w.blockers?.some(blocker=>blocker.kind==='practice'&&blocker.id===item.id));
  for(const button of skipSpeechButtons){
   button.hidden=!consoleSession||!w.session_confirmed||!s.verified||s.config.dry_run||w.state==='live'||
    !activePractice.some(item=>item.id.startsWith('speech_'));
   button.disabled=busy||hasOperationalEdits();
  }
  const pendingTargetId=w.blockers?.find(item=>item.kind==='confirm_target')?.id;
  if(skipLookTests){
   skipLookTests.hidden=!consoleSession||!w.session_confirmed||!s.verified||s.config.dry_run||w.state==='live'||
    !(w.targets||[]).some(target=>target.output_type==='channel_look'&&!target.confirmed&&!target.skipped);
   skipLookTests.disabled=busy||hasOperationalEdits();
  }
  const signature=JSON.stringify([owned,rehearsal,sourceMode(),isCameraRunning(),w.camera_ready,isMicrophoneRunning(),w.microphone_ready,s.verified,w.session_confirmed,w.state,hasOperationalEdits(),w.targets,pendingTargetId,activePractice]);
  if(signature!==readinessSignature){
  readinessSignature=signature;const list=$('readiness');list.replaceChildren();
  if(needsCamera())addReadiness(list,'Camera',isCameraRunning()&&w.camera_ready?'Performer camera is ready.':'Start the camera to preview movement.',isCameraRunning()&&w.camera_ready);
  if(needsSpeech())addReadiness(list,'Microphone',isMicrophoneRunning()&&w.microphone_ready?'Local speech recognition is ready.':'Start the microphone to preview phrases.',isMicrophoneRunning()&&w.microphone_ready);
  if(!rehearsal)addReadiness(list,'Console & show',w.session_confirmed?'Identity confirmed for this session.':s.verified?'Console found. Confirm its identity.':'Waiting for console identity.',w.session_confirmed,owned&&s.verified&&!w.session_confirmed?[action('Confirm',openSessionConfirmation)]:[]);
  for(const target of rehearsal?[]:w.targets||[]){
   const awaiting=pendingTargetId===target.id;
   const detail=target.confirmed?'Visible result confirmed.':target.skipped?'Look test skipped for this session.':awaiting?'Test sent. Confirm the visible result.':'Live test and visible confirmation needed.';
   const buttons=[];
   if(!target.confirmed){const b=action(awaiting?'Confirm result':'Test live',()=>openTarget(target.id));b.disabled=!owned||!w.session_confirmed||w.state==='live'||hasOperationalEdits();buttons.push(b);}
   addReadiness(list,outputTitle(target),detail,target.confirmed||target.skipped,buttons);
  }
  for(const item of activePractice){const buttons=owned&&item.observed?[action('Confirm match',()=>confirmPractice(item))]:[];addReadiness(list,title(item.label),item.observed?'Match observed. Confirm the intended phrase or movement.':'Practice in Preview; no cue is sent.',false,buttons);}
  }
  const next=active?getNextAction(s):null;$('nextAction').hidden=!next?.run||w.state==='live';$('nextAction').disabled=busy;if(next?.run){$('nextAction').textContent=next.label;$('nextAction').onclick=run(next.run);}else $('nextAction').onclick=null;
  $('blockReason').hidden=w.state==='live'||(rehearsal&&!next);$('blockReason').textContent=next?.reason||((w.targets||[]).some(target=>target.skipped)?'Look tests skipped. Go live when the performer is ready.':'All checks passed. Go live when the performer is ready.');
  $('arm').hidden=w.state==='live'||rehearsal;$('arm').textContent=goingLive?'Enabling live output…':w.state==='paused'?'Resume live':'Go live';$('arm').disabled=busy||!owned||!active||rehearsal||!w.can_go_live||hasOperationalEdits()||isLearning()||isPracticing()||(needsCamera()&&!isCameraRunning())||(needsSpeech()&&!isMicrophoneRunning());
  $('stop').disabled=!starting&&(rehearsal||(!active&&!s.armed));
  const consoleUnavailable=rehearsal||!!s.rehearsal_only;
  for(const id of ['connect','manualZoom','release','confirmZoom','recheckCues','dry_run'])$(id).disabled=consoleUnavailable;
  $('testConnection').disabled=consoleUnavailable||!!s.diagnostics?.running;
  const waitingForGesture=needsCamera()&&w.state==='live'&&w.fresh_gesture_required;
  if(startGestureHold){
   startGestureHold.hidden=!waitingForGesture||!owned||s.config.mode!=='cue';
   startGestureHold.disabled=busy||hasOperationalEdits()||!isCameraRunning();
  }
  if(debugGesture&&sendDebugGesture){
   const choices=(s.config.mappings||[]).filter(mapping=>mapping.enabled&&outputLabel(mapping));
   const signature=JSON.stringify(choices.map(mapping=>[mapping.gesture,outputLabel(mapping)]));
   if(signature!==debugMappingSignature){
    const selected=debugGesture.value;
    debugGesture.replaceChildren(...choices.map(mapping=>{
     const option=make('option',`${title(mapping.gesture)} · ${outputLabel(mapping)}`);
     option.value=mapping.gesture;
     return option;
    }));
    if(choices.some(mapping=>mapping.gesture===selected))debugGesture.value=selected;
    debugMappingSignature=signature;
   }
   const debugReady=owned&&s.armed&&s.verified&&!s.config.dry_run&&needsCamera()&&s.config.mode==='cue';
   sendDebugGesture.disabled=busy||debugBusy||hasOperationalEdits()||!debugReady||!choices.length;
   if(!debugReady)debugStatus.textContent='Go live to use this check.';
   else if(debugStatus.textContent==='Go live to use this check.')debugStatus.textContent='Choose a gesture and send its saved mapping.';
  }
  if(waitingForGesture)$('tracking').textContent=s.config.cue_sheet==='air-obey'?
   'Lower both arms with your wrists in view, or show a relaxed hand briefly. Then perform a fresh gesture.':
   'Return to neutral for 0.3 seconds, then perform a fresh complete gesture. Held gestures do not fire on Resume.';
  if(test&&$('targetTestDialog').open&&(test.token!==s.token||test.revision!==w.revision||test.epoch!==w.epoch)){$('targetTestState').textContent='Session or operational settings changed. Close this test and test the current destination again.';$('confirmTargetTest').hidden=true;$('rejectTargetTest').hidden=true;$('sendTargetTest').disabled=true;test=null;}
 }
 showView(['session','cues','settings','learn','speech','advanced'].includes(location.hash.slice(1))?location.hash.slice(1):'session');
 return {onState,showView,openTarget,pause,start:()=>begin(false),rehearse:()=>begin(true),refresh:()=>onState(getState()),getView:()=>view,sessionStartedHere:()=>sessionStartedHere};
}
