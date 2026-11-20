"""Optional local recognition with bounded audio, voice detection and a CPU worker.

The decoder never sees the cue vocabulary. It transcribes sound, and the
controller decides whether the transcript exactly matches an allowed cue.
"""
from collections import deque
from concurrent.futures import Future
from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import threading
import time
import unicodedata


SAMPLE_RATE = 16000
FRAME_BYTES = 640                       # 20 ms of PCM16LE.
VOSK_BLOCK_BYTES = SAMPLE_RATE * 2 // 5  # Vosk advances in 200 ms blocks.
MODEL_NAME = 'faster-whisper-base.en'
MODEL_FILES = ('config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt')
PREFIX_FRAMES = 120                     # 2.4 s, including onset padding.
END_FRAMES = 22                         # 440 ms without detected voice.
MAX_FRAMES = 600                        # Keep at most 12 s of one utterance.
MAX_RESULT_AGE = 1.5                   # Never fire a delayed transcript.
LIGHT_PHRASE = 'let there be light'
LIGHT_CONTRASTS = ('let there be lights', 'let there be night', 'let there be a light')
LIGHT_GRAMMAR = json.dumps((LIGHT_PHRASE, *LIGHT_CONTRASTS, '[unk]'))
LIGHT_VETO = (*LIGHT_CONTRASTS, LIGHT_PHRASE + ' light')


class BoundedSpeechError(ValueError):
    """A decoder failure that needs operator attention."""


@dataclass(frozen=True)
class Utterance:
    number: int
    pcm: bytes
    prefix_only: bool = False


class VoiceEndpoint:
    """Group consecutive audio frames without treating a hard cap as a pause."""

    def __init__(self, is_voice, early_prefix):
        self.is_voice = is_voice
        self.early_prefix = early_prefix
        self.number = 0
        self.reset()

    def reset(self):
        self.remainder = b''
        self.preroll = deque(maxlen=10)
        self.audio = bytearray()
        self.active = False
        self.overflow = False
        self.prefix_sent = False
        self.quiet = 0
        self.voiced = 0

    def push(self, pcm):
        joined = self.remainder + pcm
        length = len(joined) - len(joined) % FRAME_BYTES
        self.remainder = joined[length:]
        completed = []
        for offset in range(0, length, FRAME_BYTES):
            frame = joined[offset:offset + FRAME_BYTES]
            voiced = self.is_voice(frame)
            if not self.active:
                self.preroll.append((frame, voiced))
                if voiced and sum(flag for _, flag in list(self.preroll)[-5:]) >= 3:
                    self.active = True
                    self.number += 1
                    self.voiced = sum(flag for _, flag in self.preroll)
                    self.audio.extend(b''.join(sample for sample, _ in self.preroll))
                    self.preroll.clear()
                continue

            self.voiced += int(voiced)
            self.quiet = 0 if voiced else self.quiet + 1
            if not self.overflow:
                if len(self.audio) >= MAX_FRAMES * FRAME_BYTES:
                    self.overflow = True
                    self.audio.clear()
                else:
                    self.audio.extend(frame)
            if self.quiet >= END_FRAMES:
                if not self.overflow and self.voiced >= 10:
                    # Leave enough trailing silence for the last consonant.
                    end = self.observation_end
                    completed.append(Utterance(self.number, bytes(self.audio[:end])))
                remainder = self.remainder
                self.reset()
                self.remainder = remainder
            elif (self.early_prefix and not self.prefix_sent and not self.overflow
                  and len(self.audio) >= PREFIX_FRAMES * FRAME_BYTES
                  and self.quiet <= 3 and self.voiced >= 30):
                self.prefix_sent = True
                completed.append(Utterance(self.number, bytes(self.audio), True))
        return completed

    @property
    def observation_end(self):
        # Stream only audio that would still be included if the voice endpoint
        # closed now. If speech resumes, the quiet interval is fed in order.
        return len(self.audio) - max(0, self.quiet - 7) * FRAME_BYTES


def _word_key(text):
    text = unicodedata.normalize('NFC', text).casefold()
    return ' '.join(''.join(' ' if unicodedata.category(ch).startswith('P')
                           else ch for ch in text).split())


