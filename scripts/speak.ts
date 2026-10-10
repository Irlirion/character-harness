import { coreFetch } from '../packages/domain/core-http.ts';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const text=process.argv.slice(2).join(' ');
if(!text)throw new Error('Usage: node scripts/speak.ts <text>');
const token=(await readFile('secrets/owner_token','utf8')).trim();
const r=await coreFetch('http://127.0.0.1:3000/owner/speech',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({request_id:randomUUID(),text})});
if(!r.ok)throw new Error(`Queue rejected: ${r.status}`);
console.log(JSON.stringify(await r.json()));
