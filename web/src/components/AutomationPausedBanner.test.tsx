import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { AutomationPausedBanner } from './AutomationPausedBanner'

afterEach(() => {
    cleanup()
    window.localStorage.clear()
})

describe('AutomationPausedBanner', () => {
    it('states that automation is paused while direct chat still works', () => {
        render(
            <I18nProvider>
                <AutomationPausedBanner onResume={() => {}} />
            </I18nProvider>
        )

        expect(screen.getByTestId('automation-paused-banner')).toBeInTheDocument()
        expect(screen.getByText(/automation tasks are paused/i)).toBeInTheDocument()
        // The key user contract: the human can still chat directly.
        expect(screen.getByText(/you can still chat directly/i)).toBeInTheDocument()
    })

    it('fires the resume handler when the Resume button is clicked', () => {
        const onResume = vi.fn()
        render(
            <I18nProvider>
                <AutomationPausedBanner onResume={onResume} />
            </I18nProvider>
        )

        fireEvent.click(screen.getByRole('button', { name: /resume automation/i }))
        expect(onResume).toHaveBeenCalledOnce()
    })

    it('disables the resume button while a resume request is pending', () => {
        render(
            <I18nProvider>
                <AutomationPausedBanner onResume={() => {}} isPending={true} />
            </I18nProvider>
        )

        expect(screen.getByRole('button', { name: /resume automation/i })).toBeDisabled()
    })
})
