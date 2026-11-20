"""Exercise the live audio boundaries without native speech dependencies."""
import json
import threading
import time
import unittest
from unittest.mock import patch

from speech import SpeechEngine, SpeechError
from speech_enhanced import (BoundedSpeechDecoder, END_FRAMES, FRAME_BYTES,
                             MAX_RESULT_AGE, StreamingVoskObservations, Utterance,
                             VoiceEndpoint, evidence_score,
                             load_vosk_observation_decoder)


VOICE = b'\1\0' * (FRAME_BYTES // 2)
QUIET = bytes(FRAME_BYTES)


def voice_detector(frame):
    if len(frame) not in (FRAME_BYTES, FRAME_BYTES // 2):
        raise AssertionError('Unexpected VAD frame size')
    return bool(frame[0])


def word_result(utterance):
    return dict(final=True, text='At my command American',
                words=[dict(word=w, conf=.92) for w in ('At', 'my', 'command', 'American')],
                confidence=.92, utterance=utterance.number,
                prefix_only=utterance.prefix_only, quality_ok=True)


class EndpointTests(unittest.TestCase):
    def test_noise_bursts_do_not_create_a_phrase(self):
        endpoint = VoiceEndpoint(voice_detector, True)
        self.assertEqual(endpoint.push((VOICE + QUIET * 8) * 200), [])
        self.assertFalse(endpoint.active)

    def test_prefix_and_final_share_one_utterance_without_hard_splitting(self):
        endpoint = VoiceEndpoint(voice_detector, True)
        self.assertEqual(endpoint.push(VOICE * 60), [])
        early = endpoint.push(VOICE * 80)
        self.assertEqual(len(early), 1)
        self.assertTrue(early[0].prefix_only)
        self.assertEqual(endpoint.push(VOICE * 200), [])
        final = endpoint.push(QUIET * 25)
        self.assertEqual(len(final), 1)
        self.assertFalse(final[0].prefix_only)
        self.assertEqual(early[0].number, final[0].number)
        self.assertLess(len(early[0].pcm), len(final[0].pcm))

    def test_overlong_speech_does_not_finalize_an_arbitrary_tail(self):
        endpoint = VoiceEndpoint(voice_detector, False)
        self.assertEqual(endpoint.push(VOICE * 800), [])
        self.assertTrue(endpoint.overflow)
        self.assertEqual(len(endpoint.audio), 0)
        self.assertEqual(endpoint.push(QUIET * 25), [])
        self.assertEqual(len(endpoint.push(VOICE * 25 + QUIET * 25)), 1)

    def test_packet_fragments_and_pause_are_handled_by_sample_count(self):
        endpoint = VoiceEndpoint(voice_detector, False)
        signal = VOICE * 25 + QUIET * 24
        events = []
        for i in range(0, len(signal), 320):
            events.extend(endpoint.push(signal[i:i+320]))
        self.assertEqual(len(events), 1)
        self.assertFalse(events[0].prefix_only)


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.load_started = threading.Event()
        self.load_release = threading.Event()
        self.decode_started = threading.Event()
        self.decode_release = threading.Event()
        self.now = 30

        def decode(item):
            self.decode_started.set()
            self.decode_release.wait(timeout=3)
            return word_result(item)

        def load(path):
            self.load_started.set()
            self.load_release.wait(timeout=3)
            return decode

        self.engine = BoundedSpeechDecoder('unused', loader=load, detector_factory=lambda: voice_detector,
                                           clock=lambda: self.now)
        self.addCleanup(self.load_release.set)
        self.addCleanup(self.decode_release.set)

    def wait_task(self):
        self.engine._task.result(timeout=3)

    def warm_up(self):
        self.engine.start(True)
        self.load_release.set()
        self.wait_task()
        self.engine.feed(QUIET)

    def start_phrase(self):
        for packet in (VOICE * 10, VOICE * 10, QUIET * 10, QUIET * 10, QUIET * 10):
            self.engine.feed(packet)
        self.assertTrue(self.decode_started.wait(timeout=2))

    def test_start_and_packets_return_while_model_loads(self):
        self.engine.start(True)
        self.assertTrue(self.load_started.wait(timeout=2))
        self.assertFalse(self.engine._task.done())
        self.assertTrue(self.engine.status()['loading'])
        self.assertFalse(self.engine.feed(VOICE * 10)['final'])
        self.assertFalse(self.engine._task.done())
        self.load_release.set()
        self.wait_task()
        self.assertFalse(self.engine.feed(QUIET)['final'])
        self.assertFalse(self.engine.status()['loading'])

    def test_decode_does_not_block_capture_and_overflow_is_not_replayed(self):
        self.warm_up()
        self.start_phrase()
        self.assertTrue(self.engine.status()['processing'])
        self.assertFalse(self.engine._task.done())
        self.start_phrase()
        self.assertEqual(self.engine.status()['dropped_utterances'], 1)
        self.decode_release.set()
        self.wait_task()
        result = self.engine.feed(QUIET)
        self.assertTrue(result['final'])
        self.assertEqual(result['utterance'], 1)
        self.assertFalse(self.engine.feed(QUIET)['final'])

    def test_reset_and_restart_never_deliver_retired_results(self):
        self.warm_up()
        self.start_phrase()
        self.engine.stop()
        self.engine.start(True)
        self.assertFalse(self.engine.status()['processing'])
        self.decode_release.set()
        self.wait_task()
        self.assertFalse(self.engine.feed(QUIET)['final'])
        self.engine.reset()
        self.start_phrase()
        self.wait_task()
        self.assertEqual(self.engine.feed(QUIET)['utterance'], 2)

    def test_delayed_decoding_cannot_produce_a_cue(self):
        self.warm_up()
        self.start_phrase()
        self.now += MAX_RESULT_AGE + .05
        self.decode_release.set()
        self.wait_task()
        self.assertFalse(self.engine.feed(QUIET)['final'])
        self.assertIn('too long', self.engine.status()['audio_hint'])

    def test_live_quiet_check_rejects_voice_and_partial_frames(self):
        self.warm_up()
        self.assertTrue(self.engine.quiet_audio(QUIET * 3))
        self.assertFalse(self.engine.quiet_audio(QUIET + VOICE))
        self.assertFalse(self.engine.quiet_audio(bytes(318)))


class BackendTests(unittest.TestCase):
    def test_light_contrast_can_only_veto_general_recognition(self):
        primary = 'let there be light'
        contrast, contrast_confidence = '', .99

        def words(text, confidence):
            return [dict(word=word, conf=confidence, start=index*.1, end=(index+1)*.1)
                    for index, word in enumerate(text.split())]

        calls = []

        def recognize(_pcm, grammar=None):
            calls.append(grammar)
            return words(contrast, contrast_confidence) if grammar else words(primary, .99)

        with (patch('speech_enhanced._secondary_decoder', return_value=recognize),
              patch('speech_enhanced.Path.is_file', return_value=True)):
            decoder = load_vosk_observation_decoder('unused')
            for contrast in ('let there be lights', 'let there be night',
                             'let there be a light', 'let there be light light'):
                with self.subTest(contrast=contrast):
                    calls.clear()
                    rejected = decoder(Utterance(1, VOICE*30))
                    self.assertFalse(rejected['quality_ok'])
                    self.assertEqual(rejected['confidence'], 0)
                    self.assertEqual(rejected['reject_reason'], 'light-ending')
                    self.assertEqual(len(calls), 2)
                    self.assertIn('let there be a light', json.loads(calls[-1]))
            contrast_confidence = .75
            self.assertTrue(decoder(Utterance(1, VOICE*30))['quality_ok'])
            primary = 'let there be night'
            calls.clear()
            self.assertEqual(decoder(Utterance(2, VOICE*30))['text'], primary)
            self.assertEqual(calls, [None])

    def test_auto_prefers_low_latency_standard_and_user_can_switch(self):
        engine = SpeechEngine('vosk')
        with (patch.object(SpeechEngine, 'enhanced_available', True),
              patch.object(SpeechEngine, 'standard_available', True)):
            self.assertEqual(engine.backend, 'vosk')
            engine.select_backend('enhanced')
            self.assertEqual(engine.backend, 'enhanced')
            engine.select_backend('vosk')
            self.assertEqual(engine.status()['backend'], 'vosk')
            self.assertEqual(engine.status()['backend_preference'], 'vosk')

    def test_selected_enhanced_unavailable_fails_without_silent_model_switch(self):
        engine = SpeechEngine('missing', backend='enhanced')
        self.assertFalse(engine.available)
        with self.assertRaisesRegex(SpeechError, 'Enhanced speech is not installed'):
            engine.start(['Stand down'])
        self.assertFalse(engine.running)
        self.assertEqual(engine.backend, 'enhanced')

    def test_effective_standard_identity_contains_model_and_endpoint_policy(self):
        engine = SpeechEngine('models/model-a', backend='vosk')
        with patch.object(engine, '_package_available', return_value=True):
            original = engine.recognition_id
            engine.set_leading_command(True)
            self.assertNotEqual(engine.recognition_id, original)
            self.assertIn('model-a', engine.recognition_id)
            self.assertIn('observations', engine.recognition_id)


class StreamingWorkerTests(unittest.TestCase):
    def setUp(self):
        advance_started = self.advance_started = threading.Event()
        release_advance = self.release_advance = threading.Event()
        decoded = self.decoded = []
        self.now = 30

        class Decoder:
            def advance(self, item):
                advance_started.set()
                release_advance.wait(timeout=3)

            def __call__(self, item):
                decoded.append(item)
                return word_result(item)

        self.engine = BoundedSpeechDecoder('unused', loader=lambda _: Decoder(),
                                           detector_factory=lambda: voice_detector,
                                           clock=lambda: self.now, stream_audio=True)
        self.addCleanup(release_advance.set)
        self.engine.start(False)
        self.engine._task.result(timeout=3)
        self.assertFalse(self.engine.feed(VOICE * 20)['final'])
        self.assertTrue(advance_started.wait(timeout=3))

    def test_completed_observation_waits_for_its_audio_without_early_finalizing(self):
        self.assertFalse(self.engine.feed(QUIET * (END_FRAMES - 1))['final'])
        self.assertFalse(self.engine.status()['processing'])
        self.assertFalse(self.engine.feed(QUIET)['final'])
        self.assertTrue(self.engine.status()['processing'])
        self.release_advance.set()
        self.engine._task.result(timeout=3)
        self.assertFalse(self.engine.feed(QUIET)['final'])
        self.engine._task.result(timeout=3)
        result = self.engine.feed(QUIET)
        self.assertTrue(result['final'])
        self.assertEqual(self.decoded[0].pcm, VOICE * 20 + QUIET * 7)
        self.assertFalse(self.engine.feed(QUIET)['final'])

    def test_reset_discards_an_observation_waiting_for_streamed_audio(self):
        self.engine.feed(QUIET * END_FRAMES)
        self.engine.reset()
        self.release_advance.set()
        self.engine._task.result(timeout=3)
        self.assertFalse(self.engine.feed(QUIET)['final'])
        self.assertEqual(self.decoded, [])

    def test_stale_waiting_observation_does_not_begin_decoding(self):
        self.engine.feed(QUIET * END_FRAMES)
        self.now += MAX_RESULT_AGE + .1
        self.release_advance.set()
        self.engine._task.result(timeout=3)
        self.assertFalse(self.engine.feed(QUIET)['final'])
        self.assertEqual(self.decoded, [])
        self.assertEqual(self.engine.status()['dropped_utterances'], 1)


class StandardObservationTests(unittest.TestCase):
    def test_streamed_observation_reuses_exact_audio_and_keeps_prefix_independent(self):
        recognizers = []

        class Recognizer:
            def __init__(self, grammar=None):
                self.audio = []
                recognizers.append(self)

            def AcceptWaveform(self, pcm):
                self.audio.append(pcm)

            def FinalResult(self):
                words = [dict(word='speech', start=.0, end=.1, conf=.9)]
                return json.dumps(dict(text='speech', result=words))

        with patch('speech_enhanced._vosk_recognizers', return_value=Recognizer):
            decode = StreamingVoskObservations('unused')
        beginning = VOICE * 20
        middle = QUIET * 15 + VOICE * 15
        tail = QUIET * 7
        decode.advance(Utterance(1, beginning))
        prefix = decode(Utterance(1, beginning + middle, True))
        decode.advance(Utterance(1, beginning + middle))
        final = decode(Utterance(1, beginning + middle + tail))
        self.assertTrue(prefix['prefix_only'])
        self.assertTrue(final['quality_ok'])
        self.assertEqual(recognizers[0].audio, [beginning, middle, tail])
        self.assertEqual(recognizers[1].audio, [beginning + middle])

    def test_prefix_requires_a_complete_suffix_word(self):
        words = [
            dict(word='at', start=.2, end=.3, conf=.94),
            dict(word='my', start=.3, end=.4, conf=.94),
            dict(word='command', start=.4, end=.9, conf=.94),
            dict(word='american', start=1.7, end=2.39, conf=.90),
        ]
        with patch('speech_enhanced._secondary_decoder', return_value=lambda pcm: words):
            decode = load_vosk_observation_decoder('unused')
        clip = bytes(120 * FRAME_BYTES)
        prefix = decode(Utterance(7, clip, True))
        final = decode(Utterance(7, clip))
        self.assertEqual(prefix['text'], 'at my command')
        self.assertEqual(prefix['confidence'], 0)
        self.assertEqual(final['utterance'], prefix['utterance'])
        self.assertEqual(final['text'], 'at my command american')


class AcousticEvidenceTests(unittest.TestCase):
    @staticmethod
    def words(text, *scores):
        return [dict(word=word, conf=score) for word, score in zip(text.split(), scores)]

    def test_independent_agreement_can_recover_a_weak_but_correct_onset(self):
        primary = self.words('Stand down.', .34, .9)
        secondary = self.words('stand down', .98, .97)
        self.assertGreaterEqual(evidence_score(primary, secondary, acoustic=.47,
                                                silence=.03, compression=1.2), .7)
        self.assertLess(evidence_score(primary, [], acoustic=.47,
                                        silence=.03, compression=1.2), .7)

    def test_disagreement_on_plurals_and_negation_is_never_corroboration(self):
        for first, second in (('let there be light', 'let there be lights'),
                              ('they shall not pass', 'they shall all pass')):
            with self.subTest(second=second):
                primary = self.words(first, .98, .98, .98, .98)
                secondary = self.words(second, .99, .99, .99, .99)
                self.assertLess(evidence_score(primary, secondary, acoustic=.85,
                                               silence=.01, compression=1.1), .6)

    def test_identical_sounding_magic_word_spellings_agree_only_as_a_whole(self):
        primary = self.words('Abra Kadabra.', .51, .85)
        secondary = self.words('abracadabra', .99)
        args = dict(acoustic=.58, silence=.03, compression=1.2)
        self.assertGreater(evidence_score(primary, secondary, **args), .7)
        self.assertLess(evidence_score(primary + self.words('please', .96), secondary, **args), .6)

    def test_prefix_scoring_considers_the_leading_evidence_only(self):
        primary = self.words('At my command, American forces', .5, .98, .95, .95, .15)
        secondary = self.words('at my command some fighters', .99, .99, .95, .81, .8)
        args = dict(acoustic=.6, silence=.02, compression=1.3)
        self.assertLess(evidence_score(primary, secondary, **args), .7)
        self.assertGreater(evidence_score(primary, secondary, limit=3, **args), .7)

    def test_silence_and_invalid_evidence_cannot_be_rescued_by_agreement(self):
        primary = self.words('stand down', .98, .98)
        self.assertEqual(evidence_score(primary, primary, acoustic=.82,
                                         silence=.9, compression=1.1), 0)
        self.assertEqual(evidence_score(primary, self.words('stand down', float('nan'), .9),
                                         acoustic=.82, silence=.02, compression=1.1), 0)


if __name__ == '__main__':
    unittest.main()
