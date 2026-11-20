"""Speech decoding is optional, resettable, local, and explicitly matched."""
import copy
import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from speech import (DEFAULT_SPEECH_MAPPINGS, MAX_PCM_BYTES, SAMPLE_RATE,
                    SpeechEngine, SpeechError, normalized_phrase,
                    validate_speech_mappings)


class FakeRecognizer:
    def __init__(self):
        self.final = False
        self.payload = {'partial': ''}
        self.calls = []

    def SetWords(self, enabled): self.calls.append(('words', enabled))
    def AcceptWaveform(self, pcm): self.calls.append(('pcm', pcm)); return self.final
    def PartialResult(self): self.calls.append(('partial',)); return json.dumps(self.payload)
    def Result(self): self.calls.append(('result',)); return json.dumps(self.payload)
    def Reset(self): self.calls.append(('reset',))
    def FinalResult(self): raise AssertionError('Unfinished speech must never be flushed')


class SpeechValidationTests(unittest.TestCase):
    def test_defaults_keep_the_five_user_phrases_unassigned_and_disabled(self):
        result = validate_speech_mappings(DEFAULT_SPEECH_MAPPINGS)
        self.assertEqual([row['phrase'] for row in result], [
            'there be light', 'Abracadabra', 'They shall not pass',
            'At my command', 'This will defend'])
        self.assertTrue(all(not row['enabled'] and not row['cue'] for row in result))
        self.assertIsNot(result[0], DEFAULT_SPEECH_MAPPINGS[0])

    def test_matching_normalizes_case_punctuation_and_spacing_only(self):
        self.assertEqual(normalized_phrase('  THEY  shall not pass!!! '), 'they shall not pass')
        self.assertEqual(normalized_phrase('There\u00a0be light.'), 'there be light')
        self.assertNotEqual(normalized_phrase('let there be light'), normalized_phrase('there be light'))
        self.assertNotEqual(normalized_phrase('they shall pass'), normalized_phrase('they shall not pass'))
        self.assertNotEqual(normalized_phrase('abra cadabra'), normalized_phrase('Abracadabra'))
        with self.assertRaises(ValueError): normalized_phrase(None)

    def test_rejects_duplicate_ids_and_equivalent_phrase_names(self):
        for change in [dict(id='speech_light'), dict(phrase='THERE BE LIGHT!!!')]:
            rows = copy.deepcopy(DEFAULT_SPEECH_MAPPINGS)
            rows[1].update(change)
            with self.assertRaises(ValueError): validate_speech_mappings(rows)

    def test_rejects_malformed_mapping_and_command_injection(self):
        for key, value in [('id', 'speech_/eos/cmd'), ('id', 'motion_light'),
                           ('phrase', ''), ('phrase', '!!!'), ('phrase', 'x' * 161),
                           ('phrase', 'hello\nworld'), ('phrase', 3),
                           ('enabled', 'true'), ('cue', '3/fire'), ('cue', '0'),
                           ('cue', '123456'), ('cue_list', 0), ('cue_list', True),
                           ('cue_list', 1.5), ('cue_list', float('nan'))]:
            with self.subTest(key=key, value=value):
                rows = copy.deepcopy(DEFAULT_SPEECH_MAPPINGS)
                rows[0][key] = value
                with self.assertRaises(ValueError): validate_speech_mappings(rows)
        with self.assertRaises(ValueError): validate_speech_mappings({})
        with self.assertRaises(ValueError): validate_speech_mappings([None])
        with self.assertRaises(ValueError): validate_speech_mappings([{}] * 51)

    def test_enabled_phrase_needs_cue_and_decimal_cues_are_valid(self):
        rows = copy.deepcopy(DEFAULT_SPEECH_MAPPINGS)
        rows[0]['enabled'] = True
        with self.assertRaises(ValueError): validate_speech_mappings(rows)
        rows[0].update(cue=' 999.5 ', cue_list='2')
        result = validate_speech_mappings(rows)
        self.assertEqual((result[0]['cue'], result[0]['cue_list']), ('999.5', 2))


