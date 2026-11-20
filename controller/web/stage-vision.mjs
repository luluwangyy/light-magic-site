// Local camera inference for one performer. Geometry scores are support
// indicators, not trained probabilities. Neither frames nor crops leave this tab.
const ASSETS = new URL('./assets/', import.meta.url);
const POSE_URL = new URL('pose_landmarker_lite.task', ASSETS).href;
const HAND_URL = new URL('gesture_recognizer.task', ASSETS).href;
const SIDES = [[11, 13, 15], [12, 14, 16]];
const MIN_FRAME_MS = 68;
const POSE_INTERVAL_MS = 125;
const POSE_EXPIRY_MS = 210;
const POSE_RETRY_INTERVAL_MS = 500;
// Match the stage hand association and bridge hold window. A freshly observed
// performer at a slower camera cadence still contributes hold evidence.
const OBSERVATION_GAP_MS = 450;
// Keep scene ambiguity and arm-lowering guards independent of camera cadence.
const AMBIGUITY_GUARD_MS = 300;
const FULL_SCAN_INTERVAL_MS = 430;
const TRACKED_SCAN_INTERVAL_MS = 850;
const FIRST_CROP_BUDGET_MS = 112;
const SECOND_CROP_BUDGET_MS = 82;
const EMPTY_HANDS = Object.freeze({landmarks: [], worldLandmarks: [], handedness: [], gestures: [], wristSides: []});
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const xy = (p, w, h) => [p.x*w, p.y*h];
const diff = (a, b) => a.map((n, i) => n-b[i]);
const dot = (a, b) => a.reduce((sum, n, i) => sum+n*b[i], 0);
const length = a => Math.hypot(...a);
const distance = (a, b) => length(diff(a, b));
const angle = (a, b, c) => {
  const u = diff(a, b), v = diff(c, b), norm = length(u)*length(v);
  return norm > 1e-9 ? Math.acos(clamp(dot(u, v)/norm, -1, 1))*180/Math.PI : 0;
};
const pointInFrame = (p, margin = 0) => p && finite(p.x) && finite(p.y) &&
  p.x >= margin && p.x <= 1-margin && p.y >= margin && p.y <= 1-margin;
const visibility = p => p && finite(p.visibility) ?
  Math.min(p.visibility, finite(p.presence) ? p.presence : 1) : 0;
const visible = (p, threshold = .60) => pointInFrame(p, .006) && visibility(p) >= threshold;

export function exposureStats(rgba) {
  const counts = new Uint32Array(256);
  let total = 0;
  for(let i = 0; i+3 < rgba.length; i+=4) {
    if(!rgba[i+3]) continue;
    counts[(54*rgba[i]+183*rgba[i+1]+19*rgba[i+2]) >> 8]++;
    total++;
  }
  if(!total) return {light: 'unknown', gamma: 1, p50: 0, p90: 0, p98: 0};
  const percentile = ratio => {
    const target = Math.ceil(total*ratio);
    for(let i=0, n=0; i<256; i++) if((n+=counts[i]) >= target) return i;
    return 255;
  };
  const p50 = percentile(.5), p90 = percentile(.9), p98 = percentile(.98);
  const light = p90 < 34 && p98 < 90 ? 'very dark' : p90 < 85 ? 'dim' : 'adequate';
  // Use a bounded lift on non-flat images. No brightening can recover a
  // clipped silhouette, and unrestricted gain mostly amplifies sensor noise.
  const anchor = Math.max(p90, p98*.55);
  const gamma = light !== 'adequate' && anchor >= 10 && p98-p50 >= 13 ?
    clamp(Math.log(92/255)/Math.log(anchor/255), .57, 1) : 1;
  return {light, gamma, p50, p90, p98};
}

