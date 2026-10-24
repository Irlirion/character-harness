import type pg from 'pg';
import {DomainError} from '../domain/policy.ts';
export async function approvedGroups(db:Pick<pg.Pool,'query'>,characterId:string){
 return (await db.query(`SELECT b.*,d.approval_ref AS group_ref,d.title,d.username FROM telegram_bindings b
 LEFT JOIN telegram_discovered_chats d ON d.bot_id=b.bot_id AND d.chat_id=b.chat_id
 WHERE b.character_id=$1 AND b.kind='group' AND b.enabled ORDER BY b.id`,[characterId])).rows;
}
export function selectGroup(groups:any[],selector?:string){
 const key=selector?.trim().toLowerCase();
 const matches=key?groups.filter(g=>[g.id,g.group_ref,g.title,g.username,g.username?'@'+g.username:null].some(v=>typeof v==='string'&&v.toLowerCase()===key)):groups;
 if(matches.length!==1)throw new DomainError(matches.length>1?'group_selection_required':'group_binding_required');
 return matches[0];
}
