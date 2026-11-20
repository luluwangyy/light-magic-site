"""Preparation receipts and camera epochs never imply permission to replay output."""
import copy
from pathlib import Path
import tempfile
import unittest

from app import Controller, DEFAULT
from test_custom_motions import motion


class Clock:
    def __init__(self): self.now = 100.0
    def __call__(self): return self.now
    def advance(self, seconds): self.now += seconds


class FakeTransport:
    def __init__(self):
        self.sent = []
        self.connections = []
        self.fail = False
    def send(self, address, args=()):
        if self.fail: raise OSError('test cable disconnected')
        self.sent.append((address, list(args)))
    def connect(self, **endpoint):
        self.connections.append(endpoint)
        self.fail = False
    def close(self): pass


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        scratch = Path(tempfile.gettempdir()) / 'light-magic-tests'
        scratch.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.clock = Clock()
        self.c = Controller(self.temp.name, self.clock)
        self.c.transport = FakeTransport()
        # This fixture covers camera behavior; speech requirements have their own suite.
        self.c.needs_practice.difference_update(key for key in list(self.c.needs_practice) if key.startswith('speech_'))

    def tearDown(self): self.temp.cleanup()

    def action(self, name, **data):
        if name in ('go_live','confirm_session','test_target'):data={**self.tokens(),**data}
        return self.c.action(name, data, 'workflow-test-browser')

    def workflow(self): return self.c.state()['workflow']

    def tokens(self):
        workflow = self.workflow()
        return dict(revision=workflow['revision'], epoch=workflow['epoch'])

    def feedback(self, show='Workflow test show'):
        self.c.receive('/eos/out/get/version', ['3.3.10'])
        self.c.receive('/eos/out/show/name', [show])
        self.c.receive('/eos/out/get/show/path', ['/test/' + show + '.esf'])

    def prepare_session(self):
        self.action('session_start')
        self.feedback()
        self.action('confirm_session', only_host=True, session_ok=True)
        self.action('camera_status', ready=True, camera_id='test-camera')
        self.action('pause', reason='Preparing workflow tests')

    def frame(self, gesture='None', confidence=0, **data):
        self.action('heartbeat')
        if self.c.connected: self.c.receive('/eos/out/ping', [])
        payload = dict(source='camera', gesture=gesture, confidence=confidence,
                       hands=[], **self.tokens())
        payload.update(data)
        return self.action('frame', **payload)

    def hold(self, gesture, seconds=.8):
        self.frame(gesture, .99)
        for _ in range(round(seconds / .1)):
            self.clock.advance(.1)
            self.frame(gesture, .99)

    def neutral(self):
        self.frame()
        self.clock.advance(.4)
        self.frame()

    def complete_targets(self):
        for target in list(self.workflow()['targets']):
            self.wait_for_cue_slot()
            self.action('test_target', id=target['id'])
            self.action('confirm_target', id=target['id'], worked=True, **self.tokens())

    def wait_for_cue_slot(self):
        self.clock.advance(self.c.config['cue_interval_s'])
        self.action('heartbeat')
        self.c.receive('/eos/out/ping', [])

    def complete_practice(self):
        for item in list(self.workflow()['needs_practice']):
            if item['id'] not in self.c.active_recognition():continue
            if item['id'].startswith('pose:'):
                self.hold(item['id'].split(':', 1)[1])
            else:
                self.frame(motion_practice=dict(id=item['id'], similarity=.99))
            self.action('practice_confirm', id=item['id'], observed=True, **self.tokens())
        self.neutral()

    def ready(self):
        self.prepare_session()
        self.complete_targets()
        self.complete_practice()

    def target(self, identity):
        return next(item for item in self.workflow()['targets'] if item['id'] == identity)

    def cues(self):
        return [entry for entry in self.c.transport.sent
                if entry[0].startswith('/eos/cue/') and entry[0].endswith('/fire')]

    def apply(self, **changes):
        config = copy.deepcopy(self.c.config)
        config.update(changes)
        return self.action('config', config=config)

    def test_session_start_is_read_only_preview(self):
        self.assertFalse(self.c.armed)
        self.assertTrue(self.c.config['dry_run'])
        self.action('session_start')
        workflow = self.workflow()
        self.assertTrue(workflow['active'])
        self.assertEqual(workflow['state'], 'preview')
        self.assertFalse(self.c.armed)
        self.assertFalse(self.c.config['dry_run'])
        self.assertFalse(workflow['session_confirmed'])
        self.assertFalse(workflow['can_go_live'])
        self.assertTrue(self.c.transport.sent)
        self.assertTrue(all(address in ('/eos/get/version', '/eos/get/show/path', '/eos/ping')
                            for address, _ in self.c.transport.sent))
        self.action('camera_status',ready=True,camera_id='test-camera')
        self.assertEqual(self.workflow()['state'],'preview')

    def test_version_without_show_cannot_confirm_session(self):
        self.action('session_start')
        self.c.receive('/eos/out/get/version', ['3.3.10'])
        with self.assertRaises(ValueError):
            self.action('confirm_session', only_host=True, session_ok=True)
        self.assertFalse(self.workflow()['session_confirmed'])
        self.feedback()
        self.action('confirm_session', only_host=True, session_ok=True)
        self.assertTrue(self.workflow()['session_confirmed'])
        self.assertEqual(self.workflow()['identity']['version'], '3.3.10')

    def test_show_without_version_cannot_confirm_session(self):
        self.action('session_start')
        self.c.receive('/eos/out/show/name', ['Workflow test show'])
        with self.assertRaises(ValueError):
            self.action('confirm_session', only_host=True, session_ok=True)
        self.assertFalse(self.workflow()['session_confirmed'])

    def test_stale_session_confirmation_cannot_acknowledge_a_different_show(self):
        self.action('session_start')
        self.feedback()
        old=self.tokens()
        self.feedback('Another show')
        with self.assertRaisesRegex(ValueError,'output state changed'):
            self.action('confirm_session',only_host=True,session_ok=True,**old)
        self.assertFalse(self.workflow()['session_confirmed'])

    def test_stale_manual_cue_request_cannot_send_after_pause(self):
        self.prepare_session()
        identity=self.workflow()['targets'][0]['id']
        old=self.tokens()
        self.action('pause')
        with self.assertRaisesRegex(ValueError,'output state changed'):
            self.action('test_target',id=identity,**old)
        self.assertEqual(self.cues(),[])

    def test_successful_write_requires_separate_physical_confirmation(self):
        self.prepare_session()
        identity = self.workflow()['targets'][0]['id']
        self.action('test_target', id=identity)
        self.assertTrue(self.target(identity)['sent'])
        self.assertFalse(self.target(identity)['confirmed'])
        self.assertEqual(len(self.cues()), 1)
        with self.assertRaises(ValueError): self.action('go_live')
        self.action('confirm_target', id=identity, worked=True, **self.tokens())
        self.assertTrue(self.target(identity)['confirmed'])
        self.assertEqual(len(self.cues()), 1)

    def test_a_mapped_level_needs_its_own_visible_console_check(self):
        config=copy.deepcopy(self.c.config)
        palm=next(row for row in config['mappings'] if row['gesture']=='Open_Palm')
        palm.update(output_type='channel_level',channel=9,level=30)
        self.action('claim')
        self.action('config',config=config)
        self.prepare_session()
        target=self.target('channel_level:9:30')
        self.assertEqual(target['command'],'Chan 9 @ 30')
        self.assertEqual(target['output_type'],'channel_level')
        self.action('manual_channel_level',channel=9,level=30,confirmed=True,**self.tokens())
        self.assertFalse(self.target(target['id'])['confirmed'])
        self.assertFalse(self.target(target['id'])['sent'])
        self.wait_for_cue_slot()
        self.action('test_target',id=target['id'])
        self.assertTrue(self.target(target['id'])['sent'])
        self.action('confirm_target',id=target['id'],worked=True,**self.tokens())
        self.assertTrue(self.target(target['id'])['confirmed'])
        self.assertEqual(self.c.transport.sent.count(('/eos/chan/9/at',[30.0])),2)
        config=copy.deepcopy(self.c.config)
        next(row for row in config['mappings'] if row['gesture']=='Open_Palm')['level']=0
        self.action('config',config=config)
        self.assertFalse(self.target('channel_level:9:0')['confirmed'])
        self.assertTrue(self.workflow()['session_confirmed'])
        self.assertFalse(self.c.armed)

    def test_unsent_or_stale_target_confirmation_is_rejected(self):
        self.prepare_session()
        first, second = self.workflow()['targets'][:2]
        self.action('test_target', id=first['id'])
        with self.assertRaises(ValueError):
            self.action('confirm_target', id=second['id'], worked=True, **self.tokens())
        for key in ('revision', 'epoch'):
            stale = self.tokens(); stale[key] -= 1
            with self.subTest(stale=key), self.assertRaises(ValueError):
                self.action('confirm_target', id=first['id'], worked=True, **stale)
        self.assertFalse(self.target(first['id'])['confirmed'])

    def test_failed_or_rate_limited_test_gets_no_success_receipt(self):
        self.prepare_session()
        first, second = self.workflow()['targets'][:2]
        self.action('test_target', id=first['id'])
        with self.assertRaises(ValueError): self.action('test_target', id=second['id'])
        self.assertFalse(self.target(second['id'])['sent'])
        self.wait_for_cue_slot()
        self.c.transport.fail = True
        with self.assertRaisesRegex(ValueError, 'Connection failed'):
            self.action('test_target', id=second['id'])
        self.assertFalse(self.target(second['id'])['sent'])
        self.assertFalse(self.c.armed)

    def test_preview_observation_and_performer_confirmation_are_separate(self):
        self.prepare_session()
        config = copy.deepcopy(self.c.config)
        next(row for row in config['mappings'] if row['gesture'] == 'Open_Palm')['confidence'] = .9
        self.action('config', config=config)
        item = next(item for item in self.workflow()['needs_practice']
                    if item['id'] == 'pose:Open_Palm')
        with self.assertRaises(ValueError):
            self.action('practice_confirm', id=item['id'], observed=True, **self.tokens())
        self.frame('Open_Palm', .99)
        with self.assertRaises(ValueError):
            self.action('practice_confirm', id=item['id'], observed=True, **self.tokens())
        self.hold('Open_Palm')
        self.assertTrue(next(row for row in self.workflow()['needs_practice']
                             if row['id'] == item['id'])['observed'])
        self.action('practice_confirm', id=item['id'], observed=True, **self.tokens())
        self.assertNotIn(item['id'], [row['id'] for row in self.workflow()['needs_practice']])
        self.assertEqual(self.cues(), [])

    def test_identical_and_label_only_apply_preserve_completed_checks(self):
        self.ready()
        confirmed = {target['id'] for target in self.workflow()['targets'] if target['confirmed']}
        self.action('config', config=copy.deepcopy(self.c.config))
        config = copy.deepcopy(self.c.config)
        config['notes'] = 'Operator notes changed'
        config['mappings'][1]['label'] = 'A more useful name'
        self.action('config', config=config)
        self.assertEqual({target['id'] for target in self.workflow()['targets'] if target['confirmed']}, confirmed)
        self.assertEqual(self.workflow()['needs_practice'], [])
        self.assertTrue(self.workflow()['session_confirmed'])

    def test_cue_remap_requires_only_the_new_target_test(self):
        self.ready()
        config = copy.deepcopy(self.c.config)
        next(row for row in config['mappings'] if row['gesture'] == 'Open_Palm')['cue'] = '1001'
        self.action('config', config=config)
        self.assertTrue(self.target('cue:1:888')['confirmed'])
        self.assertFalse(self.target('cue:1:1001')['sent'])
        self.assertFalse(self.target('cue:1:1001')['confirmed'])
        self.assertEqual(self.workflow()['needs_practice'], [])
        self.assertTrue(self.workflow()['session_confirmed'])
        self.assertFalse(self.workflow()['can_go_live'])

    def test_pose_recognition_edit_only_invalidates_its_practice(self):
        self.ready()
        config = copy.deepcopy(self.c.config)
        next(row for row in config['mappings'] if row['gesture'] == 'Open_Palm')['confidence'] = .9
        self.action('config', config=config)
        self.assertEqual([item['id'] for item in self.workflow()['needs_practice']], ['pose:Open_Palm'])
        self.assertTrue(all(target['confirmed'] for target in self.workflow()['targets']))
        self.assertTrue(self.workflow()['session_confirmed'])

    def test_enabling_unchanged_pose_with_shared_cue_preserves_completed_checks(self):
        self.ready()
        config = copy.deepcopy(self.c.config)
        next(row for row in config['mappings'] if row['gesture'] == 'Thumb_Up').update(enabled=True, cue='1000')
        self.action('config', config=config)
        self.assertEqual(len(self.workflow()['targets']), 2)
        self.assertTrue(all(target['confirmed'] for target in self.workflow()['targets']))
        self.assertEqual(self.workflow()['needs_practice'], [])

    def test_motion_template_edit_only_invalidates_that_motion_practice(self):
        first = motion()
        second = motion(identifier='motion_second_0002', name='Wave left', cue='1201')
        self.c.apply(dict(copy.deepcopy(DEFAULT), mode='motion', custom_motions=[first, second]))
        self.ready()
        config = copy.deepcopy(self.c.config)
        config['custom_motions'][0]['templates'][0]['frames'][15][1] += .1
        self.action('config', config=config)
        self.assertEqual([item['id'] for item in self.workflow()['needs_practice']], [first['id']])
        self.assertTrue(all(target['confirmed'] for target in self.workflow()['targets']))

    def test_profile_persists_configuration_and_pending_practice_not_permission(self):
        self.ready()
        config = copy.deepcopy(self.c.config)
        next(row for row in config['mappings'] if row['gesture'] == 'Open_Palm').update(cue='1001', confidence=.9)
        self.action('config', config=config)
        self.assertTrue((Path(self.temp.name) / 'profile.json').exists())
        recovered = Controller(self.temp.name, self.clock)
        recovered.transport = FakeTransport()
        opened = next(row for row in recovered.config['mappings'] if row['gesture'] == 'Open_Palm')
        self.assertEqual(opened['cue'], '1001')
        self.assertEqual(opened['confidence'], .9)
        self.assertFalse(recovered.armed)
        self.assertTrue(recovered.config['dry_run'])
        self.assertFalse(recovered.connected)
        self.assertFalse(recovered.state()['workflow']['camera_ready'])
        self.assertFalse(recovered.state()['workflow']['session_confirmed'])
        self.assertFalse(recovered.state()['workflow']['can_go_live'])
        self.assertTrue(all(not target['confirmed'] for target in recovered.state()['workflow']['targets']))
        self.assertIn('pose:Open_Palm', [item['id'] for item in recovered.state()['workflow']['needs_practice']])
        self.assertEqual(recovered.transport.sent, [])

    def test_recheck_cues_keeps_recognition_but_requires_fresh_target_tests(self):
        self.ready()
        self.action('recheck_cues')
        self.assertFalse(self.c.armed)
        self.assertTrue(all(not target['sent'] and not target['confirmed'] for target in self.workflow()['targets']))
        self.assertEqual(self.workflow()['needs_practice'], [])
        self.assertTrue(self.workflow()['session_confirmed'])

    def test_stale_revision_and_epoch_frames_cannot_refresh_camera_or_send(self):
        self.ready()
        self.action('go_live')
        before = len(self.cues())
        last_frame = self.c.last_frame
        for key in ('revision', 'epoch'):
            stale = self.tokens(); stale[key] -= 1
            self.clock.advance(.1)
            try: self.frame('Closed_Fist', .99, **stale)
            except ValueError: pass
            self.assertEqual(self.c.last_frame, last_frame)
        self.assertEqual(len(self.cues()), before)

    def test_unversioned_or_demo_frames_cannot_refresh_live_camera(self):
        self.ready()
        self.action('go_live')
        before = len(self.cues())
        last_frame = self.c.last_frame
        frames = [dict(source='camera'), dict(source='demo', **self.tokens())]
        for payload in frames:
            self.clock.advance(.1)
            try: self.action('frame', gesture='Closed_Fist', confidence=.99, hands=[], **payload)
            except ValueError: pass
            self.assertEqual(self.c.last_frame, last_frame)
        self.assertEqual(len(self.cues()), before)

    def test_manual_target_test_requires_pausing_live_output(self):
        self.ready()
        self.action('go_live')
        before = len(self.cues())
        with self.assertRaises(ValueError):
            self.action('test_target', id=self.workflow()['targets'][0]['id'])
        self.assertEqual(len(self.cues()), before)

    def test_pause_is_available_to_another_browser_without_taking_control(self):
        self.ready()
        self.action('go_live')
        before = len(self.cues())
        old_epoch = self.workflow()['epoch']
        result = self.c.action('pause', {'reason': 'Stop from another browser'}, 'other-test-browser')
        self.assertFalse(result['armed'])
        self.assertEqual(result['workflow']['state'], 'paused')
        self.assertGreater(result['workflow']['epoch'], old_epoch)
        self.assertEqual(result['owner'], 'workflow-test-browser')
        self.assertTrue(result['workflow']['session_confirmed'])
        self.assertTrue(all(target['confirmed'] for target in result['workflow']['targets']))
        self.assertEqual(len(self.cues()), before)

    def test_pose_calibration_reloads_and_edits_only_require_both_pose_checks(self):
        self.ready()
        calibration = {'Closed_Fist': [.2] * 16, 'Open_Palm': [1.5] * 16}
        self.apply(pose_calibration=calibration)
        self.complete_practice()
        self.assertEqual(self.workflow()['needs_practice'], [])
        calibration = copy.deepcopy(calibration)
        calibration['Closed_Fist'][0] = .4
        before = len(self.cues())
        self.apply(pose_calibration=calibration)
        self.assertEqual({item['id'] for item in self.workflow()['needs_practice']},
                         {'pose:Closed_Fist', 'pose:Open_Palm'})
        self.assertTrue(self.workflow()['session_confirmed'])
        self.assertTrue(all(target['confirmed'] for target in self.workflow()['targets']))
        self.assertFalse(self.c.armed)
        self.assertEqual(len(self.cues()), before)
        recovered = Controller(self.temp.name, self.clock)
        recovered.transport = FakeTransport()
        self.assertEqual(recovered.config['pose_calibration'], calibration)
        self.assertEqual({item['id'] for item in recovered.state()['workflow']['needs_practice']},
                         {'pose:Closed_Fist', 'pose:Open_Palm'})
        self.assertFalse(recovered.armed)
        self.assertTrue(recovered.config['dry_run'])
        self.assertFalse(recovered.state()['workflow']['session_confirmed'])
        self.assertEqual(recovered.transport.sent, [])

    def test_malformed_pose_calibration_cannot_replace_saved_configuration(self):
        baseline = copy.deepcopy(self.c.config)
        invalid = [[], {'Victory': [.2] * 16}, {'Closed_Fist': None},
                   {'Closed_Fist': [.2] * 15}, {'Closed_Fist': [.2] * 17},
                   {'Closed_Fist': [.2] * 15 + ['not a feature']},
                   {'Closed_Fist': [.2] * 15 + [True]},
                   {'Closed_Fist': [.2] * 15 + [float('nan')]},
                   {'Closed_Fist': [.2] * 15 + [float('inf')]},
                   {'Closed_Fist': [.2] * 15 + [-.01]},
                   {'Closed_Fist': [.2] * 15 + [10.01]},
                   {'Closed_Fist': [.2] * 16, 'Open_Palm': [.2] * 16}]
        for index, features in enumerate(invalid):
            config = copy.deepcopy(baseline)
            config['pose_calibration'] = features
            with self.subTest(index=index), self.assertRaises(ValueError): self.c.apply(config)
            self.assertEqual(self.c.config, baseline)
        self.assertEqual(self.c.transport.sent, [])

    def test_simulated_target_test_cannot_earn_live_receipt_after_leaving_dry_run(self):
        self.prepare_session()
        identity = self.workflow()['targets'][0]['id']
        self.apply(dry_run=True)
        with self.assertRaises(ValueError): self.action('test_target', id=identity)
        self.assertFalse(self.target(identity)['sent'])
        self.assertFalse(self.target(identity)['confirmed'])
        self.assertEqual(self.cues(), [])
        self.apply(dry_run=False)
        self.assertFalse(self.target(identity)['sent'])
        self.assertFalse(self.target(identity)['confirmed'])
        with self.assertRaises(ValueError):
            self.action('confirm_target', id=identity, worked=True, **self.tokens())
        self.action('test_target', id=identity)
        self.assertTrue(self.target(identity)['sent'])
        self.assertFalse(self.target(identity)['confirmed'])
        self.action('confirm_target', id=identity, worked=True, **self.tokens())
        self.assertTrue(self.target(identity)['confirmed'])
        self.assertEqual(len(self.cues()), 1)

    def test_old_practice_evidence_cannot_confirm_after_recognition_change(self):
        self.prepare_session()
        self.hold('Open_Palm')
        old = self.tokens()
        config = copy.deepcopy(self.c.config)
        next(row for row in config['mappings'] if row['gesture'] == 'Open_Palm')['confidence'] = .9
        self.action('config', config=config)
        with self.assertRaises(ValueError):
            self.action('practice_confirm', id='pose:Open_Palm', observed=True, **old)
        with self.assertRaises(ValueError):
            self.action('practice_confirm', id='pose:Open_Palm', observed=True, **self.tokens())

    def test_camera_watchdog_pauses_despite_browser_heartbeat(self):
        self.ready()
        self.action('go_live')
        self.clock.advance(1.6)
        self.action('heartbeat')
        self.c.tick()
        self.assertFalse(self.c.armed)
        self.assertEqual(self.workflow()['state'], 'paused')
        self.assertFalse(self.workflow()['can_go_live'])
        self.assertTrue(all(target['confirmed'] for target in self.workflow()['targets']))
        with self.assertRaises(ValueError): self.action('go_live')

    def test_camera_change_preserves_target_tests_but_invalidates_recognition(self):
        self.ready()
        previous_epoch = self.workflow()['epoch']
        self.action('camera_status', ready=True, camera_id='different-camera')
        self.assertGreater(self.workflow()['epoch'], previous_epoch)
        self.assertFalse(self.c.armed)
        self.assertTrue(self.workflow()['session_confirmed'])
        self.assertTrue(all(target['confirmed'] for target in self.workflow()['targets']))
        self.assertEqual({item['id'] for item in self.workflow()['needs_practice']},
                         {'pose:' + mapping['gesture'] for mapping in self.c.config['mappings']})
        self.assertEqual({item['id'] for item in self.workflow()['blockers'] if item['kind'] == 'practice'},
                         {'pose:Open_Palm', 'pose:Closed_Fist'})

    def test_show_identity_change_pauses_and_invalidates_session_and_tests(self):
        self.ready()
        self.action('go_live')
        before = len(self.cues())
        self.feedback('Different show')
        self.assertFalse(self.c.armed)
        self.assertFalse(self.workflow()['session_confirmed'])
        self.assertTrue(all(not target['confirmed'] for target in self.workflow()['targets']))
        self.assertFalse(self.workflow()['can_go_live'])
        self.assertEqual(len(self.cues()), before)

    def test_reconnect_never_replays_or_reuses_live_permission(self):
        self.ready()
        self.action('go_live')
        before = len(self.cues())
        self.action('session_start')
        self.feedback()
        self.assertFalse(self.c.armed)
        self.assertFalse(self.workflow()['session_confirmed'])
        self.assertFalse(self.workflow()['can_go_live'])
        self.assertTrue(all(not target['confirmed'] for target in self.workflow()['targets']))
        self.assertEqual(len(self.cues()), before)

    def test_resume_requires_fresh_hold_but_no_extra_neutral_for_static_cues(self):
        config = copy.deepcopy(DEFAULT)
        config['palm_from_fist'] = False
        next(row for row in config['mappings'] if row['gesture'] == 'Closed_Fist')['enabled'] = False
        self.c.apply(config)
        self.ready()
        self.action('go_live')
        self.neutral()
        self.hold('Open_Palm')
        self.assertEqual(len(self.cues()), 2)  # One manual test and one deliberate pose.
        self.action('pause', reason='Operator pause')
        self.hold('Open_Palm')
        self.assertEqual(len(self.cues()), 2)
        stale=self.tokens()
        self.action('go_live')
        self.assertFalse(self.c.fresh_gesture_required)
        self.assertEqual(self.c.gate.progress,0)
        self.assertEqual(len(self.cues()),2)
        # Preview's complete hold and frames from its old epoch do not count.
        self.frame('Open_Palm',.99,**stale)
        self.hold('Open_Palm',.3)
        self.assertEqual(len(self.cues()), 2)
        for _ in range(12):
            self.clock.advance(.1)
            self.frame('Open_Palm',.99)
        self.assertEqual(len(self.cues()), 3)
        self.hold('Open_Palm',1.2)
        self.assertEqual(len(self.cues()),3)

    def test_arms_open_needs_distance_calibration_before_live(self):
        config=copy.deepcopy(self.c.config)
        arms=next(row for row in config['mappings'] if row['gesture']=='Arms_Open')
        arms.update(enabled=True,cue='999')
        self.action('claim')
        self.action('config',config=config)
        self.ready()
        self.assertTrue(any(item['kind']=='settings' and 'spacing' in item['message'] for item in self.workflow()['blockers']))
        with self.assertRaises(ValueError):self.action('go_live')
        self.apply(close=.1,far=.8)
        self.complete_practice()
        self.assertTrue(self.workflow()['can_go_live'])

    def test_failed_old_zoom_release_blocks_endpoint_change_and_survives_restart(self):
        self.c.apply(dict(copy.deepcopy(DEFAULT), mode='zoom', target='28',
                          zoom_min=10, zoom_max=60, close=.1, far=.8))
        self.prepare_session()
        old_endpoint = self.c.endpoint()
        self.c.zoom(30)
        self.c.transport.fail = True
        config = copy.deepcopy(self.c.config); config['host'] = '169.254.44.254'
        with self.assertRaises(ValueError): self.action('config', config=config)
        self.assertEqual(self.c.endpoint(), old_endpoint)
        self.assertTrue(self.c.pending)
        self.assertFalse(self.c.armed)
        recovered = Controller(self.temp.name, self.clock)
        recovered.transport = FakeTransport()
        self.assertEqual(recovered.pending[0]['endpoint'], old_endpoint)
        self.assertFalse(recovered.armed)
        recovered.action('session_start', {}, 'recovery-test-browser')
        self.assertEqual(recovered.transport.sent[0], ('/eos/chan/28/param/zoom/release', []))
        self.assertFalse(recovered.pending)
        self.assertFalse(recovered.armed)
        self.assertFalse(any(address.endswith('/override') for address, _ in recovered.transport.sent))


if __name__ == '__main__': unittest.main()
