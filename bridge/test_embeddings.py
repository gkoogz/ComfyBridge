import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
from model_library import Library, embedding_encoder, roots


class EmbeddingCatalogueTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.library=Library(self.root/'comfy',self.root/'data')

    def test_header_compatibility_without_loading_weights(self):
        path=self.root/'neutral.safetensors'
        for tensors,expected in [({'clip_l':{'shape':[16,768]},'clip_g':{'shape':[16,1280]}},'SDXL'),({'emb_params':{'shape':[8,768]}},'SD 1.x'),({'unknown':{'shape':[8,4096]}},'')]:
            data=json.dumps(tensors).encode();path.write_bytes(struct.pack('<Q',len(data))+data)
            self.assertEqual(embedding_encoder(path),expected)
        self.assertEqual(embedding_encoder(path.with_suffix('.pt')),'')

    def test_search_is_cached_and_remote_results_not_installed(self):
        raw={'items':[{'id':8,'type':'TextualInversion','name':'Pottery','creator':{'username':'Artist'},'modelVersions':[
            {'id':7,'name':'v1','baseModel':'SDXL','files':[{'name':'pottery.safetensors','sizeKB':10,'hashes':{'SHA256':'a'*64}}], 'images':[]}]}], 'metadata':{}}
        with patch('model_library.fetch',return_value=json.dumps(raw).encode()) as fetch:
            result=self.library.search_embeddings('pottery');self.assertEqual(result['items'][0]['baseModel'],'SDXL')
            self.assertEqual(self.library.snapshot()['items'],[])
            self.library.search_embeddings('pottery');self.assertEqual(fetch.call_count,1)
            with patch.object(self.library,'inspect'):self.library.scan(force=True)
            with self.library.db() as db:self.assertEqual(db.execute("SELECT count(*) FROM assets WHERE kind='embedding_remote'").fetchone()[0],1)
        self.assertIn('embeddings',roots(self.library.root))

    def test_all_local_embedding_formats_are_indexed_but_placeholder_is_not(self):
        folder=self.library.root/'models/embeddings';folder.mkdir(parents=True)
        for name in ['neutral.safetensors','another.pt','third.bin','put_embeddings_here']:(folder/name).write_bytes(b'fixture')
        with patch.object(self.library,'inspect') as inspect:self.library.scan(force=True)
        self.assertEqual({call.args[2] for call in inspect.call_args_list},{'neutral.safetensors','another.pt','third.bin'})
        self.assertTrue(all(call.args[1]=='embeddings' for call in inspect.call_args_list))
