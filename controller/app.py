"""Local lighting controller with optional offline speech recognition."""
import argparse
import base64
import binascii
import copy
import ipaddress
import json
import math
import mimetypes
import os
import re
import secrets
import signal
import struct
import threading
import time
import webbrowser
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from osc import Transport
from diagnostics import probe
from workflow import SessionWorkflow, behavior
from speech import SpeechEngine, DEFAULT_SPEECH_MAPPINGS, normalized_phrase, validate_speech_mappings
from show_profile import (FIRE, STAGE_BRIEF_GAP_S, STAGE_EFFECTS, STAGE_FRAME_GAP_S, STAGE_GESTURES, STAGE_SHEET, StageGestureGate,
                          direct_channel_config, speech_aliases, speech_match, speech_recognition_phrases,
                          stage_config)
from cue_output import CAMERA_EVIDENCE_MAX_AGE, CueIntent, CueLane, output_label
from mapping_outputs import CHANNEL_OUTPUT_TYPES, mapping_target, output_key, validate_mapping_output

ROOT = Path(__file__).resolve().parent
try:BUILD_VERSION=(ROOT/'VERSION').read_text(encoding='utf-8').strip()[:80] or 'development'
except OSError:BUILD_VERSION='development'
SPEECH_CUE_OFFERED = 'Phrase recognized · cue requested'
GESTURES = ['Arms_Open', 'Open_Palm', 'Closed_Fist', 'Thumb_Up', 'Victory']
DEFAULT = dict(host='169.254.44.253', port=3032, framing='length', dry_run=True, mode='cue',palm_from_fist=True,custom_motions=[],camera_id='',pose_calibration={},
    cue_sheet='legacy',input_source='camera',microphone_id='',speech_backend='auto',speech_mappings=copy.deepcopy(DEFAULT_SPEECH_MAPPINGS),speech_confidence=.7,speech_cooldown_s=2,cue_interval_s=2,
    mappings=[dict(gesture=g, enabled=g in ('Open_Palm','Closed_Fist'), cue_list=1,
        cue={'Open_Palm':'1000','Closed_Fist':'888'}.get(g,''), confidence=.8, hold_s=.6, label=g.replace('_',' ')) for g in GESTURES],
    target_type='chan', target='', parameter='zoom', zoom_min=None, zoom_max=None,
    close=None, far=None, reverse=False, alpha=.2, deadband=.02, rate_hz=12,
    hand_confidence=.75, hand_loss_s=.8, notes='Lab verified November 2: laptop Ethernet 169.254.40.147 / 255.255.0.0; console 169.254.44.253. TCP 3032 returns readable Eos identity feedback with OSC 1.0 packet length. TCP 3037/3038 time out. Operator mappings: open palm Cue 1000, closed fist Cue 888, list 1. Zoom target and limits unconfirmed. Photos show Rush Par 2 RGBW Zoom 9ch.')

def number(value, low, high, name):
    if isinstance(value, bool): raise ValueError(name + ': expected number')
    try: value = float(value)
    except (ValueError, TypeError): raise ValueError(name + ': enter a number')
    if not math.isfinite(value) or not low <= value <= high: raise ValueError(name + ': outside allowed range')
    return value

def integer(value, low, high, name):
    n = number(value, low, high, name)
    if n != int(n): raise ValueError(name + ': expected whole number')
    return int(n)

def cue_number(value):
    cue=str(value).strip()
    if not re.fullmatch(r'[0-9]{1,5}(?:\.[0-9]{1,3})?',cue) or float(cue)<=0: raise ValueError('Invalid cue number')
    return cue

def validate_motions(raw):
    if not isinstance(raw,list) or len(raw)>20: raise ValueError('Store at most 20 custom motions')
    result=[];ids=set();names=set()
    for motion in raw:
        if not isinstance(motion,dict): raise ValueError('Invalid custom motion')
        identity=motion.get('id','');name=str(motion.get('name','')).strip()
        if not isinstance(identity,str) or not re.fullmatch(r'motion_[A-Za-z0-9_-]{4,64}',identity) or identity in ids: raise ValueError('Invalid or duplicate custom motion ID')
        if not 1<=len(name)<=80 or any(ord(ch)<32 for ch in name) or name.casefold() in names: raise ValueError('Each custom motion needs a unique name of 1–80 characters')
        if not isinstance(motion.get('enabled'),bool): raise ValueError('Custom motion enabled must be boolean')
        if motion.get('feature_version')!='hand-v1': raise ValueError('Unsupported custom motion feature version')
        templates=motion.get('templates')
        if not isinstance(templates,list) or not 1<=len(templates)<=3: raise ValueError('Each custom motion needs 1–3 demonstrations')
        cleaned=[]
        for template in templates:
            if not isinstance(template,dict): raise ValueError('Invalid motion demonstration')
            duration=number(template.get('duration_s'),.6,6,'Motion duration')
            frames=template.get('frames')
            if not isinstance(frames,list) or len(frames)!=32: raise ValueError('Motion demonstrations require 32 sampled frames')
            validated=[]
            for row in frames:
                if not isinstance(row,list) or len(row)!=38: raise ValueError('Invalid motion feature dimensions')
                validated.append([number(n,-20,20,'Motion feature') for n in row])
            cleaned.append(dict(duration_s=duration,frames=validated))
        output = validate_mapping_output(motion, required=True)
        uses_channel = output.get('output_type') in CHANNEL_OUTPUT_TYPES
        cue = str(motion.get('cue', '')).strip()
        if cue or not uses_channel:
            cue = cue_number(cue)
        result.append(dict(id=identity,name=name,enabled=motion['enabled'],feature_version='hand-v1',
            cue_list=integer(motion.get('cue_list', 1 if uses_channel else None),1,999,'Motion cue list'),cue=cue,
            threshold=number(motion.get('threshold',.85),.7,.98,'Motion similarity threshold'),
            cooldown_s=number(motion.get('cooldown_s',2),1,10,'Motion cooldown'),templates=cleaned,**output))
        ids.add(identity);names.add(name.casefold())
    return result

def validate(raw):
    if not isinstance(raw, dict): raise ValueError('Configuration must be an object')
    c = copy.deepcopy(DEFAULT)
    for key in c:
        if key in raw: c[key] = copy.deepcopy(raw[key])
    c['host'] = str(c['host']).strip()
    if c['host']:
        ip = ipaddress.ip_address(c['host'])
        if not (ip.is_private or ip.is_loopback) or ip.is_multicast or ip.is_unspecified:
            raise ValueError('Use the local console IP address')
    c['port'] = integer(c['port'],1,65535,'TCP port')
    if c['cue_sheet'] not in ('legacy', STAGE_SHEET):raise ValueError('Unknown cue sheet')
    if c['input_source'] not in ('camera','speech','both'):raise ValueError('Choose Camera, Speech, or Camera + speech')
    if c['speech_backend'] not in ('auto','enhanced','vosk'):raise ValueError('Choose a supported speech recognizer')
    c['microphone_id']=str(c['microphone_id'])
    if len(c['microphone_id'])>512:raise ValueError('Invalid microphone selection')
    c['speech_mappings']=validate_speech_mappings(c['speech_mappings'])
    c['speech_confidence']=number(c['speech_confidence'],.6,1,'Speech confidence')
    c['speech_cooldown_s']=number(c['speech_cooldown_s'],1,10,'Speech cooldown')
    c['cue_interval_s']=number(c['cue_interval_s'],1,10,'Minimum time between cues')
    c['camera_id']=str(c['camera_id'])
    if len(c['camera_id'])>512:raise ValueError('Invalid camera selection')
    poses=c['pose_calibration']
    if not isinstance(poses,dict) or any(key not in ('Closed_Fist','Open_Palm') for key in poses):raise ValueError('Invalid hand pose calibration')
    for key,features in poses.items():
        if not isinstance(features,list) or len(features)!=16:raise ValueError('Hand poses require sixteen features')
        poses[key]=[number(value,0,10,'Hand pose feature') for value in features]
    if len(poses)==2 and math.sqrt(sum((a-b)**2 for a,b in zip(poses['Closed_Fist'],poses['Open_Palm']))/16)<.12:
        raise ValueError('Learned fist and palm are too similar')
    if c['framing'] not in ('slip','length'): raise ValueError('Invalid framing')
    if c['mode'] not in ('cue','zoom','motion'): raise ValueError('Invalid mode')
    if c['target_type'] not in ('chan','group'): raise ValueError('Invalid Zoom target type')
    c['target'] = str(c['target']).strip()
    if c['target']: c['target'] = str(integer(c['target'],1,99999,'Zoom target'))
    if c['parameter'] != 'zoom': raise ValueError('Only the zoom parameter is allowlisted')
    for key in ('dry_run','reverse','palm_from_fist'):
        if not isinstance(c[key], bool): raise ValueError(key + ': expected boolean')
    for key, lo, hi in [('alpha',.01,1),('deadband',0,.2),('rate_hz',1,15),('hand_confidence',.75,1),('hand_loss_s',.2,2)]:
        c[key] = number(c[key],lo,hi,key)
    for key in ('zoom_min','zoom_max','close','far'):
        if c[key] is not None: c[key] = number(c[key],0,100000 if key.startswith('zoom') else 4,key)
    if c['zoom_min'] is not None and c['zoom_max'] is not None and c['zoom_min'] >= c['zoom_max']:
        raise ValueError('Zoom maximum must exceed minimum')
    if c['close'] is not None and c['far'] is not None and c['far']-c['close'] < .01:
        raise ValueError('Hands far must exceed hands close by at least 0.01')
    gestures = STAGE_GESTURES if c['cue_sheet'] == STAGE_SHEET else GESTURES
    if not isinstance(c['mappings'],list) or len(c['mappings']) != len(gestures): raise ValueError('Gesture mappings do not match the cue sheet')
    seen = set()
    for m in c['mappings']:
        if not isinstance(m,dict) or m.get('gesture') not in gestures or m['gesture'] in seen: raise ValueError('Invalid or duplicate gesture')
        seen.add(m['gesture'])
        if not isinstance(m.get('enabled'),bool): raise ValueError('Mapping enabled must be boolean')
        default_list = 1 if m.get('output_type') in CHANNEL_OUTPUT_TYPES else None
        m['cue_list'] = integer(m.get('cue_list',default_list),1,999,'Cue list')
        m['cue'] = str(m.get('cue','')).strip()
        if m['cue'] and (not re.fullmatch(r'[0-9]{1,5}(?:\.[0-9]{1,3})?', m['cue']) or float(m['cue']) <= 0): raise ValueError('Invalid cue number')
        m.update(validate_mapping_output(m,required=m['enabled']))
        if m['enabled'] and mapping_target(m) is None: raise ValueError('Enabled mappings need a cue number')
        m['confidence'] = number(m.get('confidence'),.75,1,'Confidence')
        m['hold_s'] = number(m.get('hold_s'),.4,3,'Hold time')
        m['label'] = str(m.get('label',''))[:100]
    c['custom_motions']=validate_motions(c['custom_motions'])
    c['notes'] = str(c['notes'])[:5000]
    return c

