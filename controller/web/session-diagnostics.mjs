import {outputLabel} from './mapping-output.mjs';

const finite=value=>typeof value==='number'&&Number.isFinite(value);
const text=value=>typeof value==='string'?value.slice(0,600):'';
const label=value=>text(value).replaceAll('_',' ').replace(/^./,first=>first.toUpperCase());
const fraction=value=>finite(value)?Math.min(1,Math.max(0,value)):null;
const selectedSource=value=>['camera','speech','both'].includes(value)?value:'camera';
const safeTarget=target=>{
 if(!target||typeof target!=='object')return null;
 const result={};
 for(const key of ['output_type','cue_list','cue','channel','level','zoom','color']){
  const value=target[key];
  if(typeof value==='string'||finite(value)||value===null)result[key]=value;
 }
 if(Array.isArray(target.channels))result.channels=target.channels.slice(0,32).map(safeTarget);
 return result;
};

// Exports are built from this model, never from raw state. In particular, do not
// include config, feedback, identity, logs, audio streams, device IDs or templates.
export function buildSessionDiagnostics(context={}){
 const state=context.state||{},config=state.config||{},workflow=state.workflow||{},telemetry=state.telemetry||{},speech=state.speech||{};
 const source=selectedSource(config.input_source||workflow.input_source);
 const cameraSelected=source!=='speech',speechSelected=source!=='camera';
 const observation=context.cameraObservation||context.latestCameraObservation||null;
 const currentCamera=!!context.cameraRunning;
 const gesture=currentCamera?text(observation?.gesture||telemetry.gesture||'None'):'None';
 const confidence=fraction(observation?.confidence??telemetry.confidence);
 const uncertain=!!observation?.tracking_uncertain;
 const mapping=(config.mappings||[]).find(row=>row.gesture===gesture);
 const diagnostic=telemetry.camera_diagnostics||{};
 const hold=fraction(telemetry.hold)??0;
 const blockers=[];
 const add=(kind,message)=>{if(message&&!blockers.some(item=>item.message===message))blockers.push({kind,message});};
 if(!state.owner)add('owner','Start this session here to take browser control.');
 else if(state.owner!==context.client)add('owner','Another browser controls this session. Pause there before taking control here.');
 if(context.hasOperationalEdits)add('settings','Save the edited settings, then complete any checks that changed.');
 if(context.learning)add('learning','Finish learning or stop Practice before enabling automatic output.');
 for(const blocker of workflow.blockers||[])add(text(blocker.kind)||'session',text(blocker.message));
 const rehearsal=!!(workflow.rehearsal||state.rehearsal_only);
 const simulation=!!config.dry_run;
 if(rehearsal)add('rehearsal','Rehearsal shows recognized inputs without sending to the console. Start a console session when ready.');
 else if(simulation)add('simulation','Dry run simulates output. Start a console session to use live output.');
 if(cameraSelected&&!currentCamera)add('camera','Start the camera so this browser can supply current gesture observations.');
 if(speechSelected&&!(context.microphoneRunning??speech.ready))add('speech','Start the microphone for the selected speech input.');
 if(speechSelected&&speech.error)add('speech','Speech recognition needs attention. Check the microphone panel.');
 if(speechSelected&&speech.waiting_for_silence)add('speech_silence','Pause speaking briefly, then say a fresh complete phrase.');
 if(workflow.active&&workflow.fresh_gesture_required&&cameraSelected)add('fresh_neutral','Show a relaxed neutral pose before a fresh trigger. Keep it visible for at least 0.3 seconds.');
 if(cameraSelected&&currentCamera&&uncertain)add('tracking',text(observation.method)||'Tracking is uncertain. Keep the performer and hands clearly visible.');
 if(cameraSelected&&currentCamera&&gesture!=='None'&&mapping){
  if(!mapping.enabled)add('mapping','This gesture is recognized, but its saved output mapping is disabled.');
  else if(confidence!==null&&finite(mapping.confidence)&&confidence<mapping.confidence)add('confidence',`Hold a clearer pose: recognition is ${Math.round(confidence*100)}%, below the ${Math.round(mapping.confidence*100)}% threshold.`);
  else if(hold<1&&!workflow.fresh_gesture_required)add('hold',`Keep this pose steady${finite(mapping.hold_s)?` for ${mapping.hold_s} seconds`:''}. The bridge hold is ${Math.round(hold*100)}% complete.`);
 }
 if(!state.armed&&!rehearsal&&!simulation)add('paused',workflow.can_go_live?'Checks are complete. Resume output when ready.':'Output is paused while the session checks are completed.');
 if(state.armed&&context.localOutputPaused)add('browser_pause','Output is paused in this browser. Use Resume output after completing the current checks.');
 const dispatch=state.cue_dispatch||{},wait=finite(dispatch.wait_s)?Math.max(0,dispatch.wait_s):0;
 const target=outputLabel(dispatch)||'Mapped output';
 const queue=dispatch.kind==='waiting'?{state:'waiting',label:`${target} is waiting${wait>0?` for ${wait.toFixed(1)} seconds of console spacing`:''}.`,detail:dispatch.source==='camera'?'Keep the same pose visible. A changed pose cancels this request.':'This is a queued request, not a console write.',source:text(dispatch.source),wait_s:wait,target:safeTarget(dispatch)}:
  dispatch.kind==='dropped'?{state:'dropped',label:`${target} was not sent.`,detail:text(dispatch.reason)||'Repeat the trigger when ready.',source:text(dispatch.source),wait_s:wait,target:safeTarget(dispatch)}:
  {state:'clear',label:'No output is waiting.',detail:wait>0?`Console spacing has ${wait.toFixed(1)} seconds remaining.`:'Recognition can be checked independently of console output.',wait_s:wait,target:null};
 const receipt=state.last_output;
 const lastWrite=receipt?.kind==='sent'?{state:'sent',label:outputLabel(receipt)||'Mapped output',timestamp:text(receipt.timestamp),source:text(receipt.source),target:safeTarget(receipt),detail:'The bridge completed its console write. Confirm the visible fixture result on Eos.'}:
  {state:'none',label:'No actual console write is reported in this session.',detail:receipt?.kind==='simulated'?'The most recent output was simulated. Recognition and preview do not mean a console command was sent.':'A recognized input, stage preview or queued request does not establish a console write.'};
 const camera={selected:cameraSelected,running:currentCamera,gesture:gesture==='None'?'No gesture':label(gesture),confidence:currentCamera?confidence:null,uncertain,
  received_fps:finite(diagnostic.received_fps)?diagnostic.received_fps:null,
  phase:text(diagnostic.phase),gate_reason:text(diagnostic.reason),
  method:currentCamera?text(observation?.method):'',mapping:currentCamera&&mapping?{enabled:!!mapping.enabled,label:outputLabel(mapping)||'Output unassigned',threshold:fraction(mapping.confidence),hold_s:finite(mapping.hold_s)?mapping.hold_s:null}:null};
 const voice={selected:speechSelected,running:!!(context.microphoneRunning??speech.ready),partial:text(speech.partial),last_text:text(speech.last_text),confidence:fraction(speech.last_confidence),outcome:text(speech.last_outcome),waiting_for_silence:!!speech.waiting_for_silence};
 return {build_version:text(state.build_version)||'development',mode:!workflow.active?'not started':rehearsal?'rehearsal':simulation?'dry run':state.armed?'live':'paused',input_source:source,
  recognition:{camera,speech:voice},gate:{state:blockers.length?'waiting':'ready',label:blockers.length?'What is needed next':'Ready for a fresh enabled trigger',hold,blockers},queue,last_write:lastWrite,
  connection:{connected:!!state.connected,feedback_current:!!state.verified}};
}

