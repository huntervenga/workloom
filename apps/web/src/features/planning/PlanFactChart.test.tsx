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
    expect(screen.getByRole('img', { name: 'Анна · Исследование, план: Не задан' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Анна · Исследование, факт: Не внесено' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Иван · Проверка, план: 0 мин' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Иван · Проверка, факт: 0 мин' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Ольга · Дизайн, план: 1 ч 30 мин' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Ольга · Дизайн, факт: 1 ч 1 мин' })).toBeInTheDocument();
  });
});
