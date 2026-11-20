"""Recognized rehearsal mappings resolve locally without console dispatch."""
import base64
import copy
import tempfile
import unittest

from app import Controller
from show_profile import stage_config
from test_custom_motions import motion
from test_speech_workflow import FakeSpeech
from test_workflow import Clock, FakeTransport


class StagePreviewTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.clock = Clock()
        self.speech = FakeSpeech()
        self.controller = Controller(self.folder.name, self.clock, self.speech)
        self.transport = FakeTransport()
        self.controller.transport = self.transport

    def action(self, name, **data):
        return self.controller.action(name, data, 'preview-owner')

    def tokens(self):
        return dict(revision=self.controller.config_revision, epoch=self.controller.output_epoch)

    def frame(self, gesture='None', confidence=0, **overrides):
        data = dict(source='camera', gesture=gesture, confidence=confidence, hands=[], compact=True, **self.tokens())
        return self.action('frame', **(data | overrides))

    def hold(self, gesture, confidence=.99, **data):
        for _ in range(10):
            self.clock.advance(.1)
            result = self.frame(gesture, confidence, **data)
        return result

    def audio(self, text, confidence=.99, **result):
        self.speech.results.append(dict(final=True, text=text, confidence=confidence) | result)
        return self.action('speech_audio', stream_id=self.controller.speech_stream,
                           sequence=self.controller.speech_sequence + 1,
                           pcm=base64.b64encode(bytes(640)).decode(), compact=True, **self.tokens())

    def start_camera(self):
        self.action('start_rehearsal')
        self.action('camera_status', ready=True)

    def assert_no_console_output(self, state):
        self.assertEqual(self.transport.sent, [])
        self.assertEqual(self.transport.connections, [])
        self.assertIsNone(state['last_output'])
        self.assertEqual(state['workflow']['confirmed_target_ids'], [])
        self.assertFalse(state['armed'])

    def test_manual_rehearsal_demo_resolves_gesture_and_voice_without_input_evidence(self):
        self.action('start_rehearsal')
        config=stage_config(self.controller.config)
        palm=next(row for row in config['mappings'] if row['gesture']=='Open_Palm')
        palm.update(cue='14',enabled=True)
        speech=next(row for row in config['speech_mappings'] if row['id']=='speech_light')
        speech.update(cue='15',enabled=True)
        fire=next(row for row in config['mappings'] if row['gesture']=='Fire_Gesture')
        fire.update(cue='16',enabled=False)
        self.action('config',config=config)
        for request,expected in (
            (dict(source='camera',gesture='Open_Palm'),'14'),
            (dict(source='speech',id='speech_light'),'15'),
            (dict(source='camera',gesture='Fire_Gesture'),'16'),
        ):
            state=self.action('rehearsal_trigger',**request,**self.tokens())
            self.assertEqual(state['stage_preview']['source'],'demo')
            self.assertEqual(state['stage_preview']['target']['cue'],expected)
            self.assertFalse(self.controller.practice_evidence)
            self.assertFalse(self.controller.camera_frame_seen)
            self.assertFalse(self.controller.speech_frame_seen)
            self.assert_no_console_output(state)

    def test_rehearsal_demo_rejects_stale_unknown_and_console_session_requests(self):
        self.action('start_rehearsal')
        stale=self.tokens()
        self.action('pause')
        with self.assertRaisesRegex(ValueError,'output state changed'):
            self.action('rehearsal_trigger',source='camera',gesture='Open_Palm',**stale)
        with self.assertRaisesRegex(ValueError,'Assign an output'):
            self.action('rehearsal_trigger',source='camera',gesture='Unknown',**self.tokens())
        with self.assertRaisesRegex(ValueError,'gesture or speech'):
            self.action('rehearsal_trigger',source='motion',**self.tokens())
        self.controller.rehearsal=False
        with self.assertRaisesRegex(ValueError,'local rehearsal'):
            self.action('rehearsal_trigger',source='camera',gesture='Open_Palm',**self.tokens())
        self.assert_no_console_output(self.controller.state())

    def test_slow_fist_previews_then_sends_blackout_only_when_live(self):
        c = self.controller
        config = stage_config(c.config)
        config['input_source'] = 'camera'
        channels = [*range(1, 19), 28, 30, 31, 32]
        fist = next(row for row in config['mappings'] if row['gesture'] == 'Closed_Fist')
        fist.update(enabled=True, output_type='channel_look',
                    channels=[dict(channel=channel, level=0) for channel in channels])
        self.action('session_start')
        self.action('config', config=config | {'dry_run': False})
        self.action('camera_status', ready=True)
        self.transport.sent.clear()
        for _ in range(3):
            self.clock.advance(.4)
            state = self.frame('Closed_Fist', .96, stage_ready=True, tracking_key='hand:1')
        self.assertEqual(state['stage_preview']['input'], 'Fist')
        self.assertEqual(state['stage_preview']['target']['channels'], fist['channels'])
        self.assertEqual(self.transport.sent, [])

        c.connected = c.verified = c.session_confirmed = True
        c.feedback_time = c.last_heartbeat = self.clock()
        c.console_identity = {'version': '3.3', 'show_name': 'Mock Eos'}
        self.action('skip_look_tests', **self.tokens())
        c.needs_practice.clear()
        self.action('go_live', **self.tokens())
        for _ in range(2):
            self.clock.advance(.4)
            self.frame(stage_ready=True, neutral_kind='arms-down')
        for _ in range(4):
            self.clock.advance(.4)
            self.action('heartbeat')
            state = self.frame('Closed_Fist', .96, stage_ready=True, tracking_key='hand:1')
        self.assertEqual(state['last_output']['source'], 'camera')
        self.assertEqual(state['last_output']['kind'], 'sent')
        self.assertEqual(self.transport.sent, [(f'/eos/chan/{channel}/at', [0.0]) for channel in channels])

    def test_held_pose_resolves_channel_level_once_and_repeats_after_neutral(self):
        config = copy.deepcopy(self.controller.config)
        palm = next(row for row in config['mappings'] if row['gesture'] == 'Open_Palm')
        palm.update(output_type='channel_level', channel=28, level=0)
        self.action('start_rehearsal')
        self.action('config', config=config)
        self.action('camera_status', ready=True)
        self.assertIsNone(self.frame('Open_Palm', .99)['stage_preview'])

        state = self.hold('Open_Palm')
        event = state['stage_preview']
        self.assertTrue(state['compact'])
        self.assertEqual(event, dict(serial=1, source='camera', input='Open palm',
                                     target=dict(output_type='channel_level', channel=28, level=0)))
        self.assertEqual(self.controller.state()['stage_preview'], event)
        self.assertEqual(self.hold('Open_Palm')['stage_preview'], event)
        self.hold('None', 0)
        self.assertEqual(self.hold('Open_Palm')['stage_preview']['serial'], 2)
        self.assert_no_console_output(state)

    def test_late_and_demo_frames_cannot_restore_preview_after_pause(self):
        self.start_camera()
        event = self.hold('Closed_Fist')['stage_preview']
        self.assertEqual(event['target'], dict(output_type='cue', cue_list=1, cue='888'))
        stale = self.tokens()
        self.assertIsNone(self.action('pause')['stage_preview'])
        self.assertIsNone(self.hold('Closed_Fist', **stale)['stage_preview'])
        self.assertIsNone(self.hold('Closed_Fist', source='demo')['stage_preview'])
        self.assertIsNotNone(self.hold('Closed_Fist')['stage_preview'])
        config = copy.deepcopy(self.controller.config)
        config['cue_interval_s'] += 1
        self.assertIsNone(self.action('config', config=config)['stage_preview'])

    def test_stage_pose_with_no_cue_is_reported_only_with_reliable_body_tracking(self):
        self.action('start_rehearsal')
        self.action('config', config=stage_config(self.controller.config))
        self.action('camera_status', ready=True)
        self.assertIsNone(self.hold('Ankh_Pose', stage_ready=False)['stage_preview'])
        state = self.hold('Ankh_Pose', stage_ready=True)
        self.assertEqual(state['stage_preview'], dict(serial=1, source='camera', input='Ankh pose',
                                                     target=None, message='No output assigned'))
        self.assert_no_console_output(state)

    def test_console_session_previews_a_voice_match_without_sending(self):
        config = stage_config(self.controller.config)
        config['input_source'] = 'speech'
        light = next(row for row in config['speech_mappings'] if row['id'] == 'speech_light')
        light.update(cue_list=1, cue='14', enabled=True)
        self.action('session_start')
        self.action('config', config=config)
        self.action('speech_start')
        self.transport.sent.clear()
        self.assertIsNone(self.audio('White lights', confidence=.3)['stage_preview'])
        state = self.audio('White lights', utterance=1)
        self.assertEqual(state['stage_preview']['target'], dict(output_type='cue', cue_list=1, cue='14'))
        self.assertEqual(state['stage_preview']['source'], 'speech')
        self.assertIsNone(state['last_output'])
        self.assertEqual(self.transport.sent, [])

    def test_speech_previews_only_confident_decoder_matches_and_deduplicates_prefix(self):
        self.action('start_rehearsal')
        config = stage_config(self.controller.config)
        config['input_source'] = 'speech'
        command = next(row for row in config['speech_mappings'] if row['id'] == 'speech_command')
        command.update(cue_list=2, cue='1.5', enabled=True)
        self.action('config', config=config)
        self.action('speech_start')
        self.assertIsNone(self.action('speech_debug', phrase='At my command')['stage_preview'])
        self.assertIsNone(self.audio('At my command', final=False)['stage_preview'])
        self.assertIsNone(self.audio('At my command', confidence=.5)['stage_preview'])
        phrase = 'At my command American'
        state = self.audio(phrase, prefix_only=True, utterance=1)
        event = state['stage_preview']
        self.assertEqual(event, dict(serial=1, source='speech', input=phrase,
                                     target=dict(output_type='cue', cue_list=2, cue='1.5')))
        self.assertEqual(self.audio(phrase + ' forces', utterance=1)['stage_preview'], event)
        self.assertEqual(self.audio('At my command', utterance=2)['stage_preview']['serial'], 2)
        self.assert_no_console_output(state)

    def test_learned_motion_practice_resolves_its_selected_cue(self):
        self.action('start_rehearsal')
        config = copy.deepcopy(self.controller.config)
        learned = motion()
        config.update(mode='motion', custom_motions=[learned])
        self.action('config', config=config)
        self.action('camera_status', ready=True)
        self.assertIsNone(self.frame(motion_practice=dict(id=learned['id'], similarity=.5))['stage_preview'])
        state = self.frame(motion_practice=dict(id=learned['id'], similarity=.99))
        self.assertEqual(state['stage_preview'], dict(serial=1, source='motion', input=learned['name'],
                                                     target=dict(output_type='cue', cue_list=1, cue=learned['cue'])))
        self.assert_no_console_output(state)

    def test_automatic_motion_preview_does_not_record_practice_evidence(self):
        self.action('start_rehearsal')
        config = copy.deepcopy(self.controller.config)
        learned = motion()
        config.update(mode='motion', custom_motions=[learned])
        self.action('config', config=config)
        self.action('camera_status', ready=True)
        state = self.frame(motion_preview=dict(id=learned['id'], similarity=.99))
        self.assertEqual(state['stage_preview']['target'], dict(output_type='cue', cue_list=1, cue=learned['cue']))
        self.assertNotIn(learned['id'], self.controller.practice_evidence)
        self.assert_no_console_output(state)
        learned['enabled'] = False
        self.action('config', config=config)
        state = self.frame(motion_preview=dict(id=learned['id'], similarity=.99))
        self.assertIsNone(state['stage_preview'])

    def test_gesture_and_voice_preview_their_assigned_beam_settings(self):
        config = stage_config(self.controller.config)
        fire = next(row for row in config['mappings'] if row['gesture'] == 'Fire_Gesture')
        fire.update(output_type='channel_level', channel=28, zoom=25, color='#F70F00')
        light = next(row for row in config['speech_mappings'] if row['id'] == 'speech_light')
        light.update(output_type='channel_level', channel=28, zoom=80, color='#ffffff', enabled=True)
        self.action('start_rehearsal')
        self.action('config', config=config)
        self.action('speech_start')
        self.action('camera_status', ready=True)
        state = self.hold('Fire_Gesture', stage_ready=True)
        self.assertEqual(state['stage_preview']['target'],
                         dict(output_type='channel_level', channel=28, level=None, zoom=25, color='#f70f00'))
        state = self.audio('Let there be light')
        self.assertEqual(state['stage_preview']['target'],
                         dict(output_type='channel_level', channel=28, level=None, zoom=80, color='#ffffff'))
        self.assert_no_console_output(state)

    def test_a_learned_gesture_can_preview_a_color_without_a_cue_or_intensity(self):
        self.action('start_rehearsal')
        config = copy.deepcopy(self.controller.config)
        learned = motion()
        learned.pop('cue')
        learned.update(output_type='channel_level', channel=28, color='#EE0000')
        config.update(mode='motion', custom_motions=[learned])
        self.action('config', config=config)
        self.action('camera_status', ready=True)
        state = self.frame(motion_preview=dict(id=learned['id'], similarity=.99))
        self.assertEqual(state['stage_preview']['target'],
                         dict(output_type='channel_level', channel=28, level=None, color='#ee0000'))
        self.assert_no_console_output(state)

    def test_recognized_gesture_and_voice_preview_a_full_look_without_writes(self):
        config = stage_config(self.controller.config)
        rows = [dict(channel=28, level=70, color='#ffaa00'), dict(channel=9, level=0)]
        palm = next(row for row in config['mappings'] if row['gesture'] == 'Open_Palm')
        light = next(row for row in config['speech_mappings'] if row['id'] == 'speech_light')
        for mapping in (palm, light):
            mapping.pop('cue_list')
            mapping.update(output_type='channel_look', channels=rows, enabled=True)
        self.action('start_rehearsal')
        self.action('config', config=config)
        self.action('speech_start')
        self.action('camera_status', ready=True)
        expected = dict(output_type='channel_look', channels=list(reversed(rows)))
        camera = self.hold('Open_Palm', stage_ready=True)
        self.assertEqual(camera['stage_preview']['target'], expected)
        voice = self.audio('Let there be light')
        self.assertEqual(voice['stage_preview']['source'], 'speech')
        self.assertEqual(voice['stage_preview']['target'], expected)
        self.assert_no_console_output(voice)


if __name__ == '__main__':
    unittest.main()
