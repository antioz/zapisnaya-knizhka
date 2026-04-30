import { v4 as uuidv4 } from 'uuid'
import { classify, structure, search, editRecord, checkContentSafety } from '../ai.js'
import { checkLimits } from './limits.js'
import { extractForwardMeta } from './forward.js'
import { checkRateLimit, handleViolation } from './moderation.js'
import * as googleDrive from '../drive/google.js'
import * as yandexDrive from '../drive/yandex.js'
import { getUser } from '../db.js'

// session cache for drill-down search results
const searchCache = new Map()

function getDrive(provider) {
  return provider === 'yandex' ? yandexDrive : googleDrive
}

async function readUserJson(user) {
  const drive = getDrive(user.drive_provider)
  return await drive.readJson(user.encrypted_token, user.drive_file_id)
}

async function writeUserJson(user, data) {
  const drive = getDrive(user.drive_provider)
  await drive.writeJson(user.encrypted_token, user.drive_file_id, data)
}

async function getPhotoBase64(ctx, photo) {
  const file = await ctx.telegram.getFile(photo.file_id)
  const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`
  const res = await fetch(url)
  const buf = await res.arrayBuffer()
  return Buffer.from(buf).toString('base64')
}

export async function handleMessage(ctx, bot) {
  try {
    return await _handleMessage(ctx, bot)
  } catch (e) {
    console.error('handleMessage error:', e)
    await ctx.reply('Что-то пошло не так. Попробуй ещё раз.')
  }
}

async function _handleMessage(ctx, bot) {
  const telegramId = ctx.from.id
  const username = ctx.from.username

  // rate limit check
  const rate = checkRateLimit(telegramId)
  if (rate.blocked) {
    await handleViolation(bot, telegramId, username, rate.reason)
    return ctx.reply('Бот временно недоступен для тебя. Если это ошибка — напиши @antiosina')
  }

  const user = await getUser(telegramId)

  // not connected yet — onboarding
  if (!user || !user.encrypted_token) {
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
  }

  if (user.is_banned) return
  if (user.is_paused) return ctx.reply('Бот временно недоступен для тебя. Если это ошибка — напиши @antiosina')

  const msg = ctx.message
  const limits = checkLimits(ctx)

  if (limits.blocked) return ctx.reply(limits.reply)

  const comment = msg.caption || ''
  const forwardMeta = extractForwardMeta(msg)

  // drill-down: user replies with number or name to previous search
  if (limits.type === 'text') {
    const cached = searchCache.get(telegramId)
    if (cached && /^\d+$/.test(limits.text.trim())) {
      const idx = parseInt(limits.text.trim()) - 1
      if (cached[idx]) return sendCard(ctx, cached[idx])
    }
    if (cached) {
      const match = cached.find(r =>
        r.data && Object.values(r.data).some(v =>
          String(v).toLowerCase().includes(limits.text.toLowerCase())
        )
      )
      if (match) return sendCard(ctx, match)
    }
  }

  // content safety
  const rawText = limits.text || comment || ''
  if (rawText) {
    const safety = await checkContentSafety(rawText)
    if (safety === 'UNSAFE') {
      await handleViolation(bot, telegramId, username, 'подозрительный контент')
      return ctx.reply('Бот временно недоступен для тебя. Если это ошибка — напиши @antiosina')
    }
  }

  // classify: SAVE or SEARCH
  const textForClassify = limits.text || comment
  if (!textForClassify && limits.type !== 'photo') return

  const mode = limits.type === 'photo' ? 'SAVE' : await classify(textForClassify)

  if (mode === 'EDIT') {
    const lastSaved = searchCache.get(`last_saved_${telegramId}`)
    if (!lastSaved) return ctx.reply('Не помню последнюю запись. Найди её через поиск и уточни что исправить.')
    const db = await readUserJson(user)
    const idx = db.records.findIndex(r => r.id === lastSaved.id)
    if (idx === -1) return ctx.reply('Запись не найдена.')
    const updated = await editRecord(limits.text, lastSaved)
    db.records[idx] = updated
    await writeUserJson(user, db)
    searchCache.set(`last_saved_${telegramId}`, updated)
    return sendCard(ctx, updated, false)
  }

  if (mode === 'SEARCH') {
    const db = await readUserJson(user)
    const result = await search(textForClassify, db.records)

    if (!result.results || result.results.length === 0) {
      return ctx.reply(`Ничего не нашлось по запросу «${textForClassify}»`)
    }

    const foundRecords = result.results
      .map(r => db.records.find(rec => rec.id === r.id))
      .filter(Boolean)

    searchCache.set(telegramId, foundRecords)
    setTimeout(() => searchCache.delete(telegramId), 5 * 60_000)

    if (result.format === 'cards') {
      for (const rec of foundRecords) await sendCard(ctx, rec)
    } else {
      const list = foundRecords
        .map((r, i) => `${i + 1}. ${formatListItem(r)}`)
        .join('\n')
      await ctx.reply(list + '\n\nНапиши номер или название — покажу подробнее')
    }
    return
  }

  // SAVE
  let structured
  if (limits.type === 'photo') {
    const photo = msg.photo[msg.photo.length - 1]
    const base64 = await getPhotoBase64(ctx, photo)
    structured = await structure('', comment, base64)
  } else {
    structured = await structure(limits.text, comment)
    if (limits.truncated) await ctx.reply('⚠️ Текст обрезан до 1000 символов')
  }

  const record = {
    id: uuidv4(),
    category: structured.category || 'другое',
    created_at: new Date().toISOString(),
    comment,
    raw: limits.text || comment,
    tags: structured.tags || [],
    data: {
      ...structured.data,
      ...(forwardMeta || {})
    }
  }

  const db = await readUserJson(user)
  db.records.push(record)
  await writeUserJson(user, db)

  searchCache.set(`last_saved_${telegramId}`, record)
  await sendCard(ctx, record, true)
}

function sendCard(ctx, rec, saved = false) {
  const lines = []
  if (saved) lines.push(`✅ Сохранено`)
  lines.push(`📇 *${capitalize(rec.category)}*`)
  if (rec.data) {
    Object.entries(rec.data).forEach(([k, v]) => {
      if (v) lines.push(`${k}: ${v}`)
    })
  }
  if (rec.comment) lines.push(`💬 "${rec.comment}"`)
  if (rec.tags?.length) lines.push(`Теги: ${rec.tags.join(', ')}`)
  return ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' })
}

function formatListItem(rec) {
  const parts = []
  if (rec.data?.имя) parts.push(rec.data.имя)
  if (rec.data?.название) parts.push(rec.data.название)
  if (rec.data?.город) parts.push(rec.data.город)
  if (rec.data?.источник_tg) parts.push(rec.data.источник_tg)
  return parts.length ? parts.join(' · ') : rec.category
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1)
}
