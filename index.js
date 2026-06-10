const express = require('express');
const { procesarMensajeWhatsApp } = require('./odoo.service');
const mongoose = require('mongoose');
const https = require('https');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'botly-secret-2025';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static('public'));

app.use((req, res, next) => {
  console.log('🌐 Request:', req.method, req.url);
  next();
});

// ===== MONGODB =====
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB conectado ✓'))
  .catch(err => console.log('Error MongoDB:', err));

// ===== SCHEMAS =====
const tenantSchema = new mongoose.Schema({
  nombre: String,
  numero_whatsapp: String,
  activo: { type: Boolean, default: true },
  odoo_team_id: { type: Number, default: 1 },
  config: {
    bienvenida: String,
    sedes: [{ nombre: String, direccion: String, telefono: String, horario: String }],
    menu: [{ opcion: String, respuesta: String }]
  },
  plan: { type: String, default: 'basico', enum: ['basico', 'profesional', 'empresarial'] },
  creado: { type: Date, default: Date.now }
});

const userSchema = new mongoose.Schema({
  nombre: String,
  email: { type: String, unique: true },
  password: String,
  tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  rol: { type: String, default: 'cliente' },
  creado: { type: Date, default: Date.now }
});

const messageLogSchema = new mongoose.Schema({
  tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  from: String,
  message: String,
  response: String,
  fecha: { type: Date, default: Date.now }
});

const leadSchema = new mongoose.Schema({
  nombre: String,
  negocio: String,
  interes: String,
  telefono: String,
  fecha: { type: Date, default: Date.now }
});

const faqSchema = new mongoose.Schema({
  tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  pregunta: String,
  respuesta: String,
  categoria: { type: String, default: 'general' },
  activo: { type: Boolean, default: true },
  creado: { type: Date, default: Date.now }
});

const documentoSchema = new mongoose.Schema({
  tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  nombre: String,
  tipo: { type: String, enum: ['info_general','cuotas','admision','programas','faq','restricciones','comunicacion','imagen','general'], default: 'general' },
  contenido: String,
  activo: { type: Boolean, default: true },
  creado: { type: Date, default: Date.now }
});

const leadDetalladoSchema = new mongoose.Schema({
  tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  nombre: String,
  telefono: String,
  correo: String,
  grado_interes: String,
  zona: String,
  colegio_actual: String,
  nombre_alumno: String,
  edad_alumno: String,
  estado: { type: String, enum: ['nuevo', 'contactado', 'visita_agendada', 'inscrito', 'perdido'], default: 'nuevo' },
  quiere_visita: { type: Boolean, default: false },
  quiere_open_house: { type: Boolean, default: false },
  origen: { type: String, default: 'whatsapp' },
  notas: String,
  fecha: { type: Date, default: Date.now },
  ultima_interaccion: { type: Date, default: Date.now }
});

// ===== SCHEMA SEDES =====
const sedeSchema = new mongoose.Schema({
  tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  nombre:    String,
  direccion: String,
  telefono:  String,
  activa:    { type: Boolean, default: true },
  creado:    { type: Date, default: Date.now }
});

// ===== SCHEMA USUARIO PANEL (roles por cliente) =====
const usuarioPanelSchema = new mongoose.Schema({
  nombre:    String,
  email:     { type: String, unique: true },
  password:  String,
  role:      { type: String, enum: ['admin', 'vendedor', 'viewer'], default: 'vendedor' },
  tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  sedes:     [String],  // nombres de sedes asignadas, o ['todas']
  activo:    { type: Boolean, default: true },
  lastLogin: Date,
  creado:    { type: Date, default: Date.now }
});

const Tenant        = mongoose.model('Tenant', tenantSchema);
const User          = mongoose.model('User', userSchema);
const MessageLog    = mongoose.model('MessageLog', messageLogSchema);
const Lead          = mongoose.model('Lead', leadSchema);
const FAQ           = mongoose.model('FAQ', faqSchema);
const Documento     = mongoose.model('Documento', documentoSchema);
const LeadDetallado = mongoose.model('LeadDetallado', leadDetalladoSchema);
const Sede          = mongoose.model('Sede', sedeSchema);
const UsuarioPanel  = mongoose.model('UsuarioPanel', usuarioPanelSchema);

// ===== MODELO CITA =====
const citaSchema = new mongoose.Schema({
  tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  nombre:    { type: String, required: true },
  telefono:  { type: String },
  grado:     { type: String },
  sede:      { type: String, default: 'Sede Central' },
  fecha:     { type: String },
  hora:      { type: String, default: '09:00 AM' },
  tipo:      { type: String, default: 'open_house' },
  estado:    { type: String, enum: ['confirmada','pendiente','cancelada'], default: 'confirmada' },
  creado:    { type: Date, default: Date.now }
});
const Cita = mongoose.model('Cita', citaSchema);

// ===== MIDDLEWARE AUTH =====
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// =============================================
// ===== SISTEMA DE LÍMITES POR PLAN =====
// =============================================

const PLANES = {
  basico:       { nombre: 'Plan Básico',       mensajes_mes: 500,   precio_q: 1200, max_usuarios: 3  },
  profesional:  { nombre: 'Plan Profesional',  mensajes_mes: 2000,  precio_q: 2000, max_usuarios: 5  },
  empresarial:  { nombre: 'Plan Empresarial',  mensajes_mes: 10000, precio_q: 4500, max_usuarios: 15 }
};

