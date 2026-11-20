import assert from 'node:assert/strict';
import {
  StageVision, PoseHold, armsAtRest, evaluateAnkh, evaluateFireShape, exposureStats, matchWrist, remapHand, wristRegions,
} from '../web/stage-vision.mjs';

const W=1280,H=720;
function upperBody({scale=1,mid=640,mirrored=false,wristRise=0,level=1,missing=null,crossed=false}={}) {
  const points=Array.from({length:33},()=>({x:.5,y:.5,z:0,visibility:0}));
  const sides=[
    [[-57,0],[-130,9],[-212,16-wristRise]],
    [[57,0],[130,-11],[213,-16-wristRise]],
  ];
  sides.forEach((joints,side)=>joints.forEach(([x,y],i)=>{
    const index=11+side+i*2, position=crossed&&i===2?-x:x;
    points[index]={x:(mid+position*scale*(mirrored?-1:1))/W,y:(340+y*scale)/H,z:0,
      visibility:index===missing ? .2 : level,presence:index===missing ? .2 : level};
  }));
  return points;
}
const rgba = pixels => Uint8ClampedArray.from(pixels.flatMap(g=>[g,g,g,255]));
const darkness=exposureStats(rgba(Array(100).fill(0)));
assert.equal(darkness.light,'very dark');
assert.equal(darkness.gamma,1,'never invent detail in a black frame');
const stageLight=exposureStats(rgba([...Array(75).fill(6),...Array(15).fill(46),...Array(10).fill(93)]));
assert.equal(stageLight.light,'dim');
assert.ok(stageLight.gamma>=.57 && stageLight.gamma<1);
assert.equal(exposureStats(rgba(Array(100).fill(135))).gamma,1);

const body=upperBody();
assert.ok(evaluateAnkh(body,W,H).match,'slightly tilted arms at shoulder level');
const resting=body.map((point,index)=>{
  if(index<13||index>16) return point;
  const shoulder=body[11+(index-13)%2];
  return {...point,x:shoulder.x,y:shoulder.y+(index<15?72:143)/H};
});
assert.ok(armsAtRest(resting,W,H),'both elbows and wrists are down and visible');
assert.ok(!armsAtRest(body,W,H),'extended arms are not at rest');
assert.ok(!armsAtRest(resting.map((point,index)=>index===16?{...point,visibility:.2}:point),W,H),
 'an occluded wrist does not establish a resting pose');
assert.ok(evaluateAnkh(upperBody({mirrored:true,scale:.65}),W,H).match,'invariant to mirroring and distance');
const narrowShoulders=upperBody();
[[.527,.501],[.473,.479],[.587,.532],[.417,.501],[.644,.540],[.363,.501]].forEach(([x,y],i)=>{
 narrowShoulders[11+i]={x,y,z:0,visibility:.9};
});
assert.ok(evaluateAnkh(narrowShoulders,W,H).match,'nearly level arms can look steeper against a narrow tilted shoulder line');
const downward=narrowShoulders.map((p,i)=>({...p,y:p.y+([13,14].includes(i)?.065:[15,16].includes(i)?.13:0)}));
assert.ok(!evaluateAnkh(downward,W,H).match,'lowered arms still do not form Ankh');
assert.ok(!evaluateAnkh(upperBody({scale:.18}),W,H).match,'body too small');
assert.ok(!evaluateAnkh(upperBody({crossed:true}),W,H).match,'crossed wrists are not outstretched arms');
assert.ok(!evaluateAnkh(upperBody({wristRise:115}),W,H).match,'bent or raised forearms do not match');
assert.ok(!evaluateAnkh(upperBody({level:.55}),W,H).match,'weak landmarks are not evidence');
const hidden=evaluateAnkh(upperBody({missing:15}),W,H);
assert.equal(hidden.match,false);
assert.equal(hidden.forming,true,'forming pose can still suppress a competing hand cue');
const regions=wristRegions(body,W,H);
assert.equal(regions.length,2);
assert.ok(regions.every(r=>r.x>=0 && r.y>=0 && r.x+r.size<=W && r.y+r.size<=H));
assert.equal(wristRegions(upperBody({missing:15}),W,H).length,1,'only the trustworthy wrist can seed a crop');
const foreshortened=wristRegions(upperBody({missing:13}),W,H);
assert.equal(foreshortened.length,2,'a reliable wrist still seeds a crop when the elbow is hidden');
assert.ok(foreshortened[0].gate<regions[0].gate,'the wrist-only crop requires a tighter hand association');
const [r]=regions;
const p={x:.38,y:.52,z:-.22};
const q=remapHand([p],r,W,H)[0];
assert.equal(q.x,(r.x+r.size*p.x)/W);
assert.equal(q.y,(r.y+r.size*p.y)/H);
assert.equal(q.z,p.z*r.size/W);
const at=(x,y)=>({points:[{x:x/W,y:y/H}]});
assert.equal(matchWrist(at(...r.wrist),regions,W,H),0);
assert.equal(matchWrist(at(0,0),regions,W,H),null);
assert.equal(matchWrist(at(...r.wrist),[r,{...r,side:1}],W,H),null,'reject ambiguous wrist associations');

