import hashlib
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile

from tools.build_download import assemble


def archive(entries):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w') as package:
        for name, data in entries.items():
            package.writestr(name, data)
    return output.getvalue()


class DownloadBundleTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.output = Path(self.folder.name) / 'controller.zip'
        self.speech = archive({'standard/am/final.mdl': b'model', 'standard/README': b'Original model notes'})
        self.source = {
            'VERSION': 'test-version', 'app.py': '# app', 'START HERE.html': '<h1>Start</h1>',
            'Set up Light Magic.command': '#!/bin/sh\n', 'Set up Light Magic.bat': '@echo off',
            'setup_light_magic.py': '# setup', 'web/assets/APACHE-2.0.txt': 'Apache license',
            'setup_speech.py': '# speech setup', 'requirements-speech.txt': 'vosk',
            'Start Movement Gesture.command': '#!/bin/sh\n', 'Start Movement Gesture.bat': '@echo off',
            'web/assets/model.task': b'camera',
            'web/assets/manifest.json': json.dumps({'model.task': {'sha256': hashlib.sha256(b'camera').hexdigest()}}),
            'speech-model.json': json.dumps(dict(name='standard', sha256=hashlib.sha256(self.speech).hexdigest(),
                                               url='https://example.com/model.zip', source='https://example.com/models')),
        }

    def build(self):
        return assemble(archive(self.source), self.speech, self.output, 'a' * 40)

    def test_complete_download_has_models_guidance_executable_launcher_and_integrity_metadata(self):
        metadata = self.build()
        with zipfile.ZipFile(self.output) as package:
            self.assertEqual(package.read('Light-Magic/models/standard/am/final.mdl'), b'model')
            self.assertEqual(package.read('Light-Magic/models/standard/README'), b'Original model notes')
            launcher = package.getinfo('Light-Magic/Set up Light Magic.command')
            self.assertTrue(stat.S_IMODE(launcher.external_attr >> 16) & stat.S_IXUSR)
            self.assertIn('Source:', package.read('Light-Magic/THIRD-PARTY-NOTICES.txt').decode())
            self.assertIn('Light-Magic/models/standard/LICENSE-APACHE-2.0.txt', package.namelist())
            self.assertEqual(json.loads(package.read('Light-Magic/BUNDLE.json'))['source_commit'], 'a' * 40)
        self.assertEqual(metadata['sha256'], hashlib.sha256(self.output.read_bytes()).hexdigest())
        self.assertEqual(json.loads(self.output.with_name('release.json').read_text()), metadata)

    def test_private_settings_and_runtime_folders_cannot_enter_public_download(self):
        for name in ['profile.json', '.env', '.venv/pyvenv.cfg', 'events.jsonl', 'models/local/model.bin',
                     'venv/pyvenv.cfg', 'previous-cue-sheet.json', 'previous-channel-looks.json',
                     'stage-cue-sheet.json', 'VERSION-NOTES.txt']:
            with self.subTest(name=name):
                self.source[name] = 'private'
                with self.assertRaises(ValueError):
                    self.build()
                self.source.pop(name)
        self.assertFalse(self.output.exists())

    def test_tampered_model_or_camera_is_rejected_before_replacing_previous_download(self):
        self.output.write_bytes(b'previous download')
        self.source['web/assets/model.task'] = b'corrupt'
        with self.assertRaisesRegex(ValueError, 'Camera asset'):
            self.build()
        self.assertEqual(self.output.read_bytes(), b'previous download')
        self.source['web/assets/model.task'] = b'camera'
        self.speech = b'not the official archive'
        with self.assertRaisesRegex(ValueError, 'speech model archive checksum'):
            self.build()
        self.assertEqual(self.output.read_bytes(), b'previous download')

    def test_unsafe_archive_paths_never_produce_a_published_zip(self):
        self.source['../profile.json'] = 'private'
        with self.assertRaisesRegex(ValueError, 'Unsafe archive path'):
            self.build()
        self.assertFalse(self.output.exists())
        self.assertFalse(self.output.with_name(self.output.name + '.part').exists())


if __name__ == '__main__':
    unittest.main()
