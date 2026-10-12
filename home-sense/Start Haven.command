#!/bin/zsh
haven_dir=${0:A:h}
haven_python="$haven_dir/.venv/bin/python"
cd "$haven_dir" || exit 1
if [[ ! -x "$haven_python" ]]; then
 print 'The Haven environment is missing. Create it with a supported Python, then install requirements.txt.'
 exit 1
fi
if [[ ! -f dist/index.html ]]; then
 npm ci && npm run build || exit 1
fi
print 'Open http://127.0.0.1:8768. Press Ctrl+C to stop Haven.'
exec "$haven_python" server.py
