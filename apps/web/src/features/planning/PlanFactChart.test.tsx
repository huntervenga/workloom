import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PlanFactChart } from './PlanFactChart';

describe('PlanFactChart', () => {
  it('explains missing entries independently from confirmed zero and preserves minute precision', () => {
    render(<PlanFactChart items={[
      { id: 'missing', label: 'Анна · Исследование', planMinutes: null, factMinutes: null },
      { id: 'zero', label: 'Иван · Проверка', planMinutes: 0, factMinutes: 0 },
      { id: 'known', label: 'Ольга · Дизайн', planMinutes: 90, factMinutes: 61 },
    ]} />);
    expect(screen.getByRole('img', { name: 'Анна · Исследование, plan: Not set' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Анна · Исследование, actual: Not recorded' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Иван · Проверка, plan: 0m' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Иван · Проверка, actual: 0m' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Ольга · Дизайн, plan: 1h 30m' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Ольга · Дизайн, actual: 1h 1m' })).toBeInTheDocument();
  });
});
