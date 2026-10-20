import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { GenericMeasureResultDto, PersonalEffortResultDto } from '@workloom/contracts';
import { Measure } from './ReportResults';
import { WorkspaceDashboard } from '../workspace-reports/WorkspaceDashboard';
import { dashboardResult } from '../workspace-reports/test/fixtures';
import { amount, coverage, fact, result } from './test/fixtures';

const known:PersonalEffortResultDto={minutes:240,canonicalTaskCount:1,participationCount:5,coverage:{sources:5,known:4,unknown:1,zero:0,void:0},contributions:[]};
const measure:GenericMeasureResultDto={key:'effort',operation:'personal_effort',fieldId:fact.id,unit:'minutes',value:amount(240),coverage,effort:known};
it('shows canonical count, participation count and unknown attendance beside a known subtotal',()=>{
 render(<Measure measure={measure} result={result()}/>);
 expect(screen.getByText('4h')).toBeVisible();expect(screen.getByText('1 distinct tasks · 5 shared participations')).toBeVisible();expect(screen.getByText('4 of 5 contributions known · 1 unknown · 0 void')).toBeVisible();expect(screen.getByText('Known subtotal; some participation is not confirmed.')).toBeVisible();
 expect(screen.queryByText(/60 of 63 tasks/)).not.toBeInTheDocument();
});
it('does not turn entirely unconfirmed time into zero',()=>{
 render(<Measure measure={{...measure,value:null,effort:{...known,minutes:null,coverage:{sources:5,known:0,unknown:5,zero:0,void:0}}}} result={result()}/>);
 expect(screen.getByText('—')).toBeVisible();expect(screen.queryByText('0m')).not.toBeInTheDocument();expect(screen.getByText('0 of 5 contributions known · 5 unknown · 0 void')).toBeVisible();
});
it('workspace personal effort labels its method and never presents incomplete attendance as a full capacity ratio',()=>{
 const data=dashboardResult();data.attribution='personal_effort';data.summary.effort={plan:known,fact:known};data.summary.fact={...measure,value:amount(240)};
 render(<WorkspaceDashboard result={data} onPersonSelect={()=>undefined}/>);
 expect(screen.getByText('Personal effort')).toBeVisible();expect(screen.getByText('Dates select the current task cohort, including shared calls. These are not daily attendance or time logs.')).toBeVisible();expect(screen.getByText('1 distinct tasks · 5 shared participations')).toBeVisible();expect(screen.getByRole('article',{name:'Actual'})).toHaveTextContent('Recorded/available: —');
});
