"""Simulated stage inputs and a single bounded hardware output lane."""

import copy
import tempfile
import unittest

from app import Controller, DEFAULT, validate
from mapping_outputs import mapping_target
from show_profile import StageGestureGate, stage_config
from test_speech_workflow import FakeSpeech
from test_workflow import Clock, FakeTransport


class CueOutputTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.clock=Clock()
        self.c=Controller(self.temp.name,self.clock,FakeSpeech())
        self.c.transport=FakeTransport()
        self.c.config=stage_config(self.c.config)
        self.c.config['dry_run']=False
        self.c.config['mappings'][0].update(cue='12',enabled=True)
        self.c.config['speech_mappings'][0].update(cue='012.0',enabled=True)
        self.c.config['speech_mappings'][4].update(cue='13',enabled=True)
        self.c.config['custom_motions']=[dict(id='motion_bow',name='Bow',cue_list=1,cue='14',
                                             threshold=.85,enabled=True,cooldown_s=2)]
        self.c.workflow_active=self.c.armed=True
        self.c.session_confirmed=self.c.camera_ready=self.c.speech_ready=True
        self.c.console_identity={'version':'3.3','show_name':'Simulated'}
        self.c.connected=self.c.verified=True
        self.c.owner='test-owner'
        self.c.fresh_gesture_required=False
        self.c.speech_wait_for_silence=False
        self.c.target_tests={f'cue:1:{cue}':{'confirmed':True} for cue in ('12','012.0','13','14')}
        self.at(0)
        self.c.cue({'cue':'19','cue_list':1})

    def at(self,offset,*,camera=True,speech=True):
        self.clock.now=100+offset
        c=self.c
        c.last_heartbeat=c.feedback_time=c.ping_time=self.clock()
        if camera:c.last_frame=c.camera_frame_time=self.clock()
        if speech:
            c.speech_frame_time=self.clock();c.speech_frame_seen=True

    def frame(self,offset,name='Open_Palm',**changes):
        self.at(offset,camera=False)
        payload=dict(source='camera',gesture=name,confidence=.98,stage_ready=True,
                     tracking_key='hand:1',revision=self.c.config_revision,epoch=self.c.output_epoch)
        payload.update(changes)
        self.c.action('frame',payload,self.c.owner)

    def hold(self,start=.1):
        for n in range(8):self.frame(start+.1*n)

    def speak(self,offset,words):
        self.at(offset)
        self.c.process_speech_result(dict(final=True,text=words,confidence=.98))

    def cue_addresses(self):
        return [address for address,_ in self.c.transport.sent if address.endswith('/fire')]

    def test_cross_source_duplicate_coalesces_and_latest_distinct_request_wins(self):
        self.hold()
        pending=self.c.cue_lane.pending
        self.assertEqual(pending.source,'camera')
        self.speak(.9,'Let there be light')
        self.assertIs(self.c.cue_lane.pending,pending,'equivalent cue number cannot extend the pending lifetime')
        self.speak(1.55,'Stand down')
        self.assertEqual(self.c.cue_lane.pending.source,'speech')
        self.assertEqual(self.c.speech_state()['last_outcome'],'Cue 13 waiting for console spacing')
        self.at(1.99);self.c.tick()
        self.assertEqual(self.cue_addresses(),['/eos/cue/1/19/fire'])
        self.at(2.05);self.c.tick()
        self.assertEqual(self.cue_addresses(),['/eos/cue/1/19/fire','/eos/cue/1/13/fire'])
        self.at(2.1);self.c.tick()
        self.assertEqual(self.c.last_output['source'],'speech')
        self.assertEqual(self.c.speech_state()['last_outcome'],'Cue 13 sent')
        self.assertEqual(len(self.cue_addresses()),2)

    def test_expired_speech_request_reports_reason_and_can_be_repeated(self):
        self.speak(.12,'Stand down')
        self.at(1);self.c.tick()
        self.assertIn('request expired',self.c.speech_state()['last_outcome'])
        self.assertEqual(self.cue_addresses(),['/eos/cue/1/19/fire'])
        self.speak(2.05,'Stand down')
        self.assertEqual(self.cue_addresses()[-1],'/eos/cue/1/13/fire')

    def test_rearmed_same_gesture_waits_for_gap_instead_of_losing_the_event(self):
        self.hold(2.1)
        self.assertEqual(len(self.cue_addresses()),2)
        for offset in (2.9,3,3.1,3.21):
            self.frame(offset,'None',confidence=0,neutral_kind='observed')
        self.hold(3.3)
        self.assertEqual(len(self.cue_addresses()),2)
        self.assertIsNotNone(self.c.cue_lane.pending)
        self.assertEqual(self.c.cue_lane.pending.identity,'Open_Palm')
        ready_at=self.c.last_cue_t+self.c.config['cue_interval_s']-100
        for offset in (4.1,4.2,4.3,4.4,4.5,4.6,ready_at-.01):self.frame(offset)
        self.assertEqual(len(self.cue_addresses()),2)
        self.frame(ready_at+.01)
        self.assertEqual(len(self.cue_addresses()),3)
        self.hold(5)
        self.assertEqual(len(self.cue_addresses()),3)

    def test_sent_camera_output_still_suppresses_equivalent_voice_destination(self):
        self.hold(2.1)
        self.assertEqual(len(self.cue_addresses()),2)
        self.speak(3,'Let there be light')
        self.assertIsNone(self.c.cue_lane.pending)
        self.assertIn('Duplicate output',self.c.speech_last_outcome)
        self.assertEqual(len(self.cue_addresses()),2)

    def test_pose_and_speech_coalesce_the_same_channel_level(self):
        channel_level=dict(output_type='channel_level',channel=9,level=30.5)
        self.c.config['mappings'][0].update(channel_level)
        self.c.config['speech_mappings'][0].update(channel_level)
        self.c.target_tests['channel_level:9:30.5']={'confirmed':True}
        self.hold()
        pending=self.c.cue_lane.pending
        self.speak(.9,'Let there be light')
        self.assertIs(self.c.cue_lane.pending,pending)
        for n in range(1,12):self.frame(.9+n*.1)
        self.frame(2.05)
        self.assertEqual(self.c.transport.sent,[('/eos/cue/1/19/fire',[]),('/eos/chan/9/at',[30.5])])
        self.assertEqual(self.c.last_output['id'],'Open_Palm')
        self.assertEqual(self.c.last_output['target_id'],'channel_level:9:30.5')

    def test_speech_can_send_zero_level_after_the_shared_gap(self):
        self.c.config['speech_mappings'][4].update(output_type='channel_level',channel=9,level=0.0)
        self.c.target_tests['channel_level:9:0']={'confirmed':True}
        self.speak(1.6,'Stand down')
        self.assertEqual(self.c.speech_state()['last_outcome'],'Chan 9 @ 0 waiting for console spacing')
        self.at(2.05);self.c.tick()
        self.assertEqual(self.c.transport.sent[-1],('/eos/chan/9/at',[0.0]))
        self.assertEqual(self.c.speech_state()['last_outcome'],'Chan 9 @ 0 sent')

    def test_a_spoken_channel_look_shares_spacing_and_matches_by_every_setting(self):
        gesture = self.c.config['mappings'][0]
        speech = self.c.config['speech_mappings'][0]
        gesture.update(output_type='channel_level', channel=28, level=None, zoom=15, color='#ff0000')
        speech.update(output_type='channel_level', channel=28, level=None, zoom=60, color='#0000ff')
        for row in (gesture, speech):
            self.c.target_tests[mapping_target(row)['id']] = {'confirmed': True}
        self.hold()
        self.assertEqual(self.c.cue_lane.pending.source, 'camera')
        self.speak(1.7, 'Let there be light')
        self.assertEqual(self.c.cue_lane.pending.source, 'speech')
        self.assertEqual(self.c.transport.sent, [('/eos/cue/1/19/fire', [])])
        self.at(2.05)
        self.c.tick()
        self.assertEqual(self.c.transport.sent[1:], [
            ('/eos/chan/28/param/zoom', [60.0]), ('/eos/chan/28/color/rgb', [0.0, 0.0, 1.0]),
        ])
        self.assertEqual(self.c.last_output['color'], '#0000ff')

    def test_learned_motion_can_send_zoom_with_confirmed_output(self):
        self.c.config['mode'] = 'motion'
        motion = self.c.config['custom_motions'][0]
        motion.update(output_type='channel_level', channel=28, zoom=50)
        target = mapping_target(motion)
        self.c.target_tests[target['id']] = {'confirmed': True}
        self.frame(2.1, name='None', motion_candidate=dict(id=motion['id'], similarity=.95))
        self.assertEqual(self.c.transport.sent[1:], [('/eos/chan/28/param/zoom', [50.0])])
        self.assertEqual(self.c.last_output['source'], 'motion')

    def test_multi_channel_gesture_sends_one_ordered_output_and_dedupes_voice(self):
        rows = [
            dict(channel=28, level=72, zoom=35, color='#ff6600'),
            dict(channel=9, level=0),
            dict(channel=4, level=0, color='#ffffff'),
        ]
        self.c.config['mappings'][0].update(output_type='channel_look', channels=rows)
        self.c.config['speech_mappings'][0].update(output_type='channel_look', channels=list(reversed(rows)))
        target = mapping_target(self.c.config['mappings'][0])
        self.c.target_tests[target['id']] = {'confirmed': True}
        self.hold()
        pending = self.c.cue_lane.pending
        self.speak(.9, 'Let there be light')
        self.assertIs(self.c.cue_lane.pending, pending)
        for n in range(1, 11):
            self.frame(.9 + n * .1)
        self.frame(2.05)
        self.assertEqual(self.c.transport.sent[1:], [
            ('/eos/chan/4/at', [0.0]),
            ('/eos/chan/9/at', [0.0]),
            ('/eos/chan/4/color/rgb', [1.0, 1.0, 1.0]),
            ('/eos/chan/28/param/zoom', [35.0]),
            ('/eos/chan/28/color/rgb', [1.0, .4, 0.0]),
            ('/eos/chan/28/at', [72.0]),
        ])
        self.assertEqual(self.c.last_output['target_id'], target['id'])
        self.assertEqual(self.c.last_output['channels'], target['channels'])
        self.assertAlmostEqual(self.c.cue_lane.remaining(self.clock(), self.c.config['cue_interval_s']), 2)

    def test_partial_look_write_disarms_and_does_not_continue_or_retry(self):
        mapping = self.c.config['speech_mappings'][4]
        mapping.update(output_type='channel_look', channels=[
            dict(channel=4, level=0), dict(channel=9, zoom=20), dict(channel=28, level=90),
        ])
        target = mapping_target(mapping)
        self.c.target_tests[target['id']] = {'confirmed': True}
        old_output = self.c.last_output
        send = self.c.transport.send

        def send_until_zoom(address, args=()):
            if address == '/eos/chan/9/param/zoom':
                raise OSError('lost connection during look')
            send(address, args)

        self.c.transport.send = send_until_zoom
        with self.assertRaisesRegex(ValueError, 'Connection failed'):
            self.speak(2.1, 'Stand down')
        self.assertEqual(self.c.transport.sent[1:], [('/eos/chan/4/at', [0.0])])
        self.assertEqual(self.c.last_output, old_output)
        self.assertFalse(self.c.armed)
        self.assertIsNone(self.c.cue_lane.pending)
        self.assertEqual(self.c.cue_lane.status['kind'], 'dropped')
        self.c.transport.send = send
        self.at(5)
        self.c.tick()
        self.assertEqual(self.c.transport.sent[1:], [('/eos/chan/4/at', [0.0])])

    def test_queued_channel_level_cannot_send_after_mapping_changes(self):
        mapping=self.c.config['speech_mappings'][4]
        mapping.update(output_type='channel_level',channel=9,level=30.0)
        self.c.target_tests['channel_level:9:30']={'confirmed':True}
        self.speak(1.6,'Stand down')
        self.assertIsNotNone(self.c.cue_lane.pending)
        mapping['level']=31.0
        self.at(2.05);self.c.tick()
        self.assertEqual(self.c.transport.sent,[('/eos/cue/1/19/fire',[])])
        self.assertIn('mapping changed',self.c.speech_state()['last_outcome'])

    def test_combined_zoom_can_keep_its_override_during_paced_speech_cue(self):
        self.c.config.update(mode='zoom',target='1',zoom_min=10,zoom_max=40,close=.1,far=.6)
        self.at(1.5)
        self.assertTrue(self.c.zoom(30))
        self.speak(1.6,'Stand down')
        self.assertEqual(self.c.speech_state()['last_outcome'],'Cue 13 waiting for console spacing')
        self.assertNotIn('release',{blocker['kind'] for blocker in self.c.workflow_state()['blockers']})
        self.at(2.05);self.c.tick()
        self.assertTrue(self.c.armed)
        self.assertEqual(self.c.pending,[self.c.owned])
        self.assertEqual(self.cue_addresses(),['/eos/cue/1/19/fire','/eos/cue/1/13/fire'])

    def test_spoken_zoom_can_change_a_channel_without_a_two_hand_override(self):
        self.c.config.update(mode='zoom',target='1',zoom_min=10,zoom_max=40,close=.1,far=.6)
        row = self.c.config['speech_mappings'][4]
        row.update(output_type='channel_level', channel=1, zoom=50)
        self.c.target_tests[mapping_target(row)['id']] = {'confirmed': True}
        self.at(1.5)
        self.assertTrue(self.c.zoom(30))
        self.speak(1.6, 'Stand down')
        self.assertIsNone(self.c.cue_lane.pending)
        self.assertIn('two-hand Zoom adjustment', self.c.speech_state()['last_outcome'])
        row['channel'] = 2
        self.c.target_tests[mapping_target(row)['id']] = {'confirmed': True}
        self.speak(2.1, 'Stand down')
        self.assertTrue(self.c.armed)
        self.assertEqual(self.c.pending, [self.c.owned])
        self.assertEqual(self.c.transport.sent[-1], ('/eos/chan/2/param/zoom', [50.0]))

    def test_overlapping_zoom_blocks_the_entire_spoken_look(self):
        self.c.config.update(mode='zoom', target='1', zoom_min=10, zoom_max=40, close=.1, far=.6)
        row = self.c.config['speech_mappings'][4]
        row.update(output_type='channel_look', channels=[dict(channel=1, zoom=50), dict(channel=2, level=30)])
        self.c.target_tests[mapping_target(row)['id']] = {'confirmed': True}
        self.at(2.1)
        self.assertTrue(self.c.zoom(30))
        before = list(self.c.transport.sent)
        self.speak(2.2, 'Stand down')
        self.assertEqual(self.c.transport.sent, before)
        self.assertIsNone(self.c.cue_lane.pending)
        self.assertIn('two-hand Zoom adjustment', self.c.speech_state()['last_outcome'])

    def test_live_zoom_does_not_hide_an_unresolved_override(self):
        self.c.config.update(mode='zoom',target='1',zoom_min=10,zoom_max=40,close=.1,far=.6)
        self.at(2.1)
        self.assertTrue(self.c.zoom(30))
        previous=dict(endpoint={**self.c.endpoint(),'host':'192.0.2.42'},address='/eos/chan/2/param/zoom/release')
        self.c.pending.append(previous)
        self.speak(2.2,'Stand down')
        self.assertFalse(self.c.armed)
        self.assertEqual(self.c.pending,[previous])
        self.assertEqual(self.cue_addresses(),['/eos/cue/1/19/fire'])

    def test_camera_can_send_only_on_a_fresh_matching_observation(self):
        self.hold()
        for n in range(1,12):self.frame(.8+n*.1)
        self.at(2.01,camera=False);self.c.tick()
        self.assertEqual(len(self.cue_addresses()),1)
        self.frame(2.05)
        self.assertEqual(self.cue_addresses()[-1],'/eos/cue/1/12/fire')
        self.frame(4.2)
        self.assertEqual(len(self.cue_addresses()),2,'held pose must not send again')

    def test_confirmed_fist_802_fires_once_after_neutral_and_a_fresh_hold(self):
        c = self.c
        fist = next(row for row in c.config['mappings'] if row['gesture'] == 'Closed_Fist')
        fist.update(cue='802', enabled=True)
        c.target_tests[mapping_target(fist)['id']] = {'confirmed': True}
        c.fresh_gesture_required = True

        for n in range(8):
            self.frame(2.1 + n * .1, 'Closed_Fist')
        self.assertEqual(self.cue_addresses(), ['/eos/cue/1/19/fire'])
        for n in range(5):
            self.frame(3 + n * .1, 'None', confidence=0, neutral_kind='observed')
        self.assertFalse(c.fresh_gesture_required)

        for n in range(6):
            self.frame(3.5 + n * .1, 'Closed_Fist')
        self.assertEqual(self.cue_addresses(), ['/eos/cue/1/19/fire'])
        for n in range(6, 30):
            self.frame(3.5 + n * .1, 'Closed_Fist')

        self.assertEqual(self.cue_addresses(), ['/eos/cue/1/19/fire', '/eos/cue/1/802/fire'])
        self.assertEqual(c.last_output['source'], 'camera')
        self.assertEqual(c.last_output['id'], 'Closed_Fist')

    def test_go_live_starts_complete_stage_hold_without_initial_neutral(self):
        c=self.c
        c.armed=False;c.needs_practice.clear()
        self.hold(2.1)
        stale=dict(revision=c.config_revision,epoch=c.output_epoch)
        self.assertEqual(len(self.cue_addresses()),1)
        c.action('go_live',stale,c.owner)
        self.assertFalse(c.fresh_gesture_required)
        self.assertEqual(c.stage_gate.progress,0)
        self.assertEqual(len(self.cue_addresses()),1)
        c.action('frame',dict(source='camera',gesture='Open_Palm',confidence=.99,stage_ready=True,**stale),c.owner)
        self.assertEqual(c.stage_gate.progress,0)
        for n in range(6):self.frame(3+.1*n)
        self.assertEqual(len(self.cue_addresses()),1)
        self.frame(3.61)
        self.assertEqual(self.cue_addresses(),['/eos/cue/1/19/fire','/eos/cue/1/12/fire'])
        self.hold(4)
        self.assertEqual(len(self.cue_addresses()),2)

    def test_static_fire_has_same_hold_once_and_confirmed_target_requirements(self):
        c=self.c
        fire=next(row for row in c.config['mappings'] if row['gesture']=='Fire_Gesture')
        fire.update(cue='18',enabled=True)
        c.target_tests[mapping_target(fire)['id']]={'confirmed':True}
        self.assertIn('cue:1:18',{row['id'] for row in c.all_targets()})
        for n in range(7):self.frame(2.1+n*.1,'Fire_Gesture')
        self.assertEqual(len(self.cue_addresses()),1)
        self.frame(2.76,'Fire_Gesture')
        self.assertEqual(self.cue_addresses(),['/eos/cue/1/19/fire','/eos/cue/1/18/fire'])
        for n in range(1,40):self.frame(2.76+n*.1,'Fire_Gesture')
        self.assertEqual(len(self.cue_addresses()),2)

    def test_motion_and_zoom_keep_their_initial_neutral_boundary(self):
        for mode in ('motion','zoom'):
            with self.subTest(mode=mode):
                c=self.c
                c.armed=False;c.needs_practice.clear()
                c.config.update(mode=mode,target='28',zoom_min=10,zoom_max=60,close=.1,far=.8)
                c.zoom_confirmed=True
                self.at(2.1)
                c.camera_frame_seen=True
                c.action('go_live',dict(revision=c.config_revision,epoch=c.output_epoch),c.owner)
                self.assertTrue(c.fresh_gesture_required)
                self.assertEqual(len(self.cue_addresses()),1)

    def test_unconfirmed_fire_never_writes_and_reports_its_blocker(self):
        fire=next(row for row in self.c.config['mappings'] if row['gesture']=='Fire_Gesture')
        fire.update(cue='18',enabled=True)
        for n in range(9):self.frame(2.1+n*.1,'Fire_Gesture')
        self.assertEqual(len(self.cue_addresses()),1)
        diagnostic=self.c.telemetry['camera_diagnostics']
        self.assertEqual(diagnostic['phase'],'dropped')
        self.assertIn('not confirmed',diagnostic['reason'])

    def test_camera_diagnostics_show_received_rate_hold_and_current_block(self):
        self.frame(.1,confidence=.76)
        diagnostic=self.c.telemetry['camera_diagnostics']
        self.assertEqual(diagnostic['phase'],'confidence')
        self.assertEqual(diagnostic['threshold'],.8)
        self.frame(.2)
        self.frame(.3)
        diagnostic=self.c.telemetry['camera_diagnostics']
        self.assertEqual(diagnostic['phase'],'holding')
        self.assertAlmostEqual(diagnostic['received_fps'],10)
        self.assertAlmostEqual(diagnostic['hold_s'],.1)
        self.assertAlmostEqual(diagnostic['hold_required_s'],.6)
        for n in range(4,10):self.frame(n*.1)
        self.assertEqual(self.c.telemetry['camera_diagnostics']['phase'],'waiting')
        self.frame(1,'None',confidence=0,tracking_uncertain=True,tracking_gap='hard')
        self.assertEqual(self.c.telemetry['camera_diagnostics']['phase'],'uncertain')
        self.assertIsNone(self.c.cue_lane.pending)
        for n in range(1,90):self.frame(1+n*.1)
        self.assertLessEqual(len(self.c.camera_frame_times),60)
        self.assertEqual(self.c.telemetry['camera_diagnostics']['phase'],'dropped')

    def test_tracking_gap_cancels_pending_and_does_not_rearm_held_pose(self):
        self.hold()
        self.frame(.9,'None',tracking_uncertain=True,tracking_gap='hard',confidence=0)
        self.assertIsNone(self.c.cue_lane.pending)
        for i in range(1,18):self.frame(.9+i*.1)
        self.assertEqual(len(self.cue_addresses()),1)

    def test_brief_same_wrist_miss_waits_for_fresh_pose_before_sending(self):
        self.hold()
        for n in range(1,12):self.frame(.8+n*.1)
        self.frame(2,'None',tracking_uncertain=True,tracking_gap='brief',confidence=0)
        self.assertIsNotNone(self.c.cue_lane.pending)
        self.at(2.01,camera=False);self.c.tick()
        self.assertEqual(len(self.cue_addresses()),1)
        self.frame(2.05)
        self.assertEqual(self.cue_addresses(),['/eos/cue/1/19/fire','/eos/cue/1/12/fire'])
        self.frame(2.15)
        self.assertEqual(len(self.cue_addresses()),2)

    def test_operator_can_start_fresh_hold_for_cue_556_without_sending_on_click(self):
        c=self.c
        c.config['mappings'][0]['cue']='556'
        c.target_tests['cue:1:556']={'confirmed':True}
        c.fresh_gesture_required=True
        self.hold(2.1)
        self.assertEqual(len(self.cue_addresses()),1)
        c.action('start_gesture_hold',dict(revision=c.config_revision,epoch=c.output_epoch),c.owner)
        self.assertFalse(c.fresh_gesture_required)
        self.assertEqual(len(self.cue_addresses()),1)
        self.hold(2.9)
        self.assertEqual(self.cue_addresses(),['/eos/cue/1/19/fire','/eos/cue/1/556/fire'])

    def test_gesture_debug_resolves_saved_cue_and_uses_live_dispatch(self):
        c=self.c
        c.config['mappings'][0]['cue']='556'
        c.target_tests['cue:1:556']={'confirmed':True}
        c.fresh_gesture_required=True
        request=dict(gesture='Open_Palm',revision=c.config_revision,epoch=c.output_epoch)
        with self.assertRaisesRegex(ValueError,'Wait'):
            c.action('gesture_debug',request,c.owner)
        self.assertIsNone(c.cue_lane.pending)
        self.at(2.1)
        state=c.action('gesture_debug',request,c.owner)
        self.assertEqual(self.cue_addresses(),['/eos/cue/1/19/fire','/eos/cue/1/556/fire'])
        self.assertEqual(state['last_output']['source'],'gesture_debug')
        self.assertTrue(state['workflow']['fresh_gesture_required'])
        c.armed=False
        with self.assertRaisesRegex(ValueError,'Go live'):
            c.action('gesture_debug',request,c.owner)

    def test_speech_and_motion_are_short_lived_and_do_not_build_a_backlog(self):
        self.c.config['mode']='motion'
        self.speak(.12,'Stand down')
        self.at(.25)
        self.c.motion_frame({'id':'motion_bow','similarity':.99},self.clock())
        self.assertEqual(self.c.cue_lane.pending.source,'motion')
        self.at(2.03);self.c.tick()
        self.assertEqual(self.c.cue_lane.status['kind'],'dropped')
        self.assertEqual(len(self.cue_addresses()),1)

    def test_pause_clears_slot_without_resetting_hardware_gap(self):
        self.hold()
        self.c.action('pause',{},self.c.owner)
        self.assertIsNone(self.c.cue_lane.pending)
        self.assertFalse(self.c.cue({'cue':'22','cue_list':1}))
        self.at(2.1);self.c.tick()
        self.assertEqual(len(self.cue_addresses()),1)

    def test_automatic_pause_requires_current_owner_revision_and_epoch(self):
        c = self.c
        owner = c.owner
        active = dict(revision=c.config_revision, epoch=c.output_epoch)
        for client, request in (
            ('another-browser', active),
            (owner, dict(active, revision=active['revision'] - 1)),
            (owner, dict(active, epoch=active['epoch'] - 1)),
            (owner, {}),
        ):
            with self.subTest(client=client, request=request):
                c.action('input_pause', request, client)
                self.assertTrue(c.armed)
                self.assertEqual(c.owner, owner)
                self.assertEqual(c.output_epoch, active['epoch'])

        c.action('input_pause', active, owner)
        self.assertFalse(c.armed)
        paused = dict(revision=c.config_revision, epoch=c.output_epoch)
        last_log = c.logs[-1]
        c.action('input_pause', paused, owner)
        self.assertEqual(c.output_epoch, paused['epoch'])
        self.assertIs(c.logs[-1], last_log)

    def test_legacy_nonowner_hidden_page_cannot_pause_but_explicit_stop_can(self):
        c = self.c
        old_epoch = c.output_epoch
        for action in ('pause', 'stop'):
            with self.subTest(action=action):
                c.action(action, {'reason': 'Controller page hidden or closed'}, 'another-browser')
                self.assertTrue(c.armed)
                self.assertEqual(c.output_epoch, old_epoch)
        c.action('stop', {}, 'another-browser')
        self.assertFalse(c.armed)

    def test_dropped_or_unverified_input_never_fires_from_tick(self):
        self.speak(1.6,'Stand down')
        self.at(2.05,speech=False)
        self.c.speech_ready=False
        self.c.tick()
        self.assertIsNone(self.c.cue_lane.pending)
        self.assertEqual(len(self.cue_addresses()),1)

    def test_slow_write_leaves_full_gap_after_completion(self):
        self.at(2.1)
        original=self.c.transport.send
        def slow(address,args=()):
            self.clock.advance(.4)
            original(address,args)
        self.c.transport.send=slow
        self.assertTrue(self.c.cue({'cue':'20','cue_list':1}))
        self.at(4.48)
        self.assertFalse(self.c.cue({'cue':'21','cue_list':1}))
        self.at(4.51)
        self.assertTrue(self.c.cue({'cue':'21','cue_list':1}))

    def test_failed_queued_write_disarms_and_cannot_retry(self):
        self.speak(1.6,'Stand down')
        self.assertIsNotNone(self.c.cue_lane.pending)
        self.at(2.05)
        self.c.transport.fail=True
        with self.assertRaisesRegex(ValueError,'Connection failed'):
            self.c.tick()
        self.assertFalse(self.c.armed)
        self.assertIsNone(self.c.cue_lane.pending)
        self.assertEqual(self.c.cue_lane.status['kind'],'dropped')
        self.c.transport.fail=False
        self.at(6)
        self.c.tick()
        self.assertEqual(len(self.cue_addresses()),1)


