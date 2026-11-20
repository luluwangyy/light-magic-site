// Operator-labelled hand-pose prototypes. Similarity below is normalized
// geometric distance, not a probability or a MediaPipe confidence value.
const LABELS=['Closed_Fist','Open_Palm'];
const FINGERS=[[5,6,7,8],[9,10,11,12],[13,14,15,16],[17,18,19,20]];
const DIMENSIONS=16,MIN_SEPARATION=.12,EPS=1e-9;
const sub=(a,b)=>[a.x-b.x,a.y-b.y,a.z-b.z];
const norm=v=>Math.hypot(...v);
const distance=(a,b)=>norm(sub(a,b));
const validFeatures=f=>Array.isArray(f)&&f.length===DIMENSIONS&&f.every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=10);
const featureDistance=(a,b)=>Math.sqrt(a.reduce((s,n,i)=>s+(n-b[i])**2,0)/DIMENSIONS);
function angle(a,b,c){
 const u=sub(a,b),v=sub(c,b),den=norm(u)*norm(v);
 if(den<=EPS)return null;
 return Math.acos(Math.max(-1,Math.min(1,u.reduce((s,n,i)=>s+n*v[i],0)/den)))/Math.PI;
}

export function poseFeatures(points){
 if(!Array.isArray(points)||points.length!==21||!points.every(p=>p&&['x','y','z'].every(k=>typeof p[k]==='number'&&Number.isFinite(p[k]))))return null;
 const wrist=points[0],palm=distance(wrist,points[9]);
 if(palm<=EPS||distance(points[5],points[17])<palm*.1)return null;
 const features=[];
 for(const [m,p,d,t] of FINGERS){
  if([distance(points[m],points[p]),distance(points[p],points[d]),distance(points[d],points[t])].some(n=>n<=palm*.01))return null;
  const pip=angle(points[m],points[p],points[d]),dip=angle(points[p],points[d],points[t]);
  if(pip===null||dip===null)return null;
  features.push(distance(points[m],points[t])/palm,distance(wrist,points[t])/palm,pip,dip);
 }
 return validFeatures(features)?features:null;
}

export function learnPose(calibration,gesture,features){
 if(!LABELS.includes(gesture))throw Error('Learn only Closed_Fist or Open_Palm.');
 if(!validFeatures(features))throw Error('Show one fully tracked hand before learning a pose.');
 const next={};
 for(const label of LABELS)if(validFeatures(calibration?.[label]))next[label]=calibration[label].slice();
 next[gesture]=features.slice();
 if(next.Closed_Fist&&next.Open_Palm&&featureDistance(next.Closed_Fist,next.Open_Palm)<MIN_SEPARATION)throw Error('The two learned poses are too similar. Close the fingers fully for fist, then open them for palm.');
 return next;
}

export function matchPose(calibration,features){
 const none=reason=>({gesture:'None',similarity:0,reason});
 if(!validFeatures(features))return none('No valid tracked hand features');
 if(!LABELS.every(label=>validFeatures(calibration?.[label])))return none('Learn both closed fist and open palm');
 const separation=featureDistance(calibration.Closed_Fist,calibration.Open_Palm);
 if(separation<MIN_SEPARATION)return none('Learned poses are too similar');
 const ranked=LABELS.map(gesture=>({gesture,distance:featureDistance(features,calibration[gesture])})).sort((a,b)=>a.distance-b.distance);
 const similarity=Math.max(0,Math.min(1,1-ranked[0].distance/separation));
 if(Math.abs(ranked[0].distance-ranked[1].distance)<EPS||similarity<.8)return {gesture:'None',similarity,reason:'Between learned poses or outside the learned pose range'};
 return {gesture:ranked[0].gesture,similarity,reason:'Matched operator-learned pose by normalized geometric distance'};
}
