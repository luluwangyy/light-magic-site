import {createSpeechSender} from './speech-audio.mjs';
import {stopCameraStream,waitForCameraStage} from './camera-lifecycle.mjs';
import {mountSpeechDebug} from './speech-debug.mjs';
import {canTestMapping,cueStatus,STAGE_SPEECH_EFFECTS} from './show-ui.mjs';
import {appendOutputFields,mergeMappingDraft,outputKind,outputLabel,savedOutputTarget} from './mapping-output.mjs';

const $=id=>document.getElementById(id);
const put=(id,text)=>{const element=$(id);if(element&&element.textContent!==text)element.textContent=text;};
const engineName=backend=>backend==='enhanced'?'Enhanced · local':backend==='vosk'?'Standard · local':'Local recognition';
const quotePhrases=phrases=>phrases.map(phrase=>`“${phrase}”`).join(' or ');
// Camera inference can delay the main thread while the audio worklet keeps capturing.
const MAX_SPEECH_PACKET_AGE_S=.45;
export const DEFAULT_PHRASES=[
 {id:'speech_light',phrase:'there be light',cue_list:1,cue:'',enabled:false},
 {id:'speech_abracadabra',phrase:'Abracadabra',cue_list:1,cue:'',enabled:false},
 {id:'speech_pass',phrase:'They shall not pass',cue_list:1,cue:'',enabled:false},
 {id:'speech_command',phrase:'At my command',cue_list:1,cue:'',enabled:false},
 {id:'speech_defend',phrase:'This will defend',cue_list:1,cue:'',enabled:false}
];

