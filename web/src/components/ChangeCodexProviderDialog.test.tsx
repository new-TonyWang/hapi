import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { ChangeCodexProviderDialog } from './ChangeCodexProviderDialog'

function renderDialog(props: Partial<Parameters<typeof ChangeCodexProviderDialog>[0]> = {}) {
    const onClose = vi.fn()
    const onChange = vi.fn(async () => {})
    const view = render(
        <I18nProvider>
            <ChangeCodexProviderDialog
                isOpen={true}
                onClose={onClose}
                currentProvider={null}
                providers={[]}
                onChange={onChange}
                isPending={false}
                {...props}
            />
        </I18nProvider>
    )
    return { ...view, onClose, onChange }
}

describe('ChangeCodexProviderDialog', () => {
    afterEach(() => {
        cleanup()
        window.localStorage.clear()
    })

    it('renders the restart notice and default option', () => {
        renderDialog()

        // The user must be told the session stops and re-opens.
        expect(screen.getByText(/stop and re-open/i)).toBeInTheDocument()
        const select = screen.getByLabelText('Provider')
        expect(select).toBeInTheDocument()
        expect((select as HTMLSelectElement).value).toBe('')
        expect(screen.getByRole('option', { name: /default provider/i })).toBeInTheDocument()
    })

    it('lists discovered providers and marks the current one selected', () => {
        renderDialog({
            currentProvider: 'custom-proxy',
            providers: ['openai', 'custom-proxy', 'zhipu']
        })

        const select = screen.getByLabelText('Provider') as HTMLSelectElement
        expect(select.value).toBe('custom-proxy')
        const optionValues = Array.from(select.options).map((option) => option.value)
        expect(optionValues).toEqual(['', 'custom-proxy', 'openai', 'zhipu'])
    })

    it('submits the selected provider and closes on success', async () => {
        const { onChange, onClose } = renderDialog({
            currentProvider: 'openai',
            providers: ['openai', 'custom-proxy']
        })

        fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'custom-proxy' } })
        fireEvent.click(screen.getByRole('button', { name: /change provider/i }))

        await waitFor(() => expect(onChange).toHaveBeenCalledWith('custom-proxy'))
        await waitFor(() => expect(onClose).toHaveBeenCalled())
    })

    it('submits null (default) when the selection is empty', async () => {
        const { onChange } = renderDialog({
            currentProvider: 'openai',
            providers: ['openai']
        })

        fireEvent.change(screen.getByLabelText('Provider'), { target: { value: '' } })
        fireEvent.click(screen.getByRole('button', { name: /change provider/i }))

        // Empty selection restores the default provider.
        await waitFor(() => expect(onChange).toHaveBeenCalledWith(null))
    })

    it('the custom input overrides the select value', async () => {
        const { onChange } = renderDialog({
            currentProvider: 'openai',
            providers: ['openai']
        })

        fireEvent.change(screen.getByPlaceholderText(/enter a provider name/i), { target: { value: 'my-proxy' } })
        fireEvent.click(screen.getByRole('button', { name: /change provider/i }))

        await waitFor(() => expect(onChange).toHaveBeenCalledWith('my-proxy'))
    })

    it('shows the real error and stays open when the change fails', async () => {
        const onChange = vi.fn(async () => { throw new Error('hub exploded') })
        const onClose = vi.fn()
        render(
            <I18nProvider>
                <ChangeCodexProviderDialog
                    isOpen={true}
                    onClose={onClose}
                    currentProvider={null}
                    providers={[]}
                    onChange={onChange}
                    isPending={false}
                />
            </I18nProvider>
        )

        fireEvent.click(screen.getByRole('button', { name: /change provider/i }))

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('hub exploded'))
        expect(onClose).not.toHaveBeenCalled()
    })

    it('disables inputs while pending', () => {
        renderDialog({ isPending: true })

        expect(screen.getByLabelText('Provider')).toBeDisabled()
        expect(screen.getByPlaceholderText(/enter a provider name/i)).toBeDisabled()
        expect(screen.getByRole('button', { name: /changing…/i })).toBeDisabled()
    })
})
