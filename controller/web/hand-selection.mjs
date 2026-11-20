import {analyzeHand,hasOcclusion,projectedPalmEvidence} from './hand-input.mjs';
import {poseFeatures,matchPose} from './pose-calibration.mjs';

const POSES=new Set(['Open_Palm','Closed_Fist']);
const OTHER_SIGNS=new Set(['Thumb_Up','Thumb_Down','Pointing_Up','Victory','ILoveYou']);
const TRACK_GRACE_MS=260;
// Current wrist observations can preserve identity on a slower camera.
// Missing observations still use the shorter tracking-loss grace.
const STAGE_ASSOCIATION_MS=450;
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const pointInFrame=p=>p&&finite(p.x)&&finite(p.y)&&p.x>=.004&&p.x<=.996&&p.y>=.004&&p.y<=.996;
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const score=n=>finite(n)?Math.max(0,Math.min(1,n)):0;
const category=(list,index)=>({
 name:list?.[index]?.[0]?.categoryName||'None',
 score:score(list?.[index]?.[0]?.score),
});

function wristLocation(points,side) {
 if(!Array.isArray(points)||![0,5,9,17].every(i=>pointInFrame(points[i])))return null;
 const span=Math.max(distance(points[0],points[9]),distance(points[5],points[17]));
 if(span<.0035)return null;
 return {wrist:points[0],span,side:side===0||side===1?side:null};
}

function evaluate(points,world,raw,handed,config,calibration,track,index,aspect) {
 const shape=analyzeHand(world);
 const usable=!!track&&points.length===21&&points.every(pointInFrame)&&!hasOcclusion(points)&&shape.usable;
 const features=usable?poseFeatures(world):null;
 const learned=matchPose(calibration,features);
 const thresholdFor=name=>config.mappings?.find(m=>m.gesture===name)?.confidence??.8;
 const stage=config.cue_sheet==='air-obey';
 const result={gesture:'None',confidence:0,method:usable?shape.reason:'Show the whole hand',
  scoreLabel:'pose evidence',side:handed.name,quality:usable?.94:0,raw,shape,learned,features,index,
  track_id:track?.id??null,neutral_observed:false,tracking_uncertain:true,tracking_conflict:false};
 if(!usable)return result;
 const possible=name=>name==='Open_Palm'?shape.openPossible:name==='Closed_Fist'&&shape.fistPossible;
 const accept=(gesture,confidence,method,scoreLabel)=>Object.assign(result,{
  gesture,confidence,method,scoreLabel,tracking_uncertain:confidence<thresholdFor(gesture),
 });
 // Original lab mappings for the other canned signs remain available.
 if(!stage&&['Thumb_Up','Victory'].includes(raw.name)&&raw.score>=thresholdFor(raw.name)){
  return accept(raw.name,raw.score,'MediaPipe gesture','gesture confidence');
 }
 const projected=shape.gesture==='Open_Palm'?0:projectedPalmEvidence(points,aspect);
 if(projected&&(shape.fistPossible||shape.curledCount>0)){
  result.method='Visible fingers and estimated depth disagree';result.tracking_conflict=true;return result;
 }
 // Do not issue a cue when good geometry and a confident classifier disagree.
 if(shape.gesture!=='None'&&raw.name!==shape.gesture&&
    ((POSES.has(raw.name)&&raw.score>=.82)||(OTHER_SIGNS.has(raw.name)&&raw.score>=.87))){
  result.method='Hand shape and classifier disagree';result.tracking_conflict=true;return result;
 }
 if(shape.gesture!=='None'){
  const sameModel=raw.name===shape.gesture?raw.score:0;
  const sameLearned=learned.gesture===shape.gesture?learned.similarity:0;
  const evidence=Math.max(shape.score,sameModel,sameLearned);
  return accept(shape.gesture,evidence,sameModel>shape.score||sameLearned>shape.score?
   'Finger geometry with corroboration':'Finger geometry','pose evidence (not handedness)');
 }
 if(projected&&
    !(raw.name==='Closed_Fist'&&raw.score>=.78)&&!(OTHER_SIGNS.has(raw.name)&&raw.score>=.82)){
  return accept('Open_Palm',projected,'Four visible extended fingers','pose evidence');
 }
 // A partly foreshortened shape may need the classifier or a learned example,
 // but neither may override incompatible, incomplete or out-of-frame geometry.
 if(POSES.has(raw.name)&&possible(raw.name)&&raw.score>=Math.max(.88,thresholdFor(raw.name))){
  return accept(raw.name,raw.score,'Gesture with compatible finger geometry','gesture confidence');
 }
 if(possible(learned.gesture)&&learned.similarity>=Math.max(.86,thresholdFor(learned.gesture))&&
    !(OTHER_SIGNS.has(raw.name)&&raw.score>=.82)&&
    !(POSES.has(raw.name)&&raw.name!==learned.gesture&&raw.score>=.80)){
  return accept(learned.gesture,learned.similarity,'Your learned hand pose','pose similarity (not model confidence)');
 }
 if(shape.neutral){
  result.neutral_observed=true;result.tracking_uncertain=false;result.method='Non-trigger hand shape';
 }
 return result;
}

