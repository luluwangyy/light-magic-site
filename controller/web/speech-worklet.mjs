import {Pcm16Chunks} from './speech-audio.mjs';

class LocalSpeechCapture extends AudioWorkletProcessor {
 constructor({processorOptions}={}){
  super();
  // The worker accepts 100 ms (five VAD frames). The inline decoder needs the wider send budget.
  const chunkSamples=processorOptions?.packetMs===100?1600:3200;
  this.chunks=new Pcm16Chunks(sampleRate,16000,chunkSamples);
  this.generation=0;this.sequence=0;this.active=false;
  this.port.onmessage=event=>{if(event.data?.type==='reset'){this.chunks.reset();this.generation=event.data.generation;this.active=true;}else if(event.data?.type==='stop'){this.active=false;this.chunks.reset();}};
 }
 process(inputs,outputs){
  for(const output of outputs)for(const channel of output)channel.fill(0);
  const input=inputs[0]?.[0];
  if(this.active&&input){
   const capturedAt=currentTime+input.length/sampleRate;
   for(const chunk of this.chunks.push(input)){
    this.port.postMessage({...chunk,capturedAt,generation:this.generation,sequence:++this.sequence},[chunk.pcm]);
   }
  }
  return true;
 }
}
registerProcessor('local-speech-capture',LocalSpeechCapture);
