"""A single, expiring console output request shared by all recognition inputs."""

from dataclasses import dataclass
from mapping_outputs import output_key

CAMERA_MAX_AGE = 2.0
EVENT_MAX_AGE = .8
CAMERA_EVIDENCE_MAX_AGE = .35


def output_label(target):
    return f"Cue {target['cue']}" if target['output_type'] == 'cue' else target['command']


@dataclass(frozen=True)
class CueIntent:
    source: str
    identity: str
    target: dict
    at: float
    revision: int
    epoch: int
    owner: str
    track: object = None

    @property
    def destination(self):
        return output_key(self.target)

    @property
    def max_age(self):
        return CAMERA_MAX_AGE if self.source == 'camera' else EVENT_MAX_AGE


class CueLane:
    """No FIFO and no retry. A continuous pose cannot renew an event."""

    def __init__(self):
        self.pending = None
        self.last_at = float('-inf')
        self.last_target_at = float('-inf')
        self.last_target = None
        self.last_source = None
        self.last_identity = None
        self.status = {'kind': 'idle'}

    def remaining(self, now, gap):
        return max(0, self.last_at + gap - now)

    def record(self, kind, intent, reason=None):
        self.status = dict(intent.target, kind=kind, source=intent.source, identity=intent.identity)
        if reason:
            self.status['reason'] = reason

    def cancel(self, reason, source=None):
        intent = self.pending
        if intent is not None and (source is None or intent.source == source):
            self.pending = None
            self.record('dropped', intent, reason)

    def expire(self, now):
        if self.pending is not None and now - self.pending.at > self.pending.max_age:
            self.cancel('The request expired. Repeat the trigger when ready.')

    def offer(self, intent, now, gap):
        """Keep one request; return the rejection reason, or None if accepted."""
        self.expire(now)
        if self.pending and self.pending.destination == intent.destination:
            return 'This output is already waiting for console spacing.'
        same_trigger=(intent.source==self.last_source and intent.identity==self.last_identity)
        # A producer already requires its deliberate rearm/cooldown. Let a new
        # event from that trigger wait for spacing rather than consume it as a
        # duplicate. Independent inputs aimed at the same output still coalesce.
        if not same_trigger and self.last_source != 'manual' and intent.destination == self.last_target and now - self.last_target_at < max(3, gap):
            reason = 'Duplicate output suppressed.'
            if self.pending is None:
                self.record('dropped', intent, reason)
            return reason
        if self.pending is not None:
            ready_at = now + self.remaining(now, gap)
            if (intent.at + intent.max_age < ready_at <= self.pending.at + self.pending.max_age):
                return 'This request would expire before console spacing allows it. Repeat when ready.'
        self.pending = intent
        self.record('waiting', intent)

    def observe_camera(self, now, matches):
        self.expire(now)
        if self.pending and self.pending.source == 'camera' and not matches(self.pending):
            self.cancel('Pose changed or tracking was lost.', 'camera')

    def pace_after_write(self, now):
        self.last_at = now

    def sent(self, target, now, source, identity=None):
        self.pace_after_write(now)
        self.last_target, self.last_target_at, self.last_source = target, now, source
        self.last_identity=identity

    def snapshot(self, now, gap):
        return dict(self.status, gap_s=gap, wait_s=round(self.remaining(now, gap), 2))
