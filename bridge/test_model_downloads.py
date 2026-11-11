import hashlib
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.request

from model_downloads import Downloads, DownloadRedirect, download_host, download_url, filename, MAX_BYTES
from model_library import Library, request_for


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)/'comfy';self.data=Path(self.temp.name)/'data'
        self.library=Library(self.root,self.data);self.downloads=Downloads(self.library,background=False)
        self.payload=b'neutral fixture weights, never loaded\n'*64
        self.digest=hashlib.sha256(self.payload).hexdigest()
        self.raw=dict(id=7,modelId=8,name='Version 2',baseModel='SDXL',trainedWords=['ceramic glaze'],
                      model=dict(name='Pottery detail',type='LORA'),description='A neutral fixture.',
                      files=[dict(id=9,name='pottery.safetensors',type='Model',primary=True,sizeKB=len(self.payload)/1024,
                                  hashes=dict(SHA256=self.digest),metadata=dict(format='SafeTensor'),
                                  downloadUrl='https://civitai.com/api/download/models/7?type=Model&format=SafeTensor')])
        self.fetch=patch('model_downloads.fetch',side_effect=lambda *args,**kwargs:json.dumps(self.raw).encode()).start()
        self.addCleanup(patch.stopall)
        self.enrich=patch.object(self.library,'inspect').start()
        self.open=patch('model_downloads.open_download',side_effect=self.response).start()
        self.folder=self.root/'models/loras'
    def response(self,*args):
        response=io.BytesIO(self.payload);response.headers={'Content-Length':str(len(self.payload))};return response
    def queue(self):
        plan=self.downloads.prepare('7');self.downloads.start(plan['confirmation']);return plan
    def finish(self):self.downloads.run()
    def test_prepare_and_cancel_do_not_download_or_create_a_model_folder(self):
        plan=self.downloads.prepare(7)
        self.assertEqual(plan['status'],'confirm');self.assertEqual(plan['baseModel'],'SDXL')
        self.assertEqual(plan['filename'],'pottery.safetensors');self.assertEqual(plan['bytes'],len(self.payload))
        self.open.assert_not_called();self.assertFalse(self.folder.exists());self.assertFalse(self.downloads.busy())
    def test_verified_file_is_published_and_available_to_other_devices(self):
        self.queue();self.assertTrue(self.downloads.busy());self.finish()
        file=self.folder/'pottery.safetensors';self.assertEqual(file.read_bytes(),self.payload)
        self.assertFalse(list(self.folder.rglob('*.part')));self.assertFalse(self.downloads.busy())
        other=Downloads(Library(self.root,self.data),background=False)
        self.assertEqual(other.status(['7'])['7'],dict(status='installed',name='pottery.safetensors'))
        item=self.library.snapshot()['items'][0]
        self.assertEqual(item['sha256'],self.digest);self.assertEqual(item['keywords'],['ceramic glaze'])
        self.assertEqual(item['versionId'],7);self.assertEqual(item['title'],'Pottery detail')
    def test_two_confirmations_and_duplicate_submits_download_once(self):
        first=self.downloads.prepare('7');second=self.downloads.prepare('7')
        self.downloads.start(first['confirmation']);self.downloads.start(first['confirmation']);self.downloads.start(second['confirmation'])
        self.finish();self.open.assert_called_once()
        self.assertEqual(len(list(self.folder.glob('*.safetensors'))),1)
        self.fetch.reset_mock();self.assertEqual(self.downloads.prepare('7')['status'],'installed');self.fetch.assert_not_called()
    def test_background_download_finishes_without_a_phone_and_other_device_does_not_duplicate_it(self):
        entered=threading.Event();release=threading.Event()
        original=self.response
        def held(*args):
            response=original();read=response.read
            def block(size=-1):entered.set();release.wait(4);return read(size)
            response.read=block;return response
        self.open.side_effect=held
        first=self.downloads.prepare('7');second=self.downloads.prepare('7')
        manager=Downloads(self.library);manager.start(first['confirmation'])
        thread=manager.thread
        try:
            self.assertTrue(entered.wait(3));self.assertTrue(manager.busy())
            self.downloads.start(second['confirmation'])
            self.assertEqual(self.downloads.status(['7'])['7']['status'],'downloading')
        finally:release.set();thread.join(5)
        self.assertFalse(thread.is_alive());self.open.assert_called_once()
        self.assertEqual(self.downloads.status(['7'])['7']['status'],'installed')
    def test_missing_or_expired_confirmation_never_queues(self):
        with self.assertRaises(ValueError):self.downloads.start('unconfirmed')
        plan=self.downloads.prepare('7')
        with self.library.db() as db:db.execute('UPDATE model_download_plans SET created=?',(time.time()-1000,))
        with self.assertRaises(ValueError):self.downloads.start(plan['confirmation'])
        self.assertFalse(self.downloads.busy());self.open.assert_not_called()
    def test_checksum_failure_keeps_existing_files_and_exposes_no_partial_model(self):
        self.queue();self.payload=b'<html>not model weights</html>';self.finish()
        status=self.downloads.status(['7'])['7'];self.assertEqual(status['status'],'error');self.assertIn('SHA-256',status['error'])
        self.assertFalse(list(self.folder.glob('*.safetensors')));self.assertFalse(list(self.folder.rglob('*.part')))
        self.assertEqual(self.library.snapshot()['items'],[])
    def test_filename_collision_preserves_original_and_uses_versioned_name(self):
        self.folder.mkdir(parents=True);original=self.folder/'pottery.safetensors';original.write_bytes(b'own unrelated model')
        self.queue();self.finish()
        self.assertEqual(original.read_bytes(),b'own unrelated model')
        self.assertEqual((self.folder/('pottery_civitai_v7_'+self.digest[:8]+'.safetensors')).read_bytes(),self.payload)
        self.assertEqual(self.downloads.status(['7'])['7']['status'],'installed')
    def test_matching_existing_unindexed_file_is_recognized_without_download(self):
        self.folder.mkdir(parents=True);(self.folder/'pottery.safetensors').write_bytes(self.payload)
        self.assertEqual(self.downloads.prepare('7')['status'],'installed');self.open.assert_not_called()
    def test_deleted_or_modified_local_model_does_not_get_a_false_checkmark(self):
        self.queue();self.finish();file=self.folder/'pottery.safetensors'
        file.write_bytes(b'changed by user')
        self.assertEqual(self.downloads.status(['7'])['7']['status'],'available')
        file.unlink();self.assertEqual(self.downloads.status(['7'])['7']['status'],'available')
    def test_new_manager_resumes_a_confirmed_queue_after_restart(self):
        self.queue();other=Downloads(self.library,background=False);other.recover();other.run()
        self.assertEqual(other.status(['7'])['7']['status'],'installed')
    def test_dead_owner_restarts_partial_file_but_live_owner_is_not_stolen(self):
        self.queue()
        with self.library.db() as db:db.execute("UPDATE model_downloads SET status='downloading',owner=99999999,born=1,received=10")
        stage=self.folder/'.comfybridge-downloads';stage.mkdir(parents=True)
        (stage/('7-'+self.digest+'.part')).write_bytes(b'old partial')
        self.downloads.recover();self.assertEqual(self.downloads.status(['7'])['7']['status'],'queued');self.finish()
        self.assertEqual((self.folder/'pottery.safetensors').read_bytes(),self.payload)
        with self.library.db() as db:
            db.execute("UPDATE model_downloads SET status='downloading',owner=?,born=?",(self.downloads.pid,self.downloads.born))
        self.downloads.recover()
        with self.library.db() as db:self.assertEqual(db.execute('SELECT status FROM model_downloads').fetchone()[0],'downloading')
    def test_wrong_resource_type_pickle_missing_hash_and_bad_urls_are_rejected(self):
        for change in ('type','pickle','hash','url'):
            raw=json.loads(json.dumps(self.raw))
            if change=='type':self.raw['model']['type']='Checkpoint'
            if change=='pickle':self.raw['files'][0]['name']='weights.ckpt'
            if change=='hash':self.raw['files'][0]['hashes']={}
            if change=='url':self.raw['files'][0]['downloadUrl']='http://127.0.0.1/secret'
            with self.assertRaises(ValueError):self.downloads.prepare('7')
            self.raw=raw
        self.open.assert_not_called();self.assertFalse(self.folder.exists())
    def test_disk_space_and_response_size_fail_before_installation(self):
        self.queue()
        with patch('model_downloads.shutil.disk_usage',return_value=type('Disk',(),{'free':0})()):self.finish()
        self.open.assert_not_called();self.assertIn('disk space',self.downloads.status(['7'])['7']['error'])
        self.queue()
        response=self.response();response.headers['Content-Length']=str(MAX_BYTES+1);self.open.side_effect=lambda *args:response
        self.finish();self.assertFalse(list(self.folder.glob('*.safetensors')))
    def test_archive_is_shared_persistent_and_does_not_move_or_change_weights(self):
        self.queue();self.finish();file=self.folder/'pottery.safetensors';stamp=file.stat().st_mtime_ns
        item=self.library.snapshot()['items'][0];self.library.archive(item['id'],True)
        other=Library(self.root,self.data);self.assertTrue(other.snapshot()['items'][0]['archived'])
        self.assertEqual(file.read_bytes(),self.payload);self.assertEqual(file.stat().st_mtime_ns,stamp)
        other.archive(item['id'],False);self.assertFalse(self.library.snapshot()['items'][0]['archived'])
        with self.assertRaises(ValueError):other.archive(item['id'],'true')
        with self.assertRaises(ValueError):other.archive('a'*32,True)
    def test_redirects_never_send_the_civitai_key_to_a_cdn(self):
        handler=DownloadRedirect();request=request_for('https://civitai.com/api/download/models/7','private-test-key')
        redirected=handler.redirect_request(request,None,302,'redirect',{},'https://example.r2.cloudflarestorage.com/signed-model')
        self.assertIsNone(redirected.get_header('Authorization'))
        for bad in ('http://civitai.com/file','https://127.0.0.1/file','https://civitai.com.evil.test/file'):
            self.assertFalse(download_host(bad))
            with self.assertRaises(ValueError):handler.redirect_request(request,None,302,'redirect',{},bad)
    def test_filename_and_exact_version_url_guards(self):
        for bad in ('../model.safetensors','x\\model.safetensors','model.pkl'):
            with self.assertRaises(ValueError):filename(bad)
        self.assertEqual(filename('CON.safetensors'),'LoRA_CON.safetensors')
        self.assertEqual(filename('pottery?.safetensors'),'pottery_.safetensors')
        for bad in ('https://civitai.com/api/download/models/8','https://civitai.com/api/download/models/7?token=secret'):
            with self.assertRaises(ValueError):download_url(bad,'7')


if __name__=='__main__':unittest.main()
