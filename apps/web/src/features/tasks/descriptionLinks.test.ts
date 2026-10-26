import { describe, expect, it } from 'vitest';
import { hasDescriptionLinks, parseTaskLink, splitDescription } from './descriptionLinks';

const project = '11111111-2222-4333-8444-555555555555', task = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('description links', () => {
  it('finds web addresses and leaves sentence punctuation outside', () => {
    expect(splitDescription('See https://example.com/a?b=1, then (https://x.io).')).toEqual([
      { kind: 'text', text: 'See ' }, { kind: 'link', href: 'https://example.com/a?b=1' },
      { kind: 'text', text: ', then (' }, { kind: 'link', href: 'https://x.io' }, { kind: 'text', text: ').' }]);
    expect(hasDescriptionLinks('no links here')).toBe(false);
  });
  it('recognises a link to a task of this service only', () => {
    const origin = 'https://workloom.example.com';
    expect(parseTaskLink(`${origin}/app/w/balancy/projects/${project}?task=${task}`, origin)).toEqual({ projectId: project, taskId: task });
    expect(parseTaskLink(`https://other.com/projects/${project}?task=${task}`, origin)).toBeNull();
    expect(parseTaskLink(`${origin}/app/w/balancy/projects/${project}`, origin)).toBeNull();
  });
});
