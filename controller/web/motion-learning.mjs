// Local demonstration matching, not model training or a probability estimate.
// hand-v1: two fixed Left/Right slots of [present, wrist x, wrist y,
// sixteen rotation/scale-invariant finger features]. Total: 38 numbers.
import {poseFeatures} from './pose-calibration.mjs';

const SIZE=32,DIM=38,SLOT=19,FACTORS=[.75,1,1.3],MIN_ACTIVITY=.075;
const empty=()=>({best:null,candidate:null,matched:false});
const clamp=n=>Math.max(0,Math.min(1,n));

function validFrame(f){
 if(!Array.isArray(f)||f.length!==DIM||!f.every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=10))return false;
 for(const s of [0,SLOT]){
  if(f[s]!==0&&f[s]!==1)return false;
  if(f.slice(s+3,s+SLOT).some(n=>n<0))return false;
 }
 return f[0]===1||f[SLOT]===1;
}

export function extractMotionFrame(result,minQuality=.75){
 if(!result||!Number.isFinite(minQuality))return null;
 const out=Array(DIM).fill(0),quality=[-1,-1];
 for(let i=0;i<(result.landmarks||[]).length;i++){
  const image=result.landmarks[i],side=result.handedness?.[i]?.[0];
  if(!side||side.score<minQuality||!['Left','Right'].includes(side.categoryName))continue;
  const shape=poseFeatures(result.worldLandmarks?.[i]);
  if(!shape||!Array.isArray(image)||image.length!==21||!image.every(p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=-.02&&p.x<=1.02&&p.y>=-.02&&p.y<=1.02))continue;
  const slot=side.categoryName==='Left'?0:1;
  if(side.score<=quality[slot])continue;
  quality[slot]=side.score;
  const offset=slot*SLOT;
  out.splice(offset,SLOT,1,image[0].x,image[0].y,...shape);
 }
 return validFrame(out)?out:null;
}

function frameDistance(a,b){
 let sum=0,count=0;
 for(const s of [0,SLOT]){
  if(!a[s]&&!b[s])continue;
  count++;
  if(a[s]!==b[s]){sum+=1;continue;}
  let shape=0;
  for(let k=0;k<16;k++){
   const scale=k%4<2?3:1;
   shape+=((a[s+3+k]-b[s+3+k])/scale)**2;
  }
  const position=4*((a[s+1]-b[s+1])**2+(a[s+2]-b[s+2])**2);
  sum+=Math.sqrt(position+.75*shape/16);
 }
 return count?sum/count:1;
}

function activity(frames){
 let maximum=0;
 for(const s of [0,SLOT]){
  const present=frames.filter(f=>f[s]);
  if(present.length<3)continue;
  const min=Array(SLOT-1).fill(Infinity),max=Array(SLOT-1).fill(-Infinity);
  for(const f of present)for(let k=1;k<SLOT;k++){min[k-1]=Math.min(min[k-1],f[s+k]);max[k-1]=Math.max(max[k-1],f[s+k]);}
  let shape=0;
  for(let k=0;k<16;k++)shape+=((max[k+2]-min[k+2])/(k%4<2?3:1))**2;
  maximum=Math.max(maximum,Math.sqrt(4*((max[0]-min[0])**2+(max[1]-min[1])**2)+.75*shape/16));
 }
 return maximum;
}

function resample(samples,start,end){
 const output=[];let cursor=0;
 for(let i=0;i<SIZE;i++){
  const target=start+(end-start)*i/(SIZE-1);
  while(cursor+1<samples.length&&samples[cursor+1].timeMs<target)cursor++;
  const a=samples[cursor],b=samples[Math.min(cursor+1,samples.length-1)];
  const t=b.timeMs>a.timeMs?clamp((target-a.timeMs)/(b.timeMs-a.timeMs)):0;
  const frame=Array(DIM).fill(0);
  for(const s of [0,SLOT]){
   const nearest=t<.5?a.features:b.features;
   frame[s]=nearest[s];
   if(!frame[s])continue;
   if(a.features[s]&&b.features[s])for(let k=1;k<SLOT;k++)frame[s+k]=a.features[s+k]*(1-t)+b.features[s+k]*t;
   else for(let k=1;k<SLOT;k++)frame[s+k]=nearest[s+k];
  }
  output.push(frame);
 }
 return output;
}

