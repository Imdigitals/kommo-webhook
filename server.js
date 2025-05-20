import express from 'express'
import bodyParser from 'body-parser'
import axios from 'axios'
import crypto from 'crypto'
import { Low } from 'lowdb'
import { JSONFile } from 'lowdb/node'

const app = express()
app.use(bodyParser.json())

// lowdb setup
const adapter = new JSONFile('./db.json')
const db = new Low(adapter, { logs: [], config: { enabled: true } })

async function initDb() {
  await db.read()
  db.data = db.data || { logs: [], config: { enabled: true } }
  await db.write()
}

// env vars
const port             = parseInt(process.env.PORT, 10) || 3000
const META_PIXEL_ID    = process.env.META_PIXEL_ID
const META_ACCESS_TOKEN= process.env.META_ACCESS_TOKEN
const KOMMO_SECRET     = process.env.KOMMO_WEBHOOK_SECRET
const GA_MEASUREMENT_ID= process.env.GA_MEASUREMENT_ID
const GA_API_SECRET    = process.env.GA_API_SECRET

// map event type to name
function mapEventName(type) {
  if (type === 'lead')     return 'Lead'
  if (type === 'purchase') return 'Purchase'
  return null
}

// send to Meta CAPI
async function sendToMeta(eventName, user_data, custom_data) {
  const metaBody = {
    data: [{ event_name: eventName, event_time: Math.floor(Date.now()/1000), user_data, custom_data }],
    access_token: META_ACCESS_TOKEN
  }
  return axios.post(`https://graph.facebook.com/v15.0/${META_PIXEL_ID}/events`, metaBody)
}

// send to GA4
async function sendToGA4(eventName, custom_data, clientId) {
  const url = `https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`
  const payload = {
    client_id: clientId || '555.555',
    events: [{
      name: eventName.toLowerCase(),
      params: {
        value:    custom_data.value    || 0,
        currency: custom_data.currency || 'USD'
      }
    }]
  }
  return axios.post(url, payload)
}

// central handler
async function handleEvent(type, contact, custom_fields, res) {
  await initDb()
  if (!db.data.config.enabled) {
    return res.status(503).send('Webhook disabled')
  }
  const eventName = mapEventName(type)
  if (!eventName) {
    return res.status(200).send('Ignored event')
  }

  // hash user_data
  const user_data = {}
  if (contact?.email) {
    const e = contact.email.trim().toLowerCase()
    user_data.em = [crypto.createHash('sha256').update(e).digest('hex')]
  }
  if (contact?.phone) {
    const p = contact.phone.replace(/\D+/g, '')
    user_data.ph = [crypto.createHash('sha256').update(p).digest('hex')]
  }

  // custom_data
  const custom_data = {}
  if (custom_fields?.amount) {
    custom_data.value    = custom_fields.amount
    custom_data.currency = custom_fields.currency || 'USD'
  }

  // send and log
  let metaStatus = 'error', ga4Status = 'error'
  try {
    const m = await sendToMeta(eventName, user_data, custom_data)
    metaStatus = m.status
    console.log('✅ Meta response:', m.data)
  } catch (e) {
    console.error('❌ Error Meta CAPI:', e.response?.data || e.message)
    metaStatus = e.response?.status || 'error'
  }
  try {
    const g = await sendToGA4(eventName, custom_data, custom_fields?.client_id)
    ga4Status = g.status
    console.log(`✅ GA4 ${eventName} sent (status: ${ga4Status})`)
  } catch (e) {
    console.error('❌ Error GA4:', e.response?.data || e.message)
    ga4Status = e.response?.status || 'error'
  }

  db.data.logs.push({
    timestamp: new Date().toISOString(),
    type:      eventName,
    metaStatus,
    ga4Status
  })
  await db.write()

  return res.json({ success: true })
}

// manual lead/purchase webhooks
app.post('/api/webhook/manual/:evt', async (req, res) => {
  console.log('🔔 Received manual webhook:', {
    event: req.params.evt,
    body:  req.body
  })
  const type = req.params.evt  // 'lead' o 'purchase'
  const { contact, custom_fields } = req.body
  await handleEvent(type, contact, custom_fields, res)
})

// admin endpoints
app.get('/admin/logs', async (req, res) => {
  await initDb()
  res.json({ enabled: db.data.config.enabled, logs: db.data.logs.slice(-100) })
})
app.post('/admin/config', async (req, res) => {
  await initDb()
  db.data.config.enabled = !!req.body.enabled
  await db.write()
  res.json({ enabled: db.data.config.enabled })
})

// admin UI
app.get('/admin', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Admin</title></head><body>
    <h1>Admin Kommo → Ads</h1>
    <label>Enabled: <input type="checkbox" id="toggle"></label>
    <h2>Logs</h2>
    <table border="1" id="tbl"><tr><th>Timestamp</th><th>Type</th><th>Meta</th><th>GA4</th></tr></table>
    <script>
      async function load() {
        const r = await fetch('/admin/logs')
        const d = await r.json()
        document.getElementById('toggle').checked = d.enabled
        const tbl = document.getElementById('tbl')
        tbl.innerHTML = '<tr><th>Timestamp</th><th>Type</th><th>Meta</th><th>GA4</th></tr>'
        d.logs.forEach(l => {
          const row = tbl.insertRow()
          row.insertCell().textContent = l.timestamp
          row.insertCell().textContent = l.type
          row.insertCell().textContent = l.metaStatus
          row.insertCell().textContent = l.ga4Status
        })
      }
      document.getElementById('toggle').onchange = async e => {
        await fetch('/admin/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: e.target.checked })
        })
      }
      load()
      setInterval(load, 15000)
    </script>
  </body></html>`)
})

// health & root
app.get('/healthz', (req, res) => res.sendStatus(200))
app.get('/',       (req, res) => res.send('OK'))

// start server
app.listen(port, () => console.log('Server on port ' + port))
