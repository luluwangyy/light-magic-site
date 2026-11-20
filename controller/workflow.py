"""Session readiness, selective validation, and versioned output control."""
import copy
import hashlib
import json
from collections import deque
from mapping_outputs import mapping_target
from show_profile import FIRE, STAGE_NAMES, STAGE_SHEET, STAGE_FRAME_GAP_S, StageGestureGate

STAGE_RECOGNITION_VERSION = 'stage-v3'

def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def behavior(config):
    result=copy.deepcopy(config)
    for key in ('notes','camera_id','microphone_id'): result.pop(key,None)
    for mapping in result['mappings']: mapping.pop('label',None)
    for motion in result['custom_motions']: motion.pop('name',None)
    return result


def recognition(config):
    result={}
    for mapping in config['mappings']:
        result['pose:'+mapping['gesture']]=fingerprint(dict(
            gesture=mapping['gesture'],confidence=mapping['confidence'],hold=mapping['hold_s'],
            tracker=STAGE_RECOGNITION_VERSION if config.get('cue_sheet')==STAGE_SHEET else 'legacy',
            quality=config['hand_confidence'],palm_from_fist=config['palm_from_fist'],
            calibration=config.get('pose_calibration',{}) if mapping['gesture'] in ('Closed_Fist','Open_Palm') else None,
            spacing=[config['close'],config['far']] if mapping['gesture']=='Arms_Open' else None))
    for motion in config['custom_motions']:
        result[motion['id']]=fingerprint({k:motion[k] for k in ('feature_version','templates','threshold','cooldown_s')}|
                                       {'quality':config['hand_confidence']})
    for mapping in config.get('speech_mappings',[]):
        result[mapping['id']]=fingerprint(dict(phrase=mapping['phrase'].strip().casefold(),
                                                backend=config.get('speech_backend','auto'),
                                                sheet=config.get('cue_sheet','legacy'),
                                                leading_command=config.get('cue_sheet')==STAGE_SHEET and mapping['id']=='speech_command',
                                                confidence=config.get('speech_confidence',.7),
                                                microphone=config.get('microphone_id','')))
    return result


