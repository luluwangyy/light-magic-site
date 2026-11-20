import math
import unittest
from decimal import Decimal

from mapping_outputs import mapping_target, output_key, validate_mapping_output


class MappingOutputTests(unittest.TestCase):
    def test_legacy_cues_keep_their_receipt_id_and_numeric_dedupe(self):
        legacy = dict(cue_list=1, cue='012.00', enabled=True)
        self.assertEqual(validate_mapping_output(legacy, required=True), {})
        target = mapping_target(legacy)
        self.assertEqual(target, dict(id='cue:1:012.00', output_type='cue', cue_list=1,
                                      cue='012.00', command='Cue 012.00 (list 1)'))
        self.assertEqual(output_key(target), ('cue', 1, Decimal('12')))
        self.assertEqual(output_key(target), output_key(mapping_target(dict(cue_list=1, cue='12'))))

    def test_switching_the_output_preserves_both_destinations(self):
        mapping = dict(cue_list=4, cue='12.3', channel='09', level='30.250', enabled=True)
        mapping.update(validate_mapping_output(mapping, required=True))
        self.assertEqual(mapping['output_type'], 'cue')
        self.assertEqual(mapping_target(mapping)['id'], 'cue:4:12.3')

        mapping['output_type'] = 'channel_level'
        mapping.update(validate_mapping_output(mapping, required=True))
        self.assertEqual(mapping_target(mapping),
                         dict(id='channel_level:9:30.25', output_type='channel_level',
                              channel=9, level=30.25, command='Chan 9 @ 30.25'))
        self.assertEqual((mapping['cue_list'], mapping['cue']), (4, '12.3'))
        self.assertNotEqual(output_key(mapping_target(mapping)),
                            output_key(mapping_target(dict(cue_list=9, cue='30.25'))))

    def test_zero_level_is_an_assigned_output_and_has_one_identity(self):
        targets = []
        for zero in ('-0.00', 0, 0.0):
            mapping = validate_mapping_output(dict(output_type='channel_level', channel=9, level=zero),
                                              required=True)
            self.assertEqual(math.copysign(1, mapping['level']), 1)
            targets.append(mapping_target(mapping))
        self.assertEqual(targets[0], targets[1])
        self.assertEqual(targets[1], targets[2])
        self.assertEqual(targets[0]['id'], 'channel_level:9:0')
        self.assertEqual(output_key(targets[0]), ('channel_level', 9, 0.0))
        self.assertNotEqual(output_key(targets[0]),
                            output_key(mapping_target(dict(output_type='channel_level', channel=9, level=100))))

    def test_unassigned_selected_channel_does_not_fall_back_to_a_cue(self):
        row = dict(output_type='channel_level', cue_list=1, cue='12', channel=' ', level=None)
        self.assertEqual(validate_mapping_output(row), dict(output_type='channel_level', channel='', level=None))
        self.assertIsNone(mapping_target(row | validate_mapping_output(row)))
        with self.assertRaisesRegex(ValueError, 'Assign a channel and level'):
            validate_mapping_output(row, required=True)

    def test_rejects_invalid_channels_and_levels_even_in_inactive_fields(self):
        for channel in (False, 0, 100000, 1.5, '9.0000000000000001', float('inf'), []):
            with self.subTest(channel=channel), self.assertRaisesRegex(ValueError, 'whole channel'):
                validate_mapping_output(dict(output_type='cue', channel=channel))
        for level in (True, -1, 101, float('nan'), 'Infinity', {}):
            with self.subTest(level=level), self.assertRaisesRegex(ValueError, '0 to 100'):
                validate_mapping_output(dict(output_type='cue', level=level))
        with self.assertRaisesRegex(ValueError, 'Choose Cue or Channel level'):
            validate_mapping_output(dict(output_type='raw'))

    def test_zoom_and_color_are_optional_and_part_of_the_output_identity(self):
        raw = dict(output_type='channel_level', channel=28, zoom='0.0', color=' #FF8800 ')
        mapping = validate_mapping_output(raw, required=True)
        target = mapping_target(mapping)
        self.assertEqual(target['id'], 'channel_level:28::zoom:0:color:ff8800')
        self.assertEqual(target['command'], 'Chan 28 · Zoom 0% · #ff8800')
        self.assertIsNone(target['level'])
        self.assertEqual(output_key(target), output_key(mapping_target(validate_mapping_output(
            raw | {'color': '#ff8800', 'zoom': 0}))))
        self.assertNotEqual(output_key(target), output_key(mapping_target(mapping | {'zoom': 1})))
        self.assertNotEqual(output_key(target), output_key(mapping_target(mapping | {'color': '#ffff00'})))
        self.assertNotEqual(output_key(target), output_key(mapping_target(mapping | {'level': 0})))
        for fields in ({'zoom': True}, {'zoom': float('nan')}, {'zoom': -1}, {'zoom': 100.1},
                       {'color': '#abc'}, {'color': 'red'}, {'color': '#000000ff'}, {'color': []}):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                validate_mapping_output(raw | fields, required=True)

    def test_multi_channel_look_has_a_canonical_identity(self):
        mapping = dict(output_type='channel_look', channels=[
            dict(channel=28, level=0, zoom=0, color='#FFAA00'),
            dict(channel='009', level='45.00'),
        ])
        target = mapping_target(validate_mapping_output(mapping, required=True))
        self.assertEqual(target['channels'], [
            dict(channel=9, level=45.0),
            dict(channel=28, level=0.0, zoom=0.0, color='#ffaa00'),
        ])
        self.assertEqual(target['command'], 'Channel look · 2 channels')
        reordered = mapping | {'channels': list(reversed(mapping['channels']))}
        self.assertEqual(target, mapping_target(validate_mapping_output(reordered, required=True)))
        changed = mapping | {'channels': [dict(channel=9, level=46), mapping['channels'][0]]}
        self.assertNotEqual(output_key(target), output_key(mapping_target(changed)))
        single = mapping_target(dict(output_type='channel_level', channel=9, level=45))
        one_channel_look = mapping_target(dict(output_type='channel_look', channels=[dict(channel=9, level=45)]))
        self.assertEqual(output_key(single), output_key(one_channel_look))

    def test_look_rejects_duplicate_incomplete_and_excess_channels(self):
        raw = {'output_type': 'channel_look'}
        self.assertIsNone(mapping_target(validate_mapping_output(raw)))
        for rows in (
            [],
            None,
            [dict(channel=1), dict(channel=2, level=0)],
            [dict(channel=1, level=0), dict(channel='01', zoom=0)],
            [dict(channel=index, level=100) for index in range(1, 34)],
        ):
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                validate_mapping_output(raw | {'channels': rows}, required=True)


if __name__ == '__main__':
    unittest.main()