export function exportSessionDiagnostics(context={},generatedAt=new Date().toISOString()){
 const model=buildSessionDiagnostics(context);
 // Blocker wording can originate in backend errors, so export only known
 // locally generated categories or a generic description for external text.
 const localKinds=new Set(['owner','settings','learning','rehearsal','simulation','camera','speech','speech_silence','fresh_neutral','tracking','mapping','confidence','hold','paused','browser_pause']);
 const safeMessage=message=>text(message).replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|home|var|tmp|private)\/)[^\r\n]*/g,'[local path omitted]');
 model.gate.blockers=model.gate.blockers.map(item=>({kind:item.kind,message:localKinds.has(item.kind)?safeMessage(item.message):'Complete the indicated session check in the app.'}));
 model.recognition.camera.method=safeMessage(model.recognition.camera.method);
 model.recognition.camera.gate_reason=safeMessage(model.recognition.camera.gate_reason);
 model.recognition.speech.outcome=safeMessage(model.recognition.speech.outcome);
 model.queue.detail=safeMessage(model.queue.detail);
 return {format:'Light Magic session diagnostics',version:1,generated_at:generatedAt,...model};
}

export function mountSessionDiagnostics(container,{client,notify=()=>{}}={}){
 if(!container)throw Error('A session diagnostics container is required.');
 const doc=container.ownerDocument||document;
 const make=(tag,content)=>{const node=doc.createElement(tag);if(content)node.textContent=content;return node;};
 const root=make('div');root.className='session-diagnostics';
 const heading=make('h3','Session diagnostics'),intro=make('p','Recognition, output readiness and console writes are shown separately.');
 const recognition=make('p'),speech=make('p'),gateHeading=make('h4','What is needed next'),blockers=make('ul');
 const progress=make('progress');progress.max=1;progress.value=0;progress.setAttribute('aria-label','Stable gesture hold');
 const hold=make('p'),queueHeading=make('h4','Output queue'),queue=make('p'),writeHeading=make('h4','Last console write'),write=make('p');
 const actions=make('div');actions.className='row';const copy=make('button','Copy diagnostics'),download=make('button','Download diagnostics'),status=make('p');
 copy.type=download.type='button';status.setAttribute('role','status');actions.append(copy,download);
 root.append(heading,intro,recognition,speech,gateHeading,blockers,progress,hold,queueHeading,queue,writeHeading,write,actions,status);container.replaceChildren(root);
 let context={client},model=null;
 const set=(node,value)=>{if(node.textContent!==value)node.textContent=value;};
 function update(next={}){
  context={...context,...next,client:next.client??client};model=buildSessionDiagnostics(context);
  const camera=model.recognition.camera,voice=model.recognition.speech;
  set(intro,`Version ${model.build_version}. Session: ${model.mode}. Input: ${model.input_source==='both'?'camera and speech':model.input_source}.`);
  set(recognition,!camera.selected?'Camera input is not selected.':!camera.running?'Camera is off.':`Camera sees: ${camera.gesture}${camera.confidence!==null?` · ${Math.round(camera.confidence*100)}%`:''}${camera.uncertain?' · tracking uncertain':''}.${camera.mapping?` Saved output: ${camera.mapping.label}${camera.mapping.enabled?'':' (disabled)'}.`:''}${camera.method?` ${camera.method}.`:''}`);
  speech.hidden=!voice.selected;
  set(speech,!voice.running?'Speech input: microphone is off.':`Speech heard: ${voice.partial?`“${voice.partial}” (in progress)`:voice.last_text?`“${voice.last_text}”`:'waiting for a complete phrase'}${voice.confidence!==null?` · ${Math.round(voice.confidence*100)}%`:''}.${voice.outcome?` ${voice.outcome}.`:''}`);
  set(gateHeading,model.gate.label);
  const messages=model.gate.blockers.map(item=>item.message);
  const signature=messages.join('\n');if(blockers.dataset.signature!==signature){blockers.dataset.signature=signature;blockers.replaceChildren(...messages.map(message=>make('li',message)));}
  progress.hidden=!camera.selected||!camera.running;progress.value=model.gate.hold;
  hold.hidden=progress.hidden;set(hold,`Stable hold: ${Math.round(model.gate.hold*100)}%.${camera.received_fps!==null?` Camera packets: ${camera.received_fps.toFixed(1)} per second.`:''} ${camera.gate_reason||'Complete a stable hold to request the saved output.'}`);
  set(queue,`${model.queue.label} ${model.queue.detail}`);
  const receipt=model.last_write;set(write,receipt.state==='sent'?`${receipt.label}${receipt.timestamp?` · ${receipt.timestamp}`:''}${receipt.source?` · ${label(receipt.source)}`:''}. ${receipt.detail}`:`${receipt.label} ${receipt.detail}`);
  return model;
 }
 const json=()=>JSON.stringify(exportSessionDiagnostics(context),null,2);
 copy.onclick=async()=>{
  try{await (doc.defaultView?.navigator||globalThis.navigator).clipboard.writeText(json());set(status,'Diagnostics copied. Device IDs, session tokens and learned templates are omitted.');}
  catch{set(status,'Clipboard unavailable. Use Download diagnostics.');notify('Clipboard unavailable. Use Download diagnostics.',true);}
 };
 download.onclick=()=>{
  const url=URL.createObjectURL(new Blob([json()],{type:'application/json'})),link=make('a');
  link.href=url;link.download='light-magic-diagnostics.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);set(status,'Diagnostics downloaded.');
 };
 update();return {update,onState:state=>update({state}),snapshot:()=>exportSessionDiagnostics(context),destroy:()=>container.replaceChildren()};
}