const poseHold=new PoseHold();
assert.equal(poseHold.update(true,0),false);
assert.equal(poseHold.update(true,110),false);
assert.equal(poseHold.update(true,220),true);
assert.equal(poseHold.update(true,221,false),false,'a track change discards prior hold credit');
assert.equal(poseHold.update(true,600),false,'a gap cannot complete a hold');
assert.equal(poseHold.update(true,600),false,'duplicate timestamp cannot add credit');
assert.equal(poseHold.update(false,820),false);
const slowHold=new PoseHold();
assert.equal(slowHold.update(true,0),false);
assert.equal(slowHold.update(true,400),false);
assert.equal(slowHold.update(true,800),true,'three current observations at 400 ms cadence complete the pose hold');
assert.equal(slowHold.update(true,1251),false,'a gap beyond the 450 ms stage window starts fresh');

const firePoints=[
  [0,0,0],[-.18,.25,0],[-.38,.44,0],[-.67,.55,0],[-1.06,.66,0],
  [-.34,.96,0],[-.44,1.33,0],[-.52,1.61,0],[-.59,1.86,0],
  [.02,1,0],[.05,1.46,0],[.08,1.77,0],[.11,2.01,0],
  [.28,.92,0],[.31,1.24,0],[.31,1.17,.20],[.29,1.00,.18],
  [.5,.78,0],[.56,1.06,0],[.55,.99,.20],[.51,.84,.18],
].map(([x,y,z])=>({x,y,z}));
assert.ok(evaluateFireShape(firePoints).match);
const foreshortenedThumb=[[-35,74,46],[-51,42,25],[-55,13,16],[-63,-19,2],[-71,-46,2],
 [-25,-23,4],[-19,-52,-7],[-17,-72,-16],[-15,-90,-41],[-2,-8,3],[24,-39,-13],[30,-61,-26],[44,-82,-40],
 [17,13,-3],[14,10,-27],[-7,22,-32],[-20,36,-25],[24,38,-4],[22,30,-23],[7,34,-27],[-10,42,-20]]
 .map(([x,y,z])=>({x:x/1000,y:y/1000,z:z/1000}));
assert.ok(evaluateFireShape(foreshortenedThumb).match,'the thumb can appear closer to the index base at a different camera angle');
const thumbFolded=firePoints.map((p,i)=>i===4?{x:-.25,y:.72,z:0}:p);
assert.ok(!evaluateFireShape(thumbFolded).match,'a peace sign with tucked thumb is different');
const threeStraight=firePoints.map((p,i)=>i===15?{x:.34,y:1.52,z:0}:i===16?{x:.37,y:1.74,z:0}:p);
assert.ok(!evaluateFireShape(threeStraight).match,'an extended ring finger is different');
assert.ok(!evaluateFireShape(firePoints.map(()=>({x:0,y:0,z:0}))).match);

