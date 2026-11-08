import copy
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('image_patch',Path(__file__).parents[1]/'scripts/k8s/assemble-source-patch.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class SourcePatchImageTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.dist=self.root/'dist';self.dist.mkdir()
        (self.dist/'src').mkdir();(self.dist/'src/kubectl-read.js').write_bytes(b'fixed read-only timeout\n')
        (self.dist/'src/unchanged.js').write_bytes(b'unchanged\n')
        raw=io.BytesIO()
        with tarfile.open(fileobj=raw,mode='w') as tar:
            for name,data in [('app/dist/src/kubectl-read.js',b'old\n'),('app/dist/src/unchanged.js',b'unchanged\n')]:
                info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o644;info.uid=10001;info.gid=10001
                tar.addfile(info,io.BytesIO(data))
        layer=gzip.compress(raw.getvalue(),mtime=0)
        self.config={'architecture':'amd64','os':'linux','config':{'User':'10001:10001','Cmd':['node','dist/src/index.js'],'Env':['NODE_ENV=production'],'Labels':{'org.opencontainers.image.revision':'a'*40,'org.opencontainers.image.version':'1.4.0'}},'rootfs':{'type':'layers','diff_ids':[m.digest(raw.getvalue())]},'history':[{'created_by':'original'}]}
        config=m.canonical(self.config)
        self.manifest={'schemaVersion':2,'mediaType':'application/vnd.oci.image.manifest.v1+json','config':{'mediaType':'application/vnd.oci.image.config.v1+json','digest':m.digest(config),'size':len(config)},'layers':[{'mediaType':'application/vnd.oci.image.layer.v1.tar+gzip','digest':m.digest(layer),'size':len(layer)}]}
        manifest=m.canonical(self.manifest)
        self.members={'oci-layout':b'{"imageLayoutVersion":"1.0.0"}','index.json':b'{}','blobs/sha256/'+m.digest(config)[7:]:config,'blobs/sha256/'+m.digest(layer)[7:]:layer,'blobs/sha256/'+m.digest(manifest)[7:]:manifest}
        self.archive=self.root/'base.tar';self.write_archive()
        self.policy={'archive_sha256':hashlib.sha256(self.archive.read_bytes()).hexdigest(),'manifest_digest':m.digest(manifest),'layers':1,'source_sha':'a'*40,'allowed_runtime_changes':['src/kubectl-read.js'],'maximum_patch_bytes':65536}

    def write_archive(self):
        with tarfile.open(self.archive,'w') as tar:
            for name,data in self.members.items():
                info=tarfile.TarInfo(name);info.size=len(data);tar.addfile(info,io.BytesIO(data))

    def run_patch(self,policy=None):
        out=self.root/'out';result=m.assemble(self.archive,self.dist,out,policy or self.policy,'b'*40,1700000000)
        descriptor=json.loads((out/'index.json').read_text())['manifests'][0]
        manifest=json.loads(m.blob(out,descriptor));config=json.loads(m.blob(out,manifest['config']))
        return out,result,manifest,config

    def test_only_allowed_file_layer_changes_and_base_runtime_settings_survive(self):
        out,result,manifest,config=self.run_patch()
        self.assertEqual(manifest['layers'][:-1],self.manifest['layers'])
        self.assertEqual(config['rootfs']['diff_ids'][:-1],self.config['rootfs']['diff_ids'])
        self.assertEqual(config['config']['User'],self.config['config']['User']);self.assertEqual(config['config']['Cmd'],self.config['config']['Cmd']);self.assertEqual(config['config']['Env'],self.config['config']['Env'])
        self.assertEqual(config['config']['Labels']['org.opencontainers.image.revision'],'b'*40)
        packed=m.blob(out,manifest['layers'][-1]);raw=gzip.decompress(packed)
        self.assertEqual(m.digest(raw),config['rootfs']['diff_ids'][-1])
        with tarfile.open(fileobj=io.BytesIO(raw)) as tar:
            self.assertEqual(tar.getnames(),['app/dist/src/kubectl-read.js'])
            entry=tar.getmembers()[0];self.assertEqual((entry.mode,entry.uid,entry.gid),(0o644,10001,10001))
            self.assertEqual(tar.extractfile(entry).read(),(self.dist/'src/kubectl-read.js').read_bytes())
        self.assertEqual(result['layers'],2);self.assertLess(result['new_layer_expanded_bytes'],65536)

    def test_corrupt_archive_rejected(self):
        self.archive.write_bytes(self.archive.read_bytes()+b'corrupt')
        with self.assertRaisesRegex(ValueError,'archive hash'):self.run_patch()

    def test_unauthorized_second_runtime_change_rejected(self):
        (self.dist/'src/unchanged.js').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'unapproved compiled'):self.run_patch()

    def test_missing_runtime_file_rejected(self):
        (self.dist/'src/unchanged.js').unlink()
        with self.assertRaisesRegex(ValueError,'inventory'):self.run_patch()

    def test_symlink_rejected(self):
        (self.dist/'src/extra.js').symlink_to('unchanged.js')
        with self.assertRaisesRegex(ValueError,'symlink'):self.run_patch()

    def test_patch_size_bound_rejected(self):
        policy=copy.deepcopy(self.policy);policy['maximum_patch_bytes']=10
        with self.assertRaisesRegex(ValueError,'byte bound'):self.run_patch(policy)

    def test_unexpected_outer_member_rejected_even_with_new_archive_hash(self):
        self.members['../escape']=b'bad';self.write_archive();self.policy['archive_sha256']=hashlib.sha256(self.archive.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'unsafe archive'):self.run_patch()

    def test_wrong_platform_rejected(self):
        policy=copy.deepcopy(self.policy);policy['source_sha']='c'*40
        with self.assertRaisesRegex(ValueError,'platform/source'):self.run_patch(policy)

    def test_identical_runtime_is_not_misrepresented_as_fix(self):
        (self.dist/'src/kubectl-read.js').write_bytes(b'old\n')
        with self.assertRaisesRegex(ValueError,'unapproved compiled'):self.run_patch()

if __name__=='__main__':unittest.main()
