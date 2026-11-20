"""Both learned hand poses can fire their own cue once per deliberate pose."""
import unittest

from app import FistPalmGate


class ClosedCueTests(unittest.TestCase):
    def setUp(self):
        self.closed = dict(gesture='Closed_Fist', enabled=True, cue_list=1,
                           cue='888', confidence=.8, hold_s=.6, label='Closed hand')
        self.opened = dict(gesture='Open_Palm', enabled=True, cue_list=1,
                           cue='1000', confidence=.8, hold_s=.6, label='Open hand')
        self.mappings = [self.closed, self.opened]
        self.gate = FistPalmGate()

    def update(self, name, now, confidence=.99):
        return self.gate.update(name, confidence, self.mappings, now)

    def fist(self, start=0):
        self.assertIsNone(self.update('Closed_Fist', start))
        self.assertIsNone(self.update('Closed_Fist', start+.31))
        return self.update('Closed_Fist', start+.61)

    def palm(self, start=1):
        self.assertIsNone(self.update('Open_Palm', start))
        self.assertIsNone(self.update('Open_Palm', start+.31))
        return self.update('Open_Palm', start+.61)

    def test_stable_closed_fist_fires_888_once(self):
        self.assertEqual(self.fist(), self.closed)
        for now in (1, 2, 3, 10):
            self.assertIsNone(self.update('Closed_Fist', now))

    def test_fist_also_prepares_the_existing_palm_trigger(self):
        self.update('Closed_Fist', 0)
        self.update('Closed_Fist', .31)
        self.assertTrue(self.gate.ready)
        self.assertEqual(self.update('Closed_Fist', .61), self.closed)
        self.assertTrue(self.gate.ready)
        self.assertEqual(self.palm(1), self.opened)
        for now in (2, 3, 10):
            self.assertIsNone(self.update('Open_Palm', now))

    def test_alternating_fist_palm_fist_uses_the_correct_cues(self):
        self.assertEqual(self.fist(), self.closed)
        self.assertEqual(self.palm(1), self.opened)
        self.assertEqual(self.fist(2), self.closed)

    def test_global_cooldown_applies_between_the_two_pose_cues(self):
        self.assertEqual(self.fist(), self.closed)
        self.update('Open_Palm', .65)
        self.assertIsNone(self.update('Open_Palm', 1.27))
        self.assertEqual(self.update('Open_Palm', 1.53), self.opened)

    def test_disabled_closed_mapping_preserves_fist_then_palm_behavior(self):
        self.closed['enabled'] = False
        self.assertIsNone(self.fist())
        self.assertEqual(self.palm(1), self.opened)

    def test_low_confidence_fist_cannot_fire_or_prepare(self):
        for now in (0, .31, .61, 1):
            self.assertIsNone(self.update('Closed_Fist', now, .79))
        self.assertFalse(self.gate.ready)
        self.assertIsNone(self.palm(1.2))

    def test_brief_closed_pose_does_not_fire_888(self):
        self.update('Closed_Fist', 0)
        self.assertIsNone(self.update('Closed_Fist', .2))
        self.assertIsNone(self.update('None', .21, 0))
        self.assertIsNone(self.update('Open_Palm', .4))
        self.assertIsNone(self.update('Open_Palm', 1.1))


if __name__ == '__main__':
    unittest.main()
