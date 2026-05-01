import 'dotenv/config'
import { Telegraf } from 'telegraf'
import express from 'express'
import { handleMessage, setupSaveCallbacks } from './handlers/message.js'
import { setupModerationCallbacks } from './handlers/moderation.js'
import { getAuthUrl as getGoogleAuthUrl, handleCallback as handleGoogleCallback } from './auth/google.js'
import { getAuthUrl as getYandexAuthUrl, handleCallback as handleYandexCallback } from './auth/yandex.js'
import { initUserFile as initGoogleFile, getFileUrl as getGoogleFileUrl } from './drive/google.js'
import { initUserFile as initYandexFile, getFileUrl as getYandexFileUrl } from './drive/yandex.js'
import { getUser, upsertUser } from './db.js'
import { webAppAuth } from './auth/telegram-webapp.js'
import path from 'path'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
import * as googleDrive from './drive/google.js'
import * as yandexDrive from './drive/yandex.js'

function getDriveForUser(user) {
  return user.drive_provider === 'yandex' ? yandexDrive : googleDrive
}

const bot = new Telegraf(process.env.BOT_TOKEN)
const app = express()
app.use(express.json())

export const MENU = {
  reply_markup: {
    keyboard: [[
      { text: '📁 Записи', web_app: { url: 'https://zapisnaya-knizhka.onrender.com/app' } },
      { text: '⚙️ Настройки' }
    ]],
    resize_keyboard: true
  }
}

// connect drive buttons
bot.action('connect:google', async (ctx) => {
  const url = getGoogleAuthUrl(ctx.from.id)
  await ctx.answerCbQuery()
  await ctx.reply('Нажми кнопку для подключения Google Drive:', {
    reply_markup: {
      inline_keyboard: [[{ text: 'Подключить Google Drive →', url }]]
    }
  })
})

bot.action('connect:yandex', async (ctx) => {
  const url = getYandexAuthUrl(ctx.from.id)
  await ctx.answerCbQuery()
  await ctx.reply('Нажми кнопку для подключения Яндекс Диска:', {
    reply_markup: {
      inline_keyboard: [[{ text: 'Подключить Яндекс Диск →', url }]]
    }
  })
})

setupModerationCallbacks(bot)
setupSaveCallbacks(bot)

// /start command
bot.start(async (ctx) => {
  const user = await getUser(ctx.from.id)
  if (user?.encrypted_token) {
    return ctx.reply('Кидай что хочешь сохранить — или напиши что найти.', MENU)
  }
  return ctx.reply(
    'Привет. Я чуть умней записной книжки. Помогаю хранить записи и находить их по запросам. Например, сохраняй прилетающие контакты, а когда нужно будет найти что-то по теме, просто напиши мне: «трактор Клин» или «лучшая шаурма на Рязанском проспекте», чем ты там ещё увлекаешься. Ни к каким твоим данным доступа не имею. Но всё равно совет: не надо хранить чувствительную информацию в интернете.',
    {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Google Drive', callback_data: 'connect:google' },
          { text: 'Яндекс Диск', callback_data: 'connect:yandex' }
        ]]
      }
    }
  )
})

// menu buttons
bot.hears('⚙️ Настройки', async (ctx) => {
  const user = await getUser(ctx.from.id)
  const driveUrl = user?.drive_file_id
    ? (user.drive_provider === 'yandex' ? getYandexFileUrl() : getGoogleFileUrl(user.drive_file_id))
    : null
  await ctx.reply(
    'Настройки и команды:\n\n' +
    '• *удали все* — удалить все записи\n' +
    '• *удали 3* — удалить запись из последнего списка\n' +
    '• *найди похожее* — найти дубликаты\n\n' +
    'Можно сменить хранилище, но базы тоже будут разные.\n\n' +
    'Скажи спасибо звонкой монетой — [тык](https://tbank.ru/cf/5FJG7hrT28)\n' +
    'Подписывайся на канал — [\\@webthreesome](https://t.me/webthreesome)' +
    (driveUrl ? `\n\n[Открыть файл в Drive](${driveUrl})` : ''),
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🔄 Сменить хранилище', callback_data: 'settings:reset' }
        ]]
      }
    }
  )
})

