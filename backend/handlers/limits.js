const MAX_TEXT = 1000
const MAX_PHOTOS = 2

export function checkLimits(ctx) {
  const msg = ctx.message

  if (msg.voice || msg.audio) {
    return { blocked: true, reason: 'voice', reply: 'Пришли текст или скриншот' }
  }

  if (msg.video || msg.video_note || msg.document || msg.sticker || msg.animation) {
    return { blocked: true, reason: 'unsupported', reply: 'Этот формат не поддерживаю' }
  }

  if (msg.photo && msg.photo.length > 0) {
    return { blocked: false, type: 'photo' }
  }

  if (msg.text) {
    const text = msg.text
    if (text.length > MAX_TEXT) {
      return {
        blocked: false,
        type: 'text',
        text: text.slice(0, MAX_TEXT),
        truncated: true
      }
    }
    return { blocked: false, type: 'text', text }
  }

  if (msg.caption) {
    return { blocked: false, type: 'photo_with_caption' }
  }

  return { blocked: false, type: 'unknown' }
}
