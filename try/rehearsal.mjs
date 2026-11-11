import {createCameraRecognition, createSpeechRecognition} from './recognition.mjs?v=hand-tracking';
import {createStagePreview} from './stage-preview.mjs';
import {mountSessionLayout} from './session-layout.mjs';

const $ = id => document.getElementById(id);
const stage = createStagePreview($('stagePreview'));
const layout = mountSessionLayout($('main'));
layout.setView('session');

async function readAsset(name) {
  const response = await fetch(new URL('./assets/' + name, import.meta.url));
  if (!response.ok) throw Error('The stage assets could not load.');
  return response.json();
}
let design, fixtures;
try {
  [design, fixtures] = await Promise.all([
    readAsset('movement-lab-channel-looks.json'),
    readAsset('movement-lab-fixtures.json'),
  ]);
} catch (error) {
  $('loadStatus').textContent = error.message + ' Refresh to retry.';
  throw error;
}
const looks = new Map(design.looks.map(look => [look.id, look]));
const channels = fixtures.fixtures.map(fixture => Number(fixture.channel));
const gestures = [
  ['open-palm', 'Open palm', 'reveal'], ['fist', 'Fist', 'blackout'],
  ['ankh', 'Ankh', 'halo'], ['fire', 'Fire', 'fire'],
];
const phrases = [
  ['light', 'Let there be light', 'white', 'White lights'],
  ['abracadabra', 'Abracadabra', 'transformation', 'Magic shift', 'Abra cadabra', 'Abra kadabra'],
  ['barrier', 'They shall not pass', 'barrier', 'Shield up'],
  ['command', 'At my command', 'command', 'Take command'],
  ['stand-down', 'Stand down', 'blackout', 'Lights out'],
];
const entries = [...gestures, ...phrases];
const labels = new Map(entries.map(([id, label]) => [id, label]));
const mappings = new Map(entries.map(([id, , look]) => [id, {type: 'look', look, channel: 9, level: 30}]));
const cueNumbers = new Map([...looks.keys()].map((id, index) => [id, index + 1]));

function showLook(mapping, input, source) {
  const look = looks.get(mapping.look);
  if (mapping.type === 'level') {
    stage.render({source, input, target: {output_type: 'channel_level', channel: mapping.channel, level: mapping.level}});
    return;
  }
  const name = mapping.type === 'cue' ? `Cue ${cueNumbers.get(look.id)} · ${look.name}` : look.name;
  stage.render({source, input, name, target: {output_type: 'channel_look', channels: look.channels}});
}
function fire(id, source, input = labels.get(id)) {
  const mapping = mappings.get(id);
  if (mapping) showLook(mapping, input, source);
}
for (const button of document.querySelectorAll('[data-trigger]')) {
  button.onclick = () => fire(button.dataset.trigger, 'manual');
}
$('resetStage').onclick = () => showLook({type: 'look', look: 'blackout'}, 'Reset lights', 'manual');

const normalize = text => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const phraseMatches = new Map(phrases.flatMap(([id, phrase, , ...aliases]) =>
  [phrase, ...aliases].map(text => [normalize(text), id])));
function matchPhrase(text, source) {
  const normalized = normalize(text);
  const id = phraseMatches.get(normalized) || (normalized.startsWith('at my command ') ? 'command' : null);
  $('phraseStatus').textContent = id ? `Matched “${labels.get(id)}”.` :
    normalized ? `No match for “${text.trim()}”. Try a short command.` : 'Type a phrase or choose a short command.';
  if (id) fire(id, source, text.trim());
}
$('phraseForm').addEventListener('submit', event => {
  event.preventDefault();
  matchPhrase($('phrase').value, 'speech');
});
$('phrase').addEventListener('input', () => { $('phraseStatus').textContent = ''; });
for (const button of document.querySelectorAll('[data-phrase]')) {
  button.onclick = () => {
    $('phrase').value = button.dataset.phrase;
    matchPhrase(button.dataset.phrase, 'speech');
  };
}

const triggerSelect = $('mappingTrigger'), typeSelect = $('mappingType'), cueSelect = $('mappingCue');
for (const [name, items] of [['Gestures', gestures], ['Phrases', phrases]]) {
  const group = document.createElement('optgroup');
  group.label = name;
  for (const [id, label] of items) group.append(new Option(label, id));
  triggerSelect.append(group);
}
$('mappingChannel').replaceChildren(...channels.map(channel => new Option(channel, channel)));
function showDestination(selected = cueSelect.value) {
  const type = typeSelect.value;
  const level = type === 'level';
  $('cueFields').hidden = level;
  $('levelFields').hidden = !level;
  $('cueFieldLabel').textContent = type === 'cue' ? 'Sample cue' : 'Stage look';
  if (!level) {
    cueSelect.replaceChildren(...design.looks.map(look =>
      new Option(type === 'cue' ? `Cue ${cueNumbers.get(look.id)} · ${look.name}` : look.name, look.id)));
    if (looks.has(selected)) cueSelect.value = selected;
  }
}
function showMapping() {
  const mapping = mappings.get(triggerSelect.value);
  typeSelect.value = mapping.type;
  $('mappingChannel').value = String(mapping.channel);
  $('mappingLevel').value = String(mapping.level);
  showDestination(mapping.look);
  $('mappingStatus').textContent = '';
}
triggerSelect.addEventListener('change', showMapping);
typeSelect.addEventListener('change', () => showDestination());
$('mappingForm').addEventListener('submit', event => {
  event.preventDefault();
  const id = triggerSelect.value;
  const mapping = {...mappings.get(id), type: typeSelect.value, look: cueSelect.value};
  if (mapping.type === 'level') {
    const level = $('mappingLevel').valueAsNumber, channel = Number($('mappingChannel').value);
    if (!Number.isFinite(level) || level < 0 || level > 100 || !channels.includes(channel)) {
      $('mappingStatus').textContent = 'Choose a channel and a level from 0 to 100%.';
      return;
    }
    Object.assign(mapping, {level, channel});
  }
  mappings.set(id, mapping);
  $('mappingStatus').textContent = `Saved “${labels.get(id)}” for this rehearsal.`;
});
$('tryMapping').onclick = () => fire(triggerSelect.value, 'manual');
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
  handContext.strokeStyle='#151515';
  handContext.lineWidth=radius*1.6;
  handContext.stroke();
  handContext.strokeStyle='#f4f4f4';
  handContext.lineWidth=radius*.75;
  handContext.stroke();
  handContext.beginPath();
  for(const [x,y] of points){
    handContext.moveTo(x+radius,y);
    handContext.arc(x,y,radius,0,2*Math.PI);
  }
  handContext.fillStyle='#fff';
  handContext.fill();
  handContext.strokeStyle='#151515';
  handContext.lineWidth=radius*.55;
  handContext.stroke();
}

let cameraControl,speechControl;
const camera=createCameraRecognition({
  video,
  onGesture:({gesture})=>{if(cameraControl?.isActive())fire(gesture,'camera');},
  onLandmarks:drawHand,
  onStatus:text=>cameraControl?.notice(text),
  onError:text=>cameraControl?.fail(text)
});
cameraControl=bindDevice({
  button:$('cameraToggle'),status:$('cameraStatus'),adapter:camera,label:'Camera',
  available:!!navigator.mediaDevices?.getUserMedia,
  unavailable:'Camera access is unavailable here. Try the gesture buttons.',
  onActive:active=>{$('cameraNote').textContent=active?'Camera on':'Camera off';}
});
const speech=createSpeechRecognition({
  onText:text=>{if(speechControl?.isActive())matchPhrase(text,'speech');},
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
