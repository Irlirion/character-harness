import {spawn} from 'node:child_process';
let data='';
for await(const chunk of process.stdin)data+=chunk;
const request=JSON.parse(data),mode=process.argv[2];
if(process.env.DATABASE_URL||process.env.ENGINE_TOKEN||process.env.OPENAI_API_KEY||process.env.HOME)process.exit(2);
if(mode==='hang')await new Promise(()=>setInterval(()=>{},1000));
else if(mode==='large')process.stdout.write('x'.repeat(10000));
else if(mode==='fail')process.exit(1);
else if(mode==='bad')process.stdout.write('not json');
else {if(mode==='descendant')spawn(process.execPath,['-e',"setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'orphan'),300)",process.argv[3]],{stdio:'ignore'}).unref();process.stdout.write(JSON.stringify({verdict:'allow',rule_id:'synthetic_test_only',policy_version:request.policy_version,payload_hash:mode==='wrong'?'0'.repeat(64):request.payload_hash}));}
