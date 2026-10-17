import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
await mkdir('secrets',{recursive:true,mode:0o700});
for(const [name,value] of Object.entries({telegram_worker_token:randomBytes(32).toString('hex'),telegram_bot_token:''})) {
  try {await writeFile(`secrets/${name}`,value+'\n',{mode:0o600,flag:'wx'});}
  catch(e){if(!(e instanceof Error) || !('code' in e) || e.code!=='EEXIST')throw e;}
}
console.log('Telegram secret files prepared without overwriting existing files. Fill telegram_bot_token locally with the BotFather token.');
