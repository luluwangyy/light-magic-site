import {outputLabel} from './mapping-output.mjs';

const names={Open_Palm:'Open palm',Closed_Fist:'Fist',Fire_Gesture:'Fire',Ankh_Pose:'Ankh'};

export function mountRehearsalControls(root,{api,getState,client,notify}){
 const doc=root.ownerDocument;
 const heading=doc.createElement('h2');
 heading.textContent='Try a mapping';
 const hint=doc.createElement('p');
 hint.className='hint';
 hint.textContent='These buttons simulate inputs on the stage preview. Use the camera and microphone to check recognition.';
 const controls=doc.createElement('div');
 controls.className='row';
 const status=doc.createElement('p');
 status.className='hint';
 status.setAttribute('role','status');
 root.replaceChildren(heading,hint,controls,status);
 let signature='',busy=false;
 function onState(state=getState()){
  const w=state?.workflow;
  root.hidden=!w?.active||!w.rehearsal;
  if(root.hidden)return;
  const entries=[
   ...(state.config.mappings||[]).filter(mapping=>mapping.gesture in names).map(mapping=>({
    name:names[mapping.gesture],source:'camera',gesture:mapping.gesture,mapping,
   })),
   ...(state.config.speech_mappings||[]).map(mapping=>({
    name:mapping.phrase,source:'speech',id:mapping.id,mapping,
   })),
  ];
  const next=JSON.stringify(entries.map(entry=>[entry.name,entry.id,entry.gesture,entry.mapping.enabled,outputLabel(entry.mapping)]));
  if(next!==signature){
   signature=next;
   controls.replaceChildren(...entries.map(entry=>{
    const button=doc.createElement('button');
    button.type='button';
    button.textContent=entry.name;
    button.title=outputLabel(entry.mapping)||'Assign an output in Cue sheet';
    button.onclick=async()=>{
     if(busy)return;
     busy=true;onState();
     try{
      const {revision,epoch}=getState().workflow;
      const result=await api('rehearsal_trigger',{source:entry.source,gesture:entry.gesture,id:entry.id,revision,epoch});
      status.textContent=result.stage_preview?.message||entry.name+' shown on stage.';
     }catch(error){status.textContent=error.message;notify(error.message,true);}
     finally{busy=false;onState();}
    };
    return button;
   }));
  }
  for(const button of controls.children)button.disabled=busy||state.owner!==client;
 }
 return {onState};
}
