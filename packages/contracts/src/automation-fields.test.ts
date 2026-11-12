import { describe, expect, it } from 'vitest';
import { MCP_TOOL_INPUTS, parseDurationMinutes, publicSetTaskFieldsSchema, publicTimeSummaryQuerySchema } from './automation.js';

const taskId = '00000000-0000-4000-8000-000000000001';

describe('automation field contracts', () => {
  it('parses the friendly duration forms into whole minutes', () => {
    const cases: [number | string, number][] = [
      [90, 90], ['90', 90], ['90m', 90], ['1.5h', 90], ['1,5h', 90], ['1h 30m', 90], ['1h30m', 90], ['1:30', 90],
      ['2h', 120], ['0', 0], ['45 min', 45], ['2 hours', 120], ['1ч 30мин', 90], [' 3H ', 180], ['0.25h', 15],
    ];
    for (const [input, minutes] of cases) expect(parseDurationMinutes(input), String(input)).toBe(minutes);
  });

  it('rejects text that is not a whole-minute duration', () => {
    for (const input of ['', 'soon', '-1h', '1.01h', '1:75', '1.5', 1.5, -5, 'h', '1h 30', 'm30'] as const) expect(parseDurationMinutes(input), String(input)).toBeNull();
  });

  it('requires each task and each field once per request', () => {
    expect(publicSetTaskFieldsSchema.safeParse({ items: [{ taskId, values: [{ field: 'Fact', value: '1h' }] }] }).success).toBe(true);
    expect(publicSetTaskFieldsSchema.safeParse({ items: [{ taskId, values: [{ field: 'Fact', value: '1h' }, { field: 'fact', value: '2h' }] }] }).success).toBe(false);
    expect(publicSetTaskFieldsSchema.safeParse({ items: [{ taskId, values: [{ field: 'Fact', value: 1 }] }, { taskId, values: [{ field: 'Estimation', value: 1 }] }] }).success).toBe(false);
    expect(publicSetTaskFieldsSchema.safeParse({ items: [{ taskId, project: 'Week 45', values: [{ field: 'Fact', value: 1 }] }, { taskId, values: [{ field: 'Fact', value: 1 }] }] }).success).toBe(true);
    expect(publicSetTaskFieldsSchema.safeParse({ items: [] }).success).toBe(false);
  });

  it('leaves the time summary fields to the project\'s time fields and requires a complete range', () => {
    const parsed = publicTimeSummaryQuerySchema.parse({ project: 'Week 45' });
    expect(parsed).toMatchObject({ includeTasks: true });
    expect(parsed.planField).toBeUndefined();
    expect(parsed.factField).toBeUndefined();
    expect(publicTimeSummaryQuerySchema.parse({ project: 'W', people: 'me,Anna', includeTasks: 'false' })).toMatchObject({ people: ['me', 'Anna'], includeTasks: false });
    expect(publicTimeSummaryQuerySchema.safeParse({ project: 'W', from: '2026-11-02' }).success).toBe(false);
    expect(publicTimeSummaryQuerySchema.safeParse({ project: 'W', from: '2026-11-08', to: '2026-11-02' }).success).toBe(false);
  });

  it('exposes the MCP inputs for the new tools', () => {
    expect(MCP_TOOL_INPUTS.set_task_fields.safeParse({ items: [{ taskId, values: [{ field: 'Fact', value: null }] }], dryRun: true }).success).toBe(true);
    expect(MCP_TOOL_INPUTS.time_summary.safeParse({ project: 'Week 45', people: ['me'] }).success).toBe(true);
    expect(MCP_TOOL_INPUTS.list_tasks.safeParse({ includeFields: true }).success).toBe(true);
  });
});
