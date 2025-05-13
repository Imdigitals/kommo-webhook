import express from 'express'
import bodyParser from 'body-parser'
import axios from 'axios'
import crypto from 'crypto'
import { Low } from 'lowdb'
import { JSONFile } from 'lowdb/node'   // <— ruta corregida para JSONFile

const app = express()
app.use(bodyParser.json())

// Inicializar DB local (lowdb) para logs y configuración
const adapter = new JSONFile('./db.json')
const db = new Low(adapter)
async function initDb() {
  await db.read()
  db.data = db.data || { logs: [], config: { enabled: true } }
  await db.write()
}

// Variables de entorno
const port = parseInt(process.env.PORT, 10) || 3000
const META_PIXEL_ID     = process.env.META_PIXEL_ID
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN
const KOMMO_SECRET      = process.env.KOMMO_WEBHOOK_SECRET
const GA_MEASUREMENT_ID = process.env.GA_MEASUREMENT_ID
const GA_API_SECRET     = process.env.GA_API_SECRET

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

// Envía evento a Meta Conversions API
async function sendToMeta(eventName, user_data, custom_data) {
  const metaBody = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      user_data,
      custom_data
    }],
    access_token: META_ACCESS_TOKEN
  }
  return axios.post(
    `https://graph.facebook.com/v15.0/${META_PIXEL_ID}/events`,
    metaBody
  )
}

// Envía evento a GA4 vía Measurement Protocol
async function sendToGA4(eventName, custom_data, clientId) {
  const url =
    `https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}` +
    `&api_secret=${GA_API_SECRET}`
  const payload = {
    client_id: clientId || '555.555',
    events: [{
      name: eventName.toLowerCase(),
      params: {
        value: custom_data.value || 0,
        currency: custom_data.currency || 'USD'
      }
    }]
  }
  return axios.post(url, payload)
}

// Handler del webhook de Kommo
app.post('/api/webhook/kommo', async (req, res) => {
  await initDb()

  if (!db.data.config.enabled) {
    return res.status(503).send('Webhook disabled')
  }

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

  // Construir user_data (hashed) para Meta
  const user_data = {}
  if (contact.email) {
    const email = contact.email.trim().toLowerCase()
    user_data.em = [ crypto.createHash('sha256').update(email).digest('hex') ]
  }
  if (contact.phone) {
    const phone = contact.phone.replace(/\D+/g, '')
    user_data.ph = [ crypto.createHash('sha256').update(phone).digest('hex') ]
  }

  // Construir custom_data
  const custom_data = {}
  if (custom_fields?.amount) {
    custom_data.value    = custom_fields.amount
    custom_data.currency = custom_fields.currency || 'USD'
  }

  // Enviar a Meta CAPI y GA4
  let metaStatus = 'error', ga4Status = 'error'
  try {
    const metaResp = await sendToMeta(eventName, user_data, custom_data)
    metaStatus = metaResp.status
    console.log('✅ Meta response:', metaResp.data)
  } catch (err) {
    console.error('❌ Error Meta CAPI:', err.response?.data || err.message)
    metaStatus = err.response?.status || 'error'
  }
  try {
    const ga4Resp = await sendToGA4(eventName, custom_data, custom_fields?.client_id)
    ga4Status = ga4Resp.status
    console.log(`✅ GA4 ${eventName} sent (status: ${ga4Status})`)
  } catch (err) {
    console.error('❌ Error GA4:', err.response?.data || err.message)
    ga4Status = err.response?.status || 'error'
  }

  // Guardar log
  db.data.logs.push({
    timestamp: new Date().toISOString(),
    type:      eventName,
    metaStatus,
    ga4Status
  })
  await db.write()

  res.json({ success: true })
})

// Endpoints de administración
app.get('/admin/logs', async (req, res) => {
  await initDb()
  res.json({ enabled: db.data.config.enabled, logs: db.data.logs.slice(-100) })
})
app.post('/admin/config', async (req, res) => {
  await initDb()
  const { enabled } = req.body
  db.data.config.enabled = !!enabled
  await db.write()
  res.json({ enabled: db.data.config.enabled })
})

// UI mínima en /admin
app.get('/admin', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Admin Kommo → Ads</title></head><body>
  <h1>Admin Kommo → Ads</h1>
  <label>Enabled: <input type="checkbox" id="toggle"></label>
  <h2>Logs</h2>
  <table border="1" id="tbl"><tr><th>Timestamp</th><th>Type</th><th>Meta</th><th>GA4</th></tr></table>
  <script>
    async function load(){
      const r = await fetch('/admin/logs')
      const d = await r.json()
      document.getElementById('toggle').checked = d.enabled
      const tbl = document.getElementById('tbl')
      tbl.innerHTML = '<tr><th>Timestamp</th><th>Type</th><th>Meta</th><th>GA4</th></tr>'
      d.logs.forEach(l=>{
        const row = tbl.insertRow()
        row.insertCell().textContent = l.timestamp
        row.insertCell().textContent = l.type
        row.insertCell().textContent = l.metaStatus
        row.insertCell().textContent = l.ga4Status
      })
    }
    document.getElementById('toggle').onchange = async e => {
      await fetch('/admin/config',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ enabled: e.target.checked })
      })
    }
    load()
    setInterval(load,15000)
  </script>
</body></html>
  `)
})

// Health check y root
app.get('/healthz', (req, res) => res.sendStatus(200))
app.get('/',       (req, res) => res.send('OK'))

// Arrancar servidor
app.listen(port, () => console.log(`✅ Servidor escuchando en puerto ${port}`))
