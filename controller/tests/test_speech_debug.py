"""Typed speech diagnosis and manual cue tests cannot impersonate microphone input."""
import copy
from pathlib import Path
import tempfile
import unittest

from app import Controller
from test_speech_workflow import FakeSpeech
from test_workflow import Clock, FakeTransport


class SpeechDebugTests(unittest.TestCase):
    def setUp(self):
        scratch=Path(tempfile.gettempdir())/'light-magic-tests'
        scratch.mkdir(parents=True,exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(dir=scratch)
        self.clock=Clock();self.c=Controller(self.temp.name,self.clock,speech_engine=FakeSpeech())
        self.c.transport=FakeTransport()
        light=next(row for row in self.c.config['speech_mappings'] if row['id']=='speech_light')
        light.update(cue_list=1,cue='320',enabled=True)
        self.c.config['input_source']='camera'
        self.c.speech_last_text='Previous microphone phrase'
        self.c.speech_last_confidence=.81

    def tearDown(self):self.temp.cleanup()
    def action(self,name,**data):
        if name in ('confirm_session','test_target'):data={**self.tokens(),**data}
        return self.c.action(name,data,'speech-debug-browser')
    def tokens(self):
        workflow=self.c.workflow_state()
        return dict(revision=workflow['revision'],epoch=workflow['epoch'])
    def diagnosis(self,phrase='there be light'):
        return self.action('speech_debug',phrase=phrase)['speech_debug']
    def send_test_cue(self,phrase='there be light',**overrides):
        data=dict(phrase=phrase,**self.tokens());data.update(overrides)
        return self.action('speech_debug_test',**data)
    def cue_packets(self):
        return [(address,args) for address,args in self.c.transport.sent
                if address.startswith('/eos/cue/') and address.endswith('/fire')]
    def session(self,confirm=True,identity=True):
        self.action('session_start')
        if identity:
            self.c.receive('/eos/out/get/version',['3.3'])
            self.c.receive('/eos/out/show/name',['Typed speech debug test'])
        if confirm:self.action('confirm_session',only_host=True,session_ok=True)
    def microphone_state(self):
        return copy.deepcopy(dict(text=self.c.speech_last_text,confidence=self.c.speech_last_confidence,
            evidence=self.c.practice_evidence,practice=self.c.needs_practice,
            last_fire=self.c.speech_last_fire,partial=self.c.speech_partial))

    def test_diagnosis_is_read_only_without_owner_or_session(self):
        before=self.microphone_state();epoch=self.c.output_epoch;logs=list(self.c.logs)
        diagnosis=self.diagnosis('  THERE, be light!!!  ')
        self.assertEqual(diagnosis['normalized'],'there be light')
        self.assertEqual(diagnosis['match']['id'],'speech_light')
        self.assertEqual(diagnosis['match']['cue'],'320')
        self.assertEqual(diagnosis['source_mode'],'camera')
        self.assertFalse(diagnosis['microphone_ready'])
        self.assertFalse(diagnosis['recognition_confirmed'])
        self.assertFalse(diagnosis['can_test'])
        self.assertTrue(any('camera' in blocker.casefold() for blocker in diagnosis['blockers']))
        self.assertTrue(any('microphone' in blocker.casefold() for blocker in diagnosis['blockers']))
        self.assertIsNone(self.c.owner)
        self.assertFalse(self.c.workflow_active)
        self.assertFalse(self.c.armed)
        self.assertEqual(self.c.output_epoch,epoch)
        self.assertEqual(list(self.c.logs),logs)
        self.assertEqual(self.microphone_state(),before)
        self.assertEqual(self.cue_packets(),[])

    def test_diagnosis_can_read_while_another_browser_owns_control(self):
        self.c.owner='another-browser'
        diagnosis=self.diagnosis()
        self.assertEqual(diagnosis['match']['id'],'speech_light')
        self.assertEqual(self.c.owner,'another-browser')
        with self.assertRaises(ValueError):self.send_test_cue()
        self.assertEqual(self.cue_packets(),[])

    def test_diagnosis_does_not_accept_substrings_or_unknown_phrases(self):
        for phrase in ('there be','light','let there be light','there be light please','unconfigured magic words'):
            with self.subTest(phrase=phrase):
                diagnosis=self.diagnosis(phrase)
                self.assertIsNone(diagnosis['match'])
                self.assertFalse(diagnosis['can_test'])
        self.assertEqual(self.cue_packets(),[])

    def test_empty_or_invalid_typed_input_is_rejected_without_mutation(self):
        before=self.microphone_state()
        for phrase in ('',None,42,'x'*161):
            with self.subTest(phrase=phrase),self.assertRaises(ValueError):self.diagnosis(phrase)
        self.assertEqual(self.microphone_state(),before)
        self.assertIsNone(self.c.owner)
        self.assertEqual(self.cue_packets(),[])

    def test_camera_only_diagnosis_separates_manual_test_from_speech_readiness(self):
        self.session();diagnosis=self.diagnosis()
        self.assertEqual(diagnosis['source_mode'],'camera')
        self.assertFalse(diagnosis['microphone_ready'])
        self.assertFalse(diagnosis['recognition_confirmed'])
        self.assertTrue(diagnosis['can_test'],'an explicit manual cue test must not require a microphone')
        self.assertEqual(diagnosis['last_text'],'Previous microphone phrase')
        self.assertEqual(diagnosis['last_confidence'],.81)
        self.assertEqual(diagnosis['revision'],self.c.config_revision)
        self.assertEqual(diagnosis['epoch'],self.c.output_epoch)
        self.assertEqual(self.cue_packets(),[])

    def test_typed_test_requires_owner_and_confirmed_console_identity(self):
        with self.assertRaises(ValueError):self.send_test_cue()
        self.action('claim')
        with self.assertRaises(ValueError):self.send_test_cue()
        self.session(confirm=False,identity=False)
        with self.assertRaises(ValueError):self.send_test_cue()
        self.c.receive('/eos/out/get/version',['3.3'])
        with self.assertRaises(ValueError):self.send_test_cue()
        self.c.receive('/eos/out/show/name',['Typed speech debug test'])
        with self.assertRaises(ValueError):self.send_test_cue()
        self.action('confirm_session',only_host=True,session_ok=True)
        self.send_test_cue()
        self.assertEqual(self.cue_packets(),[('/eos/cue/1/320/fire',[])])

    def test_typed_test_rejects_stale_revision_or_epoch_before_transmission(self):
        self.session()
        for key in ('revision','epoch'):
            with self.subTest(stale=key),self.assertRaises(ValueError):
                self.send_test_cue(**{key:self.tokens()[key]-1})
        self.assertEqual(self.cue_packets(),[])

    def test_typed_test_requires_enabled_mapping_with_assigned_cue(self):
        self.session()
        row=next(row for row in self.c.config['speech_mappings'] if row['id']=='speech_light')
        row['enabled']=False
        self.assertFalse(self.diagnosis()['can_test'])
        with self.assertRaises(ValueError):self.send_test_cue()
        row['cue']=''
        self.assertFalse(self.diagnosis()['can_test'])
        with self.assertRaises(ValueError):self.send_test_cue()
        self.assertEqual(self.cue_packets(),[])

    def test_typed_test_rejects_unknown_phrase_and_cannot_override_destination(self):
        self.session()
        with self.assertRaises(ValueError):self.send_test_cue('there be light please')
        self.send_test_cue(cue='999',cue_list=9,id='cue:9:999')
        self.assertEqual(self.cue_packets(),[('/eos/cue/1/320/fire',[])])

    def test_typed_channel_test_uses_saved_destination_and_needs_visible_confirmation(self):
        self.session()
        light=next(row for row in self.c.config['speech_mappings'] if row['id']=='speech_light')
        light.update(output_type='channel_level',channel=9,level=30.5)
        diagnosis=self.diagnosis()
        target=diagnosis['target']
        self.assertEqual(target['command'],'Chan 9 @ 30.5')
        self.assertEqual(diagnosis['match']['id'],'speech_light')
        self.send_test_cue(channel=99,level=100)
        self.assertEqual(self.c.transport.sent[-1],('/eos/chan/9/at',[30.5]))
        self.assertEqual(self.diagnosis()['pending_test'],dict(id=target['id'],**self.tokens()))
        self.assertFalse(self.c.target_tests[target['id']]['confirmed'])
        self.action('confirm_target',id=target['id'],worked=True,**self.tokens())
        self.assertTrue(self.c.target_tests[target['id']]['confirmed'])
        self.assertIn('speech_light',self.c.needs_practice)

    def test_typed_test_rejects_simulation_and_unavailable_console(self):
        self.session();self.c.config['dry_run']=True
        self.assertFalse(self.diagnosis()['can_test'])
        with self.assertRaises(ValueError):self.send_test_cue()
        self.c.config['dry_run']=False;self.c.connected=False
        self.assertFalse(self.diagnosis()['can_test'])
        with self.assertRaises(ValueError):self.send_test_cue()
        self.assertEqual(self.cue_packets(),[])

    def test_typed_test_respects_existing_manual_cue_rate_limit(self):
        self.session();self.send_test_cue()
        with self.assertRaises(ValueError):self.send_test_cue()
        self.assertEqual(len(self.cue_packets()),1)
        self.assertFalse(self.c.target_tests['cue:1:320']['confirmed'])

    def test_transmission_requires_separate_visible_result_confirmation(self):
        self.session();before=self.microphone_state()
        self.send_test_cue('THERE BE LIGHT!')
        self.assertFalse(self.c.target_tests['cue:1:320']['confirmed'])
        diagnosis=self.diagnosis()
        self.assertEqual(diagnosis['pending_test'],dict(id='cue:1:320',**self.tokens()))
        self.assertFalse(diagnosis['recognition_confirmed'])
        self.assertFalse(self.c.armed)
        self.action('confirm_target',id='cue:1:320',worked=True,**self.tokens())
        self.assertTrue(self.c.target_tests['cue:1:320']['confirmed'])
        self.assertIsNone(self.diagnosis()['pending_test'])
        self.assertEqual(self.microphone_state(),before)
        self.assertFalse(self.c.armed)
        self.assertEqual(len(self.c.speech_engine.feeds),0)

    def test_actual_recognition_confirmation_is_reported_separately(self):
        self.session();self.c.speech_ready=True;self.c.speech_frame_seen=True;self.c.speech_frame_time=self.clock()
        self.c.practice_evidence['speech_light']=self.clock()
        self.action('practice_confirm',id='speech_light',observed=True,**self.tokens())
        before=self.microphone_state();diagnosis=self.diagnosis()
        self.assertTrue(diagnosis['recognition_confirmed'])
        self.assertEqual(self.microphone_state(),before)
        self.assertEqual(self.cue_packets(),[])

    def test_pending_confirmation_cannot_survive_output_epoch_change(self):
        self.session();self.send_test_cue()
        self.assertIsNotNone(self.diagnosis()['pending_test'])
        self.action('pause')
        self.assertIsNone(self.diagnosis()['pending_test'])
        with self.assertRaises(ValueError):
            self.action('confirm_target',id='cue:1:320',worked=True,**self.tokens())
        self.assertFalse(self.c.target_tests['cue:1:320']['confirmed'])

    def test_typed_manual_test_pauses_live_output_without_arming_speech(self):
        self.session()
        for target in self.c.workflow_state()['targets']:
            self.clock.advance(self.c.config['cue_interval_s'])
            self.action('heartbeat')
            self.c.receive('/eos/out/ping',[])
            self.action('test_target',id=target['id'])
            self.action('confirm_target',id=target['id'],worked=True,**self.tokens())
        self.c.camera_ready=True;self.c.camera_frame_seen=True;self.c.camera_frame_time=self.clock()
        self.c.last_frame=self.clock();self.action('go_live',**self.tokens())
        self.assertTrue(self.c.armed)
        epoch=self.c.output_epoch;before=self.microphone_state()
        self.clock.advance(self.c.config['cue_interval_s'])
        self.action('heartbeat')
        self.c.receive('/eos/out/ping',[])
        self.send_test_cue()
        self.assertFalse(self.c.armed)
        self.assertGreater(self.c.output_epoch,epoch)
        self.assertEqual(self.c.config['input_source'],'camera')
        self.assertFalse(self.c.speech_ready)
        self.assertIn('speech_light',self.c.needs_practice)
        self.assertEqual(self.c.speech_last_text,before['text'])
        self.assertEqual(self.c.speech_last_confidence,before['confidence'])
        self.assertFalse(self.c.target_tests['cue:1:320']['confirmed'])


if __name__=='__main__':unittest.main()
