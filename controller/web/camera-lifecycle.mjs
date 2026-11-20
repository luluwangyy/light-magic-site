export class CameraStartCancelled extends Error{
 constructor(){super('Camera start cancelled. Choose Start camera when ready to retry.');this.name='CameraStartCancelled';}
}

export function stopCameraStream(stream){
 for(const track of stream?.getTracks?.()||[])try{track.stop();}catch{}
}

// Browser permission requests cannot be aborted. Ignore and dispose of a late
// result after timeout/cancellation so an old Start can never reopen the camera.
export function waitForCameraStage(operation,{signal,timeoutMs=30000,timeoutMessage='Camera start timed out. Choose Start camera to retry.',onLateValue}={}){
 return new Promise((resolve,reject)=>{
  let settled=false,timer;
  const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);};
  const fail=error=>{if(settled)return;settled=true;cleanup();reject(error);};
  const cancel=()=>fail(new CameraStartCancelled());
  timer=setTimeout(()=>fail(new Error(timeoutMessage)),timeoutMs);
  signal?.addEventListener('abort',cancel,{once:true});
  if(signal?.aborted)cancel();
  Promise.resolve(operation).then(value=>{
   if(settled){try{Promise.resolve(onLateValue?.(value)).catch(()=>{});}catch{}return;}
   settled=true;cleanup();resolve(value);
  },fail);
 });
}