export function armsAtRest(landmarks, width, height) {
  if(!landmarks) return false;
  const shoulders=SIDES.map(([s])=>landmarks[s]);
  if(!shoulders.every(point=>visible(point,.65))) return false;
  const span=distance(xy(shoulders[0],width,height),xy(shoulders[1],width,height));
  if(span<Math.max(23,.048*Math.min(width,height))) return false;
  return SIDES.every(([s,e,w])=>{
    const [shoulder,elbow,wrist]=[landmarks[s],landmarks[e],landmarks[w]];
    return visible(elbow,.60)&&visible(wrist,.60)&&
      (elbow.y-shoulder.y)*height>=.40*span&&
      (wrist.y-elbow.y)*height>=.20*span&&
      Math.abs(wrist.x-shoulder.x)*width<=.60*span;
  });
}

export function evaluateAnkh(landmarks, width, height) {
  const none = reason => ({match: false, forming: false, score: 0, reason});
  if(!landmarks || !width || !height) return none('No body detected');
  const shoulders = [landmarks[11], landmarks[12]];
  if(!shoulders.every(p => visible(p, .62))) return none('Keep both shoulders visible');
  const [a,b] = shoulders.map(p => xy(p,width,height));
  const shoulder = distance(a,b);
  if(shoulder < Math.max(23, .048*Math.min(width,height))) return none('Performer is too small in the camera');
  const axis = diff(b,a).map(n => n/shoulder);
  const vertical = [-axis[1],axis[0]];
  if(Math.abs(axis[0]) < .89) return none('Face the camera with both shoulders level');
  const measures = SIDES.map(([s,e,w], i) => {
    const dir = i ? 1 : -1, origin = xy(landmarks[s],width,height);
    if(!visible(landmarks[e], .48)) return null;
    const elbow = xy(landmarks[e],width,height), ed = diff(elbow,origin);
    const elbowReach = dir*dot(ed,axis)/shoulder;
    const elbowRise = Math.abs(dot(ed,vertical))/shoulder;
    const elbowOut = elbowReach >= .28 && elbowRise <= .55;
    if(!visible(landmarks[w], .48)) return {elbowOut, wristVisible: false};
    const wrist = xy(landmarks[w],width,height), wd = diff(wrist,origin);
    const wristReach = dir*dot(wd,axis)/shoulder, wristRise = Math.abs(dot(wd,vertical))/shoulder;
    const bend = angle(origin,elbow,wrist), forearmReach = wristReach-elbowReach;
    const quality = Math.min(visibility(landmarks[s]), visibility(landmarks[e]), visibility(landmarks[w]));
    return {elbowOut, wristVisible: true, elbowReach, elbowRise, wristReach, wristRise, bend, forearmReach, quality};
  });
  const forming = measures.every(m => m?.elbowOut &&
    (!m.wristVisible || (m.wristReach >= .52 && m.wristRise <= .84 && m.forearmReach > .06)));
  // Only a credible extended arm warrants a second view of a missed Ankh.
  const retry = measures.some(m => m?.wristVisible && m.quality >= .60 && m.elbowOut &&
    m.wristReach >= .92 && m.wristRise <= Math.max(.66,.40*m.wristReach) &&
    m.forearmReach >= .25 && m.bend >= 146);
  if(!measures.every(m => m?.wristVisible)) {
    return {...none('Keep both elbows and wrists in view'), forming, retry};
  }
  if(!forming) return {...none('Extend both arms sideways'), retry};
  // A turned shoulder line can look narrower than the arm length. Allow a
  // bounded arm angle as well as a distance measured in shoulder widths.
  const match = measures.every(m => m.quality >= .60 &&
    m.elbowReach >= .36 && m.elbowReach <= 1.30 && m.elbowRise <= Math.max(.42,.52*m.elbowReach) &&
    m.wristReach >= .92 && m.wristReach <= 2.28 && m.wristRise <= Math.max(.66,.40*m.wristReach) &&
    m.forearmReach >= .25 && m.bend >= 146) &&
    measures[0].wristReach+measures[1].wristReach >= 2.02 &&
    Math.min(...measures.map(m=>m.wristReach))/Math.max(...measures.map(m=>m.wristReach)) >= .61;
  const score = match ? .50 + .50*Math.min(...measures.map(m=>m.quality)) : 0;
  return {match, forming, retry, score, reason: match ? 'Both arms extended' : 'Straighten both arms near shoulder height'};
}