export class HandSelector {
 constructor(){this.calibration=null;this.nextTrack=1;this.reset();}
 reset(){this.tracks=[];this.selectedTrack=null;this.lastPose=null;}
 setCalibration(calibration){this.calibration=calibration;this.reset();}
 associate(landmarks,wristSides,now,associationMs){
  const previous=this.tracks.filter(t=>now>=t.time&&now-t.time<=associationMs);
  const locations=landmarks.map((points,i)=>wristLocation(points,wristSides?.[i]));
  const ranked=locations.map(location=>location?previous.flatMap(track=>{
   if(location.side!==null&&track.side!==null&&location.side!==track.side)return [];
   const gap=distance(location.wrist,track.wrist);
   const sameSide=location.side!==null&&location.side===track.side;
   const limit=Math.min(.17,Math.max(.04,1.5*Math.max(location.span,track.span)));
   return gap<=limit?[{track,cost:gap+(sameSide?0:.02)}]:[];
  }).sort((a,b)=>a.cost-b.cost):[]);
  // Do not guess between two nearly coincident old wrists. Also refuse to
  // assign one old hand to both new detections when hands cross.
  const best=ranked.map(options=>options[0]&&
   (!options[1]||options[1].cost-options[0].cost>.014)?options[0]:null);
  const tracks=locations.map((location,i)=>{
   if(!location)return null;
   const link=best[i];
   const shared=link&&best.some((other,j)=>j!==i&&other?.track.id===link.track.id);
   return {...location,id:link&&!shared?link.track.id:this.nextTrack++,time:now};
  });
  const present=new Set(tracks.filter(Boolean).map(t=>t.id));
  const current=tracks.filter(Boolean);
  this.tracks=[...current,...previous.filter(t=>!present.has(t.id)).slice(0,Math.max(0,2-current.length))];
  return tracks;
 }
 update(result,config,now,aspect){
  const landmarks=result?.landmarks||[];
  const associationMs=config.cue_sheet==='air-obey'&&landmarks.length?STAGE_ASSOCIATION_MS:TRACK_GRACE_MS;
  const tracks=this.associate(landmarks,result?.wristSides,now,associationMs);
  const choices=landmarks.map((points,i)=>evaluate(points,result.worldLandmarks?.[i],
   category(result.gestures,i),category(result.handedness||result.handednesses,i),config,
   this.calibration,tracks[i],i,aspect));
  const debug=choices.map(x=>`${x.side}: model ${x.raw.name} ${Math.round(x.raw.score*100)}%; ${x.shape.extendedCount} extended, ${x.shape.curledCount} folded · ${x.method}`).join('\n');
  const candidates=choices.filter(x=>x.gesture!=='None'&&!x.tracking_uncertain);
  const opposed=new Set(candidates.filter(x=>POSES.has(x.gesture)).map(x=>x.gesture)).size>1;
  const conflict=opposed||choices.some(x=>x.tracking_conflict);
  if(!conflict&&candidates.length){
   const chosen=candidates.find(x=>x.track_id===this.selectedTrack)||candidates.sort((a,b)=>b.confidence-a.confidence)[0];
   this.selectedTrack=chosen.track_id;
   this.lastPose={id:chosen.track_id,time:now};
   return {...chosen,debug,handCount:landmarks.length};
  }
  const chosen=choices.find(x=>x.track_id===this.selectedTrack)||choices[0];
  const recent=this.lastPose&&now>=this.lastPose.time&&now-this.lastPose.time<=TRACK_GRACE_MS;
  const lost=recent&&!choices.some(x=>x.track_id===this.lastPose.id&&x.quality>0);
  const neutral=!conflict&&!lost&&choices.length>0&&choices.every(x=>x.neutral_observed);
  // Retain the track identity through a tiny interruption, but never return a
  // stale positive gesture. Missing and partial observations cannot fire.
  return {...chosen,gesture:'None',confidence:0,
   method:opposed?'Hands show conflicting poses':conflict?'Conflicting hand evidence':lost?'Reacquiring the tracked hand':
    chosen?.method||'No hand landmarks detected',
   track_id:chosen?.track_id??(recent?this.lastPose.id:null),
   neutral_observed:neutral,tracking_uncertain:!neutral,tracking_conflict:conflict,debug,handCount:landmarks.length};
 }
}