class GestureGate:
    def __init__(self,cooldown_s=.9):
        self.candidate = None; self.since = 0; self.neutral = None
        self.ready = False; self.last_fire = -100; self.progress = 0
        self.cooldown_s=cooldown_s

    def update(self, name, confidence, mappings, now):
        mapping = next((m for m in mappings if m['enabled'] and m['gesture']==name and confidence>=m['confidence']), None)
        if mapping is None:
            self.candidate = None; self.progress = 0
            if self.neutral is None: self.neutral = now
            if now-self.neutral >= .3: self.ready = True
            return None
        self.neutral = None
        if self.candidate != name: self.candidate, self.since = name, now
        self.progress = min(1,(now-self.since)/mapping['hold_s'])
        if self.ready and self.progress >= 1 and now-self.last_fire >= self.cooldown_s:
            self.ready = False; self.last_fire = now
            return mapping
        return None

class FistPalmGate:
    """A stable fist can fire its own cue and prepares one subsequent palm."""
    def __init__(self,cooldown_s=.9):
        self.fist_since=None; self.palm_since=None; self.loss_since=None
        self.prepare_since=None; self.open_seen_since=None; self.closed_fired=False
        self.ready=False; self.progress=0; self.last_fire=-100
        self.cooldown_s=cooldown_s

    def update(self,name,confidence,mappings,now):
        mapping=next((m for m in mappings if m['enabled'] and m['gesture']=='Open_Palm'),None)
        if mapping is None: return None
        closed=next((m for m in mappings if m['enabled'] and m['gesture']=='Closed_Fist'),None)
        confident=confidence>=mapping['confidence']
        if name=='Closed_Fist' and (confident or closed and confidence>=closed['confidence']):
            self.loss_since=None; self.palm_since=None; self.open_seen_since=None
            if self.fist_since is None: self.fist_since=now
            if confident:
                if self.prepare_since is None: self.prepare_since=now
                if now-self.prepare_since>=.3: self.ready=True
            else: self.prepare_since=None
            self.progress=min(1,(now-self.fist_since)/closed['hold_s']) if closed else 0
            if closed and confidence>=closed['confidence'] and not self.closed_fired and self.progress>=1 and now-self.last_fire>=self.cooldown_s:
                self.closed_fired=True; self.last_fire=now
                return closed
            return None
        self.fist_since=None; self.prepare_since=None
        if name=='Open_Palm' and confident:
            self.loss_since=None
            if self.open_seen_since is None: self.open_seen_since=now
            if now-self.open_seen_since>=.3: self.closed_fired=False
            if not self.ready: self.progress=0; self.palm_since=None; return None
            if self.palm_since is None: self.palm_since=now
            self.progress=min(1,(now-self.palm_since)/mapping['hold_s'])
            if self.progress>=1 and now-self.last_fire>=self.cooldown_s:
                self.ready=False; self.last_fire=now; self.palm_since=None
                return mapping
            return None
        self.palm_since=None; self.open_seen_since=None; self.progress=0
        if self.loss_since is None: self.loss_since=now
        if now-self.loss_since>=.3: self.ready=False; self.closed_fired=False
        return None

