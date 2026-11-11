import { MAX_TITLE_LENGTH } from './contracts';

/** Keep every title Queue sends to Paseo within its 200-character limit. */
export function capPaseoTitle(title:string){
  if(title.length<=MAX_TITLE_LENGTH)return title;
  let prefix='';
  for(const character of title){
    if(prefix.length+character.length>MAX_TITLE_LENGTH-1)break;
    prefix+=character;
  }
  const boundary=[...prefix.matchAll(/\s/g)].at(-1)?.index??-1;
  if(boundary>0)prefix=prefix.slice(0,boundary);
  return `${prefix.trimEnd()}…`;
}