// Crop coordinates are in source pixels. The crop is square; clamping at
// frame edges avoids padding and keeps remapping exact.
export function wristRegions(pose, width, height) {
  if(!pose || !visible(pose[11],.54) || !visible(pose[12],.54)) return [];
  const shoulder = distance(xy(pose[11],width,height),xy(pose[12],width,height));
  if(shoulder < 19) return [];
  return SIDES.flatMap(([s,e,w],side) => {
    if(!visible(pose[w],.62)) return [];
    const wrist=xy(pose[w],width,height);
    const forearm=visible(pose[e],.51)?diff(wrist,xy(pose[e],width,height)):null;
    const forearmLength=forearm?length(forearm):0;
    const directionKnown=forearmLength>=.20*shoulder && forearmLength<=1.45*shoulder;
    // The hand may face directly into the lens or the elbow may be hidden.
    // A reliable wrist can still seed a crop; use a tighter match radius
    // without a trustworthy direction, and never invent elbow evidence.
    if(!directionKnown&&!visible(pose[w],.78)) return [];
    const size=Math.min(Math.min(width,height)*.52,
      Math.max(54,(directionKnown?1.16:1.45)*shoulder,directionKnown?1.57*forearmLength:0));
    // Leave room beyond the wrist for fully extended fingertips, including
    // a raised hand that occupies a small part of the whole stage frame.
    const offset=directionKnown?clamp(forearmLength*.43,.16*shoulder,.42*shoulder):0;
    const center=directionKnown?wrist.map((n,i)=>n+forearm[i]*offset/forearmLength):wrist;
    return [{side,wrist,shoulder,size,elevation:(pose[s].y-pose[w].y)*height/shoulder,
      gate:Math.max(12,(directionKnown ? .34 : .25)*shoulder),
      x:clamp(center[0]-size/2,0,width-size), y:clamp(center[1]-size/2,0,height-size)}];
  });
}

export function remapHand(points, crop, width, height) {
  return points.map(p=>({...p,x:(crop.x+p.x*crop.size)/width,
    y:(crop.y+p.y*crop.size)/height,z:finite(p.z)?p.z*crop.size/width:0}));
}

function readHands(result) {
  return (result?.landmarks || []).flatMap((points,i)=>{
    if(!Array.isArray(points) || points.length!==21 || !points.every(p=>pointInFrame(p,.003))) return [];
    const handedness=(result.handedness || result.handednesses)?.[i] || [];
    const gestures=result.gestures?.[i] || [];
    return [{points,world:result.worldLandmarks?.[i] || [],handedness,gestures,
      quality:handedness[0]?.score || 0, source:'full frame'}];
  });
}

function handResult(hands) {
  return {landmarks:hands.map(x=>x.points), worldLandmarks:hands.map(x=>x.world),
    handedness:hands.map(x=>x.handedness), gestures:hands.map(x=>x.gestures),
    wristSides:hands.map(x=>x.wristSide??null)};
}

function palmPixels(hand, width, height) {
  return distance(xy(hand.points[0],width,height),xy(hand.points[9],width,height));
}

export function matchWrist(hand, regions, width, height) {
  const wrist=xy(hand.points[0],width,height);
  const matches=regions.map(r=>({r, d:distance(wrist,r.wrist)}))
    .filter(({r,d})=>d<=r.gate).sort((a,b)=>a.d-b.d);
  if(!matches.length || (matches.length>1 && matches[1].d-matches[0].d < .12*matches[0].r.shoulder)) return null;
  return matches[0].r.side;
}

const qualityKey = hand => Number(hand.gestures[0]?.categoryName !== 'None' &&
  hand.gestures[0]?.score >= .65) + hand.quality;

function associateHands(hands, regions, width, height) {
  const bySide=new Map();
  for(const hand of hands) {
    const side=matchWrist(hand,regions,width,height);
    if(side===null || palmPixels(hand,width,height)<7) continue;
    if(!bySide.has(side) || qualityKey(hand)>qualityKey(bySide.get(side))) bySide.set(side,hand);
  }
  return bySide;
}

