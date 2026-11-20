#!/bin/sh
cd "$(dirname "$0")" || exit 1

python=.venv/bin/python
if [ ! -x "$python" ]; then
    python=python3
fi
if ! "$python" -c 'import sys; sys.exit(sys.version_info < (3, 10))' >/dev/null 2>&1; then
    printf '%s\n' 'Speech setup needs Python 3.10 or later. Install Python 3.12 or 3.13 and try again.' >&2
    exit 1
fi
if [ "$python" = python3 ]; then
    "$python" -m venv .venv || exit 1
fi
exec .venv/bin/python setup_speech.py "$@"
