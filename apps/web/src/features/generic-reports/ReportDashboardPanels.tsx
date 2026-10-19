import { useState } from 'react';
import type { GenericReportResultDto, MembershipDto, SectionDto, TaskFieldDefinitionDto } from '@workloom/contracts';
import { useTranslation } from '../../i18n';
import { ReportSelect } from './ReportConfigEditor';
import { ReportDashboard } from './ReportDashboard';
import { useAggregates } from './queries';
import { QueryErrorState } from '../../shared/QueryErrorState';

/** Both breakdowns are independent full-scope server queries using the displayed filters. */
export function ReportDashboardPanels({actorId,workspaceId,projectId,result,members,sections,fields,disabled,onPersonSelect}:{actorId:string;workspaceId:string;projectId:string;result:GenericReportResultDto;members:readonly MembershipDto[];sections:readonly SectionDto[];fields:readonly TaskFieldDefinitionDto[];disabled:boolean;onPersonSelect:(membershipId:string|null)=>void}){
 const {t}=useTranslation();
 const [categoryId,setCategoryId]=useState(result.config.groupBy.kind==='category'?result.config.groupBy.fieldId:'');
 const categories=fields.filter(field=>field.type==='single_select'&&field.archivedAt===null);
 const {capacity: authorizedCapacity,...taskConfig}=result.config;
 void authorizedCapacity;
 const people=useAggregates(actorId,workspaceId,projectId,{config:{...taskConfig,groupBy:{kind:'assignee'}},offset:0,limit:1},result.config.comparison!==null&&result.config.groupBy.kind!=='assignee');
 const category=useAggregates(actorId,workspaceId,projectId,{config:{...taskConfig,groupBy:{kind:'category',fieldId:categoryId}},offset:0,limit:1},categoryId!==''&&!(result.config.groupBy.kind==='category'&&result.config.groupBy.fieldId===categoryId));
 return <div className="space-y-3">
  {result.config.comparison!==null&&result.config.groupBy.kind!=='assignee'?people.isError?<QueryErrorState error={people.error} subject="fields" headingLevel={3} onRetry={()=>void people.refetch()}/>:people.data?<ReportDashboard result={{...people.data,...(result.capacity?{capacity:result.capacity}:{})}} members={members} sections={sections} hideSummary {...(!disabled?{onPersonSelect}:{})}/>:<p role="status" className="text-xs text-muted">{t('genericReports.calculating')}</p>:null}
  {categories.length>0?<div className="space-y-2"><div className="max-w-72"><ReportSelect label={t('genericReports.categoryBreakdown')} value={categoryId} onChange={setCategoryId}><option value="">{t('genericReports.chooseCategoryBreakdown')}</option>{categories.map(field=><option key={field.id} value={field.id}>{field.name}</option>)}</ReportSelect></div>{categoryId!==''&&!(result.config.groupBy.kind==='category'&&result.config.groupBy.fieldId===categoryId)?category.isError?<QueryErrorState error={category.error} subject="fields" headingLevel={3} onRetry={()=>void category.refetch()}/>:category.data?<ReportDashboard result={category.data} members={members} sections={sections} hideSummary/>:<p role="status" className="text-xs text-muted">{t('genericReports.calculating')}</p>:null}</div>:null}
 </div>;
}
