import { readFileSync } from 'node:fs';
export const MINECRAFT_WORKSPACE_INSTRUCTIONS = readFileSync(new URL('./workspace.md',import.meta.url),'utf8').trimEnd();
