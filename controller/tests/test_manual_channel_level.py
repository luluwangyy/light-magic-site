"""Manual channel levels go through the verified, paused console session."""

import tempfile
import unittest

from app import Controller
from cue_output import CueIntent
from mapping_outputs import mapping_target
from test_workflow import Clock, FakeTransport


class ManualChannelLevelTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.clock = Clock()
        self.controller = Controller(scratch.name, self.clock)
        self.transport = self.controller.transport = FakeTransport()
        self.client = 'manual-level-browser'

    def tokens(self):
        return dict(revision=self.controller.config_revision, epoch=self.controller.output_epoch)

    def action(self, name, **data):
        return self.controller.action(name, {**self.tokens(), **data}, self.client)

    def prepare(self, confirm=True):
        self.action('session_start')
        self.controller.receive('/eos/out/get/version', ['3.3.10'])
        self.controller.receive('/eos/out/show/name', ['Manual channel level test'])
        if confirm:
            self.action('confirm_session', only_host=True, session_ok=True)

    def level(self, channel=9, level=30.5, confirmed=True, **tokens):
        return self.action('manual_channel_level', channel=channel, level=level, confirmed=confirmed, **tokens)

    def test_one_typed_intensity_write_in_preview_without_cue_credit(self):
        self.prepare()
        before = len(self.transport.sent)
        result = self.level()
        self.assertEqual(self.transport.sent[before:], [('/eos/chan/9/at', [30.5])])
        self.assertEqual(result['channel_level'], {'channel': 9, 'level': 30.5})
        self.assertEqual(result['workflow']['state'], 'preview')
        self.assertEqual(result['workflow']['confirmed_target_ids'], [])
        self.assertIsNone(result['last_output'])

    def test_rejects_arbitrary_or_out_of_range_values_and_missing_confirmation(self):
        self.prepare()
        before = list(self.transport.sent)
        for fields in (
            {'channel': '9'}, {'channel': '9/thru/32'}, {'channel': True},
            {'channel': 9.5}, {'channel': 0}, {'channel': 100000},
            {'level': '30'}, {'level': True}, {'level': float('nan')},
            {'level': float('inf')}, {'level': -1}, {'level': 100.1},
            {'confirmed': False}, {'confirmed': 1},
        ):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                self.level(**fields)
        self.assertEqual(self.transport.sent, before)

    def test_requires_confirmed_session_current_epoch_owner_and_paused_output(self):
        self.prepare(confirm=False)
        before = list(self.transport.sent)
        with self.assertRaisesRegex(ValueError, 'Confirm the console'):
            self.level()
        self.action('confirm_session', only_host=True, session_ok=True)
        stale = self.tokens()
        self.action('pause')
        with self.assertRaisesRegex(ValueError, 'state changed'):
            self.level(**stale)
        with self.assertRaisesRegex(ValueError, 'Another browser'):
            self.controller.action('manual_channel_level', dict(channel=9, level=30, confirmed=True, **self.tokens()),
                                   'different-browser')
        self.controller.armed = True
        with self.assertRaisesRegex(ValueError, 'Pause automatic'):
            self.level()
        self.controller.armed = False
        self.clock.advance(8.1)
        with self.assertRaisesRegex(ValueError, 'current console feedback'):
            self.level()
        self.assertEqual(self.transport.sent, before)

    def test_rehearsal_dry_run_and_unresolved_zoom_block_channel_writes(self):
        self.prepare()
        before = list(self.transport.sent)
        self.controller.pending = [dict(endpoint=self.controller.endpoint(), address='/eos/chan/2/param/zoom/release')]
        with self.assertRaisesRegex(ValueError, 'Release the remembered Zoom override'):
            self.level()
        self.controller.pending.clear()
        self.action('config', config={**self.controller.config, 'dry_run': True})
        with self.assertRaisesRegex(ValueError, 'live console session'):
            self.level()
        self.action('start_rehearsal')
        with self.assertRaisesRegex(ValueError, 'Rehearsal is isolated'):
            self.level()
        self.assertEqual(self.transport.sent, before)

    def test_channel_level_and_cues_share_spacing_in_both_directions(self):
        self.prepare()
        self.level(level=0)
        with self.assertRaisesRegex(ValueError, 'Wait 2.0 seconds'):
            self.action('test_target', id='cue:1:888')
        self.clock.advance(2)
        self.action('test_target', id='cue:1:888')
        with self.assertRaisesRegex(ValueError, 'Wait 2.0 seconds'):
            self.level(level=100)
        self.clock.advance(2)
        self.level(channel=99999, level=100)
        self.assertEqual(self.transport.sent[-3:], [('/eos/chan/9/at', [0.0]),
                         ('/eos/cue/1/888/fire', []), ('/eos/chan/99999/at', [100.0])])

    def test_one_off_level_invalidates_an_awaiting_visible_result(self):
        self.prepare()
        self.action('test_target', id='cue:1:888')
        self.assertEqual(self.controller.pending_test, 'cue:1:888')
        self.clock.advance(2)
        self.level()
        with self.assertRaises(ValueError):
            self.action('confirm_target', id='cue:1:888', worked=True)
        self.assertFalse(self.controller.target_tests['cue:1:888']['confirmed'])

    def test_uncertain_write_keeps_the_spacing_after_reconnect(self):
        self.prepare()
        send = self.transport.send

        def fail_after_write(address, args=()):
            send(address, args)
            if address == '/eos/chan/9/at':
                self.clock.advance(.25)
                raise OSError('Transport lost after write')

        self.transport.send = fail_after_write
        with self.assertRaisesRegex(ValueError, 'Connection failed'):
            self.level()
        self.assertFalse(self.controller.connected)
        self.assertEqual(self.controller.cue_lane.last_at, self.clock())
        self.transport.send = send
        self.prepare()
        with self.assertRaisesRegex(ValueError, 'Wait 2.0 seconds'):
            self.level()
        self.assertEqual(self.transport.sent.count(('/eos/chan/9/at', [30.5])), 1)

    def test_channel_write_preserves_recent_cue_duplicate_window(self):
        self.prepare()
        self.controller.config['cue_interval_s'] = 1
        self.assertTrue(self.controller.cue(dict(cue_list=1, cue='888'), 'camera'))
        self.clock.advance(1)
        self.level()
        self.clock.advance(1)
        lane = self.controller.cue_lane
        intent = CueIntent('speech', 'same_cue', mapping_target(dict(cue_list=1,cue='888')), self.clock(),
                           self.controller.config_revision, self.controller.output_epoch, self.client)
        self.assertEqual(lane.offer(intent, self.clock(), 1), 'Duplicate output suppressed.')
        self.clock.advance(1)
        self.assertIsNone(lane.offer(intent, self.clock(), 1))

    def test_manual_zoom_and_color_can_leave_intensity_untouched(self):
        self.prepare()
        before = len(self.transport.sent)
        result = self.level(channel=28, level=None, zoom=0, color='#FF8800')
        self.assertEqual(self.transport.sent[before:], [
            ('/eos/chan/28/param/zoom', [0.0]), ('/eos/chan/28/color/rgb', [1.0, 136 / 255, 0.0]),
        ])
        self.assertEqual(result['channel_level'], dict(channel=28, level=None, zoom=0, color='#ff8800'))
        self.assertTrue(result['fixture_parameters_supported'])
        with self.assertRaisesRegex(ValueError, 'Wait 2.0 seconds'):
            self.level(channel=28, level=None, color='#ff8800')

    def test_incomplete_manual_change_does_not_continue_after_disconnect(self):
        self.prepare()
        before = len(self.transport.sent)
        send = self.transport.send

        def fail_after_color(address, args=()):
            send(address, args)
            if address.endswith('/color/rgb'):
                raise OSError('Lost connection during the channel change')

        self.transport.send = fail_after_color
        with self.assertRaisesRegex(ValueError, 'Connection failed'):
            self.level(channel=28, level=30, zoom=30, color='#ff8800')
        self.assertEqual(self.transport.sent[before:], [
            ('/eos/chan/28/param/zoom', [30.0]), ('/eos/chan/28/color/rgb', [1.0, 136 / 255, 0.0]),
        ])
        self.assertFalse(self.controller.connected)
        self.assertEqual(self.controller.cue_lane.last_at, self.clock())
        self.assertIsNone(self.controller.last_output)
