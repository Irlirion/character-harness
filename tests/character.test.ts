import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCharacter, parseCharacter } from '../packages/domain/character.ts';

test('default package loads Lada with labelled examples into the existing engine contract', async () => {
  const character = await loadCharacter(undefined, 'lada');
  assert.deepEqual(Object.keys(character).sort(), ['id', 'name', 'persona']);
  assert.equal(character.name, 'Лада');
  assert.match(character.persona, /Я Лада/);
  assert.match(character.persona, /Примеры интонации, не события разговора/);
  assert.match(character.persona, /Лада: Тогда потерянная кирка/);
  await assert.rejects(loadCharacter(undefined, 'different-instance'), /binding mismatch/);
});

test('JSON packages still load without modifying the contract', () => {
  assert.deepEqual(parseCharacter('{"id":"iskra","name":"Искра","persona":"Another personality"}', 'json', 'iskra'),
    { id: 'iskra', name: 'Искра', persona: 'Another personality' });
});

test('examples use the selected identity and reject incomplete pairs', () => {
  const source = 'character: {id: iskra, name: Искра}\nstreamer_abstract: Hello\nstreamer_fewshot: {hello_q: Question, hello_a: Answer}\n';
  assert.match(parseCharacter(source, 'yaml').persona, /Искра: Answer/);
  assert.throws(() => parseCharacter(source.replace(', hello_a: Answer', ''), 'yaml'), /Incomplete fewshot/);
  assert.throws(() => parseCharacter(source.replace('hello_q:', 'wrong:'), 'yaml'), /Invalid fewshot|Incomplete fewshot/);
});

test('invalid identity, YAML duplicates and missing persona fail before startup', () => {
  assert.throws(() => parseCharacter('character: {id: lada, name: ""}\nstreamer_abstract: Hello', 'yaml'));
  assert.throws(() => parseCharacter('character: {id: lada, name: Лада}\nstreamer_abstract: Hello\nstreamer_abstract: Other', 'yaml'));
  assert.throws(() => parseCharacter('character: {id: lada, name: Лада}', 'yaml'));
});
