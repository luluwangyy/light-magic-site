const types=['cue','channel_level','channel_look'];
export const outputType=mapping=>types.includes(mapping?.output_type)?mapping.output_type:'cue';

const optionalValue=value=>value===''||value==null?null:value;
const validPercent=value=>Number.isFinite(value)&&value>=0&&value<=100;
const validColor=value=>typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value);
const validChannel=value=>Number.isInteger(value)&&value>=1&&value<=99999;
const maxLookChannels=32;
const lookEditors=new WeakMap();

function cleanChannels(rows){
 if(!Array.isArray(rows)||rows.length>maxLookChannels)throw Error('A channel look can include up to 32 channels.');
 const seen=new Set();
 return rows.map(row=>{
  const channel=row?.channel;
  if(!validChannel(channel))throw Error('Enter a whole channel number from 1 to 99999 for each row.');
  if(seen.has(channel))throw Error(`Channel ${channel} appears twice in this look.`);
  seen.add(channel);
  const settings={channel};
  for(const [key,label] of [['level','Intensity'],['zoom','Zoom']]){
   const value=optionalValue(row[key]);
   if(value===null)continue;
   if(!validPercent(value))throw Error(`${label} for channel ${channel} must be 0–100%.`);
   settings[key]=value;
  }
  const color=optionalValue(row.color);
  if(color!==null){
   if(!validColor(color))throw Error(`Use a color such as #e07822 for channel ${channel}.`);
   settings.color=color.toLowerCase();
  }
  if(Object.keys(settings).length===1)throw Error(`Enter intensity, zoom, or color for channel ${channel}.`);
  return settings;
 }).sort((a,b)=>a.channel-b.channel);
}

export function channelLookRows(rows){
 try{return cleanChannels(rows);}catch{return null;}
}

export function outputKind(mapping){
 const type=outputType(mapping);
 if(type==='cue')return 'cue';
 if(type==='channel_look')return 'look';
 return optionalValue(mapping.zoom)!==null||optionalValue(mapping.color)!==null?'fixture':'level';
}

export function outputLabel(mapping,{compact=false}={}){
 const type=outputType(mapping);
 if(type==='channel_look'){
  const count=channelLookRows(mapping.channels)?.length;
  return count?`Channel look · ${count} ${count===1?'channel':'channels'}`:'';
 }
 if(type==='channel_level'){
  const {channel}=mapping;
  if(!validChannel(channel))return '';
  const level=optionalValue(mapping.level),zoom=optionalValue(mapping.zoom),color=optionalValue(mapping.color);
  if((level!==null&&!validPercent(level))||(zoom!==null&&!validPercent(zoom))||(color!==null&&!validColor(color)))return '';
  if(level===null&&zoom===null&&color===null)return '';
  const parts=[level===null?`Chan ${channel}`:`Chan ${channel} @ ${level}`];
  if(zoom!==null)parts.push(`Zoom ${zoom}%`);
  if(color!==null)parts.push(`Color ${color.toLowerCase()}`);
  return parts.join(' · ');
 }
 return mapping?.cue?(compact?`Cue ${mapping.cue}`:`List ${mapping.cue_list} · Cue ${mapping.cue}`):'';
}

export function savedOutputTarget(state,mapping){
 if(!outputLabel(mapping))return undefined;
 const targets=state?.workflow?.targets;
 const type=outputType(mapping);
 if(type==='channel_look'){
  const channels=JSON.stringify(channelLookRows(mapping.channels));
  return targets?.find(target=>outputType(target)==='channel_look'&&
   JSON.stringify(channelLookRows(target.channels))===channels);
 }
 if(type==='channel_level'){
  const color=optionalValue(mapping.color)?.toLowerCase()??null;
  return targets?.find(target=>outputType(target)==='channel_level'&&target.channel===mapping.channel&&
   optionalValue(target.level)===optionalValue(mapping.level)&&optionalValue(target.zoom)===optionalValue(mapping.zoom)&&
   optionalValue(target.color)===color);
 }
 return targets?.find(target=>target.id===`cue:${mapping.cue_list}:${mapping.cue}`);
}

const numericFields=new Set(['cue_list','channel','level','zoom','confidence','hold_s','threshold']);
const optionalNumbers=new Set(['channel','level','zoom']);

