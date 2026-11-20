"""Build a public controller ZIP from a Git commit and verified model archive."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import stat
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PREFIX = 'Light-Magic/'
PRIVATE_NAMES = {'profile.json', 'custom-motions.json', 'events.jsonl', 'lab-config.json',
                 'session-settings.json', 'SNAPSHOT.json', 'pending-release.json',
                 'previous-cue-sheet.json', 'previous-channel-looks.json', 'stage-cue-sheet.json',
                 'VERSION-NOTES.txt', '.DS_Store', 'Thumbs.db'}
PRIVATE_PARTS = {'.git', '.venv', 'venv', '__pycache__'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_path(name):
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or '\\' in name or not path.parts:
        raise ValueError('Unsafe archive path: ' + name)
    return path


def public_source_path(name):
    path = safe_path(name)
    if path.name in PRIVATE_NAMES or any(part in PRIVATE_PARTS for part in path.parts):
        raise ValueError('Local runtime data must not be published: ' + name)
    if any(part.startswith('.env') and part != '.env.example' for part in path.parts):
        raise ValueError('Environment settings must not be published: ' + name)
    if 'models' in path.parts or path.suffix in {'.log', '.tmp', '.pyc'}:
        raise ValueError('Runtime file must not be published as source: ' + name)
    return path


def entry(name, source=None, executable=False):
    result = zipfile.ZipInfo(name, source.date_time if source else (2026, 11, 19, 0, 0, 0))
    result.create_system = 3
    result.external_attr = (stat.S_IFREG | (0o755 if executable else 0o644)) << 16
    result.compress_type = zipfile.ZIP_DEFLATED
    return result


def assemble(source_zip, speech_zip, output, commit):
    source = zipfile.ZipFile(io.BytesIO(source_zip))
    manifest = json.loads(source.read('speech-model.json'))
    if digest(speech_zip) != manifest['sha256']:
        raise ValueError('The standard speech model archive checksum does not match')
    version = source.read('VERSION').decode().strip()
    required = ['app.py', 'START HERE.html', 'Set up Light Magic.command',
                'Set up Light Magic.bat', 'setup_light_magic.py', 'setup_speech.py',
                'requirements-speech.txt', 'Start Movement Gesture.command', 'Start Movement Gesture.bat']
    for name in required:
        if name not in source.namelist():
            raise ValueError('Missing first-time setup file: ' + name)
    camera_manifest = json.loads(source.read('web/assets/manifest.json'))
    for name, expected in camera_manifest.items():
        if digest(source.read('web/assets/' + name)) != expected['sha256']:
            raise ValueError('Camera asset checksum does not match: ' + name)
    speech = zipfile.ZipFile(io.BytesIO(speech_zip))
    model_files = []
    for item in speech.infolist():
        path = safe_path(item.filename)
        if path.parts[0] != manifest['name'] or stat.S_ISLNK(item.external_attr >> 16):
            raise ValueError('Unexpected speech model archive entry: ' + item.filename)
        if not item.is_dir():
            model_files.append(item)
    if sum(item.file_size for item in model_files) > 150_000_000:
        raise ValueError('Standard speech model is larger than expected')
    if not any(item.filename == manifest['name'] + '/am/final.mdl' for item in model_files):
        raise ValueError('Standard speech model is incomplete')
    metadata = dict(version=version, source_commit=commit, platforms=['macOS', 'Windows'],
                    python='3.12 (64-bit, installed separately)',
                    speech_model=manifest['name'], speech_archive_sha256=manifest['sha256'],
                    first_setup_requires_internet=True, enhanced_speech_included=False)
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + '.part')
    try:
        with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
            for item in source.infolist():
                if item.is_dir():
                    continue
                public_source_path(item.filename)
                if stat.S_ISLNK(item.external_attr >> 16):
                    raise ValueError('Source symlinks are not supported: ' + item.filename)
                bundle.writestr(entry(PREFIX + item.filename, item, item.filename.endswith('.command')),
                                source.read(item))
            for item in model_files:
                bundle.writestr(entry(PREFIX + 'models/' + item.filename, item), speech.read(item))
            bundle.writestr(entry(PREFIX + 'models/' + manifest['name'] + '/LICENSE-APACHE-2.0.txt'),
                            source.read('web/assets/APACHE-2.0.txt'))
            notice = ('Vosk standard English speech model\n' + manifest['name'] + '\n'
                      'Published by Alpha Cephei. License: Apache-2.0.\n'
                      'Source: ' + manifest['source'] + '\n'
                      'Original archive: ' + manifest['url'] + '\n'
                      'Original archive SHA-256: ' + manifest['sha256'] + '\n'
                      'Original model files and README are included without modification.\n'
                      'Camera asset licenses are in web/assets/.\n')
            bundle.writestr(entry(PREFIX + 'THIRD-PARTY-NOTICES.txt'), notice.encode())
            bundle.writestr(entry(PREFIX + 'BUNDLE.json'), json.dumps(metadata, indent=2).encode() + b'\n')
        if temporary.stat().st_size >= 100_000_000:
            raise ValueError('The download exceeds the GitHub file-size limit')
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    metadata.update(filename=output.name, bytes=output.stat().st_size, sha256=digest(output.read_bytes()))
    output.with_name('release.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
    output.with_name(output.name + '.sha256').write_text(metadata['sha256'] + '  ' + output.name + '\n', encoding='ascii')
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--speech-archive', type=Path, required=True, help='official, checksum-verified Vosk model ZIP')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    source = subprocess.check_output(['git', 'archive', '--format=zip', commit], cwd=ROOT)
    result = assemble(source, args.speech_archive.read_bytes(), args.output, commit)
    print(f"Built {result['filename']}: {result['bytes']/1e6:.1f} MB; source {commit[:7]}; standard speech included")


if __name__ == '__main__':
    main()
