import { v4 as uuidv4 } from 'uuid'
import { classify, structure, search, editRecord } from '../ai.js'
import { checkLimits } from './limits.js'
import { extractForwardMeta } from './forward.js'
import { checkRateLimit, handleViolation } from './moderation.js'
import * as googleDrive from '../drive/google.js'
import * as yandexDrive from '../drive/yandex.js'
import { getUser } from '../db.js'

// session cache for drill-down search results
const searchCache = new Map()
// pending confirmation before save
const pendingCache = new Map()
// pending closed-account forward (waiting for @username)
const pendingForwardCache = new Map()
// context note sent right before a forward (to attach as comment)
const pendingContextCache = new Map()

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

function extractIdentifiers(data) {
  const ids = []
  for (const v of Object.values(data || {})) {
    const s = String(v).toLowerCase()
    if (/\+?[\d\s\-()]{7,}/.test(s)) ids.push(s.replace(/[\s\-()]/g, ''))  // phone
    if (/@\w+/.test(s)) ids.push(s.match(/@\w+/)[0])  // @nick
    if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/.test(s)) ids.push(s.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/)[0])  // email
  }
  return ids
}

function findDuplicateByIdentifier(records, newData) {
  const newIds = extractIdentifiers(newData)
  if (!newIds.length) return null
  return records.find(r => {
    const existing = extractIdentifiers(r.data)
    return existing.some(id => newIds.includes(id))
  }) || null
}

function hasValuableInfo(text) {
  return /\+?[\d\s\-()]{7,}/.test(text) ||  // phone
    /https?:\/\/|t\.me\/|@\w+/.test(text) ||  // url or @
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/.test(text) ||  // email
    text.length > 40  // long enough to likely have substance
}

