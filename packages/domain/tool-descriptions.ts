import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('./tool-descriptions.md',import.meta.url),'utf8');
const descriptions=new Map([...source.matchAll(/^## ([a-z0-9-]+)\n\n([\s\S]*?)(?=\n\n## |\n?$)/gm)].map(m=>[m[1],m[2]]));
export function toolDescription(id:string):string {
 const value=descriptions.get(id);
 if(!value)throw new Error(`Missing tool description: ${id}`);
 return value;
}
