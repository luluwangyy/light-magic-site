"""Validate mapping destinations and identify the selected console output."""

from decimal import Decimal, InvalidOperation
from hashlib import sha256
import json
import re


CHANNEL_OUTPUT_TYPES = ('channel_level', 'channel_look')
OUTPUT_FIELDS = ('output_type', 'channel', 'level', 'zoom', 'color', 'channels')
MAX_LOOK_CHANNELS = 32


def _decimal(value, error):
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ValueError(error)
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ValueError(error) from None
    if not number.is_finite():
        raise ValueError(error)
    return number


def _optional_percent(value, error):
    if value is None or isinstance(value, str) and not value.strip():
        return None
    value = _decimal(value, error)
    if not 0 <= value <= 100:
        raise ValueError(error)
    return float(value) or 0.0


def _optional_color(value):
    if value is None or isinstance(value, str) and not value.strip():
        return None
    if not isinstance(value, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', value.strip()):
        raise ValueError('Enter a color as six hex digits, for example #ff7700')
    return value.strip().lower()


def _channel_settings(raw):
    channel = raw.get('channel')
    if channel is None or isinstance(channel, str) and not channel.strip():
        channel = ''
    else:
        error = 'Enter a whole channel number from 1 to 99999'
        channel = _decimal(channel, error)
        if not 1 <= channel <= 99999 or channel != channel.to_integral_value():
            raise ValueError(error)
        channel = int(channel)
    return dict(
        channel=channel,
        level=_optional_percent(raw.get('level'), 'Enter a level from 0 to 100 percent'),
        zoom=_optional_percent(raw.get('zoom'), 'Enter a Zoom value from 0 to 100 percent'),
        color=_optional_color(raw.get('color')),
    )


def _has_channel_settings(row):
    return bool(row['channel']) and any(row[field] is not None for field in ('level', 'zoom', 'color'))


def _validate_look(rows):
    if not isinstance(rows, list) or len(rows) > MAX_LOOK_CHANNELS:
        raise ValueError(f'Use a list of up to {MAX_LOOK_CHANNELS} channels in a look')
    channels = {}
    for item in rows:
        if not isinstance(item, dict):
            raise ValueError('Each row needs a channel and fixture settings')
        row = _channel_settings(item)
        if not _has_channel_settings(row):
            raise ValueError('Assign a channel and at least one setting in each look row')
        channel = row['channel']
        if channel in channels:
            raise ValueError(f'Channel {channel} appears more than once in this look')
        channels[channel] = {key: value for key, value in row.items() if value is not None}
    return [channels[channel] for channel in sorted(channels)]


def validate_mapping_output(raw, *, required=False):
    """Clean the optional channel fields while preserving existing cue fields.

    Legacy rows stay cue-only. Callers apply their existing cue validation
    and pass whether a selected channel destination must be complete.
    """
    if not any(field in raw for field in OUTPUT_FIELDS):
        return {}
    output_type = raw.get('output_type', 'cue')
    if output_type != 'cue' and output_type not in CHANNEL_OUTPUT_TYPES:
        raise ValueError('Choose Cue or Channel level, or choose a Channel look for multiple fixtures')
    settings = _channel_settings(raw)
    if required and output_type == 'channel_level' and not _has_channel_settings(settings):
        raise ValueError('Assign a channel and level, Zoom, or color before enabling this mapping')
    result = dict(output_type=output_type, channel=settings['channel'], level=settings['level'])
    for field in ('zoom', 'color'):
        if field in raw:
            result[field] = settings[field]
    if output_type == 'channel_look' or 'channels' in raw:
        result['channels'] = _validate_look(raw.get('channels', []))
        if required and output_type == 'channel_look' and not result['channels']:
            raise ValueError('Add at least one channel before enabling this look')
    return result


def mapping_target(mapping):
    """Build the selected output from a validated mapping or return None."""
    output_type = mapping.get('output_type', 'cue')
    if output_type == 'cue' and mapping.get('cue'):
        cue_list, cue = mapping['cue_list'], mapping['cue']
        return dict(id=f'cue:{cue_list}:{cue}', output_type='cue', cue_list=cue_list, cue=cue,
                    command=f'Cue {cue} (list {cue_list})')
    if output_type == 'channel_look':
        channels = mapping.get('channels', [])
        if not channels:
            return None
        canonical = _validate_look(channels)
        digest = sha256(json.dumps(canonical, separators=(',', ':'), sort_keys=True).encode()).hexdigest()
        count = len(canonical)
        noun = 'channel' if count == 1 else 'channels'
        return dict(id=f'channel_look:{digest}', output_type=output_type, channels=canonical,
                    command=f'Channel look · {count} {noun}')
    if output_type == 'channel_level':
        channel, level = mapping.get('channel'), mapping.get('level')
        zoom, color = mapping.get('zoom'), mapping.get('color')
        if not channel or all(value is None for value in (level, zoom, color)):
            return None

        level = (level or 0.0) if level is not None else None
        percent = '' if level is None else str(level).removesuffix('.0')
        command = f'Chan {channel}' if level is None else f'Chan {channel} @ {percent}'
        target = dict(id=f'channel_level:{channel}:{percent}', output_type='channel_level', channel=channel, level=level)
        if zoom is not None:
            zoom = zoom or 0.0
            zoom_text = str(zoom).removesuffix('.0')
            target['zoom'] = zoom
            target['id'] += f':zoom:{zoom_text}'
            command += f' · Zoom {zoom_text}%'
        if color is not None:
            target['color'] = color
            target['id'] += f':color:{color[1:]}'
            command += f' · {color}'
        target['command'] = command
        return target
    return None


def output_key(target):
    """Identify numerically equivalent outputs for pacing and deduplication."""
    output_type = target.get('output_type', 'cue')
    if output_type == 'channel_look':
        rows = target['channels']
        if len(rows) == 1:
            return output_key(dict(level=None) | rows[0] | {'output_type': 'channel_level'})
        return 'channel_look', target['id']
    if output_type == 'channel_level':
        key = 'channel_level', target['channel'], target['level']
        if 'zoom' in target or 'color' in target:
            return (*key, target.get('zoom'), target.get('color'))
        return key
    return 'cue', target['cue_list'], Decimal(target['cue'])
