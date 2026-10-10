import test from 'node:test';
import assert from 'node:assert/strict';
import { boundRecentConversation, makeTurnInput, type RecentConversationTurn } from '../packages/domain/conversation-context.ts';
import { loadRecentConversation } from '../packages/storage/conversation.ts';

const turn=(id:string,input:string,reply:string):RecentConversationTurn=>({
  event_id:id,author_id:`minecraft-system:mc.agicraft.ru:25565:${id}`,
  author_provenance:'minecraft_system_chat',author_trust:'unverified',input,reply
});

test('recent conversation query stays within the current character and audience, before current event, and completed pairs only',async()=>{
  let sql='';let values:unknown[]=[];
  const rows=[turn('old','old input','old reply')];
  const result=await loadRecentConversation(async(query,params)=>{sql=query;values=params;return {rows};},
    {characterId:'lada',audienceId:'demo-public'},'current-event-id');
  assert.match(sql,/current_event\.character_id=\$1 AND current_event\.audience_id=\$2/);
  assert.match(sql,/e\.character_id=\$1 AND e\.audience_id=\$2 AND e\.processed=true/);
  assert.match(sql,/JOIN replies r ON r\.event_id=e\.id/);
  assert.match(sql,/\(e\.created_at,e\.id\) < \(current_event\.created_at,current_event\.id\)/);
  assert.match(sql,/ORDER BY e\.created_at DESC,e\.id DESC LIMIT 10/);
  assert.deepEqual(values,['lada','demo-public','current-event-id']);
  assert.deepEqual(result,rows);
});

test('recent conversation is chronological, capped at ten turns and the serialized character budget',()=>{
  const rows=Array.from({length:12},(_,i)=>turn(`event-${i}`,`input-${i}`,`reply-${i}`)).reverse();
  const selected=boundRecentConversation(rows);
  assert.equal(selected.length,10);
  assert.deepEqual(selected.map(x=>x.event_id),Array.from({length:10},(_,i)=>`event-${i+2}`));

  const longRows=Array.from({length:5},(_,i)=>turn(`long-${i}`,'и'.repeat(1600),'о'.repeat(1200))).reverse();
  const withinBudget=boundRecentConversation(longRows);
  assert.ok(JSON.stringify(withinBudget).length<=8000);
  assert.deepEqual(withinBudget.map(x=>x.event_id),['long-3','long-4']);
});

test('turn input carries recent pairs with provenance and trust intact',()=>{
  const history=[turn('earlier','что мы обсуждали?','Мы говорили о мосте.')];
  assert.deepEqual(makeTurnInput({text:'продолжим'},[{text:'память'}],history),{
    event:{text:'продолжим'},memories:[{text:'память'}],recent_conversation:history
  });
});
