import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { genericHeaderWidgetSchema, setGenericAggregateSettingsInputSchema, type GenericHeaderWidgetDto } from '@workloom/contracts';
import { alpha, alphaMembers } from '../../test/fakeApi';
import { HeaderWidgets } from './HeaderWidgets';
import { fact, plan } from './test/fixtures';
afterEach(()=>vi.restoreAllMocks());
it('directly saves each popup with stable valid keys when generated UUIDs begin with a digit',async()=>{
 const user=userEvent.setup(),group={kind:'section' as const,sectionId:null},retained:GenericHeaderWidgetDto={key:'retained',label:'Retained source',kind:'measure',measure:{key:'retained_sum',operation:'sum',fieldId:fact.id}},save=vi.fn((widgets:GenericHeaderWidgetDto[],revision:number)=>{setGenericAggregateSettingsInputSchema.parse({expectedRevision:revision,measures:[],headerWidgets:[{group,widgets}]});});
 function Example(){const[widgets,setWidgets]=useState<GenericHeaderWidgetDto[]>([retained]),[revision,setRevision]=useState(2);return <HeaderWidgets group={group} title="Delivery" rules={[{group,widgets}]} result={undefined} fields={[plan,fact]} members={alphaMembers} workspaceId={alpha.id} writable disabled={false} loading={false} revision={revision} feedback={null} uncertain={false} projectDateRange={{from:'2026-10-19',to:'2026-10-25'}} onRetry={()=>undefined} onSave={(next,expected,done)=>{save(next,expected);setWidgets(next);setRevision(value=>value+1);done();}}/>;}
 render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><Example/></MemoryRouter></QueryClientProvider>);
 const uuids=['90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000002']as const;let at=0;const generated=vi.spyOn(crypto,'randomUUID').mockImplementation(()=>uuids[at++]??'90000000-0000-4000-8000-000000000099');
 const add=async()=>{await user.click(screen.getByRole('button',{name:'Configure summary for Delivery'}));await user.click(within(screen.getByRole('dialog',{name:'Summary · Delivery'})).getByRole('button',{name:'Add indicator'}));return screen.getByRole('dialog',{name:'Add summary indicator'});};
 const choose=async(dialog:HTMLElement,label:string,option:string)=>{await user.click(within(dialog).getByRole('combobox',{name:label}));await user.click(screen.getByRole('option',{name:option}));};
 let dialog=await add();await choose(dialog,'Field','Budget');await user.click(within(dialog).getByRole('button',{name:'Save indicator'}));expect(save).toHaveBeenCalledOnce();expect(save.mock.calls[0]?.[1]).toBe(2);
 dialog=await add();await choose(dialog,'Summary type','Person’s available working time');await choose(dialog,'Person','Анна Тестова');await user.click(within(dialog).getByRole('button',{name:'Save indicator'}));expect(save).toHaveBeenCalledTimes(2);const widgets=save.mock.calls[1]?.[0]??[];expect(save.mock.calls[1]?.[1]).toBe(3);expect(widgets).toHaveLength(3);expect(widgets[0]).toEqual(retained);expect(widgets.slice(1).map(widget=>widget.key)).toEqual(uuids.map(uuid=>`w_${uuid}`));for(const widget of widgets)expect(genericHeaderWidgetSchema.parse(widget)).toEqual(widget);expect(generated).toHaveBeenCalledTimes(2);expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
