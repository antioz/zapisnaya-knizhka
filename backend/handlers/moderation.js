import { setUserPaused, setUserBanned } from '../db.js'

const rateMap = new Map()

const OWNER_ID = process.env.OWNER_TELEGRAM_ID

function getRateData(telegramId) {
  if (!rateMap.has(telegramId)) {
    rateMap.set(telegramId, { minute: [], hour: [] })
  }
  return rateMap.get(telegramId)
}

export function checkRateLimit(telegramId) {
  const now = Date.now()
  const data = getRateData(telegramId)

  data.minute = data.minute.filter(t => now - t < 60_000)
  data.hour = data.hour.filter(t => now - t < 3_600_000)

  data.minute.push(now)
  data.hour.push(now)

  if (data.minute.length > 15) return { blocked: true, reason: `флуд — ${data.minute.length} сообщений за минуту` }
  if (data.hour.length > 100) return { blocked: true, reason: `превышен лимит — ${data.hour.length} сообщений за час` }

  return { blocked: false }
}

export async function handleViolation(bot, telegramId, username, reason) {
  await setUserPaused(String(telegramId), true)

  const userLabel = username ? `@${username}` : `ID: ${telegramId}`

  await bot.telegram.sendMessage(OWNER_ID,
    `⚠️ Подозрительная активность\n${userLabel} · ID: ${telegramId}\nПричина: ${reason}`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '▶️ Снять паузу', callback_data: `unpause:${telegramId}` },
          { text: '🚫 Забанить', callback_data: `ban:${telegramId}` }
        ]]
      }
    }
  )
}

export function setupModerationCallbacks(bot) {
  bot.action(/^unpause:(\d+)$/, async (ctx) => {
    const telegramId = ctx.match[1]
    await setUserPaused(telegramId, false)
    await ctx.editMessageText(`✅ Пауза снята с ID: ${telegramId}`)
  })

  bot.action(/^ban:(\d+)$/, async (ctx) => {
    const telegramId = ctx.match[1]
    await setUserBanned(telegramId)
    await ctx.editMessageText(`🚫 Пользователь ID: ${telegramId} заблокирован`)
  })
}