function normalize(frames){
 // One shared anchor preserves initial spacing between two hands. It removes
 // whole-demonstration image translation, but keeps direction, amplitude, and
 // the changing distance between the hands. Left and Right are not swapped.
 const first=frames.find(f=>f[0]||f[SLOT]);
 const s=first[0]?0:SLOT,origin=[first[s+1],first[s+2]];
 return frames.map(f=>{
  const copy=f.slice();
  for(const offset of [0,SLOT])if(copy[offset]){copy[offset+1]-=origin[0];copy[offset+2]-=origin[1];}
  return copy;
 });
}

export function createMotionTemplate(samples){
 if(!Array.isArray(samples)||samples.length<8)throw Error('Record at least eight camera frames while performing the motion.');
 if(samples.some((s,i)=>!s||!Number.isFinite(s.timeMs)||(i&&s.timeMs<=samples[i-1].timeMs)))throw Error('Motion frames must have increasing capture times.');
 const good=samples.filter(s=>validFrame(s.features));
 if(good.length<8||good.length/samples.length<.75)throw Error('Hand tracking was lost. Keep the demonstrated hands in camera view and record again.');
 const duration=(good.at(-1).timeMs-good[0].timeMs)/1000;
 if(duration<.6||duration>6)throw Error('Record one complete motion lasting 0.6 to 6 seconds.');
 if(good.some((s,i)=>i&&s.timeMs-good[i-1].timeMs>450))throw Error('Hand tracking paused during the motion. Record again with the hand fully visible.');
 const frames=normalize(resample(good,good[0].timeMs,good.at(-1).timeMs));
 if(activity(frames)<MIN_ACTIVITY)throw Error('This recording is almost still. Demonstrate a movement; use the pose-learning controls for a static hand shape.');
 return {duration_s:duration,frames};
}

function validTemplate(t){return t&&Number.isFinite(t.duration_s)&&t.duration_s>=.6&&t.duration_s<=6&&Array.isArray(t.frames)&&t.frames.length===SIZE&&t.frames.every(validFrame)&&activity(t.frames)>=MIN_ACTIVITY;}

function dtw(a,b){
 const n=SIZE,band=6;
 const costs=Array.from({length:n+1},()=>Array(n+1).fill(Infinity));
 const lengths=Array.from({length:n+1},()=>Array(n+1).fill(0));costs[0][0]=0;
 for(let i=1;i<=n;i++)for(let j=Math.max(1,i-band);j<=Math.min(n,i+band);j++){
  const previous=[[i-1,j-1],[i-1,j],[i,j-1]].sort((p,q)=>costs[p[0]][p[1]]-costs[q[0]][q[1]])[0];
  costs[i][j]=costs[previous[0]][previous[1]]+frameDistance(a[i-1],b[j-1]);
  lengths[i][j]=lengths[previous[0]][previous[1]]+1;
 }
 const mean=costs[n][n]/Math.max(1,lengths[n][n]);
 // Exact endpoints keep an incomplete or reversed path from being accepted
 // merely because the interior can be compressed by dynamic time warping.
 const ends=(frameDistance(a[0],b[0])+frameDistance(a.at(-1),b.at(-1)))/2;
 return .75*mean+.25*ends;
}

