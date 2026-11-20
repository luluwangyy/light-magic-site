/** Streaming mono resampling for the local PCM speech transport. */
export class Pcm16Chunks {
 constructor(inputRate,outputRate=16000,chunkSamples=3200){
  if(!Number.isFinite(inputRate)||inputRate<outputRate||!Number.isInteger(chunkSamples)||chunkSamples<1)throw Error('Unsupported microphone sample rate');
  this.ratio=inputRate/outputRate;this.chunkSamples=chunkSamples;this.reset();
 }
 reset(){this.sum=0;this.weight=0;this.position=0;this.energy=0;this.clipped=0;this.buffer=new Int16Array(this.chunkSamples);}
 push(input){
  const chunks=[];
  for(const raw of input){
   const sample=Number.isFinite(raw)?Math.max(-1,Math.min(1,raw)):0;let remaining=1;
   while(remaining>1e-9){
    const take=Math.min(remaining,this.ratio-this.weight);this.sum+=sample*take;this.weight+=take;remaining-=take;
    if(this.weight>=this.ratio-1e-9){
     const value=this.sum/this.ratio;this.buffer[this.position++]=Math.round(value*(value<0?32768:32767));this.energy+=value*value;this.clipped+=Number(Math.abs(value)>=.985);this.sum=0;this.weight=0;
     if(this.position===this.chunkSamples){chunks.push({pcm:this.buffer.buffer,rms:Math.sqrt(this.energy/this.chunkSamples),clipping:this.clipped/this.chunkSamples});this.position=0;this.energy=0;this.clipped=0;this.buffer=new Int16Array(this.chunkSamples);}
    }
   }
  }
  return chunks;
 }
}

export function pcmBase64(buffer){
 const bytes=new Uint8Array(buffer);let text='';
 for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));
 return btoa(text);
}

export function createSpeechSender({api,isCurrent,isFresh,onFailure}){
 let busy=false;
 const pending=[];
 const maxPending=4;
 const eligible=({chunk,capture})=>capture.streamId&&isCurrent(capture)&&isFresh(chunk);
 async function transmit(packet){
  if(!eligible(packet))return false;
  const {chunk,capture}=packet;
  try{
   await api('speech_audio',{stream_id:capture.streamId,sequence:chunk.sequence,pcm:pcmBase64(chunk.pcm),revision:capture.revision,epoch:capture.epoch});
   return true;
  }catch(error){if(isCurrent(capture))onFailure?.(error);return false;}
 }
 async function drain(){
  busy=true;
  try{
   while(pending.length){
    const packet=pending.shift();
    packet.resolve(await transmit(packet));
   }
  }finally{busy=false;}
 }
 return function send(chunk,capture){
  if(!eligible({chunk,capture}))return Promise.resolve(false);
  return new Promise(resolve=>{
   // A camera stall can deliver several fresh packets while a request is in flight.
   // Preserve their order so the recognizer can keep its partial utterance.
   if(pending.length===maxPending)pending.shift().resolve(false);
   pending.push({chunk,capture,resolve});
   if(!busy)void drain();
  });
 };
}