const canvas=()=>{
  const elem={width:0,height:0,args:[]};
  elem.getContext=()=>({drawImage:(...args)=>{elem.args=args;},
    getImageData:()=>({data:rgba([135])}),putImageData:()=>{},
    save(){},translate(){},scale(){elem.mirrored=true;},restore(){elem.mirrored=false;}});
  return elem;
};
const input={videoWidth:W,videoHeight:H};
let poses=[body],primaryCalls=0;
const empty={recognizeForVideo(){primaryCalls++;return {landmarks:[]};}};
const detector={detect(){return {landmarks:poses};}};
const reflected=body.map(p=>({...p,x:1-p.x}));
for(const [a,b] of [[11,12],[13,14],[15,16]])[reflected[a],reflected[b]]=[reflected[b],reflected[a]];
let poseCalls=0;
const retryDetector={detect(){poseCalls++;return {landmarks:[poseCalls===1?upperBody({missing:16}):reflected]};}};
const retryVision=new StageVision({pose:retryDetector,rescue:null,makeCanvas:canvas,clock:()=>0});
assert.equal(retryVision.process(input,0,empty).ankh.active,false);
assert.equal(poseCalls,2,'retry once in the opposite orientation when a clear extended arm is present');
assert.equal(retryVision.process(input,130,empty).ankh.active,false,'retry does not shorten the hold');
assert.ok(retryVision.process(input,260,empty).ankh.active);
assert.equal(poseCalls,4,'the next observations reuse the reliable orientation');
const vision=new StageVision({pose:detector,rescue:null,makeCanvas:canvas,clock:()=>0});
assert.equal(vision.process(input,0,empty).ankh.active,false);
assert.equal(vision.process(input,35,empty),null,'throttle overlapping video work');
assert.equal(vision.process(input,130,empty).ankh.active,false);
let report=vision.process(input,260,empty);
assert.ok(report.ankh.active && !report.ankh.openPalms,'arms still work with no finger tracking');
assert.equal(report.result.landmarks.length,0);
assert.equal(vision.process(input,330,empty,{requireOpenPalms:true}).ankh.active,false);
poses=[];
report=vision.process(input,410,empty);
assert.ok(!report.ankh.active && report.ankh.forming,'pose loss cancels Ankh but suppresses transient hand cues');
poses=[body,upperBody({mid:880,scale:.55})];
const calls=primaryCalls;
report=vision.process(input,540,empty);
assert.equal(report.diagnostics.poseState,'multiple people');
assert.equal(report.diagnostics.personCount,2);
assert.equal(primaryCalls,calls,'no hand output during ambiguity');
assert.equal(report.ankh.active,false);
poses=[body];
report=vision.process(input,670,empty);
assert.equal(report.ankh.active,false,'brief return to one body cannot reuse credit');
vision.reset();
report=vision.process(input,800,empty);
assert.equal(report.ankh.active,false,'camera restart resets all pose holds');

const slowVision=new StageVision({pose:detector,rescue:null,makeCanvas:canvas,clock:()=>0});
poses=[body];
assert.equal(slowVision.process(input,0,empty).ankh.active,false);
assert.equal(slowVision.process(input,400,empty).ankh.active,false);
assert.equal(slowVision.process(input,800,empty).ankh.active,true,'current same-person body observations share the bridge 450 ms hold window');
poses=[upperBody({mid:880})];
report=slowVision.process(input,1200,empty);
assert.equal(report.diagnostics.poseState,'reacquiring','the longer observation window still rejects a changed performer');
assert.equal(report.ankh.active,false);
poses=[body];

const continuity=new StageVision({pose:detector,rescue:null,makeCanvas:canvas,clock:()=>0});
poses=[body];continuity.process(input,0,empty);
poses=[];continuity.process(input,130,empty);
poses=[upperBody({mid:880})];
report=continuity.process(input,260,empty);
assert.equal(report.diagnostics.poseState,'reacquiring','do not adopt a displaced person after a single missing pose');
assert.equal(report.result.landmarks.length,0);
assert.equal(report.ankh.active,false);
poses=[body];

