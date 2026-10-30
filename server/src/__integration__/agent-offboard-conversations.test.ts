/**
 * Off-boarding an agent must also take it out of every conversation.
 *
 * Membership lives in its own normalized table, not on the participant row, so
 * a participant update alone leaves every group roster untouched.
 */
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import {
  buildApiTestApp, ensureSchemaOnce, resetAllTables, seedUserMembership, teardownAll,
} from './_helpers.js'
import { pool } from '../db/pool.js'

const OWNER = 'human-offboard-owner'
const AGENT = 'agent-offboard-target'
const PEER = 'agent-offboard-peer'
const COMPANY = 'c-offboard-conv'

let server: Server
let baseUrl = ''

before(async () => {
  await ensureSchemaOnce()
  const app = await buildApiTestApp(OWNER)
  await new Promise<void>((resolve) => {
    server = createServer(app).listen(0, () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
})

beforeEach(async () => {
  await resetAllTables()
})

after(async () => {
  await teardownAll(server)
})

async function seed(): Promise<{ groupId: string; dmId: string }> {
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id) VALUES ($1, 'Offboard Co', 'offboard-co', $2)`,
    [COMPANY, OWNER],
  )
  await seedUserMembership(OWNER, COMPANY, { displayName: 'Owner' })
  for (const [id, name] of [[AGENT, 'Target'], [PEER, 'Peer']] as const) {
    await pool.query(
      `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status)
       VALUES ($1, $2, 'agent', $3, 'tester', $4, '#abcdef', 'avail')`,
      [id, COMPANY, name, name.slice(0, 1)],
    )
  }
  const groupId = 'conv-offboard-group'
  const dmId = 'conv-offboard-dm'
  await pool.query(
    `INSERT INTO conversations (id, kind, title, members, company_id)
     VALUES ($1, 'group', 'Squad', $2::jsonb, $3)`,
    [groupId, JSON.stringify([OWNER, AGENT, PEER]), COMPANY],
  )
  await pool.query(
    `INSERT INTO conversations (id, kind, title, members, company_id)
     VALUES ($1, 'direct', 'Target', $2::jsonb, $3)`,
    [dmId, JSON.stringify([OWNER, AGENT]), COMPANY],
  )
  return { groupId, dmId }
}

async function membersOf(conversationId: string): Promise<string[]> {
  const { rows } = await pool.query<{ participant_id: string }>(
    `SELECT participant_id FROM conversation_members WHERE conversation_id = $1 ORDER BY ordinal`,
    [conversationId],
  )
  return rows.map((row) => row.participant_id)
}

async function offboard(): Promise<Response> {
  return await fetch(`${baseUrl}/api/agents/${AGENT}`, {
    method: 'DELETE',
    headers: { 'x-company-id': COMPANY },
  })
}

test('[integration] off-board removes the agent from every group conversation', async () => {
  const { groupId } = await seed()
  assert.deepEqual(await membersOf(groupId), [OWNER, AGENT, PEER])

  const res = await offboard()
  assert.equal(res.status, 200, await res.text())

  assert.deepEqual(await membersOf(groupId), [OWNER, PEER], 'off-boarded agent stayed in the group roster')
})

test('[integration] off-board keeps the direct-chat row so a rehire resumes it', async () => {
  const { dmId } = await seed()

  const res = await offboard()
  assert.equal(res.status, 200, await res.text())

  // The human workspace-removal path deliberately preserves direct memberships
  // (server/src/api/router.ts, `AND c.kind <> 'direct'`) so a returning member
  // lands back in the same thread. Off-board follows the same rule.
  assert.deepEqual(await membersOf(dmId), [OWNER, AGENT], 'direct membership must survive for a rehire')
})

test('[integration] off-board leaves the participant row and its history intact', async () => {
  const { groupId } = await seed()

  const res = await offboard()
  assert.equal(res.status, 200, await res.text())

  const { rows } = await pool.query<{ departed_at: Date | null; status: string }>(
    `SELECT departed_at, status FROM participants WHERE id = $1 AND company_id = $2`,
    [AGENT, COMPANY],
  )
  assert.ok(rows[0]?.departed_at, 'participant row must survive as a departed row')
  assert.equal(rows[0]?.status, 'resting')

  const { rows: convo } = await pool.query<{ members: string[] }>(
    `SELECT members FROM conversations WHERE id = $1`,
    [groupId],
  )
  assert.deepEqual(convo[0]?.members, [OWNER, PEER], 'jsonb projection drifted from conversation_members')
})

test('[integration] off-boarded agent no longer appears in group member counts', async () => {
  const { groupId } = await seed()

  const res = await offboard()
  assert.equal(res.status, 200, await res.text())

  const listRes = await fetch(`${baseUrl}/api/conversations`, { headers: { 'x-company-id': COMPANY } })
  assert.equal(listRes.status, 200)
  const rows = await listRes.json() as Array<{ id: string; members: string[] }>
  const group = rows.find((row) => row.id === groupId)
  assert.deepEqual(group?.members, [OWNER, PEER], 'sidebar still counts the off-boarded agent')
})

test('[integration] the direct chat leaves the sidebar while the agent is off-boarded', async () => {
  const { dmId } = await seed()

  const res = await offboard()
  assert.equal(res.status, 200, await res.text())

  const listRes = await fetch(`${baseUrl}/api/conversations`, { headers: { 'x-company-id': COMPANY } })
  assert.equal(listRes.status, 200)
  const rows = await listRes.json() as Array<{ id: string }>
  assert.equal(
    rows.some((row) => row.id === dmId), false,
    'a DM whose other member was off-boarded must not sit in the sidebar as a dead row',
  )
})

test('[integration] rehiring brings the same direct chat back', async () => {
  const { dmId } = await seed()
  await offboard()

  const res = await fetch(`${baseUrl}/api/agents/${AGENT}/rehire`, {
    method: 'POST',
    headers: { 'x-company-id': COMPANY },
  })
  assert.equal(res.status, 200, await res.text())

  const listRes = await fetch(`${baseUrl}/api/conversations`, { headers: { 'x-company-id': COMPANY } })
  const rows = await listRes.json() as Array<{ id: string }>
  assert.equal(
    rows.some((row) => row.id === dmId), true,
    'the preserved direct membership should put the same thread back in the sidebar',
  )
})

test('[integration] off-board and rehire both announce the roster change', async () => {
  await seed()

  await offboard()
  const { rows: departed } = await pool.query<{ payload: { type: string; kind: string } }>(
    `SELECT payload FROM realtime_outbox WHERE payload->>'type' = 'participants.roster_changed'`,
  )
  assert.deepEqual(departed.map((row) => row.payload.kind), ['departed'],
    'nothing told connected clients the roster changed')

  const res = await fetch(`${baseUrl}/api/agents/${AGENT}/rehire`, {
    method: 'POST',
    headers: { 'x-company-id': COMPANY },
  })
  assert.equal(res.status, 200, await res.text())

  const { rows: after } = await pool.query<{ payload: { kind: string } }>(
    `SELECT payload FROM realtime_outbox
      WHERE payload->>'type' = 'participants.roster_changed' ORDER BY created_at`,
  )
  assert.deepEqual(after.map((row) => row.payload.kind), ['departed', 'rehired'],
    'a rehire that does not announce itself leaves the sidebar hiding the restored thread')
})
