/**
 * Profile avatar storage (per-user singleton row).
 *
 * The image bytes live in the user's own database because the deployment has
 * no persistent object store or app-container volume — only Postgres persists.
 */
import { query } from './connection.ts'

export interface ProfileAvatar {
  content_type: string
  data: Buffer
  updated_at: Date
}

export const getProfileAvatar = async (user: string): Promise<ProfileAvatar | undefined> => {
  const result = await query(
    user,
    `SELECT content_type, data, updated_at FROM profile_avatar WHERE singleton`,
  )
  if (result.rows.length === 0) return undefined
  return {
    content_type: result.rows[0].content_type as string,
    data: result.rows[0].data as Buffer,
    updated_at: result.rows[0].updated_at as Date,
  }
}

/**
 * The avatar's last-modified time WITHOUT loading the image bytes — it versions
 * the actor document's icon URL, and runs on every actor fetch. `undefined` = no
 * uploaded avatar (the identicon fallback).
 */
export const getProfileAvatarVersion = async (user: string): Promise<Date | undefined> => {
  const result = await query(user, `SELECT updated_at FROM profile_avatar WHERE singleton`)
  if (result.rows.length === 0) return undefined
  return result.rows[0].updated_at as Date
}

export const upsertProfileAvatar = async (user: string, contentType: string, data: Buffer): Promise<void> => {
  await query(
    user,
    `INSERT INTO profile_avatar (singleton, content_type, data, updated_at)
     VALUES (true, $1, $2, NOW())
     ON CONFLICT (singleton)
     DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, updated_at = NOW()`,
    [contentType, data],
  )
}

export const deleteProfileAvatar = async (user: string): Promise<boolean> => {
  const result = await query(user, `DELETE FROM profile_avatar WHERE singleton`)
  return (result.rowCount ?? 0) > 0
}
