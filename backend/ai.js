import OpenAI from 'openai'

const client = new OpenAI({
  baseURL: 'https://api.groq.com/openai/v1',
  apiKey: process.env.GROQ_API_KEY
})

const visionClient = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY
})

const CATEGORIES = 'контакт, место, цена/услуга, идея, ссылка, другое'

export async function classify(text) {
  const res = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'system',
        content: `Классифицируй сообщение пользователя. Отвечай ТОЛЬКО одним словом: SAVE, SEARCH или EDIT.

SEARCH — если:
- одно слово или короткая фраза (1-3 слова) без явной новой информации
- есть слова: найди, покажи, ищи, где, кто, есть ли, помнишь
- похоже на запрос (имя человека, название места, тема)

EDIT — если просит исправить, изменить, добавить, удалить в последней записи.

SAVE — если есть явная новая информация: телефон, адрес, описание, ссылка, развёрнутый текст.

Сомневаешься между SEARCH и SAVE для короткой фразы → выбирай SEARCH.`
      },
      {
        role: 'user',
        content: `Классифицируй: "${text}"\n\nОтвет (одно слово):`
      }
    ],
    max_tokens: 10,
    temperature: 0
  })
  const result = res.choices[0].message.content.trim().toUpperCase()
  if (result.includes('SEARCH')) return 'SEARCH'
  if (result.includes('EDIT')) return 'EDIT'
  return 'SAVE'
}

export async function editRecord(command, record) {
  const res = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'system',
        content: `Ты редактируешь запись в записной книжке по команде пользователя.
Верни обновлённую запись строго в том же JSON формате что получил.
Без markdown, только JSON.`
      },
      {
        role: 'user',
        content: `Команда: "${command}"\n\nТекущая запись:\n${JSON.stringify(record, null, 2)}`
      }
    ],
    max_tokens: 600,
    temperature: 0.1
  })
  return JSON.parse(res.choices[0].message.content.trim())
}

export async function structure(text, comment, imageBase64 = null) {
  const messages = [
    {
      role: 'system',
      content: `Ты структурируешь записи для личной записной книжки.

Категории и когда использовать:
- "контакт" — есть человек, компания, телефон, telegram, email, имя
- "место" — адрес, заведение, локация, город
- "цена/услуга" — стоимость, прайс, тариф, услуга с ценой
- "идея" — мысль, план, задача, заметка без контакта
- "ссылка" — URL, сайт, канал, бот
- "другое" — только если не подходит ни одна из выше

Верни JSON строго в формате:
{
  "category": "...",
  "tags": ["...", "..."],
  "data": { "поле": "значение" }
}
Поля в data — на русском, свободные, зависят от категории.
Без markdown, только JSON.`
    }
  ]

  if (imageBase64) {
    const visionModels = [
      'google/gemini-flash-1.5',
      'meta-llama/llama-4-maverick:free',
      'qwen/qwen2.5-vl-72b-instruct:free'
    ]
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: `Прочитай текст с изображения и структурируй как запись.\nКомментарий пользователя: "${comment || ''}"\n\nВерни только JSON без markdown.` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
      ]
    })
    for (const model of visionModels) {
      try {
        const res = await visionClient.chat.completions.create({ model, messages, max_tokens: 500, temperature: 0.2 })
        return JSON.parse(res.choices[0].message.content.trim())
      } catch (e) {
        console.error(`Vision model ${model} failed:`, e.message)
      }
    }
    throw new Error('vision_unavailable')
  } else {
    messages.push({
      role: 'user',
      content: `Структурируй эту запись:\n\nТекст: "${text}"\nКомментарий: "${comment || ''}"`
    })
  }

  const res = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages,
    max_tokens: 500,
    temperature: 0.2
  })

  return JSON.parse(res.choices[0].message.content.trim())
}

export async function search(query, records) {
  const res = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'system',
        content: `Ты ищешь записи в личной записной книжке.
Ищи по ВСЕМ полям: data, comment, raw, tags, category — включая частичное совпадение и похожие слова.
Если запрос — название организации или имя, ищи его в любом поле.

Верни JSON строго в формате:
{
  "results": [
    { "id": "...", "summary": "краткое описание для списка" }
  ],
  "format": "cards" | "list"
}
"cards" если 1-2 результата, "list" если больше.
Если ничего не найдено — верни { "results": [], "format": "cards" }.
Без markdown, только JSON.`
      },
      {
        role: 'user',
        content: `Запрос: "${query}"\n\nБаза записей:\n${JSON.stringify(records, null, 2)}`
      }
    ],
    max_tokens: 1000,
    temperature: 0.1
  })

  return JSON.parse(res.choices[0].message.content.trim())
}

export async function checkContentSafety(text) {
  const res = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'system',
        content: 'Определи: содержит ли текст попытки взлома, инъекции, вредоносный контент, спам. Ответь только: SAFE или UNSAFE'
      },
      { role: 'user', content: text }
    ],
    max_tokens: 10,
    temperature: 0
  })
  return res.choices[0].message.content.trim().toUpperCase().includes('UNSAFE') ? 'UNSAFE' : 'SAFE'
}
