import { useTranslation } from '@/lib/use-translation'

/**
 * Automation-paused banner: the session's automation sends are blocked by a
 * human stop, but the human composer still posts to /messages normally (the
 * hub lets human sends through — only automation-origin sends are rejected).
 * Only the explicit Resume button clears the flag; ordinary sends never
 * resume implicitly.
 */
export function AutomationPausedBanner(props: {
    onResume: () => void
    isPending?: boolean
}) {
    const { t } = useTranslation()
    return (
        <div className="px-3 pt-3">
            <div
                data-testid="automation-paused-banner"
                className="mx-auto flex w-full max-w-content items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm"
            >
                <div className="text-[var(--app-fg)]">
                    <div className="font-medium text-amber-600 dark:text-amber-400">
                        {t('session.automationPaused.title')}
                    </div>
                    <div className="text-[var(--app-hint)]">{t('session.automationPaused.body')}</div>
                </div>
                <button
                    type="button"
                    aria-label={t('session.automationPaused.resume')}
                    disabled={props.isPending}
                    className="shrink-0 rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={props.onResume}
                >
                    {t('session.automationPaused.resume')}
                </button>
            </div>
        </div>
    )
}
