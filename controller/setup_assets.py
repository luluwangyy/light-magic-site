"""Run once with internet; runtime uses only these local assets."""
from pathlib import Path
import urllib.request
import hashlib
import json

ROOT = Path(__file__).parent / 'web' / 'assets'
VERSION = '0.10.22-rc.20250304'
BASE = f'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@{VERSION}/'
FILES = {name: BASE + name for name in ['vision_bundle.mjs', 'wasm/vision_wasm_internal.js', 'wasm/vision_wasm_internal.wasm', 'wasm/vision_wasm_nosimd_internal.js', 'wasm/vision_wasm_nosimd_internal.wasm']}
FILES['gesture_recognizer.task'] = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task'
FILES['pose_landmarker_lite.task'] = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'
FILES['LICENSE'] = BASE + 'README.md'
FILES['APACHE-2.0.txt'] = 'https://www.apache.org/licenses/LICENSE-2.0.txt'
PINNED = {
    'pose_landmarker_lite.task': '59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a',
    'APACHE-2.0.txt': 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
}
POSE_CARD = 'https://storage.googleapis.com/mediapipe-assets/Model%20Card%20BlazePose%20GHUM%203D.pdf'

def main():
    manifest = {}
    for name, url in FILES.items():
        dest = ROOT / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        print('Downloading', name, flush=True)
        with urllib.request.urlopen(url, timeout=90) as response:
            data = response.read()
        digest = hashlib.sha256(data).hexdigest()
        if name in PINNED and digest != PINNED[name]:
            raise RuntimeError(f'{name} does not match its pinned SHA-256; existing asset was not replaced')
        dest.write_bytes(data)
        manifest[name] = dict(url=url, bytes=len(data), sha256=digest)
        if name == 'pose_landmarker_lite.task':
            manifest[name].update(license='Apache-2.0', model_card=POSE_CARD)
    (ROOT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8', newline='\n')
    print('Offline assets ready.')

if __name__ == '__main__':
    main()
