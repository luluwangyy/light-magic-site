// Scale-normalized shape evidence from MediaPipe world landmarks. Distances,
// bends and dot products are invariant to rotation and reflection, so the
// test does not depend on palm facing, handedness, or image mirroring.
const FINGERS = [[5,6,7,8],[9,10,11,12],[13,14,15,16],[17,18,19,20]];
const EPS = 1e-9;
const sub = (a,b) => [a.x-b.x,a.y-b.y,a.z-b.z];
const norm = v => Math.hypot(...v);
const dot = (a,b) => a.reduce((sum,n,i)=>sum+n*b[i],0);
const distance = (a,b) => norm(sub(a,b));
const finite = n => typeof n==='number'&&Number.isFinite(n);
const angle = (a,b,c) => {
  const u=sub(a,b),v=sub(c,b),den=norm(u)*norm(v);
  return Math.acos(Math.max(-1,Math.min(1,dot(u,v)/den)))*180/Math.PI;
};
const none = reason => ({gesture:'None',score:0,usable:false,extendedCount:0,curledCount:0,
  openness:0,openPossible:false,fistPossible:false,neutral:false,reason});

export function hasOcclusion(points) {
  // The hand task can omit visibility or populate it with zeros. Use it only
  // when actual per-point scores are supplied.
  return ['visibility','presence'].some(field=>points.some(p=>finite(p?.[field])&&p[field]>0)&&
    points.some(p=>p?.[field]!==undefined&&(!finite(p[field])||p[field]<.45)));
}

export function analyzeHand(points) {
  if(!Array.isArray(points)||points.length!==21)return none('Expected 21 world landmarks');
  if(!points.every(p=>p&&[p.x,p.y,p.z].every(finite)))return none('Invalid world landmark coordinates');
  if(hasOcclusion(points))return none('Part of the hand is occluded');
  const wrist=points[0],palm=distance(wrist,points[9]);
  if(palm<=EPS||distance(points[5],points[17])<palm*.24||
     distance(points[5],points[17])>palm*1.65)return none('Degenerate palm geometry');
  let extendedCount=0,curledCount=0,openSupport=0,foldSupport=0,relaxedCount=0;
  for(const [m,p,d,t] of FINGERS){
    const a=points[m],b=points[p],c=points[d],e=points[t];
    const segments=[distance(a,b),distance(b,c),distance(c,e)];
    const fingerLength=segments.reduce((sum,n)=>sum+n,0);
    const fingerAxis=sub(a,wrist),axisLength=norm(fingerAxis),pipReach=distance(b,wrist);
    if(segments.some(n=>n<palm*.025||n>palm*.95)||
       Math.max(...segments)>8*Math.min(...segments)||
       fingerLength<palm*.32||fingerLength>palm*2.2||axisLength<palm*.4||pipReach<palm*.4){
      return none('Unreliable finger geometry');
    }
    const proximal=angle(a,b,c),distal=angle(b,c,e);
    const reach=distance(a,e)/fingerLength;
    const forward=dot(sub(e,a),fingerAxis)/(axisLength*fingerLength);
    const outward=distance(e,wrist)/pipReach;
    const straight=proximal>=138&&distal>=122&&reach>=.84&&forward>=.59&&outward>=1.10;
    const nearlyStraight=proximal>=119&&distal>=105&&reach>=.74&&forward>=.46&&outward>=1.035;
    // Require evidence of folding and a compact tip, rather than treating any
    // partly bent finger as closed. This keeps pointing and claw shapes out.
    const curled=(proximal<=128||distal<=112)&&reach<=.61&&forward<=.24&&outward<=1.06;
    const nearlyCurled=(proximal<=147||distal<=132)&&reach<=.70&&forward<=.35&&outward<=1.115;
    if(straight)extendedCount++;
    if(nearlyStraight)openSupport++;
    if(curled)curledCount++;
    if(nearlyCurled)foldSupport++;
    if(!nearlyStraight&&!nearlyCurled&&forward>.28&&reach>.64)relaxedCount++;
  }
  const thumbAxis=sub(points[4],points[2]),thumbLength=norm(thumbAxis);
  const thumbSegments=distance(points[2],points[3])+distance(points[3],points[4]);
  const thumbSpread=thumbSegments>palm*.49&&thumbLength/thumbSegments>=.91&&
    Math.min(...[0,5,6,7,8,9,12,13,16,17,20].map(i=>distance(points[4],points[i])))>=palm*.64;
  const openPossible=openSupport>=3&&curledCount===0;
  const fistPossible=!thumbSpread&&extendedCount===0&&curledCount>=2&&foldSupport===4;
  const gesture=extendedCount>=3&&openSupport===4?'Open_Palm':
    fistPossible&&curledCount>=3?'Closed_Fist':'None';
  const score=gesture==='Open_Palm'?(extendedCount===4?.94:.86):
    gesture==='Closed_Fist'?(curledCount===4?.94:.85):0;
  const neutral=gesture==='None'&&!openPossible&&!fistPossible&&(
    (extendedCount>=1&&extendedCount<=2&&curledCount>=1)||relaxedCount>=3||
    (thumbSpread&&foldSupport===4));
  const reason=gesture==='Open_Palm'?'Four fingers extended':gesture==='Closed_Fist'?
    'Four fingers folded':neutral?'Clear non-trigger hand shape':'Finger shape is incomplete or ambiguous';
  return {gesture,score,usable:true,extendedCount,curledCount,openness:extendedCount/4,
    openPossible,fistPossible,neutral,reason};
}

export function projectedPalmEvidence(points, aspect=4/3) {
  // A visible four-finger fan can rescue a palm when the model's estimated
  // depth is bent or foreshortened. Never infer a fist from flat projection.
  if(!Array.isArray(points)||points.length!==21||
     !points.every(p=>p&&finite(p.x)&&finite(p.y)))return 0;
  const xScale=finite(aspect)&&aspect>=.5&&aspect<=3?aspect:4/3;
  const flat=points.map(p=>({x:p.x*xScale,y:p.y,z:0}));
  const wrist=flat[0],palm=distance(wrist,flat[9]),across=sub(flat[17],flat[5]);
  if(palm<=EPS||norm(across)<palm*.25)return 0;
  const tips=FINGERS.map(f=>flat[f[3]]);
  if(tips.some((tip,i)=>tips.some((other,j)=>i<j&&distance(tip,other)<palm*.075))||
     dot(sub(tips[3],tips[0]),across)<.36*dot(across,across))return 0;
  let clear=0,supported=0;
  for(const [m,p,d,t] of FINGERS){
    const a=flat[m],b=flat[p],c=flat[d],e=flat[t];
    const segments=[distance(a,b),distance(b,c),distance(c,e)];
    const length=segments.reduce((sum,n)=>sum+n,0),axis=sub(a,wrist);
    const toJoint=distance(b,wrist);
    if(segments.some(n=>n<palm*.045)||norm(axis)<palm*.35||toJoint<palm*.5)return 0;
    const reach=distance(a,e)/length;
    const forward=dot(sub(e,a),axis)/(norm(axis)*length);
    const outward=distance(e,wrist)/toJoint;
    const proximal=angle(a,b,c),distal=angle(b,c,e);
    if(reach>=.92&&forward>=.69&&outward>=1.15&&distance(a,e)>=palm*.52&&proximal>=149&&distal>=132)clear++;
    if(reach>=.85&&forward>=.57&&outward>=1.095&&distance(a,e)>=palm*.43&&proximal>=133&&distal>=112)supported++;
  }
  return clear===4?.90:clear>=3&&supported===4?.85:0;
}
