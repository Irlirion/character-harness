import {decodeImage} from '../images/domain.ts';
export class BotApiError extends Error {
  code: 'unauthorized'|'forbidden'|'rate_limited'|'rejected'|'unknown';
  retryAfter?:number;
  constructor(code:BotApiError['code'],retryAfter?:number) { super(`telegram_${code}`);this.code=code;this.retryAfter=retryAfter; }
}
export class BotApi {
  private token:string;
  private transport:typeof fetch;
  constructor(token:string, transport:typeof fetch=fetch) {
    this.token=token;this.transport=transport;
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('invalid_bot_token');
  }
  async call(method:'getChat'|'getUserProfilePhotos'|'getFile'|'getChatMemberCount'|'getChatAdministrators'|'getChatMember'|'getMe'|'getWebhookInfo'|'getUpdates'|'sendMessage'|'sendPhoto', body:Record<string,unknown>={},signal?:AbortSignal):Promise<any> {
    let payload:BodyInit=JSON.stringify(body);let headers:Record<string,string>|undefined={'Content-Type':'application/json'};
    if(method==='sendPhoto'){
      if(!(body.photo instanceof Uint8Array))throw new BotApiError('rejected');
      const form=new FormData();
      form.set('photo',new Blob([new Uint8Array(body.photo)],{type:body.photo[0]===137?'image/png':'image/jpeg'}),'lada-image.'+(body.photo[0]===137?'png':'jpg'));
      for(const [key,value] of Object.entries(body))if(key!=='photo'&&value!==undefined)form.set(key,typeof value==='object'?JSON.stringify(value):String(value));
      payload=form;headers=undefined;
    }
    let response:Response;
    try { response = await this.transport(`https://api.telegram.org/bot${this.token}/${method}`, {
      method:'POST',headers,body:payload,
      signal:AbortSignal.any([AbortSignal.timeout(method==='getUpdates'?35000:method==='sendPhoto'?20000:15000),...(signal?[signal]:[])]), redirect:'error'
    }); } catch { throw new BotApiError('unknown'); }
    let data:any; try { data=await response.json(); } catch { throw new BotApiError('unknown'); }
    if (response.ok && data?.ok === true) return data.result;
    const code=data?.error_code ?? response.status;
    if (code===429 && Number.isSafeInteger(data?.parameters?.retry_after) && data.parameters.retry_after>0 && data.parameters.retry_after<=2147483647) throw new BotApiError('rate_limited',data.parameters.retry_after);
    if (code===401) throw new BotApiError('unauthorized');
    if (code===403) throw new BotApiError('forbidden');
    if (code>=400 && code<500) throw new BotApiError('rejected');
    throw new BotApiError('unknown');
  }
  async downloadProfilePhoto(fileId:string,signal?:AbortSignal):Promise<{mime:'image/jpeg'|'image/png';data:string}>{
    const f=await this.call('getFile',{file_id:fileId},signal),path=f?.file_path;
    if(typeof path!=='string'||! /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(path)||path.split('/').some(p=>p==='.'||p==='..')||f.file_size>256*1024)throw new BotApiError('rejected');
    try{
      const r=await this.transport(`https://api.telegram.org/file/bot${this.token}/${path}`,{redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(15000),...(signal?[signal]:[])])});
      if(!r.ok||!r.body||Number(r.headers.get('content-length'))>256*1024)throw new BotApiError('rejected');
      const reader=r.body.getReader(),chunks:Uint8Array[]=[];let length=0;
      try{while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>256*1024)throw new BotApiError('rejected');chunks.push(part.value);}}
      finally{await reader.cancel().catch(()=>{});}
      const bytes=Buffer.concat(chunks),data=bytes.toString('base64');decodeImage(data);
      return {mime:bytes[0]===137?'image/png':'image/jpeg',data};
    }catch(e){throw e instanceof BotApiError?e:new BotApiError('unknown');}
  }

}