let cropCalls=0;
const recoverer={recognize(target){
  cropCalls++;
  const [,x,y,size]=target.args;
  const region=regions.find(r=>r.x===x && r.y===y);
  assert.ok(region,'only a crop associated with a current pose wrist is processed');
  const [wx,wy]=region.wrist;
  const points=Array.from({length:21},(_,i)=>({x:(wx-x+Math.min(i,9)*1.8)/size,y:(wy-y)/size,z:.1}));
  return {landmarks:[points],worldLandmarks:[firePoints],
    handedness:[[{categoryName:region.side?'Right':'Left',score:.92}]],
    gestures:[[{categoryName:'Open_Palm',score:.90}]]};
}};
const assisted=new StageVision({pose:detector,rescue:recoverer,makeCanvas:canvas,clock:()=>0});
report=assisted.process(input,0,empty);
assert.equal(cropCalls,2,'both small hands can be recovered in one frame');
assert.equal(report.diagnostics.handMode,'wrist crop');
assert.equal(report.result.landmarks.length,2);
assert.deepEqual(report.result.landmarks.map(p=>p[0].x),regions.map(r=>r.wrist[0]/W));
assert.deepEqual(report.result.wristSides,[0,1],'associated hands carry pose side independently of handedness classification');
assert.equal(report.result.worldLandmarks[0],firePoints,'world geometry and model scores remain in model coordinates');
assert.equal(report.result.gestures[0][0].score,.90);
assert.equal(report.ankh.openPalms,true);
assert.equal(report.fire.previewOnly,false);

const fireScreen=Array.from({length:21},(_,i)=>({x:.5+i*.002,y:.5,z:0}));
const firePrimary={recognizeForVideo:()=>({landmarks:[fireScreen],worldLandmarks:[firePoints],
  handedness:[[{categoryName:'Right',score:.92}]],gestures:[[{categoryName:'Victory',score:.94}]]})};
const fireVision=new StageVision({pose:null,rescue:null,makeCanvas:canvas,clock:()=>0});
assert.equal(fireVision.process(input,0,firePrimary).fire.active,false);
assert.equal(fireVision.process(input,75,firePrimary).fire.active,false);
assert.deepEqual(fireVision.process(input,150,firePrimary).fire,
  {active:true,forming:true,score:.85,previewOnly:false,trackingKey:'fire:hand:Right',handIndex:0,wristSide:null,
    reason:'Three-finger Fire shape held'});
assert.equal(fireVision.process(input,225,empty).fire.active,false);
const slowerPreview=new StageVision({pose:null,rescue:null,makeCanvas:canvas,clock:()=>0});
assert.equal(slowerPreview.process(input,0,firePrimary).fire.active,false);
assert.ok(slowerPreview.process(input,165,firePrimary).fire.active,'slower frames can confirm a shape preview from two current observations');
assert.equal(slowerPreview.process(input,650,firePrimary).fire.active,false,'a stale observation cannot support the preview');
const stageCadenceFire=new StageVision({pose:null,rescue:null,makeCanvas:canvas,clock:()=>0});
assert.equal(stageCadenceFire.process(input,0,firePrimary).fire.active,false);
report=stageCadenceFire.process(input,400,firePrimary);
assert.equal(report.fire.active,true,'two fresh shapes may form a rehearsal candidate at the supported stage cadence');
assert.equal(report.fire.previewOnly,false,'the defined static shape is eligible for the bridge hold gate');
assert.equal(stageCadenceFire.process(input,851,firePrimary).fire.active,false,'a stale shape cannot keep the Fire candidate active');

let handOnlyPoseCalls=0,handOnlyCropCalls=0,handOnlyFullCalls=0;
const handOnlyVision=new StageVision({
 pose:{detect(){handOnlyPoseCalls++;return {landmarks:[body]};}},
 rescue:{recognize(){handOnlyCropCalls++;return {landmarks:[]};}},
 makeCanvas:canvas,clock:()=>0,
});
const handOnlyRecognizer={recognizeForVideo(...args){handOnlyFullCalls++;return firePrimary.recognizeForVideo(...args);}};
assert.equal(handOnlyVision.process(input,0,handOnlyRecognizer,{trackBody:false}).fire.active,false);
report=handOnlyVision.process(input,150,handOnlyRecognizer,{trackBody:false});
assert.equal(handOnlyPoseCalls,0,'a hand-only session does not run the body detector');
assert.equal(handOnlyCropCalls,0,'a hand-only session does not run wrist-crop rescues');
assert.equal(handOnlyFullCalls,2,'hand-only sessions still recognize each fresh full-frame hand observation');
assert.equal(report.result.landmarks.length,1);
assert.equal(report.fire.active,true,'the static three-finger Fire shape works without body inference');
assert.equal(report.diagnostics.poseState,'disabled');
assert.equal(report.diagnostics.personCount,0);
assert.equal(report.ankh.active,false);
assert.equal(report.ankh.forming,false,'disabled body tracking cannot suppress a hand cue');
assert.equal(report.diagnostics.sceneClear,false,'absence of body inference cannot establish an empty stage');
poses=[body];
handOnlyVision.process(input,300,empty);
report=handOnlyVision.process(input,450,handOnlyRecognizer,{trackBody:false});
assert.equal(report.ankh.forming,false,'switching to hands clears a prior Ankh forming guard');

