import assert from 'node:assert/strict';
import test from 'node:test';
import { spokenText } from '../packages/domain/speech-text.ts';

test('emoji and punctuation are dropped from the spoken text', () => {
  assert.equal(spokenText('Привет! Я Север, ИИ-персонаж — рад тебя слышать 😄'),
    'Привет Я Север ИИ персонаж рад тебя слышать');
});

test('a hyphen inside a word splits it rather than vanishing', () => {
  assert.equal(spokenText('ИИ-персонаж'), 'ИИ персонаж');
});

test('digits survive because the character counts things out loud', () => {
  assert.equal(spokenText('Рядом только Irlirion — примерно в 2 блоках'), 'Рядом только Irlirion примерно в 2 блоках');
});

test('a whole emoji sequence leaves no orphaned marks behind', () => {
  assert.equal(spokenText('семья 👨‍👩‍👧 и флаг 🇷🇺'), 'семья и флаг');
});

test('collapsed runs do not leave double spaces or edges', () => {
  assert.equal(spokenText('  раз,  два — три.  '), 'раз два три');
});

test('cyrillic and latin letters are both preserved', () => {
  assert.equal(spokenText('Север и Irlirion'), 'Север и Irlirion');
});

test('text that is only emoji becomes empty rather than whitespace', () => {
  assert.equal(spokenText('😄 🎉'), '');
  assert.equal(spokenText('   '), '');
});