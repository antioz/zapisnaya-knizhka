export function extractForwardMeta(msg) {
  if (!msg.forward_date) return null

  if (msg.forward_from) {
    const u = msg.forward_from
    return {
      источник_tg: u.username ? `@${u.username}` : `${u.first_name}${u.last_name ? ' ' + u.last_name : ''}`,
      источник_имя: `${u.first_name}${u.last_name ? ' ' + u.last_name : ''}`
    }
  }

  if (msg.forward_from_chat) {
    const c = msg.forward_from_chat
    return {
      источник_tg: c.username ? `@${c.username} (${c.title})` : c.title,
      источник_имя: c.title
    }
  }

  if (msg.forward_sender_name) {
    return { источник_имя: msg.forward_sender_name }
  }

  return null
}
