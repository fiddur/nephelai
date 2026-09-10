import express from 'express'
import sharp from 'sharp'
import supertest from 'supertest'
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../db/index.ts', () => ({
  deleteProfileAvatar: vi.fn(),
  upsertProfileAvatar: vi.fn(),
}))

const db = await import('../db/index.ts')

const { createProfileRouter } = await import('./profile-router.ts')

const buildApp = (onAvatarChanged?: (user: string) => void) => {
  const app = express()
  const auth = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = 'tester'
    next()
  }
  app.use(
    '/profile',
    createProfileRouter(auth, 'https://aurboda.net', onAvatarChanged) as unknown as express.RequestHandler,
  )
  return app
}

const pngBuffer = () =>
  sharp({ create: { background: { b: 90, g: 150, r: 20 }, channels: 3, height: 300, width: 500 } })
    .png()
    .toBuffer()

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /profile/avatar', () => {
  test('processes and stores an uploaded image, returning the public URL', async () => {
    const res = await supertest(buildApp())
      .post('/profile/avatar')
      .attach('avatar', await pngBuffer(), { contentType: 'image/png', filename: 'a.png' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, url: 'https://aurboda.net/u/tester/avatar.png' })
    expect(db.upsertProfileAvatar).toHaveBeenCalledWith('tester', 'image/webp', expect.any(Buffer))
  })

  test('notifies onAvatarChanged after a successful upload, but not on rejection', async () => {
    const onAvatarChanged = vi.fn()
    const app = buildApp(onAvatarChanged)
    await supertest(app)
      .post('/profile/avatar')
      .attach('avatar', await pngBuffer(), { contentType: 'image/png', filename: 'a.png' })
    expect(onAvatarChanged).toHaveBeenCalledWith('tester')
    onAvatarChanged.mockClear()
    await supertest(app).post('/profile/avatar')
    expect(onAvatarChanged).not.toHaveBeenCalled()
  })

  test('rejects when no file is uploaded', async () => {
    const res = await supertest(buildApp()).post('/profile/avatar')
    expect(res.status).toBe(400)
    expect(db.upsertProfileAvatar).not.toHaveBeenCalled()
  })

  test('rejects an unsupported content type', async () => {
    const res = await supertest(buildApp())
      .post('/profile/avatar')
      .attach('avatar', Buffer.from('%PDF-'), { contentType: 'application/pdf', filename: 'a.pdf' })
    expect(res.status).toBe(400)
    expect(db.upsertProfileAvatar).not.toHaveBeenCalled()
  })

  test('rejects a corrupt image of an allowed type', async () => {
    const res = await supertest(buildApp())
      .post('/profile/avatar')
      .attach('avatar', Buffer.from('not really a png'), { contentType: 'image/png', filename: 'a.png' })
    expect(res.status).toBe(400)
    expect(db.upsertProfileAvatar).not.toHaveBeenCalled()
  })
})

describe('DELETE /profile/avatar', () => {
  test('removes the avatar and notifies onAvatarChanged', async () => {
    vi.mocked(db.deleteProfileAvatar).mockResolvedValue(true)
    const onAvatarChanged = vi.fn()
    const res = await supertest(buildApp(onAvatarChanged)).delete('/profile/avatar')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true })
    expect(db.deleteProfileAvatar).toHaveBeenCalledWith('tester')
    expect(onAvatarChanged).toHaveBeenCalledWith('tester')
  })

  test('a delete that removed nothing federates no Update{Person} (#1049)', async () => {
    // Nothing about the actor document changed, so the followers' servers have
    // nothing to re-fetch — a repeat DELETE must not fan out.
    vi.mocked(db.deleteProfileAvatar).mockResolvedValue(false)
    const onAvatarChanged = vi.fn()
    const res = await supertest(buildApp(onAvatarChanged)).delete('/profile/avatar')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true })
    expect(onAvatarChanged).not.toHaveBeenCalled()
  })
})
