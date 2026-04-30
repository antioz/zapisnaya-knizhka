import fetch from 'node-fetch'
import { getToken } from '../auth/yandex.js'
import { upsertUser } from '../db.js'

const BASE = 'https://cloud-api.yandex.net/v1/disk/resources'
const FOLDER_PATH = 'disk:/MyData'
const FILE_PATH = `${FOLDER_PATH}/записная_книжка.json`

function headers(encryptedToken) {
  const { access_token } = getToken(encryptedToken)
  return { Authorization: `OAuth ${access_token}` }
}

export async function initUserFile(telegramId, encryptedToken) {
  const h = headers(encryptedToken)

  const folderCheck = await fetch(`${BASE}?path=${encodeURIComponent(FOLDER_PATH)}`, { headers: h })
  if (folderCheck.status === 404) {
    await fetch(`${BASE}?path=${encodeURIComponent(FOLDER_PATH)}`, { method: 'PUT', headers: h })
  }

  const fileCheck = await fetch(`${BASE}?path=${encodeURIComponent(FILE_PATH)}`, { headers: h })
  if (fileCheck.status === 404) {
    const uploadRes = await fetch(
      `${BASE}/upload?path=${encodeURIComponent(FILE_PATH)}&overwrite=true`,
      { headers: h }
    )
    const { href } = await uploadRes.json()
    await fetch(href, {
      method: 'PUT',
      body: JSON.stringify({ version: 1, records: [] }, null, 2),
      headers: { 'Content-Type': 'application/json' }
    })
  }

  await upsertUser(telegramId, { drive_file_id: FILE_PATH, drive_folder_id: FOLDER_PATH })
  return FILE_PATH
}

export async function readJson(encryptedToken) {
  const h = headers(encryptedToken)
  const meta = await fetch(`${BASE}?path=${encodeURIComponent(FILE_PATH)}`, { headers: h })
  const { file } = await meta.json()
  const res = await fetch(file, { headers: h })
  return await res.json()
}

export async function writeJson(encryptedToken, data) {
  const h = headers(encryptedToken)
  const uploadRes = await fetch(
    `${BASE}/upload?path=${encodeURIComponent(FILE_PATH)}&overwrite=true`,
    { headers: h }
  )
  const { href } = await uploadRes.json()
  await fetch(href, {
    method: 'PUT',
    body: JSON.stringify(data, null, 2),
    headers: { 'Content-Type': 'application/json' }
  })
}

export function getFileUrl() {
  return `https://disk.yandex.ru/client/disk/MyData`
}