export function mountSpeech({api,getState,client,notify,onEdited,saveSettings,openTarget,setInputSource=async()=>{},ensureSaved=()=>{},pauseOutputLocal=()=>{},onRunningChanged=()=>{},hasOutputBlock=()=>false,hasOperationalEdits=()=>false}){
 let stream=null,context=null,node=null,source=null,silent=null,streamId=null,running=false,starting=null,abort=null,generation=0,capture=null,epochKey='',bridgeToken='',lastSource=null,baseline=[],baselineBackend='auto';
 let clippingUntil=0;
 let shortCommandDisplay='';
 const alternateNotes=new WeakMap();
 const stage=(operation,signal,message,onLateValue)=>waitForCameraStage(operation,{signal,timeoutMs:30000,timeoutMessage:message,onLateValue});
 const phrases=()=>getState()?.config.speech_mappings||DEFAULT_PHRASES;
 const current=packet=>running&&!document.hidden&&!(getState()?.armed&&hasOutputBlock())&&packet.generation===generation&&packet.streamId===streamId&&packet.revision===getState()?.workflow?.revision&&packet.epoch===getState()?.workflow?.epoch;
 const fresh=chunk=>context?.state==='running'&&Number.isFinite(chunk.capturedAt)&&context.currentTime-chunk.capturedAt<=MAX_SPEECH_PACKET_AGE_S;
 const send=createSpeechSender({api,isCurrent:current,isFresh:fresh,onFailure:error=>{notify('Microphone stream stopped: '+error.message,true);stop().catch(()=>{});}});
 const wrapped=fn=>async()=>{try{await fn();}catch(error){notify(error.message,true);}};
 const debug=mountSpeechDebug({api,getState,client,notify,ensureSaved,pauseLocal:pauseOutputLocal,openTarget});
 function resetCapture(state=getState()){
  const w=state?.workflow;if(!w)return;
  generation++;capture={generation,streamId,revision:w.revision,epoch:w.epoch};
  node?.port.postMessage({type:'reset',generation});
 }
 async function devices(){
  if(!navigator.mediaDevices?.enumerateDevices)return;
  const selected=$('microphoneSelect').value||getState()?.config.microphone_id||'';
  const list=await navigator.mediaDevices.enumerateDevices();$('microphoneSelect').replaceChildren(new Option('Default microphone',''));
  for(const device of list.filter(item=>item.kind==='audioinput'))$('microphoneSelect').append(new Option(device.label||'Microphone',device.deviceId));
  $('microphoneSelect').value=[...$('microphoneSelect').options].some(option=>option.value===selected)?selected:'';
 }
 function controls(){
  $('microphoneStart').disabled=!!starting||running;$('microphoneStop').disabled=!starting&&!running;
  const cameraOnly=(getState()?.config.input_source||'camera')==='camera';
  $('speechPreviewStart').disabled=!!starting||running||cameraOnly;
  put('speechPreviewStart',cameraOnly?'Choose a speech input source':'Start microphone');
 }
 function audioLevel(rms,clipping=0){
  const value=Math.min(1,Math.max(0,(Number(rms)||0)*6));
  if(clipping>.02)clippingUntil=Date.now()+1800;
  $('speechLevel').value=value;$('showSpeechPreviewLevel').value=value;
 }
 function cleanLocal(){
  const oldContext=context;running=false;generation++;capture=null;
  node?.port.postMessage({type:'stop'});if(node)node.port.onmessage=null;
  for(const item of [source,node,silent])try{item?.disconnect();}catch{}
  stopCameraStream(stream);stream=null;context=null;node=null;source=null;silent=null;
  if(oldContext){oldContext.onstatechange=null;oldContext.close().catch(()=>{});}
  clippingUntil=0;audioLevel(0);controls();onRunningChanged(false);
 }
 async function stop({notifyServer=true}={}){
  abort?.abort();const previous=streamId;streamId=null;cleanLocal();
  if(previous&&notifyServer)try{await api('speech_stop',{stream_id:previous});}catch(error){notify('Microphone stopped locally. '+error.message,true);}
  onState(getState());
 }
 async function open(){
  if(running)return;
  if(!navigator.mediaDevices?.getUserMedia||!(window.AudioContext||window.webkitAudioContext)||!window.AudioWorkletNode)throw Error('Local microphone capture needs a current Chrome or Edge browser.');
  const attemptAbort=new AbortController();abort=attemptAbort;const signal=attemptAbort.signal;let acquired=null,createdId=null;
  try{
   if(getState()?.owner!==client)await api('claim');
   notify('Opening the microphone. Allow microphone access if your browser asks.');
   const id=$('microphoneSelect').value||getState()?.config.microphone_id||'';
   acquired=await stage(navigator.mediaDevices.getUserMedia({video:false,audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true,...(id?{deviceId:{exact:id}}:{})}}),signal,'Microphone permission or opening timed out. Allow access and choose Start microphone again.',stopCameraStream);
   if(signal.aborted)throw Error('Microphone start cancelled.');
   if(!acquired.getAudioTracks()[0])throw Error('The selected device did not provide microphone audio. Choose another microphone and retry.');
   stream=acquired;context=new (window.AudioContext||window.webkitAudioContext)();
   await stage(context.resume(),signal,'Microphone audio did not start. Choose Start microphone to retry.');
   await stage(context.audioWorklet.addModule('./speech-worklet.mjs'),signal,'Microphone processing did not load. Refresh the page and retry.');
   notify('Preparing local speech recognition…');
   const result=await stage(api('speech_start'),signal,'Local speech recognition did not start. Choose Start microphone to retry.',late=>late?.speech?.stream_id&&api('speech_stop',{stream_id:late.speech.stream_id}));
   createdId=result.speech?.stream_id;if(!createdId||!result.speech?.ready)throw Error(result.speech?.error||'The local speech recognizer is not ready.');
   if(signal.aborted)throw Error('Microphone start cancelled.');
   if(acquired.getAudioTracks()[0].readyState==='ended'||context.state!=='running')throw Error('Microphone audio was interrupted while starting. Reconnect it and choose Start microphone again.');
   streamId=createdId;source=context.createMediaStreamSource(acquired);
   node=new AudioWorkletNode(context,'local-speech-capture',{processorOptions:{packetMs:result.speech.audio_packet_ms}});
   silent=context.createGain();silent.gain.value=0;
   const activeContext=context;
   node.port.onmessage=event=>{
    const chunk=event.data;if(!capture||chunk.generation!==generation)return;
    // Vision and rendering can stall this handler while microphone capture keeps running.
    if(!fresh(chunk))return;
    audioLevel(chunk.rms,chunk.clipping);
    send(chunk,{...capture});
   };
   source.connect(node);node.connect(silent);silent.connect(context.destination);running=true;resetCapture(result);
   for(const track of acquired.getAudioTracks())track.addEventListener('ended',()=>{if(running&&stream===acquired){notify('The microphone disconnected. Output is paused.',true);stop().catch(()=>{});}});
   context.onstatechange=()=>{if(running&&context===activeContext&&activeContext.state!=='running'){notify('Microphone audio was interrupted. Start it again before resuming.',true);stop().catch(()=>{});}};
   devices().catch(()=>{});notify('Microphone ready. Say a complete phrase, then pause briefly. Preview sends no cues.');onRunningChanged(true);onState(getState());
  }catch(error){
   stopCameraStream(acquired);cleanLocal();streamId=null;
   if(createdId)api('speech_stop',{stream_id:createdId}).catch(()=>{});
   if(signal.aborted)throw Error('Microphone start cancelled.');
   const hint=error.name==='NotAllowedError'?' Allow microphone access in your browser and retry.':error.name==='NotFoundError'||error.name==='OverconstrainedError'?' Choose an available microphone and retry.':'';
   throw Error(error.message+hint);
  }finally{if(abort===attemptAbort)abort=null;}
 }
 function start(){if(running)return Promise.resolve();if(starting)return starting;const attempt=open().finally(()=>{if(starting===attempt)starting=null;controls();});starting=attempt;controls();return attempt;}
 function cancelPending(){if(starting)abort?.abort();}
 function updateShortCommands(state){
  const aliases=state.speech_aliases||{};
  const available=phrases().filter(mapping=>aliases[mapping.id]?.length);
  const active=available.filter(mapping=>mapping.enabled&&outputLabel(mapping));
  const display=active.map(mapping=>[quotePhrases(aliases[mapping.id]),mapping.phrase]);
  const signature=JSON.stringify(display);
  if(shortCommandDisplay!==signature){
   shortCommandDisplay=signature;
   const items=display.map(([alternates,phrase])=>{
    const item=document.createElement('div'),term=document.createElement('dt'),description=document.createElement('dd');
    term.textContent=alternates;description.textContent=phrase;
    item.append(term,description);return item;
   });
   $('speechShortCommandList').replaceChildren(...items);
  }
  $('speechShortCommands').hidden=!available.length;
  $('speechShortCommandList').hidden=!active.length;
  $('speechShortCommandSetup').hidden=!!active.length;
  return active.length>0;
 }
 function onState(state){
  if(!state)return;
  const restarted=bridgeToken&&state.token&&bridgeToken!==state.token;if(state.token)bridgeToken=state.token;
  if(restarted&&(running||starting)){stop({notifyServer:false}).catch(()=>{});notify('The local bridge restarted. Start the microphone again when ready.');}
  const sourceMode=state.config.input_source||'camera';
  if(lastSource&&lastSource!=='camera'&&sourceMode==='camera'&&running)stop().catch(()=>{});lastSource=sourceMode;
  const w=state.workflow,key=w?`${w.revision}:${w.epoch}`:'';
  if(key!==epochKey){epochKey=key;if(running)resetCapture(state);}
  if(running&&(state.speech?.ready===false||(state.speech?.stream_id&&state.speech.stream_id!==streamId)))stop({notifyServer:false}).catch(()=>{});
  const speech=state.speech||{},status=speech.loading?'Warming up locally':running&&speech.ready?(speech.processing?'Recognizing phrase':'Listening locally'):starting?'Starting microphone':speech.error?'Microphone unavailable':'Microphone off';
  put('speechInputWarning',sourceMode==='camera'?'The input source is Camera. Choose Camera + speech below to include spoken triggers, then check microphone recognition before resuming.':!running||!speech.ready?'The microphone is off. Start it before speaking. Output stays paused until the required checks are complete.':state.armed?'Speech input is live. Say a fresh complete phrase after a brief pause.':w?.rehearsal?'Speech is in rehearsal. Say a phrase to check recognition without sending output.':'Speech is in Preview. Say a phrase, confirm its recognized match, then resume from Session when ready.');
  $('speechUseBoth').hidden=sourceMode!=='camera';
  put('speechStatus',status);put('speechPreviewStatus',status);
  const effectiveEngine=engineName(speech.backend),engine=speech.backend?effectiveEngine:'Local recognition';
  put('showSpeechEngine',engine);put('showSpeechPreviewEngine',engine);
  put('showSpeechInput',running&&speech.ready?(Date.now()<clippingUntil?'Input is clipping. Lower microphone gain.':speech.audio_hint||'Microphone active'):status);
  put('showSpeechLatency',running&&speech.ready&&Number.isFinite(speech.last_decode_ms)?Math.round(speech.last_decode_ms)+' ms':'No result yet');
  put('showSpeechEngineHelp',speech.enhanced_available===false?'Automatic prefers the faster Standard engine. To add Enhanced on Windows, run Setup speech recognition.bat, then reopen Light Magic.':'Automatic prefers Standard for lower delay. Try Enhanced in rehearsal if Standard misses or mishears a phrase.');
  const prefix=state.config.cue_sheet==='air-obey'&&phrases().some(item=>item.id==='speech_command'&&item.phrase.normalize('NFC').toLowerCase().replace(/\p{P}/gu,' ').trim().replace(/\s+/g,' ')==='at my command');
  put('showSpeechMatchHelp',prefix?'Say the complete phrase, then pause briefly. “At my command” can also match at the start of a longer passage.':'Say the complete phrase, then pause briefly. Only complete, matching phrases can trigger output while live.');
  const transcript=speech.partial||speech.last_text||'Say a phrase to see it here.';
  put('speechTranscript',transcript);put('speechPreviewTranscript',transcript);
  const match=speech.last_match,found=phrases().find(item=>item.id===(typeof match==='string'?match:match?.id));
  const outcome=speech.waiting_for_silence?'Pause briefly, then say a fresh complete phrase.':speech.last_outcome||
   (found?`Matched “${found.phrase}” · ${outputLabel(found,{compact:true})||'output unassigned'}`:speech.error||'No phrase matched yet.');
  const hasShortCommands=updateShortCommands(state);
  const suggestShortCommand=hasShortCommands&&running&&speech.ready&&speech.last_text&&
   !speech.partial&&!found&&!speech.waiting_for_silence&&!speech.error;
  put('speechMatch',String(outcome)+(suggestShortCommand?' Try a short command below.':''));
  put('speechPreviewMatch',String(outcome)+(suggestShortCommand?' Try a short command listed in Speech.':''));
  put('speechPrivacy',speech.error||'Recognition runs on this laptop. Microphone audio is not saved or uploaded.');
  const practice=w?.needs_practice?.find(item=>item.id===found?.id);
  $('speechConfirmPractice').disabled=!!state.armed||!running||!speech.ready||!found||!practice?.observed;
  $('speechConfirmPractice').textContent=found?'Confirm “'+found.phrase+'” was recognized':'Confirm recognized phrase';
  for(const row of $('speechMappings').children){
   const mapping=phrases().find(item=>item.id===row.dataset.speechId);if(!mapping)continue;
   const dirty=hasOperationalEdits(),status=cueStatus(state,mapping,'speech',{dirty});
   const note=alternateNotes.get(row),alternates=state.speech_aliases?.[mapping.id];
   if(note){
    const text=alternates?.length?'Also say '+quotePhrases(alternates):'';
    note.hidden=!text;
    if(note.textContent!==text)note.textContent=text;
   }
   const cell=row.querySelector('[data-speech-status]');if(cell.textContent!==status.text)cell.textContent=status.text;cell.dataset.tone=status.tone;
   const button=row.children[row.children.length-1].children[0],type=outputKind(mapping);
   const label=`Test ${type} live`,description=`Test ${type} for “${mapping.phrase}” live`;
   if(button.textContent!==label)button.textContent=label;
   if(button.getAttribute('aria-label')!==description)button.setAttribute('aria-label',description);
   button.disabled=!canTestMapping(state,mapping,'speech',dirty);
  }
  controls();debug.onState(state);
 }
 function fillConfig(config){
  const stage=config.cue_sheet==='air-obey';$('showSpeechEffectHeading').hidden=!stage;
  baseline=structuredClone(config.speech_mappings||DEFAULT_PHRASES);$('speechMappings').replaceChildren();
  for(const mapping of baseline){
   const row=document.createElement('tr');row.dataset.speechId=mapping.id;
   for(const field of ['enabled','phrase']){
    const cell=document.createElement('td'),input=document.createElement('input');input.dataset.field=field;input.type=field==='enabled'?'checkbox':'text';
    input.setAttribute('aria-label',`${field==='enabled'?'Enable':'Phrase for'} “${mapping.phrase}”`);
    if(field==='enabled')input.checked=mapping.enabled;else input.value=mapping[field]??'';
    cell.append(input);
    if(field==='phrase'){
     input.maxLength=160;
     const note=document.createElement('span');
     note.className='hint speech-row-alternates';note.id=`speech-alternates-${mapping.id}`;note.hidden=true;
     input.setAttribute('aria-describedby',note.id);
     cell.append(note);alternateNotes.set(row,note);
    }
    row.append(cell);
    if(stage&&field==='phrase'){const effect=document.createElement('td');effect.className='show-cue-effect';effect.textContent=getState()?.stage_effects?.[mapping.id]||STAGE_SPEECH_EFFECTS[mapping.id]||'—';row.append(effect);}
   }
   appendOutputFields(row,mapping,`“${mapping.phrase}”`);
   const status=document.createElement('td');status.dataset.speechStatus='';row.append(status);
   const actions=document.createElement('td'),button=document.createElement('button');button.type='button';
   button.onclick=wrapped(()=>{
    const saved=phrases().find(item=>item.id===mapping.id),target=savedOutputTarget(getState(),saved);
    if(!target)throw Error('Save and enable a mapping in the active input mode before testing.');
    openTarget(target.id);
   });
   actions.append(button);row.append(actions);$('speechMappings').append(row);
  }
  baselineBackend=config.speech_backend||'auto';$('speechBackend').value=baselineBackend;
  $('speechDebugPhrase').placeholder='e.g. '+(baseline[0]?.phrase||'Let there be light');
  $('microphoneSelect').value=config.microphone_id||'';onState(getState());
 }
 function gatherMappings(config=getState()?.config){
  return [...$('speechMappings').children].map(row=>{
   const base=baseline.find(item=>item.id===row.dataset.speechId),saved=config?.speech_mappings?.find(item=>item.id===row.dataset.speechId);
   return mergeMappingDraft(row,saved,base);
  });
 }
 function gatherBackend(config=getState()?.config){const value=$('speechBackend').value;return value===baselineBackend||!value?config?.speech_backend||baselineBackend:value;}
 $('speechMappings').addEventListener('input',event=>{onEdited(event);});
 $('speechBackend').addEventListener('input',event=>{onEdited(event);});
 $('speechSave').onclick=wrapped(saveSettings);
 $('speechSaveEngine').onclick=wrapped(async()=>{
  const selectionChanged=gatherBackend()!==(getState()?.config.speech_backend||'auto'),restart=running&&selectionChanged;
  if(restart)await stop();
  await saveSettings();
  if(restart&&getState()?.config.input_source!=='camera')await start();
 });
 $('speechUseBoth').onclick=wrapped(async()=>{$('speechUseBoth').disabled=true;try{await setInputSource('both');await start();notify(getState()?.workflow?.rehearsal?'Camera + speech selected for rehearsal. Say a phrase to check recognition.':'Camera + speech selected. Output is paused. Say the phrase, confirm its recognized match, then resume when ready.');}finally{$('speechUseBoth').disabled=false;}});
 $('speechConfirmPractice').onclick=wrapped(async()=>{
  const state=getState(),identity=typeof state.speech?.last_match==='string'?state.speech.last_match:state.speech?.last_match?.id;
  const practice=state.workflow?.needs_practice?.find(item=>item.id===identity);
  if(state.armed||!running||!state.speech?.ready||!practice?.observed)throw Error('Say the complete phrase into the microphone in Preview before confirming recognition.');
  await api('practice_confirm',{id:identity,observed:true,revision:state.workflow.revision,epoch:state.workflow.epoch});notify('Phrase recognition confirmed. Return to Session and resume when all checks are ready.');
 });
 $('microphoneStart').onclick=wrapped(start);$('speechPreviewStart').onclick=wrapped(start);$('microphoneStop').onclick=wrapped(()=>stop());
 $('microphoneRefresh').onclick=wrapped(async()=>{await devices();notify('Microphone list refreshed.');});
 $('microphoneSelect').onchange=wrapped(async()=>{
  const id=$('microphoneSelect').value,wasRunning=running;await stop();if(getState()?.owner!==client)await api('claim');
  await api('config',{config:{...getState().config,microphone_id:id}});if(wasRunning)await start();
 });
 document.addEventListener('visibilitychange',()=>{if(document.hidden)stop().catch(()=>{});});
 window.addEventListener('pagehide',()=>{abort?.abort();cleanLocal();});
 return {start,stop,cancelPending,onState,fillConfig,gatherMappings,gatherBackend,devices,isRunning:()=>running,resetCapture};
}
