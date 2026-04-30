import 'dotenv/config'
import { Telegraf } from 'telegraf'
import express from 'express'
import { handleMessage } from './handlers/message.js'
import { setupModerationCallbacks } from './handlers/moderation.js'
import { getAuthUrl as getGoogleAuthUrl, handleCallback as handleGoogleCallback } from './auth/google.js'
import { getAuthUrl as getYandexAuthUrl, handleCallback as handleYandexCallback } from './auth/yandex.js'
import { initUserFile as initGoogleFile, getFileUrl as getGoogleFileUrl } from './drive/google.js'
import { initUserFile as initYandexFile, getFileUrl as getYandexFileUrl } from './drive/yandex.js'
import { getUser, upsertUser } from './db.js'

const bot = new Telegraf(process.env.BOT_TOKEN)
const app = express()
app.use(express.json())

const MENU = {
  reply_markup: {
    keyboard: [
      ['📁 Моя книжка', 'Спасибо'],
      ['Канал', '⚙️ Настройки']
    ],
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

// /start command
bot.start(async (ctx) => {
  const user = await getUser(ctx.from.id)
  if (user?.encrypted_token) {
    return ctx.reply('Кидай что хочешь сохранить — или напиши что найти.')
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
bot.hears('📁 Моя книжка', async (ctx) => {
  const user = await getUser(ctx.from.id)
  if (!user?.drive_file_id) return ctx.reply('Сначала подключи хранилище')
  const url = user.drive_provider === 'yandex'
    ? getYandexFileUrl()
    : getGoogleFileUrl(user.drive_file_id)
  await ctx.reply(`Твоя записная книжка:\n${url}`)
})

bot.hears('Спасибо', (ctx) => ctx.reply('Спасибо! ☕', {
  reply_markup: {
    inline_keyboard: [[{ text: 'Спасибо', url: 'https://tbank.ru/cf/5FJG7hrT28' }]]
  }
}))
bot.hears('Канал', (ctx) => ctx.reply('Подписывайся 👇', {
  reply_markup: {
    inline_keyboard: [[{ text: '@webthreesome', url: 'https://t.me/webthreesome' }]]
  }
}))
bot.hears('⚙️ Настройки', async (ctx) => {
  await ctx.reply('Настройки:', {
    reply_markup: {
      inline_keyboard: [[
        { text: '🔄 Сменить хранилище', callback_data: 'settings:reset' }
      ]]
    }
  })
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