def _result(text='', words=(), confidence=0.0, final=False, **extra):
    return dict(final=final, text=text, words=list(words), confidence=confidence, **extra)


def _detector():
    import webrtcvad
    detector = webrtcvad.Vad(2)
    return lambda pcm: detector.is_speech(pcm, SAMPLE_RATE)


def _vosk_recognizers(model_path):
    if not model_path or not (Path(model_path) / 'am' / 'final.mdl').is_file():
        return None
    try:
        import vosk
    except (ImportError, OSError):
        return None
    vosk.SetLogLevel(-1)
    model = vosk.Model(str(model_path))

    def new_recognizer(grammar=None):
        recognizer = (vosk.KaldiRecognizer(model, SAMPLE_RATE, grammar) if grammar
                      else vosk.KaldiRecognizer(model, SAMPLE_RATE))
        recognizer.SetWords(True)
        return recognizer

    return new_recognizer


def _vosk_words(recognizer):
    result = json.loads(recognizer.FinalResult())
    words = result.get('result', ())
    if _word_key(result.get('text', '')) != _word_key(' '.join(w['word'] for w in words)):
        return []
    return [dict(word=w['word'], conf=float(w['conf']),
                 start=float(w['start']), end=float(w['end'])) for w in words]


def _vosk_batch_decoder(new_recognizer):
    def recognize(pcm, grammar=None):
        recognizer = new_recognizer(grammar)
        recognizer.AcceptWaveform(pcm)
        return _vosk_words(recognizer)

    return recognize


def _secondary_decoder(model_path):
    """Unbiased Vosk corroboration of a completed, bounded observation."""
    new_recognizer = _vosk_recognizers(model_path)
    return _vosk_batch_decoder(new_recognizer) if new_recognizer is not None else None


def load_vosk_observation_decoder(model_path):
    """Finalize a voiced observation without emitting any streaming interim text."""
    return _vosk_observation_decoder(model_path, _secondary_decoder(model_path))


def _vosk_observation_decoder(model_path, recognize):
    if recognize is None:
        raise BoundedSpeechError('The Standard speech model is missing. Run speech setup.')
    can_check_ending = (Path(model_path) / 'graph' / 'Gr.fst').is_file()

    def decode(utterance, words=None):
        if words is None:
            words = recognize(utterance.pcm)
        if utterance.prefix_only:
            complete = len(utterance.pcm) / (SAMPLE_RATE * 2) - .12
            words = [word for word in words if word['end'] <= complete]
        scores = [score for _, score in _tokens(words)]
        plausible = bool(scores) and all(math.isfinite(score) and 0 <= score <= 1 for score in scores)
        leading = min(scores[:3]) if plausible and len(scores) > 3 else 0.0
        confidence = ((leading if utterance.prefix_only else min(scores)) if plausible else 0.0)
        text = ' '.join(word['word'] for word in words)
        reject_reason = ''
        if can_check_ending and not utterance.prefix_only and confidence >= .6 and _word_key(text) == LIGHT_PHRASE:
            # General decoding already produced the command. The contrast
            # check can reject a near-match or an echo that repeats the last
            # word, while cue eligibility still comes from the general model.
            checked = recognize(utterance.pcm, LIGHT_GRAMMAR)
            if (_word_key(' '.join(word['word'] for word in checked)) in LIGHT_VETO
                    and min(word['conf'] for word in checked) >= .82):
                plausible = False
                confidence = 0.0
                reject_reason = 'light-ending'
        return _result(text, words, confidence, True,
                       quality_ok=plausible, leading_confidence=leading,
                       prefix_only=utterance.prefix_only, utterance=utterance.number,
                       reject_reason=reject_reason)

    return decode


class StreamingVoskObservations:
    """Advance the general recognizer during speech and finalize at the endpoint."""

    def __init__(self, model_path):
        self._new = _vosk_recognizers(model_path)
        self._decode = _vosk_observation_decoder(
            model_path, _vosk_batch_decoder(self._new) if self._new is not None else None)
        self._number = None
        self._recognizer = None
        self._fed = 0

    def advance(self, utterance):
        if utterance.number != self._number:
            self._number = utterance.number
            self._recognizer = self._new()
            self._fed = 0
        tail = utterance.pcm[self._fed:]
        if tail:
            self._recognizer.AcceptWaveform(tail)
            self._fed += len(tail)

    def __call__(self, utterance):
        if utterance.prefix_only:
            # Keep the opening observation independent of the live recognizer,
            # whose final result must still contain the complete phrase.
            return self._decode(utterance)
        self.advance(utterance)
        words = _vosk_words(self._recognizer)
        self._number, self._recognizer = None, None
        return self._decode(utterance, words)


