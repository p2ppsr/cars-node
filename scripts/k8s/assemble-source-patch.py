#!/usr/bin/env python3
"""Build a bounded, source-verified OCI layer on the exact approved CARS base.

Production assembly runs on hosted Linux/amd64 CI. All unchanged compiled
runtime files and all base blobs must match; this cannot package arbitrary
runtime changes or silently substitute dependencies, tools or operating systems.
"""
import argparse
import copy
import datetime as dt
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile


def digest(data):
    return 'sha256:'+hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value,sort_keys=True,separators=(',',':')).encode()


def checked_path(name):
    while name.startswith('./'):name=name[2:]
    path=PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts:raise ValueError('unsafe archive path')
    return str(path)


def blob(layout,descriptor):
    key=descriptor['digest']
    if not re.fullmatch(r'sha256:[a-f0-9]{64}',key):raise ValueError('noncanonical digest')
    data=(layout/'blobs/sha256'/key[7:]).read_bytes()
    if len(data)!=descriptor['size'] or digest(data)!=key:raise ValueError('blob integrity mismatch')
    return data


def write_blob(layout,data,media):
    key=digest(data);path=layout/'blobs/sha256'/key[7:]
    if path.exists() and path.read_bytes()!=data:raise ValueError('content-address collision')
    path.write_bytes(data)
    return {'mediaType':media,'digest':key,'size':len(data)}


def unpack_base(archive,layout,policy):
    with archive.open('rb') as source:
        if hashlib.file_digest(source,'sha256').hexdigest()!=policy['archive_sha256']:
            raise ValueError('base archive hash differs')
    (layout/'blobs/sha256').mkdir(parents=True,exist_ok=False)
    seen=set();total=0
    with tarfile.open(archive,'r:*') as tar:
        for member in tar:
            name=checked_path(member.name)
            if member.isdir():continue
            if (not member.isfile() or name in seen or
                not(name in {'index.json','oci-layout'} or re.fullmatch(r'blobs/sha256/[a-f0-9]{64}',name))):
                raise ValueError('unexpected base archive member')
            total+=member.size
            if member.size>440_000_000 or total>440_000_000:raise ValueError('base archive bound exceeded')
            seen.add(name);data=tar.extractfile(member).read()
            if name.startswith('blobs/') and digest(data)[7:]!=name.rsplit('/',1)[1]:
                raise ValueError('base member digest mismatch')
            (layout/name).write_bytes(data)
    manifest=json.loads((layout/'blobs/sha256'/policy['manifest_digest'][7:]).read_bytes())
    if digest(canonical(manifest))!=policy['manifest_digest']:
        # Original JSON serialization is retained and hashed, not normalized.
        raw=(layout/'blobs/sha256'/policy['manifest_digest'][7:]).read_bytes()
        if digest(raw)!=policy['manifest_digest']:raise ValueError('base manifest differs')
    if len(manifest['layers'])!=policy['layers']:raise ValueError('base layer count differs')
    config=json.loads(blob(layout,manifest['config']))
    if (config['architecture']!='amd64' or config['os']!='linux' or
        config['config']['Labels']['org.opencontainers.image.revision']!=policy['source_sha'] or
        config['rootfs']['type']!='layers' or len(config['rootfs']['diff_ids'])!=policy['layers']):
        raise ValueError('base platform/source/rootfs differs')
    for layer in manifest['layers']:blob(layout,layer)
    return manifest,config


def compiled_runtime(layout,manifest):
    files={};expanded=0
    for descriptor in manifest['layers']:
        compressed=blob(layout,descriptor)
        if descriptor['mediaType']!='application/vnd.oci.image.layer.v1.tar+gzip':
            raise ValueError('unexpected base layer encoding')
        with tarfile.open(fileobj=io.BytesIO(compressed),mode='r|gz') as tar:
            for member in tar:
                expanded+=member.size
                if expanded>4*2**30:raise ValueError('base expansion bound exceeded')
                name=checked_path(member.name)
                if not name.startswith('app/dist/'):continue
                relative=name[len('app/dist/'):];leaf=PurePosixPath(relative).name
                if leaf=='.wh..wh..opq':
                    parent=str(PurePosixPath(relative).parent)
                    files={k:v for k,v in files.items() if not k.startswith(parent+'/')}
                elif leaf.startswith('.wh.'):
                    target=str(PurePosixPath(relative).with_name(leaf[4:]));files.pop(target,None)
                elif member.isdir():continue
                elif member.isfile() and member.size<=16*2**20:
                    data=tar.extractfile(member).read()
                    files[relative]={'sha256':digest(data),'mode':member.mode,'uid':member.uid,'gid':member.gid}
                else:raise ValueError('compiled runtime contains an unsupported member')
    if not files:raise ValueError('compiled base runtime missing')
    return files


