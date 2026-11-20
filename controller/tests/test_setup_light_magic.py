import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from setup_light_magic import SetupError, bootstrap, environment_python, main, require_supported_python, validate_environment


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name).resolve()
        (self.root / 'app.py').touch()
        (self.root / 'setup_speech.py').touch()
        self.calls = []
        self.runtime = patch('setup_light_magic.require_supported_python')
        self.runtime.start()
        self.addCleanup(self.runtime.stop)

    def run_command(self, command, **kwargs):
        self.calls.append((command, kwargs))
        if 'venv' in command:
            executable = environment_python(self.root / '.venv')
            executable.parent.mkdir(parents=True)
            executable.touch()
        return subprocess.CompletedProcess(command, 0, stdout=json.dumps([[3, 12], 64]))

    def setup(self, **kwargs):
        return bootstrap(self.root, run=kwargs.get('run', self.run_command), is_running=kwargs.get('is_running', lambda: False), output=lambda *a, **k: None, enhanced=kwargs.get('enhanced', False))

    def test_fresh_setup_prepares_voice_before_starting_controller(self):
        self.assertEqual(self.setup(), 0)
        commands = [call[0] for call in self.calls]
        self.assertIn('venv', commands[0])
        self.assertEqual(commands[1][-1], str(self.root / 'setup_speech.py'))
        self.assertNotIn('--enhanced', commands[1])
        self.assertEqual(commands[2][-1], str(self.root / 'app.py'))
        self.assertTrue(all(call[1].get('cwd') == str(self.root) for call in self.calls))

    def test_existing_supported_environment_is_reused(self):
        python = environment_python(self.root / '.venv')
        python.parent.mkdir(parents=True); python.touch()
        self.setup()
        self.assertFalse(any('venv' in call[0] for call in self.calls))
        self.assertEqual(self.calls[0][0][0], str(python))

    def test_running_controller_is_left_alone(self):
        with self.assertRaisesRegex(SetupError, 'already running'):
            self.setup(is_running=lambda: True)
        self.assertEqual(self.calls, [])
        self.assertFalse((self.root / '.venv').exists())

    def test_failed_voice_install_does_not_start_app(self):
        def runner(command, **kwargs):
            if str(self.root / 'setup_speech.py') in command:
                raise subprocess.CalledProcessError(1, command)
            return self.run_command(command, **kwargs)
        with self.assertRaisesRegex(SetupError, 'internet connection'):
            self.setup(run=runner)
        self.assertFalse(any(str(self.root / 'app.py') in call[0] for call in self.calls))

    def test_enhanced_recognition_requires_explicit_option(self):
        self.setup(enhanced=True)
        setup_commands = [command for command, _ in self.calls if str(self.root / 'setup_speech.py') in command]
        self.assertEqual(setup_commands[0][-1], '--enhanced')

    def test_incomplete_environment_is_not_removed(self):
        venv = self.root / '.venv'; venv.mkdir()
        marker = venv / 'keep.txt'; marker.write_text('keep')
        with self.assertRaisesRegex(SetupError, 'incomplete'):
            self.setup()
        self.assertEqual(marker.read_text(), 'keep')
        self.assertEqual(self.calls, [])

    def test_partial_zip_has_clear_error_and_does_not_install(self):
        (self.root / 'setup_speech.py').unlink()
        with self.assertRaisesRegex(SetupError, 'Extract the entire ZIP'):
            self.setup()
        self.assertEqual(self.calls, [])


class RuntimeTests(unittest.TestCase):
    def test_supported_python_is_explicit(self):
        require_supported_python((3, 12, 9), 64)
        for version, bits in [((3, 11), 64), ((3, 13), 64), ((3, 12), 32)]:
            with self.subTest(version=version, bits=bits), self.assertRaisesRegex(SetupError, 'python.org'):
                require_supported_python(version, bits)

    def test_existing_unsupported_environment_has_recovery_guidance(self):
        def runner(command, **kwargs):
            return subprocess.CompletedProcess(command, 0, stdout=json.dumps([[3, 13], 64]))
        with self.assertRaisesRegex(SetupError, 'left in place'):
            validate_environment(Path('existing-python'), runner)

    def test_environment_executable_uses_the_selected_platform(self):
        folder = Path('controller') / '.venv'
        self.assertEqual(environment_python(folder, windows=True), folder / 'Scripts/python.exe')
        self.assertEqual(environment_python(folder, windows=False), folder / 'bin/python')


class MainTests(unittest.TestCase):
    def test_folder_permission_error_is_explained_without_starting_app(self):
        errors = io.StringIO()
        with patch('sys.argv', ['setup_light_magic.py']), \
                patch('setup_light_magic.require_supported_python'), \
                patch.object(Path, 'resolve', side_effect=PermissionError('Folder is not accessible')), \
                patch('setup_light_magic.subprocess.run') as run, \
                contextlib.redirect_stderr(errors):
            self.assertEqual(main(), 1)
        run.assert_not_called()
        self.assertIn('writable folder', errors.getvalue())
        self.assertNotIn('Traceback', errors.getvalue())


if __name__ == '__main__':
    unittest.main()