class ChannelMappingValidationTests(unittest.TestCase):
    def test_enabled_channel_mapping_can_omit_inactive_cue_fields(self):
        config=copy.deepcopy(DEFAULT)
        palm=next(row for row in config['mappings'] if row['gesture']=='Open_Palm')
        del palm['cue_list'],palm['cue']
        palm.update(output_type='channel_level',channel=9,level=0)
        saved=next(row for row in validate(config)['mappings'] if row['gesture']=='Open_Palm')
        self.assertEqual((saved['cue_list'],saved['cue'],saved['channel'],saved['level']),(1,'',9,0.0))
        palm['level']=None
        with self.assertRaisesRegex(ValueError,'Assign a channel and level'):validate(config)


class StageEvidenceTests(unittest.TestCase):
    def test_brief_gap_does_not_count_as_hold_and_other_hand_starts_fresh(self):
        gate=StageGestureGate()
        mapping=dict(gesture='Open_Palm',confidence=.8,enabled=True,hold_s=.4)
        def pose(at,track='hand:1'):
            return gate.update('Open_Palm',.99,[mapping],at,track=track)
        pose(0);pose(.1);pose(.2)
        gate.update('None',0,[mapping],.28,uncertain=True,brief=True,track='hand:1')
        self.assertIsNone(pose(.36))
        self.assertAlmostEqual(gate.progress,.5)
        self.assertIsNone(pose(.48))
        self.assertIsNotNone(pose(.60))
        self.assertIsNone(pose(.62,'hand:2'))
        self.assertEqual(gate.progress,0)