const guard=new StageVision({pose:detector,rescue:null,makeCanvas:canvas,clock:()=>0});
poses=[body];
guard.process(input,0,empty);
poses=[upperBody({crossed:true})];
assert.equal(guard.process(input,130,empty).ankh.forming,true,'lowering arms cannot immediately release the body guard');
assert.equal(guard.process(input,390,empty).ankh.forming,false,'a settled pose releases the guard');

const lowered=upperBody();
for(const [e,w] of [[13,15],[14,16]]){
 lowered[e]={...lowered[e],y:lowered[e].y+.09};
 lowered[w]={...lowered[w],y:lowered[w].y+.23};
}
poses=[lowered];
let inferenceTime=0,dimCrops=0,dimFullScans=0;
const dimCanvas=()=> {
 const result=canvas();
 const context=result.getContext();
 result.getContext=()=>({...context,getImageData:()=>({data:rgba([...Array(75).fill(6),...Array(15).fill(46),...Array(10).fill(93)])})});
 return result;
};
const dimPrimary={recognizeForVideo(){dimFullScans++;inferenceTime+=125;return {landmarks:[]};}};
const dimRescue={recognize(){dimCrops++;return {landmarks:[]};}};
const dimVision=new StageVision({pose:detector,rescue:dimRescue,makeCanvas:dimCanvas,clock:()=>inferenceTime});
assert.equal(dimVision.process(input,0,dimPrimary).diagnostics.sceneClear,false);
assert.equal(dimCrops,0,'the initial slow full scan can use up the frame budget');
dimVision.process(input,150,dimPrimary);
assert.ok(dimCrops>=1,'the next frame makes time for wrist crops even without a previously successful rescue');
assert.equal(dimFullScans,1);
dimVision.process(input,450,dimPrimary);
assert.equal(dimFullScans,2,'wrist priority still allows periodic full-frame scans');

const [wrist]=wristRegions(lowered,W,H);
const trackedRescue={recognize(target){
 const [,x,y,size]=target.args;
 if(x!==wrist.x||y!==wrist.y)return {landmarks:[]};
 const [wx,wy]=wrist.wrist;
 const points=Array.from({length:21},(_,i)=>({x:(wx-x+Math.min(i,9)*1.8)/size,y:(wy-y)/size,z:.1}));
 return {landmarks:[points],handedness:[[{categoryName:'Left',score:.92}]]};
}};
const trackedVision=new StageVision({pose:detector,rescue:trackedRescue,makeCanvas:dimCanvas,clock:()=>inferenceTime});
trackedVision.process(input,0,dimPrimary);
for(const now of [170,340,510,680])assert.equal(trackedVision.process(input,now,dimPrimary).diagnostics.handMode,'wrist crop');
assert.equal(dimFullScans,3,'reliable wrist recovery avoids interrupting consecutive observations with an early full scan');
trackedVision.process(input,850,dimPrimary);
assert.equal(dimFullScans,4,'the full scan still runs at a bounded interval');
poses=[];
const clear=new StageVision({pose:detector,rescue:null,makeCanvas:canvas,clock:()=>0});
assert.equal(clear.process(input,0,empty).diagnostics.sceneClear,true);
assert.equal(dimVision.process(input,600,dimPrimary).diagnostics.sceneClear,false,'a dim scene is not reliable empty-stage evidence');

console.log('Stage vision: exposure limits, Ankh priority, balanced wrist rescue, empty-scene evidence, and held three-finger Fire shape pass.');
