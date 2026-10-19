#!/usr/bin/env python3
"""Build small, British-English MP3 fallbacks for every published word."""

import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    weeks = json.loads((ROOT / 'data/weeks.json').read_text())['weeks']
    phonics = json.loads((ROOT / 'data/phonics.json').read_text())
    words = {}
    for week in weeks:
        for row in week['rows']:
            for word in row:
                key = word['en'].lower().strip()
                words[key] = phonics.get(key, {}).get('say') or word['en']

    audio_dir = ROOT / 'audio'
    audio_dir.mkdir(exist_ok=True)
    assets = {}
    with tempfile.TemporaryDirectory(prefix='maimai-audio-') as temp:
        temp_dir = Path(temp)
        for key, text in words.items():
            filename = hashlib.sha256(key.encode()).hexdigest()[:16] + '.mp3'
            wav = temp_dir / (filename + '.wav')
            mp3 = audio_dir / filename
            subprocess.run(
                ['espeak-ng', '-v', 'en-gb-x-rp', '-s', '142', '-a', '170', '-w', str(wav), text],
                check=True,
            )
            subprocess.run(
                ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(wav),
                 '-ar', '24000', '-ac', '1', '-codec:a', 'libmp3lame', '-b:a', '48k', str(mp3)],
                check=True,
            )
            assets[key] = 'audio/' + filename

    (ROOT / 'data/audio.json').write_text(json.dumps(assets, ensure_ascii=False, indent=2) + '\n')
    total = sum((audio_dir / Path(path).name).stat().st_size for path in assets.values())
    print(f'Built {len(assets)} British-English pronunciation files ({total:,} bytes).')


if __name__ == '__main__':
    main()
