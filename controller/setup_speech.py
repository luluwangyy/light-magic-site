"""Explicit one-time setup; runtime speech recognition has no network calls."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import urllib.request
import zipfile

ROOT=Path(__file__).resolve().parent


def install(requirements):
    subprocess.run([sys.executable,'-m','pip','install','--disable-pip-version-check',
                    '-r',str(ROOT/requirements)],check=True)


def sha256(path):
    checksum = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024*1024), b''):
            checksum.update(chunk)
    return checksum.hexdigest()


def setup_vosk():
    install('requirements-speech.txt')
    manifest=json.loads((ROOT/'speech-model.json').read_text(encoding='utf-8'))
    models=ROOT/'models';models.mkdir(exist_ok=True)
    model=models/manifest['name']
    if not (model/'am'/'final.mdl').is_file():
        archive=models/'speech-model.download.zip'
        print('Downloading the official English speech model (about 40 MB)…',flush=True)
        urllib.request.urlretrieve(manifest['url'],archive)
        digest=sha256(archive)
        if digest!=manifest['sha256']:raise ValueError('Speech model checksum does not match; rerun setup')
        with zipfile.ZipFile(archive) as package:
            for item in package.infolist():
                target=(models/item.filename).resolve()
                if not target.is_relative_to(models.resolve()):raise ValueError('Invalid speech model archive path')
            package.extractall(models)
        archive.unlink()
    from speech import SpeechEngine, DEFAULT_SPEECH_MAPPINGS
    recognizer=SpeechEngine(model, backend='vosk')
    result=recognizer.start([row['phrase'] for row in DEFAULT_SPEECH_MAPPINGS])
    recognizer.stop()
    if result['unknown_words']:
        print('Vosk may miss these words: '+', '.join(result['unknown_words']))


def setup_enhanced():
    from speech_enhanced import MODEL_FILES, MODEL_NAME
    install('requirements-speech-enhanced.txt')
    manifest = json.loads((ROOT/'speech-enhanced-model.json').read_text(encoding='utf-8'))
    if manifest['name'] != MODEL_NAME or set(manifest['files']) != set(MODEL_FILES):
        raise ValueError('Enhanced speech model manifest does not match the decoder')
    destination = ROOT/'models'/MODEL_NAME
    destination.mkdir(parents=True, exist_ok=True)
    base = f"https://huggingface.co/{manifest['repository']}/resolve/{manifest['revision']}"
    for name, expected in manifest['files'].items():
        path = destination/name
        if path.is_file() and path.stat().st_size == expected['bytes'] and sha256(path) == expected['sha256']:
            continue
        part = path.with_name(name+'.part')
        print(f"Downloading {name} ({expected['bytes']/1e6:.1f} MB)…", flush=True)
        try:
            checksum = hashlib.sha256()
            size = 0
            with urllib.request.urlopen(base+'/'+name, timeout=60) as source, part.open('wb') as sink:
                for chunk in iter(lambda: source.read(1024*1024), b''):
                    size += len(chunk)
                    if size > expected['bytes']:
                        raise ValueError(f'Enhanced speech file is larger than expected: {name}')
                    sink.write(chunk)
                    checksum.update(chunk)
            if size != expected['bytes'] or checksum.hexdigest() != expected['sha256']:
                raise ValueError(f'Enhanced speech file checksum does not match: {name}')
            part.replace(path)
        finally:
            part.unlink(missing_ok=True)
    from speech_enhanced import load_decoder
    print('Checking the enhanced model on this CPU…', flush=True)
    load_decoder(destination)
    print('Enhanced recognition is installed. Choose Enhanced in Speech settings to compare it with Standard.')


def setup(enhanced=False):
    if importlib.util.find_spec('pip') is None:
        subprocess.run([sys.executable,'-m','ensurepip','--upgrade'],check=True)
    setup_vosk()
    if enhanced:
        setup_enhanced()
    print('Offline speech is ready. Restart Light Magic, then choose Speech or Camera + speech.')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description='Install offline speech recognition for Light Magic')
    parser.add_argument('--enhanced', action='store_true', help='also install the enhanced English model (about 150 MB)')
    args=parser.parse_args()
    try:setup(args.enhanced)
    except (OSError,ValueError,RuntimeError,ImportError,subprocess.CalledProcessError) as error:
        print('Speech setup did not complete: '+str(error),file=sys.stderr)
        sys.exit(1)