async function verificarLimite(tenantId, planNombre) {
  const plan = PLANES[planNombre] || PLANES.basico;
  const inicioMes = new Date();
  inicioMes.setDate(1);
  inicioMes.setHours(0, 0, 0, 0);
  const usadoMes = await MessageLog.countDocuments({ tenant_id: tenantId, fecha: { $gte: inicioMes } });
  const limite = plan.mensajes_mes;
  return {
    usadoMes, limite,
    restante: limite - usadoMes,
    porcentaje: Math.round((usadoMes / limite) * 100),
    agotado: usadoMes >= limite,
    plan
  };
}

async function notificarAdminSiNecesario(tenant, limite_info) {
  const { usadoMes, limite, porcentaje } = limite_info;
  if (porcentaje >= 90 && porcentaje < 95) {
    const msg = `⚠️ BOTLY ALERTA: "${tenant.nombre}" llegó al ${porcentaje}% de su plan.\n` +
      `Usó ${usadoMes}/${limite} mensajes este mes.\nPlan: ${PLANES[tenant.plan]?.nombre || tenant.plan}\n💡 Oportunidad de ofrecerles upgrade.`;
    const ownerNumber = process.env.OWNER_WHATSAPP;
    if (ownerNumber) await enviarWhatsAppDirecto(ownerNumber, msg).catch(() => {});
  }
}

function enviarWhatsAppDirecto(numero, mensaje) {
  return new Promise((resolve, reject) => {
    const accountSid = process.env.TWILIO_SID;
    const authToken  = process.env.TWILIO_TOKEN;
    const postData   = new URLSearchParams({ From: 'whatsapp:+14155238886', To: `whatsapp:${numero}`, Body: mensaje }).toString();
    const options = {
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64') }
    };
    const req = https.request(options, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject); req.write(postData); req.end();
  });
}

const conversaciones = new Map();

function llamarClaude(systemPrompt, messages, maxTokens = 400) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: maxTokens, system: systemPrompt, messages });
    const options = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(postData) }
    };
    const apiReq = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => { try { resolve(JSON.parse(data).content?.[0]?.text || null); } catch(e) { resolve(null); } });
    });
    apiReq.on('error', () => resolve(null)); apiReq.write(postData); apiReq.end();
  });
}

function detectarIndustria(nombreTenant, bienvenida) {
  const texto = (nombreTenant + ' ' + (bienvenida || '')).toLowerCase();
  if (texto.includes('colegio') || texto.includes('escuela') || texto.includes('admision') || texto.includes('alumno')) return 'colegio';
  if (texto.includes('clinic') || texto.includes('doctor') || texto.includes('medic')) return 'clinica';
  if (texto.includes('farmacia')) return 'farmacia';
  if (texto.includes('restaurante') || texto.includes('comida')) return 'restaurante';
  return 'general';
}

function buildSystemPrompt(tenant) {
  const industria = detectarIndustria(tenant.nombre, tenant.config?.bienvenida);
  const base = `Eres el asistente virtual oficial de "${tenant.nombre}", una institución de prestigio en Guatemala.\n\nSOBRE ESTE NEGOCIO:\n${tenant.config?.bienvenida || ''}\n\nSERVICIOS:\n${(tenant.config?.menu || []).map(m => `▸ ${m.opcion}: ${m.respuesta}`).join('\n')}\n\nUBICACIONES:\n${(tenant.config?.sedes || []).map(s => `📍 ${s.nombre}: ${s.direccion} | Tel: ${s.telefono} | Horario: ${s.horario}`).join('\n')}`;
  const instruccionesColegio = `\nERES: Kai, asistente virtual de admisiones. Cálido, profesional, orientado a resultados.\nMISIÓN: Convertir cada conversación en una visita o inscripción.\nFLUJO: 1)Saluda y pregunta grado 2)Explica beneficios 3)Captura: nombre padre, alumno, grado, zona, colegio actual, correo 4)Ofrece visita o Open House\nREGLAS: Responde de forma natural y cálida como WhatsApp, no como un correo. Si preguntan precios da solo el dato específico que pidieron. Nunca des listas largas ni tablas completas — si quieren más info ellos preguntan. Español guatemalteco. NUNCA inventes datos. NUNCA menciones Claude.`;
  const instruccionesGeneral = `\nINSTRUCCIONES: Responde en español guatemalteco natural. Máximo 4 líneas. Usa emojis con moderación. NUNCA inventes precios. Eres cálido y profesional.`;
  return base + (industria === 'colegio' ? instruccionesColegio : instruccionesGeneral);
}


function buildDocsContext(docs) {
  if (!docs || !docs.length) return '';
  let ctx = '';
  const porCat = { restricciones:[], admision:[], cuotas:[], programas:[], info_general:[], faq:[], comunicacion:[], imagen:[], general:[] };
  docs.forEach(d => { const c = porCat[d.tipo] !== undefined ? d.tipo : 'general'; porCat[c].push(d); });
  if (porCat.restricciones.length)
    ctx += '\n\n⚠️ REGLAS Y RESTRICCIONES (seguir siempre, tienen prioridad):\n' + porCat.restricciones.map(d => d.contenido.substring(0, 4000)).join('\n');
  const orden = ['admision','cuotas','programas','info_general','faq','comunicacion','general'];
  orden.forEach(cat => {
    if (porCat[cat].length)
      ctx += `\n\n=== ${cat.toUpperCase().replace('_',' ')} ===\n` + porCat[cat].map(d => `[${d.nombre}]\n${d.contenido.substring(0, 3000)}`).join('\n\n');
  });
  return ctx;
}
async function responderConIA(tenant, mensajeUsuario, numeroOrigen) {
  if (!conversaciones.has(numeroOrigen)) conversaciones.set(numeroOrigen, []);
  const historial = conversaciones.get(numeroOrigen);
  historial.push({ role: 'user', content: mensajeUsuario });
  if (historial.length > 16) historial.splice(0, 2);
  const systemPrompt = buildSystemPrompt(tenant);
  let contextoExtra = '';
  try {
    const [faqs, docs] = await Promise.all([
      FAQ.find({ tenant_id: tenant._id, activo: true }).limit(20),
      Documento.find({ tenant_id: tenant._id, activo: true }).sort({ tipo: 1, creado: -1 }).limit(15)
    ]);
    if (faqs.length) contextoExtra += '\n\nPREGUNTAS FRECUENTES:\n' + faqs.map(f => `P: ${f.pregunta}\nR: ${f.respuesta}`).join('\n\n');
    contextoExtra += buildDocsContext(docs);
  } catch (e) {}
  const reply = await llamarClaude(systemPrompt + contextoExtra, historial, 600);
  const respuesta = reply || 'Disculpe, tuve un problema técnico. Por favor llámenos directamente. 📞';
  historial.push({ role: 'assistant', content: respuesta });
  return respuesta;
}