def _tokens(words, limit=None):
    tokens = [(token, word['conf']) for word in words for token in _word_key(word['word']).split()]
    if limit is None and [token for token, _ in tokens] in (['abra', 'cadabra'], ['abra', 'kadabra']):
        return [('abracadabra', min(score for _, score in tokens))]
    return tokens[:limit] if limit else tokens


def evidence_score(words, secondary, *, acoustic, silence, compression, limit=None):
    """Score unprompted acoustic evidence; agreement is not a probability."""
    primary = _tokens(words, limit)
    comparison = _tokens(secondary, limit)
    if (not primary or not all(math.isfinite(value) for value in (acoustic, silence, compression))
            or not all(math.isfinite(score) and 0 <= score <= 1 for _, score in primary + comparison)
            or silence > .55 or compression > 2.2):
        return 0.0
    weak_word = min(conf for _, conf in primary)
    score = weak_word if acoustic >= math.exp(-.85) else 0.0
    if comparison:
        compare_score = min(conf for _, conf in comparison)
        agrees = [word for word, _ in primary] == [word for word, _ in comparison]
        # Weak first-word estimates are common for short commands. Independent
        # agreement can rescue that case without accepting alternate transcripts.
        if (agrees and acoustic >= math.exp(-1.1) and silence <= .35
                and weak_word >= .20 and compare_score >= .60):
            score = max(score, min(.95, .42 * weak_word + .58 * compare_score + .17))
        elif not agrees and compare_score >= .84:
            score = min(score, .55)
    return score


