import unittest

from cue_output import CueIntent, CueLane
from mapping_outputs import mapping_target, output_key


def cue_target(cue):
    return mapping_target(dict(cue_list=1,cue=cue))


class CueLaneAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.lane = CueLane()
        self.lane.sent(output_key(cue_target('19')), 0, 'manual')
        self.camera = CueIntent('camera', 'Open_Palm', cue_target('12'), .7, 1, 1, 'owner', 'hand:1')
        self.assertIsNone(self.lane.offer(self.camera, .7, 2))

    def test_short_request_cannot_displace_a_cue_that_can_send(self):
        for source in ('speech', 'motion'):
            with self.subTest(source=source):
                request = CueIntent(source, 'stand_down', cue_target('13'), .9, 1, 1, 'owner')
                rejection = self.lane.offer(request, .9, 2)
                self.assertIn('expire before console spacing', rejection)
                self.assertIs(self.lane.pending, self.camera)
                self.assertEqual(self.lane.status['kind'], 'waiting')
                self.assertEqual(self.lane.status['cue'], '12')
        self.lane.expire(2.05)
        self.assertIs(self.lane.pending, self.camera)

    def test_equivalent_cue_cannot_extend_waiting_lifetime(self):
        duplicate = CueIntent('speech', 'light', cue_target('012.0'), 1.95, 1, 1, 'owner')
        self.assertIn('already waiting', self.lane.offer(duplicate, 1.95, 2))
        self.assertIs(self.lane.pending, self.camera)

    def test_latest_distinct_cue_that_can_send_still_takes_priority(self):
        request = CueIntent('speech', 'stand_down', cue_target('13'), 1.55, 1, 1, 'owner')
        self.assertIsNone(self.lane.offer(request, 1.55, 2))
        self.assertIs(self.lane.pending, request)
        self.assertEqual(self.lane.status['cue'], '13')