// Keep an untouched control from overwriting a newer saved value. Hidden output fields retain their drafts.
export function mergeMappingDraft(row,saved,baseline,{validate=true}={}){
 const mapping={...(saved||baseline)};
 for(const input of row.querySelectorAll('[data-field]')){
  const field=input.dataset.field;
  const badInput=!input.hidden&&input.validity?.badInput;
  if(validate&&badInput)throw Error('Enter a valid number for '+(input.getAttribute('aria-label')||field)+'.');
  let base=field==='output_type'?outputType(baseline):baseline?.[field];
  if(optionalNumbers.has(field))base=optionalValue(base);
  let value=input.value;
  if(input.type==='checkbox')value=input.checked;
  else if(numericFields.has(field))value=badInput?NaN:optionalNumbers.has(field)&&value===''?null:Number(value);
  else if(field==='color'){
   base=optionalValue(base?.trim().toLowerCase());
   value=optionalValue(value.trim().toLowerCase());
  }
  if(value!==base)mapping[field]=value;
 }
 if(outputType(mapping)==='channel_look'){
  const editor=lookEditors.get(row);
  if(editor){
   const channels=editor.read(validate);
   const original=channelLookRows(baseline?.channels||[])||[];
   if(JSON.stringify(channels)!==JSON.stringify(original))mapping.channels=channels;
  }
 }
 return mapping;
}

export function bindColorPicker(color,picker){
 const sync=()=>{picker.value=validColor(color.value.trim())?color.value.trim().toLowerCase():'#ffffff';};
 sync();
 color.addEventListener('input',sync);
 picker.addEventListener('input',()=>{color.value=picker.value;});
 return sync;
}

export function mountChannelLookEditor(owner,container,channels=[]){
 const details=document.createElement('details'),summary=document.createElement('summary');
 details.className='channel-look-editor';
 const rows=document.createElement('div');
 rows.className='channel-look-rows';
 const add=document.createElement('button');
 add.type='button';add.textContent='Add channel';
 const controls=document.createElement('div');
 controls.className='channel-look-controls';
 controls.append(add);
 details.append(summary,rows,controls);
 container.append(details);
 let entries=[],disabled=false;

 function refresh(){
  const count=entries.length;
  summary.textContent=count?`Edit ${count} ${count===1?'channel':'channels'}`:'Edit channels';
  add.disabled=disabled||count>=maxLookChannels;
  entries.forEach(({inputs,remove,picker},index)=>{
   for(const input of Object.values(inputs)){
    input.setAttribute('aria-label',`${input.title} for look row ${index+1}`);
    input.disabled=disabled;
   }
   remove.setAttribute('aria-label',`Remove look row ${index+1}`);
   remove.disabled=disabled;
   picker.setAttribute('aria-label',`Choose color for look row ${index+1}`);
   picker.disabled=disabled;
  });
 }
 function updateRows(){rows.replaceChildren(...entries.map(entry=>entry.row));refresh();}
 function notifyEdited(){details.dispatchEvent?.(new Event('input',{bubbles:true}));}
 function makeRow(channel={}){
  const row=document.createElement('div');
  row.className='channel-look-row';
  const inputs={};
  for(const [key,label,placeholder] of [
   ['channel','Channel','Chan'],['level','Intensity (%)','Intensity %'],['zoom','Zoom (%)','Zoom %'],['color','Color hex code','#rrggbb']
  ]){
   const input=document.createElement('input');
   input.type=key==='color'?'text':'number';
   input.value=String(channel[key]??'');input.placeholder=placeholder;input.title=label;
   input.dataset.lookField=key;
   if(key==='color'){
    input.maxLength=7;input.spellcheck=false;input.autocomplete='off';
   }else{
    input.min=key==='channel'?'1':'0';input.max=key==='channel'?'99999':'100';
    input.step=key==='channel'?'1':'any';
   }
   inputs[key]=input;
   const field=document.createElement('label');
   field.textContent=key==='color'?'Color':label;
   field.append(input);row.append(field);
  }
  const picker=document.createElement('input');
  picker.type='color';picker.className='channel-look-picker';
  bindColorPicker(inputs.color,picker);
  row.append(picker);
  const remove=document.createElement('button');
  remove.type='button';remove.className='channel-look-remove';remove.textContent='Remove';
  const entry={row,inputs,remove,picker};
  remove.onclick=()=>{
   if(disabled)return;
   const index=entries.indexOf(entry);
   entries=entries.filter(item=>item!==entry);
   updateRows();
   (entries[index]?.inputs.channel||entries.at(-1)?.inputs.channel||add).focus?.();
   notifyEdited();
  };
  row.append(remove);
  return entry;
 }
 add.onclick=()=>{
  if(disabled||entries.length>=maxLookChannels)return;
  const entry=makeRow();entries.push(entry);updateRows();entry.inputs.channel.focus?.();notifyEdited();
 };
 const editor={
  set(channels){entries=(Array.isArray(channels)?channels:[]).map(makeRow);updateRows();},
  setDisabled(value){
   if(disabled===value&&add.disabled===(disabled||entries.length>=maxLookChannels))return;
   disabled=value;refresh();
  },
  read(validate=true){
   const inputRows=entries.map(({inputs})=>{
    const values={};
    for(const [key,input] of Object.entries(inputs)){
     if(input.validity?.badInput){values[key]=NaN;continue;}
     const value=input.value.trim();
     if(value)values[key]=key==='color'?value.toLowerCase():Number(value);
    }
    return values;
   }).filter(settings=>Object.keys(settings).length);
   return validate?cleanChannels(inputRows):channelLookRows(inputRows)||inputRows;
  }
 };
 lookEditors.set(owner,editor);
 editor.set(channels);
 return editor;
}

