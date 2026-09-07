import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { buildNestedSessionChildren, nestSessionGroups } from './SessionList'

function session(id: string, parentSessionId?: string): SessionSummary {
    return { id, parentSessionId, active: true, updatedAt: 1 } as unknown as SessionSummary
}

describe('buildNestedSessionChildren', () => {
    it('groups known children under their parent and keeps orphaned children at the root', () => {
        const tree = buildNestedSessionChildren([
            session('parent'),
            session('child', 'parent'),
            session('orphan', 'missing'),
        ])

        expect(tree.get(null)?.map(item => item.id)).toEqual(['parent', 'orphan'])
        expect(tree.get('parent')?.map(item => item.id)).toEqual(['child'])
    })
})

it('assigns cross-directory descendants to the ancestor group', () => {
    const groups = [
        { key: 'a', directory: 'a', displayName: 'a', machineId: null, sessions: [session('parent')], latestUpdatedAt: 1, hasActiveSession: true, hasPinnedSession: false },
        { key: 'b', directory: 'b', displayName: 'b', machineId: null, sessions: [session('child', 'parent')], latestUpdatedAt: 1, hasActiveSession: true, hasPinnedSession: false },
    ]
    const nested = nestSessionGroups(groups)
    expect(nested[0].sessions.map(item => item.id)).toEqual(['parent', 'child'])
    expect(nested[1].sessions).toEqual([])
})
