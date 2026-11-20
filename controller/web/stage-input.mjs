// Only a current observation may become cue evidence. In particular, a
// missing hand is not the performer releasing a held gesture.
const BRIEF_GAP_MS=200;
const isHandCue=gesture=>gesture==='Open_Palm'||gesture==='Closed_Fist'||gesture==='Fire_Gesture';
const handKey=hand=>Number.isSafeInteger(hand.track_id)&&hand.track_id>0?'hand:'+hand.track_id:null;
const fireKey=(hand,report)=>report?.fire?.trackingKey||handKey(hand);

export function stageInput(hand,report,{allowInitialEmpty=true,waitingForNeutral=false}={}) {
 const d=report?.diagnostics||{};
 const base={...hand,tracking_gap:null,tracking_key:null,neutral_kind:null};
 const uncertain=method=>({...base,gesture:'None',confidence:0,tracking_uncertain:true,tracking_gap:'hard',method});
 if(d.poseState==='multiple people'||d.personCount>1)return uncertain('Multiple people in frame');
 if(d.poseState==='reacquiring')return uncertain('Reacquiring performer');
 if(report?.ankh?.active)return {...base,gesture:'Ankh_Pose',confidence:report.ankh.score,
  method:'Shoulder, elbow, and wrist geometry',scoreLabel:'pose score',features:null,tracking_uncertain:false,tracking_key:'body'};
 if(report?.ankh?.forming)return {...uncertain('Ankh forming'),features:null};
 if(report?.fire?.active)return {...base,gesture:'Fire_Gesture',confidence:report.fire.score,
  method:'Thumb, index and middle extended; ring and little folded',scoreLabel:'shape score',
  features:null,tracking_uncertain:false,tracking_key:fireKey(hand,report)};
 if(report?.fire?.forming)return {...uncertain('Checking fire hand shape'),features:null};
 if(d.light==='very dark'&&!hand.handCount)return uncertain('Too dark to track');
 // A clear arms-down body pose can start a live run. Later repetitions
 // still require release evidence from the gesture tracker.
 if(waitingForNeutral&&hand.gesture==='None'&&!hand.tracking_conflict&&d.light!=='very dark'&&
  d.armsAtRest===true&&d.poseState==='visible')
  return {...base,gesture:'None',confidence:0,tracking_uncertain:false,neutral_kind:'arms-down',method:'Arms at rest'};
 if(!hand.handCount&&!hand.tracking_conflict&&allowInitialEmpty&&d.sceneClear===true)return {...base,gesture:'None',confidence:0,
  tracking_uncertain:false,neutral_kind:'empty'};
 if(hand.tracking_uncertain||hand.tracking_conflict)return uncertain(hand.method||'Hand shape is uncertain');
 if(isHandCue(hand.gesture)){
  if(!Number.isFinite(hand.confidence)||hand.confidence<.75)return uncertain('Hand shape is uncertain');
  return {...base,tracking_uncertain:false,tracking_key:handKey(hand)};
 }
 if(hand.handCount>0&&hand.neutral_observed===true)return {...base,gesture:'None',confidence:0,
  tracking_uncertain:false,neutral_kind:'observed',tracking_key:handKey(hand)};
 return uncertain(hand.handCount?'No clear hand shape':'Hand not visible');
}

export class StageInputTracker {
 constructor(){this.reset();}
 reset(){this.performerSeen=false;this.previous=null;this.lastHandKey=null;this.lastHandSide=null;}
 update(hand,report,now,{waitingForNeutral=false}={}){
  const d=report?.diagnostics||{};
  if(hand.handCount>0||d.personCount>0||d.poseState==='visible'||d.poseState==='limited'||report?.ankh?.landmarks)
   this.performerSeen=true;
  const next=stageInput(hand,report,{allowInitialEmpty:!this.performerSeen,waitingForNeutral});
  const wristSide=next.gesture==='Fire_Gesture'?report?.fire?.wristSide:report?.result?.wristSides?.[hand.index];
  const sameWrist=(wristSide===0||wristSide===1)&&wristSide===this.lastHandSide;
  // The other hand being visible and relaxed does not prove release when
  // the hand that supplied the cue is currently hidden.
  if(next.neutral_kind==='observed'&&this.lastHandKey&&next.tracking_key!==this.lastHandKey&&!sameWrist&&d.missingWrists>0){
   this.previous=null;
   return {...next,tracking_uncertain:true,tracking_gap:'hard',tracking_key:null,neutral_kind:null,method:'Show the hidden hand to reset the gesture'};
  }
  if(!next.tracking_uncertain){
   this.previous=isHandCue(next.gesture)&&next.tracking_key&&Number.isFinite(now)?{key:next.tracking_key,time:now}:null;
   if(this.previous){
    this.lastHandKey=this.previous.key;
    this.lastHandSide=wristSide===0||wristSide===1?wristSide:null;
   }
   return next;
  }
  const currentKey=report?.fire?.forming?fireKey(hand,report):handKey(hand);
  const ordinaryMiss=(!hand.handCount||this.previous?.key===currentKey)&&!hand.tracking_conflict&&d.light!=='very dark'&&
   !['multiple people','reacquiring','limited','unavailable'].includes(d.poseState)&&!(d.personCount>1)&&
   !report?.ankh?.forming&&!report?.fire?.forming;
  if(ordinaryMiss&&this.previous&&Number.isFinite(now)&&now>=this.previous.time&&now-this.previous.time<=BRIEF_GAP_MS)
   return {...next,tracking_gap:'brief',tracking_key:this.previous.key};
  this.previous=null;
  return next;
 }
}