class SpeechEngineTests(unittest.TestCase):
    def setUp(self):
        self.recognizers = []
        self.phrases = []

        def factory(phrases, sample_rate):
            self.phrases.append((phrases, sample_rate))
            recognizer = FakeRecognizer()
            self.recognizers.append(recognizer)
            return recognizer

        self.engine = SpeechEngine('not-a-real-model', recognizer_factory=factory)

    def start(self):
        self.engine.start(['there be light', 'Abracadabra'])
        return self.recognizers[-1]

    def test_status_does_not_import_a_decoder_or_load_a_model(self):
        engine = SpeechEngine('not-a-real-model/missing')
        with patch('speech.importlib.util.find_spec', return_value=None):
            status = engine.status()
            self.assertFalse(status['available'])
            self.assertFalse(status['running'])
            self.assertIn('Setup speech recognition', status['reason'])
        self.assertTrue(self.engine.available)
        self.assertFalse(self.engine.running)

    def test_start_uses_requested_phrases_and_fixed_pcm_format(self):
        recognizer = self.start()
        self.assertEqual(self.phrases, [(['there be light', 'abracadabra'], SAMPLE_RATE)])
        self.assertIn(('words', True), recognizer.calls)
        self.assertTrue(self.engine.status()['running'])

    def test_decoder_inventory_accepts_alternatives_in_addition_to_fifty_saved_phrases(self):
        phrases = [f'Show phrase {index}' for index in range(50)]
        phrases.extend(['white lights', 'magic shift', 'shield up', 'take command', 'lights out'])
        self.engine.start(phrases)
        self.assertEqual(len(self.phrases[-1][0]), len(phrases))

    def test_partial_result_cannot_earn_command_confidence(self):
        recognizer = self.start()
        recognizer.payload = {'partial': 'there be light', 'result': [{'word': 'there', 'conf': 1}]}
        result = self.engine.feed(b'\0\0' * 1600)
        self.assertEqual(result, dict(final=False, text='there be light', confidence=0.0, words=[]))
        self.assertIn(('partial',), recognizer.calls)
        self.assertNotIn(('result',), recognizer.calls)

    def test_final_confidence_uses_the_weakest_word(self):
        recognizer = self.start()
        recognizer.final = True
        recognizer.payload = dict(text='there be light', result=[
            dict(word='there', conf=.99), dict(word='be', conf=.6), dict(word='light', conf=.9)])
        result = self.engine.feed(b'\0\0' * 1600)
        self.assertTrue(result['final'])
        self.assertEqual(result['text'], 'there be light')
        self.assertEqual(result['confidence'], .6)
        self.assertEqual(len(result['words']), 3)

    def test_missing_or_incomplete_word_evidence_has_zero_confidence(self):
        recognizer = self.start()
        recognizer.final = True
        for words in [[], [dict(word='light', conf=1)]]:
            recognizer.payload = dict(text='there be light', result=words)
            self.assertEqual(self.engine.feed(b'\0\0')['confidence'], 0)

    def test_reset_and_stop_discard_without_finalizing_utterance(self):
        recognizer = self.start()
        self.engine.reset()
        self.assertEqual(recognizer.calls[-1], ('reset',))
        self.engine.stop()
        self.assertFalse(self.engine.running)
        with self.assertRaises(SpeechError): self.engine.feed(b'\0\0')
        self.engine.reset()  # A stopped decoder has nothing left to flush.
        self.start()
        self.assertEqual(len(self.recognizers), 2)

    def test_starting_again_replaces_the_old_decoder(self):
        first = self.start()
        self.engine.start(['At my command'])
        self.assertIsNot(self.recognizers[-1], first)
        self.assertEqual(self.phrases[-1], (['at my command'], SAMPLE_RATE))
        self.assertNotIn(('reset',), first.calls)

    def test_rejects_bad_audio_before_decoder_receives_it(self):
        recognizer = self.start()
        for pcm in [b'', b'\0', b'\0' * (MAX_PCM_BYTES + 2), 'pcm', [0, 0]]:
            with self.subTest(pcm_type=type(pcm).__name__):
                with self.assertRaises(SpeechError): self.engine.feed(pcm)
        self.assertEqual(recognizer.calls, [('words', True)])

    def test_invalid_decoder_results_fail_closed_and_require_restart(self):
        for payload in [[], {'text': 3}, {'text': 'light', 'result': [{'word': 'light', 'conf': float('nan')}]},
                        {'text': 'light', 'result': [{'word': 'light', 'conf': True}]}]:
            with self.subTest(payload=payload):
                recognizer = self.start()
                recognizer.final = True
                recognizer.payload = payload
                with self.assertRaises(SpeechError): self.engine.feed(b'\0\0')
                self.assertFalse(self.engine.running)
                self.assertIn('Restart', self.engine.status()['reason'])

    def test_missing_model_and_bad_phrase_start_are_actionable(self):
        engine = SpeechEngine('missing-local-model')
        with self.assertRaisesRegex(SpeechError, 'model is missing'): engine.start(['light'])
        for phrases in [[], [''], ['x' * 161], 'light']:
            with self.subTest(phrases=phrases):
                with self.assertRaises(SpeechError): self.engine.start(phrases)

    def test_known_words_do_not_force_similar_speech_into_a_configured_phrase(self):
        created = []
        model = SimpleNamespace(vosk_model_find_word=lambda word: 1)

        def recognizer(*args):
            created.append(args)
            return FakeRecognizer()

        module = SimpleNamespace(Model=lambda path: model,
                                 KaldiRecognizer=recognizer, SetLogLevel=lambda level: None)
        engine = SpeechEngine('installed-local-model')
        with patch.object(engine, '_model_available', return_value=True), patch.dict('sys.modules', vosk=module):
            engine.start(['there be light', 'Abracadabra'])
        self.assertEqual(created[0], (model, SAMPLE_RATE), 'No restrictive phrase grammar is passed to the decoder')
        self.assertEqual(engine.status()['grammar_mode'], 'general vocabulary')
        self.assertEqual(engine.status()['unknown_words'], [])

    def test_missing_vocabulary_does_not_silently_drop_a_phrase_word(self):
        created = []
        model = SimpleNamespace(vosk_model_find_word=lambda word: -1 if word == 'abracadabra' else 1)

        def recognizer(*args):
            created.append(args)
            return FakeRecognizer()

        module = SimpleNamespace(Model=lambda path: model,
                                 KaldiRecognizer=recognizer, SetLogLevel=lambda level: None)
        engine = SpeechEngine('installed-local-model')
        with patch.object(engine, '_model_available', return_value=True), patch.dict('sys.modules', vosk=module):
            engine.start(['there be light', 'Abracadabra'])
        self.assertEqual(created[0], (model, SAMPLE_RATE))
        self.assertEqual(engine.status()['grammar_mode'], 'general vocabulary')
        self.assertEqual(engine.status()['unknown_words'], ['abracadabra'])


if __name__ == '__main__': unittest.main()
