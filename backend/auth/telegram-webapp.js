// backend/auth/telegram-webapp.js
import crypto from 'crypto'

export function verifyInitData(initData) {
  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) return null

  params.delete('hash')
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')

  const secretKey = crypto.createHmac('sha256', 'WebAppData')
    .update(process.env.BOT_TOKEN)
    .digest()

  const expectedHash = crypto.createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex')

  if (expectedHash !== hash) return null

  const userStr = params.get('user')
  if (!userStr) return null
  return JSON.parse(userStr)
}

export function webAppAuth(req, res, next) {
  const initData = req.headers['x-telegram-init-data']
  if (!initData) return res.status(401).json({ error: 'No initData' })
  const user = verifyInitData(initData)
  if (!user) return res.status(401).json({ error: 'Invalid initData' })
  req.telegramUser = user
  next()
}
