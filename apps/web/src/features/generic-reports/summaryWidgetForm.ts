import { genericHeaderWidgetSchema, summaryTemplateWidgetSchema, type GenericHeaderWidgetDto, type GenericReportMeasure, type SummaryTemplateWidgetDto } from '@workloom/contracts';
export interface WidgetForm {editingKey:string|null;kind:string;fieldId:string;membershipId:string;operation:GenericReportMeasure['operation'];range:string;from:string;to:string;manual:boolean;minutes:string;note:string}
export const emptyWidgetForm=():WidgetForm=>({editingKey:null,kind:'measure',fieldId:'',membershipId:'',operation:'sum',range:'project_dates',from:'',to:'',manual:false,minutes:'',note:''});
export function widgetFormFromValue(widget:GenericHeaderWidgetDto|SummaryTemplateWidgetDto|null):WidgetForm{
 if(!widget)return emptyWidgetForm();
 const base={...emptyWidgetForm(),editingKey:widget.key};
 if(widget.kind==='personal_effort')return{...base,kind:widget.kind,fieldId:widget.fieldId};
 if(widget.kind==='measure')return{...base,kind:widget.kind,fieldId:'fieldId'in widget.measure?widget.measure.fieldId:'',operation:widget.measure.operation};
 return{...base,kind:widget.kind,membershipId:'membershipId'in widget?widget.membershipId:'',range:'range'in widget?widget.range.kind:'project_dates',from:'range'in widget&&widget.range.kind==='dates'?widget.range.from:'',to:'range'in widget&&widget.range.kind==='dates'?widget.range.to:'',manual:widget.override!==undefined,minutes:widget.override?String(widget.override.minutes):'',note:widget.override?.note??''};
}
function widgetCandidate(form:WidgetForm,key:string,portable:boolean){
 if(form.kind==='personal_effort')return{key,kind:form.kind,fieldId:form.fieldId};
 if(form.kind==='measure')return{key,kind:form.kind,measure:form.operation==='count_tasks'?{key,operation:form.operation}:{key,operation:form.operation,fieldId:form.fieldId}};
 const range=form.range==='project_dates'?{kind:'project_dates'}:form.range==='this_week'?{kind:'this_week'}:{kind:'dates',from:form.from,to:form.to};
 return{key,kind:form.kind,...(portable?{}:{membershipId:form.membershipId,range}),...(form.manual?{override:{minutes:form.minutes.trim()===''?NaN:Number(form.minutes),...(form.note.trim()?{note:form.note.trim()}:{})}}:{})};
}
export function headerWidgetFromForm(form:WidgetForm,key:string):GenericHeaderWidgetDto|null{const parsed=genericHeaderWidgetSchema.safeParse(widgetCandidate(form,key,false));return parsed.success?parsed.data:null;}
export function templateWidgetFromForm(form:WidgetForm,key:string):SummaryTemplateWidgetDto|null{const parsed=summaryTemplateWidgetSchema.safeParse(widgetCandidate(form,key,true));return parsed.success?parsed.data:null;}
export function preserveWidgetIdentity<T extends GenericHeaderWidgetDto|SummaryTemplateWidgetDto>(widget:T,previous:GenericHeaderWidgetDto|SummaryTemplateWidgetDto|null):T{
 if(!previous)return widget;
 return{...widget,...(previous.label?{label:previous.label}:{}),...(widget.kind==='measure'&&previous.kind==='measure'?{measure:{...widget.measure,key:previous.measure.key}}:{}),...(widget.kind==='personal_effort'&&previous.kind==='personal_effort'&&'membershipId'in previous&&previous.membershipId?{membershipId:previous.membershipId}:{})};
}
