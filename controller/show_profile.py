"""Cue vocabulary and recognition rules for How to Make the Air Obey."""

from collections import Counter
from copy import deepcopy
import json
from pathlib import Path
from speech import normalized_phrase


STAGE_SHEET = 'air-obey'
# Keep this in step with STAGE_ASSOCIATION_MS in the browser hand selector.
STAGE_FRAME_GAP_S = .45
STAGE_BRIEF_GAP_S = .22
FIRE = 'Fire_Gesture'
ANKH = 'Ankh_Pose'
STAGE_GESTURES = ('Open_Palm', 'Closed_Fist', FIRE, ANKH)
STAGE_NAMES = {'Open_Palm':'Open palm','Closed_Fist':'Fist',FIRE:'Fire gesture',ANKH:'Ankh pose'}
STAGE_EFFECTS = {
    'Open_Palm': 'Full / revealing light',
    'Closed_Fist': 'Lights off / blackout',
    FIRE: 'Red-orange / fire state',
    ANKH: 'Ceremonial / halo state',
    'speech_light': 'White light',
    'speech_abracadabra': 'Transformation state',
    'speech_pass': 'Red barrier',
    'speech_command': 'Authoritarian state',
    'speech_stand_down': 'Lights off / blackout',
}
STAGE_SPEECH = (
    ('speech_light', 'Let there be light'),
    ('speech_abracadabra', 'Abracadabra'),
    ('speech_pass', 'They shall not pass'),
    ('speech_command', 'At my command'),
    ('speech_stand_down', 'Stand down'),
)
COMMAND_PREFIX = 'at my command'
STAGE_BACKUP_PHRASES = {
    'speech_light': ('white lights',),
    'speech_abracadabra': ('magic shift',),
    'speech_pass': ('shield up',),
    'speech_command': ('take command',),
    'speech_stand_down': ('lights out',),
}
TRANSCRIPT_VARIANTS = {'speech_abracadabra': ('abra cadabra', 'abra kadabra')}


def stage_config(previous):
    """Make an unassigned cue sheet without changing the existing lab setup."""
    result = deepcopy(previous)
    result.update(cue_sheet=STAGE_SHEET, mode='cue', palm_from_fist=False,input_source='both',notes='')
    result['mappings'] = [
        dict(gesture=gesture, label=STAGE_EFFECTS[gesture], cue_list=1, cue='', enabled=False,
             confidence=.8, hold_s=hold)
        for gesture, hold in (
            ('Open_Palm', .6), ('Closed_Fist', .65),
            (FIRE, .65), (ANKH, .7),
        )
    ]
    result['speech_mappings'] = [
        dict(id=identity, phrase=phrase, cue_list=1, cue='', enabled=False)
        for identity, phrase in STAGE_SPEECH
    ]
    return result


def direct_channel_config(previous):
    """Assign the Movement Lab designs to the show's gesture and voice vocabulary."""
    asset = Path(__file__).resolve().parent / 'web' / 'assets' / 'movement-lab-channel-looks.json'
    looks = json.loads(asset.read_text(encoding='utf-8'))['looks']
    by_trigger = {trigger: look['channels'] for look in looks for trigger in look['triggers']}
    result = stage_config(previous)
    result.update(input_source=previous['input_source'], notes=previous['notes'])
    saved_gestures = {row['gesture']: row for row in previous['mappings']}
    for row in result['mappings']:
        gesture = row['gesture']
        if previous['cue_sheet'] == STAGE_SHEET and gesture in saved_gestures:
            saved = saved_gestures[gesture]
            row.update(confidence=saved['confidence'], hold_s=saved['hold_s'])
        row.update(output_type='channel_look', channels=by_trigger[gesture], enabled=gesture != FIRE)
    for row in result['speech_mappings']:
        row.update(output_type='channel_look', channels=by_trigger[row['id']], enabled=True)
    return result


