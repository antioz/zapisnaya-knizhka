import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

export async function getUser(telegramId) {
  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', String(telegramId))
    .single()
  return data
}

export async function upsertUser(telegramId, fields) {
  const { data, error } = await supabase
    .from('users')
    .upsert({ telegram_id: String(telegramId), ...fields }, { onConflict: 'telegram_id' })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function setUserPaused(telegramId, isPaused) {
  await supabase
    .from('users')
    .update({ is_paused: isPaused })
    .eq('telegram_id', String(telegramId))
}

export async function setUserBanned(telegramId) {
  await supabase
    .from('users')
    .update({ is_banned: true, is_paused: true })
    .eq('telegram_id', String(telegramId))
}
