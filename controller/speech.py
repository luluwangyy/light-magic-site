"""Optional, offline PCM speech decoding and explicit phrase mappings.

The local model is opened only by Start microphone. No audio is recorded here,
and neither model discovery nor decoding contacts a remote speech service.
"""
from __future__ import annotations

import importlib.util
import json
import math
from pathlib import Path
import re
import time
import unicodedata

from speech_enhanced import (BoundedSpeechDecoder, BoundedSpeechError, MODEL_FILES,
                             MODEL_NAME, StreamingVoskObservations, load_decoder)
from mapping_outputs import CHANNEL_OUTPUT_TYPES, validate_mapping_output


SAMPLE_RATE = 16000
MAX_PCM_BYTES = SAMPLE_RATE * 2 * 2
MAX_SPEECH_MAPPINGS = 50
# The decoder receives built-in alternatives in addition to the saved rows.
MAX_RECOGNITION_PHRASES = 64
DEFAULT_SPEECH_MAPPINGS = [
    dict(id='speech_light', phrase='there be light', cue_list=1, cue='', enabled=False),
    dict(id='speech_abracadabra', phrase='Abracadabra', cue_list=1, cue='', enabled=False),
    dict(id='speech_pass', phrase='They shall not pass', cue_list=1, cue='', enabled=False),
    dict(id='speech_command', phrase='At my command', cue_list=1, cue='', enabled=False),
    dict(id='speech_defend', phrase='This will defend', cue_list=1, cue='', enabled=False),
]


class SpeechError(ValueError):
    """An actionable speech setup or decoding error."""


def normalized_phrase(text):
    """Normalize presentation only; never accept substrings or fuzzy matches."""
    if not isinstance(text, str):
        raise ValueError('Speech phrase must be text')
    text = unicodedata.normalize('NFC', text).casefold()
    text = ''.join(' ' if unicodedata.category(char).startswith('P') else char
                   for char in text)
    return ' '.join(text.split())


def validate_speech_mappings(raw):
    if not isinstance(raw, list) or len(raw) > MAX_SPEECH_MAPPINGS:
        raise ValueError('Store at most 50 speech phrases')
    result, identities, phrases = [], set(), set()
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError('Invalid speech mapping')
        identity = item.get('id', '')
        if (not isinstance(identity, str)
                or not re.fullmatch(r'speech_[A-Za-z0-9_-]{1,64}', identity)
                or identity in identities):
            raise ValueError('Invalid or duplicate speech mapping ID')
        phrase = item.get('phrase', '')
        if (not isinstance(phrase, str) or not 1 <= len(phrase.strip()) <= 160
                or any(unicodedata.category(char) == 'Cc' for char in phrase)):
            raise ValueError('Each speech phrase needs 1–160 characters without control characters')
        phrase = ' '.join(phrase.split())
        normalized = normalized_phrase(phrase)
        if not normalized or not any(char.isalpha() for char in normalized) or normalized in phrases:
            raise ValueError('Speech phrases must contain words and be unique')
        enabled = item.get('enabled')
        if not isinstance(enabled, bool):
            raise ValueError('Speech mapping enabled must be boolean')
        output = validate_mapping_output(item, required=enabled)
        uses_channel = output.get('output_type') in CHANNEL_OUTPUT_TYPES
        cue_list = item.get('cue_list', 1 if uses_channel else None)
        if isinstance(cue_list, bool):
            raise ValueError('Speech cue list must be a whole number from 1 to 999')
        try:
            numeric_list = float(cue_list)
        except (ValueError, TypeError):
            raise ValueError('Speech cue list must be a whole number from 1 to 999') from None
        if not math.isfinite(numeric_list) or numeric_list != int(numeric_list) or not 1 <= numeric_list <= 999:
            raise ValueError('Speech cue list must be a whole number from 1 to 999')
        cue = str(item.get('cue', '')).strip()
        if cue and (not re.fullmatch(r'[0-9]{1,5}(?:\.[0-9]{1,3})?', cue) or float(cue) <= 0):
            raise ValueError('Invalid speech cue number')
        if enabled and not uses_channel and not cue:
            raise ValueError('Assign a cue before enabling a speech phrase')
        result.append(dict(id=identity, phrase=phrase, cue_list=int(numeric_list),
                           cue=cue, enabled=enabled, **output))
        identities.add(identity)
        phrases.add(normalized)
    return result


