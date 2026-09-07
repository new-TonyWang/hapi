import { useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'

/**
 * Change the Codex provider of a running session.
 *
 * Empty selection (or empty custom input) restores the default provider —
 * the backend clears both provider and profile for that case. Changing the
 * provider stops and re-opens the session, which the copy states up front.
 * The provider list comes from Codex model discovery (useCodexModels) on
 * the session's machine; unknown providers can be typed by hand.
 */
export function ChangeCodexProviderDialog(props: {
    isOpen: boolean
    onClose: () => void
    currentProvider?: string | null
    providers: string[]
    onChange: (provider: string | null) => Promise<void>
    isPending: boolean
}) {
    const { isOpen, onClose, currentProvider, providers, onChange, isPending } = props
    const { t } = useTranslation()
    const [value, setValue] = useState('')
    const [customProvider, setCustomProvider] = useState('')
    const [error, setError] = useState<string | null>(null)

    // Machine-discovered providers plus the current one; the empty option
    // is the "default" choice rendered separately, so no '' entry here.
    const options = useMemo(() => {
        const all = new Set<string>()
        for (const provider of providers) {
            if (provider.trim()) all.add(provider.trim())
        }
        if (currentProvider?.trim()) all.add(currentProvider.trim())
        return [...all].sort((a, b) => a.localeCompare(b))
    }, [providers, currentProvider])

    useEffect(() => {
        if (isOpen) {
            setValue(currentProvider?.trim() ?? '')
            setCustomProvider('')
            setError(null)
        }
    }, [isOpen, currentProvider])

    const submit = async (event: React.FormEvent) => {
        event.preventDefault()
        setError(null)
        // Empty string means default: provider (and profile) are cleared.
        const next = customProvider.trim() || value.trim() || null
        try {
            await onChange(next)
            onClose()
        } catch (e) {
            setError(e instanceof Error ? e.message : t('session.provider.changeFailed'))
        }
    }

    return <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle className="text-center">{t('session.provider.changeTitle')}</DialogTitle></DialogHeader>
            <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
                <p className="text-sm text-[var(--app-hint)]">{t('session.provider.changeRestartNotice')}</p>
                <label className="flex flex-col gap-1.5 text-sm text-[var(--app-fg)]">
                    <span>{t('session.provider.changeLabel')}</span>
                    <select
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        disabled={isPending}
                        aria-label={t('session.provider.changeLabel')}
                        className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2.5 text-[var(--app-fg)]"
                    >
                        <option value="">{t('session.provider.defaultOption')}</option>
                        {options.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
                    </select>
                </label>
                <input
                    type="text"
                    value={customProvider}
                    onChange={(e) => setCustomProvider(e.target.value)}
                    placeholder={t('session.provider.customPlaceholder')}
                    disabled={isPending}
                    maxLength={255}
                    aria-label={t('session.provider.customPlaceholder')}
                    className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2.5 text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-button)]"
                />
                {error ? (
                    <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                        {error}
                    </div>
                ) : null}
                <div className="flex justify-end gap-2">
                    <Button type="button" variant="secondary" onClick={onClose} disabled={isPending}>
                        {t('button.cancel')}
                    </Button>
                    <Button type="submit" disabled={isPending}>
                        {isPending ? t('session.provider.changing') : t('session.provider.change')}
                    </Button>
                </div>
            </form>
        </DialogContent>
    </Dialog>
}