def assemble(archive,dist,layout,policy,source_sha,epoch):
    if not re.fullmatch('[a-f0-9]{40}',source_sha):raise ValueError('full source SHA required')
    manifest,config=unpack_base(archive,layout,policy)
    previous=compiled_runtime(layout,manifest);current={}
    for path in dist.rglob('*'):
        if path.is_symlink():raise ValueError('compiled output contains symlink')
        if path.is_file():current[str(path.relative_to(dist))]=path
    if set(previous)!=set(current):raise ValueError('compiled runtime file inventory changed')
    changed=sorted(k for k in current if digest(current[k].read_bytes())!=previous[k]['sha256'])
    if changed!=sorted(policy['allowed_runtime_changes']):raise ValueError('unapproved compiled runtime differences')
    stream=io.BytesIO()
    with tarfile.open(fileobj=stream,mode='w',format=tarfile.USTAR_FORMAT) as tar:
        for name in changed:
            data=current[name].read_bytes();old=previous[name];info=tarfile.TarInfo('app/dist/'+name)
            info.size=len(data);info.mode=old['mode'];info.uid=old['uid'];info.gid=old['gid'];info.mtime=epoch
            tar.addfile(info,io.BytesIO(data))
    raw=stream.getvalue();packed=gzip.compress(raw,mtime=0)
    if max(len(raw),len(packed))>policy['maximum_patch_bytes']:raise ValueError('patch byte bound exceeded')
    created=dt.datetime.fromtimestamp(epoch,dt.timezone.utc).isoformat().replace('+00:00','Z')
    updated=copy.deepcopy(config);updated['created']=created
    updated['config']['Labels']['org.opencontainers.image.revision']=source_sha
    updated['rootfs']['diff_ids'].append(digest(raw))
    updated.setdefault('history',[]).append({'created':created,'created_by':'source-verified compiled runtime patch '+source_sha,
        'comment':'Approved base '+policy['manifest_digest']+'; unchanged runtime and all base blobs verified'})
    output=copy.deepcopy(manifest)
    output['config']=write_blob(layout,canonical(updated),'application/vnd.oci.image.config.v1+json')
    output['layers'].append(write_blob(layout,packed,'application/vnd.oci.image.layer.v1.tar+gzip'))
    output.setdefault('annotations',{})['org.opencontainers.image.base.digest']=policy['manifest_digest']
    descriptor=write_blob(layout,canonical(output),'application/vnd.oci.image.manifest.v1+json')
    day=created[:10];version=updated['config']['Labels']['org.opencontainers.image.version']
    tag='v'+version+'-'+day+'-cars-reliability-'+source_sha[:12]
    reference='registry.cars-operator-system.svc.cluster.local:5000/cars-node:'+tag
    descriptor.update(platform={'architecture':'amd64','os':'linux'},annotations={'org.opencontainers.image.ref.name':reference})
    (layout/'index.json').write_bytes(canonical({'schemaVersion':2,'manifests':[descriptor]}))
    (layout/'oci-layout').write_bytes(canonical({'imageLayoutVersion':'1.0.0'}))
    if output['layers'][:-1]!=manifest['layers'] or updated['rootfs']['diff_ids'][:-1]!=config['rootfs']['diff_ids']:
        raise ValueError('base layers were changed')
    return {'source_sha':source_sha,'image_tag':tag,'image_digest':descriptor['digest'],'image':reference+'@'+descriptor['digest'],
        'transport_image':'docker.io/bsvb/cars-node:'+tag+'@'+descriptor['digest'],'base_source_sha':policy['source_sha'],
        'base_manifest_digest':policy['manifest_digest'],'compiled_runtime_changes':changed,'all_base_layer_blobs_preserved':True,
        'new_layer_compressed_bytes':len(packed),'new_layer_expanded_bytes':len(raw),
        'new_content_blob_bytes':len(packed)+output['config']['size'],'base_layers':len(manifest['layers']),
        'layers':len(output['layers']),'architecture':'amd64','os':'linux'}


def main():
    p=argparse.ArgumentParser();p.add_argument('--base-archive',type=Path,required=True);p.add_argument('--dist',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True);p.add_argument('--source-sha',required=True)
    p.add_argument('--policy',type=Path,default=Path('.github/cars-source-patch-base.json'));a=p.parse_args()
    policy=json.loads(a.policy.read_text())
    head=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
    if head!=a.source_sha:raise ValueError('checkout differs from requested source')
    subprocess.run(['git','merge-base','--is-ancestor',a.source_sha,'origin/master'],check=True)
    differences=subprocess.check_output(['git','diff','--name-only',policy['source_sha'],a.source_sha,'--',*policy['runtime_git_paths']],text=True).splitlines()
    if sorted(differences)!=sorted(policy['allowed_git_changes']):raise ValueError('unapproved runtime source changes')
    epoch=int(subprocess.check_output(['git','show','-s','--format=%ct',a.source_sha],text=True))
    result=assemble(a.base_archive,a.dist,a.output,policy,a.source_sha,epoch)
    Path('release-manifest.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result))


if __name__=='__main__':main()