class Controller(SessionWorkflow):
    def __init__(self, folder=ROOT, clock=time.monotonic, speech_engine=None, rehearsal_only=False):
        self.folder, self.clock = Path(folder), clock
        self.rehearsal_only=rehearsal_only
        self.cue_sheet_backup=self.folder/'previous-cue-sheet.json'
        self.saved_stage_sheet=self.folder/'stage-cue-sheet.json'
        self.lock = threading.RLock()
        self.config = copy.deepcopy(DEFAULT)
        self.logs = deque(maxlen=300)
        self.armed = False; self.owner = None; self.last_heartbeat = 0; self.last_frame = 0
        self.connected = False; self.verified = False; self.feedback_time = 0; self.ping_time = 0
        self.feedback = {}; self.gate = GestureGate(0); self.pending = []
        self.palm_gate=FistPalmGate(0); self.stage_gate=StageGestureGate()
        self.cue_lane=CueLane()
        self.last_output=None;self.output_serial=0;self.state_serial=0
        self.owned = None; self.dry_owned = False; self.last_hands = 0
        self.smooth = None; self.last_zoom = None; self.last_zoom_t = -100; self.last_cue_t = -100
        self.telemetry = {}; self.cue_tested = False; self.zoom_tested = False; self.release_tested = False
        self.diagnostics = None
        self.tested_motions=set(); self.motion_latched=None; self.motion_miss_since=None; self.motion_last_fire={}
        self.transport = Transport(self.receive, self.failed, lock=self.lock)
        self.speech_engine=speech_engine or SpeechEngine(ROOT/'models'/'vosk-model-small-en-us-0.15')
        self.speech_ready=False;self.speech_frame_seen=False;self.speech_frame_time=-100
        self.speech_stream=None;self.speech_sequence=0;self.speech_last_fire={}
        self.speech_partial='';self.speech_last_text='';self.speech_last_match=None
        self.speech_last_confidence=None
        self.speech_error='';self.speech_last_outcome='Microphone is off'
        self.speech_quiet_samples=0;self.speech_wait_for_silence=True
        self.speech_quiet_since=None
        self.speech_prefix_utterance=None
        self.preview_speech_utterance=None
        profile=None
        profile_path=self.folder/'profile.json'
        if profile_path.exists():
            try:
                profile=json.loads(profile_path.read_text(encoding='utf-8'))
                self.config=validate(profile['config']);self.config['dry_run']=True
            except (ValueError,KeyError,TypeError,OSError) as error:
                profile=None;self.log('ERROR','Could not load saved setup: '+str(error))
        journal = self.folder / 'pending-release.json'
        if journal.exists():
            self.pending = json.loads(journal.read_text())
            for p in self.pending:
                if not re.fullmatch(r'/eos/(chan|group)/[0-9]+/param/zoom/release',p['address']): raise ValueError('Invalid recovery journal')
            if self.pending: self.config.update(self.pending[0]['endpoint'])
        saved_motions=self.folder/'custom-motions.json'
        if saved_motions.exists():
            try: self.config['custom_motions']=validate_motions(json.loads(saved_motions.read_text(encoding='utf-8')))
            except (ValueError,OSError) as error: self.log('ERROR','Could not load custom motions: '+str(error))
        select_backend=getattr(self.speech_engine,'select_backend',None)
        if select_backend:select_backend(self.config['speech_backend'])
        self.set_speech_context()
        self.workflow_init(profile)
        self.log('READY', 'Setup restored. Starts in Preview; no live output permission is restored.')

    def log(self, kind, message):
        item = dict(time=time.strftime('%H:%M:%S'), kind=kind, message=message)
        self.logs.append(item)
        with (self.folder / 'events.jsonl').open('a',encoding='utf-8') as f: f.write(json.dumps(item)+'\n')

    def journal(self):
        path = self.folder / 'pending-release.json'
        tmp = path.with_suffix('.tmp'); tmp.write_text(json.dumps(self.pending)); tmp.replace(path)

    def endpoint(self): return {k:self.config[k] for k in ('host','port','framing')}
    def fresh(self): return self.connected and self.verified and self.clock()-self.feedback_time < 8

    def send(self, address, args=(), live=False):
        if not live and self.config['dry_run']:
            self.log('DRY',address+' '+json.dumps(list(args))); return
        if self.rehearsal_only or self.rehearsal:raise ValueError('Rehearsal does not send commands to Eos')
        try:
            self.transport.send(address,args)
            self.log('TX',address+' '+json.dumps(list(args)))
        except OSError as e:
            self.failed(str(e)); raise ValueError('Connection failed; release retained for reconnect')

    def receive(self, address, args):
        with self.lock:
            if not address.startswith('/eos/out/'): return
            self.feedback_time = self.clock()
            if address in ('/eos/out/get/version','/eos/out/show/name','/eos/out/get/show/path') and args:
                self.verified = True
            if address != '/eos/out/ping':
                self.feedback[address] = args
                if len(self.feedback)>30: self.feedback.pop(next(iter(self.feedback)))
                self.log('RX',address+' '+json.dumps(args))
            self.workflow_received(address,args)

    def failed(self, reason):
        with self.lock:
            self.connected = self.verified = self.armed = False
            self.owned = None; self.dry_owned = False; self.gate = GestureGate(0)
            self.transport.close()
            self.workflow_stopped('Console connection lost')
            self.session_confirmed=False;self.target_tests.clear();self.pending_test=None
            self.log('ERROR',reason+'; disarmed. Reconnect to release remembered target.')

    def connect(self):
        if self.rehearsal_only or self.rehearsal:raise ValueError('Start a console session to connect to Eos')
        self.stop('Connect / reconnect')
        self.connected = self.verified = False; self.feedback = {}
        self.cue_tested = self.zoom_tested = self.release_tested = False
        self.tested_motions.clear()
        self.workflow_connected()
        if not self.config['host']: raise ValueError('Enter the physical console Host IP first')
        self.transport.connect(**self.endpoint()); self.connected = True
        # Release old ownership before asking for or accepting new output.
        self.release_pending()
        self.send('/eos/get/version',live=True)
        self.send('/eos/get/show/path',live=True)
        self.send('/eos/ping',['gesture-eos-lab'],live=True)
        self.ping_time = self.clock()

    def release_pending(self):
        for p in self.pending[:]:
            if p['endpoint'] == self.endpoint() and self.connected:
                self.send(p['address'],live=True)
                self.pending.remove(p); self.journal()

    def release(self):
        if self.dry_owned:
            self.log('DRY',self.zoom_address('release')); self.dry_owned = False
        self.release_pending()
        self.owned = None; self.smooth = None; self.last_zoom = None

    def stop(self, reason='Stop Output'):
        self.armed = False; self.gate = GestureGate(0); self.palm_gate=FistPalmGate(0);self.stage_gate=StageGestureGate()
        self.motion_latched=None; self.motion_miss_since=None
        self.workflow_stopped(reason)
        try: self.release()
        finally: self.log('STOP',reason)

    def apply(self, raw):
        c = validate(raw)
        if self.rehearsal or self.rehearsal_only:c['dry_run']=True
        old=copy.deepcopy(self.config)
        backend_changed=old.get('speech_backend','auto')!=c['speech_backend']
        cue_sheet_changed=old.get('cue_sheet','legacy')!=c['cue_sheet']
        microphone_changed=old.get('microphone_id','')!=c.get('microphone_id','')
        microphone_operational=microphone_changed and (old.get('input_source','camera')!='camera' or c['input_source']!='camera')
        operational=behavior(old)!=behavior(c) or old.get('camera_id','')!=c.get('camera_id','') or microphone_operational
        if operational:self.stop('Settings changed; check only the affected items')
        if self.pending and {k:c[k] for k in ('host','port','framing')} != self.endpoint():
            raise ValueError('Reconnect to the previous console and release pending Zoom before changing host')
        if {k:c[k] for k in ('host','port','framing')} != self.endpoint():
            self.transport.close(); self.connected = self.verified = False; self.feedback = {}
        motions_changed=c['custom_motions']!=self.config['custom_motions']
        self.config = c
        if motions_changed:
            path=self.folder/'custom-motions.json';temporary=path.with_suffix('.tmp')
            temporary.write_text(json.dumps(c['custom_motions'],ensure_ascii=False),encoding='utf-8');temporary.replace(path)
        endpoint_changed=any(old[k]!=c[k] for k in ('host','port','framing'))
        old_targets={target['id'] for m in old['mappings'] if m['enabled'] and (target:=mapping_target(m))}
        new_targets={target['id'] for m in c['mappings'] if m['enabled'] and (target:=mapping_target(m))}
        if endpoint_changed or new_targets-old_targets:self.cue_tested=False
        old_motions = {m['id']: mapping_target(m)['id'] for m in old['custom_motions']}
        self.tested_motions = {
            m['id'] for m in c['custom_motions']
            if m['id'] in self.tested_motions and old_motions.get(m['id']) == mapping_target(m)['id']
        }
        if endpoint_changed:self.tested_motions.clear()
        self.workflow_changed(old,c)
        if cue_sheet_changed:self.set_speech_context()
        if backend_changed:
            self.speech_engine.stop();self.speech_ready=False;self.speech_stream=None
            self.speech_partial='';self.speech_last_text='';self.speech_last_confidence=None
            self.speech_error='';self.speech_last_outcome='Start the microphone with the new recognizer'
            select_backend=getattr(self.speech_engine,'select_backend',None)
            if select_backend:select_backend(c['speech_backend'])
        elif self.speech_ready and (cue_sheet_changed or speech_recognition_phrases(old)!=speech_recognition_phrases(c)):
            try:self.speech_engine.start(speech_recognition_phrases(c))
            except ValueError as error:
                self.speech_ready=False;self.speech_error=str(error)
        self.save_profile()
        if operational:self.telemetry = {}; self.gate = GestureGate(0)
        self.log('CONFIG','Settings saved; affected checks updated' if operational else 'Details saved; session and checks preserved')

    def load_cue_sheet(self):
        if self.config['cue_sheet']==STAGE_SHEET:return
        replacement=validate(json.loads(self.saved_stage_sheet.read_text(encoding='utf-8'))) if self.saved_stage_sheet.is_file() else validate(stage_config(self.config))
        if replacement['cue_sheet']!=STAGE_SHEET:raise ValueError('Saved show cue sheet is invalid')
        replacement['dry_run']=self.config['dry_run']
        replacement['custom_motions']=copy.deepcopy(self.config['custom_motions'])
        self.save_cue_sheet_snapshot(self.cue_sheet_backup)
        self.apply(replacement)
        self.last_output=None

    def switch_channel_looks(self, restore=False):
        if self.armed:
            raise ValueError('Pause output before changing the show assignments')
        backup = self.folder / 'previous-channel-looks.json'
        if restore:
            if not backup.is_file():
                raise ValueError('No previous assignments to restore')
            previous = validate(json.loads(backup.read_text(encoding='utf-8')))
            replacement = copy.deepcopy(self.config)
            for key in ('cue_sheet', 'mode', 'palm_from_fist', 'mappings', 'speech_mappings'):
                replacement[key] = previous[key]
            self.apply(replacement)
            backup.unlink()
        else:
            replacement = validate(direct_channel_config(self.config))
            if replacement == self.config:
                return
            self.save_cue_sheet_snapshot(backup)
            self.apply(replacement)
        self.last_output = None

    def save_cue_sheet_snapshot(self,path):
        config=copy.deepcopy(self.config)
        config['dry_run']=True
        temporary=path.with_suffix('.tmp')
        temporary.write_text(json.dumps(config,ensure_ascii=False,indent=2),encoding='utf-8')
        temporary.replace(path)

    def restore_cue_sheet(self):
        if self.config['cue_sheet']!=STAGE_SHEET or not self.cue_sheet_backup.is_file():
            raise ValueError('No previous cue sheet to restore')
        previous=validate(json.loads(self.cue_sheet_backup.read_text(encoding='utf-8')))
        if previous['cue_sheet']!= 'legacy':raise ValueError('Saved previous cue sheet is invalid')
        previous['dry_run']=self.config['dry_run']
        # Learning new motions is independent of switching cue sheets.
        previous['custom_motions']=copy.deepcopy(self.config['custom_motions'])
        self.save_cue_sheet_snapshot(self.saved_stage_sheet)
        self.apply(previous)
        self.last_output=None

    def live_gate(self, data):
        if self.workflow_active:
            self.session_gate();return
        if self.config['dry_run']: return
        if not self.fresh(): raise ValueError('Real Eos version/show feedback required; check IP and framing')
        if not data.get('only_host'): raise ValueError('Confirm this is the only laptop controlling Eos')
        if not data.get('session_ok'): raise ValueError('Confirm the feedback identifies the intended Eos session')
        if self.pending: raise ValueError('Release pending Zoom first')

    def zoom_address(self, suffix):
        c = self.config
        return f"/eos/{c['target_type']}/{c['target']}/param/zoom/{suffix}"

    def zoom_ready(self, calibration=False):
        c = self.config
        if not c['target'] or c['zoom_min'] is None or c['zoom_max'] is None: raise ValueError('Set verified Zoom target and safe minimum/maximum')
        if calibration and (c['close'] is None or c['far'] is None): raise ValueError('Calibrate hands close and far first')

    def channel_zoom_in_use(self, target):
        if self.owned is None:
            return False
        # The bridge cannot tell which fixtures belong to an Eos group.
        group = self.config['target_type'] == 'group'
        owned_channel = str(self.config['target'])
        return any(
            row.get('zoom') is not None and (group or str(row['channel']) == owned_channel)
            for row in target.get('channels', [target])
        )

    def cue(self, mapping, source='manual'):
        target=mapping_target(mapping)
        if target is None:raise ValueError('Assign a console output first')
        return self.send_target(target,source,identity=mapping.get('id') or mapping.get('gesture'))

    def write_channel_level(self,channel,level):
        self.send(f'/eos/chan/{channel}/at',[float(level)])

    def write_channel_settings(self, target):
        channels = target.get('channels', [target])
        # Put channels going dark out first, then set optics before raising intensity.
        for row in channels:
            if row.get('level') == 0:
                self.write_channel_level(row['channel'], 0)
        for row in channels:
            channel, zoom, color = row['channel'], row.get('zoom'), row.get('color')
            if zoom is not None:
                self.send(f'/eos/chan/{channel}/param/zoom', [float(zoom)])
            if color is not None:
                rgb = [int(color[index:index + 2], 16) / 255 for index in (1, 3, 5)]
                self.send(f'/eos/chan/{channel}/color/rgb', rgb)
        for row in channels:
            if row.get('level', 0):
                self.write_channel_level(row['channel'], row['level'])

    def send_target(self,target,source='manual',*,identity=None):
        if self.cue_lane.remaining(self.clock(),self.config['cue_interval_s'])>0:return False
        try:
            if target['output_type'] in CHANNEL_OUTPUT_TYPES:
                self.write_channel_settings(target)
            else:self.send(f"/eos/cue/{target['cue_list']}/{target['cue']}/fire")
        finally:
            # Leave the full gap after a slow or uncertain TCP write too.
            self.last_cue_t=self.clock()
            self.cue_lane.sent(output_key(target),self.last_cue_t,source,identity)
        self.output_serial+=1
        self.last_output=dict(target,source=source,id=identity or target['id'],target_id=target['id'],
            kind='simulated' if self.config['dry_run'] else 'sent',
            timestamp=time.strftime('%H:%M:%S'),serial=self.output_serial)
        return True

    def cue_wait_message(self):
        wait=self.cue_lane.remaining(self.clock(),self.config['cue_interval_s'])
        return f"Wait {max(.1,wait):.1f} seconds before sending another console output."

    def manual_channel_level(self, data):
        self.check_revision(data)
        if self.armed:
            raise ValueError('Pause automatic output before changing channel settings')
        self.session_gate()
        if self.rehearsal_only or self.config['dry_run']:
            raise ValueError('Start a live console session before changing channel settings')
        if data.get('confirmed') is not True:
            raise ValueError('Confirm the channel settings before sending to Eos')
        channel, level = data.get('channel'), data.get('level')
        if isinstance(channel, bool) or not isinstance(channel, int) or not 1 <= channel <= 99999:
            raise ValueError('Enter a whole channel number from 1 to 99999')
        if level is not None and (isinstance(level, bool) or not isinstance(level, (int, float)) or not 0 <= level <= 100):
            raise ValueError('Enter a level from 0 to 100 percent')
        zoom = data.get('zoom')
        if zoom is not None and (isinstance(zoom, bool) or not isinstance(zoom, (int, float)) or not 0 <= zoom <= 100):
            raise ValueError('Enter a Zoom value from 0 to 100 percent')
        settings = validate_mapping_output(
            dict(output_type='channel_level', channel=channel, level=level, zoom=zoom, color=data.get('color')),
            required=True,
        )
        wait = self.cue_lane.remaining(self.clock(), self.config['cue_interval_s'])
        if wait > 0:
            raise ValueError(f'Wait {max(.1, wait):.1f} seconds before sending another console command')
        try:
            self.write_channel_settings(settings)
        finally:
            # A failed write might have reached the desk. Keep the gap and let
            # the operator decide whether to send another command.
            self.cue_lane.pace_after_write(self.clock())
        self.pending_test=None
        receipt = dict(channel=channel, level=level)
        for key in ('zoom', 'color'):
            if settings[key] is not None:
                receipt[key] = settings[key]
        return receipt

    def offer_cue(self,mapping,source,track=None):
        target=mapping_target(mapping)
        if target is None:return False
        now=self.clock()
        intent=CueIntent(source,mapping.get('id') or mapping['gesture'],target,
                         now,self.config_revision,self.output_epoch,self.owner,track)
        rejection=self.cue_lane.offer(intent,now,self.config['cue_interval_s'])
        if rejection:
            if source=='speech':self.speech_last_outcome=f"{output_label(target)} not sent · {rejection}"
            return False
        return self.flush_cue(camera_current=source=='camera')

    def flush_cue(self,camera_current=False):
        """Run under the bridge lock, after checking the current input and session."""
        now=self.clock()
        self.cue_lane.expire(now)
        intent=self.cue_lane.pending
        if intent is None:return False
        if (not self.armed or self.rehearsal or self.rehearsal_only or intent.revision!=self.config_revision or
                intent.epoch!=self.output_epoch or intent.owner!=self.owner):
            self.cue_lane.cancel('The output session changed.')
            return False
        if self.workflow_active and (not self.owner or now-self.last_heartbeat>1.5 or
                self.camera_required() and now-self.last_frame>1.5 or
                self.speech_required() and (not self.speech_ready or
                    not self.speech_frame_seen or now-self.speech_frame_time>1.5)):
            self.cue_lane.cancel('An input is no longer current.')
            return False
        if intent.source=='camera':
            evidence_age=STAGE_FRAME_GAP_S if self.config['cue_sheet']==STAGE_SHEET else CAMERA_EVIDENCE_MAX_AGE
            if now-self.last_frame>evidence_age:
                self.cue_lane.cancel('Camera evidence is no longer current.')
                return False
            if not camera_current:return False
            field,rows='gesture',self.config['mappings']
            active=self.camera_required() and self.config['mode']=='cue'
        elif intent.source=='gesture_debug':
            field,rows='gesture',self.config['mappings']
            active=self.camera_required() and self.config['mode']=='cue'
        elif intent.source=='motion':
            field,rows='id',self.config['custom_motions']
            active=self.camera_required() and self.config['mode']=='motion'
        else:
            field,rows='id',self.config['speech_mappings']
            active=self.speech_required() and not self.speech_wait_for_silence
        mapping=next((m for m in rows if m[field]==intent.identity and m['enabled']),None) if active else None
        target=intent.target
        if mapping is None or mapping_target(mapping)!=target:
            self.cue_lane.cancel('The output mapping changed.')
            return False
        if target['output_type'] in CHANNEL_OUTPUT_TYPES and not self.workflow_active and not self.config['dry_run']:
            self.cue_lane.cancel('Start a console session to use channel mappings.')
            return False
        if self.workflow_active:
            try:self.session_gate(allow_owned_zoom=intent.source=='speech')
            except ValueError:
                self.cue_lane.cancel('Console or show verification was lost.')
                return False
            if self.channel_zoom_in_use(target):
                self.cue_lane.cancel('Finish the two-hand Zoom adjustment before changing the beam width.')
                return False
            if not self.target_ready(target):
                self.cue_lane.cancel('This output is not confirmed on the console.')
                return False
        if self.cue_lane.remaining(now,self.config['cue_interval_s'])>0:return False
        self.cue_lane.pending=None
        try:
            if not self.send_target(target,intent.source,identity=intent.identity):return False
        except ValueError:
            self.cue_lane.record('dropped',intent,'Console write interrupted. Check the desk before trying again.')
            raise
        self.cue_lane.record('sent',intent)
        if intent.source=='speech':
            self.speech_last_fire[intent.identity]=self.last_cue_t
            self.speech_last_outcome=f"{output_label(target)} sent"
            self.log('SPEECH',mapping['phrase']+' → '+target['command'])
        elif intent.source=='motion':
            self.log('MOTION',mapping['name']+' → '+target['command'])
        elif intent.source=='gesture_debug':
            self.log('DEBUG',intent.identity+' → '+target['command']+' sent')
        return True

    def debug_gesture(self,data):
        self.check_revision(data)
        if not self.armed or self.config['dry_run'] or not self.camera_required() or self.config['mode']!='cue':
            raise ValueError('Go live with gesture input before sending a debug command')
        self.session_gate()
        gesture=data.get('gesture')
        mapping=next((item for item in self.config['mappings'] if item['gesture']==gesture and item['enabled']),None)
        if mapping is None or mapping_target(mapping) is None:
            raise ValueError('Choose an enabled gesture with a saved output')
        self.cue_lane.expire(self.clock())
        if self.cue_lane.pending:
            raise ValueError('Another output is waiting. Try again when the cue queue is clear.')
        if self.cue_lane.remaining(self.clock(),self.config['cue_interval_s'])>0:
            raise ValueError(self.cue_wait_message())
        if not self.offer_cue(mapping,'gesture_debug'):
            self.cue_lane.cancel('Debug command did not send immediately.')
            raise ValueError(self.cue_lane.status.get('reason','Gesture debug did not send'))

    def zoom(self, value):
        self.zoom_ready()
        c, now = self.config, self.clock()
        value = number(value,c['zoom_min'],c['zoom_max'],'Zoom')
        if now-self.last_zoom_t < 1/c['rate_hz']: return False
        if self.last_zoom is not None and abs(value-self.last_zoom) < c['deadband']*(c['zoom_max']-c['zoom_min']): return False
        if not c['dry_run']:
            p = dict(endpoint=self.endpoint(),address=self.zoom_address('release'))
            if p not in self.pending: self.pending.append(p); self.journal()
            self.owned = p
        else: self.dry_owned = True
        self.send(self.zoom_address('override'),[float(value)])
        self.last_zoom = value; self.last_zoom_t = now; self.last_hands = now
        return True

    def frame(self, data):
        previous_frame=self.last_frame
        if self.workflow_frame(data):return
        now, c = self.clock(), self.config
        if not self.armed: return
        if c['cue_sheet']==STAGE_SHEET and not self.workflow_active:return
        if not c['dry_run'] and not self.fresh(): self.stop('Feedback stale'); return
        if data.get('source')=='demo' and not c['dry_run']: raise ValueError('Mouse demo is Dry Run only')
        self.last_frame = now
        name = data.get('gesture','None')
        score = number(data.get('confidence',0),0,1,'Confidence')
        self.telemetry.update(gesture=name, confidence=score)
        if c['mode']=='motion':
            self.motion_frame(data.get('motion_candidate'),now)
            return
        if c['mode']=='cue':
            track=data.get('tracking_key')
            if not isinstance(track,str) or len(track)>80:track=None
            uncertain=data.get('tracking_uncertain') is True
            stage=c['cue_sheet']==STAGE_SHEET
            evidence_age=STAGE_FRAME_GAP_S if stage else CAMERA_EVIDENCE_MAX_AGE
            brief=data.get('tracking_gap')=='brief'
            within_brief_gap=(stage and self.stage_gate.last_good is not None and
                              now-self.stage_gate.last_good<=STAGE_BRIEF_GAP_S)
            self.cue_lane.observe_camera(now,lambda intent:
                now-previous_frame<=evidence_age and intent.track==track and (
                    (not uncertain and (not stage or not self.stage_gate.gap or within_brief_gap) and
                     intent.identity==name and any(m['gesture']==name and score>=m['confidence'] for m in c['mappings']))
                    or (uncertain and brief and within_brief_gap and track is not None and
                        intent.identity==self.stage_gate.candidate and track==self.stage_gate.track)))
            if stage:
                mapping=self.stage_gate.update(name,score,c['mappings'],now,uncertain,data.get('neutral_kind')=='empty',
                                               brief,track)
                self.telemetry.update(hold=self.stage_gate.progress,ready=self.stage_gate.ready)
                if mapping:
                    self.stage_gate.fired(name)
                    self.offer_cue(mapping,'camera',track)
                elif not uncertain:self.flush_cue(camera_current=True)
                self.record_camera_diagnostics(data,self.stage_gate)
                return
            gate=self.palm_gate if c['palm_from_fist'] and any(m['enabled'] and m['gesture']=='Open_Palm' for m in c['mappings']) else self.gate
            mapping = gate.update(name,score,c['mappings'],now)
            self.telemetry['hold'] = gate.progress
            self.telemetry['ready'] = gate.ready
            if mapping:self.offer_cue(mapping,'camera',track)
            else:self.flush_cue(camera_current=True)
            self.record_camera_diagnostics(data,gate)
            return
        hands = data.get('hands',[])
        if len(hands)!=2: return
        for hand in hands:
            if number(hand.get('confidence',0),0,1,'Hand confidence') < c['hand_confidence']: return
        distance = number(data.get('distance'),0,4,'Hand distance')
        self.last_hands = now
        n = max(0,min(1,(distance-c['close'])/(c['far']-c['close'])))
        if c['reverse']: n = 1-n
        self.smooth = n if self.smooth is None else c['alpha']*n+(1-c['alpha'])*self.smooth
        value = c['zoom_min']+self.smooth*(c['zoom_max']-c['zoom_min'])
        self.telemetry.update(distance=distance, normalized=n, output=value)
        self.zoom(value)

    def motion_frame(self,candidate,now):
        if candidate is not None and not isinstance(candidate,dict): raise ValueError('Invalid motion candidate')
        identity=candidate.get('id') if candidate else None
        score=number(candidate.get('similarity',0),0,1,'Motion similarity') if candidate else 0
        motion=next((m for m in self.config['custom_motions'] if m['id']==identity and m['enabled']),None)
        self.telemetry.update(motion_id=identity,motion_similarity=score,motion_name=motion['name'] if motion else None)
        if motion is None or score<motion['threshold']:
            if self.motion_miss_since is None: self.motion_miss_since=now
            if now-self.motion_miss_since>=.5:self.motion_latched=None
            return
        self.motion_miss_since=None
        if self.motion_latched==identity or now-self.motion_last_fire.get(identity,-100)<motion['cooldown_s']:return
        self.motion_last_fire[identity]=now;self.motion_latched=identity
        self.offer_cue(motion,'motion')

    def reset_speech_epoch(self):
        """Discard unfinished audio whenever permission/settings change."""
        self.speech_partial='';self.speech_last_match=None
        self.speech_frame_seen=False;self.speech_frame_time=-100
        self.speech_quiet_samples=0;self.speech_quiet_since=None;self.speech_wait_for_silence=True
        self.speech_prefix_utterance=None
        self.preview_speech_utterance=None
        self.cue_lane.cancel('Microphone input changed.','speech')
        try:self.speech_engine.reset()
        except ValueError as error:
            self.speech_ready=False;self.speech_error=str(error)

    def speech_state(self):
        setup=self.speech_engine.status()
        outcome=self.speech_last_outcome
        if outcome==SPEECH_CUE_OFFERED:
            dispatch=self.cue_lane.status
            if self.speech_last_match and dispatch.get('source')=='speech' and dispatch.get('identity')==self.speech_last_match:
                if dispatch['kind']=='waiting':
                    outcome=f"{output_label(dispatch)} waiting for console spacing"
                elif dispatch['kind']=='dropped':
                    outcome=f"{output_label(dispatch)} not sent · {dispatch['reason']}"
            elif self.speech_last_match:
                outcome='Phrase recognized · this request is no longer waiting for output'
        return dict(setup,ready=self.speech_ready,listening=self.speech_ready,stream_id=self.speech_stream,
                    partial=self.speech_partial,last_text=self.speech_last_text,last_match=self.speech_last_match,last_confidence=self.speech_last_confidence,
                    last_outcome=outcome,error=self.speech_error,
                    waiting_for_silence=bool(self.armed and self.speech_required() and self.speech_wait_for_silence))

    def set_speech_context(self):
        set_leading_command=getattr(self.speech_engine,'set_leading_command',None)
        if set_leading_command:set_leading_command(self.config['cue_sheet']==STAGE_SHEET)

    def start_speech(self):
        self.stop('Microphone started in Preview')
        self.speech_ready=False;self.speech_stream=None;self.speech_error=''
        self.set_speech_context()
        try:self.speech_engine.start(speech_recognition_phrases(self.config))
        except ValueError as error:
            self.speech_error=str(error);raise
        finally:self.last_heartbeat=self.clock()
        if self.sync_speech_recognition():self.save_profile()
        self.speech_stream=secrets.token_urlsafe(24);self.speech_sequence=0
        self.speech_ready=True;self.speech_frame_seen=False;self.speech_frame_time=-100
        self.speech_partial='';self.speech_last_text='';self.speech_last_match=None
        self.speech_last_confidence=None
        self.speech_last_outcome='Listening in Preview · no cue sent'

    def stop_speech(self,data):
        # A late cleanup from an earlier microphone must not stop its replacement.
        if not self.speech_stream or data.get('stream_id')!=self.speech_stream:return
        if self.speech_required():self.stop('Microphone stopped')
        self.speech_engine.stop();self.speech_ready=False;self.speech_frame_seen=False
        self.speech_stream=None;self.speech_partial='';self.speech_last_match=None
        self.speech_last_outcome='Microphone is off'

    def speech_audio(self,data):
        # Audio is decoded locally; client text, interim hypotheses and stale work
        # have no route to an Eos cue.
        if data.get('revision')!=self.config_revision or data.get('epoch')!=self.output_epoch:return
        if not self.speech_ready or not self.speech_stream or data.get('stream_id')!=self.speech_stream:return
        sequence=data.get('sequence')
        if isinstance(sequence,bool) or not isinstance(sequence,int) or sequence<1:raise ValueError('Invalid microphone audio sequence')
        if sequence<=self.speech_sequence:return
        encoded=data.get('pcm')
        if not isinstance(encoded,str) or not 1<=len(encoded)<=22000:raise ValueError('Invalid microphone audio size')
        try:pcm=base64.b64decode(encoded,validate=True)
        except (binascii.Error,ValueError):raise ValueError('Invalid microphone audio encoding') from None
        if len(pcm)%2 or not 320<=len(pcm)<=16000:raise ValueError('Send 10–500 ms of mono PCM16 audio at 16 kHz')
        now=self.clock()
        if self.speech_frame_seen and now-self.speech_frame_time>1.5:
            if self.armed and self.speech_required():
                self.stop('Microphone input timeout');return
            self.reset_speech_epoch()
        if self.speech_sequence and sequence!=self.speech_sequence+1:
            self.reset_speech_epoch()
        self.speech_sequence=sequence
        self.speech_frame_seen=True;self.speech_frame_time=now
        if self.armed and self.speech_required() and self.speech_wait_for_silence:
            samples=struct.unpack('<'+'h'*(len(pcm)//2),pcm)
            rms=math.sqrt(sum(value*value for value in samples)/len(samples))/32768
            quiet_audio=getattr(self.speech_engine,'quiet_audio',None)
            quiet=quiet_audio(pcm) if quiet_audio else None
            if quiet is None:quiet=rms<.008
            if quiet:
                if self.speech_quiet_since is None:self.speech_quiet_since=now
                self.speech_quiet_samples+=len(samples)
                if self.speech_quiet_samples>=8000 and now-self.speech_quiet_since>=.4:
                    self.speech_engine.reset();self.speech_wait_for_silence=False
                    self.speech_last_outcome='Ready for a fresh complete phrase'
            else:self.speech_quiet_samples=0;self.speech_quiet_since=None
            return
        try:result=self.speech_engine.feed(pcm)
        except ValueError as error:
            self.speech_error=str(error);self.speech_ready=False
            if self.armed and self.speech_required():self.stop('Speech recognition stopped')
            raise
        self.process_speech_result(result)

    def process_speech_result(self,result):
        """Internal decoder result; never exposed as a client transcript endpoint."""
        if not result.get('final'):
            self.speech_partial=str(result.get('text',''))[:240];return
        self.speech_partial=''
        text=str(result.get('text',''))[:240]
        if not text:return
        prefix_only=result.get('prefix_only') is True
        utterance=result.get('utterance')
        if isinstance(utterance,bool) or not isinstance(utterance,int) or utterance<1:utterance=None
        if utterance is not None and utterance==self.speech_prefix_utterance:
            self.speech_last_text=text
            return
        if prefix_only and utterance is None:return
        mapping=speech_match(self.config,text,prefix_only=prefix_only)
        if prefix_only and not mapping:return
        self.speech_last_text=text;self.speech_last_match=None
        score=result.get('confidence')
        self.speech_last_confidence=float(score) if isinstance(score,(int,float)) and not isinstance(score,bool) and math.isfinite(score) and 0<=score<=1 else None
        if not mapping:
            self.speech_last_outcome='No complete phrase matched · no cue sent';return
        confidence=result.get('confidence',0)
        if self.config['cue_sheet']==STAGE_SHEET and mapping['id']=='speech_command' and normalized_phrase(text).startswith('at my command '):
            confidence=result.get('leading_confidence',confidence)
            if isinstance(confidence,(int,float)) and not isinstance(confidence,bool) and math.isfinite(confidence) and 0<=confidence<=1:
                self.speech_last_confidence=float(confidence)
        if result.get('quality_ok') is False or isinstance(confidence,bool) or not isinstance(confidence,(int,float)) or not math.isfinite(confidence) or confidence<self.config['speech_confidence'] or confidence>1:
            self.speech_last_outcome=('Similar phrase heard. Say “Let there be light” and pause.' if result.get('reject_reason')=='light-ending'
                                      else 'Phrase was uncertain · no cue sent');return
        self.speech_last_match=mapping['id']
        if not self.armed:self.practice_evidence[mapping['id']]=self.clock()
        if self.workflow_active and self.speech_required() and (utterance is None or utterance!=self.preview_speech_utterance):
            self.record_stage_preview('speech',text,mapping)
            self.preview_speech_utterance=utterance
        target=mapping_target(mapping)
        output={'channel_level': 'channel level', 'channel_look': 'channel look'}.get(mapping.get('output_type'), 'cue')
        if target and ('zoom' in target or 'color' in target):
            output = 'channel change'
        if target is None:
            self.speech_last_outcome=f'Phrase recognized · {output} not assigned';return
        if not mapping['enabled']:
            self.speech_last_outcome='Phrase recognized · mapping is disabled';return
        if not self.workflow_active or not self.armed or not self.speech_required():
            self.speech_last_outcome=f'Phrase recognized in Preview · no {output} sent';return
        if self.speech_wait_for_silence:return
        try:self.session_gate(allow_owned_zoom=True)
        except ValueError:
            self.stop('Console session is not ready for speech output');return
        if self.channel_zoom_in_use(target):
            self.speech_last_outcome = 'Finish the two-hand Zoom adjustment before changing the beam width.'
            return
        if not self.target_ready(target):
            self.stop('Speech output needs its visible-result confirmation');return
        now=self.clock()
        if now-self.speech_last_fire.get(mapping['id'],-100)<self.config['speech_cooldown_s']:
            self.speech_last_outcome=f'Phrase repeated too soon · no {output} sent';return
        if prefix_only:self.speech_prefix_utterance=utterance
        self.speech_last_outcome=SPEECH_CUE_OFFERED
        self.offer_cue(mapping,'speech')

    def speech_debug(self,phrase):
        """Read-only typed lookup. It cannot represent microphone evidence."""
        if not isinstance(phrase,str) or not 1<=len(phrase.strip())<=160 or any(ord(char)<32 for char in phrase):
            raise ValueError('Type a phrase of 1–160 characters')
        normalized=normalized_phrase(phrase)
        mapping=speech_match(self.config,phrase)
        target=mapping_target(mapping) if mapping else None
        target_id=target['id'] if target else None
        blockers=[];test_blockers=[]
        if not self.speech_required():blockers.append('Camera only is selected. Choose Camera + speech or Speech only to use voice output.')
        microphone_current=self.speech_ready and self.speech_frame_seen and self.clock()-self.speech_frame_time<=1.5
        if not self.speech_ready:blockers.append('The microphone is off. Start the microphone to recognise spoken phrases.')
        elif not microphone_current:blockers.append('Waiting for current microphone audio.')
        if not mapping:test_blockers.append('No configured phrase exactly matches this text.')
        elif not target:test_blockers.append('This phrase has no output assigned.')
        elif not mapping['enabled']:test_blockers.append('This phrase mapping is disabled.')
        if not self.workflow_active:test_blockers.append('Start a session before sending a live test.')
        if not self.fresh():test_blockers.append('The console is not connected with current identity feedback.')
        if not self.session_confirmed:test_blockers.append('Confirm the intended console and show first.')
        if self.config['dry_run']:test_blockers.append('Dry Run is on. No live output can be sent.')
        if self.pending:test_blockers.append('Release the remembered Zoom override first.')
        blockers.extend(test_blockers)
        confirmed=bool(mapping and mapping['id'] not in self.needs_practice)
        if mapping and not confirmed:blockers.append('Say the phrase in microphone Preview and confirm its recognition. Typed input does not complete this check.')
        if not self.armed:blockers.append('Automatic output is paused. Go live or Resume live after completing the remaining checks.')
        pending=None
        if target_id:
            receipt=self.target_tests.get(target_id,{})
            if self.pending_test==target_id and receipt.get('revision')==self.config_revision and receipt.get('epoch')==self.output_epoch:
                pending=dict(id=target_id,revision=self.config_revision,epoch=self.output_epoch)
        return dict(normalized=normalized,match=copy.deepcopy(mapping),target=target,target_id=target_id,can_test=not test_blockers,
                    blockers=blockers,test_blockers=test_blockers,source_mode=self.config['input_source'],
                    microphone_ready=self.speech_ready,microphone_current=microphone_current,
                    recognition_confirmed=confirmed,last_text=self.speech_last_text,last_confidence=self.speech_last_confidence,
                    revision=self.config_revision,epoch=self.output_epoch,pending_test=pending)

    def test_typed_speech(self,data):
        self.check_revision(data)
        diagnostic=self.speech_debug(data.get('phrase'))
        if not diagnostic['can_test']:raise ValueError(' '.join(diagnostic['test_blockers']))
        if self.armed:self.stop('Typed phrase manual test; automatic output paused')
        self.workflow_action('test_target',dict(id=diagnostic['target_id'],
                                               revision=self.config_revision,epoch=self.output_epoch))
        self.log('DEBUG','Typed phrase manual output test. Microphone recognition checks are unchanged.')
        return dict(self.state(),speech_debug=self.speech_debug(data['phrase']))

    def tick(self):
        with self.lock:
            now = self.clock()
            if self.owner and now-self.last_heartbeat > 1.5:
                self.stop('Browser watchdog timeout'); self.owner = None
            if self.armed and self.camera_required() and now-self.last_frame > 1.5: self.stop('Camera/input watchdog timeout')
            if self.armed and self.speech_required() and (not self.speech_ready or now-self.speech_frame_time>1.5):self.stop('Microphone input watchdog timeout')
            if (self.owned or self.dry_owned) and now-self.last_hands > self.config['hand_loss_s']:
                self.release(); self.log('RELEASE','Hand/input loss timeout')
            if self.connected and now-self.ping_time >= 2:
                self.send('/eos/ping',['gesture-eos-lab'],live=True); self.ping_time = now
            if self.armed and not self.config['dry_run'] and not self.fresh(): self.stop('Eos feedback timeout')
            self.flush_cue()

    def action(self, name, data, client):
        with self.lock:
            # Automatic browser notices belong to the current operator and epoch.
            # Keep the explicit emergency Stop path separate.
            legacy_notice=name in ('stop','pause') and data.get('reason')=='Controller page hidden or closed'
            if name=='input_pause' or legacy_notice:
                current=(client==self.owner and (legacy_notice or
                         (data.get('revision')==self.config_revision and data.get('epoch')==self.output_epoch)))
                if current and (self.armed or self.owned or self.dry_owned or
                                (self.workflow_active and not self.output_paused)):
                    self.stop(str(data.get('reason','Camera input paused'))[:160])
                return self.state()
            if name in ('stop','pause'):
                self.stop(str(data.get('reason','Output paused' if name=='pause' else 'Stop Output'))[:160])
                return self.state()
            if name=='diagnostics':
                self.start_diagnostics()
                return self.state()
            if name=='speech_debug':return dict(self.state(),speech_debug=self.speech_debug(data.get('phrase')))
            if self.owner and self.owner != client: raise ValueError('Another browser tab owns control; Stop remains available')
            if name in ('session_start','start_rehearsal'):
                if not self.owner:self.owner=client
                self.last_heartbeat=self.clock()
                self.workflow_action(name,data)
            elif name=='claim':
                if self.workflow_active and self.owner is None:
                    self.speech_practice_skipped=False
                    self.session_confirmed=False;self.target_tests.clear();self.pending_test=None
                self.owner = client; self.last_heartbeat = self.clock()
            elif not self.owner: raise ValueError('Click Take control first')
            elif name=='heartbeat': self.last_heartbeat = self.clock()
            elif name=='speech_start':self.start_speech()
            elif name=='speech_stop':self.stop_speech(data)
            elif name=='speech_audio':self.speech_audio(data)
            elif name=='speech_debug_test':return self.test_typed_speech(data)
            elif name=='gesture_debug':self.debug_gesture(data)
            elif name=='manual_channel_level':
                result=self.manual_channel_level(data)
                return dict(self.state(),channel_level=result)
            elif name=='load_cue_sheet':self.check_revision(data);self.load_cue_sheet()
            elif name=='restore_cue_sheet':self.check_revision(data);self.restore_cue_sheet()
            elif name in ('load_channel_looks', 'undo_channel_looks'):
                self.check_revision(data)
                self.switch_channel_looks(restore=name == 'undo_channel_looks')
            elif self.workflow_action(name,data):pass
            elif name=='config': self.apply(data['config'])
            elif name=='connect': self.connect()
            elif name=='release':
                had_live = bool(self.pending)
                self.release()
                if had_live and not self.pending: self.release_tested = True
            elif name=='manual_cue':
                if self.armed: raise ValueError('Stop camera output before manual tests')
                self.live_gate(data)
                m = next((m for m in self.config['mappings'] if m['gesture']==data.get('gesture') and m['enabled']),None)
                if not m: raise ValueError('Mapping is disabled')
                if m.get('output_type') in CHANNEL_OUTPUT_TYPES:
                    raise ValueError('Use the console session to test this channel level or look mapping')
                if not self.cue(m):raise ValueError(self.cue_wait_message())
                if not self.config['dry_run']:self.cue_tested=True
            elif name=='manual_motion':
                if self.armed:raise ValueError('Stop camera output before manual motion cue tests')
                self.live_gate(data)
                motion=next((m for m in self.config['custom_motions'] if m['id']==data.get('id')),None)
                if not motion:raise ValueError('Unknown custom motion')
                if motion.get('output_type') in CHANNEL_OUTPUT_TYPES and not self.config['dry_run']:
                    raise ValueError('Use the console session to test this motion output')
                if not self.cue(motion):raise ValueError(self.cue_wait_message())
                if not self.config['dry_run']:
                    self.tested_motions.add(motion['id']);self.cue_tested=True
            elif name=='manual_zoom':
                if self.armed: raise ValueError('Stop camera output before manual tests')
                # An already-owned target is permitted for successive manual values.
                pending = self.pending
                if self.owned: self.pending = []
                try: self.live_gate(data)
                finally: self.pending = pending
                if self.zoom(data['value']) and not self.config['dry_run']: self.zoom_tested = True
            elif name=='arm':
                if self.workflow_active:
                    self.workflow_action('go_live',data)
                    return self.state()
                if self.config['cue_sheet']==STAGE_SHEET:
                    raise ValueError('Start a console session and complete the show cue checks first')
                self.live_gate(data)
                if (not self.config['dry_run'] and self.config['mode']=='cue' and
                        any(m['enabled'] and m.get('output_type') in CHANNEL_OUTPUT_TYPES for m in self.config['mappings'])):
                    raise ValueError('Start a console session and test mapped channel levels or looks first')
                if self.config['mode']=='motion':
                    enabled=[m for m in self.config['custom_motions'] if m['enabled']]
                    if not enabled:raise ValueError('Learn, practice and enable at least one custom motion first')
                    if not self.config['dry_run'] and any(m.get('output_type') in CHANNEL_OUTPUT_TYPES for m in enabled):
                        raise ValueError('Start a console session and test mapped motion outputs first')
                    if not self.config['dry_run'] and (not data.get('cue_ok') or any(m['id'] not in self.tested_motions for m in enabled)):
                        raise ValueError('Manually test every enabled custom motion cue and confirm its result before arming')
                if self.config['mode']=='zoom': self.zoom_ready(calibration=True)
                if self.config['mode']=='cue' and any(m['enabled'] and m['gesture']=='Arms_Open' for m in self.config['mappings']):
                    if self.config['close'] is None or self.config['far'] is None: raise ValueError('Set hands close and hands far, then apply settings before arming the open-arms trigger')
                if not self.config['dry_run']:
                    if self.config['mode']=='cue' and not (self.cue_tested and data.get('cue_ok')): raise ValueError('Complete and confirm a manual cue test first')
                    if self.config['mode']=='zoom' and not (self.zoom_tested and self.release_tested and data.get('zoom_ok')): raise ValueError('Complete and confirm manual Zoom AND explicit release first')
                self.gate = GestureGate(0); self.palm_gate=FistPalmGate(0); self.armed = True; self.last_frame = self.clock(); self.last_hands = self.clock()
                self.motion_latched=None;self.motion_miss_since=None
                self.gate.last_fire=self.last_cue_t; self.palm_gate.last_fire=self.last_cue_t
                self.log('ARM','Dry Run' if self.config['dry_run'] else 'LIVE '+self.config['mode'])
            elif name=='frame': self.frame(data)
            else: raise ValueError('Unknown action')
            compact=(name in ('frame','speech_audio') and data.get('compact') is True and
                     data.get('revision')==self.config_revision and data.get('epoch')==self.output_epoch)
            return self.state(compact=compact)

    def start_diagnostics(self):
        if self.rehearsal_only or self.rehearsal:raise ValueError('Rehearsal is isolated. Start a console session for connection checks.')
        if self.diagnostics and self.diagnostics['running']: return
        endpoint=self.endpoint()
        if not endpoint['host']: raise ValueError('Enter and apply the console Host IP first')
        self.diagnostics=dict(running=True,started_at=time.strftime('%H:%M:%S'),endpoint=endpoint,steps=[],summary='Testing connection…')
        def report(name,status,detail):
            with self.lock:
                self.diagnostics['steps'].append(dict(name=name,status=status,detail=detail))
        def run():
            try: summary=probe(endpoint,report)
            except Exception as error:
                report('Diagnostic','fail',str(error)); summary='Connection test could not complete: '+str(error)
            with self.lock:
                self.diagnostics['summary']=summary; self.diagnostics['running']=False
                self.log('DEBUG',summary)
        threading.Thread(target=run,daemon=True).start()

    def state(self,compact=False):
        speech=self.speech_state()
        self.state_serial+=1
        snapshot=dict(state_serial=self.state_serial,armed=self.armed,connected=self.connected,
            verified=self.fresh(),owner=self.owner,
            pending=copy.deepcopy(self.pending),owned=self.owned,dry_owned=self.dry_owned,
            telemetry=self.telemetry.copy(),cue_tested=self.cue_tested,build_version=BUILD_VERSION,
            zoom_tested=self.zoom_tested,release_tested=self.release_tested,
            tested_motions=sorted(self.tested_motions),workflow=self.workflow_state(speech),speech=speech,
            last_output=copy.deepcopy(self.last_output),
            stage_preview=copy.deepcopy(self.stage_preview),
            cue_dispatch=self.cue_lane.snapshot(self.clock(),self.config['cue_interval_s']))
        if compact:return dict(snapshot,compact=True)
        return dict(snapshot,config=copy.deepcopy(self.config),feedback=self.feedback.copy(),logs=list(self.logs),
            diagnostics=copy.deepcopy(self.diagnostics),cue_sheet_backup=self.config['cue_sheet']==STAGE_SHEET and self.cue_sheet_backup.is_file(),
            stage_effects=STAGE_EFFECTS.copy(),speech_aliases=speech_aliases(self.config),rehearsal_only=self.rehearsal_only,
            channel_level_supported=True,mapped_channel_levels_supported=True,fixture_parameters_supported=True,
            channel_looks_supported=True,channel_look_backup=(self.folder/'previous-channel-looks.json').is_file())

class RequestAccess:
    def __init__(self, port, shared_origin=None, proxy_key=None):
        self.local_hosts = (f'127.0.0.1:{port}', f'localhost:{port}')
        self.local_origins = tuple('http://' + host for host in self.local_hosts)
        self.shared_origin = self.shared_host = self._proxy_key = None
        if shared_origin is None:
            return

        origin_error = 'Shared origin must be an exact HTTPS origin, with no path, query or fragment'
        try:
            parsed = urlsplit(shared_origin)
            hostname, https_port = parsed.hostname, parsed.port
            if not hostname or https_port == 0:
                raise ValueError
            if ':' in hostname:
                if '%' in hostname:
                    raise ValueError
                hostname = f'[{ipaddress.IPv6Address(hostname).compressed}]'
            elif len(hostname) > 253 or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label)
                                            for label in hostname.split('.')):
                raise ValueError
            authority = hostname if https_port is None else f'{hostname}:{https_port}'
            if shared_origin != 'https://' + authority:
                raise ValueError
        except ValueError:
            raise ValueError(origin_error) from None
        shared_host = hostname if https_port in (None, 443) else authority
        if shared_host in self.local_hosts:
            raise ValueError('Shared origin must use a different host or port from the local bridge')
        if not re.fullmatch(r'[A-Za-z0-9_-]{32,256}', proxy_key or ''):
            raise ValueError('Set LIGHT_MAGIC_PROXY_KEY to a 32–256 character URL-safe secret')
        self.shared_host = shared_host
        self.shared_origin = 'https://' + shared_host
        self._proxy_key = proxy_key.encode('ascii')

    def allows(self, headers, *, post=False):
        hosts = headers.get_all('Host', [])
        if len(hosts) != 1:
            return False
        host = hosts[0]
        origins = headers.get_all('Origin', [])
        keys = headers.get_all('X-Light-Magic-Proxy-Key', [])
        if host in self.local_hosts:
            if self.shared_host and keys:
                return False
            return not post or not origins or (len(origins) == 1 and origins[0] in self.local_origins)
        if self.shared_host is None or host != self.shared_host:
            return False
        if len(keys) != 1 or not secrets.compare_digest(keys[0].encode('utf-8'), self._proxy_key):
            return False
        return origins == [self.shared_origin] or (not post and not origins)


