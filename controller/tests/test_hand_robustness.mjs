import assert from 'node:assert/strict';
import {analyzeHand,projectedPalmEvidence} from '../web/hand-input.mjs';
import {HandSelector} from '../web/hand-selection.mjs';
import {poseFeatures,learnPose,matchPose} from '../web/pose-calibration.mjs';

const fingerStarts=[5,9,13,17];
function hand(folded=[]) {
 const points=Array.from({length:21},()=>({x:0,y:0,z:0}));
 points[1]={x:-.028,y:.022,z:0};
 points[2]={x:-.044,y:.039,z:0};
 points[3]={x:-.055,y:.054,z:0};
 points[4]={x:-.063,y:.063,z:0};
 fingerStarts.forEach((i,j)=>{
  const x=[-.033,-.012,.013,.036][j];
  const y=[.072,.082,.080,.065][j];
  const length=[.036,.043,.040,.030][j];
  const bend=folded.includes(i);
  const tipZ=bend?-length*.8:.001;
  points[i]={x,y,z:0};
  points[i+1]={x,y:y+length,z:0};
  points[i+2]={x,y:bend?y+length:y+length*1.69,z:tipZ};
  points[i+3]={x,y:bend?y+length*.12:y+length*2.20,z:tipZ};
 });
 return points;
}
function rotate(points,{yaw=0,roll=0,mirror=false,scale=1}={}) {
 const cy=Math.cos(yaw),sy=Math.sin(yaw),cr=Math.cos(roll),sr=Math.sin(roll);
 return points.map(p=>{
  const x=(mirror?-1:1)*(p.x*cy+p.z*sy),z=p.z*cy-p.x*sy;
  return {...p,x:scale*(x*cr-p.y*sr),y:scale*(x*sr+p.y*cr),z:scale*z};
 });
}
const open=hand(),fist=hand(fingerStarts),peace=hand([13,17]);
const config={cue_sheet:'air-obey',hand_confidence:.75,mappings:[
 {gesture:'Open_Palm',confidence:.80,enabled:true},
 {gesture:'Closed_Fist',confidence:.80,enabled:true},
]};
function frame(hands){
 return {
  landmarks:hands.map(({points,x=.5,y=.4,size=.7})=>points.map(p=>({
   ...p,x:x+p.x*size,y:y+p.y*size,z:p.z*size,
  }))),
  worldLandmarks:hands.map(({points})=>points),
  handednesses:hands.map(({label='Left',handedness=.52})=>[{categoryName:label,score:handedness}]),
  gestures:hands.map(({label,model='None',confidence=.9})=>[{categoryName:model,score:confidence}]),
  wristSides:hands.map(({side=null})=>side),
 };
}

for(const [points,label] of [[open,'Open_Palm'],[fist,'Closed_Fist']]){
 for(const yaw of [0,Math.PI/4,Math.PI/2,Math.PI]) for(const mirror of [false,true]){
  const pose=rotate(points,{yaw,roll:.71,mirror,scale:.54});
  assert.equal(analyzeHand(pose).gesture,label,`3D geometry: ${label}, yaw ${yaw}, mirror ${mirror}`);
  const found=new HandSelector().update(frame([{points:pose,size:.42}]),config,100);
  assert.equal(found.gesture,label,'A small rotated hand should not depend on a left/right classifier');
  assert.equal(found.tracking_uncertain,false);
 }
}
const slowSelector=new HandSelector();
const steadyFist=frame([{points:fist,side:0}]);
const slowTrackIds=[0,400,800].map(time=>slowSelector.update(steadyFist,config,time).track_id);
assert.equal(new Set(slowTrackIds).size,1,'a steady wrist keeps its identity across slower stage frames');
assert.notEqual(slowSelector.update(steadyFist,config,1400).track_id,slowTrackIds[0],'a long gap starts a new track');

// Keep the same stored 16-value calibration representation across views.
const learned=learnPose(learnPose({},'Closed_Fist',poseFeatures(fist)),'Open_Palm',poseFeatures(open));
assert.equal(matchPose(learned,poseFeatures(rotate(fist,{yaw:Math.PI,mirror:true,roll:.73}))).gesture,'Closed_Fist');

