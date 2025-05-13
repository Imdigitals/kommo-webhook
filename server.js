import express from 'express'
import bodyParser from 'body-parser'
import axios from 'axios'
import crypto from 'crypto'
import { Low, JSONFile } from 'lowdb'

const app = express()
app.use(bodyParser.json())

// Inicializar base de datos local (lowdb) para logs y configuración
const adapter = new JSONFile('./db.json')
const db = new Low(adapter)
async function initDb() {
await db.read()
db.data ||= { logs: \[], config: { enabled: true } }
await db.write()
}

// Variables de entorno
const port = parseInt(process.env.PORT, 10) || 3000
const META\_PIXEL\_ID      = process.env.META\_PIXEL\_ID
const META\_ACCESS\_TOKEN  = process.env.META\_ACCESS\_TOKEN
const KOMMO\_SECRET       = process.env.KOMMO\_WEBHOOK\_SECRET
const GA\_MEASUREMENT\_ID  = process.env.GA\_MEASUREMENT\_ID
const GA\_API\_SECRET      = process.env.GA\_API\_SECRET

// Mapea eventos de Kommo a nombres de Meta CAPI y GA4
function mapEventName(type) {
if (type === 'lead')     return 'Lead'
if (type === 'purchase') return 'Purchase'
return null
}

// Verifica firma HMAC-SHA256 de Kommo
function verifySignature(body, sig) {
const expected = crypto
.createHmac('sha256', KOMMO\_SECRET)
.update(JSON.stringify(body))
.digest('hex')
return expected === sig
}

// Envía evento a Meta Conversions API
async function sendToMeta(eventName, user\_data, custom\_data) {
const metaBody = {
data: \[{
event\_name: eventName,
event\_time: Math.floor(Date.now() / 1000),
user\_data,
custom\_data
}],
access\_token: META\_ACCESS\_TOKEN
}
return axios.post(`https://graph.facebook.com/v15.0/${META_PIXEL_ID}/events`, metaBody)
}

// Envía evento a Google Analytics 4 via Measurement Protocol
async function sendToGA4(eventName, custom\_data, clientId) {
const url =
`https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}` +
`&api_secret=${GA_API_SECRET}`
const payload = {
client\_id: clientId || '555.555',
events: \[{
name: eventName.toLowerCase(),
params: {
value: custom\_data.value || 0,
currency: custom\_data.currency || 'USD'
}
}]
}
return axios.post(url, payload)
}

// Webhook de Kommo: Lead y Purchase
app.post('/api/webhook/kommo', async (req, res) => {
await initDb()
// Permitir desactivar via UI
if (!db.data.config.enabled) return res.status(503).send('Webhook disabled')

// Validar firma
const sig = req.get('X-Hub-Signature') || ''
if (!verifySignature(req.body, sig)) return res.status(403).send('Invalid signature')

const { type, contact, custom\_fields } = req.body
const eventName = mapEventName(type)
if (!eventName) {
console.log('Evento ignorado:', type)
return res.status(200).send('Ignored event')
}

// Construir user\_data para Meta (hashed)
const user\_data = {}
if (contact.email) {
const email = contact.email.trim().toLowerCase()
user\_data.em = \[crypto.createHash('sha256').update(email).digest('hex')]
}
if (contact.phone) {
const phone = contact.phone.replace(/\D+/g, '')
user\_data.ph = \[crypto.createHash('sha256').update(phone).digest('hex')]
}

// Construir custom\_data
const custom\_data = {}
if (custom\_fields?.amount) {
custom\_data.value = custom\_fields.amount
custom\_data.currency = custom\_fields.currency || 'USD'
}

// Disparar a Meta CAPI y GA4
let metaStatus = 'error', ga4Status = 'error'
try {
const metaResp = await sendToMeta(eventName, user\_data, custom\_data)
metaStatus = metaResp.status
console.log('✅ Meta response:', metaResp.data)
} catch (err) {
console.error('❌ Error Meta CAPI:', err.response?.data || err.message)
metaStatus = err.response?.status || 'error'
}
try {
const ga4Resp = await sendToGA4(eventName, custom\_data, custom\_fields?.client\_id)
ga4Status = ga4Resp.status
console.log(`✅ GA4 ${eventName} sent (status: ${ga4Status})`)
} catch (err) {
console.error('❌ Error GA4:', err.response?.data || err.message)
ga4Status = err.response?.status || 'error'
}

// Guardar log
db.data.logs.push({ timestamp: new Date().toISOString(), type: eventName, metaStatus, ga4Status })
await db.write()

res.json({ success: true })
})

// Endpoints de administración
// Obtener logs y estado
app.get('/admin/logs', async (req, res) => {
await initDb()
res.json({ enabled: db.data.config.enabled, logs: db.data.logs.slice(-100) })
})
// Cambiar on/off
app.post('/admin/config', async (req, res) => {
await initDb()
const { enabled } = req.body
db.data.config.enabled = !!enabled
await db.write()
res.json({ enabled: db.data.config.enabled })
})

// UI mínima en /admin
app.get('/admin', (req, res) => {
res.send(\`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Admin</title></head><body> <h1>Admin Kommo → Ads</h1> <label>Enabled: <input type="checkbox" id="toggle"></label> <h2>Logs</h2><table border="1" id="tbl"><tr><th>Timestamp</th><th>Type</th><th>Meta</th><th>GA4</th></tr></table> <script>
async function load(){ const r=await fetch('/admin/logs'); const d=await r.json(); document.getElementById('toggle').checked=d.enabled; const tbl=document.getElementById('tbl'); tbl.innerHTML='<tr><th>Timestamp</th><th>Type</th><th>Meta</th><th>GA4</th></tr>'; d.logs.forEach(l=>{ const row=tbl.insertRow(); row\.insertCell().textContent=l.timestamp; row\.insertCell().textContent=l.type; row\.insertCell().textContent=l.metaStatus; row\.insertCell().textContent=l.ga4Status; }); }
document.getElementById('toggle').onchange = async e => { await fetch('/admin/config',{ method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ enabled: e.target.checked }) }); };
load(); setInterval(load,15000); </script>

  </body></html>`)
})

// Health check y root
app.get('/healthz', (req, res) => res.sendStatus(200))
app.get('/', (req, res) => res.send('OK'))

// Iniciar servidor
app.listen(port, () => console.log(`✅ Servidor escuchando en puerto ${port}`))
