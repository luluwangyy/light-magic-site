import {createCameraRecognition,createSpeechRecognition} from './recognition.mjs?v=hand-tracking';

const $=id=>document.getElementById(id);
const channels=[1,2,9];
const warm='255 237 203';
const cues=new Map([
  ['1',{name:'Reveal',levels:[100,82,92],colors:[warm,'255 246 224',warm]}],
  ['2',{name:'Blackout',levels:[0,0,0],colors:[warm,warm,warm]}],
  ['3',{name:'Fire',levels:[80,100,56],colors:['255 111 47','255 157 65','241 62 42']}],
  ['4',{name:'Halo',levels:[30,100,30],colors:['170 208 255','255 236 164','170 208 255']}],
  ['5',{name:'Transformation',levels:[89,40,92],colors:['200 111 255','132 200 255','145 127 250']}],
  ['6',{name:'Red barrier',levels:[90,14,90],colors:['255 65 74','255 97 99','255 65 74']}],
  ['7',{name:'Command',levels:[12,100,12],colors:['184 210 255','247 243 228','184 210 255']}]
]);
const gestures=[
  ['open-palm','Open palm','1'],['fist','Fist','2'],['ankh','Ankh','4'],['fire','Fire','3']
];
const phrases=[
  ['light','Let there be light','1'],['abracadabra','Abracadabra','5'],
  ['barrier','They shall not pass','6'],['command','At my command','7'],['stand-down','Stand down','2']
];
const labels=new Map([...gestures,...phrases].map(([id,label])=>[id,label]));
const mappings=new Map([...gestures,...phrases].map(([id,,cue])=>[id,{type:'cue',cue,channel:9,level:30}]));
const fixtures=new Map(channels.map(channel=>[channel,{
  view:document.querySelector(`[data-fixture="${channel}"]`),
  readout:document.querySelector(`[data-level="${channel}"]`)
}]));

function setFixture(channel,level,color){
  const {view,readout}=fixtures.get(channel);
  if(color)view.style.setProperty('--color',color);
  view.style.setProperty('--strength',String(level/100));
  readout.textContent=level+'%';
}
function showCue(cue){
  const look=cues.get(cue);
  channels.forEach((channel,index)=>setFixture(channel,look.levels[index],look.colors[index]));
  return look.name;
}
const command=mapping=>mapping.type==='level'?`Chan ${mapping.channel} @ ${mapping.level}`:`List 1 · Cue ${mapping.cue}`;
function fire(id,source){
  const mapping=mappings.get(id);
  if(!mapping)return;
  let look;
  if(mapping.type==='level'){
    setFixture(mapping.channel,mapping.level);
    look=`Channel ${mapping.channel} at ${mapping.level}%`;
  }else look=showCue(mapping.cue);
  $('outputLook').textContent=look;
  $('outputDetail').textContent=`${command(mapping)} · ${labels.get(id)} · ${source}`;
}
for(const button of document.querySelectorAll('[data-trigger]')){
  button.onclick=()=>fire(button.dataset.trigger,'Gesture button');
}
$('resetStage').onclick=()=>{
  showCue('2');
  $('outputLook').textContent='Blackout';
  $('outputDetail').textContent='Lights reset. Choose a trigger to change them.';
};

const normalize=text=>text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const phraseMatches=new Map(phrases.map(([id,phrase])=>[normalize(phrase),id]));
function matchPhrase(text,source){
  const normalized=normalize(text);
  const id=phraseMatches.get(normalized)||(normalized.startsWith('at my command ')?'command':null);
  if(!id){
    $('phraseStatus').textContent=normalized?`No match for “${text.trim()}”. Try one of the sample phrases.`:'Type a phrase or choose a sample.';
    return;
  }
  $('phraseStatus').textContent=`Matched “${labels.get(id)}”.`;
  fire(id,source);
}
$('phraseForm').addEventListener('submit',event=>{
  event.preventDefault();
  matchPhrase($('phrase').value,'Typed phrase');
});
$('phrase').addEventListener('input',()=>{$('phraseStatus').textContent='';});
for(const button of document.querySelectorAll('[data-phrase]')){
  button.onclick=()=>{
    $('phrase').value=button.dataset.phrase;
    matchPhrase(button.dataset.phrase,'Sample phrase');
  };
}

