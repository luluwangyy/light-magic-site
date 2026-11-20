"""Speech-only readiness is independent of the camera and never restores permission."""
import copy
import base64
from collections import deque
from pathlib import Path
import struct
import tempfile
import unittest

from app import Controller
from test_workflow import Clock, FakeTransport


class FakeSpeech:
    def __init__(self):self.resets=0;self.started=False;self.results=deque();self.feeds=[]
    def start(self,phrases):self.started=True
    def reset(self):self.resets+=1
    def stop(self):self.started=False
    def feed(self,pcm):
        self.feeds.append(pcm)
        return self.results.popleft() if self.results else dict(final=False,text='',confidence=0,words=[])
    def status(self):return dict(available=True,started=self.started,error=None)


class SpeechWorkflowTests(unittest.TestCase):
    def setUp(self):
        scratch=Path(tempfile.gettempdir())/'light-magic-tests'
        scratch.mkdir(parents=True,exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(dir=scratch)
        self.clock=Clock();self.c=Controller(self.temp.name,self.clock)
        self.c.transport=FakeTransport();self.c.speech_engine=FakeSpeech()
        self.c.speech_ready=False;self.c.speech_frame_seen=False;self.c.speech_frame_time=-100
        self.c.config.update(input_source='speech',microphone_id='',speech_confidence=.7,speech_cooldown_s=2,
            speech_mappings=[dict(id='speech_light',phrase='there be light',cue_list=1,cue='777',enabled=True),
                             dict(id='speech_defend',phrase='This will defend',cue_list=1,cue='778',enabled=False)])
        self.c.workflow_init()

    def tearDown(self):self.temp.cleanup()
    def action(self,name,**data):
        if name in ('go_live','confirm_session','test_target'):data={**self.tokens(),**data}
        return self.c.action(name,data,'speech-workflow-browser')
    def workflow(self):return self.c.state()['workflow']
    def tokens(self):
        w=self.workflow();return dict(revision=w['revision'],epoch=w['epoch'])
    def kinds(self):return {row['kind'] for row in self.workflow()['blockers']}
    def microphone_frame(self):
        self.c.speech_ready=True;self.c.speech_frame_seen=True;self.c.speech_frame_time=self.clock()
    def camera_frame(self):
        self.c.camera_ready=True;self.c.camera_frame_seen=True;self.c.camera_frame_time=self.clock()
        self.c.last_frame=self.clock()
    def start(self):
        self.action('session_start')
        self.c.receive('/eos/out/get/version',['3.3'])
        self.c.receive('/eos/out/show/name',['Speech workflow test'])
        self.action('confirm_session',only_host=True,session_ok=True)
    def targets(self):
        for target in self.workflow()['targets']:
            self.clock.advance(self.c.config['cue_interval_s'])
            self.action('heartbeat')
            self.c.receive('/eos/out/ping',[])
            self.action('test_target',id=target['id'])
            self.action('confirm_target',id=target['id'],worked=True,**self.tokens())
    def practice(self):
        self.microphone_frame()
        for identity in list(self.c.needs_practice):
            if identity.startswith('speech_'):
                self.c.practice_evidence[identity]=self.clock()
                self.action('practice_confirm',id=identity,observed=True,**self.tokens())
    def ready(self):
        self.start();self.targets();self.practice();self.microphone_frame()
    def apply(self,**changes):
        config=copy.deepcopy(self.c.config);config.update(changes)
        return self.action('config',config=config)
    def audio(self,result=None,quiet=False,**overrides):
        if result is not None:self.c.speech_engine.results.append(result)
        pcm=bytes(6400) if quiet else struct.pack('<3200h',*([5000]*3200))
        data=dict(pcm=base64.b64encode(pcm).decode(),stream_id=self.c.speech_stream,
                  sequence=self.c.speech_sequence+1,**self.tokens())
        data.update(overrides)
        return self.action('speech_audio',**data)
    def result(self,text='there be light',confidence=.99,final=True):
        return dict(final=final,text=text,confidence=confidence,words=[])
    def live_microphone(self):
        self.start();self.action('speech_start');self.targets()
        self.audio(self.result())
        self.action('practice_confirm',id='speech_light',observed=True,**self.tokens())
        self.action('go_live')
        # Wait out the manual test with current audio, rather than a silent
        # fake-clock jump that would leave stale microphone evidence.
        for _ in range(11):
            self.clock.advance(.21);self.action('heartbeat');self.audio(quiet=True)
        self.assertFalse(self.c.speech_wait_for_silence)
    def cue_count(self):return sum(address.startswith('/eos/cue/') and address.endswith('/fire') for address,_ in self.c.transport.sent)

    def test_speech_only_can_go_live_without_camera_or_gesture_checks(self):
        self.ready()
        w=self.workflow()
        self.assertEqual(w['input_source'],'speech')
        self.assertEqual({row['id'] for row in w['targets']},{'cue:1:777'})
        self.assertFalse(self.c.camera_ready)
        self.assertTrue(w['can_go_live'])
        self.action('go_live')
        self.assertTrue(self.c.armed)
        self.assertFalse(self.c.fresh_gesture_required)

    def test_stale_go_live_cannot_rearm_after_pause(self):
        self.ready()
        old=self.tokens()
        self.action('pause')
        self.microphone_frame()
        self.assertTrue(self.workflow()['can_go_live'])
        with self.assertRaisesRegex(ValueError,'output state changed'):
            self.action('go_live',**old)
        self.assertFalse(self.c.armed)
        self.action('go_live')
        self.assertTrue(self.c.armed)

    def test_watchdog_waits_for_a_fresh_audio_packet_after_arming(self):
        self.ready()
        self.action('go_live')
        self.clock.advance(.1)
        self.c.tick()
        self.assertTrue(self.c.armed)
        self.assertFalse(self.c.speech_frame_seen)
        self.assertTrue(self.c.speech_wait_for_silence)
        self.clock.advance(1.5)
        self.action('heartbeat')
        self.c.tick()
        self.assertFalse(self.c.armed)
        self.assertIn('Microphone input watchdog timeout',self.c.pause_reason)

    def test_offline_console_does_not_block_speech_preview_start(self):
        class OfflineTransport(FakeTransport):
            def connect(self,**endpoint):raise OSError('test console is offline')
        self.c.transport=OfflineTransport()
        result=self.action('session_start')
        self.assertTrue(result['workflow']['active'])
        self.assertEqual(result['workflow']['state'],'preview')
        self.assertIn('connect',self.kinds())
        self.assertFalse(result['workflow']['session_confirmed'])
        self.assertFalse(result['armed'])
        self.assertFalse(result['verified'])
        self.action('speech_start');self.audio(self.result())
        self.assertTrue(self.c.speech_ready)
        self.assertEqual(self.c.speech_last_match,'speech_light')
        self.assertEqual(self.cue_count(),0)
        with self.assertRaises(ValueError):self.action('go_live')
        with self.assertRaises(ValueError):self.action('test_target',id='cue:1:777')

    def test_missing_console_address_leaves_read_only_preview_available(self):
        self.c.config['host']=''
        result=self.action('session_start')
        self.assertEqual(result['workflow']['state'],'preview')
        self.assertFalse(result['connected'])
        self.assertFalse(result['workflow']['session_confirmed'])
        self.assertFalse(result['workflow']['can_go_live'])

    def test_camera_only_ignores_speech_targets_and_microphone_readiness(self):
        self.c.config['input_source']='camera'
        self.start()
        self.assertTrue(self.c.camera_required());self.assertFalse(self.c.speech_required())
        self.assertNotIn('start_microphone',self.kinds())
        self.assertNotIn('cue:1:777',{row['id'] for row in self.workflow()['targets']})
        self.assertNotIn('speech_light',self.c.active_recognition())

    def test_both_requires_fresh_camera_and_microphone(self):
        self.c.config['input_source']='both';self.start()
        self.assertIn('start_camera',self.kinds());self.assertIn('start_microphone',self.kinds())
        self.camera_frame();self.c.speech_ready=True
        self.assertNotIn('start_camera',self.kinds());self.assertIn('microphone',self.kinds())
        self.microphone_frame()
        self.assertFalse({'start_camera','camera','start_microphone','microphone'}&self.kinds())
        self.clock.advance(1.6)
        self.assertIn('camera',self.kinds());self.assertIn('microphone',self.kinds())

    def test_unassigned_phrases_can_preview_but_cannot_enable_live(self):
        self.c.config['speech_mappings'][0]['cue']=''
        self.c.config['speech_mappings'][0]['enabled']=False
        self.start();self.practice();self.microphone_frame()
        self.assertEqual(self.workflow()['targets'],[])
        self.assertTrue(any(row['kind']=='settings' and 'speech cue' in row['message'] for row in self.workflow()['blockers']))
        with self.assertRaises(ValueError):self.action('go_live')

    def test_speech_confirmation_needs_current_mic_not_camera(self):
        self.start();self.camera_frame()
        self.c.practice_evidence['speech_light']=self.clock()
        with self.assertRaises(ValueError):self.action('practice_confirm',id='speech_light',observed=True,**self.tokens())
        self.microphone_frame()
        self.action('practice_confirm',id='speech_light',observed=True,**self.tokens())
        self.assertNotIn('speech_light',self.c.needs_practice)
        self.c.needs_practice.add('speech_light');self.clock.advance(1.6)
        self.camera_frame()
        with self.assertRaises(ValueError):self.action('practice_confirm',id='speech_light',observed=True,**self.tokens())

    def test_speech_only_discards_camera_frames(self):
        self.ready();self.action('go_live')
        before=len(self.c.transport.sent)
        self.action('frame',source='camera',gesture='Closed_Fist',confidence=.99,hands=[],**self.tokens())
        self.assertFalse(self.c.camera_frame_seen)
        self.assertEqual(len(self.c.transport.sent),before)

    def test_stop_resets_decoder_and_freshness_without_releasing_microphone(self):
        self.ready();old=self.tokens();resets=self.c.speech_engine.resets
        self.action('pause')
        self.assertTrue(self.c.speech_ready)
        self.assertFalse(self.c.speech_frame_seen)
        self.assertGreater(self.c.speech_engine.resets,resets)
        self.assertGreater(self.tokens()['epoch'],old['epoch'])
        with self.assertRaises(ValueError):self.action('go_live')

    def test_phrase_change_rechecks_only_changed_recognition_and_preserves_cues(self):
        self.c.config['speech_mappings'][1]['enabled']=True
        self.ready();config=copy.deepcopy(self.c.config)
        config['speech_mappings'][0]['phrase']='Let there be light'
        self.action('config',config=config)
        self.assertIn('speech_light',self.c.needs_practice)
        self.assertNotIn('speech_defend',self.c.needs_practice)
        self.assertTrue(all(row['confirmed'] for row in self.workflow()['targets']))

    def test_speech_practice_skip_survives_a_gesture_cue_edit(self):
        self.start()
        self.c.needs_practice.add('speech_light')
        self.action('skip_speech_practice', **self.tokens())
        mappings = copy.deepcopy(self.c.config['mappings'])
        mappings[0]['cue'] = '801'
        self.apply(mappings=mappings)
        self.assertTrue(self.workflow()['speech_practice_skipped'])
        self.assertNotIn('practice', self.kinds())
        self.apply(speech_confidence=.8)
        self.assertFalse(self.workflow()['speech_practice_skipped'])
        self.assertIn('practice', self.kinds())

    def test_destination_change_preserves_speech_practice_and_other_cue(self):
        self.c.config['speech_mappings'][1]['enabled']=True
        self.ready();config=copy.deepcopy(self.c.config)
        config['speech_mappings'][0]['cue']='779'
        self.action('config',config=config)
        self.assertFalse(self.c.needs_practice)
        targets={row['id']:row for row in self.workflow()['targets']}
        self.assertFalse(targets['cue:1:779']['confirmed'])
        self.assertTrue(targets['cue:1:778']['confirmed'])

    def test_microphone_change_rechecks_speech_only(self):
        self.ready();self.c.needs_practice.clear()
        self.apply(microphone_id='usb-mic')
        self.assertEqual(self.c.needs_practice,{'speech_light','speech_defend'})
        self.assertFalse(self.c.speech_ready)
        self.assertFalse(self.c.speech_frame_seen)
        self.assertTrue(all(row['confirmed'] for row in self.workflow()['targets']))

    def test_inactive_microphone_selection_preserves_live_camera_output(self):
        self.c.config['input_source']='camera';self.c.needs_practice.clear()
        self.start();self.targets();self.camera_frame();self.action('go_live')
        before=self.tokens()
        self.apply(microphone_id='preview-only-mic')
        self.assertTrue(self.c.armed)
        self.assertEqual(self.tokens(),before)
        self.assertTrue(all(row['confirmed'] for row in self.workflow()['targets']))
        self.assertFalse(any(key.startswith('pose:') for key in self.c.needs_practice))

    def test_speech_confidence_change_does_not_recheck_camera_recognition(self):
        self.ready();self.c.needs_practice.clear()
        self.apply(speech_confidence=.8)
        self.assertEqual(self.c.needs_practice,{'speech_light','speech_defend'})
        self.assertTrue(all(row['confirmed'] for row in self.workflow()['targets']))

    def test_camera_change_does_not_invalidate_speech_practice(self):
        self.ready();self.c.needs_practice.clear()
        self.apply(camera_id='another-camera')
        self.assertFalse(any(key.startswith('speech_') for key in self.c.needs_practice))

    def test_speech_only_zoom_explains_camera_requirement(self):
        self.c.config['mode']='zoom';self.start();self.microphone_frame()
        self.assertTrue(any(row['kind']=='settings' and 'Speech-only' in row['message'] for row in self.workflow()['blockers']))
        self.assertFalse(self.workflow()['can_go_live'])

    def test_restart_preserves_phrases_without_microphone_or_live_permission(self):
        self.ready();self.c.save_profile()
        restored=Controller(self.temp.name,self.clock)
        self.assertEqual(restored.config['input_source'],'speech')
        self.assertEqual(restored.config['speech_mappings'][0]['phrase'],'there be light')
        self.assertFalse(restored.armed)
        self.assertFalse(restored.workflow_active)
        self.assertFalse(restored.workflow_state()['microphone_ready'])

    def test_partial_text_does_not_fire_but_complete_phrase_does(self):
        self.live_microphone();before=self.cue_count()
        self.audio(self.result(final=False))
        self.assertEqual(self.cue_count(),before)
        self.assertEqual(self.c.speech_partial,'there be light')
        self.audio(self.result())
        self.assertEqual(self.cue_count(),before+1)
        self.audio(self.result())
        self.assertEqual(self.cue_count(),before+1,'duplicate recognized phrase is suppressed by cooldown')

    def test_unmapped_phrase_preview_creates_recognition_evidence_without_output(self):
        self.c.config['speech_mappings'][0].update(cue='',enabled=False)
        self.start();self.action('speech_start')
        self.audio(self.result())
        self.assertIn('speech_light',self.c.practice_evidence)
        self.assertEqual(self.c.speech_last_match,'speech_light')
        self.assertEqual(self.cue_count(),0)
        self.assertIn('not assigned',self.c.speech_last_outcome)

    def test_unrelated_substring_or_uncertain_phrase_never_fires(self):
        self.live_microphone();before=self.cue_count()
        for result in (self.result('well there be light'),self.result('let there be light'),self.result(confidence=.69)):
            self.audio(result)
        self.assertEqual(self.cue_count(),before)

    def test_stale_epoch_wrong_stream_and_duplicate_sequence_cannot_decode(self):
        self.live_microphone();before=self.cue_count();feeds=len(self.c.speech_engine.feeds)
        self.audio(epoch=self.c.output_epoch-1)
        self.audio(stream_id='previous-microphone-stream')
        self.audio(sequence=self.c.speech_sequence)
        self.assertEqual(len(self.c.speech_engine.feeds),feeds)
        self.assertEqual(self.cue_count(),before)

    def test_audio_gap_discards_partial_decoder_and_requires_new_silence(self):
        self.live_microphone();before=self.cue_count();feeds=len(self.c.speech_engine.feeds);resets=self.c.speech_engine.resets
        self.audio(sequence=self.c.speech_sequence+2)
        self.assertGreater(self.c.speech_engine.resets,resets)
        self.assertTrue(self.c.speech_wait_for_silence)
        self.assertEqual(len(self.c.speech_engine.feeds),feeds)
        self.assertEqual(self.cue_count(),before)

    def test_noise_on_resume_cannot_supply_pre_pause_phrase(self):
        self.live_microphone();old=self.tokens();self.action('pause');self.audio()
        self.action('go_live');before=self.cue_count();feeds=len(self.c.speech_engine.feeds)
        self.audio(epoch=old['epoch'])
        self.audio()
        self.assertTrue(self.c.speech_wait_for_silence)
        self.assertEqual(len(self.c.speech_engine.feeds),feeds)
        self.assertEqual(self.cue_count(),before)

    def test_speech_only_watchdog_accepts_mic_without_camera_and_pauses_on_mic_loss(self):
        self.live_microphone()
        for _ in range(5):
            self.clock.advance(.6);self.action('heartbeat');self.c.receive('/eos/out/ping',[])
            self.audio();self.c.tick()
            self.assertTrue(self.c.armed,'speech-only must not depend on camera frames')
        self.clock.advance(1.6);self.action('heartbeat');self.c.receive('/eos/out/ping',[]);self.c.tick()
        self.assertFalse(self.c.armed)
        self.assertTrue(self.c.speech_ready,'watchdog pauses output while preserving the microphone')

    def test_client_transcript_is_not_an_output_endpoint(self):
        self.start()
        with self.assertRaises(ValueError):self.action('speech_result',text='there be light',final=True,confidence=1)
        self.assertEqual(self.cue_count(),0)

    def test_invalid_audio_does_not_refresh_microphone_freshness(self):
        self.start();self.action('speech_start')
        for encoded in ('not base64!',base64.b64encode(b'odd').decode(),base64.b64encode(bytes(2)).decode()):
            with self.assertRaises(ValueError):self.audio(pcm=encoded)
        self.assertFalse(self.c.speech_frame_seen)


if __name__=='__main__':unittest.main()
