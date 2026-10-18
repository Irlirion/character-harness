import {decodeImage} from '../images/domain.ts';
/** Keep images out of text/JSON: the model must receive an actual image input. */
export function profileToolContent(result:any):Array<{type:'text';text:string}|{type:'image';data:string;mimeType:'image/jpeg'|'image/png'}>{
 if(!Array.isArray(result?.content))throw new Error('invalid_profile_result');
 return result.content.map((c:any)=>{
  if(c.type==='text'&&typeof c.text==='string')return {type:'text' as const,text:c.text};
  if(c.type!=='image'||!['image/jpeg','image/png'].includes(c.mimeType)||typeof c.data!=='string'||c.data.length>350000)throw new Error('invalid_profile_image');
  const bytes=decodeImage(c.data);if(bytes.length>256*1024||(bytes[0]===137?'image/png':'image/jpeg')!==c.mimeType)throw new Error('invalid_profile_image');
  return {type:'image' as const,data:c.data,mimeType:c.mimeType};
 });
}
export function codexProfileToolResult(result:any){
 return {success:!result.isError,contentItems:profileToolContent(result).map(c=>c.type==='text'?{type:'inputText' as const,text:c.text}:{type:'inputImage' as const,imageUrl:`data:${c.mimeType};base64,${c.data}`})};
}
