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
  async call(method:'getChatMemberCount'|'getChatAdministrators'|'getChatMember'|'getMe'|'getWebhookInfo'|'getUpdates'|'sendMessage'|'sendPhoto', body:Record<string,unknown>={}):Promise<any> {
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
      signal:AbortSignal.timeout(method==='getUpdates'?35000:method==='sendPhoto'?20000:15000), redirect:'error'
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
}
