import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import install_chat


class DownloadTests(unittest.TestCase):
    def test_truncated_responses_resume_partial_chunks_and_verify_hash(self):
        payload = bytes(range(128))
        starts = []
        class Response(io.BytesIO):
            status = 206
            def __init__(self, start, end):
                # Correct range headers followed by a prematurely closed body.
                super().__init__(payload[start:min(end + 1, start + 9)])
                self.headers = {'Content-Range': f'bytes {start}-{end}/{len(payload)}'}
        def open_range(request, **kwargs):
            start, end = map(int, request.get_header('Range')[6:].split('-'))
            starts.append(start)
            return Response(start, end)
        with tempfile.TemporaryDirectory() as folder, patch.object(install_chat, 'RANGED_MIN_BYTES', 32), patch.object(install_chat, 'CHUNK_BYTES', 16), patch.object(install_chat.urllib.request, 'urlopen', side_effect=open_range), patch.object(install_chat.time, 'sleep'):
            target = Path(folder) / 'model.gguf'
            install_chat.download('https://fixture/model', target, hashlib.sha256(payload).hexdigest(), len(payload))
            self.assertEqual(target.read_bytes(), payload)
            self.assertTrue(any(start % 16 == 9 for start in starts))
            self.assertFalse(target.with_suffix('.chunks').exists())


if __name__ == '__main__':
    unittest.main()
