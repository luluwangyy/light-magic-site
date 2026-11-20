import {outputKind,outputLabel} from './mapping-output.mjs';

const $=id=>document.getElementById(id);

/** Typed diagnostics deliberately never supply recognition or practice evidence. */
export function mountSpeechDebug({api,getState,client,notify,ensureSaved=()=>{},pauseLocal=()=>{},openTarget}){
 let diagnosis=null,checkedPhrase='',busy=false,request=null;
 const text=()=>$('speechDebugPhrase').value.trim();
 const current=()=>!!diagnosis&&checkedPhrase===text()&&diagnosis.revision===getState()?.workflow?.revision&&diagnosis.epoch===getState()?.workflow?.epoch;
 const target=()=>diagnosis?.target||diagnosis?.match;
 function render(state=getState()){
  const matching=diagnosis?.match,label=outputLabel(target()),valid=current(),pending=diagnosis?.pending_test;
  const type=outputKind(target());
  $('speechDebugSend').textContent=type==='look'?'Review matched look':`Send matched ${type} live`;
  $('speechDebugCheck').disabled=busy;
  $('speechDebugSend').disabled=busy||!valid||!matching||!label||!diagnosis.can_test||!!pending;
  $('speechDebugConfirm').hidden=!pending;
  $('speechDebugConfirm').disabled=busy||!valid||!pending;
  $('speechDebugBlockers').replaceChildren();
  if(!diagnosis){$('speechDebugResult').textContent='Type a phrase to check its saved output mapping.';$('speechDebugDetails').textContent='Typed text cannot confirm microphone recognition.';return;}
  $('speechDebugResult').textContent=matching?`“${matching.phrase}” → ${label||'Output unassigned'} · ${matching.enabled?'Enabled':'Disabled'}`:`No saved phrase matches “${diagnosis.normalized||checkedPhrase}”.`;
  const mode=state?.config?.input_source||diagnosis.source_mode||'camera',mic=state?.speech?.ready??diagnosis.microphone_ready;
  const details=[mode==='camera'?'Camera only: speech output is excluded.':mode==='speech'?'Speech only.':'Camera + speech.',mic?'Microphone is on.':'Microphone is off.'];
  const last=state?.speech?.last_text??diagnosis.last_text;if(last)details.push('Last heard: “'+last+'”.');
  const confidence=state?.speech?.last_confidence??diagnosis.last_confidence;if(typeof confidence==='number')details.push('Recognition score: '+Math.round(confidence*100)+'%.');
  details.push('Typing does not verify speech recognition.');$('speechDebugDetails').textContent=details.join(' ');
  const messages=valid?[...(diagnosis.blockers||[]).map(message=>'Automatic speech: '+message),...(diagnosis.test_blockers||[]).map(message=>'Manual test: '+message)]:['Settings or session changed. Check the phrase again before a manual test.'];
  for(const message of messages){const item=document.createElement('li');item.textContent=message;$('speechDebugBlockers').append(item);}
  if(pending&&valid)$('speechDebugDetails').textContent+=' Test sent. Confirm the visible result.';
 }
 function onState(state){
  if(state?.speech_debug&&request&&request.phrase===text()){
   diagnosis=structuredClone(state.speech_debug);checkedPhrase=request.phrase;
  }
  const pending=diagnosis?.pending_test;
  if(pending&&(state?.workflow?.confirmed_target_ids||[]).includes(pending.id)){
   diagnosis.pending_test=null;diagnosis.can_test=false;
   diagnosis.blockers=['Visible result confirmed. Use the microphone to check phrase recognition before resuming speech output.'];
  }
  render(state);
 }
 async function run(action){
  if(busy)return;busy=true;render();
  try{await action();}catch(error){notify(error.message,true);}finally{busy=false;request=null;render();}
 }
 async function check(){
  const phrase=text();if(!phrase){diagnosis=null;checkedPhrase='';render();notify('Type a phrase to check its saved mapping.');return;}
  await run(async()=>{request={phrase};const state=await api('speech_debug',{phrase});onState(state);});
 }
 $('speechDebugPhrase').addEventListener('input',()=>{diagnosis=null;checkedPhrase='';render();});
 $('speechDebugPhrase').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();check();}});
 $('speechDebugCheck').onclick=check;
 $('speechDebugSend').onclick=()=>run(async()=>{
  if(!current()||!diagnosis.match||!outputLabel(target())||!diagnosis.can_test||diagnosis.pending_test)throw Error('Check a saved, enabled output mapping before sending a manual test.');
  if(outputKind(target())==='look'){ensureSaved();return openTarget(target().id);}
  ensureSaved();const phrase=text();if(getState()?.owner!==client)await api('claim');
  const workflow=getState()?.workflow;pauseLocal();request={phrase};const state=await api('speech_debug_test',{phrase,revision:workflow.revision,epoch:workflow.epoch});onState(state);
  notify('Manual test sent. Confirm the visible result, then check recognition separately with the microphone.');
 });
 $('speechDebugConfirm').onclick=()=>run(async()=>{
  const pending=diagnosis?.pending_test;if(!current()||!pending)throw Error('Send a current manual test before confirming its visible result.');
  await api('confirm_target',{id:pending.id,revision:pending.revision,epoch:pending.epoch,worked:true});
  diagnosis.pending_test=null;diagnosis.can_test=false;diagnosis.blockers=['Visible output confirmed. Microphone recognition must be checked separately.'];
  notify('Output result confirmed. Say the phrase into the microphone to verify recognition before resuming.');
 });
 render();return {onState,check};
}
