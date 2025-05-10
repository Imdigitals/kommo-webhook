import express from 'express'
import bodyParser from 'body-parser'
import axios from 'axios'
import crypto from 'crypto'

const app = express()
app.use(bodyParser.json())

// Variables de entorno
const port = parseInt(process.env.PORT, 10) || 3000
const META_PIXEL_ID      = process.env.META_PIXEL_ID
const META_ACCESS_TOKEN  = process.env.META_ACCESS_TOKEN
const KOMMO_SECRET       = process.env.KOMMO_WEBHOOK_SECRET
const GA_MEASUREMENT_ID  = process.env.GA_MEASUREMENT_ID
const GA_API_SECRET      = process.env.GA_API_SECRET

// Mapea eventos de Kommo a nombres de Meta CAPI y GA4
function mapEventName(type) {
  if (type === 'lead')     return 'Lead'
  if (type === 'purchase') return 'Purchase'
  return null
}

// Verifica firma HMAC-SHA256 de Kommo
function verifySignature(body, sig) {
  const expected = crypto
    .createHmac('sha256', KOMMO_SECRET)
    .update(JSON.stringify(body))
    .digest('hex')
  return expected === sig
}

// Función para enviar eventos a Google Analytics 4 (Measurement Protocol)
async function sendToGA4(eventName, custom_data, clientId) {
  const url =
    `https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}` +
    `&api_secret=${GA_API_SECRET}`
  const payload = {
    client_id: clientId || '555.555', // Fallback si no existe client_id
    events: [
      {
        name: eventName.toLowerCase(), // 'lead' o 'purchase'
        params: {
          value: custom_data.value || 0,
          currency: custom_data.currency || 'USD'
        }
      }
    ]
  }
  try {
    const resp = await axios.post(url, payload)
    console.log(`✅ GA4 ${eventName} event sent (status: ${resp.status})`)
  } catch (err) {
    console.error('❌ Error sending to GA4:', err.response?.data || err.message)
  }
}

// Ruta de recepción del webhook de Kommo
app.post('/api/webhook/kommo', async (req, res) => {
  const sig = req.get('X-Hub-Signature') || ''
  if (!verifySignature(req.body, sig)) {
    return res.status(403).send('Invalid signature')
  }

  const { type, contact, custom_fields } = req.body
  const eventName = mapEventName(type)
  if (!eventName) {
    console.log('Evento ignorado:', type)
    return res.status(200).send('Ignored event')
  }

  // Construye user_data y custom_data
  const user_data = {}
  if (contact.email) user_data.em = [contact.email]
  if (contact.phone) user_data.ph = [contact.phone]
  const custom_data = {}
  if (custom_fields?.amount) {
    custom_data.value = custom_fields.amount
    custom_data.currency = custom_fields.currency || 'USD'
  }

  // 1) Enviar a Meta Conversions API
  const metaBody = {
    data: [
      {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        user_data,
        custom_data
      }
    ],
    access_token: META_ACCESS_TOKEN
  }
  try {
    const metaResp = await axios.post(
      `https://graph.facebook.com/v15.0/${META_PIXEL_ID}/events`,
      metaBody
    )
    console.log('✅ Meta response:', metaResp.data)
  } catch (error) {
    console.error('❌ Error sending to Meta CAPI:', error.response?.data || error.message)
  }

  // 2) Enviar a GA4
  const clientId = custom_fields?.client_id || null
  await sendToGA4(eventName, custom_data, clientId)

  return res.json({ success: true })
})

// Health check y ruta raíz
app.get('/healthz', (req, res) => res.sendStatus(200))
app.get('/', (req, res) => res.send('OK'))

// Arranca servidor
app.listen(port, () => console.log(`✅ Servidor escuchando en el puerto ${port}`))