const triggerSelect=$('mappingTrigger'),typeSelect=$('mappingType'),cueSelect=$('mappingCue');
for(const [name,items] of [['Gestures',gestures],['Phrases',phrases]]){
  const group=document.createElement('optgroup');
  group.label=name;
  for(const [id,label] of items)group.append(new Option(label,id));
  triggerSelect.append(group);
}
for(const [number,look] of cues)cueSelect.append(new Option(`Cue ${number} · ${look.name}`,number));
function showDestination(){
  const level=typeSelect.value==='level';
  $('cueFields').hidden=level;
  $('levelFields').hidden=!level;
  cueSelect.disabled=level;
  $('mappingChannel').disabled=!level;
  $('mappingLevel').disabled=!level;
}
function showMapping(){
  const mapping=mappings.get(triggerSelect.value);
  typeSelect.value=mapping.type;
  cueSelect.value=mapping.cue;
  $('mappingChannel').value=String(mapping.channel);
  $('mappingLevel').value=String(mapping.level);
  showDestination();
  $('mappingStatus').textContent=`Assigned to ${command(mapping)}.`;
}
triggerSelect.addEventListener('change',showMapping);
typeSelect.addEventListener('change',showDestination);
$('mappingForm').addEventListener('input',event=>{
  if(event.target!==triggerSelect)$('mappingStatus').textContent='Save changes to use the new mapping.';
});
$('mappingForm').addEventListener('submit',event=>{
  event.preventDefault();
  const id=triggerSelect.value,type=typeSelect.value,mapping={...mappings.get(id),type,cue:cueSelect.value};
  if(type==='level'){
    const raw=$('mappingLevel').value,level=Number(raw),channel=Number($('mappingChannel').value);
    if(raw===''||!Number.isFinite(level)||level<0||level>100||!fixtures.has(channel)){
      $('mappingStatus').textContent='Choose a channel and enter a level from 0 to 100%.';
      return;
    }
    Object.assign(mapping,{level,channel});
  }
  mappings.set(id,mapping);
  $('mappingStatus').textContent=`Saved ${labels.get(id)} → ${command(mapping)}.`;
});
$('tryMapping').onclick=()=>fire(triggerSelect.value,'Mapping test');
triggerSelect.value='open-palm';
showMapping();

function bindDevice({button,status,adapter,label,available=true,unavailable,onActive=()=>{}}){
  let active=false,generation=0;
  function reflect(next){
    active=next;
    button.textContent=(active?'Stop ':'Start ')+label.toLowerCase();
    onActive(active);
  }
  function stop(){
    if(!active)return;
    generation++;
    reflect(false);
    adapter.stop();
  }
  function notice(text){
    status.textContent=text;
    if(text===label+' stopped'){
      generation++;
      reflect(false);
    }
  }
  function fail(text){
    generation++;
    reflect(false);
    status.textContent=text;
  }
  button.disabled=!available;
  if(!available)status.textContent=unavailable;
  button.onclick=async()=>{
    if(!available)return;
    if(active){stop();return;}
    const attempt=++generation;
    reflect(true);
    try{
      const started=await adapter.start();
      if(!started&&attempt===generation)reflect(false);
    }catch(error){
      if(attempt===generation)fail(error.message||`Could not start the ${label.toLowerCase()}.`);
    }
  };
  return {stop,notice,fail,isActive:()=>active};
}

const video=$('rehearsalVideo');
const handOverlay=$('handOverlay');
const handContext=handOverlay.getContext('2d');
const handLines=[
  [0,1,2,3,4], [0,5,6,7,8], [5,9,10,11,12],
  [9,13,14,15,16], [13,17,18,19,20], [17,0],
];
function drawHand(landmarks){
  if(!handContext)return;
  const width=video.videoWidth,height=video.videoHeight;
  if(landmarks.length!==21||!width||!height){
    handContext.clearRect(0,0,handOverlay.width,handOverlay.height);
    return;
  }
  // The video and canvas use the same intrinsic dimensions, fit, and mirror.
  if(handOverlay.width!==width||handOverlay.height!==height){
    handOverlay.width=width;
    handOverlay.height=height;
  }
  const points=landmarks.map(({x,y})=>[x*width,y*height]);
  const radius=Math.min(width,height)*.009;
  handContext.clearRect(0,0,width,height);
  handContext.lineCap='round';
  handContext.lineJoin='round';
  handContext.beginPath();
  for(const [start,...rest] of handLines){
    handContext.moveTo(...points[start]);
    for(const index of rest)handContext.lineTo(...points[index]);
  }
  handContext.strokeStyle='#173326';
  handContext.lineWidth=radius*1.6;
  handContext.stroke();
  handContext.strokeStyle='#d7f6c8';
  handContext.lineWidth=radius*.75;
  handContext.stroke();
  handContext.beginPath();
  for(const [x,y] of points){
    handContext.moveTo(x+radius,y);
    handContext.arc(x,y,radius,0,2*Math.PI);
  }
  handContext.fillStyle='#e6f8cd';
  handContext.fill();
  handContext.strokeStyle='#173326';
  handContext.lineWidth=radius*.55;
  handContext.stroke();
}

let cameraControl,speechControl;
const camera=createCameraRecognition({
  video,
  onGesture:({gesture})=>{if(cameraControl?.isActive())fire(gesture,'Camera');},
  onLandmarks:drawHand,
  onStatus:text=>cameraControl?.notice(text),
  onError:text=>cameraControl?.fail(text)
});
cameraControl=bindDevice({
  button:$('cameraToggle'),status:$('cameraStatus'),adapter:camera,label:'Camera',
  available:!!navigator.mediaDevices?.getUserMedia,
  unavailable:'Camera access is unavailable here. Try the gesture buttons.',
  onActive:active=>{$('cameraPane').hidden=!active;}
});
const speech=createSpeechRecognition({
  onText:text=>{if(speechControl?.isActive())matchPhrase(text,'Microphone');},
  onStatus:text=>speechControl?.notice(text),
  onError:text=>speechControl?.fail(text)
});
speechControl=bindDevice({
  button:$('speechToggle'),status:$('speechStatus'),adapter:speech,label:'Microphone',
  available:speech.available,
  unavailable:'On-device speech is unavailable in this browser. Type a phrase or choose a sample.'
});
function stopDevices(){cameraControl.stop();speechControl.stop();}
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopDevices();});
window.addEventListener('pagehide',stopDevices);
