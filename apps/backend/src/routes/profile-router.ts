/**
 * Profile route group (owner-facing).
 *
 * Handles: /profile/*
 *
 * POST   /profile/avatar — upload/replace the profile avatar (authenticated)
 * DELETE /profile/avatar — remove it, reverting to the generated identicon
 *
 * The public read side lives in public-avatar-router (`/u/:username/avatar.png`).
 */
import type { RequestHandler } from 'express'

import multer from 'multer'

import { deleteProfileAvatar, upsertProfileAvatar } from '../db/index.ts'
import { isAllowedAvatarType, processAvatar } from '../services/avatar.ts'
import { buildProfileUrl } from '../services/share-urls.ts'
import { type TypedRouter, typedRouter } from '../typed-router.ts'

const upload = multer({
  limits: { fileSize: 10 * 1024 * 1024 },
  storage: multer.memoryStorage(),
})

export const createProfileRouter = (
  authMiddleware: RequestHandler,
  webHost: string,
  /**
   * Fire-and-forget: called after the avatar is uploaded/replaced/removed, so
   * federation can deliver an `Update{Person}` to followers (remote servers
   * cache the old avatar until told otherwise).
   */
  onAvatarChanged?: (user: string) => void,
): TypedRouter => {
  const router = typedRouter()

  router.post<Record<string, never>, { success: boolean; url?: string; error?: string }>(
    '/avatar',
    authMiddleware,
    upload.single('avatar'),
    async (req, res) => {
      const user = req.user!
      const file = req.file
      if (!file) {
        res.status(400).json({ error: 'No file uploaded', success: false })
        return
      }
      if (!isAllowedAvatarType(file.mimetype)) {
        res.status(400).json({
          error: `Unsupported file type: ${file.mimetype}. Allowed: PNG, JPEG, WebP, GIF`,
          success: false,
        })
        return
      }

      let processed
      try {
        processed = await processAvatar(file.buffer)
      } catch {
        res.status(400).json({ error: 'Could not process image', success: false })
        return
      }

      await upsertProfileAvatar(user, processed.content_type, processed.data)
      onAvatarChanged?.(user)
      res.json({ success: true, url: `${buildProfileUrl(webHost, user)}/avatar.png` })
    },
  )

  router.delete<Record<string, never>, { success: boolean }>('/avatar', authMiddleware, async (req, res) => {
    // Only a delete that removed something changes the actor document, so a
    // repeat DELETE doesn't fan an `Update{Person}` out to every follower.
    if (await deleteProfileAvatar(req.user!)) onAvatarChanged?.(req.user!)
    res.json({ success: true })
  })

  return router
}
