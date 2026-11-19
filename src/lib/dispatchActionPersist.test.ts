import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ACCOUNT_SAVE_FAILED,
  DISPATCH_SAVED_NO_NOTIFY,
  accountSaveToast,
  dispatchActionLogLine,
  dispatchActionToast,
  resolveDispatchPersistOutcome,
} from './dispatchActionPersist.ts'
import { compactCheckHistoryRecord, prepareCheckHistoryForPersist } from './checkHistoryPersist.ts'

test('synced toast states decision is saved and no external notify', () => {
  assert.equal(dispatchActionToast('synced'), DISPATCH_SAVED_NO_NOTIFY)
  assert.match(DISPATCH_SAVED_NO_NOTIFY, /Decision saved/i)
  assert.match(DISPATCH_SAVED_NO_NOTIFY, /no external notification/i)
  assert.doesNotMatch(DISPATCH_SAVED_NO_NOTIFY, /Logged locally/i)
  assert.doesNotMatch(DISPATCH_SAVED_NO_NOTIFY, /\(demo\)/i)
})

test('failed toast admits account sync failed without local/demo wording', () => {
  assert.equal(dispatchActionToast('failed'), ACCOUNT_SAVE_FAILED)
  assert.match(ACCOUNT_SAVE_FAILED, /Couldn't save to your account/i)
  assert.doesNotMatch(ACCOUNT_SAVE_FAILED, /locally/i)
  assert.doesNotMatch(ACCOUNT_SAVE_FAILED, /demo/i)
})

test('history log lines are action labels only (no toast/status text)', () => {
  assert.equal(dispatchActionLogLine('Proceed with departure'), 'Proceed with departure')
  assert.equal(dispatchActionLogLine('Escalate'), 'Escalate')
  assert.equal(dispatchActionLogLine('  Hold departure  '), 'Hold departure')
  assert.doesNotMatch(dispatchActionLogLine('On-site check'), /Decision saved|Couldn't save|notification/i)
})

test('resolveDispatchPersistOutcome treats pending or error as failed', () => {
  assert.equal(resolveDispatchPersistOutcome({ saveStatus: 'ok', hasPending: false }), 'synced')
  assert.equal(resolveDispatchPersistOutcome({ saveStatus: 'ok', hasPending: true }), 'failed')
  assert.equal(resolveDispatchPersistOutcome({ saveStatus: 'pending', hasPending: true }), 'failed')
  assert.equal(resolveDispatchPersistOutcome({ saveStatus: 'error', hasPending: false }), 'failed')
})

test('accountSaveToast only claims Saved after success', () => {
  assert.equal(accountSaveToast(true, 'Job saved and monitoring started.'), 'Job saved and monitoring started.')
  assert.equal(accountSaveToast(false, 'Job saved and monitoring started.'), ACCOUNT_SAVE_FAILED)
})

test('saved toast never uses Logged locally / demo wording', () => {
  assert.doesNotMatch(DISPATCH_SAVED_NO_NOTIFY, /local/i)
  assert.doesNotMatch(ACCOUNT_SAVE_FAILED, /demo/i)
})

test('actionsLog survives check-history compact + prepare for /api/state', () => {
  const line = dispatchActionLogLine('Hold departure')
  const record = {
    id: 'check-1',
    permitName: 'Ana demo permit',
    routeLabel: 'A7',
    runAt: '2026-11-18T12:00:00.000Z',
    verdict: 'HOLD' as const,
    evidenceCount: 1,
    retrievedAt: '2026-11-18T12:00:00.000Z',
    source: 'test',
    summary: 'closure',
    evidence: [{ id: 'ev-1', title: 'drop me', detail: 'geometry' }],
    actionsLog: [line],
  }
  const compact = compactCheckHistoryRecord(record)
  assert.deepEqual(compact.actionsLog, [line])
  assert.equal('evidence' in compact && compact.evidence !== undefined, false)

  const prepared = prepareCheckHistoryForPersist([record], { userId: 'anna' })
  assert.equal(prepared.length, 1)
  assert.deepEqual(prepared[0]?.actionsLog, [line])
})