export function evaluateFireShape(points) {
  const none=reason=>({match:false, score:0, reason});
  if(!Array.isArray(points) || points.length!==21 ||
      !points.every(p=>p && [p.x,p.y,p.z].every(finite))) return none('No reliable hand shape');
  const p=points.map(({x,y,z})=>[x,y,z]), scale=distance(p[0],p[9]);
  if(scale < 1e-5 || distance(p[5],p[17])<scale*.28) return none('No reliable palm geometry');
  const towardFingers=diff(p[9],p[0]).map(n=>n/scale);
  const extended = m => {
    const [a,b,c,d]=p.slice(m,m+4);
    return angle(a,b,c)>=150 && angle(b,c,d)>=131 &&
      distance(d,p[0])>=1.12*distance(b,p[0]) && distance(a,d)>=scale*.58;
  };
  const folded = m => {
    const [a,b,c,d]=p.slice(m,m+4);
    return [distance(a,b),distance(b,c),distance(c,d)].every(n=>n>=.04*scale) &&
      angle(a,b,c)<=138 && dot(diff(d,a),towardFingers)<=.15*scale &&
      distance(d,p[0])<=1.10*distance(b,p[0]);
  };
  const thumb = angle(p[2],p[3],p[4])>=145 && distance(p[4],p[9])>=.78*scale &&
    distance(p[4],p[5])>=.50*scale && distance(p[2],p[4])>=.56*scale;
  const match = thumb && extended(5) && extended(9) && folded(13) && folded(17) &&
    distance(p[8],p[12])>=.17*scale;
  return match ? {match:true,score:.85,reason:'Three-finger Fire shape seen'} :
    none('Show thumb, index and middle fingers; fold ring and little fingers');
}

function subjectKey(points, width, height) {
  if(!points || !visible(points[11],.57) || !visible(points[12],.57)) return null;
  const [a,b]=[11,12].map(i=>xy(points[i],width,height));
  const scale=distance(a,b);
  if(scale<19) return null;
  return {scale,center:a.map((n,i)=>(n+b[i])/2),axis:diff(b,a).map(n=>n/scale)};
}

function sameSubject(a,b) {
  if(!a || !b) return false;
  return distance(a.center,b.center) <= .51*Math.max(a.scale,b.scale) &&
    b.scale/a.scale >= .72 && b.scale/a.scale <= 1.38 && dot(a.axis,b.axis)>.70;
}

export class PoseHold {
  constructor() {this.reset();}
  reset() {this.start=null;this.count=0;this.last=-Infinity;}
  update(match, now, same = true, duration = 210, minFrames = 3) {
    if(!match || !finite(now)) {this.reset();return false;}
    if(!same || now<=this.last || now-this.last>OBSERVATION_GAP_MS) this.reset();
    if(this.start===null) this.start=now;
    this.last=now;this.count++;
    return this.count>=minFrames && now-this.start>=duration;
  }
}

const domCanvas = () => document.createElement('canvas');
function canvasSize(canvas, width, height) {
  if(canvas.width!==width) canvas.width=width;
  if(canvas.height!==height) canvas.height=height;
}
const renderFit = (canvas, ctx, source, width, height, maxEdge, mirrored=false) => {
  const scale=Math.min(1,maxEdge/Math.max(width,height));
  canvasSize(canvas,Math.max(1,Math.round(width*scale)),Math.max(1,Math.round(height*scale)));
  if(mirrored) {ctx.save();ctx.translate(canvas.width,0);ctx.scale(-1,1);}
  ctx.drawImage(source,0,0,canvas.width,canvas.height);
  if(mirrored) ctx.restore();
};

const OPPOSITE_JOINTS=[0,4,5,6,1,2,3,8,7,10,9,12,11,14,13,16,15,18,17,20,19,22,21,24,23,26,25,28,27,30,29,32,31];
const unmirrorPose=points=>OPPOSITE_JOINTS.map(i=>({...points[i],x:1-points[i].x}));

