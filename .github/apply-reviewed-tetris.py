"""Apply reviewed, hash-locked text edits; never execute manifest content."""
import base64
import gzip
import hashlib
import json
from pathlib import Path, PurePosixPath

root = Path.cwd().resolve()
encoded = ''.join((root / f'.github/tetris-edit-part-{i}.b64').read_text() for i in (1, 2, 3))
plans = [
    (gzip.decompress(base64.b64decode(encoded, validate=True)), 'cdce1c3b3dd104824899de88ac033217ee7f2bab648addec694b06d58e0db2d1'),
    ((root / '.github/tetris-fixups.json').read_bytes(), 'e35fb92d42422cebdc7c08101999ceefb07b3dca0b954c71b51866289f27dc4c'),
    ((root / '.github/tetris-fixups-2.json').read_bytes(), 'b542264366250e2d013cb8febd5152493261e42b6fff02fe95402a82512e1656'),
]
for raw, expected in plans:
    if hashlib.sha256(raw).hexdigest() != expected:
        raise SystemExit('Reviewed edit manifest checksum mismatch')
    prepared = []
    seen = set()
    for item in json.loads(raw):
        name = item['path']
        rel = PurePosixPath(name)
        if rel.is_absolute() or '..' in rel.parts or '\\' in name or name in seen:
            raise SystemExit('Invalid or duplicate edit path')
        if not (name.startswith(('src/', 'scripts/', 'tests/')) or name.startswith('vite.') and '/' not in name):
            raise SystemExit('Edit is outside reviewed source scope: ' + name)
        seen.add(name)
        file = root / name
        if file.is_symlink() or not file.resolve().is_relative_to(root):
            raise SystemExit('Symlink/outside-root edit refused: ' + name)
        before = file.read_bytes() if file.exists() else b''
        if hashlib.sha256(before).hexdigest() != item['before']:
            raise SystemExit('Source changed since review: ' + name)
        lines = before.decode('utf-8').splitlines(keepends=True)
        upper = len(lines)
        for start, end, replacement in reversed(item['edits']):
            if not 0 <= start <= end <= upper or not isinstance(replacement, str):
                raise SystemExit('Invalid edit range: ' + name)
            lines[start:end] = [replacement]
            upper = start
        after = ''.join(lines).encode('utf-8')
        if hashlib.sha256(after).hexdigest() != item['after']:
            raise SystemExit('Output differs from reviewed file: ' + name)
        prepared.append((file, after))
    for file, after in prepared:
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(after)
    print(f'Applied {len(prepared)} reviewed files with before/after SHA-256 verification.')
