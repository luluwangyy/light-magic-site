"""Show cue sheet, rehearsal isolation, and safe recognition transitions."""
import copy
import base64
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from app import Controller, validate
from mapping_outputs import mapping_target
from show_profile import ANKH, FIRE, STAGE_GESTURES, STAGE_SHEET, STAGE_SPEECH, StageGestureGate
from test_speech_workflow import FakeSpeech
from test_workflow import Clock, FakeTransport


class ShowProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.clock=Clock()
        self.c=Controller(Path(self.temp.name),self.clock,FakeSpeech())
        self.c.transport=FakeTransport()
        self.action('claim')

    def tearDown(self):
        self.temp.cleanup()

    def action(self,name,**data):
        if name in ('go_live','confirm_session','test_target'):data={**self.current(),**data}
        return self.c.action(name,data,'show-profile-browser')

    def current(self):
        return dict(revision=self.c.config_revision,epoch=self.c.output_epoch)

    def load(self):
        self.action('load_cue_sheet',**self.current())

    def update(self,**kwargs):
        self.action('config',config={**copy.deepcopy(self.c.config),**kwargs})

    def console(self):
        self.action('session_start')
        self.c.receive('/eos/out/get/version',['3.3'])
        self.c.receive('/eos/out/show/name',['Simulated stage'])
        self.action('confirm_session',only_host=True,session_ok=True)

    def check_target(self,number):
        self.clock.advance(self.c.config['cue_interval_s'])
        self.action('heartbeat')
        self.c.receive('/eos/out/ping',[])
        identity='cue:1:'+number
        self.action('test_target',id=identity)
        self.action('confirm_target',id=identity,worked=True,**self.current())

    def frame(self,gesture='None',score=0,**overrides):
        self.action('heartbeat')
        payload=dict(source='camera',gesture=gesture,confidence=score,hands=[],stage_ready=True,**self.current())
        if gesture=='None':payload['neutral_kind']='observed'
        payload.update(overrides)
        self.action('frame',**payload)

    def audio(self,result=None):
        self.action('heartbeat')
        self.c.receive('/eos/out/ping',[])
        if result is not None:self.c.speech_engine.results.append(result)
        packet=bytes(6400) if result is None else b'\x00\x20'*3200
        self.action('speech_audio',pcm=base64.b64encode(packet).decode(),
                    stream_id=self.c.speech_stream,sequence=self.c.speech_sequence+1,**self.current())

    def quiet_audio(self,seconds):
        for _ in range(round(seconds/.2)):
            self.clock.advance(.2)
            self.audio()

    def test_blank_first_use_and_both_setups_survive_restart(self):
        initial=copy.deepcopy(self.c.config)
        self.load()
        c=self.c.config
        self.assertEqual(c['cue_sheet'],STAGE_SHEET)
        self.assertEqual(tuple(m['gesture'] for m in c['mappings']),STAGE_GESTURES)
        self.assertEqual(tuple((m['id'],m['phrase']) for m in c['speech_mappings']),STAGE_SPEECH)
        self.assertTrue(all(not m['cue'] and not m['enabled'] for m in c['mappings']+c['speech_mappings']))
        mappings=copy.deepcopy(c['mappings']);mappings[0].update(cue='123',enabled=True)
        self.update(mappings=mappings)
        self.c=Controller(self.temp.name,self.clock,FakeSpeech())
        self.c.transport=FakeTransport()
        self.action('claim')
        self.action('restore_cue_sheet',**self.current())
        self.assertEqual(self.c.config,initial)
        self.load()
        self.assertEqual(self.c.config['mappings'][0]['cue'],'123')
        self.assertFalse(self.c.armed)

    def test_direct_look_preset_uses_archived_show_channels_and_can_be_undone(self):
        self.update(notes='Keep my notes', input_source='speech')
        initial = copy.deepcopy(self.c.config)
        expected_channels = [*range(1, 19), 28, 30, 31, 32]

        snapshot = self.action('load_channel_looks', **self.current())
        self.assertTrue(snapshot['channel_look_backup'])
        self.assertFalse(snapshot['armed'])
        self.assertEqual(self.c.config['input_source'], 'speech')
        self.assertEqual(self.c.config['notes'], 'Keep my notes')
        gestures = {row['gesture']: row for row in self.c.config['mappings']}
        phrases = {row['id']: row for row in self.c.config['speech_mappings']}
        self.assertFalse(gestures[FIRE]['enabled'])
        self.assertTrue(all(row['enabled'] for row in phrases.values()))
        for row in [*gestures.values(), *phrases.values()]:
            target = mapping_target(row)
            self.assertEqual(target['output_type'], 'channel_look')
            self.assertEqual([fixture['channel'] for fixture in target['channels']], expected_channels)
            self.assertTrue(all('level' in fixture for fixture in target['channels']))
        blackout = mapping_target(gestures['Closed_Fist'])
        self.assertEqual(blackout, mapping_target(phrases['speech_stand_down']))
        self.assertTrue(all(fixture['level'] == 0 for fixture in blackout['channels']))

        self.action('load_channel_looks', **self.current())
        snapshot = self.action('undo_channel_looks', **self.current())
        self.assertEqual(self.c.config, initial)
        self.assertFalse(snapshot['channel_look_backup'])
        self.assertEqual(self.c.transport.sent, [])

    def test_static_fire_is_disabled_initially_but_can_be_assigned_and_enabled(self):
        self.load()
        config=copy.deepcopy(self.c.config)
        fire=next(m for m in config['mappings'] if m['gesture']==FIRE)
        fire['cue']='999'
        self.update(mappings=config['mappings'])
        self.assertIn('cue:1:999',{item['id'] for item in self.c.all_targets(False)})
        self.assertNotIn('cue:1:999',{item['id'] for item in self.c.all_targets()})
        fire['enabled']=True
        self.update(mappings=validate(config)['mappings'])
        self.assertIn('cue:1:999',{item['id'] for item in self.c.all_targets()})
        self.assertIn('pose:'+FIRE,self.c.active_recognition())
        self.assertFalse(self.c.armed)
        self.assertEqual(self.c.transport.sent,[])

    def test_rehearsal_does_not_connect_even_with_assigned_targets(self):
        self.load();self.update(input_source='speech')
        self.action('start_rehearsal')
        self.update(dry_run=False)
        self.action('speech_start')
        self.c.process_speech_result(dict(final=True,text='Stand down',confidence=.98))
        self.assertEqual(self.c.speech_last_match,'speech_stand_down')
        self.assertEqual(self.c.state()['speech']['last_outcome'],'Phrase recognized · cue not assigned')
        speech=copy.deepcopy(self.c.config['speech_mappings'])
        next(m for m in speech if m['id']=='speech_stand_down').update(cue='99',enabled=True)
        self.update(speech_mappings=speech)
        self.c.process_speech_result(dict(final=True,text='Stand down',confidence=.98))
        self.assertEqual(self.c.speech_last_outcome,'Phrase recognized in Preview · no cue sent')
        self.assertTrue(self.c.state()['workflow']['rehearsal'])
        self.assertFalse(self.c.state()['workflow']['can_go_live'])
        for action in ('connect','diagnostics','go_live'):
            with self.assertRaises(ValueError):self.action(action)
        self.assertTrue(self.c.config['dry_run'])
        self.assertEqual(self.c.transport.connections,[])
        self.assertEqual(self.c.transport.sent,[])

    def test_prefix_only_for_command_at_first_words_and_not_for_legacy(self):
        passage='At my command, American and coalition forces have mounted an attack.'
        self.assertIsNone(self.c.speech_debug(passage)['match'])
        self.load()
        for phrase in ('At my command',passage):
            self.assertEqual(self.c.speech_debug(phrase)['match']['id'],'speech_command')
        for phrase in ('It began at my command', 'At my commander', 'Let there be lights',
                       'As I speak, boots are on the ground', 'Stand down now'):
            self.assertIsNone(self.c.speech_debug(phrase)['match'])
        for phrase in ('Abracadabra','Abra Cadabra','Abra Kadabra'):
            self.assertEqual(self.c.speech_debug(phrase)['match']['id'],'speech_abracadabra')
        self.assertIsNone(self.c.speech_debug('Say Abra Kadabra again')['match'])
        self.assertFalse(self.c.practice_evidence)
        self.c.process_speech_result(dict(final=True,prefix_only=True,utterance=1,text='Stand down',confidence=.98))
        self.assertFalse(self.c.practice_evidence)
        self.c.process_speech_result(dict(final=True,prefix_only=True,utterance=1,text=passage,confidence=.98,quality_ok=False))
        self.assertFalse(self.c.practice_evidence)

    def test_early_command_and_its_final_transcript_send_at_most_one_cue(self):
        self.load();self.update(input_source='speech')
        speech=copy.deepcopy(self.c.config['speech_mappings'])
        next(m for m in speech if m['id']=='speech_command').update(cue='55',enabled=True)
        speech.append(dict(id='speech_long',phrase='At my command American and coalition forces',cue_list=1,cue='56',enabled=True))
        self.update(speech_mappings=speech)
        self.console();self.action('speech_start')
        self.check_target('55');self.check_target('56')
        self.c.needs_practice.clear()
        self.audio()
        self.action('go_live')
        self.quiet_audio(self.c.config['cue_interval_s']+.2)
        before=len(self.c.transport.sent)
        self.audio(dict(final=True,prefix_only=True,utterance=12,text='At my command American',confidence=.98))
        self.assertEqual(self.c.last_output['id'],'speech_command')
        # The final result must be deduplicated even after the pacing slot opens.
        self.quiet_audio(self.c.config['cue_interval_s']+.2)
        self.audio(dict(final=True,utterance=12,text='At my command American and coalition forces',confidence=.98))
        self.assertEqual(self.c.transport.sent[before:], [('/eos/cue/1/55/fire',[])])
        self.assertEqual(self.c.last_output['kind'],'sent')

    def test_short_aliases_match_saved_rows_without_substrings_or_ambiguity(self):
        self.assertEqual(self.c.state()['speech_aliases'], {})
        self.load()
        aliases = self.c.state()['speech_aliases']
        for identity, phrases in aliases.items():
            for phrase in phrases:
                with self.subTest(phrase=phrase):
                    self.assertEqual(self.c.speech_debug(phrase.upper() + '!')['match']['id'], identity)
                    self.assertIsNone(self.c.speech_debug('Please say ' + phrase)['match'])
        self.assertNotIn('abra cadabra', aliases['speech_abracadabra'])
        self.assertIsNone(self.c.speech_debug('Take command of the room')['match'])

        mappings = copy.deepcopy(self.c.config['speech_mappings'])
        next(row for row in mappings if row['id'] == 'speech_pass')['phrase'] = 'White lights'
        next(row for row in mappings if row['id'] == 'speech_command')['phrase'] = 'Direct the show'
        self.update(speech_mappings=mappings)
        self.assertEqual(self.c.speech_debug('white lights')['match']['id'], 'speech_pass')
        self.assertIsNone(self.c.speech_debug('take command')['match'])
        self.assertNotIn('speech_light', self.c.state()['speech_aliases'])

    def test_decoder_inventory_includes_aliases_on_start_and_phrase_change(self):
        self.load()
        with patch.object(self.c.speech_engine, 'start', wraps=self.c.speech_engine.start) as start:
            self.action('speech_start')
            [inventory] = start.call_args.args
            self.assertIn('Let there be light', inventory)
            self.assertIn('white lights', inventory)
            self.assertIn('abra kadabra', inventory)
            mappings = copy.deepcopy(self.c.config['speech_mappings'])
            mappings[0]['phrase'] = 'Illuminate the stage'
            self.update(speech_mappings=mappings)
            self.assertEqual(start.call_count, 2)
            [inventory] = start.call_args.args
            self.assertIn('Illuminate the stage', inventory)
            self.assertNotIn('white lights', inventory)

    def test_live_backup_phrase_uses_the_same_output_checks(self):
        self.load()
        mappings = copy.deepcopy(self.c.config['speech_mappings'])
        next(row for row in mappings if row['id'] == 'speech_light').update(cue='42', enabled=True)
        next(row for row in mappings if row['id'] == 'speech_pass').update(cue='43', enabled=False)
        self.update(speech_mappings=mappings, input_source='speech')
        self.console()
        self.action('speech_start')
        self.check_target('42')
        self.c.needs_practice.clear()
        self.audio()
        self.action('go_live')
        self.quiet_audio(self.c.config['cue_interval_s'] + .2)
        before = len(self.c.transport.sent)
        aliases = self.c.state()['speech_aliases']
        for text, confidence in [(aliases['speech_pass'][0], .99), (aliases['speech_abracadabra'][0], .99), ('White lights', .5)]:
            self.audio(dict(final=True, text=text, confidence=confidence))
        self.assertEqual(self.c.transport.sent[before:], [])
        self.audio(dict(final=True, text='White lights', confidence=.99))
        self.assertEqual(self.c.last_output['id'], 'speech_light')
        self.assertEqual(self.c.transport.sent[before:], [('/eos/cue/1/42/fire', [])])

    def test_ankh_requires_current_body_tracker_before_and_during_live(self):
        self.load()
        mappings=copy.deepcopy(self.c.config['mappings'])
        next(m for m in mappings if m['gesture']==ANKH).update(cue='37',enabled=True)
        self.update(input_source='camera',mappings=mappings)
        self.console();self.check_target('37')
        self.action('camera_status',ready=True,camera_id='')
        self.c.needs_practice.clear()
        self.frame(stage_ready=False)
        self.assertIn('Ankh needs body tracking',self.c.workflow_state()['reason'])
        self.frame()
        self.action('go_live')
        for _ in range(5):
            self.clock.advance(.1);self.frame()
        for _ in range(17):
            self.clock.advance(.1);self.frame(ANKH,.96)
        self.assertEqual(self.c.last_output['source'],'camera')
        self.assertEqual(self.c.last_output['cue'],'37')
        self.frame(stage_ready=False)
        self.assertFalse(self.c.armed)

    def test_compact_input_keeps_revisions_and_receipts_without_large_config(self):
        self.load();self.action('start_rehearsal')
        self.action('camera_status',ready=True,camera_id='')
        current=self.current()
        response=self.action('frame',source='camera',gesture=ANKH,confidence=.96,
                             stage_ready=True,compact=True,**current)
        self.assertTrue(response['compact'])
        self.assertNotIn('config',response)
        self.assertNotIn('logs',response)
        self.assertEqual(response['telemetry']['gesture'],ANKH)
        self.action('pause')
        stale=self.action('frame',source='camera',gesture=ANKH,confidence=.96,
                          stage_ready=True,compact=True,**current)
        self.assertNotIn('compact',stale)
        self.assertIn('config',stale)


class StageHoldTests(unittest.TestCase):
    def test_no_repeat_on_tracking_drop_and_no_hold_across_a_gap(self):
        gate=StageGestureGate()
        mappings=[dict(gesture='Open_Palm',confidence=.8,hold_s=.6,enabled=True)]
        for n in range(6):
            self.assertIsNone(gate.update('Open_Palm',.97,mappings,n*.1))
        self.assertIsNotNone(gate.update('Open_Palm',.97,mappings,.61))
        gate.fired('Open_Palm')
        for n in range(10):
            self.assertIsNone(gate.update('None',0,mappings,1+n*.1,uncertain=True))
        for n in range(12):
            self.assertIsNone(gate.update('Open_Palm',.97,mappings,2+n*.1))
        # A deliberate neutral position releases the latch, but not an old sample.
        for n in range(5):
            gate.update('None',0,mappings,4+n*.1)
        self.assertIsNone(gate.update('Open_Palm',.97,mappings,4.6))
        self.assertIsNone(gate.update('Open_Palm',.97,mappings,5.3))
