import {outputLabel} from './mapping-output.mjs';

const $=id=>document.getElementById(id);

function optionalPercent(input){
 const text=input.value.trim();
 if(input.validity?.badInput)return NaN;
 if(!text)return null;
 if(!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text))return NaN;
 return Number(text);
}

function readFixture(){
 const channelText=$('manualChannel').value.trim();
 if(!/^\d+$/.test(channelText))return null;
 const channel=Number(channelText);
 const level=optionalPercent($('manualChannelLevel')),zoom=optionalPercent($('manualChannelZoom'));
 const color=$('manualSetColor').checked?$('manualChannelColor').value.toLowerCase():null;
 if([level,zoom].some(value=>value!==null&&(!Number.isFinite(value)||value<0||value>100)))return null;
 if(color!==null&&!/^#[0-9a-f]{6}$/.test(color))return null;
 const command=outputLabel({output_type:'channel_level',channel,level,zoom,color});
 return command?{channel,level,zoom,color,command}:null;
}

function consoleKey(identity={}){
 const {host,port,framing,version,show_name,show_path}=identity;
 return JSON.stringify([host,port,framing,version,show_name,show_path]);
}

export function mountChannelLevel({api,getState,client,hasOperationalEdits=()=>false,pauseLocal=()=>{},openSession=()=>{},previewOnStage=()=>{}}){
 let review=null,sending=null,outcome='';
 const dialog=$('channelLevelDialog');
 const remaining=state=>Math.max(0,state?.cue_dispatch?.wait_s||0);
 const hasFixtureParameters=draft=>draft&&(draft.zoom!==null||draft.color!==null);
 const canPreview=state=>!!state?.workflow&&!state.armed&&state.workflow.state!=='live';
 function blocker(state,draft){
  const w=state?.workflow;
  if(!w)return {message:'Waiting for the local bridge.'};
  if(!state.channel_level_supported)return {message:'Restart Light Magic to load channel level controls.'};
  if(hasFixtureParameters(draft)&&!state.fixture_parameters_supported)return {message:'Restart Light Magic to send zoom and color to Eos.'};
  if(state.rehearsal_only)return {message:'Use the local console copy to send fixture changes to Eos.'};
  if(state.owner&&state.owner!==client)return {message:'Open Session in the browser that controls this console.',session:true};
  if(!w.active||w.rehearsal||state.owner!==client)return {message:'Start a console session from the Eos connection panel below.'};
  if(state.armed||!['preview','paused'].includes(w.state))return {message:'Pause automatic output before sending fixture changes.'};
  if(hasOperationalEdits())return {message:'Save operational changes before sending fixture changes.'};
  if(state.config?.dry_run)return {message:'Turn off Dry Run before sending fixture changes.'};
  if(!state.connected||!state.verified||!w.session_confirmed||!w.identity?.version||!(w.identity.show_name||w.identity.show_path)){
   return {message:'Connect to Eos and confirm the console and show in the panel below.'};
  }
  if(state.pending?.length)return {message:'Release the remembered Zoom override first.'};
  return null;
 }
 function current(request,state){
  const w=state?.workflow;
  return state?.token===request.token&&w?.revision===request.revision&&w?.epoch===request.epoch&&
   consoleKey(w?.identity)===request.console;
 }
 function closeReview(){
  review=null;
  if(dialog.open)dialog.close();
 }
 function onState(state=getState()){
  const draft=readFixture(),blocked=blocker(state,draft),wait=remaining(state);
  if(review&&(blocked||!current(review,state)||draft?.command!==review.command)){
   closeReview();
   outcome='Settings or session changed. Review the current command before sending.';
  }
  const preview=draft?.command||'Enter a channel and at least one setting';
  if($('channelLevelPreview').textContent!==preview)$('channelLevelPreview').textContent=preview;
  $('manualChannelColor').disabled=!$('manualSetColor').checked;
  $('previewChannelOnStage').disabled=!!(sending||!draft||!canPreview(state));
  $('reviewChannelLevel').disabled=!!(blocked||sending||!draft);
  $('channelLevelSession').hidden=!blocked?.session;
  $('sendChannelLevel').disabled=!!(sending||!review||wait>0);
  const spacing=wait>0?`Console spacing allows another command in ${Math.max(.1,wait).toFixed(1)} s.`:'';
  if(review){
   const identity=state.workflow.identity;
   const action=hasFixtureParameters(review)?
    'This applies the selected settings to the patched fixture. Check that it supports them. The settings stay in effect until changed on Eos.':
    'This sets the channel intensity on Eos. Pause stops new output. The level stays in effect until changed on Eos.';
   const destination=`Eos at ${identity.host}:${identity.port} · ${identity.show_name||identity.show_path}. `+action+
    (spacing?' '+spacing:'');
   if($('channelLevelDestination').textContent!==destination)$('channelLevelDestination').textContent=destination;
  }
  const available=blocked?.message||spacing;
  const status=sending?`Sending ${sending.command}…`:[outcome,available].filter(Boolean).join(' ')||'Review the fixture settings before sending.';
  if($('channelLevelStatus').textContent!==status)$('channelLevelStatus').textContent=status;
 }
 function reviewLevel(){
  const state=getState(),draft=readFixture();
  if(sending||blocker(state,draft)||!draft){onState(state);return;}
  const {revision,epoch,identity}=state.workflow;
  review={...draft,token:state.token,revision,epoch,console:consoleKey(identity)};
  outcome='';
  $('channelLevelCommand').textContent=review.command;
  dialog.showModal();
  onState(state);
 }
 async function sendLevel(){
  const state=getState(),request=review,draft=readFixture();
  if(sending||!request||!dialog.open||blocker(state,draft)||!current(request,state)||
     draft?.command!==request.command||remaining(state)>0){
   onState(state);return;
  }
  sending=request;closeReview();pauseLocal();onState(state);
  try{
   const {channel,level,zoom,color,revision,epoch}=request;
   const payload={channel,level,confirmed:true,revision,epoch};
   if(zoom!==null)payload.zoom=zoom;
   if(color!==null)payload.color=color;
   const result=await api('manual_channel_level',payload);
   const receipt=result?.channel_level;
   if(current(request,getState())&&receipt?.channel===channel&&(receipt.level??null)===level&&
      (receipt.zoom??null)===zoom&&(receipt.color??null)===color){
    outcome=`${request.command} written to Eos. Verify the result at the console and fixture.`;
   }else{
    outcome=`No write confirmation for ${request.command}. Check Eos before trying again.`;
   }
  }catch(error){
   outcome=`${error.message} Check Eos before trying again.`;
  }finally{
   sending=null;onState();
  }
 }
 for(const id of ['manualChannel','manualChannelLevel','manualChannelZoom','manualSetColor','manualChannelColor']){
  $(id).addEventListener('input',()=>{outcome='';onState();});
 }
 $('reviewChannelLevel').onclick=reviewLevel;
 $('previewChannelOnStage').onclick=()=>{
  const state=getState(),draft=readFixture();
  if(!draft||sending||!canPreview(state))return;
  const {channel,level,zoom,color}=draft;
  previewOnStage({output_type:'channel_level',channel,level,zoom,color});
 };
 $('sendChannelLevel').onclick=sendLevel;
 $('channelLevelSession').onclick=openSession;
 dialog.addEventListener('close',()=>{if(!dialog.open){review=null;onState();}});
 onState();
 return {onState};
}
