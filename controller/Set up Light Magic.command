#!/bin/sh
cd "$(dirname "$0")" || exit 1

python_command=''
for candidate in python3.12 python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 &&
       "$candidate" -c 'import struct,sys; sys.exit(sys.version_info[:2] != (3,12) or struct.calcsize("P") != 8)' >/dev/null 2>&1; then
        python_command="$candidate"
        break
    fi
done

if [ -z "$python_command" ]; then
    printf '%s\n' 'Light Magic needs 64-bit Python 3.12.' \
        'Install the macOS universal2 Python 3.12 package from https://www.python.org/downloads/release/python-31210/ then open this setup again.' \
        'Extract the entire Light Magic ZIP before running setup.'
else
    "$python_command" setup_light_magic.py "$@"
fi
printf '\n%s\n' 'Press Return to close this window.'
read -r answer
