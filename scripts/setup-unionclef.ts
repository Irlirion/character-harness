import {readFile,writeFile,mkdir,copyFile,rename,chmod,readdir,stat} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {resolve,join,dirname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const release={version:'0.95.63',minecraft:'1.21.11',commit:'818e6f80137ad9bdbc87884cb926531065d97e2e',
 sha256:'4b48f14b657646c302af6df6d5c78737cf406e75736c757af5e8adb0e76eb1ba',
 url:'https://github.com/3ndetz/unionclef/releases/download/v0.95.63/unionclef-1.21.11-0.95.63.jar'};
const args=process.argv.slice(2),game=resolve(args.find(a=>!a.startsWith('--'))??'');
if(!args.some(a=>!a.startsWith('--')))throw new Error('Usage: setup-unionclef.ts <minecraft directory> [--apply]');
const config=join(game,'config'),mods=join(game,'mods'),settings=join(game,'altoclef','altoclef_settings.json');
await stat(config);await stat(mods);
const readJson=async(path:string)=>{try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {};throw e;}};
const pack=await readJson(join(dirname(game),'mmc-pack.json'));
if(pack.components&&pack.components.find((c:any)=>c.uid==='net.minecraft')?.version!==release.minecraft)throw new Error('Minecraft 1.21.11 instance required');
const s=await readJson(settings),tungstenPath=join(config,'tungsten.json'),t=await readJson(tungstenPath);
const legacyConfig=join(config,'character-harness-bridge.properties');
const cache=resolve(import.meta.dirname,'../work/unionclef-downloads');await mkdir(cache,{recursive:true});
const jar=join(cache,'unionclef-1.21.11-0.95.63.jar');let bytes:Buffer;let downloaded=false;
try{bytes=await readFile(jar);}catch(e){
 if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;
 const res=await fetch(release.url,{signal:AbortSignal.timeout(60000)});
 if(!res.ok||!res.body)throw new Error('UnionClef release download failed');
 const chunks:Uint8Array[]=[];let length=0;for await(const chunk of res.body){length+=chunk.length;if(length>10*1024*1024)throw new Error('Release too large');chunks.push(chunk);}
 bytes=Buffer.concat(chunks);downloaded=true;
}
if(createHash('sha256').update(bytes).digest('hex')!==release.sha256)throw new Error('UnionClef SHA256 mismatch');
// Never persist a network payload until its exact pinned digest has been verified.
if(downloaded){await writeFile(jar+'.verified-new',bytes);await rename(jar+'.verified-new',jar);}
const {stdout}=await promisify(execFile)('/usr/bin/unzip',['-p',jar,'fabric.mod.json']);const metadata=JSON.parse(stdout);
if(metadata.id!=='altoclef'||metadata.version!=='1.21.11-0.95.63')throw new Error('Unexpected UnionClef artifact');
// Keep the MCP endpoint local and authenticated; preserve other user automation settings.
s.mcpEnabled=true;s.mcpPort=25350;
if(typeof s.mcpAuthToken!=='string'||! /^[A-Za-z0-9_-]{32,128}$/.test(s.mcpAuthToken))s.mcpAuthToken=randomBytes(32).toString('hex');
if(t.configVersion!==undefined&&t.configVersion!==2)throw new Error('Unsupported Tungsten config version; restore/migrate it explicitly');
t.configVersion=2;t.allowBreak=true;t.allowPlace=true;
const tokenPath=join(config,'character-harness-unionclef-mcp.token');
if(!args.includes('--apply')){console.log(JSON.stringify({dry_run:true,game,release,backend:'unionclef_mcp',companion_bridge:false,full_mcp_workspace:true}));process.exit(0);}
const backup=join(game,'character-harness-backups','unionclef-'+new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(backup,{recursive:true,mode:0o700});
const legacyJars=(await readdir(mods)).filter(n=>/^character-harness-bridge-.*\.jar$/.test(n));
const backups=[settings,tungstenPath,legacyConfig,tokenPath,...(await readdir(mods)).filter(n=>/^character-harness-bridge-.*\.jar$/.test(n)||/^unionclef.*\.jar$/.test(n)).map(n=>join(mods,n))];
for(const [i,path] of backups.entries())try{await copyFile(path,join(backup,i+'-'+path.split('/').at(-1)));await chmod(join(backup,i+'-'+path.split('/').at(-1)),0o600);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
await mkdir(join(game,'altoclef'),{recursive:true});
for(const [path,data] of [[settings,JSON.stringify(s,null,2)+'\n'],[tungstenPath,JSON.stringify(t,null,2)+'\n'],[tokenPath,s.mcpAuthToken+'\n']] as const){
 await writeFile(path+'.unionclef-new',data,{mode:0o600});await rename(path+'.unionclef-new',path);await chmod(path,0o600);
}
await rmIfExists(legacyConfig);
for(const name of legacyJars)await rename(join(mods,name),join(backup,name));
for(const name of (await readdir(mods)).filter(n=>/^unionclef.*\.jar$/.test(n)))await rename(join(mods,name),join(backup,name));
await copyFile(jar,join(mods,'unionclef-1.21.11-0.95.63.jar'));
console.log(JSON.stringify({installed:true,game,version:release.version,sha256:release.sha256,backup,companion_bridge_removed:true,restart_client_required:true}));

async function rmIfExists(path:string){try{await (await import('node:fs/promises')).unlink(path);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