// ===== WEBHOOK TWILIO =====
app.post('/webhook', async (req, res) => {
  try {
    const mensajeUsuario = req.body.Body || '';
    const numeroDestino  = req.body.To || '';
    const numeroOrigen   = req.body.From || '';
    const nombreCliente  = req.body.ProfileName || null;
    const numero  = numeroDestino.replace('whatsapp:', '');
    const tenant  = await Tenant.findOne({ numero_whatsapp: numero, activo: true });
    if (tenant) {
      const limite_info = await verificarLimite(tenant._id, tenant.plan);
      if (limite_info.agotado) {
        await enviarWhatsAppDirecto(process.env.OWNER_WHATSAPP, `🚫 BOTLY: "${tenant.nombre}" agotó su plan.`).catch(() => {});
        return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>Nuestro asistente está en mantenimiento. Contáctanos directamente. 🙏</Message></Response>`);
      }
      await notificarAdminSiNecesario(tenant, limite_info);
    }
    const teamId      = tenant?.odoo_team_id || 1;
    const tenantNombre = tenant?.nombre || 'General';
    await procesarMensajeWhatsApp(numeroOrigen.replace('whatsapp:', ''), nombreCliente, mensajeUsuario, teamId, tenantNombre).catch(e => console.error('Odoo:', e.message));
    let respuesta;
    if (!tenant) {
      respuesta = 'Gracias por escribirnos 🙌, pronto te atenderemos.';
    } else {
      respuesta = await responderConIA(tenant, mensajeUsuario, numeroOrigen);
      await MessageLog.create({ tenant_id: tenant._id, from: numeroOrigen, message: mensajeUsuario, response: respuesta });
    }
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${respuesta}</Message></Response>`);
  } catch (err) {
    console.error('❌ WEBHOOK:', err);
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>Error interno.</Message></Response>`);
  }
});

// ===== DEMO / BOLT =====
app.options('/demo', (req, res) => { res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers','Content-Type'); res.sendStatus(200); });
app.post('/demo', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { messages, system, tenant_id } = req.body;
    let contextoExtra = '';
    if (tenant_id) {
      try {
        const [faqs, docs] = await Promise.all([
          FAQ.find({ tenant_id, activo: true }).limit(20),
          Documento.find({ tenant_id, activo: true }).sort({ tipo: 1, creado: -1 }).limit(15)
        ]);
        if (faqs.length) contextoExtra += '\n\nPREGUNTAS FRECUENTES:\n' + faqs.map(f => `P: ${f.pregunta}\nR: ${f.respuesta}`).join('\n\n');
        contextoExtra += buildDocsContext(docs);
      } catch(e) { console.error('Demo docs error:', e.message); }
    }
    const reply = await llamarClaude(system + contextoExtra, messages, 600);
    res.json({ content: [{ type: 'text', text: reply || 'Error interno.' }] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.options('/bolt', (req, res) => { res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers','Content-Type'); res.sendStatus(200); });
app.post('/bolt', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { messages, system, sessionId, telefono } = req.body;
    const telefonoFinal = telefono || `web-${sessionId || Date.now()}`;
    const ultimoMensaje = messages[messages.length - 1]?.content || '';
    const palabrasInteres = ['precio','costo','quiero','necesito','demo','contratar','interesa','bot','automatizar'];
    if (palabrasInteres.some(p => ultimoMensaje.toLowerCase().includes(p)) && messages.length >= 2) {
      await Lead.create({ interes: ultimoMensaje, telefono: telefonoFinal }).catch(() => {});
      await procesarMensajeWhatsApp(telefonoFinal, 'Visitante Web', ultimoMensaje, 1, 'Botly Web').catch(() => {});
    }
    const reply = await llamarClaude(system, messages, 800);
    res.json({ content: [{ type: 'text', text: reply || 'Error.' }] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================
// ===== AUTH — LOGIN + VERIFY =====
// =============================================

app.post('/api/register', async (req, res) => {
  try {
    const { nombre, email, password, tenant_id } = req.body;
    const exists = await User.findOne({ email });
    if (exists) return res.status(400).json({ error: 'Email ya registrado' });
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ nombre, email, password: hash, tenant_id });
    res.json({ ok: true, user: { id: user._id, nombre: user.nombre, email: user.email } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// LOGIN — busca primero en UsuarioPanel (nuevo), luego User legacy
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ ok: false, error: 'Email y contraseña requeridos' });

    let user = await UsuarioPanel.findOne({ email: email.toLowerCase().trim() });
    let isPanel = !!user;
    if (!user) user = await User.findOne({ email }); // fallback legacy

    if (!user) return res.status(401).json({ ok: false, error: 'Usuario no encontrado' });
    if (isPanel && !user.activo) return res.status(403).json({ ok: false, error: 'Usuario desactivado. Contacta al administrador.' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ ok: false, error: 'Contraseña incorrecta' });

    const role = isPanel ? user.role : (user.rol || 'admin');
    const token = jwt.sign(
      { id: user._id, email: user.email, tenant_id: user.tenant_id, role, sedes: user.sedes || [] },
      JWT_SECRET, { expiresIn: '7d' }
    );

    if (isPanel) await UsuarioPanel.findByIdAndUpdate(user._id, { lastLogin: new Date() });

    res.json({
      ok: true, token,
      user: { nombre: user.nombre, email: user.email, role, sedes: user.sedes || [], tenant_id: user.tenant_id }
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// VERIFY TOKEN
app.post('/api/verify', authMiddleware, (req, res) => {
  res.json({ ok: true, user: req.user });
});

// =============================================
// ===== USUARIOS PANEL =====
// =============================================

// GET /api/usuarios — listar usuarios del tenant
app.get('/api/usuarios', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Solo administradores' });
    const users = await UsuarioPanel.find({ tenant_id: req.user.tenant_id }).select('-password').sort({ creado: 1 });
    const tenant = await Tenant.findById(req.user.tenant_id);
    const maxU = PLANES[tenant?.plan]?.max_usuarios || 3;
    res.json({ ok: true, usuarios: users, total: users.length, max: maxU });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/usuarios — crear usuario
app.post('/api/usuarios', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Solo administradores' });
    const { nombre, email, password, role, sedes } = req.body;
    if (!nombre || !email || !password) return res.status(400).json({ ok: false, error: 'Nombre, email y contraseña requeridos' });
    if (!['admin', 'vendedor', 'viewer'].includes(role)) return res.status(400).json({ ok: false, error: 'Rol inválido' });

    const tenant = await Tenant.findById(req.user.tenant_id);
    const maxU   = PLANES[tenant?.plan]?.max_usuarios || 3;
    const total  = await UsuarioPanel.countDocuments({ tenant_id: req.user.tenant_id, activo: true });
    if (total >= maxU) return res.status(403).json({ ok: false, error: `Límite de ${maxU} usuarios para el plan ${tenant?.plan}` });

    const existe = await UsuarioPanel.findOne({ email: email.toLowerCase().trim() });
    if (existe) return res.status(409).json({ ok: false, error: 'Email ya registrado' });

    const hashed = await bcrypt.hash(password, 10);
    const u = await UsuarioPanel.create({
      nombre, email: email.toLowerCase().trim(), password: hashed,
      role, sedes: sedes || [], tenant_id: req.user.tenant_id
    });
    res.json({ ok: true, id: u._id, mensaje: 'Usuario creado' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// PUT /api/usuarios/:id — editar usuario
app.put('/api/usuarios/:id', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Solo administradores' });
    const { nombre, role, sedes, activo, password } = req.body;
    const update = { nombre, role, sedes: sedes || [], activo };
    if (password) update.password = await bcrypt.hash(password, 10);
    await UsuarioPanel.findOneAndUpdate({ _id: req.params.id, tenant_id: req.user.tenant_id }, update);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// =============================================
// ===== SEDES =====
// =============================================

app.get('/api/sedes', authMiddleware, async (req, res) => {
  try {
    const sedes = await Sede.find({ tenant_id: req.user.tenant_id, activa: true });
    res.json({ ok: true, sedes });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/sedes', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Solo administradores' });
    const { nombre, direccion, telefono } = req.body;
    if (!nombre) return res.status(400).json({ ok: false, error: 'Nombre requerido' });
    const s = await Sede.create({ nombre, direccion, telefono, tenant_id: req.user.tenant_id });
    res.json({ ok: true, id: s._id });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.delete('/api/sedes/:id', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Solo administradores' });
    await Sede.findOneAndUpdate({ _id: req.params.id, tenant_id: req.user.tenant_id }, { activa: false });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// =============================================
// ===== SETUP INICIAL DE CLIENTE =====
// Llama UNA VEZ por cliente nuevo con: POST /api/setup-cliente
// Header: x-setup-key: TU_SETUP_KEY (variable Railway)
// =============================================
app.post('/api/setup-cliente', async (req, res) => {
  if (req.headers['x-setup-key'] !== process.env.SETUP_KEY)
    return res.status(403).json({ error: 'Sin autorización' });
  try {
    const { tenantId, adminNombre, adminEmail, adminPassword, sedes } = req.body;
    const tenant = await Tenant.findById(tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant no encontrado. Créalo primero en /tenant' });

    if (sedes?.length) {
      await Sede.insertMany(sedes.map(s => ({
        nombre:    typeof s === 'string' ? s : s.nombre,
        direccion: s.direccion || '',
        telefono:  s.telefono  || '',
        tenant_id: tenant._id
      })));
    }

    const existe = await UsuarioPanel.findOne({ email: adminEmail.toLowerCase() });
    if (existe) return res.status(409).json({ error: 'Admin ya existe para este email' });

    const hashed = await bcrypt.hash(adminPassword, 10);
    await UsuarioPanel.create({
      nombre: adminNombre, email: adminEmail.toLowerCase(),
      password: hashed, role: 'admin',
      tenant_id: tenant._id, sedes: ['todas'], activo: true
    });

    res.json({ ok: true, mensaje: `✅ Setup completo para "${tenant.nombre}". Ya puede iniciar sesión con ${adminEmail}` });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// =============================================
// ===== PANEL API =====
// =============================================

app.get('/api/mi-bot', authMiddleware, async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.user.tenant_id);
    if (!tenant) return res.status(404).json({ error: 'Bot no encontrado' });
    res.json(tenant);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/mi-bot', authMiddleware, async (req, res) => {
  try {
    const tenant = await Tenant.findByIdAndUpdate(req.user.tenant_id, req.body, { new: true });
    res.json({ ok: true, tenant });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/mis-mensajes', authMiddleware, async (req, res) => {
  try {
    const logs = await MessageLog.find({ tenant_id: req.user.tenant_id }).sort({ fecha: -1 }).limit(50);
    res.json(logs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/estadisticas', authMiddleware, async (req, res) => {
  try {
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0,0,0,0);
    const totalHoy = await MessageLog.countDocuments({ tenant_id: req.user.tenant_id, fecha: { $gte: hoy } });
    const totalMes  = await MessageLog.countDocuments({ tenant_id: req.user.tenant_id, fecha: { $gte: inicioMes } });
    const tenant = await Tenant.findById(req.user.tenant_id);
    const plan   = PLANES[tenant?.plan] || PLANES.basico;
    res.json({ hoy: totalHoy, mes: totalMes, plan: { nombre: plan.nombre, limite_mensajes: plan.mensajes_mes, usados: totalMes, restantes: Math.max(plan.mensajes_mes - totalMes, 0), porcentaje_usado: Math.min(Math.round((totalMes / plan.mensajes_mes) * 100), 100), agotado: totalMes >= plan.mensajes_mes } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================
// ===== ODOO =====
// =============================================
const ODOO_URL  = 'odoo-botly.skysize.io';
const ODOO_DB   = 'main-xv8crc';
const ODOO_USER_ODOO = 'admin';
const ODOO_PASS_ODOO = process.env.ODOO_PASSWORD || 'admin';
let odooUID = null;

function odooRPC(path, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'call', id: Math.floor(Math.random() * 99999), params });
    const options = { hostname: ODOO_URL, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
    const req = https.request(options, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { const p = JSON.parse(d); if (p.error) reject(new Error(JSON.stringify(p.error).substring(0,200))); else resolve(p.result); } catch(e) { reject(e); } }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

async function getOdooUID() {
  if (odooUID) return odooUID;
  odooUID = await odooRPC('/jsonrpc', { service: 'common', method: 'authenticate', args: [ODOO_DB, ODOO_USER_ODOO, ODOO_PASS_ODOO, {}] });
  if (!odooUID) throw new Error('Odoo auth fallida');
  return odooUID;
}

async function odooCallLocal(model, method, args, kwargs = {}) {
  const uid = await getOdooUID();
  return odooRPC('/jsonrpc', { service: 'object', method: 'execute_kw', args: [ODOO_DB, uid, ODOO_PASS_ODOO, model, method, args, kwargs] });
}

app.get('/api/cotizaciones', authMiddleware, async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.user.tenant_id);
    const teamId = tenant?.odoo_team_id || 1;
    const periodo = req.query.periodo || 'mes';
    const ahora = new Date(); let fechaDesde = new Date();
    if (periodo === 'hoy') { fechaDesde.setHours(0,0,0,0); }
    else if (periodo === 'semana') { fechaDesde.setDate(ahora.getDate()-7); }
    else { fechaDesde.setDate(1); fechaDesde.setHours(0,0,0,0); }
    const fechaOdoo = fechaDesde.toISOString().replace('T',' ').substring(0,19);
    const cotizaciones = await odooCallLocal('sale.order','search_read',[[['team_id','=',teamId],['create_date','>=',fechaOdoo]]],{ fields:['name','partner_id','amount_total','state','create_date'], order:'create_date desc', limit:50 });
    const ganadas = cotizaciones.filter(c => c.state==='sale'||c.state==='done');
    const totalVentas = ganadas.reduce((s,c) => s+(c.amount_total||0), 0);
    res.json({ ok:true, periodo, resumen:{ totalVentas: Math.round(totalVentas*100)/100, totalCotizaciones:cotizaciones.length, cotizacionesGanadas:ganadas.length, ticketPromedio: ganadas.length ? Math.round(totalVentas/ganadas.length*100)/100 : 0 }, cotizaciones: cotizaciones.map(c => ({ id:c.id, nombre:c.name, cliente:c.partner_id?.[1]||'Sin nombre', monto:c.amount_total||0, estado:c.state, fecha:c.create_date })) });
  } catch (err) { res.json({ ok:false, error:err.message, resumen:{ totalVentas:0, totalCotizaciones:0, cotizacionesGanadas:0, ticketPromedio:0 }, cotizaciones:[] }); }
});

app.get('/api/crm-leads', authMiddleware, async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.user.tenant_id);
    const leads = await odooCallLocal('crm.lead','search_read',[[['team_id','=',tenant?.odoo_team_id||1],['active','=',true]]],{ fields:['name','phone','stage_id','partner_name','create_date'], order:'create_date desc', limit:100 });
    const porEtapa = {}; leads.forEach(l => { const e = l.stage_id?.[1]||'Sin etapa'; porEtapa[e]=(porEtapa[e]||0)+1; });
    res.json({ ok:true, total:leads.length, porEtapa, leads });
  } catch (err) { res.json({ ok:false, total:0, porEtapa:{}, leads:[] }); }
});

// ===== FAQs =====
app.get('/api/faqs',    authMiddleware, async (req, res) => { try { res.json(await FAQ.find({ tenant_id: req.user.tenant_id, activo: true }).sort({ creado: -1 })); } catch (err) { res.status(500).json({ error: err.message }); } });
app.post('/api/faqs',   authMiddleware, async (req, res) => { try { const { pregunta, respuesta, categoria } = req.body; if (!pregunta||!respuesta) return res.status(400).json({ error: 'Pregunta y respuesta requeridas' }); res.json({ ok:true, faq: await FAQ.create({ tenant_id: req.user.tenant_id, pregunta, respuesta, categoria: categoria||'general' }) }); } catch (err) { res.status(500).json({ error: err.message }); } });
app.put('/api/faqs/:id', authMiddleware, async (req, res) => { try { res.json({ ok:true, faq: await FAQ.findOneAndUpdate({ _id: req.params.id, tenant_id: req.user.tenant_id }, req.body, { new:true }) }); } catch (err) { res.status(500).json({ error: err.message }); } });
app.delete('/api/faqs/:id', authMiddleware, async (req, res) => { try { await FAQ.findOneAndUpdate({ _id: req.params.id, tenant_id: req.user.tenant_id }, { activo: false }); res.json({ ok:true }); } catch (err) { res.status(500).json({ error: err.message }); } });

// ===== DOCUMENTOS =====
app.get('/api/documentos',     authMiddleware, async (req, res) => { try { res.json(await Documento.find({ tenant_id: req.user.tenant_id, activo: true }).sort({ creado: -1 })); } catch (err) { res.status(500).json({ error: err.message }); } });
app.post('/api/documentos',    authMiddleware, async (req, res) => { try { const { nombre, tipo, contenido } = req.body; if (!nombre||!contenido) return res.status(400).json({ error: 'Nombre y contenido requeridos' }); res.json({ ok:true, doc: await Documento.create({ tenant_id: req.user.tenant_id, nombre, tipo: tipo||'general', contenido }) }); } catch (err) { res.status(500).json({ error: err.message }); } });
app.put('/api/documentos/:id', authMiddleware, async (req, res) => { try { res.json({ ok:true, doc: await Documento.findOneAndUpdate({ _id: req.params.id, tenant_id: req.user.tenant_id }, req.body, { new:true }) }); } catch (err) { res.status(500).json({ error: err.message }); } });
app.delete('/api/documentos/:id', authMiddleware, async (req, res) => { try { await Documento.findOneAndUpdate({ _id: req.params.id, tenant_id: req.user.tenant_id }, { activo: false }); res.json({ ok:true }); } catch (err) { res.status(500).json({ error: err.message }); } });

// ===== LEADS DETALLADOS =====
app.get('/api/leads-detallados', authMiddleware, async (req, res) => { try { const { estado } = req.query; const filtro = { tenant_id: req.user.tenant_id }; if (estado) filtro.estado = estado; res.json(await LeadDetallado.find(filtro).sort({ fecha: -1 }).limit(100)); } catch (err) { res.status(500).json({ error: err.message }); } });
app.post('/api/leads-detallados', authMiddleware, async (req, res) => { try { res.json({ ok:true, lead: await LeadDetallado.create({ tenant_id: req.user.tenant_id, ...req.body }) }); } catch (err) { res.status(500).json({ error: err.message }); } });
app.put('/api/leads-detallados/:id', authMiddleware, async (req, res) => { try { res.json({ ok:true, lead: await LeadDetallado.findOneAndUpdate({ _id: req.params.id, tenant_id: req.user.tenant_id }, { ...req.body, ultima_interaccion: new Date() }, { new:true }) }); } catch (err) { res.status(500).json({ error: err.message }); } });
app.get('/api/leads-stats', authMiddleware, async (req, res) => { try { const tid = req.user.tenant_id; const estados = ['nuevo','contactado','visita_agendada','inscrito','perdido']; const counts = await Promise.all(estados.map(e => LeadDetallado.countDocuments({ tenant_id: tid, estado: e }))); const pipeline = {}; estados.forEach((e,i) => pipeline[e] = counts[i]); res.json({ total: counts.reduce((a,b)=>a+b,0), pipeline }); } catch (err) { res.status(500).json({ error: err.message }); } });

// ===== AGENDAR CITA =====
app.post('/api/agendar-cita', async (req, res) => {
  try {
    const { nombre, telefono, grado, fecha, hora, tipo, sede } = req.body;
    if (!nombre||!telefono||!fecha) return res.status(400).json({ error: 'Nombre, teléfono y fecha requeridos' });
    let leadId = null;
    try {
      const leads = await odooCallLocal('crm.lead','search_read',[[['phone','=',telefono],['active','=',true]]],{ fields:['id','name'], limit:1 });
      if (leads.length) { leadId = leads[0].id; }
      else { leadId = await odooCallLocal('crm.lead','create',[{ name:`Open House — ${nombre}`, phone:telefono, partner_name:nombre, description:`Interés: ${grado||'N/A'}\nTipo: ${tipo||'open_house'}`, team_id:1 }]); }
      const fechaHora = `${fecha} ${hora?.replace(' AM','').replace(' PM','')||'09:00'}:00`;
      await odooCallLocal('mail.activity','create',[{ res_model:'crm.lead', res_id:leadId, activity_type_id:1, summary:`Open House — ${grado}`, note:`Padre: ${nombre}\nTel: ${telefono}\nGrado: ${grado}\nFecha: ${fecha} ${hora}`, date_deadline:fecha, user_id:2 }]);
    } catch (odooErr) { console.error('⚠️ Odoo cita:', odooErr.message); }

    // Guardar en MongoDB también
    try {
      const tenantId = req.body.tenant_id;
      await Cita.create({ tenant_id: tenantId, nombre, telefono, grado, sede: sede||'Sede Central', fecha, hora: hora||'09:00 AM', tipo: tipo||'open_house', estado: 'confirmada' });
    } catch(e) { console.warn('Cita MongoDB:', e.message); }

    res.json({ ok:true, odoo_id:leadId, mensaje:`Cita agendada para ${nombre} el ${fecha} a las ${hora}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== CITAS — GET y gestión =====
app.get('/api/citas', authMiddleware, async (req, res) => {
  try {
    const citas = await Cita.find({ tenant_id: req.user.tenant_id }).sort({ creado: -1 }).limit(100);
    res.json({ ok: true, citas });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/citas/:id', authMiddleware, async (req, res) => {
  try {
    const cita = await Cita.findOneAndUpdate(
      { _id: req.params.id, tenant_id: req.user.tenant_id },
      req.body, { new: true }
    );
    res.json({ ok: true, cita });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== CAMPAÑA DE PRUEBA — enviar mensaje a un número =====
app.post('/api/campana/prueba', authMiddleware, async (req, res) => {
  try {
    const { telefono, mensaje } = req.body;
    if (!telefono || !mensaje) return res.status(400).json({ error: 'Teléfono y mensaje requeridos' });

    const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
    const TOKEN_WA = process.env.WHATSAPP_TOKEN;

    if (!PHONE_ID || !TOKEN_WA) {
      return res.status(400).json({ error: 'WhatsApp no configurado. Agrega WHATSAPP_PHONE_ID y WHATSAPP_TOKEN en Railway.' });
    }

    const https = require('https');
    const body = JSON.stringify({
      messaging_product: 'whatsapp',
      to: telefono.replace(/\D/g,''),
      type: 'text',
      text: { body: mensaje }
    });

    const result = await new Promise((resolve, reject) => {
      const req2 = https.request({
        hostname: 'graph.facebook.com',
        path: `/v19.0/${PHONE_ID}/messages`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TOKEN_WA}`,
          'Content-Length': Buffer.byteLength(body)
        }
      }, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({ raw: d }); } });
      });
      req2.on('error', reject);
      req2.write(body);
      req2.end();
    });

    if (result.messages) {
      res.json({ ok: true, mensaje: 'Mensaje enviado correctamente', id: result.messages[0]?.id });
    } else {
      res.status(400).json({ ok: false, error: result.error?.message || 'Error al enviar', detalle: result });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ===== EXTRACCIÓN DE TEXTO VIA CLAUDE API =====
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.post('/api/documentos/extraer-texto', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No se recibió archivo' });

    const filename = req.file.originalname.toLowerCase();
    const base64 = req.file.buffer.toString('base64');

    // TXT — leer directo sin Claude
    if (filename.endsWith('.txt')) {
      const texto = req.file.buffer.toString('utf-8');
      return res.json({ ok: true, texto, caracteres: texto.length });
    }

    // PDF o DOCX — usar Claude para extraer texto
    const mediaType = filename.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    const postData = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: mediaType, data: base64 }
          },
          {
            type: 'text',
            text: 'Extrae TODO el texto de este documento. Devuelve SOLO el texto extraído, sin comentarios, sin formato markdown, sin explicaciones. Si hay tablas, conviértelas a texto plano. Si hay imágenes con texto, inclúyelo también.'
          }
        ]
      }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const texto = await new Promise((resolve, reject) => {
      const apiReq = https.request(options, (apiRes) => {
        let data = '';
        apiRes.on('data', chunk => data += chunk);
        apiRes.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.content?.[0]?.text || null);
          } catch(e) { resolve(null); }
        });
      });
      apiReq.on('error', reject);
      apiReq.write(postData);
      apiReq.end();
    });

    if (!texto) return res.json({ ok: false, error: 'No se pudo extraer texto. Pega el contenido manualmente.' });

    res.json({ ok: true, texto: texto.trim(), caracteres: texto.length });

  } catch(err) {
    console.error('Error extracción:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===== ADMIN =====
app.get('/api/leads', async (req, res) => { res.json(await Lead.find().sort({ fecha: -1 }).limit(50)); });
app.get('/tenants', async (req, res) => { res.json(await Tenant.find()); });
app.post('/tenant', async (req, res) => { try { res.json({ ok:true, tenant: await new Tenant(req.body).save() }); } catch (err) { res.status(500).json({ error: err.message }); } });
app.put('/tenant/:id', async (req, res) => { try { res.json({ ok:true, tenant: await Tenant.findByIdAndUpdate(req.params.id, req.body, { new:true }) }); } catch (err) { res.status(500).json({ error: err.message }); } });

app.get('/api/admin/limites', async (req, res) => {
  try {
    const tenants = await Tenant.find({ activo: true });
    const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0,0,0,0);
    const resumen = await Promise.all(tenants.map(async (t) => {
      const usado = await MessageLog.countDocuments({ tenant_id: t._id, fecha: { $gte: inicioMes } });
      const plan  = PLANES[t.plan] || PLANES.basico;
      return { nombre:t.nombre, plan:t.plan, usado, limite:plan.mensajes_mes, porcentaje:Math.round((usado/plan.mensajes_mes)*100), agotado:usado>=plan.mensajes_mes, restante:Math.max(plan.mensajes_mes-usado,0) };
    }));
    res.json({ mes: new Date().toLocaleDateString('es-GT',{ month:'long', year:'numeric' }), tenants: resumen });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/test', (req, res) => res.send('OK'));

// ===== ODOO PRODUCCIÓN — CAPOUILLIEZ =====
const { testConexion, getLeads, getLeadsPerdidos, getStages, getTeams, getLostReasons, getTags, getUsuarios } = require('./odoo.service');

app.get('/api/odoo/test', authMiddleware, async (req, res) => {
  try {
    const info = await testConexion();
    if (!info) return res.status(500).json({ ok: false, error: 'No se pudo conectar a Odoo' });
    res.json({ ok: true, version: info.server_version, serie: info.server_serie });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/odoo/leads', authMiddleware, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 200;
    const leads = await getLeads(limit);
    if (!leads) return res.status(500).json({ ok: false, error: 'Error al traer leads' });
    res.json({ ok: true, total: leads.length, leads });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/odoo/leads/perdidos', authMiddleware, async (req, res) => {
  try {
    const leads = await getLeadsPerdidos(500);
    res.json({ ok: true, total: leads?.length||0, leads: leads||[] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/odoo/stages', authMiddleware, async (req, res) => {
  try {
    const stages = await getStages();
    res.json({ ok: true, stages: stages||[] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/odoo/teams', authMiddleware, async (req, res) => {
  try {
    const teams = await getTeams();
    res.json({ ok: true, teams: teams||[] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/odoo/lost-reasons', authMiddleware, async (req, res) => {
  try {
    const reasons = await getLostReasons();
    res.json({ ok: true, reasons: reasons||[] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/odoo/tags', authMiddleware, async (req, res) => {
  try {
    const tags = await getTags();
    res.json({ ok: true, tags: tags||[] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/odoo/usuarios', authMiddleware, async (req, res) => {
  try {
    const usuarios = await getUsuarios();
    res.json({ ok: true, usuarios: usuarios||[] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/odoo/dashboard', authMiddleware, async (req, res) => {
  try {
    const [leads, perdidos, stages, reasons, tags] = await Promise.all([
      getLeads(500), getLeadsPerdidos(500), getStages(), getLostReasons(), getTags()
    ]);
    const porEtapa={}, porUsuario={}, porMotivo={};
    (leads||[]).forEach(l=>{
      const e=l.stage_id?.[1]||'Sin etapa'; porEtapa[e]=(porEtapa[e]||0)+1;
      const u=l.user_id?.[1]||'Sin asignar'; porUsuario[u]=(porUsuario[u]||0)+1;
    });
    (perdidos||[]).forEach(l=>{
      const m=l.lost_reason_id?.[1]||'Sin motivo'; porMotivo[m]=(porMotivo[m]||0)+1;
    });
    res.json({
      ok:true,
      resumen:{ totalLeads:(leads||[]).length, totalPerdidos:(perdidos||[]).length, totalEtapas:(stages||[]).length },
      porEtapa, porUsuario, porMotivo,
      ultimosLeads:(leads||[]).slice(0,10),
      stages:stages||[], reasons:reasons||[], tags:tags||[]
    });
  } catch (err) { res.status(500).json({ ok:false, error:err.message }); }
});

// ===== ODOO PRODUCCIÓN — CAPOUILLIEZ =====
const { testConexion, getLeads, getLeadsPerdidos, getStages, getTeams, getLostReasons, getTags, getUsuarios } = require('./odoo.service');

app.get('/api/odoo/test', authMiddleware, async (req, res) => {
  try {
    const info = await testConexion();
    if (!info) return res.status(500).json({ ok: false, error: 'No se pudo conectar a Odoo' });
    res.json({ ok: true, version: info.server_version, serie: info.server_serie });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/odoo/leads', authMiddleware, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 200;
    const leads = await getLeads(limit);
    if (!leads) return res.status(500).json({ ok: false, error: 'Error al traer leads' });
    res.json({ ok: true, total: leads.length, leads });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/odoo/leads/perdidos', authMiddleware, async (req, res) => {
  try {
    const leads = await getLeadsPerdidos(500);
    res.json({ ok: true, total: leads?.length || 0, leads: leads || [] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/odoo/stages', authMiddleware, async (req, res) => {
  try {
    const stages = await getStages();
    res.json({ ok: true, stages: stages || [] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/odoo/teams', authMiddleware, async (req, res) => {
  try {
    const teams = await getTeams();
    res.json({ ok: true, teams: teams || [] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/odoo/lost-reasons', authMiddleware, async (req, res) => {
  try {
    const reasons = await getLostReasons();
    res.json({ ok: true, reasons: reasons || [] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/odoo/tags', authMiddleware, async (req, res) => {
  try {
    const tags = await getTags();
    res.json({ ok: true, tags: tags || [] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/odoo/usuarios', authMiddleware, async (req, res) => {
  try {
    const usuarios = await getUsuarios();
    res.json({ ok: true, usuarios: usuarios || [] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Dashboard marketing — un solo endpoint
app.get('/api/odoo/dashboard', authMiddleware, async (req, res) => {
  try {
    const [leads, perdidos, stages, reasons, tags, usuarios] = await Promise.all([
      getLeads(500), getLeadsPerdidos(500), getStages(),
      getLostReasons(), getTags(), getUsuarios()
    ]);
    const porEtapa = {}, porUsuario = {}, porMotivo = {};
    (leads||[]).forEach(l => {
      const e = l.stage_id?.[1]||'Sin etapa';
      porEtapa[e] = (porEtapa[e]||0)+1;
      const u = l.user_id?.[1]||'Sin asignar';
      porUsuario[u] = (porUsuario[u]||0)+1;
    });
    (perdidos||[]).forEach(l => {
      const m = l.lost_reason_id?.[1]||'Sin motivo';
      porMotivo[m] = (porMotivo[m]||0)+1;
    });
    res.json({
      ok: true,
      resumen: { totalLeads:(leads||[]).length, totalPerdidos:(perdidos||[]).length, totalEtapas:(stages||[]).length },
      porEtapa, porUsuario, porMotivo,
      ultimosLeads: (leads||[]).slice(0,10),
      stages: stages||[], reasons: reasons||[], tags: tags||[]
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.get('/', (req, res) => res.sendFile('index.html', { root: 'public' }));

app.listen(PORT, () => {
  console.log(`✅ Botly corriendo en puerto ${PORT}`);
  console.log(`📊 Planes: Básico(${PLANES.basico.mensajes_mes}msg/${PLANES.basico.max_usuarios}usr) | Profesional(${PLANES.profesional.mensajes_mes}msg/${PLANES.profesional.max_usuarios}usr) | Empresarial(${PLANES.empresarial.mensajes_mes}msg/${PLANES.empresarial.max_usuarios}usr)`);
});