class SessionWorkflow:
    def camera_required(self):
        return self.config.get('input_source','camera') in ('camera','both')

    def speech_required(self):
        return self.config.get('input_source','camera') in ('speech','both')

    def workflow_init(self,profile=None):
        self.workflow_active=False
        self.rehearsal=False
        self.config_revision=1; self.output_epoch=1
        self.output_paused=False; self.pause_reason='Start a session to preview the camera'
        self.session_confirmed=False; self.console_identity={}
        self.camera_ready=False; self.camera_frame_seen=False; self.camera_frame_time=-100
        self.camera_frame_times=deque(maxlen=60)
        self.camera_frames_received=0
        self.stage_tracking_ready=False
        self.target_tests={}; self.pending_test=None; self.test_serial=0
        self.practice_evidence={}; self.practice_since={}
        self.speech_practice_skipped=False
        self.practice_gate=StageGestureGate()
        self.stage_preview=None; self.stage_preview_serial=0
        available=recognition(self.config)
        stored=(profile or {}).get('needs_practice',[])
        if not isinstance(stored,list):stored=list(available)
        self.needs_practice={identity for identity in stored if identity in available}
        if (self.config.get('cue_sheet')==STAGE_SHEET and
                (profile or {}).get('stage_recognition_version')!=STAGE_RECOGNITION_VERSION):
            self.needs_practice.update(key for key in available if key.startswith('pose:'))
        self.speech_practice_backend=(profile or {}).get('speech_practice_backend','vosk')
        self.sync_speech_recognition()
        if not profile:
            self.needs_practice.update(m['id'] for m in self.config['custom_motions'])
        if not profile or 'speech_mappings' not in profile.get('config',{}):
            self.needs_practice.update(m['id'] for m in self.config.get('speech_mappings',[]))
        self.fresh_gesture_required=self.camera_required(); self.neutral_since=None

    def save_profile(self):
        config=copy.deepcopy(self.config)
        config['dry_run']=True
        data=dict(config=config,needs_practice=sorted(self.needs_practice),speech_practice_backend=self.speech_practice_backend,
                  stage_recognition_version=STAGE_RECOGNITION_VERSION)
        path=self.folder/'profile.json'; temporary=path.with_suffix('.tmp')
        temporary.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
        temporary.replace(path)

    def sync_speech_recognition(self):
        current=getattr(self.speech_engine,'recognition_id',None) or getattr(self.speech_engine,'backend','vosk')
        if current==self.speech_practice_backend:return False
        self.speech_practice_backend=current
        self.speech_practice_skipped=False
        self.needs_practice.update(mapping['id'] for mapping in self.config['speech_mappings'])
        return True

    def workflow_stopped(self,reason):
        self.output_epoch+=1
        self.cue_lane.cancel('Output paused or the session changed.')
        self.practice_gate=StageGestureGate()
        self.practice_evidence.clear(); self.practice_since.clear()
        self.stage_preview=None
        self.camera_frame_seen=False
        self.camera_frame_times.clear()
        self.camera_frames_received=0
        self.telemetry['camera_diagnostics']=dict(phase='paused',reason=reason,received_fps=0,frames_received=0)
        self.stage_tracking_ready=False
        self.speech_frame_seen=False
        reset_speech=getattr(self,'reset_speech_epoch',None)
        if reset_speech:reset_speech()
        elif getattr(self,'speech_engine',None):self.speech_engine.reset()
        self.fresh_gesture_required=self.camera_required(); self.neutral_since=None
        if self.workflow_active:
            self.output_paused=True; self.pause_reason=reason

    def record_stage_preview(self,source,input_label,mapping):
        """Record a recognized input independently of console dispatch."""
        if not self.workflow_active or (source not in ('camera', 'speech') and (not self.rehearsal or self.armed)):
            return
        target = mapping_target(mapping)
        event = dict(source=source, input=input_label, target=None)
        if target is None:
            event['message'] = 'No output assigned'
        elif not mapping['enabled'] and mapping.get('gesture') != FIRE:
            event['message'] = 'Mapping disabled'
        else:
            event['target'] = {key: value for key, value in target.items() if key not in ('id', 'command')}
        self.stage_preview_serial += 1
        self.stage_preview = dict(event, serial=self.stage_preview_serial)

    def workflow_connected(self):
        self.console_identity={}; self.session_confirmed=False
        self.speech_practice_skipped=False
        self.target_tests.clear(); self.pending_test=None

    def workflow_received(self,address,args):
        names={'/eos/out/get/version':'version','/eos/out/show/name':'show_name','/eos/out/get/show/path':'show_path'}
        key=names.get(address)
        if not key or not args:return
        value=str(args[0]); previous=self.console_identity.get(key)
        if previous and previous!=value and self.workflow_active:
            self.stop('Console identity changed; confirm the session and recheck cues')
            self.speech_practice_skipped=False
            self.session_confirmed=False; self.target_tests.clear(); self.pending_test=None
            self.cue_tested=False; self.tested_motions.clear()
        self.console_identity[key]=value

    def workflow_changed(self,old,new):
        old_rec,new_rec=recognition(old),recognition(new)
        changed={key for key,value in new_rec.items() if old_rec.get(key)!=value}
        self.needs_practice.intersection_update(new_rec)
        self.needs_practice.update(changed)
        operational=behavior(old)!=behavior(new)
        endpoint=any(old[k]!=new[k] for k in ('host','port','framing'))
        if endpoint or any(key.startswith('speech_') for key in changed):
            self.speech_practice_skipped=False
        camera=old.get('camera_id','')!=new.get('camera_id','')
        microphone=old.get('microphone_id','')!=new.get('microphone_id','')
        microphone_relevant=microphone and any(c.get('input_source','camera') in ('speech','both') for c in (old,new))
        if microphone:
            self.speech_ready=False;self.speech_frame_seen=False
            for key in list(self.practice_evidence):
                if key.startswith('speech_'):self.practice_evidence.pop(key,None)
        if camera:
            self.needs_practice.update(key for key in new_rec if not key.startswith('speech_'))
            self.camera_ready=False; self.camera_frame_seen=False
        if operational or camera or microphone_relevant:
            self.config_revision+=1
            self.practice_evidence.clear(); self.practice_since.clear()
            self.motion_last_fire={}
        if endpoint:
            self.session_confirmed=False; self.console_identity={}
            self.target_tests.clear(); self.pending_test=None
        elif old.get('cue_sheet')!=new.get('cue_sheet'):
            self.target_tests.clear();self.pending_test=None
        # A pending physical test belongs to the exact revision that sent it.
        if operational or camera or microphone_relevant:self.pending_test=None
        zoom_keys=('mode','target_type','target','parameter','zoom_min','zoom_max','close','far','reverse','alpha','deadband','rate_hz','hand_confidence','hand_loss_s')
        if endpoint or any(old[k]!=new[k] for k in zoom_keys):
            self.zoom_tested=self.release_tested=False
            self.zoom_confirmed=False
        return operational or camera or microphone_relevant

    def all_targets(self,active_only=True):
        records={}
        mappings=self.config['mappings'] if not active_only or self.camera_required() and self.config['mode']=='cue' else []
        motions=self.config['custom_motions'] if not active_only or self.camera_required() and self.config['mode']=='motion' else []
        speech=self.config.get('speech_mappings',[]) if not active_only or self.speech_required() else []
        for mapping in [*mappings,*motions,*speech]:
            if active_only and not mapping['enabled']:continue
            target=mapping_target(mapping)
            if target is None:continue
            identity=target['id']
            label=mapping.get('name') or mapping.get('label') or mapping.get('phrase') or mapping.get('gesture','Output')
            if identity in records:records[identity]['label']+=' / '+label
            else:records[identity]=dict(target,label=label)
        return list(records.values())

    def practice_items(self):
        names={'pose:'+m['gesture']:m.get('label') or m['gesture'].replace('_',' ') for m in self.config['mappings']}
        if self.config.get('cue_sheet')==STAGE_SHEET:names.update({'pose:'+key:value for key,value in STAGE_NAMES.items()})
        names.update({m['id']:m['name'] for m in self.config['custom_motions']})
        names.update({m['id']:m['phrase'] for m in self.config.get('speech_mappings',[])})
        now=self.clock()
        return [dict(id=key,label=names.get(key,key),observed=now-self.practice_evidence.get(key,-100)<15)
                for key in sorted(self.needs_practice)]

    def active_recognition(self):
        active=set()
        if self.camera_required():
            if self.config['mode']=='cue':active.update('pose:'+m['gesture'] for m in self.config['mappings'] if m['enabled'])
            if self.config['mode']=='motion':active.update(m['id'] for m in self.config['custom_motions'] if m['enabled'])
        if self.speech_required():
            active.update(m['id'] for m in self.config.get('speech_mappings',[]) if m['enabled'] and mapping_target(m))
        return active

    def zoom_recovery_required(self,allow_owned_zoom=False):
        # Only the override currently controlled by this live Zoom session can
        # coexist with speech cues. Remembered overrides still block output.
        owns_live_zoom=(allow_owned_zoom and self.armed and self.config['mode']=='zoom' and
                       self.camera_required() and self.speech_required() and
                       self.owned is not None and self.pending==[self.owned])
        return bool(self.pending and not owns_live_zoom)

    def session_gate(self,*,allow_owned_zoom=False):
        if not self.workflow_active:raise ValueError('Start a session first')
        if self.rehearsal:raise ValueError('Rehearsal is isolated. Start a console session for live output.')
        if not self.fresh():raise ValueError('Connect to Eos and wait for current console feedback')
        if not self.console_identity.get('version') or not (self.console_identity.get('show_name') or self.console_identity.get('show_path')):
            raise ValueError('Waiting for Eos show identity')
        if not self.session_confirmed:raise ValueError('Confirm the console session first')
        if self.zoom_recovery_required(allow_owned_zoom):raise ValueError('Release the remembered Zoom override first')

    def check_revision(self,data):
        if data.get('revision')!=self.config_revision or data.get('epoch')!=self.output_epoch:
            raise ValueError('Settings or output state changed; use the current preview and try again')

    def target_ready(self,target):
        receipt=self.target_tests.get(target['id'],{})
        return receipt.get('confirmed') or (target['output_type']=='channel_look' and receipt.get('skipped'))

    def workflow_state(self,speech_status=None):
        targets=[]
        for target in self.all_targets():
            receipt=self.target_tests.get(target['id'],{})
            targets.append(dict(target,sent=bool(receipt.get('sent')),confirmed=bool(receipt.get('confirmed')),
                                skipped=bool(receipt.get('skipped'))))
        practices=self.practice_items();active=self.active_recognition()
        blockers=[]
        def block(kind,message,identity=None):
            item=dict(kind=kind,message=message)
            if identity is not None:item['id']=identity
            blockers.append(item)
        if not self.workflow_active:block('start_session','Start a session to connect the console and preview your inputs')
        else:
            if self.camera_required():
                if not self.camera_ready:block('start_camera','Start the camera to preview gestures')
                elif not self.camera_frame_seen or self.clock()-self.camera_frame_time>1.5:
                    block('camera','Waiting for current camera frames')
                elif 'pose:Ankh_Pose' in active and not self.stage_tracking_ready:
                    block('camera','Ankh needs body tracking. Restart the camera if it is unavailable.')
            if self.speech_required():
                if not getattr(self,'speech_ready',False):block('start_microphone','Start the microphone to preview speech')
                elif not getattr(self,'speech_frame_seen',False) or self.clock()-getattr(self,'speech_frame_time',-100)>1.5:
                    block('microphone','Waiting for current microphone audio')
                elif (speech_status if speech_status is not None else self.speech_engine.status()).get('loading'):
                    block('microphone','The local speech model is warming up')
            if not self.rehearsal:
                if not self.fresh():block('connect','Connect to Eos and wait for current console feedback')
                elif not self.console_identity.get('version') or not (self.console_identity.get('show_name') or self.console_identity.get('show_path')):
                    block('connect','Waiting for Eos show identity')
                elif not self.session_confirmed:block('confirm_session','Confirm the console and show for this session')
                if self.zoom_recovery_required(allow_owned_zoom=True):block('release','Release the remembered Zoom override before continuing')
                if self.config['dry_run']:block('settings','Turn off simulation to use live output')
                if self.config['mode']!='zoom' and not targets:block('settings','Assign a speech cue, channel level, or look and enable its phrase' if not self.camera_required() else 'Assign an output and enable at least one trigger')
                if not self.camera_required() and self.config['mode']=='zoom':block('settings','Speech-only sessions need Camera + speech to use Zoom')
                if self.camera_required() and self.config['mode']=='cue' and any(m['enabled'] and m['gesture']=='Arms_Open' for m in self.config['mappings']) and (self.config['close'] is None or self.config['far'] is None):
                    block('settings','Calibrate close and far hand spacing before using Arms Open')
                for target in targets:
                    if not self.target_ready(target):
                        receipt=self.target_tests.get(target['id'],{})
                        current=(self.pending_test==target['id'] and receipt.get('epoch')==self.output_epoch and receipt.get('revision')==self.config_revision)
                        if current:block('confirm_target',f"Confirm the visible result of {target['command']}",target['id'])
                        else:block('test_target',f"{target['command']} needs a console test",target['id'])
            for item in practices:
                if item['id'] in active and not (self.speech_practice_skipped and item['id'].startswith('speech_')):
                    block('practice',f"Practice {item['label']} with the current settings",item['id'])
            if self.rehearsal:block('start_session','Rehearsal · no console output. Start a console session when ready.')
            if not self.rehearsal and self.camera_required() and self.config['mode']=='zoom':
                try:self.zoom_ready(calibration=True)
                except ValueError as error:block('settings',str(error))
                if not getattr(self,'zoom_confirmed',False):block('confirm_zoom','Test Zoom and its release, then confirm their visible results')
        state='live' if self.armed else 'paused' if self.output_paused else 'preview'
        next_action=blockers[0]['kind'] if blockers else 'none' if self.armed else 'go_live'
        reason=blockers[0]['message'] if blockers else ('Live — enabled inputs can trigger cues' if self.armed else 'Ready — go live when you are ready')
        if not blockers and state=='paused':reason=self.pause_reason+' — ready to resume'
        return dict(active=self.workflow_active,rehearsal=self.rehearsal,state=state,reason=reason,revision=self.config_revision,epoch=self.output_epoch,
                    input_source=self.config.get('input_source','camera'),
                    camera_ready=self.camera_ready,microphone_ready=getattr(self,'speech_ready',False),session_confirmed=self.session_confirmed,
                    identity=dict(self.endpoint(),**self.console_identity),targets=targets,needs_practice=practices,
                    speech_practice_skipped=self.speech_practice_skipped,
                    blockers=blockers,next_action=next_action,can_go_live=self.workflow_active and not blockers and not self.armed,
                    fresh_gesture_required=self.fresh_gesture_required,
                    confirmed_target_ids=sorted(key for key,r in self.target_tests.items() if r.get('confirmed')))

    def workflow_action(self,name,data):
        if name=='start_rehearsal':
            # Release previous ownership before isolating the rehearsal.
            self.stop('Starting a local rehearsal')
            self.transport.close()
            self.connected=self.verified=False;self.feedback={}
            self.workflow_connected()
            self.workflow_active=True;self.rehearsal=True
            if not self.config['dry_run']:
                config=copy.deepcopy(self.config);config['dry_run']=True;self.apply(config)
            self.output_paused=False;self.pause_reason='Rehearsal · no console output'
        elif name=='session_start':
            if self.rehearsal_only:raise ValueError('This instance is rehearsal only and cannot connect to Eos')
            self.rehearsal=False
            self.workflow_active=True
            self.stop('New session started in Preview')
            self.speech_practice_skipped=False
            self.session_confirmed=False;self.target_tests.clear();self.pending_test=None
            if self.config['dry_run']:
                config=copy.deepcopy(self.config);config['dry_run']=False;self.apply(config)
            if not self.fresh():
                try:self.connect()
                except (OSError,ValueError) as error:
                    self.log('ERROR','Console unavailable; Preview remains available: '+str(error)[:160])
            self.output_paused=False;self.pause_reason='Preview — complete the next required check'
        elif name=='confirm_session':
            self.check_revision(data)
            if not self.workflow_active or not self.fresh():raise ValueError('Start the session and wait for Eos feedback')
            if not self.console_identity.get('version') or not (self.console_identity.get('show_name') or self.console_identity.get('show_path')):raise ValueError('Waiting for Eos version and show identity')
            if not data.get('only_host') or not data.get('session_ok'):raise ValueError('Confirm the intended console and that this is the only control laptop')
            self.session_confirmed=True
        elif name=='camera_status':
            ready=data.get('ready')
            if not isinstance(ready,bool):raise ValueError('Camera ready must be boolean')
            preview=self.workflow_active and not self.armed and not self.output_paused
            identity=str(data.get('camera_id',self.config.get('camera_id','')))
            if len(identity)>512:raise ValueError('Invalid camera selection')
            changed=identity!=self.config.get('camera_id','')
            if not ready or changed or not self.camera_ready:
                self.stop('Camera changed' if changed else 'Camera started' if ready else 'Camera stopped')
            if changed:
                if self.config.get('camera_id',''):self.needs_practice.update(key for key in recognition(self.config) if not key.startswith('speech_'))
                self.config['camera_id']=identity;self.config_revision+=1;self.save_profile()
            self.camera_ready=ready;self.camera_frame_seen=False;self.camera_frame_time=-100
            if ready and preview:
                self.output_paused=False;self.pause_reason='Preview — complete the next required check'
        elif name=='pause':self.stop(str(data.get('reason','Output paused'))[:160])
        elif name=='rehearsal_trigger':
            self.check_revision(data)
            if not self.workflow_active or not self.rehearsal or self.armed:
                raise ValueError('Start a local rehearsal before testing a demo trigger')
            source=data.get('source')
            if source=='camera':
                mapping=next((row for row in self.config['mappings'] if row['gesture']==data.get('gesture')),None)
                label=STAGE_NAMES.get(mapping['gesture'],mapping['gesture'].replace('_',' ')) if mapping else ''
            elif source=='speech':
                mapping=next((row for row in self.config['speech_mappings'] if row['id']==data.get('id')),None)
                label=mapping['phrase'] if mapping else ''
            else:raise ValueError('Choose a gesture or speech demo trigger')
            if mapping is None or mapping_target(mapping) is None:
                raise ValueError('Assign an output to this trigger before previewing its demo')
            self.record_stage_preview('demo',label,mapping)
        elif name=='skip_look_tests':
            self.check_revision(data)
            if self.armed:raise ValueError('Pause automatic output before skipping look tests')
            self.session_gate()
            if self.config['dry_run']:raise ValueError('Exit simulation before skipping live look tests')
            skipped=0
            for target in self.all_targets():
                if target['output_type']=='channel_look' and not self.target_ready(target):
                    self.target_tests[target['id']]=dict(skipped=True)
                    if self.pending_test==target['id']:self.pending_test=None
                    skipped+=1
            self.log('TEST',f'Operator skipped {skipped} channel look tests. No output sent.')
        elif name=='test_target':
            self.check_revision(data)
            if self.armed:raise ValueError('Pause automatic output before a console test')
            self.session_gate()
            if self.config['dry_run']:raise ValueError('Exit simulation before testing an output on the console')
            identity=data.get('id');target=next((t for t in self.all_targets(False) if t['id']==identity),None)
            if not target:raise ValueError('Choose a configured output')
            if not self.send_target(target,source='manual'):raise ValueError(self.cue_wait_message())
            self.test_serial+=1
            self.target_tests[identity]=dict(sent=True,confirmed=False,revision=self.config_revision,epoch=self.output_epoch,serial=self.test_serial)
            self.pending_test=identity
            self.log('TEST',f"{target['command']} sent. Waiting for visible confirmation.")
        elif name=='confirm_target':
            self.session_gate();self.check_revision(data)
            identity=data.get('id');receipt=self.target_tests.get(identity)
            if self.pending_test!=identity or not receipt or receipt.get('epoch')!=self.output_epoch or receipt.get('revision')!=self.config_revision:
                raise ValueError('Test this output with the current settings before confirming its result')
            if data.get('worked') is not True:raise ValueError('Confirm the intended visible result before continuing')
            receipt['confirmed']=True;self.pending_test=None
            self.log('CONFIRM',identity+' visible result confirmed')
        elif name=='skip_speech_practice':
            self.check_revision(data)
            if self.armed:raise ValueError('Pause output before skipping speech practice')
            self.session_gate()
            if self.config['dry_run'] or not self.speech_required():
                raise ValueError('Start a live console session with speech enabled first')
            self.speech_practice_skipped=True
            self.log('PRACTICE','Operator skipped speech practice. No output sent.')
        elif name=='practice_confirm':
            self.check_revision(data)
            identity=data.get('id')
            if self.armed:raise ValueError('Pause output before checking recognition')
            if identity not in recognition(self.config):raise ValueError('Unknown trigger')
            speech=identity.startswith('speech_')
            ready=getattr(self,'speech_ready',False) if speech else self.camera_ready
            frame_time=getattr(self,'speech_frame_time',-100) if speech else self.camera_frame_time
            seen=getattr(self,'speech_frame_seen',False) if speech else self.camera_frame_seen
            if data.get('observed') is not True or not ready or not seen or self.clock()-frame_time>1.5 or self.clock()-self.practice_evidence.get(identity,-100)>=15:
                raise ValueError('Say the complete phrase in the current microphone preview first' if speech else 'Perform the complete gesture in the current camera preview first')
            self.needs_practice.discard(identity);self.save_profile()
            self.log('PRACTICE',identity+' recognition confirmed')
        elif name=='confirm_zoom':
            self.session_gate()
            if not(self.zoom_tested and self.release_tested and not self.pending and data.get('worked') is True):
                raise ValueError('Test Zoom and release, then confirm their visible results')
            self.zoom_confirmed=True
        elif name=='recheck_cues':
            self.stop('Cue checks reset by operator');self.target_tests.clear();self.pending_test=None
        elif name=='start_gesture_hold':
            self.check_revision(data)
            self.session_gate()
            if not self.armed or not self.camera_required() or self.config['mode']!='cue':
                raise ValueError('Go live with gesture input first')
            if not self.camera_frame_seen or self.clock()-self.camera_frame_time>1.5:
                raise ValueError('Wait for the camera to deliver current frames')
            if self.fresh_gesture_required:
                self.fresh_gesture_required=False
                self.neutral_since=None
                self.telemetry['hold']=0
                self.log('LIVE','Operator opened the gesture gate. Waiting for a complete hold.')
        elif name=='go_live':
            self.check_revision(data)
            self.session_gate()
            current=self.workflow_state()
            if current['blockers']:raise ValueError(current['blockers'][0]['message'])
            self.stop('Starting fresh gesture output')
            self.armed=True;self.output_paused=False;self.pause_reason='Live'
            now=self.clock()
            self.last_frame=now;self.last_hands=now
            # The audio worklet starts a fresh packet after the epoch changes.
            # Allow that packet to arrive without treating it as observed audio.
            if self.speech_required():self.speech_frame_time=now
            # Go live is the deliberate boundary for a static cue. stop() has
            # reset its hold/latch and the new epoch rejects preview frames.
            # Motion and continuous Zoom still need their initial neutral.
            self.fresh_gesture_required=self.camera_required() and self.config['mode']!='cue'
            if self.camera_required() and self.config['mode']=='cue':self.gate.ready=True
            self.motion_last_fire={};self.gate.last_fire=self.last_cue_t;self.palm_gate.last_fire=self.last_cue_t
            self.log('LIVE',('Gesture output enabled; waiting for a fresh complete hold' if self.config['mode']=='cue'
                            else 'Input output enabled; waiting for neutral and a fresh complete gesture')
                     if self.camera_required() else 'Speech output enabled; waiting for silence and a fresh complete phrase')
        else:return False
        return True

    def recognized_motion(self,candidate):
        if not isinstance(candidate,dict):
            return None
        motion=next((item for item in self.config['custom_motions'] if item['id']==candidate.get('id')),None)
        similarity=candidate.get('similarity')
        if motion and isinstance(similarity,(int,float)) and not isinstance(similarity,bool) and motion['threshold']<=similarity<=1:
            return motion

    def workflow_frame(self,data):
        """True consumes the frame; False lets the armed gesture engine use it."""
        if not self.workflow_active:return False
        if not self.camera_required():return True
        # Stale work must never refresh input freshness or reach an output gate.
        if data.get('revision')!=self.config_revision or data.get('epoch')!=self.output_epoch:return True
        if data.get('source')!='camera' or not self.camera_ready:return True
        name=data.get('gesture','None');score=data.get('confidence',0)
        if not isinstance(score,(int,float)) or isinstance(score,bool) or not 0<=score<=1:raise ValueError('Invalid camera confidence')
        now=self.clock()
        stage=self.config.get('cue_sheet')==STAGE_SHEET
        if stage and now-self.camera_frame_time>STAGE_FRAME_GAP_S:self.neutral_since=None
        self.last_heartbeat=now
        self.last_frame=now;self.camera_frame_time=now;self.camera_frame_seen=True
        self.camera_frame_times.append(now)
        self.camera_frames_received=min(1000000,self.camera_frames_received+1)
        self.stage_tracking_ready=stage and data.get('stage_ready') is True
        if self.armed and stage and not self.stage_tracking_ready and 'pose:Ankh_Pose' in self.active_recognition():
            self.stop('Stage body tracking unavailable; restart camera');return True
        mapping=next((m for m in self.config['mappings'] if m['gesture']==name),None)
        uncertain=stage and data.get('tracking_uncertain') is True
        empty=stage and data.get('neutral_kind')=='empty'
        preview_poses=self.config['mode']=='cue'
        if preview_poses or (stage and not self.armed):
            track=data.get('tracking_key')
            if not isinstance(track,str) or len(track)>80:track=None
            uncertain_pose=uncertain or stage and name=='Ankh_Pose' and not self.stage_tracking_ready
            self.practice_gate.update(name,score,self.config['mappings'],now,uncertain_pose,
                                      empty,data.get('tracking_gap')=='brief',track)
            if not self.armed:self.telemetry['hold']=self.practice_gate.progress
            if mapping and not uncertain_pose and self.practice_gate.progress>=1:
                if stage and not self.armed:self.practice_evidence['pose:'+name]=now
                if preview_poses and self.practice_gate.latched!=name:
                    self.record_stage_preview('camera',STAGE_NAMES.get(name,name.replace('_',' ')),mapping)
                    self.practice_gate.fired(name)
        if not stage and mapping and score>=mapping['confidence']:
            self.practice_since={name:self.practice_since.get(name,now)}
            held=now-self.practice_since[name]
            if held>=mapping['hold_s']:self.practice_evidence['pose:'+name]=now
        elif not stage:
            self.practice_since={}
        self.telemetry.update(gesture=name,confidence=score)
        if not self.armed:
            practice_motion=self.recognized_motion(data.get('motion_practice'))
            if practice_motion:self.practice_evidence[practice_motion['id']]=now
            if self.rehearsal and self.config['mode']=='motion':
                preview_motion=self.recognized_motion(data.get('motion_preview'))
                motion=practice_motion or (preview_motion if preview_motion and preview_motion['enabled'] else None)
                if motion:self.record_stage_preview('motion',motion['name'],motion)
            self.record_camera_diagnostics(data,self.practice_gate)
            return True
        if self.fresh_gesture_required:
            neutral=not uncertain and (name=='None' if stage else name=='None' or score<.75)
            if neutral:
                if self.neutral_since is None:self.neutral_since=now
                if now-self.neutral_since>=(.7 if empty else .3):
                    self.fresh_gesture_required=False
                    self.gate.ready=True
            else:self.neutral_since=None
            self.record_camera_diagnostics(data,self.stage_gate if stage else self.gate)
            return True
        return False

    def record_camera_diagnostics(self,data,gate):
        """Latest scalar evidence only; no image, landmark, or audio retention."""
        now=self.clock()
        name=data.get('gesture','None')
        mapping=next((row for row in self.config['mappings'] if row['gesture']==name),None)
        confidence=data.get('confidence',0)
        progress=max(0,min(1,getattr(gate,'progress',0)))
        neutral_since=getattr(gate,'neutral_since',None)
        if self.fresh_gesture_required:neutral_since=self.neutral_since
        threshold=mapping['confidence'] if mapping else None
        hold_required=mapping['hold_s'] if mapping else None
        dispatch=self.cue_lane.status
        if data.get('tracking_uncertain') is True:
            phase,reason='uncertain','Tracking is uncertain; waiting for a clear, current pose.'
        elif self.fresh_gesture_required and self.armed:
            phase,reason='neutral','Return to neutral before starting a complete gesture.'
        elif mapping is None:
            phase,reason='neutral' if name=='None' else 'unmapped','Waiting for a complete mapped gesture.'
        elif confidence<threshold:
            phase,reason='confidence','Gesture confidence is below its saved threshold.'
        elif progress<1:
            phase,reason='holding','Keep the gesture steady to complete its hold.'
            if self.armed and not self.config.get('cue_sheet')==STAGE_SHEET and self.config['palm_from_fist'] and name=='Open_Palm' and not gate.ready:
                phase,reason='prepare','Close a fist to prepare the open-palm transition.'
        elif not self.armed:
            phase,reason='preview','Gesture recognized in Preview; automatic output is paused.'
        elif not mapping['enabled']:
            phase,reason='disabled','Gesture recognized; its output mapping is disabled.'
        elif mapping_target(mapping) is None:
            phase,reason='unassigned','Gesture recognized; assign an output first.'
        elif dispatch.get('source')=='camera' and dispatch.get('identity')==name:
            phase=dispatch['kind']
            reason=dispatch.get('reason') or ('Gesture recognized; waiting for console spacing.' if phase=='waiting'
                                            else 'The gesture command was sent; return to neutral before repeating it.')
        else:
            phase,reason='latched','Gesture already accepted; return to neutral before repeating it.'
        times=[value for value in self.camera_frame_times if now-value<=3]
        elapsed=times[-1]-times[0] if len(times)>1 else 0
        self.telemetry['camera_diagnostics']=dict(phase=phase,reason=reason,gesture=name,confidence=confidence,
            threshold=threshold,hold_progress=round(progress,3),hold_s=round(progress*hold_required,3) if hold_required else 0,
            hold_required_s=hold_required,neutral_s=round(max(0,now-neutral_since),3) if neutral_since is not None else 0,
            neutral_required_s=.7 if data.get('neutral_kind')=='empty' else .3,
            received_fps=round((len(times)-1)/elapsed,1) if elapsed>0 else 0,frames_received=self.camera_frames_received)
