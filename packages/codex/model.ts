export type CodexModel={id:string;model?:string;isDefault?:boolean};
export function selectConfiguredModel<T extends CodexModel>(models:readonly T[],requested:string):T{
 const selected=models.find(m=>m.id===requested||m.model===requested);
 if(!selected)throw new Error('configured_model_unavailable');
 return selected;
}
