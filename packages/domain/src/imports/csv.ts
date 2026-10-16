import {IMPORT_LIMITS,isImportStringSafe} from '@workloom/contracts';
import {DomainError} from '../errors.js';
/** Counts accepted Unicode as UTF8 bytes without Node/Buffer or repairing surrogate errors. */
export function importUtf8Bytes(value:string):number {if(!isImportStringSafe(value))throw invalid('NUL or ill-formed Unicode in CSV.');let count=0;for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);if(c<0x80)count++;else if(c<0x800)count+=2;else if(c>=0xd800&&c<=0xdbff){count+=4;i++;}else count+=3;}return count;}
function invalid(message:string):DomainError{return new DomainError('VALIDATION_FAILED',message);}
/** Strict bounded CSV state machine: commas/CRLF/LF/CR, escaped double quotes and literal quoted newlines. */
export function parseImportCsv(raw:string):{headers:string[];sourceRows:{rowNumber:number;cells:string[]}[]} {
 if(importUtf8Bytes(raw)>IMPORT_LIMITS.maxCsvBytes)throw invalid('CSV exceeds1MiB decoded UTF8.');
 const text=raw.startsWith('\ufeff')?raw.slice(1):raw;
 const records:string[][]=[];let row:string[]=[],cell='',quoted=false,closed=false,started=false;
 const pushCell=()=>{if(cell.length>20000)throw invalid('CSV cell exceeds20000 characters.');row.push(cell);if(row.length>100)throw invalid('CSV has more than100 columns.');cell='';closed=false;started=false;};
 const pushRow=()=>{pushCell();records.push(row);row=[];if(records.length>51)throw invalid('CSV has more than50 DATA ROWS.');};
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;}
  else if(c===',')pushCell();
  else if(c==='\n'||c==='\r'){pushRow();if(c==='\r'&&text[i+1]==='\n')i++;}
  else if(c==='"'){if(started||cell!==''||closed)throw invalid('Quote in an unquoted CSV cell.');quoted=true;started=true;}
  else{if(closed)throw invalid('Characters after a closing CSV quote.');cell+=c;started=true;}
  if(cell.length>20000)throw invalid('CSV cell exceeds20000 characters.');
 }
 if(quoted)throw invalid('Unclosed CSV quote.');
 if(started||closed||cell!==''||row.length)pushRow();
 const headers=records.shift();if(!headers||headers.length===0||headers.every(h=>h===''))throw invalid('CSV requires a header row.');
 if(records.length===0)throw invalid('CSV requires at least one DATA ROW.');
 if(records.some(r=>r.length!==headers.length))throw invalid('Every CSV record must have the header column count.');
 return {headers,sourceRows:records.map((cells,index)=>({rowNumber:index+1,cells}))};
}
