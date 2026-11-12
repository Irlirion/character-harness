import { readFileSync } from 'node:fs';
export type TelegramMessage = {
  chatId: string; messageId: string; authorId: string; text: string;
  kind: 'private'|'group'; replyTo?: string; direct: boolean; date: number; forwarded?: boolean;
};
const id = (v: unknown): string | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : undefined;
export function normalizeUpdate(update: any, botId: string, username: string): TelegramMessage | null {
  const m = update?.message;
  if (!m || m.from?.is_bot || !m.from || m.sender_chat || m.is_automatic_forward || m.message_thread_id || m.chat?.is_forum) return null;
  const kind = m.chat?.type === 'private' ? 'private' : ['group','supergroup'].includes(m.chat?.type) ? 'group' : null;
  const chatId = id(m.chat?.id), messageId = id(m.message_id), authorId = id(m.from.id);
  if (!kind || !chatId || !messageId || !authorId || typeof m.text !== 'string' || !m.text.trim() || m.text.length > 4000 || !Number.isSafeInteger(m.date)) return null;
  const mention = (Array.isArray(m.entities) ? m.entities : []).some((e:any) => {
    if (!Number.isInteger(e.offset) || !Number.isInteger(e.length)) return false;
    return e.type === 'text_mention' ? id(e.user?.id) === botId :
      e.type === 'mention' && m.text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${username.toLowerCase()}`;
  });
  return { chatId, messageId, authorId:`telegram:${authorId}`, text:m.text, kind,
    replyTo:id(m.reply_to_message?.message_id), date:m.date,forwarded:!!(m.forward_origin||m.forward_date),
    direct:kind === 'private' || mention || id(m.reply_to_message?.from?.id) === botId };
}
export type TelegramDecision = { decision:'reply'; text:string } | { decision:'silence' };
export function parseTelegramDecision(raw:string, group:boolean): TelegramDecision {
  let value:any; try { value=JSON.parse(raw); } catch { throw new Error('invalid_telegram_decision'); }
  if (value?.decision === 'silence' && group && (Object.keys(value).length === 1 || (value.text === null && Object.keys(value).sort().join(',') === 'decision,text'))) return {decision:'silence'};
  if (value?.decision === 'reply' && typeof value.text === 'string' && value.text.trim() && value.text.length <= 2000 && Object.keys(value).sort().join(',') === 'decision,text') return {decision:'reply',text:value.text};
  throw new Error('invalid_telegram_decision');
}
export const TELEGRAM_INSTRUCTIONS = readFileSync(new URL('./telegram.md',import.meta.url),'utf8').trimEnd();

/** Constrain Codex's final output at the model boundary, rather than relying on prompt compliance. */
export function telegramOutputSchema(group:boolean) {
  return {type:'object',additionalProperties:false,required:['decision','text'],properties:{
    decision:{type:'string',enum:group?['reply','silence']:['reply']},
    text:{type:group?['string','null']:'string'}
  }};
}
