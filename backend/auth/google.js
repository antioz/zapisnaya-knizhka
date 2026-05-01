import { google } from 'googleapis'
import { encrypt, decrypt } from '../crypto.js'
import { upsertUser } from '../db.js'

function getClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  )
}

export function getAuthUrl(telegramId) {
  const client = getClient()
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/drive.file'],
    state: String(telegramId)
  })
}

export async function handleCallback(code, telegramId) {
  const client = getClient()
  const { tokens } = await client.getToken(code)
  const encryptedToken = encrypt(JSON.stringify(tokens))
  return await upsertUser(telegramId, {
    drive_provider: 'google',
    encrypted_token: encryptedToken
  })
}

export function getAuthorizedClient(encryptedToken, telegramId = null) {
  const client = getClient()
  const tokens = JSON.parse(decrypt(encryptedToken))
  client.setCredentials(tokens)
  if (telegramId) {
    client.on('tokens', (newTokens) => {
      const merged = { ...tokens, ...newTokens }
      upsertUser(String(telegramId), { encrypted_token: encrypt(JSON.stringify(merged)) }).catch(console.error)
    })
  }
  return client
}
