const https = require('https')

function parseDataUri (dataUri) {
  // spec: data:[<mediatype>][;base64],<data>
  const match = /^data:([^,]*?),(.*)$/i.exec(dataUri)
  if (!match) throw new Error('Invalid data URI')

  const meta = match[1] || ''
  const dataPart = match[2] || ''

  const isBase64 = /;base64(?:;|$)/i.test(meta)
  const mime = (meta.split(';')[0] || 'text/plain')

  let buffer
  if (isBase64) {
    // Remove any whitespace that may have been inserted
    const clean = dataPart.replace(/\s/g, '')
    buffer = Buffer.from(clean, 'base64')
  } else {
    // Percent-decoding for non-base64 data
    const decoded = decodeURIComponent(dataPart.replace(/\s/g, ''))
    buffer = Buffer.from(decoded, 'utf8')
  }

  return { buffer, headers: { 'content-type': mime } }
}

module.exports = (url, filter = false) => {
  return new Promise((resolve, reject) => {
    // Ensure url is a string
    if (typeof url !== 'string') {
      return reject(new Error('URL must be a string'))
    }

    // Support data URI - check this FIRST before other validations
    if (url.startsWith('data:')) {
      try {
        const { buffer, headers } = parseDataUri(url)
        if (filter && filter(headers)) return resolve(Buffer.concat([]))
        return resolve(buffer)
      } catch (err) {
        return reject(err)
      }
    }

    // Check if URL is valid HTTPS/HTTP
    if (!url.startsWith('https://') && !url.startsWith('http://')) {
      return reject(new Error(`Protocol "${url.split(':')[0]}:" not supported. Expected "https:"`))
    }

    const options = new URL(url)
    options.headers = {
      'User-Agent': 'curl/8.4.0'
    }

    https.get(options, (res) => {
      if (filter && filter(res.headers)) {
        return resolve(Buffer.concat([]))
      }

      const chunks = []

      res.on('error', (err) => {
        reject(err)
      })
      res.on('data', (chunk) => {
        chunks.push(chunk)
      })
      res.on('end', () => {
        resolve(Buffer.concat(chunks))
      })
    })
  })
}