function lift(ctx, canvas, gamma) {
  if(gamma >= .985) return;
  const image=ctx.getImageData(0,0,canvas.width,canvas.height);
  const table=Uint8ClampedArray.from({length:256},(_,i)=>255*(i/255)**gamma);
  for(let i=0;i<image.data.length;i+=4) {
    image.data[i]=table[image.data[i]];image.data[i+1]=table[image.data[i+1]];
    image.data[i+2]=table[image.data[i+2]];
  }
  ctx.putImageData(image,0,0);
}

export class StageVision {
  constructor({pose, rescue, makeCanvas=domCanvas, clock=()=>performance.now()}) {
    this.pose=pose;this.rescue=rescue;this.clock=clock;
    this.sampleCanvas=makeCanvas();this.sampleCtx=this.sampleCanvas.getContext('2d',{willReadFrequently:true});
    this.enhanced=makeCanvas();this.enhancedCtx=this.enhanced.getContext('2d',{willReadFrequently:true});
    this.poseCanvas=makeCanvas();this.poseCtx=this.poseCanvas.getContext('2d');
    this.crop=makeCanvas();this.cropCtx=this.crop.getContext('2d',{willReadFrequently:true});
    if(!this.sampleCtx || !this.enhancedCtx || !this.poseCtx || !this.cropCtx) throw Error('Cannot prepare camera image processing');
    this.ankhHold=new PoseHold();this.fireHold=new PoseHold();
    this.reset();
  }
  reset() {
    this.lastFrame=-Infinity;this.lastPose=-Infinity;this.lastPoseValid=-Infinity;
    this.lastPoseRetry=-Infinity;this.poseMirrored=false;
    this.lastFullHandScan=-Infinity;this.lastCrop=-Infinity;
    this.lastAnkhForm=-Infinity;this.ambiguousUntil=-Infinity;this.ambiguousReason='reacquiring';
    this.points=null;this.subject=null;this.poseState=this.pose?'not detected':'unavailable';
    this.poseAssessment=null;this.poseHeld=false;this.fireHand=null;this.people=0;
    this.poseMs=0;this.frameMs=0;this.cropTurn=0;
    this.ankhHold.reset();this.fireHold.reset();
  }
  close() {
    try {this.pose?.close?.();} finally {
      this.rescue?.close?.();this.pose=null;this.rescue=null;this.reset();
    }
  }
  sample(video) {
    canvasSize(this.sampleCanvas,80,54);
    this.sampleCtx.drawImage(video,0,0,80,54);
    return exposureStats(this.sampleCtx.getImageData(0,0,80,54).data);
  }
  estimatePose(source,width,height,now) {
    if(!this.pose || now-this.lastPose<POSE_INTERVAL_MS) return;
    this.lastPose=now;
    const started=this.clock();
    const detect=mirrored=>{
      renderFit(this.poseCanvas,this.poseCtx,source,width,height,640,mirrored);
      const landmarks=this.pose.detect(this.poseCanvas)?.landmarks || [];
      return mirrored?landmarks.map(unmirrorPose):landmarks;
    };
    // The pose tracker is sampled independently. Hold and subject continuity
    // are checked below, so a previous pose cannot bias a new body estimate.
    let poses;
    try {
      poses=detect(this.poseMirrored);
      if(poses.length===1 && now-this.lastPoseRetry>=POSE_RETRY_INTERVAL_MS) {
        const observed=evaluateAnkh(poses[0],width,height);
        if(!observed.match && observed.retry) {
          this.lastPoseRetry=now;
          const alternative=detect(!this.poseMirrored);
          if(alternative.length>1) poses=alternative;
          else if(alternative.length===1 && evaluateAnkh(alternative[0],width,height).match) {
            poses=alternative;this.poseMirrored=!this.poseMirrored;
          }
        }
      }
    }
    catch(error) {
      console.warn('Body tracking stopped:',error.message);
      this.pose.close?.();this.pose=null;
      this.poseState='unavailable';this.points=null;this.people=0;
      this.poseAssessment=null;this.poseHeld=false;this.ankhHold.reset();
      return;
    }
    this.poseMs=this.clock()-started;this.people=poses.length;
    // Never combine wrists or hold credit across two possible performers.
    if(poses.length>1) {this.ambiguousUntil=now+AMBIGUITY_GUARD_MS;this.ambiguousReason='multiple people';}
    const points=poses.length===1?poses[0]:null;
    const key=subjectKey(points,width,height);
    const continuous=sameSubject(this.subject,key) && now-this.lastPoseValid<=OBSERVATION_GAP_MS;
    const switched=!!(this.subject && key && !continuous && now-this.lastPoseValid<=OBSERVATION_GAP_MS);
    if(switched) {this.ambiguousUntil=now+AMBIGUITY_GUARD_MS;this.ambiguousReason='reacquiring';this.lastCrop=-Infinity;}
    this.points=key?points:null;
    this.poseState=poses.length>1?'multiple people':key?'visible':points?'limited':'not detected';
    if(key) {this.lastPoseValid=now;this.subject=key;}
    if(!key && now-this.lastPoseValid>OBSERVATION_GAP_MS) this.subject=null;
    const assessment=evaluateAnkh(this.points,width,height);
    if(assessment.forming) this.lastAnkhForm=now;
    // Lowering extended arms can briefly present an incidental palm or fist.
    // Preserve the body guard for a short interval through that transition.
    this.poseAssessment=assessment;
    this.poseHeld=this.ankhHold.update(assessment.match && now>=this.ambiguousUntil,now,continuous);
  }
  cropHand(video,region,regions,width,height,sceneLight) {
    canvasSize(this.crop,320,320);
    this.cropCtx.drawImage(video,region.x,region.y,region.size,region.size,0,0,320,320);
    const cropLight=exposureStats(this.cropCtx.getImageData(0,0,320,320).data);
    const gamma=sceneLight!=='adequate' && cropLight.p98>=36 && cropLight.p98<205 && cropLight.p98-cropLight.p50>=13 ?
      Math.min(cropLight.gamma,sceneLight==='very dark' ? .57 : .63) : cropLight.gamma;
    lift(this.cropCtx,this.crop,gamma);
    const detected=readHands(this.rescue.recognize(this.crop))
      .map(h=>({...h,points:remapHand(h.points,region,width,height),source:'wrist crop'}))
      .filter(h=>h.quality>=.68 && palmPixels(h,width,height)>=7 &&
        matchWrist(h,regions,width,height)===region.side);
    return detected.sort((a,b)=>qualityKey(b)-qualityKey(a))[0] || null;
  }
  process(video, now, recognizer, {requireOpenPalms=false,trackBody=true}={}) {
    const width=video.videoWidth || video.naturalWidth || video.width;
    const height=video.videoHeight || video.naturalHeight || video.height;
    if(!width || !height || !finite(now)) return null;
    if(now<=this.lastFrame || now-this.lastFrame < Math.max(MIN_FRAME_MS,Math.min(135,this.frameMs*1.25))) return null;
    if(now-this.lastFrame>OBSERVATION_GAP_MS) {
      this.ankhHold.reset();this.fireHold.reset();this.points=null;this.subject=null;this.poseHeld=false;
      this.poseAssessment=null;this.lastAnkhForm=-Infinity;this.lastPose=-Infinity;this.lastCrop=-Infinity;
    }
    this.lastFrame=now;
    const started=this.clock();
    const exposure=this.sample(video);
    let source=video;
    if(exposure.gamma<.985 || Math.max(width,height)>1152) {
      renderFit(this.enhanced,this.enhancedCtx,video,width,height,1152);
      lift(this.enhancedCtx,this.enhanced,exposure.gamma);
      source=this.enhanced;
    }
    if(trackBody)this.estimatePose(source,width,height,now);
    else{
      // Hand-only runs do not need pose inference or wrist-crop retries. Drop
      // old body evidence so switching modes cannot keep an Ankh guard alive.
      this.points=null;this.subject=null;this.poseAssessment=null;this.poseHeld=false;
      this.people=0;this.poseState='disabled';this.lastPose=this.lastPoseValid=-Infinity;
      this.lastAnkhForm=-Infinity;this.ambiguousUntil=-Infinity;this.ankhHold.reset();
    }
    const fresh=trackBody&&now-this.lastPose<=POSE_EXPIRY_MS;
    const blocked=now<this.ambiguousUntil;
    const pose=fresh&&!blocked?this.points:null;
    const assessment=fresh?this.poseAssessment:null;
    const regions=wristRegions(pose,width,height);
    let hands=[], bySide=new Map();
    if(!blocked) {
      // Use the frame budget on known wrist regions while the Ankh is forming
      // or recent crop recovery is working. Outside the Ankh, rescan the full
      // frame periodically so this optimization does not lock onto a crop.
      const recentWristRescue=now-this.lastCrop<=OBSERVATION_GAP_MS;
      const scanInterval=recentWristRescue?TRACKED_SCAN_INTERVAL_MS:FULL_SCAN_INTERVAL_MS;
      const fullScanDue=now-this.lastFullHandScan>=scanInterval;
      const challenging=exposure.light!=='adequate'||regions.some(r=>r.shoulder<.15*Math.min(width,height));
      // A full-frame scan can exhaust the entire inference budget in dim
      // wide shots. Alternate with wrist-first frames even when an earlier
      // crop was not run or did not recover a hand.
      const directed=!!this.rescue && regions.length>0 &&
        (assessment?.forming || (!fullScanDue && (challenging || recentWristRescue)));
      const primary=directed?[]:readHands(recognizer.recognizeForVideo(source,now))
        .filter(h=>palmPixels(h,width,height)>=7);
      if(!directed) this.lastFullHandScan=now;
      if(pose) {
        bySide=associateHands(primary,regions,width,height);
        if(this.rescue) {
          const candidates=regions.filter(r=>{
            const primaryHand=bySide.get(r.side);
            return !primaryHand || palmPixels(primaryHand,width,height)<20 ||
              primaryHand.quality<.73 || (exposure.light!=='adequate' && qualityKey(primaryHand)<1);
          });
          if(candidates.length>1) {
            const turn=this.cropTurn++;
            if(Math.abs(candidates[0].elevation-candidates[1].elevation)>.35) {
              candidates.sort((a,b)=>b.elevation-a.elevation);
              if(turn%4===3)candidates.reverse();
            }else if(turn%2)candidates.reverse();
          }
          for(let i=0;i<candidates.length;i++) {
            if(this.clock()-started>(i?SECOND_CROP_BUDGET_MS:FIRST_CROP_BUDGET_MS)) break;
            const region=candidates[i], current=bySide.get(region.side);
            let found;
            try {found=this.cropHand(video,region,regions,width,height,exposure.light);}
            catch(error) {
              console.warn('Wrist crop tracking stopped:',error.message);
              this.rescue.close?.();this.rescue=null;break;
            }
            if(found && (!current || qualityKey(found)>=qualityKey(current)-.07)) bySide.set(region.side,found);
          }
        }
        hands=[...bySide.entries()].sort(([a],[b])=>a-b).map(([wristSide,hand])=>({...hand,wristSide}));
        this.lastCrop=hands.some(hand=>hand.source==='wrist crop')?now:-Infinity;
      } else if(!trackBody||now-this.lastPoseValid>OBSERVATION_GAP_MS) {
        // Close-up hand rehearsals can operate with no whole body in frame.
        // A newly lost body track cannot immediately select a different hand.
        hands=primary;
      }
    }
    const openPalms=bySide.size===2 && [...bySide.values()].every(hand=>
      hand.quality>=.70 && hand.gestures[0]?.categoryName==='Open_Palm' && hand.gestures[0]?.score>=.72);
    const active=!!(assessment?.match && this.poseHeld && !blocked && (!requireOpenPalms || openPalms));
    const ankh={active,forming:!!(blocked || assessment?.forming || now-this.lastAnkhForm<=AMBIGUITY_GUARD_MS),
      score:active?assessment.score:0,landmarks:pose,openPalms,
      reason:blocked?(this.ambiguousReason==='multiple people'?'Keep one performer in the camera':'Tracking changed; hold still briefly'):requireOpenPalms&&assessment?.match&&!openPalms?
        'Show both open palms':active?(openPalms?'Ankh held; both open palms visible':'Ankh held'):
        assessment?.match?'Hold both arms still':assessment?.reason||'No current body pose'};
    const fireHands=hands.filter(hand=>hand.quality>=.74 && palmPixels(hand,width,height)>=11 &&
      evaluateFireShape(hand.world).match);
    const candidate=fireHands.length===1?fireHands[0]:null;
    const sameFire=!!(candidate && this.fireHand &&
      (candidate.wristSide??candidate.handedness[0]?.categoryName)===(this.fireHand.wristSide??this.fireHand.handedness[0]?.categoryName) &&
      distance(xy(candidate.points[0],width,height),xy(this.fireHand.points[0],width,height))<=.14*Math.min(width,height));
    // Confirm the defined static shape from independent observations. The
    // bridge separately applies the mapping's deliberate hold and output gates.
    const fireActive=this.fireHold.update(!!candidate&&!ankh.forming,now,sameFire,135,2);
    this.fireHand=candidate;
    const wristSide=candidate?.wristSide;
    const fireSide=candidate?.handedness?.[0]?.categoryName;
    const fireKey=wristSide===0||wristSide===1?'fire:wrist:'+wristSide:
      fireSide==='Left'||fireSide==='Right'?'fire:hand:'+fireSide:null;
    const fire={active:fireActive,forming:!!candidate&&!ankh.forming,score:fireActive ? .85 : 0,previewOnly:false,
      trackingKey:fireKey,handIndex:candidate?hands.indexOf(candidate):null,
      wristSide:wristSide===0||wristSide===1?wristSide:null,
      reason:fireActive?'Three-finger Fire shape held':'Extend thumb, index and middle; fold ring and little fingers'};
    this.frameMs=this.clock()-started;
    const smallHands=hands.some(h=>palmPixels(h,width,height)<20) ||
      (!hands.length && regions.some(r=>r.shoulder<.13*Math.min(width,height)));
    const sceneClear=!!this.pose&&fresh&&!blocked&&this.poseState==='not detected'&&
      !hands.length&&exposure.light==='adequate';
    return {result:hands.length?handResult(hands):EMPTY_HANDS,ankh,fire,
      diagnostics:{light:exposure.light,handMode:hands.some(h=>h.source==='wrist crop')?
        'wrist crop':hands.length?'full frame':'none',poseState:blocked?this.ambiguousReason:this.poseState,
        smallHands,personCount:this.people,sceneClear,armsAtRest:armsAtRest(pose,width,height),
        missingWrists:pose?2-bySide.size:0,poseMs:this.poseMs,frameMs:this.frameMs}};
  }
}

export async function createStageVision({vision,PoseLandmarker,GestureRecognizer}) {
  const pose=await PoseLandmarker.createFromOptions(vision,{
    baseOptions:{modelAssetPath:POSE_URL,delegate:'CPU'},runningMode:'IMAGE',numPoses:2,
    minPoseDetectionConfidence:.5,minPosePresenceConfidence:.55,
    outputSegmentationMasks:false,
  });
  let rescue=null;
  try {
    rescue=await GestureRecognizer.createFromOptions(vision,{
      baseOptions:{modelAssetPath:HAND_URL,delegate:'CPU'},runningMode:'IMAGE',numHands:2,
      minHandDetectionConfidence:.53,minHandPresenceConfidence:.60,minTrackingConfidence:.65,
    });
  } catch(error) {
    // Hand-crop retries are optional; ordinary hand and pose inference still run.
    console.warn('Stage wrist-crop model unavailable:',error.message);
  }
  try {return new StageVision({pose,rescue});} catch(error) {
    pose.close();rescue?.close?.();throw error;
  }
}
