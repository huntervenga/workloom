import {sqlCalendarDateSchema,type ProjectImportMapping,type TaskFieldDefinitionDto,type TaskFieldData} from '@workloom/contracts';
export function importDate(raw:string,format:'iso'|'us'):string|null {if(raw.trim()==='')return null;let value=raw.trim();if(format==='us'){const m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);if(!m)throw new Error('Expected MM/DD/YYYY.');value=`${m[3]}-${m[1]?.padStart(2,'0')}-${m[2]?.padStart(2,'0')}`;}if(!sqlCalendarDateSchema.safeParse(value).success)throw new Error('Expected a real date in years0001–9999.');return value;}
function exactMinutes(value:string,unit:'minutes'|'hours'):number {if(value.length>100)throw new Error('Duration precision exceeds supported bounds.');const m=/^\+?(\d+)(?:\.(\d+))?$/.exec(value);if(!m)throw new Error('Duration must be a nonnegative decimal.');const fraction=m[2]??'',denominator=10n**BigInt(fraction.length),numerator=BigInt(`${m[1]}${fraction}`)*(unit==='hours'?60n:1n);if(numerator%denominator!==0n)throw new Error('Duration contains fractional minutes; no rounding is performed.');const minutes=numerator/denominator;if(minutes>2147483647n)throw new Error('Duration exceeds supported minutes.');return Number(minutes);}
export function importScalar(raw:string,field:TaskFieldDefinitionDto,map:ProjectImportMapping['customFields'][number],format:'iso'|'us'):TaskFieldData|undefined {
 const empty=raw==='';if(empty&&map.empty==='missing')return undefined;
 if(!['text','number','duration','date','boolean'].includes(field.type))throw new Error('Only five scalar field types are supported.');
 if(map.sourceMeaning!=='ordinary'&&(!map.sourceUnit||!['number','duration'].includes(field.type)))throw new Error('Source-current time requires explicit units and a number/duration field.');
 switch(field.type){
  case 'text':return {type:'text',value:empty?null:raw};
  case 'number':{if(empty)return {type:'number',value:null};const value=raw.trim();if(value.length>100||! /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value))throw new Error('Expected a plain decimal number.');const number=Number(value);if(!Number.isFinite(number)||Math.abs(number)>Number.MAX_SAFE_INTEGER)throw new Error('Number exceeds supported precision.');return {type:'number',value:number};}
  case 'duration':if(!map.sourceUnit)throw new Error('Choose minutes or hours explicitly.');return {type:'duration',value:empty?null:exactMinutes(raw.trim(),map.sourceUnit)};
  case 'date':return {type:'date',value:empty?null:importDate(raw,format)};
  case 'boolean':{if(empty)return {type:'boolean',value:null};const value=raw.trim().toLowerCase();if(!['true','false','1','0'].includes(value))throw new Error('Expected true/false or1/0.');return {type:'boolean',value:value==='true'||value==='1'};}
  default:throw new Error('Unsupported import field type.');
 }
}
