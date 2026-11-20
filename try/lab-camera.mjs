import {HandSelector} from '../controller/web/hand-selection.mjs';
import {StageInputTracker} from '../controller/web/stage-input.mjs';
import {createStageVision} from '../controller/web/stage-vision.mjs';

const assets=new URL('../controller/web/assets/',import.meta.url);
const config={
 cue_sheet:'air-obey',hand_confidence:.75,
 mappings:['Open_Palm','Closed_Fist','Fire_Gesture','Ankh_Pose'].map(gesture=>({
  gesture,confidence:.8,enabled:true,
 })),
};

export async function createLabCamera(){
 const {FilesetResolver,GestureRecognizer,PoseLandmarker}=await import('../controller/web/assets/vision_bundle.mjs');
 const vision=await FilesetResolver.forVisionTasks(new URL('wasm/',assets).href);
 const hands=await GestureRecognizer.createFromOptions(vision,{
  baseOptions:{modelAssetPath:new URL('gesture_recognizer.task',assets).href,delegate:'CPU'},
  runningMode:'VIDEO',numHands:2,minHandDetectionConfidence:.55,minHandPresenceConfidence:.60,minTrackingConfidence:.65,
 });
 let stage;
 try{stage=await createStageVision({vision,GestureRecognizer,PoseLandmarker});}
 catch(error){hands.close();throw error;}
 const selector=new HandSelector(),input=new StageInputTracker();
 return {
  recognizeForVideo(video,now){
   const report=stage.process(video,now,hands);
   if(!report)return null;
   const result=report.result;
   const hand=selector.update(result,config,now,video.videoWidth/video.videoHeight);
   const selected=input.update(hand,report,now);
   return {...result,observation:selected,gestures:[[{categoryName:selected.tracking_uncertain?'None':selected.gesture,score:selected.confidence}]]};
  },
  close(){stage.close();hands.close();},
 };
}
