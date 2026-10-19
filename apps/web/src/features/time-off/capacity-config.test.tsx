import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { emptyReportConfig } from '../generic-reports/ReportConfigEditor';
import { alphaMembers } from '../../test/fakeApi';
import { ReportCapacityEditor } from './ReportCapacityEditor';
function Host() { const [config,setConfig] = useState(emptyReportConfig('f0000000-0000-4000-8000-000000000001')); return <><ReportCapacityEditor config={config} onChange={setConfig} members={alphaMembers}/><output aria-label="Config">{JSON.stringify(config)}</output></>; }
describe('optional independently scoped capacity', () => {
  it('leaves existing reports unchanged, requires explicit dates and removes capacity cleanly', async () => {
    const user = userEvent.setup(); render(<Host/>);
    expect(JSON.parse(screen.getByLabelText('Config').textContent ?? '{}')).not.toHaveProperty('capacity');
    await user.click(screen.getByRole('checkbox', { name: 'Compare with working capacity' }));
    expect(screen.getByLabelText('Capacity interval start')).toHaveValue(''); expect(screen.getByLabelText('Capacity interval end')).toHaveValue('');
    await user.type(screen.getByLabelText('Capacity interval start'), '2026-10-19'); await user.type(screen.getByLabelText('Capacity interval end'), '2026-10-25');
    const config = JSON.parse(screen.getByLabelText('Config').textContent ?? '{}'); expect(config.capacity).toEqual({ startDate: '2026-10-19', endDate: '2026-10-25', people: { kind:'all_active' } }); expect(config.filters.dateRange).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'Compare with working capacity' })); expect(JSON.parse(screen.getByLabelText('Config').textContent ?? '{}')).not.toHaveProperty('capacity');
  });
});
