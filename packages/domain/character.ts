import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

export const DEFAULT_CHARACTER_FILE = 'characters/Lada/personalities.yml';
const text = z.string().trim().min(1);
const identity = z.object({ id: text, name: text }).strict();
const characterSchema = z.object({ id: text, name: text, persona: text }).strict();
const yamlSchema = z.object({
  character: identity,
  streamer_abstract: text,
  streamer_fewshot: z.record(z.string(), text).optional()
}).strict();

/** Normalize a package once in core; engines continue receiving the same persona string. */
export function parseCharacter(source: string, format: 'json' | 'yaml', expectedId?: string) {
  let character: z.infer<typeof characterSchema>;
  if (format === 'json') {
    character = characterSchema.parse(JSON.parse(source));
  } else {
    const data = yamlSchema.parse(parse(source, { maxAliasCount: 0, logLevel: 'error' }));
    let persona = data.streamer_abstract;
    const examples = data.streamer_fewshot;
    if (examples && Object.keys(examples).length) {
      const pairs: string[] = [];
      for (const key of Object.keys(examples)) {
        if (!key.endsWith('_q') && !key.endsWith('_a')) throw new Error('Invalid fewshot key');
        const prefix = key.slice(0, -2);
        if (!Object.hasOwn(examples, `${prefix}_q`) || !Object.hasOwn(examples, `${prefix}_a`)) {
          throw new Error('Incomplete fewshot pair');
        }
        if (key.endsWith('_q')) pairs.push(`Собеседник: ${examples[key]}\n${data.character.name}: ${examples[`${prefix}_a`]}`);
      }
      persona += `\n\nПримеры интонации, не события разговора:\n${pairs.join('\n')}`;
    }
    character = characterSchema.parse({ ...data.character, persona });
  }
  if (expectedId !== undefined && character.id !== expectedId) throw new Error('Character binding mismatch');
  return character;
}

export async function loadCharacter(file = DEFAULT_CHARACTER_FILE, expectedId?: string) {
  const extension = extname(file).toLowerCase();
  if (!['.json', '.yml', '.yaml'].includes(extension)) throw new Error('Unsupported character file');
  return parseCharacter(await readFile(file, 'utf8'), extension === '.json' ? 'json' : 'yaml', expectedId);
}