export function setupSaveCallbacks(bot) {
  bot.action(/^confirm_save:(\d+)$/, async (ctx) => {
    const telegramId = String(ctx.match[1])
    const pending = pendingCache.get(telegramId)
    if (!pending) return ctx.answerCbQuery('Время вышло')
    pendingCache.delete(telegramId)
    await ctx.answerCbQuery()
    await ctx.editMessageText('Сохраняю...')
    const user = await getUser(telegramId)
    await doSave(ctx, user, pending.structured, pending.record)
  })

  bot.action(/^cancel_save:(\d+)$/, async (ctx) => {
    pendingCache.delete(String(ctx.match[1]))
    await ctx.answerCbQuery()
    await ctx.editMessageText('Не сохранил.')
  })

  bot.action(/^overwrite_save:(\d+)$/, async (ctx) => {
    const telegramId = String(ctx.match[1])
    const pending = pendingCache.get(telegramId)
    if (!pending) return ctx.answerCbQuery('Время вышло')
    pendingCache.delete(telegramId)
    await ctx.answerCbQuery()
    await ctx.editMessageText('Сохраняю заново...')
    const user = await getUser(telegramId)
    await doSave(ctx, user, pending.structured, pending.record)
  })
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

  const forwardMeta = extractForwardMeta(msg)

  // pick up context note sent right before a forward
  const cachedContext = pendingContextCache.get(telegramId)
  if (cachedContext && forwardMeta) pendingContextCache.delete(telegramId)
  const captionParts = [cachedContext && forwardMeta ? cachedContext : null, msg.caption].filter(Boolean)
  const comment = captionParts.join(' · ') || ''

  // pending confirmation: text while awaiting button press
  if (limits.type === 'text') {
    const pendingItem = pendingCache.get(String(telegramId))
    if (pendingItem) {
      pendingCache.delete(String(telegramId))
      const txt = limits.text.trim()
      const isEditCommand = /^(замени|измени|исправь|удали|добавь|поменяй|убери|сделай)\b/i.test(txt)
      if (isEditCommand) {
        const updated = await editRecord(txt, pendingItem.record)
        await doSave(ctx, user, pendingItem.structured, updated)
      } else {
        pendingItem.record.comment = txt
        await doSave(ctx, user, pendingItem.structured, pendingItem.record)
      }
      return
    }
  }

  // closed-account forward: waiting for @username clarification
  if (limits.type === 'text') {
    const pendingFwd = pendingForwardCache.get(telegramId)
    if (pendingFwd) {
      const text = limits.text.trim()
      // accept @username or a link
      if (/^@\w+$/.test(text) || /https?:\/\/|t\.me\//.test(text)) {
        pendingForwardCache.delete(telegramId)
        pendingFwd.record.data.источник_tg = text
        const db = await readUserJson(user)
        const idx = db.records.findIndex(r => r.id === pendingFwd.record.id)
        if (idx !== -1) {
          db.records[idx] = pendingFwd.record
          await writeUserJson(user, db)
        }
        return ctx.reply(`Обновил: добавил ${text}`)
      } else {
        pendingForwardCache.delete(telegramId)
      }
    }
  }

  // delete commands
  if (limits.type === 'text') {
    const txt = limits.text.trim().toLowerCase()

    if (txt === 'удали все') {
      const db = await readUserJson(user)
      const count = db.records.length
      db.records = []
      await writeUserJson(user, db)
      return ctx.reply(`Удалено ${count} записей.`)
    }

    const deleteMatch = txt.match(/^удали\s+(\d+)$/)
    if (deleteMatch) {
      const cached = searchCache.get(telegramId)
      const idx = parseInt(deleteMatch[1]) - 1
      if (!cached || !cached[idx]) return ctx.reply('Сначала найди записи через поиск, потом удаляй по номеру.')
      const rec = cached[idx]
      const db = await readUserJson(user)
      const before = db.records.length
      db.records = db.records.filter(r => r.id !== rec.id)
      await writeUserJson(user, db)
      if (db.records.length < before) {
        searchCache.set(telegramId, cached.filter((_, i) => i !== idx))
        return ctx.reply(`Запись удалена.`)
      }
      return ctx.reply('Не нашёл такую запись.')
    }

    if (txt === 'найди похожее') {
      const db = await readUserJson(user)
      const seen = new Map()
      const dups = []
      for (const rec of db.records) {
        const ids = extractIdentifiers(rec.data)
        for (const id of ids) {
          if (seen.has(id)) dups.push({ id, recs: [seen.get(id), rec] })
          else seen.set(id, rec)
        }
      }
      if (!dups.length) return ctx.reply('Дубликатов не найдено.')
      const lines = dups.map(d => `• совпадение по "${d.id}": ${formatListItem(d.recs[0])} / ${formatListItem(d.recs[1])}`).join('\n')
      return ctx.reply(`Найдено совпадений: ${dups.length}\n\n${lines}`)
    }
  }

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


  // classify: SAVE or SEARCH
  let textForClassify = limits.text || comment
  if (!textForClassify && limits.type !== 'photo') return

  // "запиши ..." — explicit save command, strip the trigger word
  const zapisshiMatch = limits.text?.match(/^запиши\s+(.+)/si)
  if (zapisshiMatch) {
    limits.text = zapisshiMatch[1].trim()
    textForClassify = limits.text
  }

  // "найди ..." — explicit search command, strip the trigger word
  const najdiMatch = !zapisshiMatch && limits.text?.match(/^найди\s+(.+)/si)
  if (najdiMatch) {
    limits.text = najdiMatch[1].trim()
    textForClassify = limits.text
  }

  // plain text with no concrete identifiers and no forward → may be a context note before an upcoming forward
  const hasConcreteId = /\+?[\d\s\-()]{7,}/.test(limits.text || '') ||
    /https?:\/\/|t\.me\/|@\w+/.test(limits.text || '') ||
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/.test(limits.text || '')
  if (limits.type === 'text' && !forwardMeta && !zapisshiMatch && !hasConcreteId && limits.text.length < 120) {
    const contextText = limits.text.trim()
    pendingContextCache.set(telegramId, contextText)
    setTimeout(async () => {
      if (pendingContextCache.get(telegramId) !== contextText) return
      pendingContextCache.delete(telegramId)
      const s = await structure(contextText, '').catch(() => null)
      if (!s) return
      const rec = { id: uuidv4(), category: s.category || 'другое', created_at: new Date().toISOString(), comment: '', raw: contextText, tags: s.tags || [], data: s.data || {} }
      const db = await readUserJson(user)
      db.records.push(rec)
      await writeUserJson(user, db)
      searchCache.set(`last_saved_${telegramId}`, rec)
      const lines = [`✅ Сохранено`, `📋 ${capitalize(rec.category).toUpperCase()}`]
      Object.entries(rec.data).forEach(([k, v]) => { const sv = String(v).trim(); if (sv && !EMPTY_VALUES.has(sv.toLowerCase())) lines.push(`${k}: ${sv}`) })
      if (rec.comment) lines.push(`💬 "${rec.comment}"`)
      await bot.telegram.sendMessage(telegramId, lines.join('\n'))
    }, 1_000)
    return
  }

  const mode = limits.type === 'photo' ? 'SAVE' : (zapisshiMatch ? 'SAVE' : najdiMatch ? 'SEARCH' : await classify(textForClassify))

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
  // deduplication: check before calling AI
  const db0 = await readUserJson(user)
  if (limits.type === 'photo') {
    const photo = msg.photo[msg.photo.length - 1]
    const isDup = db0.records.some(r => r.photo_unique_id === photo.file_unique_id)
    if (isDup) return ctx.reply('Этот скрин уже сохранён.')
  } else if (limits.text) {
    const norm = limits.text.trim().toLowerCase()
    const isDup = db0.records.some(r => r.raw?.trim().toLowerCase() === norm)
    if (isDup) return ctx.reply('Такая запись уже есть.')
  }

  let structured
  if (limits.type === 'photo') {
    const photo = msg.photo[msg.photo.length - 1]
    const base64 = await getPhotoBase64(ctx, photo)
    try {
      structured = await structure('', comment, base64)
    } catch (e) {
      if (e.message === 'vision_unavailable') {
        return ctx.reply('Не могу прочитать скрин — опиши текстом что там написано')
      }
      throw e
    }
  } else {
    structured = await structure(limits.text, comment)
    if (limits.truncated) await ctx.reply('⚠️ Текст обрезан до 1000 символов')
  }

  const photo0 = limits.type === 'photo' ? msg.photo[msg.photo.length - 1] : null
  const record = {
    id: uuidv4(),
    category: structured.category || 'другое',
    created_at: new Date().toISOString(),
    comment,
    raw: limits.text || comment,
    tags: structured.tags || [],
    ...(photo0 ? { photo_unique_id: photo0.file_unique_id } : {}),
    data: {
      ...structured.data,
      ...(forwardMeta || {})
    }
  }

  // duplicate check by phone/nick/email
  const dupRecord = findDuplicateByIdentifier(db0.records, record.data)
  if (dupRecord) {
    pendingCache.set(String(telegramId), { structured, record })
    setTimeout(() => pendingCache.delete(String(telegramId)), 2 * 60_000)
    const dupLines = [`📇 *${capitalize(dupRecord.category)}*`]
    Object.entries(dupRecord.data || {}).forEach(([k, v]) => { if (v) dupLines.push(`${k}: ${v}`) })
    if (dupRecord.comment) dupLines.push(`💬 "${dupRecord.comment}"`)
    return ctx.reply(
      `Совпадение с существующей записью:\n\n${dupLines.join('\n')}\n\nСохраняем заново?`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Да, сохранить', callback_data: `overwrite_save:${telegramId}` },
            { text: '❌ Нет', callback_data: `cancel_save:${telegramId}` }
          ]]
        }
      }
    )
  }

  // photo: always confirm before saving so user can catch OCR errors
  if (limits.type === 'photo') {
    pendingCache.set(String(telegramId), { structured, record })
    setTimeout(() => pendingCache.delete(String(telegramId)), 2 * 60_000)
    const previewLines = [`📇 ${capitalize(structured.category || 'другое')}`]
    Object.entries(structured.data || {}).forEach(([k, v]) => { if (v) previewLines.push(`${k}: ${v}`) })
    if (comment) previewLines.push(`💬 "${comment}"`)
    return ctx.reply(
      `Вот что прочитал — всё верно?\n\n${previewLines.join('\n')}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Сохранить', callback_data: `confirm_save:${telegramId}` },
            { text: '❌ Не то', callback_data: `cancel_save:${telegramId}` }
          ]]
        }
      }
    )
  }

  // low-value text: ask confirmation before saving
  if (limits.type === 'text' && !hasValuableInfo(limits.text)) {
    pendingCache.set(String(telegramId), { structured, record })
    setTimeout(() => pendingCache.delete(String(telegramId)), 2 * 60_000)
    return ctx.reply(
      `Тут нет очевидной ценной инфы — точно сохранить?\n\n_${limits.text}_`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Сохранить', callback_data: `confirm_save:${telegramId}` },
            { text: '❌ Не надо', callback_data: `cancel_save:${telegramId}` }
          ]]
        }
      }
    )
  }

  await doSave(ctx, user, structured, record)

  // closed account forward: prompt for @username
  if (msg.forward_sender_name && !msg.forward_from && !msg.forward_from_chat) {
    pendingForwardCache.set(telegramId, { record })
    setTimeout(() => pendingForwardCache.delete(telegramId), 5 * 60_000)
    await ctx.reply('Аккаунт закрыт, сохранил только имя. Если знаешь @username — кинь следующим сообщением.')
  }
}

async function doSave(ctx, user, structured, record) {
  const db = await readUserJson(user)
  db.records.push(record)
  await writeUserJson(user, db)
  searchCache.set(`last_saved_${ctx.from?.id || record.id}`, record)
  await sendCard(ctx, record, true)
}

const MENU = {
  reply_markup: {
    keyboard: [
      ['⚙️ Настройки', '💬 Фидбек']
    ],
    resize_keyboard: true
  }
}

const EMPTY_VALUES = new Set(['не указано', 'не указана', 'не указан', 'нет', 'unknown', 'n/a', '-', '—'])

async function sendCard(ctx, rec, saved = false) {
  const lines = []
  if (saved) lines.push(`✅ Сохранено`)
  lines.push(`📇 ${capitalize(rec.category).toUpperCase()}`)
  if (rec.data) {
    Object.entries(rec.data).forEach(([k, v]) => {
      const s = String(v).trim()
      if (s && !EMPTY_VALUES.has(s.toLowerCase())) lines.push(`${k}: ${s}`)
    })
  }
  if (rec.comment) lines.push(`💬 "${rec.comment}"`)
  await ctx.reply(lines.join('\n'), MENU)
}

function formatListItem(rec) {
  const d = rec.data || {}
  const name = d.имя || d.название || d.источник_имя || ''
  const detail = d.описание || d.услуга || d.специализация || d.навыки || d.тема || (rec.tags?.[0]) || ''
  const contact = d.телефон || d.telegram || d.username || d.сайт || d.ссылка || d.источник_tg || ''
  const parts = [name, detail, contact].filter(Boolean)
  if (parts.length) return parts.join(' | ')
  return rec.category
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1)
}