export function setChannelLookEditorDisabled(owner,disabled){
 lookEditors.get(owner)?.setDisabled(disabled);
}

export function appendOutputFields(row,mapping,name){
 const typeCell=document.createElement('td'),selector=document.createElement('select');
 typeCell.className='mapping-output-type';
 selector.dataset.field='output_type';
 selector.setAttribute('aria-label',`Output for ${name}`);
 for(const [value,label] of [['cue','Cue'],['channel_level','Channel settings'],['channel_look','Channel look']]){
  const option=document.createElement('option');option.value=value;option.textContent=label;selector.append(option);
 }
 selector.value=outputType(mapping);
 typeCell.append(selector);row.append(typeCell);
 function field(key,label,{type='number',min,max,step,placeholder}={}){
  const input=document.createElement('input');input.dataset.field=key;input.type=type;input.value=mapping[key]??'';
  input.setAttribute('aria-label',`${label} for ${name}`);
  if(min!==undefined)input.min=String(min);
  if(max!==undefined)input.max=String(max);
  if(step!==undefined)input.step=String(step);
  if(placeholder)input.placeholder=placeholder;
  return input;
 }
 const list=field('cue_list','Cue list',{min:1,max:999,step:1});
 const cue=field('cue','Cue number',{type:'text',placeholder:'Unassigned'});cue.inputMode='decimal';
 const channel=field('channel','Channel',{min:1,max:99999,step:1,placeholder:'Channel'});
 const level=field('level','Intensity percent',{min:0,max:100,step:'any',placeholder:'Intensity %'});
 const zoom=field('zoom','Beam zoom percent',{min:0,max:100,step:'any',placeholder:'Zoom %'});
 zoom.title='Enter an Eos zoom level from 0 to 100%. Clear this field to leave zoom unchanged.';
 const color=field('color','Color hex code (blank keeps current color)',{type:'text',placeholder:'#rrggbb'});
 color.maxLength=7;color.spellcheck=false;color.autocomplete='off';color.title='Enter a color such as #e07822. Clear this field to leave color unchanged.';
 const picker=document.createElement('input');picker.type='color';picker.className='mapping-fixture-color';
 picker.setAttribute('aria-label',`Choose color for ${name}`);
 picker.title='Choose a color';
 bindColorPicker(color,picker);
 const fixtureSettings=[level,zoom,color,picker];
 const look=document.createElement('div');
 mountChannelLookEditor(row,look,mapping.channels);
 for(const input of [level,zoom,color])input.className='mapping-fixture-field';
 for(const pair of [[list,channel],[cue,...fixtureSettings,look]]){
  const cell=document.createElement('td');cell.className='mapping-output-destination';cell.append(...pair);row.append(cell);
 }
 function showSelected(){
  const usesChannel=selector.value==='channel_level';
  const usesCue=selector.value==='cue';
  list.hidden=!usesCue;cue.hidden=!usesCue;channel.hidden=!usesChannel;
  for(const input of fixtureSettings)input.hidden=!usesChannel;
  look.hidden=selector.value!=='channel_look';
 }
 selector.addEventListener('input',showSelected);showSelected();
}
