import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { ReportConfigEditor } from './ReportConfigEditor';
import { definition, plan, fact } from './test/fixtures';
import { field } from '../fields/test/fixtures';

function Editor(){const [config,setConfig]=useState(definition().config);return <><ReportConfigEditor config={config} onChange={setConfig} fields={[plan,fact,field('Points','number')]} members={[]} tags={[]} disabled={false}/><output aria-label="Saved config">{JSON.stringify(config)}</output></>;}
it('explicitly selects personal effort comparison and duration measures without rewriting SUM',async()=>{
 const user=userEvent.setup();render(<Editor/>);
 await user.click(screen.getByRole('combobox',{name:'Compare time as'}));await user.click(screen.getByRole('option',{name:'Personal effort'}));
 let config=JSON.parse(screen.getByLabelText('Saved config').textContent??'{}');expect(config.comparison.attribution).toBe('personal_effort');expect(config.measures[0].operation).toBe('sum');
 await user.click(screen.getByRole('combobox',{name:'Calculation 1'}));await user.click(screen.getByRole('option',{name:'Personal effort'}));
 await user.click(screen.getByRole('combobox',{name:'Value field 1'}));expect(screen.queryByRole('option',{name:'Points'})).not.toBeInTheDocument();await user.keyboard('{Escape}');
 config=JSON.parse(screen.getByLabelText('Saved config').textContent??'{}');expect(config.measures[0]).toMatchObject({operation:'personal_effort',fieldId:plan.id});
 await user.click(screen.getByRole('combobox',{name:'Compare time as'}));await user.click(screen.getByRole('option',{name:'Task values'}));
 config=JSON.parse(screen.getByLabelText('Saved config').textContent??'{}');expect(config.comparison).not.toHaveProperty('attribution');expect(config.measures[0].operation).toBe('personal_effort');
});