const softPalm=structuredClone(open);
softPalm[20].z-=.014;softPalm[20].y-=.009;
assert.equal(analyzeHand(softPalm).gesture,'Open_Palm','A gently bent little finger still counts as an open palm');
const slightlyFolded=structuredClone(fist);
slightlyFolded[20].y=slightlyFolded[17].y+.026;slightlyFolded[20].z=-.039;
assert.equal(analyzeHand(slightlyFolded).gesture,'Closed_Fist','A slightly looser little finger still folds');
const pointing=hand([9,13,17]);
assert.equal(analyzeHand(pointing).gesture,'None','An extended finger cannot be a fist');
const thumbOut=structuredClone(fist);
thumbOut[3]={x:-.071,y:.055,z:.010};thumbOut[4]={x:-.110,y:.078,z:.025};
assert.equal(analyzeHand(thumbOut).gesture,'None','An obviously extended thumb does not fire a fist');
// World depth can kink a clearly visible palm in a back-facing view.
const depthWarp=structuredClone(open);
for(const i of fingerStarts){depthWarp[i+1].z=.040;depthWarp[i+2].z=-.005;}
assert.equal(analyzeHand(depthWarp).gesture,'None');
const flatPalm=frame([{points:open,model:'Open_Palm',confidence:.73}]);
flatPalm.worldLandmarks=[depthWarp];
assert.equal(new HandSelector().update(flatPalm,config,0,4/3).gesture,'Open_Palm');
assert.equal(projectedPalmEvidence(frame([{points:peace}]).landmarks[0]),0,'A partial finger fan is not a palm');
flatPalm.worldLandmarks=[fist];flatPalm.gestures=[[{categoryName:'None',score:.99}]];
const depthConflict=new HandSelector().update(flatPalm,config,0);
assert.equal(depthConflict.gesture,'None','Contradictory depth and finger projection cannot fire');
assert.equal(depthConflict.tracking_conflict,true);

const selector=new HandSelector();
const first=selector.update(frame([{points:open,x:.3,label:'Left',side:0}]),config,0);
const reversed=selector.update(frame([{points:rotate(open,{yaw:Math.PI}),x:.31,label:'Right',side:0}]),config,80);
assert.equal(reversed.gesture,'Open_Palm');
assert.equal(reversed.track_id,first.track_id,'Handedness relabel and wrist rotation retain physical identity');
const lost=selector.update(frame([]),config,150);
assert.equal(lost.track_id,first.track_id);
assert.equal(lost.confidence,0);
assert.equal(lost.neutral_observed,false);
assert.equal(lost.tracking_uncertain,true);
const regained=selector.update(frame([{points:open,x:.31,side:0}]),config,210);
assert.equal(regained.track_id,first.track_id);
const other=selector.update(frame([{points:open,x:.71,side:1}]),config,290);
assert.notEqual(other.track_id,first.track_id,'A different physical hand cannot inherit the old hold');
const ordered=selector.update(frame([{points:open,x:.31,side:0},{points:open,x:.71,side:1}]),config,360);
const reordered=selector.update(frame([{points:open,x:.71,side:1},{points:open,x:.31,side:0}]),config,440);
assert.equal(ordered.track_id,other.track_id);
assert.equal(reordered.track_id,ordered.track_id,'Array order does not change the selected hand');

const conflict=selector.update(frame([{points:open,x:.31,side:0},{points:fist,x:.71,side:1}]),config,510);
assert.equal(conflict.gesture,'None');
assert.equal(conflict.tracking_conflict,true);
assert.equal(conflict.neutral_observed,false);
const neutral=selector.update(frame([{points:peace,x:.71,side:1}]),config,580);
assert.equal(neutral.neutral_observed,true,'A positively observed mixed-finger sign can rearm');
const uncertainHand=structuredClone(fist).map(p=>({...p,visibility:1}));
uncertainHand[8].visibility=.1;
const occluded=selector.update(frame([{points:uncertainHand,x:.71,side:1,model:'Closed_Fist',confidence:.999}]),config,640);
assert.equal(occluded.gesture,'None','A raw fist must not override explicit occlusion');
assert.equal(occluded.neutral_observed,false);
assert.equal(occluded.tracking_uncertain,true);
const crop=selector.update(frame([{points:open,x:.989,model:'Open_Palm',confidence:.999}]),config,720);
assert.equal(crop.gesture,'None','A cropped landmark set must not trigger even with a strong classifier');
assert.equal(crop.tracking_uncertain,true);
const disagree=selector.update(frame([{points:open,model:'Closed_Fist',confidence:.99}]),config,810);
assert.equal(disagree.gesture,'None','Classifier and geometry contradiction cannot fire');
assert.equal(disagree.tracking_conflict,true);
const fakeFist=selector.update(frame([{points:pointing,model:'Closed_Fist',confidence:.99}]),config,900);
assert.equal(fakeFist.gesture,'None','Partial gestures do not inherit the fist');
console.log('PASS: rotation, mirror, left/right continuity, relaxed variants, mixed hands and occlusion.');
