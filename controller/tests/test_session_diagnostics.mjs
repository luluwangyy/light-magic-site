import assert from 'node:assert/strict';
import {buildSessionDiagnostics,exportSessionDiagnostics} from '../web/session-diagnostics.mjs';

const context={client:'owner-secret',cameraRunning:true,microphoneRunning:false,cameraObservation:{gesture:'Open_Palm',confidence:.92,method:'Hand shape',features:[.1,.2]},state:{
 token:'token-secret',owner:'owner-secret',armed:true,verified:true,connected:true,
 config:{input_source:'both',dry_run:false,mode:'cue',camera_id:'camera-secret',microphone_id:'microphone-secret',notes:'private notes',pose_calibration:{secret:'learned-secret'},custom_motions:[{template:'template-secret'}],mappings:[{gesture:'Open_Palm',enabled:true,confidence:.8,hold_s:.6,cue_list:1,cue:'999'}]},
 workflow:{active:true,state:'live',fresh_gesture_required:true,identity:{show_path:'C:\\private\\show-secret.esf'},blockers:[]},
 telemetry:{gesture:'Open_Palm',confidence:.92,hold:.5},speech:{ready:false,stream_id:'audio-stream-secret',last_text:'Let there be light',last_confidence:.9,last_outcome:'Microphone is off'},
 cue_dispatch:{kind:'waiting',source:'camera',identity:'Open_Palm',cue_list:1,cue:'999',output_type:'cue',wait_s:.8},
 stage_preview:{source:'camera',input:'Open Palm',cue_list:1,cue:'999'},
 last_output:{kind:'simulated',cue_list:1,cue:'999',source:'camera'},logs:[{message:'never-export-log-secret'}],feedback:{'/eos/out/get/show/path':['show-secret']}
}};
let report=buildSessionDiagnostics(context);
assert.equal(report.recognition.camera.gesture,'Open Palm');
assert.equal(report.recognition.camera.mapping.label,'List 1 · Cue 999');
assert.equal(report.queue.state,'waiting');assert.match(report.queue.label,/0.8 seconds/);
assert.equal(report.last_write.state,'none','neither a preview nor a simulated output is a console write');
assert.ok(report.gate.blockers.some(item=>item.kind==='fresh_neutral'));
assert.ok(report.gate.blockers.some(item=>item.kind==='speech'));
assert.equal(report.gate.hold,.5);
let exported=JSON.stringify(exportSessionDiagnostics(context,'2026-11-19T15:00:00Z'));
for(const sentinel of ['token-secret','owner-secret','camera-secret','microphone-secret','learned-secret','template-secret','audio-stream-secret','never-export-log-secret','show-secret','private notes'])assert.ok(!exported.includes(sentinel),'export excludes '+sentinel);
assert.ok(!exported.includes('features'));
context.state.last_output={kind:'sent',output_type:'cue',cue_list:1,cue:'999',timestamp:'10:02:03',source:'camera'};
report=buildSessionDiagnostics(context);assert.equal(report.last_write.state,'sent');assert.equal(report.last_write.label,'List 1 · Cue 999');assert.equal(report.last_write.timestamp,'10:02:03');
context.state.workflow.fresh_gesture_required=false;context.state.owner=null;
report=buildSessionDiagnostics(context);assert.ok(report.gate.blockers.some(item=>item.kind==='owner'));assert.ok(report.gate.blockers.some(item=>item.kind==='hold'));
context.state.owner='another-browser';context.state.config.input_source='speech';context.state.speech.waiting_for_silence=true;
report=buildSessionDiagnostics(context);assert.equal(report.recognition.camera.selected,false);assert.ok(report.gate.blockers.some(item=>item.kind==='speech_silence'));
context.state.workflow.rehearsal=true;report=buildSessionDiagnostics(context);assert.equal(report.mode,'rehearsal');assert.ok(report.gate.blockers.some(item=>item.kind==='rehearsal'));
context.state.workflow.blockers=[{kind:'connect',message:'Failed C:\\private\\path-to-show.esf'}];
exported=JSON.stringify(exportSessionDiagnostics(context));assert.ok(!exported.includes('path-to-show'));
context.state.workflow.active=false;context.state.workflow.fresh_gesture_required=true;
report=buildSessionDiagnostics(context);assert.equal(report.mode,'not started');assert.ok(!report.gate.blockers.some(item=>item.kind==='fresh_neutral'));
console.log('Session diagnostics: recognition, readiness, queue, actual writes and private export checks passed.');
