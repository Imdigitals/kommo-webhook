import express from 'express'
import bodyParser from 'body-parser'
import axios from 'axios'
import crypto from 'crypto'

const app = express()
app.use(bodyParser.json())

const port = process.env.PORT || 3000
const META_PIXEL_ID      = process.env.META_PIXEL_ID
const META_ACCESS_TOKEN  = process.env.META_ACCESS_TOKEN
const KOMMO_SECRET       = process.env.KOMMO_WEBHOOK_SECRET

function mapEventName(type) {
  if (type === 'lead')     return 'Lead'
  if (type === 'purchase') return 'Purchase'
  return null
}

function verifySignature(body, sig) {
  const expected = crypto
    .createHmac('sha256', KOMMO_SECRET)
    .update(JSON.stringify(body))
    .digest('hex')
  return expected === sig
}

app.post('/api/webhook/kommo', async (req, res) => {
  const sig = req.get('X-Hub-Signature') || ''
  if (!verifySignature(req.body, sig)) {
    return res.status(403).send('Invalid signature')
  }

  const { type, contact, custom_fields } = req.body
  const eventName = mapEventName(type)
  if (!eventName) return res.status(200).send('Ignored event')

  const user_data = {}
  if (contact.email) user_data.em = [contact.email]
  if (contact.phone) user_data.ph = [contact.phone]

  const custom_data = {}
  if (custom_fields?.amount) {
    custom_data.value = custom_fields.amount
    custom_data.currency = custom_fields.currency || 'USD'
  }

  const metaBody = {
    data: [{
      event_name:   eventName,
      event_time:   Math.floor(Date.now()/1000),
      user_data, custom_data
    }],
    access_token: META_ACCESS_TOKEN
  }

  try {
    const r = await axios.post(
      `https://graph.facebook.com/v15.0/${META_PIXEL_ID}/events`,
      metaBody
    )
    console.log('Meta response:', r.data)
    res.json({ success: true })
  } catch (e) {
    console.error(e.response?.data || e.message)
    res.status(500).json({ error: e.response?.data || e.message })
  }
})

app.get('/healthz', (req, res) => res.sendStatus(200))

app.listen(port, () => console.log(`Listening on ${port}`))