export class MotionMatcher {
 constructor(motions=[]){this.motions=[];this.signature='';this.setMotions(motions);}
 reset(){this.history=[];this.lastValid=null;this.previous=null;this.quietSince=null;this.lastEvaluation=-Infinity;this.lastEvent=-Infinity;this.states=new Map();this.lastResult=empty();}
 setMotions(motions){
  const allowed=(Array.isArray(motions)?motions:[]).filter(m=>m&&m.enabled&&m.feature_version==='hand-v1'&&typeof m.id==='string'&&Array.isArray(m.templates)&&m.templates.some(validTemplate)).map(m=>({...m,threshold:Math.max(.7,Math.min(.98,Number(m.threshold)||.85)),cooldown_s:Math.max(1.5,Number(m.cooldown_s)||2),templates:m.templates.filter(validTemplate)}));
  const signature=JSON.stringify(allowed);
  if(signature===this.signature)return;
  this.signature=signature;this.motions=allowed;this.reset();
 }
 update(features,timeMs){
  if(!Number.isFinite(timeMs)){this.reset();return empty();}
  if(!validFrame(features)){
   if(this.lastValid!==null&&timeMs-this.lastValid>250){this.history=[];this.previous=null;this.quietSince=null;this.lastResult=empty();}
   return empty();
  }
  if(this.lastValid!==null&&(timeMs<=this.lastValid||timeMs-this.lastValid>450)){this.history=[];this.previous=null;this.quietSince=null;}
  const change=this.previous?frameDistance(this.previous,features):Infinity;
  if(change<.025){if(this.quietSince===null)this.quietSince=timeMs;}else this.quietSince=null;
  this.previous=features.slice();this.lastValid=timeMs;
  const maximum=Math.max(.8,...this.motions.flatMap(m=>m.templates.map(t=>t.duration_s*1.3)))*1000+200;
  this.history.push({timeMs,features:features.slice()});
  while(this.history.length&&this.history[0].timeMs<timeMs-maximum)this.history.shift();
  for(const motion of this.motions){
   const state=this.states.get(motion.id);
   if(state?.latched&&timeMs-state.firedAt>=motion.cooldown_s*1000&&timeMs-state.lastMatched>=500&&this.quietSince!==null&&timeMs-this.quietSince>=350)state.latched=false;
  }
  if(timeMs-this.lastEvaluation<120)return {...this.lastResult,candidate:null,matched:false};
  this.lastEvaluation=timeMs;
  const scores=[];
  for(const motion of this.motions){
   let similarity=0;
   for(const template of motion.templates)for(const factor of FACTORS)for(const lag of [0,100,200]){
    const end=timeMs-lag,duration=template.duration_s*factor*1000,start=end-duration;
    if(!this.history.length||this.history[0].timeMs>start)continue;
    const frames=normalize(resample(this.history,start,end));
    const amount=activity(frames),expected=activity(template.frames);
    if(amount<Math.max(MIN_ACTIVITY,expected*.5)||amount>expected*2.2)continue;
    const score=clamp(1-dtw(template.frames,frames)/.32);
    similarity=Math.max(similarity,score);
   }
   scores.push({id:motion.id,name:String(motion.name||motion.id),similarity,motion});
  }
  scores.sort((a,b)=>b.similarity-a.similarity);
  const first=scores[0],second=scores[1];
  const best=first?{id:first.id,name:first.name,similarity:first.similarity}:null;
  const ambiguous=!!second&&first.similarity-second.similarity<.04&&second.similarity>=second.motion.threshold-.04;
  let candidate=null;
  if(first&&first.similarity>=first.motion.threshold&&!ambiguous){
   let state=this.states.get(first.id);
   if(!state){state={latched:false,firedAt:-Infinity,lastMatched:timeMs};this.states.set(first.id,state);}
   state.lastMatched=timeMs;
   if(!state.latched&&timeMs-state.firedAt>=first.motion.cooldown_s*1000&&timeMs-this.lastEvent>=900){
    candidate={id:first.id,similarity:first.similarity};state.latched=true;state.firedAt=timeMs;this.lastEvent=timeMs;
    // A completed gesture cannot reuse its earlier frames for another trigger.
    this.history=[this.history.at(-1)];this.quietSince=null;
   }
  }
  this.lastResult={best,candidate,matched:!!candidate,ambiguous};
  return this.lastResult;
 }
}