def speech_aliases(config, *, include_variants=False):
    """Only add defaults to the show rows that still use their original phrases."""
    if config.get('cue_sheet') != STAGE_SHEET:
        return {}
    phrases = {row['id']: normalized_phrase(row['phrase']) for row in config['speech_mappings']}
    explicit = set(phrases.values())
    candidates = {}
    for identity, phrase in STAGE_SPEECH:
        if phrases.get(identity) != normalized_phrase(phrase):
            continue
        choices = STAGE_BACKUP_PHRASES.get(identity, ())
        if include_variants:
            choices += TRANSCRIPT_VARIANTS.get(identity, ())
        candidates[identity] = [alias for alias in choices if alias not in explicit]
    claimed = Counter(alias for choices in candidates.values() for alias in choices)
    return {identity: distinct for identity, choices in candidates.items()
            if (distinct := [alias for alias in choices if claimed[alias] == 1])}


def speech_recognition_phrases(config):
    """Return the saved phrases and their exact, non-conflicting alternatives."""
    aliases = speech_aliases(config, include_variants=True)
    return [phrase for row in config['speech_mappings']
            for phrase in (row['phrase'], *aliases.get(row['id'], ()))]


def speech_match(config, text, *, prefix_only=False):
    """Match complete phrases. Only the show's leading command allows more words."""
    spoken = normalized_phrase(text)
    if not prefix_only:
        exact = next((m for m in config['speech_mappings']
                      if normalized_phrase(m['phrase']) == spoken), None)
        if exact:
            return exact
        aliases = speech_aliases(config, include_variants=True)
        alias_match = next((row for row in config['speech_mappings']
                            if spoken in aliases.get(row['id'], ())), None)
        if alias_match:
            return alias_match
    if config.get('cue_sheet') == STAGE_SHEET and spoken.startswith(COMMAND_PREFIX + ' '):
        return next((m for m in config['speech_mappings']
                     if m['id'] == 'speech_command' and
                     normalized_phrase(m['phrase']) == COMMAND_PREFIX), None)
    return None


class StageGestureGate:
    """Accumulate observed hold time and latch one event per deliberate pose."""

    def __init__(self):
        self.candidate = None
        self.track = None
        self.held = 0
        self.last_good = None
        self.gap = False
        self.last_sample = None
        self.neutral_since = None
        self.latched = None
        self.progress = 0
        self.ready = True

    def clear_hold(self):
        self.candidate = self.track = self.last_good = None
        self.held = self.progress = 0
        self.gap = False

    def update(self, name, confidence, mappings, now, uncertain=False, empty=False, brief=False, track=None):
        delta=0 if self.last_sample is None else now-self.last_sample
        if delta>STAGE_FRAME_GAP_S:
            self.clear_hold()
            self.neutral_since=None
        self.last_sample = now
        if uncertain:
            self.neutral_since=None
            if (brief and self.candidate is not None and track==self.track and
                    self.last_good is not None and now-self.last_good<=STAGE_BRIEF_GAP_S):
                self.gap=True
            else:self.clear_hold()
            return None
        mapping = next((m for m in mappings if m['gesture'] == name and
                        confidence >= m['confidence']), None)
        if mapping is None:
            self.clear_hold()
            if name == 'None':
                if self.neutral_since is None:
                    self.neutral_since = now
                if now - self.neutral_since >= (.7 if empty else .3):
                    self.latched = None
                    self.ready = True
            else:
                self.neutral_since = None
            return None
        self.neutral_since = None
        if self.candidate!=name or self.track!=track or self.gap and now-self.last_good>STAGE_BRIEF_GAP_S:
            self.clear_hold()
            self.candidate,self.track=name,track
        elif not self.gap:self.held+=max(0,delta)
        self.last_good=now
        self.gap=False
        self.progress = min(1, self.held / mapping['hold_s'])
        if self.progress >= 1 and self.latched != name and mapping['enabled']:
            return mapping
        return None

    def fired(self, name):
        self.latched = name
        self.ready = False