bot.action('settings:reset', async (ctx) => {
  await upsertUser(ctx.from.id, { encrypted_token: null, drive_file_id: null, drive_folder_id: null, drive_provider: null })
  await ctx.answerCbQuery()
  await ctx.reply('Хранилище отключено. Выбери новое:', {
    reply_markup: {
      inline_keyboard: [[
        { text: 'Google Drive', callback_data: 'connect:google' },
        { text: 'Яндекс Диск', callback_data: 'connect:yandex' }
      ]]
    }
  })
})

// all other messages
bot.on('message', (ctx) => handleMessage(ctx, bot))

// OAuth callbacks
app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, state: telegramId } = req.query
    await handleGoogleCallback(code, telegramId)
    const fileId = await initGoogleFile(telegramId, (await getUser(telegramId)).encrypted_token)
    await bot.telegram.sendMessage(telegramId,
      '✅ Google Drive подключён! Папка MyData создана.\n\nТеперь просто кидай что хочешь сохранить.',
      MENU
    )
    res.send('<h2>✅ Готово! Возвращайся в Telegram.</h2>')
  } catch (e) {
    console.error(e)
    res.status(500).send('Ошибка подключения. Попробуй ещё раз.')
  }
})

app.get('/auth/yandex/callback', async (req, res) => {
  try {
    const { code, state: telegramId } = req.query
    await handleYandexCallback(code, telegramId)
    await initYandexFile(telegramId, (await getUser(telegramId)).encrypted_token)
    await bot.telegram.sendMessage(telegramId,
      '✅ Яндекс Диск подключён! Папка MyData создана.\n\nТеперь просто кидай что хочешь сохранить.',
      MENU
    )
    res.send('<h2>✅ Готово! Возвращайся в Telegram.</h2>')
  } catch (e) {
    console.error(e)
    res.status(500).send('Ошибка подключения. Попробуй ещё раз.')
  }
})

// serve Mini App
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'webapp', 'index.html'))
})

// Mini App API
app.get('/api/records', webAppAuth, async (req, res) => {
  try {
    const user = await getUser(String(req.telegramUser.id))
    if (!user?.encrypted_token) return res.json({ records: [] })
    const db = await getDriveForUser(user).readJson(user.encrypted_token, user.drive_file_id)
    res.json({ records: db.records || [] })
  } catch (e) {
    console.error('GET /api/records', e)
    res.status(500).json({ error: 'Failed to load' })
  }
})

app.patch('/api/records/:id', webAppAuth, async (req, res) => {
  try {
    const user = await getUser(String(req.telegramUser.id))
    if (!user?.encrypted_token) return res.status(404).json({ error: 'No storage' })
    const db = await getDriveForUser(user).readJson(user.encrypted_token, user.drive_file_id)
    const idx = db.records.findIndex(r => r.id === req.params.id)
    if (idx === -1) return res.status(404).json({ error: 'Not found' })
    const { data, comment } = req.body
    if (data !== undefined) db.records[idx].data = data
    if (comment !== undefined) db.records[idx].comment = comment
    await getDriveForUser(user).writeJson(user.encrypted_token, user.drive_file_id, db)
    res.json({ record: db.records[idx] })
  } catch (e) {
    console.error('PATCH /api/records', e)
    res.status(500).json({ error: 'Failed to save' })
  }
})

app.delete('/api/records/:id', webAppAuth, async (req, res) => {
  try {
    const user = await getUser(String(req.telegramUser.id))
    if (!user?.encrypted_token) return res.status(404).json({ error: 'No storage' })
    const db = await getDriveForUser(user).readJson(user.encrypted_token, user.drive_file_id)
    const before = db.records.length
    db.records = db.records.filter(r => r.id !== req.params.id)
    if (db.records.length === before) return res.status(404).json({ error: 'Not found' })
    await getDriveForUser(user).writeJson(user.encrypted_token, user.drive_file_id, db)
    res.json({ ok: true })
  } catch (e) {
    console.error('DELETE /api/records', e)
    res.status(500).json({ error: 'Failed to delete' })
  }
})

// webhook
const PORT = process.env.PORT || 3000
app.use(bot.webhookCallback('/webhook'))

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`)
  if (process.env.WEBHOOK_URL) {
    await bot.telegram.setWebhook(`${process.env.WEBHOOK_URL}/webhook`)
    console.log('Webhook set')
  }
})
