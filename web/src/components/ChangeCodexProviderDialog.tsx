import { useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export function ChangeCodexProviderDialog(props: {
    isOpen: boolean
    onClose: () => void
    currentProvider?: string | null
    providers: string[]
    onChange: (provider: string | null) => Promise<void>
    isPending: boolean
}) {
    const { isOpen, onClose, currentProvider, providers, onChange, isPending } = props
    const [value, setValue] = useState('')
    const [customProvider, setCustomProvider] = useState('')
    const [error, setError] = useState<string | null>(null)
    const options = useMemo(() => {
        // Keep this list aligned with New Session's provider suggestions;
        // machine-scanned providers are added on top of the built-in choices.
        const all = new Set(['Zhipu_Bigmodel', 'bigmodel', 'openai'])
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
        try { await onChange(customProvider.trim() || value || null); onClose() } catch (e) { setError(e instanceof Error ? e.message : 'Failed to change provider') }
    }
    return <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle className="text-center">Change Codex provider</DialogTitle></DialogHeader>
            <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
                <p className="text-sm text-[var(--app-hint)]">The active session will restart and resume with the selected provider.</p>
                <select value={value} onChange={(e) => setValue(e.target.value)} disabled={isPending} className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2.5 text-[var(--app-fg)]">
                    <option value="">Default provider</option>
                    {options.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
                </select>
                <input
                    type="text"
                    value={customProvider}
                    onChange={(e) => setCustomProvider(e.target.value)}
                    placeholder="Or enter a provider name"
                    disabled={isPending}
                    maxLength={255}
                    className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2.5 text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-button)]"
                />
                {error ? <div className="rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">{error}</div> : null}
                <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose} disabled={isPending}>Cancel</Button><Button type="submit" disabled={isPending}>{isPending ? 'Changing…' : 'Change provider'}</Button></div>
            </form>
        </DialogContent>
    </Dialog>
}