class SpeechEngine:
    """Resettable local speech for mono PCM16LE at 16 kHz.

    Tests may inject ``recognizer_factory(phrases, sample_rate)``. A factory
    returns a Vosk-compatible recognizer without loading a package or model.
    """

    def __init__(self, model_path, recognizer_factory=None, *, backend='auto'):
        self.model_path = Path(model_path)
        self._factory = recognizer_factory
        self._model = None
        self._recognizer = None
        self._enhanced = BoundedSpeechDecoder(self.model_path.parent / MODEL_NAME,
                                             loader=lambda path: load_decoder(path, self.model_path))
        self._observer = BoundedSpeechDecoder(self.model_path, loader=StreamingVoskObservations,
                                             label='Standard', stream_audio=True)
        self._worker = None
        self._leading_command = False
        self._inventory = {}
        self._backend_preference = 'auto'
        self._active_backend = None
        self._phrases = []
        self._grammar_mode = 'not started'
        self._unknown_words = []
        self._error = ''
        self.select_backend(backend)

    def select_backend(self, backend):
        if backend not in ('auto', 'vosk', 'enhanced'):
            raise SpeechError('Choose Automatic, Vosk or Enhanced speech recognition')
        self._inventory.clear()
        if backend != self._backend_preference:
            self.stop()
            self._backend_preference = backend
            self._error = ''

    def set_leading_command(self, enabled):
        """Enable independently finalized opening observations for the show."""
        if bool(enabled) != self._leading_command:
            self.stop()
            self._leading_command = bool(enabled)

    @property
    def _standard_observations(self):
        return (self._leading_command and self._factory is None
                and self._available_cached('vad', lambda: self._package_available('webrtcvad')))

    @property
    def recognition_id(self):
        """Include the effective model and endpoint policy in practice receipts."""
        if self.backend == 'enhanced':
            return 'enhanced:' + self._enhanced.model_path.name + ':observations-v1'
        policy = 'streaming-observations-v3' if self._standard_observations else 'stream-v1'
        return 'vosk:' + self.model_path.name + ':' + policy

    @property
    def backend(self):
        if self._factory is not None:
            return 'vosk'
        if self._active_backend is not None:
            return self._active_backend
        if self._backend_preference == 'auto':
            # Real-time Standard avoids a variable-latency second pass.
            # Enhanced remains selectable for rehearsal comparisons.
            return 'vosk' if self.standard_available or not self.enhanced_available else 'enhanced'
        return self._backend_preference

    def _available_cached(self, key, check):
        now = time.monotonic()
        previous = self._inventory.get(key)
        if previous is None or now - previous[0] > 4:
            previous = self._inventory[key] = (now, check())
        return previous[1]

    @property
    def enhanced_available(self):
        return self._available_cached('enhanced', lambda:
            all((self._enhanced.model_path / filename).is_file() for filename in MODEL_FILES)
            and self._package_available('faster_whisper') and self._package_available('webrtcvad'))

    @property
    def standard_available(self):
        return (self._factory is not None or self._model is not None
                or self._available_cached('vosk', lambda:
                    self._package_available() and self._model_available()))

    @property
    def running(self):
        if self._worker is not None:
            return self._worker.running
        return self._recognizer is not None

    @property
    def available(self):
        if self.backend == 'enhanced':
            return self.enhanced_available
        return self.standard_available

    @staticmethod
    def _package_available(name='vosk'):
        try:
            return importlib.util.find_spec(name) is not None
        except (ImportError, ValueError):
            return False

    def _model_available(self):
        return self.model_path.is_dir() and (self.model_path / 'am' / 'final.mdl').is_file()

    def status(self):
        """Lightweight setup status; does not import Vosk or instantiate a model."""
        available = self.available
        if self._error:
            reason = self._error
        elif self._worker is not None and self._worker.loading:
            reason = f'Loading the {self._worker.label.lower()} offline speech model'
        elif self.running:
            reason = 'Offline microphone recognition is ready'
        elif not available:
            reason = ('Run Setup speech recognition to install the local speech package and model'
                      if self.backend == 'vosk' else
                      'Run Setup speech recognition.bat or python setup_speech.py --enhanced, or choose Vosk')
        else:
            reason = 'Offline speech is installed. Choose Start microphone to preview phrases'
        extra = (self._worker.status() if self._worker is not None else
                 dict(loading=False, processing=False, last_decode_ms=None,
                      audio_hint='Waiting for speech' if self.running else 'Microphone is off',
                      dropped_utterances=0))
        return dict(available=available, running=self.running, reason=reason,
                    grammar_mode=self._grammar_mode, unknown_words=list(self._unknown_words),
                    backend=self.backend, backend_preference=self._backend_preference,
                    enhanced_available=self.enhanced_available, recognition_id=self.recognition_id,
                    audio_packet_ms=100 if self._worker is not None else 200,
                    leading_window=bool(self._leading_command and self._worker is not None
                                        and 'at my command' in self._phrases), **extra)

    def start(self, phrases):
        if (not isinstance(phrases, list) or not 1 <= len(phrases) <= MAX_RECOGNITION_PHRASES
                or any(not isinstance(phrase, str) or not normalized_phrase(phrase)
                       or len(phrase) > 160 for phrase in phrases)):
            raise SpeechError('Add at least one valid speech phrase before starting the microphone')
        self.stop()
        self._inventory.clear()
        self._phrases = list(dict.fromkeys(normalized_phrase(phrase) for phrase in phrases))
        self._error = ''
        try:
            self._active_backend = self.backend
            if self._active_backend == 'enhanced':
                if not self.enhanced_available:
                    raise SpeechError('Enhanced speech is not installed. Run Setup speech recognition.bat or choose Vosk')
                self._worker = self._enhanced
                self._worker.start(early_prefix=self._leading_command and 'at my command' in self._phrases)
                self._grammar_mode = 'general vocabulary'
                self._unknown_words = []
                return self.status()
            if self._standard_observations:
                if not self._model_available():
                    raise SpeechError('Local speech model is missing. Run Setup speech recognition, then retry')
                self._worker = self._observer
                self._worker.start(early_prefix='at my command' in self._phrases)
                self._grammar_mode = 'general vocabulary'
                self._unknown_words = []
                return self.status()
            if self._factory is not None:
                self._recognizer = self._factory(list(self._phrases), SAMPLE_RATE)
                self._grammar_mode = 'test decoder'
                self._unknown_words = []
            else:
                if not self._model_available():
                    raise SpeechError('Local speech model is missing. Run Setup speech recognition, then retry')
                try:
                    import vosk
                except (ImportError, OSError) as error:
                    raise SpeechError('Local speech package could not load. Run Setup speech recognition, then retry') from error
                vosk.SetLogLevel(-1)
                if self._model is None:
                    # Explicit paths avoid Vosk's optional automatic model download.
                    self._model = vosk.Model(str(self.model_path))
                vocabulary = sorted({word for phrase in self._phrases for word in phrase.split()})
                finder = getattr(self._model, 'vosk_model_find_word', None)
                self._unknown_words = ([word for word in vocabulary if finder(word) < 0]
                                       if finder is not None else list(vocabulary))
                # A restricted grammar can turn similar, unconfigured speech into
                # a configured command with misleadingly high confidence. Decode
                # general speech first; the controller then requires an exact,
                # complete phrase match against its explicit cue allowlist.
                self._recognizer = vosk.KaldiRecognizer(self._model, SAMPLE_RATE)
                self._grammar_mode = 'general vocabulary'
            self._recognizer.SetWords(True)
        except Exception as error:
            self.stop()
            self._error = str(error) if isinstance(error, (SpeechError, BoundedSpeechError)) else 'Offline speech could not start: ' + str(error)
            raise SpeechError(self._error) from error
        return self.status()

    def reset(self):
        """Discard unfinished speech. Never flush it into a final command."""
        if self._worker is not None:
            self._worker.reset()
            return
        if self._recognizer is not None:
            try:
                self._recognizer.Reset()
            except Exception as error:
                self._recognizer = None
                self._error = 'Offline speech could not reset. Restart the microphone'
                raise SpeechError(self._error) from error

    def stop(self):
        """Release this decoder without finalizing an unfinished utterance."""
        self._recognizer = None
        self._enhanced.stop()
        self._observer.stop()
        self._worker = None
        self._active_backend = None

    def quiet_audio(self, pcm):
        """Bounded speech uses voice activity for the post-arm quiet check."""
        return self._worker.quiet_audio(pcm) if self._worker is not None else None

    def feed(self, pcm):
        if not self.running:
            raise SpeechError('Start the microphone before sending audio')
        if (not isinstance(pcm, bytes) or not pcm or len(pcm) % 2
                or len(pcm) > MAX_PCM_BYTES):
            raise SpeechError('Speech audio must be 1–32000 PCM16 samples at 16 kHz')
        if self._worker is not None:
            try:
                return self._worker.feed(pcm)
            except BoundedSpeechError as error:
                self._error = str(error)
                raise SpeechError(self._error) from error
        try:
            final = bool(self._recognizer.AcceptWaveform(pcm))
            raw = self._recognizer.Result() if final else self._recognizer.PartialResult()
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise ValueError('Invalid decoder result')
            text = payload.get('text' if final else 'partial', '')
            if not isinstance(text, str) or len(text) > 2000:
                raise ValueError('Invalid decoder transcript')
            words, confidence = [], 0.0
            if final:
                entries = payload.get('result', [])
                if not isinstance(entries, list):
                    raise ValueError('Invalid word details')
                for entry in entries:
                    if not isinstance(entry, dict) or not isinstance(entry.get('word'), str):
                        raise ValueError('Invalid decoded word')
                    score = entry.get('conf', 0)
                    if isinstance(score, bool) or not isinstance(score, (float, int)) or not math.isfinite(score) or not 0 <= score <= 1:
                        raise ValueError('Invalid word confidence')
                    words.append(dict(word=entry['word'], conf=float(score)))
                # Missing word evidence cannot earn a high-confidence final match.
                if words and normalized_phrase(text) == normalized_phrase(' '.join(word['word'] for word in words)):
                    confidence = min(word['conf'] for word in words)
            return dict(final=final, text=' '.join(text.split()), confidence=confidence, words=words)
        except SpeechError:
            raise
        except Exception as error:
            self._recognizer = None
            self._error = 'Offline speech decoding failed. Restart the microphone'
            raise SpeechError(self._error) from error
