"""One-time local setup. Normal launchers do not install or download anything."""
import argparse
import json
from pathlib import Path
import socket
import struct
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
PYTHON_HELP = 'Install the 64-bit Python 3.12 release from https://www.python.org/downloads/release/python-31210/ and open this setup again.'


class SetupError(RuntimeError):
    pass


def require_supported_python(version=None, bits=None):
    version = sys.version_info if version is None else version
    bits = struct.calcsize('P') * 8 if bits is None else bits
    if tuple(version[:2]) != (3, 12) or bits != 64:
        raise SetupError('Light Magic setup needs 64-bit Python 3.12. ' + PYTHON_HELP)


def controller_running():
    try:
        with socket.create_connection(('127.0.0.1', 8765), timeout=.3):
            return True
    except ConnectionRefusedError:
        return False
    except OSError as error:
        # A local refusal/timeout means nothing is listening. Permission errors
        # should be explained rather than treated as permission to start twice.
        if isinstance(error, PermissionError):
            raise SetupError('The local controller check was blocked. Close any Light Magic launcher and allow local connections, then try again.') from error
        return False


def environment_python(folder, windows=None):
    windows = sys.platform == 'win32' if windows is None else windows
    return folder / ('Scripts/python.exe' if windows else 'bin/python')


def validate_environment(executable, run):
    try:
        result = run([str(executable), '-c',
                      'import json,struct,sys; print(json.dumps([list(sys.version_info[:2]),struct.calcsize("P")*8]))'],
                     capture_output=True, text=True, check=True)
        version, bits = json.loads(result.stdout)
        require_supported_python(version, bits)
    except (OSError, ValueError, subprocess.CalledProcessError, SetupError) as error:
        raise SetupError('The existing .venv is not a working 64-bit Python 3.12 environment. '
                         'Keep your saved files, extract a fresh copy of the controller into a new folder, '
                         'and run this setup there. The existing environment has been left in place.') from error


def bootstrap(root=ROOT, run=subprocess.run, is_running=controller_running, output=print, enhanced=False):
    require_supported_python()
    root = Path(root).resolve()
    if not (root / 'app.py').is_file() or not (root / 'setup_speech.py').is_file():
        raise SetupError('Controller files are missing. Extract the entire ZIP first, then open the setup launcher inside the extracted folder.')
    if is_running():
        raise SetupError('A controller is already running at http://127.0.0.1:8765. '
                         'Close its launcher first, then open this setup again. Setup has not changed it.')
    output('Light Magic: first-time setup', flush=True)
    output('Keep this window open. Internet is needed to install the voice packages.', flush=True)
    output('The standard English model is included in the full download; missing files download only when needed.', flush=True)
    if enhanced:
        output('Enhanced voice recognition was requested. Its optional model adds about 150 MB.', flush=True)
    output('Your saved mappings and console settings stay in this folder.', flush=True)
    venv = root / '.venv'
    python = environment_python(venv)
    if venv.exists():
        if not python.is_file():
            raise SetupError('An incomplete .venv folder already exists. Extract the controller into a fresh folder and run setup there. No existing files were removed.')
        validate_environment(python, run)
    else:
        output('Creating the local Python environment…', flush=True)
        try:
            run([sys.executable, '-m', 'venv', str(venv)], check=True, cwd=str(root))
        except (OSError, subprocess.CalledProcessError) as error:
            raise SetupError('The Python environment could not be created. Use the full Python 3.12 installer from python.org, '
                             'extract the ZIP to a writable folder such as Documents, and try setup again.') from error
        if not python.is_file():
            raise SetupError('Python did not create the expected environment. Extract into a new writable folder and try setup again.')
    output('Installing and checking offline voice recognition. Downloads may take several minutes…', flush=True)
    try:
        command = [str(python), '-u', str(root / 'setup_speech.py')]
        if enhanced:
            command.append('--enhanced')
        run(command, check=True, cwd=str(root))
    except (OSError, subprocess.CalledProcessError) as error:
        raise SetupError('Voice setup did not finish. Check the error above and your internet connection, '
                         'then open this same setup launcher again. Existing model downloads are reused. '
                         'For a camera-only session, use the normal Start Movement Gesture launcher.') from error
    output('Setup complete. Starting Light Magic…', flush=True)
    output('Next time, use Start Movement Gesture for normal offline startup.', flush=True)
    try:
        result = run([str(python), '-u', str(root / 'app.py')], cwd=str(root))
    except OSError as error:
        raise SetupError('Setup finished, but the controller could not start. Open the normal Start Movement Gesture launcher in this folder.') from error
    if result.returncode:
        raise SetupError('The controller stopped with an error. Check the message above. If port 8765 is already in use, close the other Light Magic launcher and start again.')
    return 0


def main():
    parser = argparse.ArgumentParser(description='Set up Light Magic locally, then start the controller')
    parser.add_argument('--enhanced', action='store_true', help='also install the optional enhanced speech model (about 150 MB)')
    args = parser.parse_args()
    try:
        return bootstrap(enhanced=args.enhanced)
    except SetupError as error:
        print('\nSetup needs attention: ' + str(error), file=sys.stderr, flush=True)
        return 1
    except OSError:
        print('\nSetup needs attention: The controller folder could not be accessed. '
              'Extract the entire ZIP into a writable folder such as Documents, '
              'then open the setup launcher there. Check that this folder is not read-only.',
              file=sys.stderr, flush=True)
        return 1
    except KeyboardInterrupt:
        print('\nLight Magic stopped. Open setup again if installation had not finished.', flush=True)
        return 130


if __name__ == '__main__':
    raise SystemExit(main())
