#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream,readFileSync} from 'node:fs';
import {mkdtemp,stat,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const SOURCE='autonomy-cloud/mellow-releases';
export const TARGET='mellow-bci/mellow-releases';
const gitUrl=repo=>'https://github.com/'+repo+'.git';
const tagPattern=/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/;
const digestPattern=/^sha256:[a-f0-9]{64}$/;
const legacyTags=JSON.parse(readFileSync(new URL('./legacy-community-tags.json',import.meta.url),'utf8'));
export function verifyTag(tag,source,target,legacy=legacyTags){
  assert(source,'Upstream tag must exist');
  if(!target)return 'missing';
  if(source===target)return 'identical';
  const known=legacy[tag];
  assert(known&&known.upstream===source&&known.community===target,'Existing community tag conflicts; refusing to move it');
  return 'preserved-legacy';
}
export function metadataNeedsUpdate(source,target){
  return target.draft||source.name!==target.name||source.body!==target.body||source.prerelease!==target.prerelease;
}
function command(name,args,{input,optional=false}={}){
  const r=spawnSync(name,args,{input,encoding:'utf8',timeout:1200000,maxBuffer:32*1024*1024});
  if(r.status!==0){if(optional)return null;throw new Error(name+' failed (exit '+String(r.status)+')')}
  return r.stdout;
}
const gh=(...args)=>command('gh',args);
// JSON input is sent through stdin, never interpreted as shell text.
function request(endpoint,method='GET',data){
  assert(endpoint.startsWith('repos/'+SOURCE+'/')||endpoint.startsWith('repos/'+TARGET+'/'),'Fixed repository boundary required');
  const args=['api','--method',method,endpoint];
  if(data!==undefined)args.push('--input','-');
  return JSON.parse(command('gh',args,{input:data===undefined?undefined:JSON.stringify(data)})||'null');
}
function releases(repo){
  const rows=JSON.parse(gh('api','--paginate','--slurp','repos/'+repo+'/releases?per_page=100'));
  return rows.flat();
}
export function validateRelease(release){
  assert(release&&release.draft===false&&release.published_at,'Published upstream release required');
  assert(tagPattern.test(release.tag_name),'Versioned release tag required');
  assert(typeof release.name==='string'&&release.name.length>0,'Release title required');
  assert(typeof release.body==='string','Explicit release notes required');
  assert(typeof release.prerelease==='boolean','Explicit prerelease flag required');
  assert(!release.tag_name.includes('-beta.')||release.prerelease,'Beta must remain a prerelease');
  assert(Array.isArray(release.assets)&&release.assets.length>0,'Published release assets required');
  const names=new Set();
  for(const asset of release.assets){
    assert(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset.name)&&asset.name!=='.'&&asset.name!=='..','Safe asset filename required');
    assert(!names.has(asset.name),'Duplicate upstream asset');names.add(asset.name);
    assert(asset.state==='uploaded'&&Number.isSafeInteger(asset.size)&&asset.size>0,'Complete uploaded asset required');
    assert(digestPattern.test(asset.digest),'Upstream SHA-256 digest required');
    assert.equal(asset.browser_download_url,'https://github.com/'+SOURCE+'/releases/download/'+release.tag_name+'/'+asset.name,'Upstream download origin/path required');
  }
  return release;
}
export function planRelease(upstream,existing){
  validateRelease(upstream);
  if(existing){
    assert.equal(existing.tag_name,upstream.tag_name,'Mirror tag mismatch');
    assert(Array.isArray(existing.assets),'Mirror asset inventory required');
    const expected=new Map(upstream.assets.map(a=>[a.name,a]));
    for(const asset of existing.assets){
      const source=expected.get(asset.name);assert(source,'Unexpected existing mirror asset; refusing deletion');
      assert.equal(asset.state,'uploaded','Incomplete existing mirror asset');
      assert.equal(asset.size,source.size,'Existing mirror asset size conflict');
      assert.equal(asset.digest,source.digest,'Existing mirror digest conflict; immutable bytes are never replaced');
    }
  }
  return upstream.assets.filter(a=>!existing?.assets.some(x=>x.name===a.name));
}
async function sha256(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return 'sha256:'+hash.digest('hex')}
function tagSha(repo,tag){
  const row=command('git',['ls-remote',gitUrl(repo),'refs/tags/'+tag]).trim();
  if(!row)return null;
  const lines=row.split('\n');assert.equal(lines.length,1,'Ambiguous tag ref');
  const [sha,ref]=lines[0].split(/\s+/);assert.match(sha,/^[a-f0-9]{40}$/);assert.equal(ref,'refs/tags/'+tag);return sha;
}
function syncTag(tag,apply){
  const source=tagSha(SOURCE,tag),target=tagSha(TARGET,tag),status=verifyTag(tag,source,target);
  if(status!=='missing'||!apply)return {status,upstream:source,community:target};
  command('git',['fetch','--no-tags',gitUrl(SOURCE),'refs/tags/'+tag]);
  assert.equal(command('git',['rev-parse','FETCH_HEAD']).trim(),source,'Upstream tag changed during fetch');
  command('git',['push','origin','FETCH_HEAD:refs/tags/'+tag]);assert.equal(tagSha(TARGET,tag),source);
  return {status:'identical',upstream:source,community:source};
}
export async function sync({apply=false}={}){
  assert.equal(command('git',['remote','get-url','origin']).trim().replace(/\.git$/,''),'https://github.com/'+TARGET,'Run only in the community repository');
  if(process.env.GITHUB_REPOSITORY)assert.equal(process.env.GITHUB_REPOSITORY,TARGET);
  if(process.env.GITHUB_ACTIONS){assert.equal(process.env.GITHUB_REF,'refs/heads/main');assert(['schedule','workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME))}
  assert.equal(command('git',['status','--porcelain']).trim(),'','Clean checkout required');
  const upstream=releases(SOURCE).filter(r=>!r.draft),mirror=new Map(releases(TARGET).map(r=>[r.tag_name,r]));
  const latest=request('repos/'+SOURCE+'/releases/latest').tag_name;
  const targetLatestJson=command('gh',['api','repos/'+TARGET+'/releases/latest'],{optional:true});
  let targetLatest=targetLatestJson?JSON.parse(targetLatestJson).tag_name:null;
  const work=await mkdtemp(path.join(tmpdir(),'mellow-public-mirror-'));
  const report={source:SOURCE,target:TARGET,apply,releases:[],sourceAssetBytes:0,uploadedAssets:0,verifiedAssets:0,immutableConflicts:0};
  try{
    for(const release of upstream){
      let existing=mirror.get(release.tag_name);const missing=planRelease(release,existing),tag=syncTag(release.tag_name,apply);
      if(apply&&!existing)existing=request('repos/'+TARGET+'/releases','POST',{tag_name:release.tag_name,name:release.name,body:release.body,prerelease:release.prerelease,draft:true,make_latest:'false'});
      for(const asset of missing){
        if(!apply)continue;
        const dir=path.join(work,release.tag_name);await mkdir(dir,{recursive:true});
        gh('release','download',release.tag_name,'--repo',SOURCE,'--pattern',asset.name,'--dir',dir);
        assert.deepEqual(await readdir(dir),[asset.name],'Exact source asset required');const file=path.join(dir,asset.name);
        assert.equal((await stat(file)).size,asset.size);assert.equal(await sha256(file),asset.digest,'Downloaded source digest mismatch');
        gh('release','upload',release.tag_name,file,'--repo',TARGET); // deliberately no --clobber
        await rm(file);report.uploadedAssets++;
      }
      if(apply){
        const saved=request('repos/'+TARGET+'/releases/'+existing.id);assert.equal(planRelease(release,saved).length,0,'Mirror assets incomplete');
        const latestNeedsUpdate=release.tag_name===latest&&targetLatest!==latest;
        const final=metadataNeedsUpdate(release,saved)||latestNeedsUpdate?request('repos/'+TARGET+'/releases/'+existing.id,'PATCH',{name:release.name,body:release.body,prerelease:release.prerelease,draft:false,make_latest:release.tag_name===latest?'true':'false'}):saved;
        assert.equal(final.draft,false);assert.equal(final.prerelease,release.prerelease);assert.equal(final.name,release.name);assert.equal(final.body,release.body);assert.equal(planRelease(release,final).length,0);
        if(release.tag_name===latest)targetLatest=latest;
      }
      report.sourceAssetBytes+=release.assets.reduce((n,a)=>n+a.size,0);report.verifiedAssets+=apply?release.assets.length:0;
      const result={tag:release.tag_name,tagRef:tag,assets:release.assets.length,uploaded:apply?missing.length:0,missing:apply?0:missing.length,published:apply||Boolean(existing&&!existing.draft)};report.releases.push(result);console.log(JSON.stringify(result));
    }
    if(apply){
      assert.equal(request('repos/'+TARGET+'/releases/latest').tag_name,latest,'Stable latest release mismatch');
      await syncFeeds();
    }
    report.result=apply?'PASS':'AUDIT';
    const reportFile=process.env.MIRROR_REPORT;
    if(reportFile)await writeFile(reportFile,JSON.stringify(report,null,2)+'\n',{mode:0o600});
    console.log(JSON.stringify(report));return report;
  }catch(error){
    report.result='FAIL';report.error={name:error.name,message:error.message};
    if(process.env.MIRROR_REPORT)await writeFile(process.env.MIRROR_REPORT,JSON.stringify(report,null,2)+'\n',{mode:0o600});
    throw error;
  }finally{await rm(work,{recursive:true,force:true})}
}
async function syncFeeds(){
  command('git',['fetch','--no-tags',gitUrl(SOURCE),'main']);
  const revision=command('git',['rev-parse','FETCH_HEAD']).trim();
  const files=command('git',['ls-tree','-r','FETCH_HEAD','docs']).trim().split('\n').filter(Boolean).map(line=>{
    const match=/^100644 blob [a-f0-9]{40}\t(docs\/[A-Za-z0-9._/-]+)$/.exec(line);assert(match,'Regular public feed file required');assert(!match[1].split('/').includes('..'),'Unsafe public feed path');return match[1];
  });assert(files.length>0,'Original public update feed required');
  command('git',['rm','-r','--ignore-unmatch','docs']);
  for(const file of files){await mkdir(path.dirname(file),{recursive:true});await writeFile(file,command('git',['show','FETCH_HEAD:'+file]));}
  command('git',['add','docs']);
  const diff=spawnSync('git',['diff','--cached','--quiet'],{encoding:'utf8'});assert([0,1].includes(diff.status));
  if(diff.status===1){command('git',['commit','-m','Sync signed upstream update feed '+revision.slice(0,12)]);command('git',['push','origin','HEAD:main']);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  sync({apply:process.argv.includes('--apply')}).catch(error=>{console.error(JSON.stringify({result:'FAIL',error:error.name,message:error.message}));process.exitCode=1});
}