def load_decoder(model_path, corroboration_path=None):
    """Load from verified local files only; never use a remote model identifier."""
    if not all((Path(model_path) / name).is_file() for name in MODEL_FILES):
        raise BoundedSpeechError('Enhanced speech model is missing. Run speech setup first.')
    import numpy as np
    from faster_whisper import WhisperModel
    # Leave CPU for browser inference and bridge watchdogs.
    threads = min(4, max(1, (os.cpu_count() or 2) // 2))
    model = WhisperModel(str(model_path), device='cpu', compute_type='int8',
                         cpu_threads=threads, num_workers=1, local_files_only=True)
    corroborate = _secondary_decoder(corroboration_path)

    def decode(utterance):
        audio = np.frombuffer(utterance.pcm, dtype='<i2').astype(np.float32) / 32768
        segments, _ = model.transcribe(
            audio, language='en', beam_size=1, temperature=0.0,
            condition_on_previous_text=False, word_timestamps=True,
            vad_filter=True, vad_parameters=dict(threshold=.42, min_speech_duration_ms=120,
                                                 min_silence_duration_ms=320, speech_pad_ms=120),
            log_prob_threshold=-.85, no_speech_threshold=.55,
            compression_ratio_threshold=2.2, max_new_tokens=64,
        )
        lines, words = [], []
        plausible, acoustic, silence, compression = True, 1.0, 0.0, 0.0
        # Do not use a final word cut off by the early observation window.
        last_complete = len(audio) / SAMPLE_RATE - .12
        for segment in segments:
            if not all(math.isfinite(value) for value in
                       (segment.avg_logprob, segment.no_speech_prob, segment.compression_ratio)):
                plausible = False
            acoustic = min(acoustic, math.exp(min(0.0, segment.avg_logprob)))
            silence = max(silence, segment.no_speech_prob)
            compression = max(compression, segment.compression_ratio)
            lines.append(segment.text)
            for word in segment.words or ():
                text = word.word.strip()
                if not text or (utterance.prefix_only and word.end > last_complete):
                    continue
                score = float(word.probability)
                if (not math.isfinite(score) or not 0 <= score <= 1
                        or not math.isfinite(word.start) or not math.isfinite(word.end)
                        or word.start < 0 or word.end < word.start):
                    plausible = False
                    score = 0.0
                words.append(dict(word=text, conf=score, start=float(word.start), end=float(word.end)))
        transcript = ' '.join((' '.join(w['word'] for w in words)
                               if utterance.prefix_only else ' '.join(lines)).split())
        plausible = bool(plausible and words and _word_key(transcript)
                         and _word_key(transcript) == _word_key(' '.join(w['word'] for w in words)))
        secondary = corroborate(utterance.pcm) if plausible and corroborate else []
        scores = dict(acoustic=acoustic, silence=silence, compression=compression)
        leading = (evidence_score(words, secondary, limit=3, **scores)
                   if plausible and len(_word_key(transcript).split()) > 3 else 0.0)
        confidence = ((leading if utterance.prefix_only else evidence_score(words, secondary, **scores))
                      if plausible else 0.0)
        return _result(transcript, words, confidence, True, quality_ok=plausible and bool(confidence or leading),
                       leading_confidence=leading,
                       acoustic_score=acoustic if lines else 0.0, no_speech_probability=silence,
                       prefix_only=utterance.prefix_only, utterance=utterance.number)

    return decode


class BoundedSpeechDecoder:
    """One asynchronous inference; microphone packets never wait for it."""

    def __init__(self, model_path, loader=load_decoder, detector_factory=_detector,
                 clock=time.monotonic, label='Enhanced', stream_audio=False):
        self.model_path = Path(model_path)
        self.label = label
        self._loader, self._detector_factory, self._clock = loader, detector_factory, clock
        self._decode = None
        self._task = None
        self._task_kind = ''
        self._task_start = 0.0
        self._task_observed = 0.0
        self._task_epoch = 0
        self._epoch = 0
        self._voice = None
        self._stream_audio = stream_audio
        self._advanced = (None, 0)
        self._pending = None
        self._utterance_number = 0
        self._quiet_detector = None
        self._early_prefix = False
        self._dropped = 0
        self.running = False
        self.last_decode_ms = None
        self.audio_hint = 'Microphone is off'
        self.error = ''

    @property
    def loading(self):
        return bool(self.running and self._decode is None and self._task_kind == 'load')

    @property
    def processing(self):
        return bool(self.running and self._task_epoch == self._epoch
                    and (self._task_kind == 'decode' or self._pending is not None))

    def _submit(self, kind, call, observed_at=None):
        assert self._task is None
        self._task = task = Future()
        self._task_kind = kind
        self._task_epoch = self._epoch
        self._task_start = self._clock()
        self._task_observed = self._task_start if observed_at is None else observed_at

        def run():
            try:
                result = call()
            except Exception as error:
                task.set_exception(error)
            else:
                task.set_result((result, self._clock()))

        threading.Thread(target=run, name='local-speech-' + kind, daemon=True).start()

    def _collect(self):
        task = self._task
        if task is None or not task.done():
            return None
        kind, epoch, start = self._task_kind, self._task_epoch, self._task_start
        self._task, self._task_kind = None, ''
        # Retired tasks must not revive the old transcript or raise a current fault.
        if kind != 'load' and epoch != self._epoch:
            return None
        try:
            result, finished = task.result()
        except Exception as error:
            self.running = False
            self.error = (f'{self.label} speech could not load. Run speech setup.'
                          if kind == 'load' else
                          f'{self.label} speech decoding stopped. Restart the microphone.')
            raise BoundedSpeechError(self.error) from error
        if kind == 'load':
            self._decode = result
            self.audio_hint = 'Waiting for speech'
            return None
        if kind == 'advance':
            return None
        self.last_decode_ms = round((finished - start) * 1000)
        if self._clock() - self._task_observed > MAX_RESULT_AGE:
            self.audio_hint = 'Recognition took too long; phrase discarded. Reduce camera load or try Standard.'
            return None
        self.audio_hint = 'Phrase analyzed' if result.get('text') else 'No clear speech recognized'
        return result

    def start(self, early_prefix):
        self.stop()
        self._early_prefix = early_prefix
        self.running = True
        self.error = ''
        self.last_decode_ms = None
        self._dropped = 0
        try:
            self.reset()
            self._collect()  # Reuse a completed model load after a previous stop.
            if self._decode is None and self._task is None:
                self._submit('load', lambda: self._loader(self.model_path))
        except Exception as error:
            self.stop()
            if isinstance(error, BoundedSpeechError):
                raise
            self.error = f'{self.label} speech components could not load. Run speech setup.'
            raise BoundedSpeechError(self.error) from error
        self.audio_hint = f'Loading {self.label.lower()} speech' if self.loading else 'Waiting for speech'

    def reset(self):
        self._epoch += 1
        self._advanced = (None, 0)
        self._pending = None
        if self._voice is not None:
            self._utterance_number = self._voice.number
        self._voice = (VoiceEndpoint(self._detector_factory(), self._early_prefix)
                       if self.running else None)
        if self._voice is not None:
            self._voice.number = self._utterance_number
        self._quiet_detector = None
        self.audio_hint = 'Waiting for speech' if self.running else 'Microphone is off'

    def stop(self):
        self.running = False
        self.reset()

    def quiet_audio(self, pcm):
        if not self.running:
            return None
        if self._quiet_detector is None:
            self._quiet_detector = self._detector_factory()
        # Browser packets contain full frames. A 10 ms remainder is also
        # supported by WebRTC, but never treat an incomplete frame as quiet.
        if len(pcm) % (FRAME_BYTES // 2):
            return False
        voiced = [self._quiet_detector(pcm[offset:offset + FRAME_BYTES])
                  for offset in range(0, len(pcm), FRAME_BYTES)]
        return not any(voiced)

    def status(self):
        return dict(loading=self.loading, processing=self.processing,
                    last_decode_ms=self.last_decode_ms, audio_hint=self.audio_hint,
                    dropped_utterances=self._dropped)

    def _submit_observation(self, utterance, observed_at=None):
        self._submit('decode', lambda: self._decode(utterance), observed_at)
        self.audio_hint = 'Recognizing phrase'

    def _process_observations(self, utterances):
        if self._task is None and self._pending is not None:
            utterance, observed_at = self._pending
            self._pending = None
            if self._clock() - observed_at <= MAX_RESULT_AGE:
                self._submit_observation(utterance, observed_at)
            elif not utterance.prefix_only:
                self._dropped += 1
                self.audio_hint = 'Recognition took too long; phrase discarded.'
        for utterance in utterances:
            if self._task is None:
                self._submit_observation(utterance)
            elif (self._task_kind == 'advance' and self._task_epoch == self._epoch
                  and (self._pending is None or (self._pending[0].prefix_only
                       and self._pending[0].number == utterance.number))):
                # A single completed observation can wait for its ongoing
                # acoustic work. Never build a backlog of performance cues.
                self._pending = utterance, self._clock()
                self.audio_hint = 'Recognizing phrase'
            elif not utterance.prefix_only:
                self._dropped += 1
                self.audio_hint = 'Recognition busy; phrase discarded. Pause briefly between phrases.'

    def _advance_stream(self):
        if self._task is not None or not self._voice.active or self._voice.overflow:
            return
        end = self._voice.observation_end
        end -= end % VOSK_BLOCK_BYTES
        number = self._voice.number
        if not end or self._advanced == (number, end):
            return
        self._advanced = number, end
        utterance = Utterance(number, bytes(self._voice.audio[:end]))
        self._submit('advance', lambda: self._decode.advance(utterance))

    def feed(self, pcm):
        if not self.running:
            raise BoundedSpeechError('Start the microphone before sending audio')
        result = self._collect()
        if self._decode is None:
            if self._clock() - self._task_start > 20:
                self.stop()
                self.error = f'{self.label} speech model loading timed out. Restart the microphone.'
                raise BoundedSpeechError(self.error)
            return _result()
        self._process_observations(self._voice.push(pcm))
        if self._stream_audio:
            self._advance_stream()
        if self._task_kind in ('advance', 'decode') and self._clock() - self._task_start > 5:
            self.stop()
            self.error = f'{self.label} speech is not keeping up. Restart the microphone or reduce camera load.'
            raise BoundedSpeechError(self.error)
        if self._voice.active and self._task_kind in ('', 'advance') and self._pending is None:
            self.audio_hint = 'Listening to phrase' if not self._voice.overflow else 'Phrase too long; pause before speaking again.'
        return result or _result()
