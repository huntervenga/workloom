import { Button } from '@workloom/ui';
import { Moon, Sun } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { useTranslation } from '../../i18n';
import { themeManager, type Theme, type ThemeManager } from './ThemeManager';

export function useTheme(manager: ThemeManager = themeManager): Theme {
  return useSyncExternalStore(manager.subscribe, manager.getTheme, () => 'light');
}

/** Only flips the root attribute: nothing remounts, so drafts, queries and focus stay put. */
export function ThemeToggle({ manager = themeManager }: { manager?: ThemeManager | undefined }) {
  const { t } = useTranslation();
  const dark = useTheme(manager) === 'dark';
  const title = dark ? t('theme.toLight') : t('theme.toDark');
  return (
    <Button variant="ghost" size="sm" className="w-8 px-0" aria-label={t('theme.label')} aria-pressed={dark} title={title} onClick={manager.toggle}>
      {dark ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
    </Button>
  );
}