def request_handler(controller, token, access):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def reply(self,body,code=200,mime='application/json'):
            if not isinstance(body,bytes): body = json.dumps(body,allow_nan=False).encode()
            self.send_response(code); self.send_header('Content-Type',mime)
            self.send_header('Cache-Control','no-store'); self.send_header('X-Content-Type-Options','nosniff')
            self.send_header('Content-Length',str(len(body))); self.end_headers()
            try: self.wfile.write(body)
            except (BrokenPipeError,ConnectionResetError): pass
        def do_GET(self):
            if not access.allows(self.headers): return self.reply({'error':'Access denied'},403)
            if self.path=='/api/state':
                with controller.lock: return self.reply(dict(controller.state(),token=token))
            path = (ROOT/'web'/self.path.split('?')[0].lstrip('/')).resolve()
            if self.path=='/': path = ROOT/'web'/'index.html'
            if not path.is_relative_to(ROOT/'web') or not path.is_file(): return self.reply({'error':'Not found'},404)
            mime = {'.mjs':'text/javascript','.js':'text/javascript','.wasm':'application/wasm'}.get(path.suffix) or mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
            self.reply(path.read_bytes(),mime=mime)
        def do_POST(self):
            if not access.allows(self.headers,post=True): return self.reply({'error':'Access denied'},403)
            try:
                length = int(self.headers.get('Content-Length','0'))
                if not 0 < length <= 2000000: raise ValueError('Invalid body size')
                data = json.loads(self.rfile.read(length))
                if not isinstance(data,dict):raise ValueError('Expected a JSON object')
                if data.get('token') != token: return self.reply({'error':'Invalid session token'},403)
                client = data.get('client')
                if not isinstance(client,str) or not 8 <= len(client) <= 100: raise ValueError('Invalid client')
                self.reply(controller.action(self.path.removeprefix('/api/'),data,client))
            except (ValueError,TypeError,KeyError,OSError) as error: self.reply({'error':str(error)},400)
    return Handler


