import fetch from 'node-fetch'
import { encrypt, decrypt } from '../crypto.js'
import { upsertUser } from '../db.js'

const TOKEN_URL = 'https://oauth.yandex.ru/token'

export function getAuthUrl(telegramId) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.YANDEX_CLIENT_ID,
    redirect_uri: process.env.YANDEX_REDIRECT_URI,
    state: String(telegramId),
    force_confirm: 'yes'
  })
  return `https://oauth.yandex.ru/authorize?${params}`
}

export async function handleCallback(code, telegramId) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.YANDEX_CLIENT_ID,
      client_secret: process.env.YANDEX_CLIENT_SECRET,
      redirect_uri: process.env.YANDEX_REDIRECT_URI
    })
  })
  const tokens = await res.json()
  if (tokens.error) throw new Error(tokens.error_description)
  const encryptedToken = encrypt(JSON.stringify(tokens))
  return await upsertUser(telegramId, {
    drive_provider: 'yandex',
    encrypted_token: encryptedToken
  })
}

export function getToken(encryptedToken) {
  return JSON.parse(decrypt(encryptedToken))
}
