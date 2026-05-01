import { google } from 'googleapis'
import { getAuthorizedClient } from '../auth/google.js'
import { upsertUser } from '../db.js'

const FOLDER_NAME = 'MyData'
const FILE_NAME = 'записная_книжка.json'

async function getDrive(encryptedToken, telegramId = null) {
  const auth = getAuthorizedClient(encryptedToken, telegramId)
  return google.drive({ version: 'v3', auth })
}

async function ensureFolder(drive) {
  const res = await drive.files.list({
    q: `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)'
  })
  if (res.data.files.length > 0) return res.data.files[0].id

  const folder = await drive.files.create({
    requestBody: { name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id'
  })
  return folder.data.id
}

export async function initUserFile(telegramId, encryptedToken) {
  const drive = await getDrive(encryptedToken)
  const folderId = await ensureFolder(drive)

  // search in folder first
  let existing = await drive.files.list({
    q: `name='${FILE_NAME}' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id)'
  })

  // fallback: search anywhere in Drive (in case folder was recreated)
  if (existing.data.files.length === 0) {
    existing = await drive.files.list({
      q: `name='${FILE_NAME}' and trashed=false`,
      fields: 'files(id)',
      orderBy: 'createdTime'
    })
  }

  let fileId
  if (existing.data.files.length > 0) {
    fileId = existing.data.files[0].id
  } else {
    const file = await drive.files.create({
      requestBody: { name: FILE_NAME, parents: [folderId] },
      media: { mimeType: 'application/json', body: JSON.stringify({ version: 1, records: [] }, null, 2) },
      fields: 'id'
    })
    fileId = file.data.id
  }

  await upsertUser(telegramId, { drive_file_id: fileId, drive_folder_id: folderId })
  return fileId
}

export async function readJson(encryptedToken, fileId, telegramId = null) {
  const drive = await getDrive(encryptedToken, telegramId)
  const res = await drive.files.get({ fileId, alt: 'media' })
  return res.data
}

export async function writeJson(encryptedToken, fileId, data, telegramId = null) {
  const drive = await getDrive(encryptedToken, telegramId)
  await drive.files.update({
    fileId,
    media: { mimeType: 'application/json', body: JSON.stringify(data, null, 2) }
  })
}

export function getFileUrl(fileId) {
  return `https://drive.google.com/file/d/${fileId}/view`
}