def main(folder=ROOT, port=8765, rehearsal_only=False, open_browser=None, *, shared_origin=None):
    access = RequestAccess(port, shared_origin, os.environ.get('LIGHT_MAGIC_PROXY_KEY'))
    controller = Controller(folder, rehearsal_only=rehearsal_only)
    token = secrets.token_urlsafe(32)
    server = ThreadingHTTPServer(('127.0.0.1',port),request_handler(controller, token, access))
    done = threading.Event()
    def watch():
        while not done.wait(.1):
            try: controller.tick()
            except (ValueError,OSError) as e: controller.log('ERROR',str(e))
    threading.Thread(target=watch,daemon=True).start()
    def shutdown(*args): raise KeyboardInterrupt
    signal.signal(signal.SIGTERM,shutdown)
    url=f'http://127.0.0.1:{port}'
    print(f'Light Magic: {url} — '+('Rehearsal only; no console output' if rehearsal_only else 'Starts disarmed; start a rehearsal or console session'),flush=True)
    if access.shared_origin:
        print(f'Private shared browser access: {access.shared_origin} through an authenticated HTTPS proxy',flush=True)
    import sys
    should_open = open_browser if open_browser is not None else '--no-browser' not in sys.argv
    if should_open:webbrowser.open(url)
    try: server.serve_forever(poll_interval=.2)
    except KeyboardInterrupt: pass
    finally:
        done.set()
        with controller.lock:
            try: controller.stop('Bridge shutdown')
            finally: controller.transport.close(); server.server_close()

if __name__=='__main__':
    parser = argparse.ArgumentParser(description='Run the local Light Magic bridge')
    parser.add_argument('--no-browser', action='store_true', help='do not open the local controller')
    parser.add_argument('--shared-origin', metavar='HTTPS_ORIGIN', help='exact HTTPS origin of an authenticated reverse proxy')
    options = parser.parse_args()
    try:
        main(open_browser=not options.no_browser, shared_origin=options.shared_origin)
    except ValueError as error:
        parser.error(str(error))
