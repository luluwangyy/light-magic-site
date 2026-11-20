"""A cue requires a deliberate closed-fist -> open-palm cycle."""
import unittest

from app import FistPalmGate


class FistPalmGateTests(unittest.TestCase):
    def setUp(self):
        self.mapping = dict(gesture='Open_Palm', enabled=True, cue_list=1,
                            cue='999', confidence=.8, hold_s=.6,
                            label='Open palm after closed fist')
        self.mappings = [self.mapping]
        self.gate = FistPalmGate()

    def update(self, name, now, confidence=.99):
        return self.gate.update(name, confidence, self.mappings, now)

    def close(self, start=0):
        self.assertIsNone(self.update('Closed_Fist', start))
        self.assertIsNone(self.update('Closed_Fist', start+.15))
        self.assertIsNone(self.update('Closed_Fist', start+.31))

    def open(self, start=.4):
        self.assertIsNone(self.update('Open_Palm', start))
        self.assertIsNone(self.update('Open_Palm', start+.3))
        return self.update('Open_Palm', start+.61)

    def test_open_palm_alone_never_fires(self):
        self.assertIsNone(self.open())
        self.assertIsNone(self.update('Open_Palm', 3))

    def test_low_confidence_fist_does_not_prepare_trigger(self):
        self.update('Closed_Fist', 0, .79)
        self.update('Closed_Fist', .5, .79)
        self.assertIsNone(self.open(.6))

    def test_short_fist_does_not_prepare_trigger(self):
        self.update('Closed_Fist', 0)
        self.update('Closed_Fist', .2)
        self.assertIsNone(self.open(.21))

    def test_close_then_open_fires_once_while_palm_is_held(self):
        self.close()
        self.assertEqual(self.open(), self.mapping)
        for now in (1.2, 2, 3, 10):
            self.assertIsNone(self.update('Open_Palm', now))

    def test_neutral_alone_cannot_rearm_after_firing(self):
        self.close()
        self.assertEqual(self.open(), self.mapping)
        self.update('None', 1.2, 0)
        self.update('None', 1.6, 0)
        self.assertIsNone(self.open(1.7))

    def test_second_complete_close_open_cycle_fires_again(self):
        self.close()
        self.assertEqual(self.open(), self.mapping)
        self.close(1.5)
        self.assertEqual(self.open(1.9), self.mapping)

    def test_brief_unknown_during_unfolding_is_tolerated(self):
        self.close()
        self.update('None', .4, 0)
        self.assertEqual(self.open(.5), self.mapping)

    def test_hand_loss_after_closing_requires_another_fist(self):
        self.close()
        self.update('None', .4, 0)
        self.update('None', .71, 0)
        self.assertIsNone(self.open(.8))

    def test_short_open_pose_does_not_fire(self):
        self.close()
        self.update('Open_Palm', .4)
        self.assertIsNone(self.update('Open_Palm', .9))


if __name__ == '__main__':
    unittest.main()
