import { t, useTranslation } from '../../i18n';
import { Button } from '@workloom/ui';
import { TriangleAlert, X } from 'lucide-react';
import { describeError } from '../../lib/errors';
import { useSession } from '../session';

export function SwitchErrorNotice() {
  useTranslation();
  const { switchError, dismissSwitchError } = useSession();
  if (switchError === null) return null;
  const described = describeError(switchError, 'actorSwitch');

  return (
    <div role="alert" className="mb-6 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50/70 px-4 py-3 text-sm">
      <TriangleAlert size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-red-600" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-red-900">{described.title}</p>
        <p className="mt-0.5 text-red-800/90">
          {described.description}  {t('shell.serverActorNotice')}
        </p>
      </div>
      <Button variant="ghost" size="sm" className="-mt-1 -mr-2 px-2" aria-label={t('shell.dismissMessage')} onClick={dismissSwitchError}>
        <X size={16} aria-hidden="true" />
      </Button>
    </div>
  );
}
