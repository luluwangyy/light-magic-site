#!/bin/sh
cd "$(dirname "$0")" || exit 1

python=python3
if [ -x .venv/bin/python ]; then
    python=.venv/bin/python
fi
if ! "$python" -c 'import sys; sys.exit(sys.version_info < (3, 10))' >/dev/null 2>&1; then
    printf '%s\n' 'Light Magic needs Python 3.10 or later. Install Python 3.12 or 3.13 and try again.' >&2
    exit 1
fi
exec "$python" app.py
