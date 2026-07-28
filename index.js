const express = require('express');
const { procesarMensajeWhatsApp, testConexion, getLeads, getLeadsPerdidos, getStages, getTeams, getLostReasons, getTags, getUsuarios } = require('./odoo.service');
const mongoose = require('mongoose');
const https = require('https');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
// xlsx es OPCIONAL — si no está instalada en el servidor, no debe tumbar TODO KAI (eso
// fue justo lo que pasó: al no estar en package.json, el require() de la línea de abajo
// hacía fallar el arranque completo del programa, y por eso Railway respondía
// "Application failed to respond" en TODOS los endpoints, no solo en el del reporte).
let XLSX = null;
try { XLSX = require('xlsx'); } catch (e) { console.error('⚠️ xlsx no está instalada — el reporte en Excel no va a funcionar hasta que se agregue a package.json. El resto de KAI sigue funcionando normal.'); }

dotenv.config();

// ===== INTERRUPTOR MAESTRO — KAI PAUSADO EN PRODUCCIÓN =====
// Activado el 24/07/2026 a solicitud del equipo: demasiados inconvenientes en un mismo
// día (leads duplicados, papás atendidos a medias, ajustes de horario pendientes,
// cambio de formularios en camino). Mientras esto sea TRUE:
//   - KAI NO responde a NINGÚN número real, en NINGÚN canal (WhatsApp, AcruxLab)
//   - KAI NO contacta leads nuevos de forma proactiva
//   - Los NÚMEROS DE PRUEBA siguen funcionando exactamente igual que siempre, para que
//     el equipo pueda seguir probando con confianza mientras se van liberando partes
// Para reactivar KAI en producción: cambiar esta línea a false.
const KAI_PAUSADO_PARA_PRODUCCION = true;

// ===== NÚMEROS DE PRUEBA =====
// Son los del equipo que prueban el sistema. KAI SIEMPRE los atiende (aunque figuren
// como oportunidad o tengan vendedor), y NUNCA se les crea lead en Odoo ni se cuentan
// como candidatos. Así se puede probar cuantas veces se quiera sin ensuciar el CRM
// ni quedar bloqueado por las reglas de negocio.
const NUMEROS_DE_PRUEBA = [
  '50252060423', // Luvy — IT / pruebas
  '50230066358', // Sylvia Flores — admisiones / pruebas
];

function esNumeroDePrueba(numero) {
  const limpio = String(numero || '').replace(/\D/g, '');
  if (!limpio) return false;
  return NUMEROS_DE_PRUEBA.some(n => {
    const nl = String(n).replace(/\D/g, '');
    return nl.length >= 8 && limpio.slice(-8) === nl.slice(-8);
  });
}

// Consulta el nombre real del usuario de Instagram/Messenger vía la Graph API de Meta.
// Antes se guardaba "null" a propósito y el contacto quedaba visible solo como
// "fb_25568420539447877" o "Sin nombre" — esto intenta traer el nombre real que Meta
// ya tiene disponible para cualquier persona que le haya escrito a la página.
async function obtenerNombreFacebook(psid, token) {
  if (!psid || !token) return null;
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'graph.facebook.com',
      path: `/v22.0/${psid}?fields=name&access_token=${token}`,
      method: 'GET'
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json?.name || null);
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

const VERSION_KAI = 'v2026.07.20-probar-solo-lectura'; // Cambia esta línea cada vez que subas un cambio importante, para verificar en /api/version
const SERVIDOR_INICIADO = Date.now();
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('❌ FATAL: JWT_SECRET no está configurado en las variables de entorno'); process.exit(1); }

// ===== SEGURIDAD =====
// CORS — solo acepta peticiones del panel y del webhook de Meta
const origenesPermitidos = [
  'https://kai-capouilliez.up.railway.app',
  'https://www.capouilliez.edu.gt',
  /\.railway\.app$/
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // peticiones server-to-server (webhook Meta, Odoo)
    const ok = origenesPermitidos.some(o => typeof o === 'string' ? o === origin : o.test(origin));
    ok ? cb(null, true) : cb(new Error('CORS bloqueado: origen no permitido'));
  },
  credentials: true
}));

// Rate limiting manual — máximo 60 peticiones por minuto por IP para el API
const _rateMap = new Map();
app.use('/api/', (req, res, next) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const ahora = Date.now();
  const ventana = 60 * 1000; // 1 minuto
  const limite = 120; // 120 req/min por IP
  const entry = _rateMap.get(ip) || { count: 0, inicio: ahora };
  if (ahora - entry.inicio > ventana) { entry.count = 1; entry.inicio = ahora; }
  else entry.count++;
  _rateMap.set(ip, entry);
  if (entry.count > limite) return res.status(429).json({ ok: false, error: 'Demasiadas peticiones. Intenta en un momento.' });
  next();
});

// Headers de seguridad básicos (sin helmet, usando solo lo necesario)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

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
  canal: { type: String, default: 'whatsapp' }, // canal de origen para trazabilidad
  procesado: { type: Boolean, default: true },   // false = llegó pero falló el proceso
  error: { type: String, default: null },        // si procesado=false, aquí está el motivo
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

// ===== MODELO IMAGEN MARKETING — fotos reales para enviar por WhatsApp =====
const imagenMarketingSchema = new mongoose.Schema({
  tenant_id:   { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  nombre:      { type: String, required: true }, // ej: "Fachada principal", "Laboratorio de ciencias"
  categoria:   { type: String, enum: ['cuotas','admision','programas','info_general','academia_aha','instalaciones','aulas','deportes','eventos','open_house','graduacion','general'], default: 'general' },
  nivel_educativo: { type: String, enum: ['Jardín','Preprimaria','Kínder','Primaria','Básico','Secundaria','Bachillerato','Todos'], default: 'Todos' },
  imagen_base64: { type: String, required: true }, // imagen codificada, se sube vía panel
  mime_type:   { type: String, default: 'image/jpeg' },
  subida_por:  { type: mongoose.Schema.Types.ObjectId, ref: 'UsuarioPanel' },
  subida_por_nombre: { type: String },
  activo:      { type: Boolean, default: true },
  caption:      { type: String, default: '' }, // texto predefinido para enviar con la imagen
  prioridad:    { type: Number, default: 0 }, // más alto = se manda primero si hay varias coincidencias posibles
  veces_enviada: { type: Number, default: 0 },
  creado:      { type: Date, default: Date.now }
});
const ImagenMarketing = mongoose.model('ImagenMarketing', imagenMarketingSchema);

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
  disponible: { type: Boolean, default: true }, // si puede recibir chats en vivo asignados
  disponible_manual: { type: Boolean, default: false }, // true si el agente lo apagó a propósito (no reactivar automático)
  odoo_user_id: { type: Number, default: null }, // ID del usuario correspondiente en Odoo (res.users), para asignar el vendedor ahí también
  ultima_actividad: { type: Date, default: Date.now }, // última vez que usó el panel — para auto-disponibilidad
  lastLogin: Date,
  creado:    { type: Date, default: Date.now }
});

// ===== MODELO CONVERSACIÓN — para handoff a humano =====
const conversacionSchema = new mongoose.Schema({
  tenant_id:     { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  numero:        { type: String, required: true },
  nombre:        String,
  canal:         { type: String, enum: ['whatsapp','instagram','messenger','acrux','otro'], default: 'whatsapp' },
  estado:        { type: String, enum: ['bot', 'esperando_agente', 'humano', 'cerrado'], default: 'bot' },
  agente_id:     { type: mongoose.Schema.Types.ObjectId, ref: 'UsuarioPanel', default: null },
  agente_nombre: { type: String, default: null },
  motivo:        { type: String, default: null },
  resumen_kai:   { type: String, default: null },
  resumen_agente:{ type: String, default: null },
  mensajes:      [{
    de:     { type: String, enum: ['padre', 'bot', 'agente'] },
    texto:  String,
    imagen_base64: { type: String, default: null }, // solo si el mensaje incluye una imagen real (no solo descripción)
    imagen_mime:   { type: String, default: null },
    fecha:  { type: Date, default: Date.now }
  }],
  ultimaActividad: { type: Date, default: Date.now },
  creado:        { type: Date, default: Date.now },
  // Solo aplica a Instagram/Messenger (canal de solo lectura, no se puede responder).
  // Equivalente a "Soltar" en Odoo: marca el lead como ya revisado, para que salga de
  // "esperando respuesta" sin necesidad de contestar.
  revisado_social: { type: Boolean, default: false }
});
const Conversacion = mongoose.model('Conversacion', conversacionSchema);

// ===== ASIGNACIÓN DE ACRUXLAB (número oficial) — control propio, no vive en Odoo =====
// Odoo/AcruxLab no tiene un concepto de "asignado a X vendedor" — solo sabemos quién
// respondió el último mensaje. Para poder repartir 1 a 1 desde que llega el mensaje
// (antes de que alguien responda), llevamos esta asignación en nuestro propio sistema.
const asignacionAcruxSchema = new mongoose.Schema({
  tenant_id:     { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  contacto_id:   { type: Number, required: true }, // ID de acrux.chat.conversation
  agente_id:     { type: mongoose.Schema.Types.ObjectId, ref: 'UsuarioPanel' },
  agente_nombre: String,
  fecha_asignado:{ type: Date, default: Date.now },
  modo:          { type: String, enum: ['bot', 'humano'], default: 'bot' }, // ¿KAI responde o ya es de un humano?
  fecha_modo_humano: { type: Date, default: null }, // cuándo pasó a modo humano — para la auto-recuperación a los 30 min
  sin_auto_recuperacion: { type: Boolean, default: false }, // true = KAI nunca retoma este chat solo (ej. Oportunidades de Sylvia)
  resumen_kai: { type: String, default: null } // resumen generado por IA de lo que ya habló KAI, para que el agente no repita preguntas
});
asignacionAcruxSchema.index({ tenant_id: 1, contacto_id: 1 }, { unique: true });
const AsignacionAcrux = mongoose.model('AsignacionAcrux', asignacionAcruxSchema);

// ===== MODELO CONTACTO — memoria persistente del padre/madre =====
// ===== RESPALDO DE MENSAJES DE ACRUXLAB =====
// Copia propia, en nuestra base de datos, de cada mensaje de AcruxLab. Independiente de
// Odoo por completo — si algo le pasa a los datos de Odoo (se pierden, se archivan, el
// módulo falla), esta copia sigue existiendo. Se llena con /api/debug/respaldar-mensajes.
const mensajeRespaldoSchema = new mongoose.Schema({
  tenant_id: { type: mongoose.Schema.Types.ObjectId, required: true },
  contacto_id_acrux: { type: Number, required: true, index: true }, // ID de la conversación en Odoo
  numero: { type: String, index: true },
  mensaje_id_odoo: { type: Number, required: true },
  de: { type: String }, // 'colegio' o 'padre'
  autor: { type: String, default: null },
  texto: { type: String, default: '' },
  fecha_mensaje: { type: Date },
  respaldado_en: { type: Date, default: Date.now }
});
mensajeRespaldoSchema.index({ tenant_id: 1, mensaje_id_odoo: 1 }, { unique: true }); // no duplicar el mismo mensaje dos veces
const MensajeRespaldo = mongoose.model('MensajeRespaldo', mensajeRespaldoSchema);

const contactoSchema = new mongoose.Schema({
  tenant_id:      { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  numero:         { type: String, required: true },
  nombre:         { type: String, default: null },
  nombre_alumno:  { type: String, default: null },
  nivel_interes:  { type: String, default: null }, // Preprimaria/Primaria/Básico/Bachillerato
  fecha_nacimiento_alumno: { type: String, default: null },
  zona:           { type: String, default: null },
  colegio_actual: { type: String, default: null },
  correo:         { type: String, default: null },
  resumen_ultimo_contacto: { type: String, default: null }, // qué se habló la última vez
  odoo_lead_id:   { type: Number, default: null }, // si ya se creó como candidato en Odoo
  nivel_calor:    { type: Number, default: null }, // 1=Alta Intención, 2=Interesado, 3=Exploratorio
  nivel_calor_etiqueta: { type: String, default: null }, // texto de la etiqueta aplicada en Odoo
  canal_origen:   { type: String, enum: ['whatsapp','instagram','messenger','lead_ads','formulario','otro'], default: 'whatsapp' },
  total_conversaciones: { type: Number, default: 0 },

  // ===== MARKETING Y REACTIVACIÓN =====
  acepta_marketing: { type: Boolean, default: null }, // null = no se le ha preguntado aún
  acepta_marketing_fecha: { type: Date, default: null },
  segmento_reactivacion: { type: String, enum: ['activo', 'seguimiento', 'reactivacion', 'frio'], default: 'activo' },
  ultima_campana_enviada: { type: Date, default: null },
  campanas_recibidas: { type: Number, default: 0 },

  primer_contacto: { type: Date, default: Date.now },
  ultimo_contacto: { type: Date, default: Date.now }
}, { timestamps: true });
contactoSchema.index({ tenant_id: 1, numero: 1 }, { unique: true });
const Contacto = mongoose.model('Contacto', contactoSchema);

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
    // Actualizar última actividad del agente (fire-and-forget, no bloquea la respuesta).
    // Si estaba apagado por inactividad automática (no manual), se reactiva al volver al panel.
    UsuarioPanel.findOne({ _id: decoded.id }).then(u => {
      if (!u) return;
      const update = { ultima_actividad: new Date() };
      if (!u.disponible && !u.disponible_manual && ['vendedor','admin'].includes(u.role)) {
        update.disponible = true; // se reactiva solo porque el apagado fue automático, no manual
      }
      UsuarioPanel.findByIdAndUpdate(decoded.id, update).exec();
    }).catch(()=>{});
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// Verificador de inactividad — marca como no disponibles a agentes que no han usado el panel en 5 min
const MINUTOS_INACTIVIDAD_AGENTE = 5;
setInterval(async () => {
  try {
    const limite = new Date(Date.now() - MINUTOS_INACTIVIDAD_AGENTE * 60 * 1000);
    const resultado = await UsuarioPanel.updateMany(
      { role: { $in: ['vendedor', 'admin'] }, disponible: true, disponible_manual: false, ultima_actividad: { $lt: limite } },
      { disponible: false }
    );
    if (resultado.modifiedCount > 0) {
      console.log(`⏸️  ${resultado.modifiedCount} agente(s) marcados como no disponibles por inactividad (>${MINUTOS_INACTIVIDAD_AGENTE} min)`);
    }
  } catch (e) { console.error('❌ Error verificando inactividad de agentes:', e.message); }
}, 60 * 1000); // revisa cada minuto

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
    const req = https.request(options, (res) => { const chunks=[]; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); });
    req.on('error', reject); req.write(postData); req.end();
  });
}

const conversaciones = new Map();
const MAX_CONVERSACIONES = 5000;
const TIMEOUT_INACTIVIDAD_MS = 3 * 60 * 60 * 1000; // 3 horas

// Limpieza periódica de conversaciones viejas
setInterval(() => {
  const ahora = Date.now();
  for (const [key, val] of conversaciones.entries()) {
    if (ahora - (val.ultimaActividad || 0) > 2 * 60 * 60 * 1000 * 3) conversaciones.delete(key);
  }
  if (conversaciones.size > MAX_CONVERSACIONES) {
    const entries = [...conversaciones.entries()].sort((a,b) => (a[1].ultimaActividad||0)-(b[1].ultimaActividad||0));
    entries.slice(0, conversaciones.size - MAX_CONVERSACIONES).forEach(([k]) => conversaciones.delete(k));
  }
}, 60 * 60 * 1000);

function llamarClaude(systemPrompt, messages, maxTokens = 400) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: maxTokens, system: systemPrompt, messages });
    const options = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(postData) }
    };
    const apiReq = https.request(options, (apiRes) => {
      const chunks = [];
      apiRes.on('data', chunk => chunks.push(chunk));
      apiRes.on('end', () => {
        const texto = Buffer.concat(chunks).toString('utf8');
        try {
          const parsed = JSON.parse(texto);
          const respuesta = parsed.content?.[0]?.text;
          if (!respuesta) {
            // La API respondió pero sin el texto esperado — casi siempre es un error de la
            // API (llave inválida, límite de uso, modelo no encontrado, etc.) — lo mostramos
            // completo en los logs para poder diagnosticar la causa real.
            console.error(`❌ Claude API — respuesta sin texto (status ${apiRes.statusCode}):`, JSON.stringify(parsed).substring(0, 500));
          }
          resolve(respuesta || null);
        } catch(e) {
          console.error(`❌ Claude API — respuesta no es JSON válido (status ${apiRes.statusCode}):`, texto.substring(0, 500));
          resolve(null);
        }
      });
    });
    apiReq.on('error', (e) => { console.error('❌ Claude API — error de red:', e.message); resolve(null); });
    apiReq.write(postData); apiReq.end();
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
  const instruccionesColegio = `\nERES: Kai, asistente virtual de admisiones. Cálido, profesional, orientado a resultados.\nESTILO — ATENCIÓN AL CLIENTE ESPECIALIZADA: eres preciso y resolutivo, como un agente de atención al cliente experto — no das vueltas, no repites la misma pregunta de formas distintas, no calculas ni improvisas cosas que el padre puede confirmar él mismo con un dato simple. Si algo se puede resolver con una tabla, imagen o dato que el propio padre puede leer y decirte, pídeselo directo así — no hagas tú el trabajo de interpretación que le corresponde a él. Sé breve, claro, y avanza la conversación con seguridad en cada turno.\nMISIÓN: Convertir cada conversación en una visita o inscripción.\n\nFLUJO INICIAL:\n1) Saluda con calidez y, si es la primera vez que escribe, pregúntale su nombre antes de continuar. Usa exactamente este formato: "¡Hola! Bienvenido al Colegio Capouilliez 👋 Soy Kai, su asistente de admisiones.\n\n¿Con quién tengo el gusto de hablar?". Si ya sabes su nombre (por el contexto interno de memoria), NO se lo vuelvas a pedir — salúdalo por su nombre directamente y continúa con calidez, sin sonar frío ni ir directo al grano.\n2) Pregunta el nivel ofreciendo un menú numerado:\n   "¿En qué nivel está interesado? Marca el número:\n   1. Preprimaria\n   2. Primaria\n   3. Secundaria (Básico y Bachillerato en Ciencias y Letras)"\n3) Si elige Preprimaria (1): NO le pidas la fecha de nacimiento ni calcules tú el grado — eso genera errores. El sistema le manda automáticamente la tabla de edades apenas elige Preprimaria (por fuera de ti, no necesitas mencionarlo). Tu única tarea es, en ese momento, preguntarle con naturalidad en qué grado le corresponde según la tabla (ej: \"¿me confirma en qué grado le corresponde según la tabla?\"). Cuando el padre/madre te diga el grado (ej. \"le corresponde Párvulos\", \"está en Kínder\", \"tiene 5 años así que Párvulos\"), toma ESO como el grado confirmado y continúa normalmente — nunca lo recalcules tú ni lo cuestiones.\n3.1) Si elige Primaria (2) o Secundaria (3): a diferencia de Preprimaria, aquí el padre/madre YA sabe directamente en qué grado va su hijo/a (1° a 6° Primaria, 7° a 10° Secundaria) — no hace falta tabla ni cálculo de ningún tipo. Simplemente pregúntale con naturalidad en qué grado estaría ingresando (ej: \"¿en qué grado estaría ingresando?\"), y toma su respuesta directa como el grado confirmado.\n4) Explica beneficios relevantes al nivel elegido.\n5) Captura: nombre del padre/madre, nombre del alumno, grado, zona, colegio actual, correo.\n6) Ofrece agendar una visita o invita al próximo Open House (sin mencionar que es "el primer sábado de cada mes" — la fecha puede variar, siempre confirma la fecha exacta vigente).\n7) Una sola vez por conversación, después de tener el correo o nombre del alumno, pregunta de forma natural y breve si desea recibir noticias del colegio (ej: "¿Le gustaría que le avisemos de nuestro próximo Open House y noticias del colegio? 📩"). Respeta la respuesta — si dice que no, no insistas ni lo vuelvas a preguntar en esta conversación.\n\nCONTACTO Y ASESORES — MUY IMPORTANTE:\n- Tu prioridad es avanzar la conversación hacia la visita/inscripción TÚ MISMO. NO ofrezcas pasar con un asesor como primera opción ni como salida fácil para dudas generales.\n- Solo sugiere hablar con un asesor humano DESPUÉS de haber intentado avanzar el proceso, o cuando el padre necesita algo que usted no puede resolver (pregunta muy específica, quiere negociar, pide hablar con alguien directamente).\n- CUANDO EL PADRE MUESTRE INTERÉS REAL DE AGENDAR UNA VISITA, OPEN HOUSE, O INSCRIBIR (ej: "quiero agendar", "sí, quiero la visita", "cómo inscribo", "quiero inscribirlo"): NO le des el número de PBX/WhatsApp como si tuviera que llamar él mismo. En su lugar dile que con gusto lo conecta directamente AHORA con un asesor que le ayudará a coordinar todo, y pregúntale si desea que lo transfieras (ej: "¡Perfecto! Te conecto ahora mismo con un asesor que te ayudará a coordinar la visita y confirmar la fecha. ¿Te parece?"). El sistema detecta esto automáticamente y transfiere la conversación.\n- Los números de PBX 2429-1999 y 2429-1908 son SOLO para si el padre prefiere llamar por su cuenta fuera de WhatsApp, no los ofrezcas como la opción principal cuando ya estás conversando con él aquí mismo.\n- NUNCA uses la palabra "mientras tanto" — está prohibida, suena repetitiva. Usa alternativas naturales o reformula sin esa frase.\n\nSOBRE LAS IMÁGENES — MUY IMPORTANTE:\n- Tú NUNCA decides ni controlas si se manda una imagen — eso lo hace el sistema automáticamente, por fuera de ti, según la pregunta exacta del padre/madre en CADA mensaje (una imagen por mensaje, sobre UN tema específico: cuotas, horarios, requisitos, proceso de admisión, edades, ubicación, o papelería).\n- JAMÁS afirmes en tu respuesta que "ya mandaste una imagen", "aquí tienes las imágenes", o similar — a menos que vea una nota de sistema real confirmándolo para ESE turno exacto. No lo asumas ni lo inventes nunca.\n- JAMÁS menciones, expliques, insinúes o describas de NINGUNA forma el mecanismo de envío de imágenes al padre/madre — ni en tiempo pasado ("ya te mandé"), ni en futuro ("el sistema te enviará", "ahora te comparto"), ni como acotación entre paréntesis o corchetes ("(aquí llega la imagen)"). El padre NUNCA debe leer una sola palabra sobre CÓMO funciona esto por dentro. Si vas a hablar de un tema que dispara imagen automática, simplemente NO lo menciones en tu respuesta — deja que el sistema haga su trabajo en silencio, y tú continúa la conversación con naturalidad (ej. preguntando si tiene otra duda), sin narrar ni un poquito el mecanismo.\n- Si el padre/madre pide VARIAS cosas o "todas las imágenes" a la vez (ej: "mándame todo", "las 4", "cuotas, horarios y requisitos"): explícale con calidez que puedes ayudarle mejor si pregunta un tema a la vez (ej: "¡Con gusto le ayudo con todo eso! Para que le llegue bien la información, empecemos con uno: ¿qué le gustaría ver primero, cuotas, horarios, requisitos o el proceso de admisión?"). NUNCA pretendas que ya se envió algo cuando el padre pidió varios temas juntos.\n- REGLA ABSOLUTA, SIN EXCEPCIÓN: NUNCA escribas precios, montos, cifras en quetzales, ni rangos de precios en tus respuestas de texto — bajo NINGUNA circunstancia, sin importar cómo esté formulada la pregunta. Todo lo relacionado a precios/cuotas/colegiaturas se resuelve SOLO con imagen. Si el padre pregunta por precios de una forma que no reconoces con claridad, NO inventes ni cites ningún número — en su lugar, pregúntale amablemente de qué nivel/grado necesita el precio, para poder ayudarle con la información exacta.\n- REGLA ABSOLUTA, SIN EXCEPCIÓN — PROCESO DE ADMISIÓN: igual que los precios, el PROCESO DE ADMISIÓN (los pasos a seguir, requisitos, papelería, evaluación, etc.) se resuelve SIEMPRE con imagen, NUNCA describiéndolo en texto — ni completo ni resumido, ni \"solo para ayudar mientras tanto\". Si te falta un dato para saber qué imagen exacta enviar (ej. la fecha de nacimiento para Preprimaria), PREGUNTA solo ese dato que falta, sin adelantar ningún paso del proceso en tu respuesta. Ejemplo CORRECTO: \"¡Con gusto! Para indicarle el proceso exacto que le corresponde, ¿me confirma la fecha de nacimiento del niño/a?\" Ejemplo INCORRECTO (no hacer esto): explicar los 4 pasos del proceso en texto y luego preguntar la fecha.\n\nFORMATO DE RESPUESTA:\n- NUNCA uses asteriscos (**texto**) para negritas ni ningún otro formato de markdown. WhatsApp no lo necesita y se ve mal. Escribe en texto plano natural.\n- No uses guiones para listas si la respuesta es corta — prefiere texto fluido y conversacional.\n\nINACTIVIDAD:\n- Si la conversación lleva más de 3 horas sin actividad ni respuesta del padre, antes de cerrar pregúntale si desea comunicarse con un asesor.\n- Si no responde, informa que se terminará la comunicación por inactividad pero que sigues a las órdenes y que pueden volver a escribir cuando quieran.\n\nLEDS (Liderazgo, Expresión, Deportes y Salud):\n- Alumnos de Primaria y Secundaria reciben 1 vez a la semana un período doble de actividades extracurriculares dentro del horario escolar, sin costo adicional.\n- Actividades disponibles: Fútbol, Baloncesto, Tenis de Mesa, Natación, Artes Visuales, Marimba, Teatro Musical.\n- Los alumnos son quienes eligen a qué actividad inscribirse, y participan en ella durante todo el ciclo escolar (la oferta puede variar cada año).\n\nREGLAS GENERALES:\nResponde de forma natural y cálida como WhatsApp, no como un correo. Nunca des listas largas ni tablas completas — si quieren más info ellos preguntan. Español guatemalteco. NUNCA inventes datos. NUNCA menciones Claude.\n\nTRATO — MUY IMPORTANTE, SIN EXCEPCIÓN:\n- SIEMPRE trata al padre/madre de USTED. NUNCA de \"vos\" ni de \"tú\", aunque el español guatemalteco use \"vos\" coloquialmente y aunque el padre te tutee primero a ti.\n- Ejemplos: di \"¿cómo está?\" no \"¿cómo estás?\" ni \"¿cómo estás vos?\"; di \"qué gusto saber de usted\" no \"qué gusto saber de vos\"; di \"su hijo\" no \"tu hijo\"; di \"le ayudo\" no \"te ayudo\".\n- Este es un colegio privado y el trato formal es un pilar de la imagen institucional frente a las familias — no es una preferencia de estilo, es una regla fija.\\n\\nASESORES Y HORARIO — REGLA DURA, SIN EXCEPCIÓN:\\n${estaDentroDeHorarioLaboral()
    ? '- Ahora SÍ es horario laboral. Si el padre pide hablar con un asesor y el sistema transfiere de verdad, puedes decir que lo conecta ahora. NUNCA digas "en un momento" o "de inmediato" si en realidad no hay transferencia ocurriendo en este turno.'
    : '- Ahora es FUERA de horario laboral (asesores: Lunes a Jueves 7:00–16:00, Viernes 7:00–15:00). NINGÚN asesor puede atender en este momento, así que JAMÁS prometas que alguien lo atenderá "de inmediato", "en un momento", "ahorita" o "enseguida" — sería una promesa falsa. Si el padre pide un asesor, dile que en este momento no hay nadie disponible, que su caso ya quedó registrado para cuando inicien labores, y que mientras tanto usted lo puede seguir ayudando con todo. Sé siempre honesto sobre esto, nunca lo suavices con lenguaje que suene a atención inmediata.'
  }`;
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
// ===== HANDOFF A HUMANO =====

// Frases que detectan intención de hablar con un agente humano
function detectaSolicitudAgente(texto) {
  const t = (texto || '').toLowerCase();
  const pideAgente = /asesor|agente|persona real|hablar con (alguien|un humano)|atenci[oó]n humana|hablar con alguien/.test(t);
  if (!pideAgente) return false;

  // Ojo con las negaciones: "no quiero hablar con agente" contiene la palabra "agente",
  // pero significa EXACTAMENTE LO CONTRARIO. Sin esta comprobación, a un padre que pide
  // que NO lo transfieran se le transfiere igual, que es lo peor que puede pasar.
  const estaNegado = /\bno\s+(quiero|necesito|deseo|me\s+interesa|hace\s+falta|es\s+necesario)\b|\bprefiero\s+no\b|\bsin\s+(asesor|agente)\b|\bno\s+con\s+(un\s+)?(asesor|agente)\b|\bpor\s+ahora\s+no\b/.test(t);
  if (estaNegado) return false;

  return true;
}

// Frases de insistencia — el padre quiere humano YA, sin importar el contexto
function detectaInsistenciaAgente(texto) {
  const t = (texto || '').toLowerCase();
  return /solo (quiero|necesito) (hablar|que me atienda)|no (quiero|m[aá]s) (bot|robot)|ya (te|le) dije que quiero (un asesor|hablar con alguien)|comun[ií]queme con|p[aá]seme con/.test(t);
}

// Horario real de atención humana: Lunes a Jueves 7:00-16:00, Viernes 7:00-15:00
// (hora de Guatemala). Fuera de esto, ningún vendedor va a contestar aunque KAI
// "transfiera" — hay que avisar eso en vez de prometer conexión inmediata.
function estaDentroDeHorarioLaboral() {
  const ahoraGT = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Guatemala' }));
  const dia = ahoraGT.getDay(); // 0=domingo, 1=lunes ... 6=sábado
  const horaDecimal = ahoraGT.getHours() + ahoraGT.getMinutes() / 60;
  if (dia === 0 || dia === 6) return false; // fin de semana
  if (dia >= 1 && dia <= 4) return horaDecimal >= 7 && horaDecimal < 16; // Lunes-Jueves 7-16h
  if (dia === 5) return horaDecimal >= 7 && horaDecimal < 15; // Viernes 7-15h
  return false;
}

// Construye el mensaje de traspaso correcto según si hay agente asignado y si estamos
// dentro del horario laboral — para no prometer "te conecto ahora" cuando en realidad
// ningún vendedor va a contestar hasta que reinicien labores.
function construirMensajeTraspaso(nombreAgente, mostroInteresReal) {
  if (!estaDentroDeHorarioLaboral()) {
    // Fuera de horario NO se transfiere (nadie contestaría), pero KAI tampoco se
    // despide: sigue atendiendo y resolviendo todo lo que pueda. El lead ya queda
    // asignado, así que la vendedora lo retoma cuando entre a trabajar.
    return 'Nuestros asesores no se encuentran disponibles en este momento (atienden de Lunes a Jueves de 7:00 a 16:00 y Viernes de 7:00 a 15:00), ' +
           (nombreAgente ? `pero ya dejé su caso asignado a ${nombreAgente.split(' ')[0]}, quien le buscará apenas inicie labores. ` : 'pero ya dejé su caso registrado para que le contacten apenas inicien labores. ') +
           'Mientras tanto yo le puedo apoyar con todo: cuotas, requisitos, horarios, proceso de admisión o lo que necesite saber 😊\n\n¿En qué le puedo ayudar?';
  }
  if (nombreAgente) {
    const primerNombre = nombreAgente.split(' ')[0];
    return mostroInteresReal
      ? `¡Perfecto! Le conecto con ${primerNombre}, quien le ayudará a coordinar todo 🙋`
      : `¡Claro! Le paso con ${primerNombre}, quien le atenderá enseguida 🙋`;
  }
  return 'En este momento todos nuestros asesores están ocupados. En breve uno le atenderá personalmente. 🙏';
}

// Busca un agente para asignar (round-robin simple: quien tenga menos hoy).
// OJO: NO se filtra por "disponible". La disponibilidad solo sirve para que la
// vendedora avise que está en almuerzo/permiso, pero el reparto 1-a-1 diario le
// sigue tocando leads igual — ella debe atenderlos cuando regrese. Filtrar por
// disponible dejaba a la otra vendedora acaparando todo el día si la primera se
// marcaba (o quedaba marcada automáticamente) como no disponible.
async function asignarAgenteLibre(tenantId) {
  const agentes = await UsuarioPanel.find({
    tenant_id: tenantId,
    role: 'vendedor', // el admin nunca debe recibir tickets asignados automáticamente
    activo: true
  }).sort({ _id: 1 }); // orden estable, para que el round-robin sea predecible
  if (!agentes.length) return null;

  // Reparto 1 a 1 REAL POR DÍA: se cuenta solo lo asignado HOY (desde medianoche,
  // hora de Guatemala), no el histórico acumulado. Antes se comparaba el total de
  // siempre, y si alguien había quedado con más en el pasado (por pruebas, por un bug,
  // etc.), el sistema seguía "compensando" ese historial viejo durante días enteros en
  // vez de alternar parejo cada día — que es lo que el equipo espera ver.
  const inicioDeHoy = new Date();
  inicioDeHoy.setHours(0, 0, 0, 0); // asume el huso horario del servidor = America/Guatemala

  const [countsMeta, countsAcrux] = await Promise.all([
    Conversacion.aggregate([
      { $match: { tenant_id: tenantId, agente_id: { $ne: null }, ultimaActividad: { $gte: inicioDeHoy } } },
      { $group: { _id: '$agente_id', total: { $sum: 1 } } }
    ]),
    AsignacionAcrux.aggregate([
      // Ojo: hay que excluir los que NO tienen vendedor. Se crean así al sincronizar el
      // semáforo de AcruxLab, y al agruparlos daban un _id nulo que reventaba el conteo
      // (y con él, TODA la asignación de vendedores del sistema).
      { $match: { tenant_id: tenantId, agente_id: { $ne: null }, fecha_asignado: { $gte: inicioDeHoy } } },
      { $group: { _id: '$agente_id', total: { $sum: 1 } } }
    ])
  ]);
  const countMap = {};
  countsMeta.forEach(c => { if (c._id) countMap[c._id.toString()] = (countMap[c._id.toString()] || 0) + c.total; });
  countsAcrux.forEach(c => { if (c._id) countMap[c._id.toString()] = (countMap[c._id.toString()] || 0) + c.total; });

  // El agente con menos conversaciones asignadas en total (entre ambos canales) recibe
  // la siguiente. Si hay empate, gana el que aparece primero en la lista (orden estable).
  agentes.sort((a, b) => (countMap[a._id.toString()] || 0) - (countMap[b._id.toString()] || 0));
  return agentes[0];
}

// Asegura que cada conversación NUEVA de AcruxLab (sin nadie que le haya respondido
// todavía, y sin asignación previa nuestra) reciba un vendedor por reparto 1 a 1 —
// así el chat ya tiene dueño desde que llega el mensaje, antes de que alguien conteste.
// No escribe nada en Odoo — la asignación vive solo en nuestra base (AsignacionAcrux).
async function asegurarAsignacionesAcrux(tenantId, conversaciones) {
  if (!conversaciones.length) return;

  const idsAConsultar = conversaciones.map(c => c.contacto_id);
  const yaAsignadas = await AsignacionAcrux.find({ tenant_id: tenantId, contacto_id: { $in: idsAConsultar } });
  const yaAsignadasMap = {};
  yaAsignadas.forEach(a => { yaAsignadasMap[a.contacto_id] = a; });

  // Traer TODOS los usuarios activos (no solo vendedores) — Sylvia es "admin" en
  // nuestro sistema pero también atiende chats reales directo desde Odoo, así que
  // debe poder reconocerse igual que Cindy o Vanessa. Excluimos solo a "Administrador"
  // (la cuenta de servicio compartida), que no es una persona real.
  const usuariosActivos = await UsuarioPanel.find({ tenant_id: tenantId, activo: true, nombre: { $ne: 'Administrador' } });
  const normalizar = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/\s+/).filter(Boolean);
  const encontrarVendedorPorNombre = (nombreOdoo) => {
    const palabrasOdoo = normalizar(nombreOdoo);
    if (!palabrasOdoo.length) return null;
    return usuariosActivos.find(v => {
      const palabrasV = normalizar(v.nombre);
      const coincidencias = palabrasV.filter(p => palabrasOdoo.includes(p)).length;
      return coincidencias >= Math.min(2, palabrasV.length);
    }) || null;
  };

  // ===== REGLA DE NEGOCIO: etiqueta "Oportunidad" → las atiende Sylvia =====
  // Las conversaciones que en Odoo tengan la etiqueta "Oportunidad" no entran al
  // reparto 1 a 1 entre vendedoras — se asignan directo a Sylvia (admisiones/admin).
  const usuarioOportunidad = usuariosActivos.find(u => normalizar(u.nombre).includes('sylvia')) || null;
  const tieneEtiquetaOportunidad = (c) => (c.etiquetas || []).some(e => (e || '').toLowerCase().includes('oportunidad'));

  for (const conv of conversaciones) {
    const existente = yaAsignadasMap[conv.contacto_id];
    if (existente) {
      // Si le pusieron la etiqueta "Oportunidad" DESPUÉS de haberse asignado a una
      // vendedora, y todavía la está atendiendo KAI (modo bot), la movemos a Sylvia.
      // No tocamos las que ya están en modo humano — ahí ya hay alguien trabajando.
      if (usuarioOportunidad && tieneEtiquetaOportunidad(conv) && existente.modo === 'bot' && existente.agente_nombre !== usuarioOportunidad.nombre) {
        try {
          existente.agente_id = usuarioOportunidad._id;
          existente.agente_nombre = usuarioOportunidad.nombre;
          existente.modo = 'humano';
          existente.fecha_modo_humano = new Date();
          existente.sin_auto_recuperacion = true;
          await existente.save();
          console.log(`🏷️ [Oportunidad] Contacto ${conv.contacto_id} reasignado a ${usuarioOportunidad.nombre} por etiqueta`);
        } catch (e) { /* no bloqueante */ }
      }
      conv.agente = existente.agente_nombre;
      conv.agente_fecha = existente.fecha_asignado;
      conv.modo = existente.modo || 'bot';
      continue;
    }
    conv.modo = 'bot'; // por defecto, hasta que se asigne

    // Etiqueta "Oportunidad" en una conversación nueva → directo a Sylvia, sin round-robin.
    if (usuarioOportunidad && tieneEtiquetaOportunidad(conv)) {
      try {
        await AsignacionAcrux.create({ tenant_id: tenantId, contacto_id: conv.contacto_id, agente_id: usuarioOportunidad._id, agente_nombre: usuarioOportunidad.nombre, modo: 'humano', fecha_modo_humano: new Date(), sin_auto_recuperacion: true });
        conv.agente = usuarioOportunidad.nombre;
        conv.modo = 'humano';
        console.log(`🏷️ [Oportunidad] Contacto ${conv.contacto_id} asignado directo a ${usuarioOportunidad.nombre} por etiqueta`);
      } catch (e) { /* condición de carrera — se toma en el próximo refresh */ }
      continue;
    }

    // Si ya hay un agente humano REAL (respondió directo desde Odoo, no desde nuestro
    // panel) para esta conversación, respetamos eso — no lo pisamos con el reparto
    // automático. Esto evita que se "borre" el rastro de que Sylvia o Vanessa ya
    // atendieron algo manualmente, solo porque nunca pasó por nuestro sistema.
    const vendedorReal = conv.agente ? encontrarVendedorPorNombre(conv.agente) : null;
    if (vendedorReal) {
      try {
        await AsignacionAcrux.create({ tenant_id: tenantId, contacto_id: conv.contacto_id, agente_id: vendedorReal._id, agente_nombre: vendedorReal.nombre, modo: 'humano', fecha_modo_humano: new Date() });
        conv.agente = vendedorReal.nombre;
        conv.modo = 'humano';
      } catch (e) { /* condición de carrera — no pasa nada, se toma en el próximo refresh */ }
      continue;
    }

    // El reparto automático 1-1 para conversaciones genuinamente nuevas SÍ respeta la
    // pausa — si Kai está detenido, no tiene sentido seguir repartiendo leads nuevos
    // como si el sistema estuviera trabajando. Se quedan "sin asignar" hasta reactivar.
    if (KAI_PAUSADO_PARA_PRODUCCION) continue;

    const agente = await asignarAgenteLibre(tenantId);
    if (!agente) continue; // nadie disponible — se queda sin asignar hasta que alguien lo esté
    try {
      await AsignacionAcrux.create({ tenant_id: tenantId, contacto_id: conv.contacto_id, agente_id: agente._id, agente_nombre: agente.nombre });
      conv.agente = agente.nombre;
      conv.agente_fecha = new Date();
    } catch (e) { /* si ya existe (condición de carrera), no pasa nada — se toma en el próximo refresh */ }
  }
}

// ===== KAI ATENDIENDO AUTOMÁTICO POR ACRUXLAB (número oficial) =====
// Versión independiente de responderConIA (la de WhatsApp/Meta) a propósito — para no
// arriesgar el flujo de WhatsApp que ya está confirmado funcionando. Comparte el mismo
// "cerebro" (buildSystemPrompt, FAQs, detección de handoff) pero lleva su memoria aparte.
async function atenderAcruxConIA(tenant, mensajeUsuario, numero, contactoId) {
  // ===== INTERRUPTOR MAESTRO: KAI PAUSADO EN PRODUCCIÓN =====
  // Se revisa PRIMERO que nada — ni siquiera se llega al filtro de proveedores. Los
  // números de prueba siguen funcionando exactamente igual, para poder seguir probando.
  if (KAI_PAUSADO_PARA_PRODUCCION && !esNumeroDePrueba(numero)) {
    console.log(`⏸️ [AcruxLab] KAI pausado en producción — no se responde a ${numero} (número real)`);
    return { texto: null, handoff: false, motivo: 'kai_pausado' };
  }

  // ===== ¿ES UN PROVEEDOR OFRECIENDO PRODUCTOS/SERVICIOS, NO UN PADRE? =====
  // Mismo filtro que en WhatsApp — se revisa ANTES que cualquier otra cosa. No se crea
  // lead, no se asigna vendedora, no se llama a la IA.
  if (!esNumeroDePrueba(numero) && esProveedorOAjenoAAdmisiones(mensajeUsuario)) {
    console.log(`📦 [AcruxLab] Mensaje de proveedor detectado (${numero}) — se responde fijo, sin crear lead ni asignar vendedora`);
    return { texto: MENSAJE_RESPUESTA_PROVEEDOR, handoff: false };
  }

  // Usamos el número limpio (sin prefijo) como clave — así, si el mismo padre ya había
  // escrito antes por el WhatsApp normal, comparte la MISMA memoria y el MISMO lead de
  // Odoo, en vez de crear un contacto/lead duplicado solo por venir de otro canal.
  const esNuevaSesionEnMemoria = !conversaciones.has(numero);
  if (esNuevaSesionEnMemoria) conversaciones.set(numero, { historial: [], ultimaActividad: Date.now() });
  const conv = conversaciones.get(numero);
  conv.ultimaActividad = Date.now();
  const historial = conv.historial;

  // ===== MODO NO INTERACTIVO — nuevo esquema, solo números de prueba por ahora =====
  // Si está activo para este número, toma el control completo del mensaje — no cae al
  // flujo conversacional normal en absoluto.
  if (MODO_NO_INTERACTIVO_SOLO_PRUEBAS && esNumeroDePrueba(numero)) {
    return await manejarModoNoInteractivoAcrux(tenant, mensajeUsuario, conv, contactoId);
  }

  // Recuperar SOLO el nivel guardado (para las imágenes) — el resto de la memoria se
  // maneja más abajo, en el bloque de saludo, para no duplicar la inyección.
  if (esNuevaSesionEnMemoria) {
    const contactoParaNivel = await Contacto.findOne({ tenant_id: tenant._id, numero });
    if (contactoParaNivel?.nivel_interes) {
      conv.nivelSesion = detectarNivelEnTexto(contactoParaNivel.nivel_interes) || conv.nivelSesion;
    }
  }

  const nivelMencionadoAhora = detectarNivelEnTexto(mensajeUsuario);
  if (nivelMencionadoAhora) conv.nivelSesion = nivelMencionadoAhora;

  // Si el mensaje menciona VARIOS niveles a la vez (ej. "Preprimaria y Primaria", caso
  // real de un papá con hijos en dos grados distintos), se guardan TODOS — así, cuando
  // más adelante pida "cuotas, requisitos y horarios" sin repetir el nivel, el sistema
  // sabe que debe mandarle la información de ambos, no solo de uno.
  const nivelesExplicitosAhora = detectarNivelesExplicitosEnMensaje(mensajeUsuario);
  if (nivelesExplicitosAhora.length > 1) {
    conv.nivelesMultiples = [...new Set([...(conv.nivelesMultiples || []), ...nivelesExplicitosAhora])];
  }

  // Si había una pregunta pendiente y este mensaje trae grado, completarla tiene
  // prioridad sobre cualquier coincidencia nueva no relacionada (ver misma lógica en WhatsApp).
  // Si el papá solo está agradeciendo o despidiéndose, NO se le manda ninguna imagen.
  const soloAgradece = esAgradecimientoOCierre(mensajeUsuario);

  // Si el mensaje no trae una PALABRA de nivel pero SÍ parece una fecha de nacimiento
  // (ej. "01/03/2018", solo eso, sin decir "primaria"), el código la calcula él mismo —
  // determinista, sin depender de que la IA lo haga bien en texto libre y sin que ese
  // cálculo se pierda sin llegar nunca al sistema de imágenes.
  // Se calcula SIEMPRE, incluso si el mensaje también trae una palabra de nivel — un
  // mismo mensaje puede traer la fecha de UN hijo y el grado de OTRO a la vez (ej.
  // "9 de septiembre 2021 y para 3° Primaria"), y antes, con la palabra "primaria"
  // presente, ni siquiera se intentaba leer la fecha del primer niño.
  const nivelPorFecha = calcularNivelDesdeFecha(mensajeUsuario);
  const nivelParaCompletarTema = nivelMencionadoAhora || nivelPorFecha;
  if (nivelPorFecha) {
    // Si ESTE mismo mensaje ya trajo una palabra de nivel (ej. "primaria" para el otro
    // hijo), esa es la que manda como nivel "actual" — la fecha se suma a la lista de
    // múltiples, pero no le quita el lugar al nivel recién mencionado por palabra.
    if (!nivelMencionadoAhora) conv.nivelSesion = nivelPorFecha;
    conv.nivelesMultiples = [...new Set([...(conv.nivelesMultiples || []), nivelPorFecha])];
  }

  let matchImagen = null;

  // Si el papá acaba de mencionar Preprimaria de forma GENÉRICA (sin decir todavía un
  // sub-grado específico como Párvulos/Kínder/Jardín/Infantil/Preparatoria), y esta
  // conversación aún no tiene ese sub-grado confirmado, se manda la tabla de edades
  // DIRECTO desde el código — sin depender de que el padre escriba la palabra "edad"
  // (el sistema de imágenes solo mira el mensaje del padre, nunca lo que Kai responde,
  // así que no se puede disparar "diciéndolo" en el texto de Kai).
  const mencionaSubNivelPreprimaria = /jard[ií]n|infantil|k[ií]nder|p[aá]rvulos|preparatoria/i.test(mensajeUsuario);
  if (!soloAgradece && nivelMencionadoAhora === 'preprimaria' && !mencionaSubNivelPreprimaria && !conv.subNivelPreprimariaConfirmado) {
    const reglaEdades = REGLAS_IMAGEN.find(r => r.nombre_contiene === 'Edades');
    if (reglaEdades) matchImagen = { regla: reglaEdades, ambigua: false };
  }
  if (mencionaSubNivelPreprimaria) conv.subNivelPreprimariaConfirmado = true; // ya no hace falta la tabla otra vez

  if (!matchImagen && !soloAgradece && nivelParaCompletarTema && conv.temaPendienteCategoria) {
    const reglaCompletada = completarTemaPendiente(conv.temaPendienteCategoria, nivelParaCompletarTema);
    if (reglaCompletada) matchImagen = { regla: reglaCompletada, ambigua: false };
  }
  if (!matchImagen && !soloAgradece) {
    matchImagen = buscarReglaImagenCoincidente(mensajeUsuario, conv.nivelSesion);
  }
  const PALABRAS_MODO_VISUAL = ['muéstrame', 'muestrame', 'quiero ver', 'envía imágenes', 'envia imagenes', 'fotografías', 'fotografias', 'necesito las imágenes', 'necesito las imagenes', 'mándame las imágenes', 'mandame las imagenes'];
  const esModoVisual = PALABRAS_MODO_VISUAL.some(p => mensajeUsuario.toLowerCase().includes(p));
  if (!matchImagen && esModoVisual && conv.temaPendienteCategoria && conv.nivelSesion) {
    const reglaCompletada = completarTemaPendiente(conv.temaPendienteCategoria, conv.nivelSesion);
    if (reglaCompletada) matchImagen = { regla: reglaCompletada, ambigua: false };
  }
  if (matchImagen && matchImagen.ambigua) conv.temaPendienteCategoria = matchImagen.categoria;

  // ===== IMÁGENES DIRECTAS — sin pasar por la IA, igual que en WhatsApp =====
  if (matchImagen && !matchImagen.ambigua && matchImagen.regla) {
    conv.temaPendienteCategoria = null;

    // El papá puede pedir VARIAS cosas en un solo mensaje ("cuotas, requisitos, horarios
    // y el proceso de admisión"). Antes solo se le mandaba la primera y las demás se
    // ignoraban. Ahora se le manda todo lo que pidió.
    const nivelParaBuscar = nivelMencionadoAhora || conv.nivelSesion;
    let reglasAEnviar = buscarTodasLasReglasCoincidentes(mensajeUsuario, nivelParaBuscar, conv.nivelesMultiples);
    if (!reglasAEnviar.length || !reglasAEnviar.some(r => r.categoria === matchImagen.regla.categoria)) {
      reglasAEnviar = [matchImagen.regla];
    }

    const enviadas = [];
    for (const regla of reglasAEnviar) {
      const filtroImg = { tenant_id: tenant._id, activo: true, categoria: regla.categoria };
      if (regla.nivel_educativo) filtroImg.nivel_educativo = { $in: [regla.nivel_educativo, 'Todos'] };
      if (regla.nombre_contiene) filtroImg.nombre = new RegExp(regla.nombre_contiene, 'i');
      const img = await ImagenMarketing.findOne(filtroImg).sort({ prioridad: -1, creado: -1 });
      if (!img) continue;

      try {
        const adjunto = await subirImagenNuevaAcrux(img.imagen_base64, `${img.nombre}.jpg`, img.mime_type || 'image/jpeg', contactoId);
        await odooCallLocal(
          'acrux.chat.conversation',
          'send_message',
          [[contactoId], {
            text: construirDescripcionImagen(img), from_me: true, ttype: 'image', res_model: 'ir.attachment', res_id: adjunto.id,
            id: -2, date_message: new Date().toISOString().replace('T', ' ').substring(0, 19), button_ids: []
          }],
          { context: { lang: 'es_GT', tz: 'America/Guatemala', is_acrux_chat_room: true } }
        );
        enviadas.push(img.nombre);
        console.log(`🖼️ [AcruxLab] Imagen enviada: "${img.nombre}" → contacto ${contactoId}`);
        if (reglasAEnviar.length > 1) await new Promise(r => setTimeout(r, 1800)); // respiro entre imágenes
      } catch (e) {
        console.error(`❌ [AcruxLab] Error enviando imagen "${img.nombre}" a contacto ${contactoId}:`, e.message);
      }
    }

    if (enviadas.length) {
      historial.push({ role: 'user', content: mensajeUsuario });
      historial.push({ role: 'assistant', content: `[NOTA DE SISTEMA — esto NO es algo que tú dijiste ni debes imitar este formato de frase: el sistema envió automáticamente ${enviadas.length === 1 ? 'la imagen' : 'las imágenes'} "${enviadas.join('", "')}" con el detalle completo de ${enviadas.length === 1 ? 'ESE tema' : 'ESOS temas'}. No repitas estos datos en texto. Jamás afirmes "te mandé la imagen" a menos que este mensaje de sistema aparezca de verdad para ESE turno.]` });
      conv.ultimaActividad = Date.now();
      return { texto: '', handoff: false };
    }

    // Ninguna imagen se pudo enviar — no dejamos a la familia sin respuesta.
    historial.push({ role: 'user', content: mensajeUsuario });
    historial.push({ role: 'assistant', content: '(Las imágenes automáticas fallaron al enviarse — se avisó al padre.)' });
    conv.ultimaActividad = Date.now();
    return { texto: 'Con gusto te comparto esa información — dame un momento para enviártela correctamente. 🙏', handoff: false };
  }

  // Recuperar memoria persistente si existe (igual que en WhatsApp) — para saludar por
  // nombre y no repetir preguntas si ya se conocía a este padre/madre.
  let contactoExistente = await Contacto.findOne({ tenant_id: tenant._id, numero });
  const esPrimeraVezEnEstaSesion = !conv.memoriaSaludoHecho;
  conv.memoriaSaludoHecho = true;
  if (contactoExistente && esPrimeraVezEnEstaSesion && contactoExistente.nombre) {
    const partes = [];
    if (contactoExistente.nombre) partes.push(`nombre del padre: ${contactoExistente.nombre}`);
    if (contactoExistente.nombre_alumno) partes.push(`nombre del alumno: ${contactoExistente.nombre_alumno}`);
    if (contactoExistente.nivel_interes) partes.push(`nivel de interés: ${contactoExistente.nivel_interes}`);
    if (contactoExistente.zona) partes.push(`zona: ${contactoExistente.zona}`);
    if (contactoExistente.correo) partes.push(`correo: ${contactoExistente.correo}`);
    if (contactoExistente.resumen_ultimo_contacto) partes.push(`última conversación: ${contactoExistente.resumen_ultimo_contacto}`);
    if (partes.length) {
      historial.push({
        role: 'assistant',
        content: `(Contexto interno — ya conoces a este padre/madre. ${partes.join(', ')}. Salúdalo por su nombre directamente, sin volver a pedir datos que ya tienes. Continúa desde donde quedaron.)`
      });
    }
  }

  historial.push({ role: 'user', content: mensajeUsuario });
  if (historial.length > 16) historial.splice(0, 2);

  // ===== DETECCIÓN DE HANDOFF — misma lógica que WhatsApp =====
  const yaHayContexto = historial.length >= 4;
  const insisteExplicito = detectaInsistenciaAgente(mensajeUsuario);
  const ultimoMsgBot = [...historial].reverse().find(m => m.role === 'assistant')?.content || '';
  const mostroInteresReal = esAltaIntencion(mensajeUsuario, ultimoMsgBot);

  if ((detectaSolicitudAgente(mensajeUsuario) && (yaHayContexto || insisteExplicito)) || mostroInteresReal) {
    const dentroDeHorario = estaDentroDeHorarioLaboral();
    let nombreAgente = null;
    if (dentroDeHorario) {
      // Solo pasamos a modo "humano" (KAI deja de auto-responder) si de verdad hay
      // alguien trabajando ahorita — fuera de horario nadie va a retomarla hasta que
      // regresen, así que KAI debe seguir atendiendo en vez de quedarse callado.
      const resumen = await generarResumenParaAgente(numero);
      const asign = await AsignacionAcrux.findOneAndUpdate(
        { tenant_id: tenant._id, contacto_id: contactoId },
        { modo: 'humano', fecha_modo_humano: new Date(), resumen_kai: resumen },
        { new: true }
      );
      nombreAgente = asign?.agente_nombre;
      historial.push({ role: 'assistant', content: '(Se transfirió la conversación a un asesor humano.)' });

      // CRÍTICO: avisarle a Odoo mismo quién es el agente — si no, Odoo se queda
      // pensando para siempre que la conversación la tiene "Administrador" (el usuario
      // con el que KAI inicia sesión), y eso genera errores de validación reales cuando
      // la vendedora intenta trabajar el caso desde Odoo.
      if (SINCRONIZAR_AGENTE_EN_ODOO_ACTIVO && asign?.agente_id) {
        const agenteReal = await UsuarioPanel.findById(asign.agente_id);
        if (agenteReal?.odoo_user_id) {
          await odooCallLocal('acrux.chat.conversation', 'write', [[contactoId], { agent_id: agenteReal.odoo_user_id }]).catch(e => {
            console.error(`⚠️ No se pudo sincronizar el agente en Odoo para la conversación ${contactoId}: ${e.message}`);
          });
        }
      }
    } else {
      // Fuera de horario NO se transfiere (KAI sigue atendiendo), pero el caso SÍ queda
      // asignado y con el resumen listo, para que la vendedora lo retome apenas entre.
      const resumenFuera = await generarResumenParaAgente(numero).catch(() => null);
      const asignFuera = await AsignacionAcrux.findOneAndUpdate(
        { tenant_id: tenant._id, contacto_id: contactoId },
        { $set: { resumen_kai: resumenFuera } },
        { new: true }
      );
      nombreAgente = asignFuera?.agente_nombre; // para poder decirle quién lo va a buscar
      historial.push({ role: 'assistant', content: '(Fuera de horario: se avisó que los asesores no están disponibles, el caso quedó asignado, y KAI sigue atendiendo mientras tanto.)' });
    }

    const msg = construirMensajeTraspaso(nombreAgente, mostroInteresReal);

    if (mostroInteresReal) {
      crearCandidatoOdooSiNoExiste(tenant, numero, mensajeUsuario, historial).catch(e => console.error('❌ Error creando candidato (AcruxLab):', e.message));
    }
    return { texto: msg, handoff: dentroDeHorario };
  }

  // ===== RESPUESTA NORMAL DE KAI =====
  const systemPrompt = buildSystemPrompt(tenant);
  let contextoExtra = '';
  if (matchImagen && matchImagen.ambigua) {
    contextoExtra += '\n\n📌 IMPORTANTE: El padre/madre preguntó sobre un tema (cuotas, proceso, etc.) pero no especificó el grado/nivel exacto. NO des ningún número, precio, o dato específico todavía — primero pregúntale amablemente en qué grado o nivel está interesado.';
  }
  try {
    const [faqs, docs] = await Promise.all([
      FAQ.find({ tenant_id: tenant._id, activo: true }).limit(20),
      Documento.find({ tenant_id: tenant._id, activo: true }).sort({ tipo: 1, creado: -1 }).limit(15)
    ]);
    if (faqs.length) contextoExtra += '\n\nPREGUNTAS FRECUENTES:\n' + faqs.map(f => `P: ${f.pregunta}\nR: ${f.respuesta}`).join('\n\n');
    contextoExtra += buildDocsContext(docs);
  } catch (e) { /* si falla, seguimos sin ese contexto extra */ }

  const reply = await llamarClaude(systemPrompt + contextoExtra, historial, 600);
  const respuestaLimpia = reply ? reply.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1') : null;

  if (!respuestaLimpia) {
    // La IA no pudo responder — transferimos a un vendedor en vez de mostrar un error técnico.
    console.error(`⚠️ Claude no respondió (AcruxLab) — transfiriendo a humano automáticamente para ${numero}`);
    const resumen = await generarResumenParaAgente(numero).catch(() => null);
    const asign = await AsignacionAcrux.findOneAndUpdate(
      { tenant_id: tenant._id, contacto_id: contactoId },
      { modo: 'humano', fecha_modo_humano: new Date(), resumen_kai: resumen },
      { new: true }
    );
    const nombreAgente = asign?.agente_nombre;
    const msg = construirMensajeTraspaso(nombreAgente, false);
    return { texto: msg, handoff: true };
  }

  const respuesta = respuestaLimpia;
  historial.push({ role: 'assistant', content: respuesta });

  // ===== VERIFICACIÓN DE CONSISTENCIA =====
  // La IA puede, por su cuenta, decir algo como "te conecto con un asesor" siguiendo
  // las instrucciones del prompt, SIN que nuestra detección determinística (esAltaIntencion/
  // detectaSolicitudAgente) lo haya disparado — eso deja el sistema diciendo una cosa y
  // haciendo otra (el chat se queda en "KAI atendiendo" aunque el texto prometió un asesor).
  // Si detectamos esa promesa en el propio texto de KAI, forzamos el traspaso real ahora.
  const PARECE_PROMESA_DE_ASESOR = /te (conecto|paso|comunico) (ahora|con)|un asesor te|con (un asesor|nuestro asesor)|le (conecto|paso|comunico)/i.test(respuesta);
  if (PARECE_PROMESA_DE_ASESOR) {
    const dentroDeHorarioAhora = estaDentroDeHorarioLaboral();
    if (dentroDeHorarioAhora) {
      const resumenConsistencia = await generarResumenParaAgente(numero).catch(() => null);
      // Se respeta el vendedor que YA tuviera asignado (del contacto inicial) — solo se
      // asigna uno nuevo por el reparto 1 a 1 si de verdad no había ninguno todavía.
      const asignExistente = await AsignacionAcrux.findOne({ tenant_id: tenant._id, contacto_id: contactoId });
      let agenteParaEsteTraspaso = null;
      if (asignExistente?.agente_id) {
        agenteParaEsteTraspaso = await UsuarioPanel.findById(asignExistente.agente_id);
      } else {
        agenteParaEsteTraspaso = await asignarAgenteLibre(tenant._id);
      }
      await AsignacionAcrux.findOneAndUpdate(
        { tenant_id: tenant._id, contacto_id: contactoId },
        {
          modo: 'humano', fecha_modo_humano: new Date(), resumen_kai: resumenConsistencia,
          ...(agenteParaEsteTraspaso ? { agente_id: agenteParaEsteTraspaso._id, agente_nombre: agenteParaEsteTraspaso.nombre } : {})
        }
      );
      // CRÍTICO: avisarle a Odoo mismo quién es el agente ahora. Si esto no se hace,
      // Odoo se queda pensando para siempre que la conversación la tiene "Administrador"
      // (el usuario con el que KAI inicia sesión) — y eso es justo lo que causó el error
      // de validación real: Odoo veía "atendido por Administrador" aunque nuestro Mongo
      // ya decía que era de una vendedora real.
      if (SINCRONIZAR_AGENTE_EN_ODOO_ACTIVO && agenteParaEsteTraspaso?.odoo_user_id) {
        await odooCallLocal('acrux.chat.conversation', 'write', [[contactoId], { agent_id: agenteParaEsteTraspaso.odoo_user_id }]).catch(e => {
          console.error(`⚠️ No se pudo sincronizar el agente en Odoo para la conversación ${contactoId}: ${e.message}`);
        });
      }
      console.log(`🔧 [Consistencia] KAI prometió un asesor en texto — se forzó el traspaso real para contacto ${contactoId}${agenteParaEsteTraspaso ? ' → ' + agenteParaEsteTraspaso.nombre : ''}`);
    }
  }

  // Extraer datos (nombre, alumno, nivel, zona, etc.), guardarlos en el Contacto persistente,
  // y crear/actualizar el lead en Odoo progresivamente según el nivel de interés — exactamente
  // igual que hace el flujo de WhatsApp. Esto es lo que faltaba: sin esto, KAI conversaba pero
  // nunca "recordaba" ni avanzaba el lead en Odoo con lo que el padre iba dando.
  actualizarContactoYDetectarInteres(tenant, numero, mensajeUsuario, respuesta, historial, contactoExistente)
    .catch(e => console.error('❌ Error actualizando contacto (AcruxLab):', e.message));

  return { texto: respuesta, handoff: PARECE_PROMESA_DE_ASESOR };
}

// Envía un mensaje de texto por AcruxLab — misma llamada real confirmada y usada en
// /api/acrux/responder, extraída aquí para reutilizarla también desde el motor automático.
async function enviarTextoAcruxLab(contactoId, texto, intento = 1) {
  try {
    const resultado = await odooCallLocal(
      'acrux.chat.conversation',
      'send_message',
      [[contactoId], {
        text: texto,
        from_me: true,
        ttype: 'text',
        res_model: '',
        res_id: 0,
        id: -2,
        date_message: new Date().toISOString().replace('T', ' ').substring(0, 19),
        button_ids: []
      }],
      { context: { lang: 'es_GT', tz: 'America/Guatemala', is_acrux_chat_room: true } }
    );

    // Copia inmediata en nuestro propio respaldo — no se espera a que termine, para no
    // atrasar la respuesta al padre. Regla fija: todo lo que Kai manda queda guardado en
    // los dos lados (Odoo y nuestro sistema), en el mismo instante, no al día siguiente.
    // Se usa un ID negativo con la hora exacta porque el ID real del mensaje en Odoo no
    // viene en esta respuesta — el respaldo diario más tarde completa el dato real y no
    // duplica (por número de conversación + texto + minuto es suficientemente único aquí).
    Tenant.findOne({ activo: true }).then(tenant => {
      if (!tenant) return;
      MensajeRespaldo.create({
        tenant_id: tenant._id,
        contacto_id_acrux: contactoId,
        mensaje_id_odoo: -Date.now(),
        de: 'colegio',
        texto,
        fecha_mensaje: new Date()
      }).catch(() => {}); // si falla el respaldo, no debe afectar el envío ya exitoso
    }).catch(() => {});

    return resultado;
  } catch (e) {
    // Odoo rechaza el envío. Puede ser porque un agente tiene tomada la conversación,
    // o porque quedó en un estado que no permite escribir (status 'new'). El mensaje
    // del módulo es el mismo en ambos casos, así que no se puede distinguir aquí.
    const esConversacionTomada = /refresque la pantalla|can't write in this conversation/i.test(e.message || '');
    if (esConversacionTomada) {
      const err = new Error('ODOO_RECHAZO_ESCRITURA (agente tomó la conversación, o quedó en estado no editable)');
      err.conversacionTomada = true;
      throw err;
    }
    throw e;
  }
}

// ⚠️ INTERRUPTOR — KAI atendiendo automático por AcruxLab. Apagado a propósito por
// petición explícita después de la primera prueba en vivo, mientras se decide cuándo
// reactivarlo. Cambiar a `true` para reactivar el motor.
const ACRUX_AUTO_RESPUESTA_ACTIVO = true; // Activado para prueba de fin de semana — monitorear los logs de cerca

// Apagado por defecto hasta confirmar, caso por caso, que el registro interno
// (AsignacionAcrux.agente_id) es confiable — se descubrió el 24/07 que puede estar
// desalineado con agente_nombre (caso Karen Fuentes: nombre decía Sylvia, el ID
// apuntaba a Cindy). Mientras esto esté en false, el traspaso sigue funcionando igual
// que antes (solo actualiza nuestro Mongo), pero NO escribe nada en Odoo — así no hay
// riesgo de sincronizar un agente equivocado por un dato ya roto de antes.
// REVERTIDO el 24/07 a solicitud explícita — el usuario quiere probar con 1 solo chat
// primero, y sacar el reporte completo de atendidos antes de activar esto para todos.
// NO cambiar a true sin confirmación directa.
const SINCRONIZAR_AGENTE_EN_ODOO_ACTIVO = false;
const VENTANA_MOTOR_ACRUX_HORAS = 48; // cuánto hacia atrás revisa el motor buscando mensajes sin responder

// Motor que revisa cada cierto tiempo si hay mensajes nuevos sin responder en AcruxLab,
// y hace que KAI conteste automáticamente (a menos que ya esté en modo "humano").
let _procesandoAcruxLab = false; // evita que se encimen dos corridas si una tarda mucho
// Recuerda a quién acabamos de responder. El mensaje que KAI envía tarda unos segundos
// en aparecer en Odoo; sin esto, la siguiente corrida (45 seg) lo ve como "sin responder"
// y CONTESTA DE NUEVO — por eso a algunos papás les llegaba el saludo dos veces.
const _respondidosRecientes = new Map(); // contactoId → cuándo se le respondió
const MINUTOS_ANTI_DUPLICADO = 3;
async function procesarNuevosMensajesAcruxLab() {
  if (!ACRUX_AUTO_RESPUESTA_ACTIVO) return;
  if (_procesandoAcruxLab) return;
  _procesandoAcruxLab = true;
  try {
    const tenant = await Tenant.findOne({ activo: true });
    if (!tenant) return;

    // Ventana amplia (48h): antes eran solo 20 minutos, y por eso un mensaje que no se
    // alcanzara a responder dentro de esa ventana quedaba pendiente PARA SIEMPRE — KAI
    // nunca lo volvía a ver. Las protecciones de abajo (ya respondido / tomado por un
    // humano / modo humano) evitan que esto genere respuestas duplicadas o intrusivas.
    const desde = new Date(Date.now() - VENTANA_MOTOR_ACRUX_HORAS * 3600 * 1000).toISOString().replace('T', ' ').substring(0, 19);
    const mensajes = await odooCallLocal('acrux.chat.message', 'search_read',
      [[['date_message', '>=', desde]]],
      { fields: ['id', 'text', 'date_message', 'contact_id', 'msgid', 'from_me'], limit: 2000, order: 'date_message asc' }
    );
    if (!mensajes) return;

    const porContacto = {};
    mensajes.forEach(m => {
      if (!m.contact_id) return;
      const cid = m.contact_id[0];
      if (!porContacto[cid]) porContacto[cid] = [];
      porContacto[cid].push(m);
    });

    // ===== VERIFICACIÓN DE "SEMÁFORO" EN ODOO REAL =====
    // El módulo de AcruxLab NO permite que dos usuarios escriban en la misma conversación:
    // si un agente la tiene "tomada" en el ChatRoom real (agent_id asignado), cualquier
    // intento nuestro de send_message truena con "no puede escribir en esta conversación,
    // refresque la pantalla" — ese era el error real de los logs. Así que ANTES de que
    // KAI intente responder, leemos el agent_id de cada conversación y saltamos las que
    // ya están tomadas por un humano real (además sincronizamos nuestro registro a modo
    // "humano" para que ni siquiera lo intente en las próximas corridas).
    const idsContactos = Object.keys(porContacto).map(Number);
    let agentePorContacto = {};
    const odooPorContactoNombre = {};
    if (idsContactos.length) {
      try {
        const uidServicio = await getOdooUID(); // nuestro propio usuario de servicio (KAI escribe con este)
        const convsOdoo = await odooCallLocal('acrux.chat.conversation', 'read', [idsContactos, ['id', 'agent_id', 'status', 'name']]) || [];
        convsOdoo.forEach(c => { if (c.name) odooPorContactoNombre[c.id] = c.name; });

        // Las conversaciones en estado 'new' o 'done' NO aceptan escritura. Hay que
        // activarlas antes de intentar responder, o KAI falla en silencio y la familia
        // se queda esperando. Odoo exige que tengan agente para poder activarlas, así
        // que se les pone nuestro usuario de servicio (no una vendedora, para no
        // quitarle chats).
        const porActivar = convsOdoo.filter(c => (c.status === 'new' || c.status === 'done') && (!c.agent_id || c.agent_id[0] === uidServicio));
        for (const c of porActivar) {
          try {
            const cambios = { status: 'current' };
            if (!c.agent_id) cambios.agent_id = uidServicio;
            await odooCallLocal('acrux.chat.conversation', 'write', [[c.id], cambios]);
            console.log(`🔓 [AcruxLab] Conversación #${c.id} activada (estaba en 'new', nadie podía escribirle)`);
          } catch (e) {
            console.error(`⚠️ [AcruxLab] No se pudo activar la conversación #${c.id}: ${e.message}`);
          }
        }

        convsOdoo.forEach(c => {
          if (c.agent_id && c.agent_id[0] !== uidServicio) {
            agentePorContacto[c.id] = c.agent_id[1]; // nombre del agente humano que la tiene tomada
          }
        });
      } catch (e) {
        // Si esta lectura falla, KAI queda "a ciegas" y puede intentar escribir en una
        // conversación que un agente ya tiene tomada — que es justo lo que provoca el
        // error de Odoo. Antes se ignoraba en silencio; ahora queda registrado.
        console.error(`⚠️ [AcruxLab] No se pudo leer quién tiene tomadas las conversaciones (agent_id): ${e.message}`);
      }
    }

    for (const contactoId of Object.keys(porContacto).map(Number)) {
      const msgs = porContacto[contactoId];
      const ultimoInbound = [...msgs].reverse().find(m => !m.from_me);
      if (!ultimoInbound) continue; // no hay mensaje nuevo del padre en esta ventana de tiempo

      // ¿Ya se respondió DESPUÉS de ese mensaje? (por KAI o por un humano)
      const yaRespondido = msgs.some(m => m.from_me && m.date_message > ultimoInbound.date_message);
      if (yaRespondido) continue;

      // ¿Le acabamos de responder nosotros? El mensaje puede no haber llegado todavía a
      // Odoo, y sin esta revisión le contestaríamos por segunda vez.
      const cuandoRespondimos = _respondidosRecientes.get(contactoId);
      if (cuandoRespondimos && (Date.now() - cuandoRespondimos) < MINUTOS_ANTI_DUPLICADO * 60000) {
        continue;
      }

      // ===== LEER TODO LO QUE EL PADRE ESCRIBIÓ SIN RESPUESTA =====
      // Los papás mandan varios mensajes seguidos: "mi hijo estudia en Huehuetenango",
      // "es para noveno grado", "en el 2027", "estaré pendiente". Antes KAI solo leía el
      // ÚLTIMO ("estaré pendiente") y contestaba una cortesía vacía, ignorando todo el
      // contexto. Ahora se juntan todos los que quedaron sin responder.
      const fechaUltimaRespuesta = [...msgs].reverse().find(m => m.from_me)?.date_message || null;
      const mensajesSinResponderCrudos = msgs.filter(m => !m.from_me && (!fechaUltimaRespuesta || m.date_message > fechaUltimaRespuesta));
      const sinResponder = mensajesSinResponderCrudos.map(m => String(m.text || '').trim()).filter(Boolean);
      const textoCompletoDelPadre = sinResponder.length > 1
        ? sinResponder.join('\n')
        : (ultimoInbound.text || '');

      // Copia inmediata en nuestro propio respaldo de lo que el padre escribió — mismo
      // instante, no espera al respaldo diario. Usa el ID real del mensaje de Odoo, así
      // que si esta corrida se repite (cada 45 seg) no duplica nada.
      Tenant.findOne({ activo: true }).then(tenant => {
        if (!tenant) return;
        mensajesSinResponderCrudos.forEach(m => {
          MensajeRespaldo.create({
            tenant_id: tenant._id, contacto_id_acrux: contactoId, numero: String(numero || '').replace(/\D/g, ''),
            mensaje_id_odoo: m.id, de: 'padre', texto: m.text || '',
            fecha_mensaje: m.date_message ? new Date(m.date_message.replace(' ', 'T') + 'Z') : null
          }).catch(() => {}); // ya respaldado antes, o falla silencioso — no debe frenar la respuesta
        });
      }).catch(() => {});

      // ¿La conversación está TOMADA por un agente humano en el ChatRoom real de Odoo?
      // KAI no puede (ni debe) escribirle — la está atendiendo esa persona. Sincronizamos
      // nuestro registro a modo humano para reflejarlo en el panel y no reintentar.
      const agenteHumanoEnOdoo = agentePorContacto[contactoId];
      if (agenteHumanoEnOdoo) {
        // Se guarda TAMBIÉN el nombre de quien la tomó. Sin eso quedaba "modo humano
        // sin agente": ni la vendedora sabía que era suya ni KAI podía atenderla.
        await AsignacionAcrux.findOneAndUpdate(
          { tenant_id: tenant._id, contacto_id: contactoId },
          { modo: 'humano', fecha_modo_humano: new Date(), agente_nombre: agenteHumanoEnOdoo },
          { upsert: true, setDefaultsOnInsert: true }
        ).catch(() => {});
        console.log(`👤 [AcruxLab] Contacto ${contactoId} tomado por "${agenteHumanoEnOdoo}" en el ChatRoom real — KAI no interviene`);
        continue;
      }

      // ¿Ya está en modo "humano"? Entonces el chat es de esa vendedora y KAI NO se mete
      // más — ni ahora ni después. Antes existía una "auto-recuperación" que se lo quitaba
      // a los 30 minutos, pero se eliminó a propósito: si una agente ya lo atendió, el
      // padre espera seguir hablando con ella, no que el bot se meta a media conversación.
      // El chat queda marcado como PENDIENTE en su bandeja para que sepa que debe contestar.
      const asign = await AsignacionAcrux.findOne({ tenant_id: tenant._id, contacto_id: contactoId });
      if (asign?.modo === 'humano') {
        // Caso "tierra de nadie": está marcada como humana pero SIN agente asignado.
        // Así nadie la atiende: ni la vendedora (no sabe que es suya) ni KAI (cree que
        // hay alguien). Se corrige devolviéndola a KAI.
        if (!asign.agente_id && !asign.agente_nombre) {
          await AsignacionAcrux.updateOne({ _id: asign._id }, { modo: 'bot' });
          console.log(`🔧 [AcruxLab] Contacto ${contactoId} estaba en modo humano SIN agente — KAI lo retoma`);
        } else {
          continue; // sí tiene dueña, KAI no se mete
        }
      }

      const numero = extraerNumeroDeMsgid(ultimoInbound.msgid);
      if (!numero) continue; // sin número no podemos llevar memoria confiable — se deja para atención manual

      // ===== ¿ESTE PAPÁ YA ES DE ALGUIEN? =====
      // Si en Odoo ya está como OPORTUNIDAD (esas son de Sylvia) o ya tiene un vendedor
      // asignado, entonces ya lo está trabajando una persona: KAI no debe meterse.
      // KAI solo atiende a los NUEVOS, los que todavía no ha tomado nadie.
      try {
        // Los números de prueba del equipo se saltan esta regla: siempre se les atiende.
        const leadDelContacto = esNumeroDePrueba(numero) ? null : await buscarLeadExistente({ telefono: numero });
        // Solo las OPORTUNIDADES bloquean a KAI. Ojo: NO se bloquea por tener vendedor
        // asignado, porque el propio KAI asigna vendedora desde el primer contacto y
        // sigue atendiendo hasta que muestre interés real. Si se bloqueara por eso, KAI
        // le diría al papá "yo te puedo apoyar" y luego se quedaría callado — que es
        // justo lo que pasó. Cuando una vendedora de verdad toma el chat, eso se detecta
        // por el agente del ChatRoom o por el modo humano, más abajo.
        if (leadDelContacto && leadDelContacto.active !== false && leadDelContacto.type === 'opportunity') {
          // Las OPORTUNIDADES son de Sylvia por regla del colegio, sin importar qué
          // vendedor tengan puesto en Odoo. Los leads normales ya asignados se quedan
          // con quien los tenga.
          const esOportunidad = leadDelContacto.type === 'opportunity';
          let duenio = leadDelContacto.user_id?.[1] || null;
          let duenioId = null;
          if (esOportunidad) {
            const sylvia = await UsuarioPanel.findOne({
              tenant_id: tenant._id, activo: true,
              nombre: new RegExp('sylvia', 'i')
            });
            if (sylvia) { duenio = sylvia.nombre; duenioId = sylvia._id; }
            else duenio = duenio || 'Sylvia';
          }
          await AsignacionAcrux.findOneAndUpdate(
            { tenant_id: tenant._id, contacto_id: contactoId },
            {
              modo: 'humano', fecha_modo_humano: new Date(),
              agente_nombre: duenio || 'Sin asignar',
              ...(duenioId ? { agente_id: duenioId } : {}),
              sin_auto_recuperacion: true
            },
            { upsert: true, setDefaultsOnInsert: true }
          ).catch(() => {});
          console.log(`🔒 [AcruxLab] ${numero} es ${esOportunidad ? 'OPORTUNIDAD → ' + duenio : 'lead de ' + duenio} (#${leadDelContacto.id}) — KAI no interviene`);
          continue;
        }
      } catch (e) {
        console.error(`⚠️ [AcruxLab] No se pudo verificar si ${numero} ya tiene dueño en Odoo: ${e.message}`);
      }

      // El nombre del papá suele venir en la conversación de AcruxLab (del perfil de
      // WhatsApp). Si aún no lo tenemos guardado, lo tomamos de ahí — así KAI no le
      // pregunta "¿con quién tengo el gusto?" a alguien que ya se identificó.
      const nombreEnOdoo = odooPorContactoNombre[contactoId];
      if (nombreEnOdoo && !/^\+?\d+$/.test(nombreEnOdoo.trim())) {
        await Contacto.findOneAndUpdate(
          { tenant_id: tenant._id, numero },
          { $setOnInsert: { primer_contacto: new Date() }, $set: { nombre: nombreEnOdoo } },
          { upsert: true }
        ).catch(() => {});
      }

      try {
        const resultado = await atenderAcruxConIA(tenant, textoCompletoDelPadre, numero, contactoId);
        _respondidosRecientes.set(contactoId, Date.now()); // marcar ANTES de enviar, por si el envío tarda
        if (resultado.texto) {
          await enviarTextoAcruxLab(contactoId, resultado.texto);
        }
        // Antes este log se imprimía SIEMPRE, aunque la pausa hubiera bloqueado todo —
        // decía "(solo imagen)" incluso cuando no se mandó ni imagen ni texto. Ahora
        // refleja lo que de verdad pasó, revisando el motivo real del resultado.
        if (resultado.motivo === 'kai_pausado') {
          console.log(`⏸️ [AcruxLab] Contacto ${contactoId} — NO se envió nada (pausado en producción)`);
        } else {
          console.log(`🤖 KAI respondió por AcruxLab a contacto ${contactoId}${resultado.handoff ? ' (con traspaso a humano)' : ''}${!resultado.texto ? ' (solo imagen)' : ''}`);
        }
      } catch (e) {
        if (e.conversacionTomada) {
          // Un agente tomó la conversación justo antes de que KAI escribiera. No es un
          // fallo del sistema: se la dejamos a esa persona y la marcamos como suya, para
          // no volver a intentarlo cada 45 segundos ni llenar los logs de errores rojos.
          // Solo se marca como humana si de verdad hay un agente detrás. Si el rechazo
          // fue por otra causa (ej. la conversación en estado no editable), marcarla
          // humana la dejaría en tierra de nadie: sin vendedora y sin KAI.
          const agenteReal = agentePorContacto[contactoId] || null;
          if (agenteReal) {
            await AsignacionAcrux.findOneAndUpdate(
              { tenant_id: tenant._id, contacto_id: contactoId },
              { modo: 'humano', fecha_modo_humano: new Date(), agente_nombre: agenteReal },
              { upsert: true, setDefaultsOnInsert: true }
            ).catch(() => {});
            console.log(`👤 [AcruxLab] Contacto ${contactoId} lo tomó ${agenteReal} — KAI se retira`);
          } else {
            console.error(`⚠️ [AcruxLab] Odoo rechazó escribir en el contacto ${contactoId} pero NO hay agente asignado — se deja en modo bot para reintentar`);
          }
        } else {
          console.error(`❌ Error al procesar/responder AcruxLab contacto ${contactoId}:`, e.message);
        }
      }
    }
  } catch (e) {
    console.error('❌ Error en procesarNuevosMensajesAcruxLab:', e.message);
  } finally {
    _procesandoAcruxLab = false;
  }
}

// Corre cada 45 segundos — suficientemente rápido para no hacer esperar a la familia,
// sin saturar la API de Odoo con consultas constantes.
setInterval(procesarNuevosMensajesAcruxLab, 45000);

// Fuerza AHORA MISMO el motor que revisa mensajes sin responder en AcruxLab, en vez de
// esperar los 45 segundos del ciclo automático. Es el que responde conversaciones YA
// abiertas (como cuando un papá contesta algo y KAI todavía no le ha respondido) —
// distinto del motor proactivo, que solo contacta leads nuevos sin conversación previa.
app.post('/api/debug/forzar-respuesta-acrux', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    await procesarNuevosMensajesAcruxLab();
    res.json({ ok: true, mensaje: 'Motor de respuestas ejecutado' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
setTimeout(procesarNuevosMensajesAcruxLab, 8000); // primera corrida poco después de iniciar el servidor

// ===== MOTOR PROACTIVO — KAI contacta primero a los leads sin asignar =====
// Los leads del Formulario de Admisiones llegan a Odoo sin vendedor asignado y ahí se
// quedan hasta que alguien los llama a mano. Este motor los contacta por WhatsApp,
// KAI conversa con ellos (pide datos, manda imágenes, resuelve dudas) y, cuando el
// padre muestra interés real, el flujo normal de traspaso ya se encarga de crear el
// lead calificado y pasárselo a un vendedor.
//
// ⚠️ INTERRUPTOR: apagado por defecto. Se escribe a familias REALES, así que conviene
// probarlo primero con el botón "Contactar ahora (prueba)" antes de dejarlo automático.
const MOTOR_PROACTIVO_ACTIVO = true; // ACTIVO — contacta por AcruxLab (número oficial) cada 10 min en horario laboral
// Por dónde sale el primer contacto. DEBE ser 'acrux': ese es el número OFICIAL del
// colegio, el que las familias reconocen. El canal 'meta' usa el número 4052 2338, que
// es SOLO DE PRUEBAS — no debe usarse para escribirle a familias reales.
const CANAL_CONTACTO_PROACTIVO = 'acrux';
const MAX_LEADS_POR_CORRIDA = 5;   // de cuántos en cuántos, para no mandar una avalancha
// Arma el primer mensaje. Si el lead YA trae el nivel (viene del formulario), no se lo
// volvemos a preguntar — se le confirma que recibimos su solicitud para ese nivel y se
// le abre la conversación. Preguntar algo que el padre ya escribió se siente como que
// no leímos su solicitud.
const MENSAJE_PRIMER_CONTACTO = (primerNombre, nivel) => {
  const saludo = primerNombre ? `Hola ${primerNombre}` : 'Hola';
  const cabecera = `${saludo} 👋 Le escribimos del Colegio Capouilliez.`;

  if (nivel) {
    return `${cabecera}\n\n` +
      `Recibimos su solicitud de información para ${nivel} 🏫\n\n` +
      `Con gusto le ayudo con todo lo del proceso de admisión: cuotas, requisitos, horarios o lo que necesite saber.\n\n` +
      `¿Con qué le puedo ayudar primero?`;
  }

  return `${cabecera}\n\n` +
    `Recibimos su solicitud de información y con gusto le ayudamos con el proceso de admisiones 🏫\n\n` +
    `¿Para qué nivel educativo está buscando información?\n\n` +
    `1️⃣ Preprimaria\n2️⃣ Primaria\n3️⃣ Secundaria (Básico y Bachillerato)`;
};

// Normaliza el nivel que viene de Odoo a los tres que usamos (Básico y Bachillerato
// se unifican como Secundaria, igual que en el menú y en las imágenes).
function normalizarNivelParaMensaje(textoNivel) {
  const t = String(textoNivel || '').toLowerCase();
  if (!t || t === 'false') return null;
  if (t.includes('prepri') || t.includes('jard') || t.includes('kinder') || t.includes('párvul') || t.includes('parvul')) return 'Preprimaria';
  if (t.includes('secundaria') || t.includes('básico') || t.includes('basico') || t.includes('bachiller') || t.includes('diversificado')) return 'Secundaria';
  if (t.includes('primaria')) return 'Primaria';
  return null;
}

// ===== CONTACTO PROACTIVO POR ACRUXLAB (número oficial del colegio) =====
// Los mensajes por la API de Meta salen del número de pruebas, no del número oficial
// que las familias conocen. AcruxLab usa el conector real del colegio, así que el
// primer contacto sale del número correcto y la conversación queda en el ChatRoom,
// donde las vendedoras ya trabajan.
const ACRUX_CONNECTOR_ID = 2; // "Whatsapp conector" (apichat.io) — el número oficial

// Busca la conversación de AcruxLab para un número; si no existe, la crea.
async function obtenerOCrearConversacionAcrux(numero, nombre) {
  const existentes = await odooCallLocal('acrux.chat.conversation', 'search_read',
    [[['number', '=', numero]]],
    { fields: ['id', 'name', 'number', 'agent_id', 'status', 'connector_id', 'valid_number'], limit: 1 }
  ) || [];
  if (existentes.length) {
    const c = existentes[0];
    const uidServicioActual = await getOdooUID();
    // ¿El agente es una persona real, o somos nosotros mismos? Es una diferencia clave:
    // si es una vendedora, no nos metemos; si es nuestro usuario de servicio, KAI puede
    // escribir con normalidad.
    const agenteEsHumano = !!(c.agent_id && c.agent_id[0] !== uidServicioActual);

    // Se reactivan las conversaciones en 'new' (recién creadas, nunca se activaron) y
    // también en 'done' (el ChatRoom las da por terminadas — puede pasar por inactividad
    // larga, como en un caso real donde la última actividad fue de hace casi un año).
    // En ambos casos Odoo exige tener un agente para poder ponerlas en 'current', que es
    // el único estado donde se puede escribir.
    if ((c.status === 'new' || c.status === 'done') && !agenteEsHumano) {
      try {
        const cambios = { status: 'current' };
        if (!c.agent_id) cambios.agent_id = uidServicioActual;
        await odooCallLocal('acrux.chat.conversation', 'write', [[c.id], cambios]);
        console.log(`🔧 [AcruxLab] Conversación #${c.id} pasada de '${c.status}' a 'current' (agente de servicio asignado)`);
      } catch (e) {
        console.error(`⚠️ [AcruxLab] No se pudo activar la conversación #${c.id}: ${e.message}`);
      }
    }
    return { id: c.id, creada: false, agente: agenteEsHumano ? c.agent_id[1] : null, status: c.status, valid_number: c.valid_number };
  }

  // Al crear: el agente va desde el inicio, porque sin él Odoo no deja activarla.
  const uidServicio = await getOdooUID();
  const nuevoId = await odooCallLocal('acrux.chat.conversation', 'create', [{
    name: nombre || numero,
    number: numero,
    connector_id: ACRUX_CONNECTOR_ID,
    agent_id: uidServicio
  }]);
  if (!nuevoId) throw new Error('Odoo no devolvió el ID de la conversación creada');

  // Ya con agente, sí acepta el cambio a 'current', que es lo que permite escribir.
  await odooCallLocal('acrux.chat.conversation', 'write', [[nuevoId], { status: 'current' }]).catch(e => {
    console.error(`⚠️ [AcruxLab] No se pudo poner en 'current' la conversación #${nuevoId}: ${e.message}`);
  });

  const reciencreada = await odooCallLocal('acrux.chat.conversation', 'read',
    [[nuevoId], ['id', 'status', 'agent_id', 'valid_number', 'connector_id']]
  ).catch(() => null);
  const info = reciencreada?.[0] || {};
  console.log(`🆕 [AcruxLab] Conversación creada #${nuevoId} para ${numero} — status: ${info.status || '?'}, agente: ${info.agent_id?.[1] || 'ninguno'}`);

  // El agente somos nosotros (usuario de servicio), así que NO se reporta como "tomada
  // por un humano" — si se reportara, el motor se saltaría el envío que acaba de habilitar.
  const agenteHumano = !!(info.agent_id && info.agent_id[0] !== uidServicio);
  return { id: nuevoId, creada: true, agente: agenteHumano ? info.agent_id[1] : null, status: info.status, valid_number: info.valid_number };
}

// Genera las condiciones de búsqueda de teléfono cubriendo los formatos reales que se
// han visto en Odoo: KAI siempre escribe limpio ("50242140856", sin espacios ni +), pero
// leads creados por otros medios (entrada manual, importaciones) pueden traer espacios
// o el signo "+" (ej. "+502 4214 0856"). El operador 'like' de Odoo hace coincidencia de
// texto literal, así que un espacio de más rompe la búsqueda por completo — eso fue lo
// que pasó con Nery Mejía: su Oportunidad estaba como "+502 4214 0856" y la búsqueda con
// el número limpio "42140856" nunca la encontró, así que KAI creó un lead de más.
function condicionesTelefono(telefono, campos = ['phone', 'mobile']) {
  const soloDigitos = String(telefono || '').replace(/\D/g, '');
  const ultimos8 = soloDigitos.slice(-8);
  if (ultimos8.length !== 8) return [];

  // Variantes conocidas: pegado, con espacio a la mitad, con guion a la mitad
  const variantes = [
    ultimos8,
    ultimos8.slice(0, 4) + ' ' + ultimos8.slice(4),
    ultimos8.slice(0, 4) + '-' + ultimos8.slice(4),
  ];

  const condiciones = [];
  for (const campo of campos) {
    for (const variante of variantes) {
      condiciones.push([campo, 'like', variante]);
    }
  }
  return condiciones;
}

// ===== REGLA: ANTES DE CREAR UN LEAD EN ODOO, VERIFICAR QUE NO EXISTA =====
// Busca por teléfono (últimos 8 dígitos, para que dé igual el formato) y por correo.
// Devuelve el lead existente o null. Usarla SIEMPRE antes de crear, para no ensuciar
// el CRM con registros repetidos del mismo papá.
async function buscarLeadExistente({ telefono, correo } = {}) {
  const condiciones = [];
  if (telefono) {
    condiciones.push(...condicionesTelefono(telefono));
  }
  if (correo && String(correo).includes('@')) condiciones.push(['email_from', 'ilike', String(correo).trim()]);
  if (!condiciones.length) return null;

  // Odoo espera los OR (|) ANTES de las condiciones que unen
  const dominio = [];
  for (let i = 0; i < condiciones.length - 1; i++) dominio.push('|');
  condiciones.forEach(c => dominio.push(c));

  try {
    // Se buscan TAMBIÉN los perdidos/archivados (active_test: false). Cuando el equipo
    // marca un lead como perdido por estar repetido y ese papá vuelve a escribir, hay
    // que traer ESE contacto, no abrir uno nuevo — solo se anota por dónde volvió.
    const encontrados = await odooCallLocal('crm.lead', 'search_read',
      [dominio],
      {
        fields: ['id', 'name', 'partner_name', 'contact_name', 'phone', 'mobile', 'email_from', 'user_id', 'create_date', 'type', 'stage_id', 'active'],
        limit: 10, order: 'create_date desc',
        context: { active_test: false }
      }
    ) || [];
    if (!encontrados.length) return null;

    // Si hay activos, se prefiere el activo más reciente. Si todos están archivados,
    // se toma el más reciente de esos.
    const activos = encontrados.filter(l => l.active !== false);
    return activos.length ? activos[0] : encontrados[0];
  } catch (e) {
    console.error(`⚠️ No se pudo verificar si el lead ya existe: ${e.message}`);
    return null; // ante la duda no bloqueamos, pero queda registrado en los logs
  }
}

// Cuando un papá vuelve a escribir por cualquier canal y ya existe como contacto, NO se
// crea otro lead ni se reactiva nada: el registro repetido se queda como perdido, tal
// como lo maneja el equipo. Lo único que hacemos es dejar anotado por dónde volvió,
// para que el historial del contacto quede completo.
// Si un contacto que ya existía (por ejemplo, de años anteriores) vuelve a escribir y
// nunca tuvo vendedor asignado en Odoo, esto es simplemente el flujo normal: no hace
// falta crear nada nuevo, solo se le asigna uno por el reparto 1 a 1, igual que a
// cualquier candidato nuevo. Si ya tenía vendedor, no se toca.
async function asignarVendedorSiFalta(tenant, existente) {
  if (existente.user_id) return; // ya tenía, no se toca
  try {
    const agenteAsignado = await asignarAgenteLibre(tenant._id);
    if (agenteAsignado?.odoo_user_id) {
      await odooCallLocal('crm.lead', 'write', [[existente.id], { user_id: agenteAsignado.odoo_user_id }]).catch(() => {});
      console.log(`👤 [Reactivación] Lead #${existente.id} no tenía vendedor — asignado a ${agenteAsignado.nombre}`);
    }
  } catch (e) { /* si falla, no bloquea el resto del flujo */ }
}

async function anotarOrigenEnLead(leadId, estabaArchivado, textoOrigen) {
  await odooCallLocal('crm.lead', 'message_post', [[leadId]], {
    body: textoOrigen +
      `<br><i>No se creó lead nuevo: ya existía este contacto.</i>` +
      (estabaArchivado ? `<br><i>Nota: este lead está archivado/perdido. Se dejó tal cual.</i>` : '')
  }).catch(() => {});
}

// Marca un lead como PERDIDO en Odoo. Es lo que hace el equipo con los repetidos:
// si ese papá ya existe como contacto, el registro nuevo no se trabaja, se da por
// perdido. Se intenta con el método propio de Odoo y, si no está disponible, se
// archiva a mano.
async function marcarLeadComoPerdido(leadId, motivo) {
  await odooCallLocal('crm.lead', 'message_post', [[leadId]], { body: motivo }).catch(() => {});
  try {
    await odooCallLocal('crm.lead', 'action_set_lost', [[leadId]]);
    console.log(`🔴 [Odoo] Lead #${leadId} marcado como PERDIDO`);
    return { ok: true, metodo: 'action_set_lost' };
  } catch (e) {
    // Algunas versiones piden razón de pérdida o no exponen el método por RPC:
    // en ese caso lo archivamos, que también lo saca de las vistas activas.
    try {
      await odooCallLocal('crm.lead', 'write', [[leadId], { active: false, probability: 0 }]);
      console.log(`🔴 [Odoo] Lead #${leadId} archivado (no se pudo usar action_set_lost: ${e.message})`);
      return { ok: true, metodo: 'archivado' };
    } catch (e2) {
      console.error(`❌ [Odoo] No se pudo marcar como perdido el lead #${leadId}: ${e2.message}`);
      return { ok: false, error: e2.message };
    }
  }
}

async function contactarLeadPorAcruxLab(tenant, lead) {
  const marcarSinWhatsApp = async (nota) => {
    const tagSinWAId = await getOdooTagId(TAG_KAI_SIN_WHATSAPP);
    await odooCallLocal('crm.lead', 'write', [[lead.id], { tag_ids: [[4, tagSinWAId]] }]).catch(() => {});
    await odooCallLocal('crm.lead', 'message_post', [[lead.id]], {
      body: `⚠️ KAI no pudo contactar por WhatsApp: ${nota}. Queda para seguimiento manual del equipo.`
    }).catch(() => {});
  };

  const telCrudo = (lead.mobile && String(lead.mobile) !== 'false') ? lead.mobile
                 : ((lead.phone && String(lead.phone) !== 'false') ? lead.phone : null);

  // Sin teléfono en los campos, pero el dato puede venir DENTRO del correo del
  // formulario (llega así cuando Odoo no lo separa en campos). Antes de descartarlo,
  // KAI lee ese correo y saca los datos. Si de verdad no hay nada, ahí sí se marca.
  let telFinal = telCrudo;
  let datosDelCorreo = null;
  if (!telFinal) {
    try {
      const extraccion = await extraerDatosDelFormulario(lead.id);
      if (extraccion.ok && extraccion.datos) {
        datosDelCorreo = extraccion.datos;
        if (!datosDelCorreo.es_formulario_admisiones) {
          await marcarSinWhatsApp(`no es una solicitud de admisión (${datosDelCorreo.tema || 'otro tema'}): ${datosDelCorreo.motivo_descarte || ''}`);
          return { ok: false, motivo: 'no_es_admision', tema: datosDelCorreo.tema };
        }
        if (datosDelCorreo.telefono) {
          telFinal = datosDelCorreo.telefono;
          // Guardarlo en Odoo, para que el equipo también lo vea en la ficha del lead
          const actualiza = { phone: datosDelCorreo.telefono };
          if (datosDelCorreo.nombre_padre) { actualiza.contact_name = datosDelCorreo.nombre_padre; actualiza.partner_name = datosDelCorreo.nombre_padre; }
          if (datosDelCorreo.correo) actualiza.email_from = datosDelCorreo.correo;
          await odooCallLocal('crm.lead', 'write', [[lead.id], actualiza]).catch(() => {});
          await odooCallLocal('crm.lead', 'message_post', [[lead.id]], {
            body: `🤖 KAI leyó el correo del formulario y completó los datos: ${datosDelCorreo.nombre_padre || '—'} · ${datosDelCorreo.telefono} · ${datosDelCorreo.nivel || 'sin nivel'}`
          }).catch(() => {});
          console.log(`📄 [Motor proactivo] Datos extraídos del correo del lead #${lead.id}: ${datosDelCorreo.telefono}`);
        }
      }
    } catch (e) {
      console.error(`⚠️ No se pudo leer el correo del lead #${lead.id}: ${e.message}`);
    }
  }

  if (!telFinal) { await marcarSinWhatsApp('el registro no trae número de teléfono ni se encontró en el correo'); return { ok: false, motivo: 'sin_telefono' }; }

  let tel = String(telFinal).replace(/\D/g, '');
  if (tel.length === 8) tel = '502' + tel;
  if (tel.length < 11) { await marcarSinWhatsApp(`el número "${telFinal}" no parece válido`); return { ok: false, motivo: 'telefono_invalido' }; }

  // ===== INTERRUPTOR MAESTRO: KAI PAUSADO EN PRODUCCIÓN =====
  // Se revisa AQUÍ, después de clasificar (leer correo, poner teléfono/nombre/nivel,
  // etiquetar) — esa parte SIEMPRE debe correr, pausado o no, porque es solo organizar
  // datos en Odoo, no contactar a nadie. Lo que sí se detiene aquí es todo lo que sigue:
  // enviar el mensaje, asignar vendedora, y marcar como contactado.
  if (KAI_PAUSADO_PARA_PRODUCCION && !esNumeroDePrueba(tel)) {
    console.log(`⏸️ [Motor AcruxLab] KAI pausado en producción — lead #${lead.id} ya quedó clasificado, pero NO se contacta`);
    return { ok: false, motivo: 'kai_pausado_ya_clasificado' };
  }

  // ===== NO CONTACTAR DOS VECES AL MISMO NÚMERO =====
  // Un mismo papá puede tener varios leads en Odoo (llenó el formulario dos veces, o
  // el correo entró duplicado). Sin esta revisión, recibiría un mensaje por cada lead,
  // que es justo lo que no queremos que le pase a una familia.
  const yaContactado = await Contacto.findOne({ tenant_id: tenant._id, numero: tel });
  if (yaContactado?.ultimo_contacto) {
    const horasDesde = (Date.now() - new Date(yaContactado.ultimo_contacto).getTime()) / 3600000;
    if (horasDesde < 72) {
      // Solo se deja una nota de rastreo, SIN tocar el estado del lead (no perdido,
      // no archivado). El duplicado simplemente se salta — no le corresponde a KAI
      // decidir si algo se marca como perdido, esa es una decisión del equipo.
      await odooCallLocal('crm.lead', 'message_post', [[lead.id]], {
        body: `♻️ <b>Registro repetido</b>: al número ${tel} ya se le escribió hace ${Math.round(horasDesde)} h` +
          (yaContactado.odoo_lead_id && yaContactado.odoo_lead_id !== lead.id ? ` (lead #${yaContactado.odoo_lead_id})` : '') +
          `.<br>No se le volvió a escribir para no duplicar mensajes. <i>No se cambió el estado de este lead — el equipo decide qué hacer con los duplicados.</i>`
      }).catch(() => {});
      console.log(`♻️ [Motor proactivo] ${tel} ya contactado hace ${Math.round(horasDesde)}h — se salta el lead #${lead.id} (duplicado, sin tocar su estado)`);
      return { ok: false, motivo: 'duplicado_no_contactado', lead_original: yaContactado.odoo_lead_id || null, horas_desde: Math.round(horasDesde) };
    }
  }

  // ¿Este papá ya es de alguien? Si en Odoo ya está como OPORTUNIDAD (de Sylvia) o ya
  // tiene vendedor asignado, ya lo está trabajando una persona — KAI no lo contacta.
  try {
    const yaEsDeAlguien = await buscarLeadExistente({ telefono: tel });
    // Solo las OPORTUNIDADES lo excluyen. Un lead con vendedor asignado puede seguir
    // siendo trabajado por KAI, que es justamente lo que se busca.
    if (yaEsDeAlguien && yaEsDeAlguien.id !== lead.id && yaEsDeAlguien.active !== false && yaEsDeAlguien.type === 'opportunity') {
      const duenio = yaEsDeAlguien.user_id?.[1] || 'Sylvia (oportunidad)';
      // Aquí NO se marca como perdido: es una oportunidad ACTIVA que alguien está
      // trabajando de verdad. Marcarla como perdida podría arruinar un caso real en
      // curso. Solo se deja constancia de que KAI no se metió, sin tocar su estado.
      await odooCallLocal('crm.lead', 'message_post', [[lead.id]], {
        body: `🔒 <b>Ya lo está trabajando ${duenio}</b>: este papá ya existe como ${yaEsDeAlguien.type === 'opportunity' ? 'OPORTUNIDAD' : 'lead asignado'} (#${yaEsDeAlguien.id}).<br>KAI no lo contactó para no interferir con el seguimiento que ya lleva esa persona. <i>No se cambió el estado de este lead.</i>`
      }).catch(() => {});
      console.log(`🔒 [Motor proactivo] ${tel} ya es de ${duenio} (lead #${yaEsDeAlguien.id}) — no se contacta, sin tocar su estado`);
      return { ok: false, motivo: 'ya_es_de_un_agente', duenio, lead_existente: yaEsDeAlguien.id };
    }
  } catch (e) { /* si falla la revisión, seguimos con el flujo normal */ }

  const nombre = lead.partner_name || lead.contact_name || datosDelCorreo?.nombre_padre || null;
  const primerNombre = nombre ? nombre.split(' ')[0] : null;
  const nivel = normalizarNivelParaMensaje(lead.x_studio_comentarios) || normalizarNivelParaMensaje(datosDelCorreo?.nivel);
  const texto = MENSAJE_PRIMER_CONTACTO(primerNombre, nivel);

  let conversacion;
  try {
    conversacion = await obtenerOCrearConversacionAcrux(tel, nombre);
  } catch (e) {
    console.error(`❌ [Motor proactivo] No se pudo abrir conversación en AcruxLab para ${tel}: ${e.message}`);
    return { ok: false, motivo: 'no_se_pudo_crear_conversacion', detalle: e.message };
  }

  // Si ya la tenía tomada una vendedora, no nos metemos: es su conversación.
  if (conversacion.agente) {
    console.log(`👤 [Motor proactivo] ${tel} ya lo atiende ${conversacion.agente} en el ChatRoom — KAI no interviene`);
    return { ok: false, motivo: 'ya_atendido_por_agente', agente: conversacion.agente };
  }

  // ¿Este papá YA nos escribió por su cuenta? Entonces NO corresponde mandarle el mensaje
  // de primer contacto ("te escribimos porque recibimos tu solicitud"): él inició la
  // conversación, y ese texto lo confunde. El motor normal ya lo está atendiendo.
  try {
    const mensajesPrevios = await odooCallLocal('acrux.chat.message', 'search_read',
      [[['contact_id', '=', conversacion.id], ['from_me', '=', false]]],
      { fields: ['id'], limit: 1 }
    ) || [];
    if (mensajesPrevios.length) {
      const tagYaEscribio = await getOdooTagId(TAG_KAI_CONTACTADO);
      await odooCallLocal('crm.lead', 'write', [[lead.id], { tag_ids: [[4, tagYaEscribio]] }]).catch(() => {});
      await odooCallLocal('crm.lead', 'message_post', [[lead.id]], {
        body: `💬 No se envió el mensaje de primer contacto: este papá YA había escrito por su cuenta al número oficial. KAI lo está atendiendo en esa conversación.`
      }).catch(() => {});
      console.log(`💬 [Motor proactivo] ${tel} ya había escrito por su cuenta — no se le manda el mensaje de primer contacto`);
      return { ok: false, motivo: 'ya_escribio_por_su_cuenta', conversacion_acrux: conversacion.id };
    }
  } catch (e) { /* si falla la revisión, seguimos con el flujo normal */ }

  try {
    await enviarTextoAcruxLab(conversacion.id, texto);
  } catch (e) {
    console.error(`❌ [Motor proactivo] Falló el envío por AcruxLab a ${tel}: ${e.message}`);
    return { ok: false, motivo: 'envio_rechazado', detalle: e.message };
  }

  // Registro en Odoo + asignación de vendedora (igual que en el flujo por Meta)
  const tagContactadoId = await getOdooTagId(TAG_KAI_CONTACTADO);
  await odooCallLocal('crm.lead', 'write', [[lead.id], { tag_ids: [[4, tagContactadoId]] }]).catch(() => {});

  let vendedorAsignado = null;
  try {
    vendedorAsignado = await asignarAgenteLibre(tenant._id);
    if (vendedorAsignado?.odoo_user_id) {
      await odooCallLocal('crm.lead', 'write', [[lead.id], { user_id: vendedorAsignado.odoo_user_id }]).catch(() => {});
    }
  } catch (e) { /* no bloquea el contacto */ }

  await odooCallLocal('crm.lead', 'message_post', [[lead.id]], {
    body: `📱 KAI contactó por el número oficial (AcruxLab, ${tel}).` +
          (vendedorAsignado ? ` Asignado a ${vendedorAsignado.nombre}.` : '') +
          ` KAI seguirá atendiendo para recabar datos y lo traspasará cuando muestre interés real.`
  }).catch(() => {});

  // Dejar la asignación registrada en nuestro control de AcruxLab, en modo bot
  await AsignacionAcrux.findOneAndUpdate(
    { tenant_id: tenant._id, contacto_id: conversacion.id },
    {
      $set: { modo: 'bot' },
      $setOnInsert: {
        agente_id: vendedorAsignado?._id || null,
        agente_nombre: vendedorAsignado?.nombre || null
      }
    },
    { upsert: true, setDefaultsOnInsert: true }
  ).catch(() => {});

  const zona = (lead.x_studio_notas_1 && String(lead.x_studio_notas_1) !== 'false' && !String(lead.x_studio_notas_1).startsWith('http'))
    ? String(lead.x_studio_notas_1) : (datosDelCorreo?.zona || null);

  await Contacto.findOneAndUpdate(
    { tenant_id: tenant._id, numero: tel },
    {
      $set: {
        nombre: nombre || undefined,
        odoo_lead_id: lead.id,
        canal_origen: 'formulario_admisiones',
        nivel_interes: nivel || undefined,
        zona: zona || undefined,
        correo: (lead.email_from && String(lead.email_from) !== 'false') ? lead.email_from : undefined,
        ultimo_contacto: new Date()
      },
      $setOnInsert: { primer_contacto: new Date() }
    },
    { upsert: true }
  ).catch(() => {});

  console.log(`📤 [Motor proactivo] KAI contactó a ${nombre || tel} por AcruxLab (lead #${lead.id}, conv #${conversacion.id}${conversacion.creada ? ', conversación nueva' : ''})${nivel ? ' — ' + nivel : ''}`);
  return { ok: true, telefono: tel, nombre, nivel, conversacion_acrux: conversacion.id, conversacion_creada: conversacion.creada, vendedor: vendedorAsignado?.nombre || null };
}


async function contactarLeadPorWhatsApp(tenant, lead) {
  // Marca el lead para que no se vuelva a intentar en cada corrida. Sin esto, los
  // registros sin teléfono (correos del formulario, boletines, etc.) se re-consultaban
  // cada 10 minutos para siempre y ocupaban los cupos de los papás reales.
  const marcarSinWhatsApp = async (nota) => {
    const tagSinWAId = await getOdooTagId(TAG_KAI_SIN_WHATSAPP);
    await odooCallLocal('crm.lead', 'write', [[lead.id], { tag_ids: [[4, tagSinWAId]] }]).catch(() => {});
    await odooCallLocal('crm.lead', 'message_post', [[lead.id]], {
      body: `⚠️ KAI no pudo contactar por WhatsApp: ${nota}. Queda para seguimiento manual del equipo.`
    }).catch(() => {});
  };

  const telCrudo = (lead.mobile && String(lead.mobile) !== 'false') ? lead.mobile
                 : ((lead.phone && String(lead.phone) !== 'false') ? lead.phone : null);
  if (!telCrudo) {
    await marcarSinWhatsApp('el registro no trae número de teléfono');
    return { ok: false, motivo: 'sin_telefono' };
  }

  let tel = String(telCrudo).replace(/\D/g, '');
  if (tel.length === 8) tel = '502' + tel;
  if (tel.length < 11) {
    await marcarSinWhatsApp(`el número "${telCrudo}" no parece válido`);
    return { ok: false, motivo: 'telefono_invalido' };
  }

  // ===== INTERRUPTOR MAESTRO: KAI PAUSADO EN PRODUCCIÓN =====
  // Después de clasificar (leer correo, teléfono/nombre/nivel) — eso siempre corre.
  // Lo que se detiene aquí es el envío del mensaje.
  if (KAI_PAUSADO_PARA_PRODUCCION && !esNumeroDePrueba(tel)) {
    console.log(`⏸️ [Motor WhatsApp] KAI pausado en producción — lead #${lead.id} ya quedó clasificado, pero NO se contacta`);
    return { ok: false, motivo: 'kai_pausado_ya_clasificado' };
  }

  const nombre = lead.partner_name || lead.contact_name || null;
  const primerNombre = nombre ? nombre.split(' ')[0] : null;
  const nivel = normalizarNivelParaMensaje(lead.x_studio_comentarios);

  const resultado = await enviarWhatsAppMeta(tel, MENSAJE_PRIMER_CONTACTO(primerNombre, nivel));

  if (resultado?.messages?.length) {
    const tagContactadoId = await getOdooTagId(TAG_KAI_CONTACTADO);
    await odooCallLocal('crm.lead', 'write', [[lead.id], { tag_ids: [[4, tagContactadoId]] }]).catch(() => {});

    // Asignar vendedor DESDE YA (reparto 1 a 1), aunque KAI siga atendiendo la
    // conversación. Así la vendedora ve el lead como suyo desde el primer momento y
    // puede seguirlo, mientras KAI hace el trabajo de pedir datos y resolver dudas.
    // El traspaso real (cuando KAI deja de responder) ocurre después, al detectar
    // interés de verdad — y se le entrega a ESTA MISMA vendedora, no a otra.
    let vendedorAsignado = null;
    try {
      vendedorAsignado = await asignarAgenteLibre(tenant._id);
      if (vendedorAsignado?.odoo_user_id) {
        await odooCallLocal('crm.lead', 'write', [[lead.id], { user_id: vendedorAsignado.odoo_user_id }]).catch(() => {});
      }
    } catch (e) { /* si falla la asignación, el lead sigue sin vendedor — no bloquea el contacto */ }

    await odooCallLocal('crm.lead', 'message_post', [[lead.id]], {
      body: `📱 KAI contactó por WhatsApp (${tel}) automáticamente.` +
            (vendedorAsignado ? ` Asignado a ${vendedorAsignado.nombre}.` : '') +
            ` KAI seguirá atendiendo para recabar datos y se lo traspasará cuando muestre interés real.`
    }).catch(() => {});

    // Vincular el contacto para que, cuando conteste, KAI ya sepa de qué lead viene,
    // qué nivel pidió y en qué zona vive — así no le vuelve a preguntar lo que ya
    // escribió en el formulario, y no se crea un lead duplicado en Odoo.
    const zona = (lead.x_studio_notas_1 && String(lead.x_studio_notas_1) !== 'false' && !String(lead.x_studio_notas_1).startsWith('http'))
      ? String(lead.x_studio_notas_1) : null;

    await Contacto.findOneAndUpdate(
      { tenant_id: tenant._id, numero: tel },
      {
        $set: {
          nombre: nombre || undefined,
          odoo_lead_id: lead.id,
          canal_origen: 'formulario_admisiones',
          nivel_interes: nivel || undefined,
          zona: zona || undefined,
          correo: (lead.email_from && String(lead.email_from) !== 'false') ? lead.email_from : undefined,
          ultimo_contacto: new Date()
        },
        $setOnInsert: { primer_contacto: new Date() }
      },
      { upsert: true }
    ).catch(() => {});

    // Crear la conversación en el panel desde YA — así el equipo ve, en Chats en Vivo,
    // a quién le escribió KAI y qué le dijo, sin tener que esperar a que el padre
    // conteste. Queda en estado 'bot' (visible con el interruptor "Ver los que atiende KAI").
    try {
      const yaExiste = await Conversacion.findOne({ tenant_id: tenant._id, numero: tel, estado: { $ne: 'cerrado' } });
      if (!yaExiste) {
        await Conversacion.create({
          tenant_id: tenant._id,
          numero: tel,
          nombre: nombre || null,
          canal: 'whatsapp',
          estado: 'bot', // KAI sigue atendiendo, aunque ya tenga vendedora asignada
          agente_id: vendedorAsignado?._id || null,
          agente_nombre: vendedorAsignado?.nombre || null,
          motivo: `Contacto proactivo de KAI — lead #${lead.id} del Formulario de Admisiones${nivel ? ' (' + nivel + ')' : ''}`,
          mensajes: [{ de: 'bot', texto: MENSAJE_PRIMER_CONTACTO(primerNombre, nivel), fecha: new Date() }],
          ultimaActividad: new Date()
        });
      }
    } catch (e) {
      console.error(`⚠️ No se pudo crear la conversación en el panel para ${tel}: ${e.message}`);
    }

    console.log(`📤 [Motor proactivo] KAI contactó a ${nombre || tel} (lead #${lead.id})${nivel ? ' — nivel: ' + nivel : ''}`);
    return { ok: true, telefono: tel, nombre, nivel };
  }

  // No se pudo enviar — lo marcamos para que el equipo lo llame a mano
  const tagSinWAId = await getOdooTagId(TAG_KAI_SIN_WHATSAPP);
  await odooCallLocal('crm.lead', 'write', [[lead.id], { tag_ids: [[4, tagSinWAId]] }]).catch(() => {});
  const detalleError = resultado?.error?.message || 'sin respuesta de Meta';
  console.error(`❌ [Motor proactivo] No se pudo contactar el lead #${lead.id} (${tel}): ${detalleError}`);
  return { ok: false, motivo: 'envio_rechazado', detalle: detalleError };
}

// Busca en Odoo los leads sin asignar que todavía no ha contactado KAI.
async function buscarLeadsPendientesDeContactar(limite) {
  const tagContactadoId = await getOdooTagId(TAG_KAI_CONTACTADO);
  const tagSinWAId = await getOdooTagId(TAG_KAI_SIN_WHATSAPP);
  const hace30d = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().replace('T', ' ').substring(0, 19);

  return await odooCallLocal('crm.lead', 'search_read',
    [[
      ['active', '=', true],
      ['user_id', '=', false],                 // sin vendedor asignado
      ['create_date', '>=', hace30d],
      ['tag_ids', 'not in', [tagContactadoId, tagSinWAId]] // que KAI no haya tocado ya
    ]],
    { fields: ['id', 'name', 'phone', 'mobile', 'partner_name', 'contact_name', 'email_from', 'create_date', 'x_studio_comentarios', 'x_studio_notas_1'], limit: limite, order: 'create_date desc' }
  ) || [];
}

let _procesandoMotorProactivo = false;
async function motorProactivoContactarLeads() {
  if (!MOTOR_PROACTIVO_ACTIVO) return;
  if (_procesandoMotorProactivo) return;
  _procesandoMotorProactivo = true;
  try {
    const tenant = await Tenant.findOne({ activo: true });
    if (!tenant) return;

    const leads = await buscarLeadsPendientesDeContactar(MAX_LEADS_POR_CORRIDA * 3);
    if (!leads.length) return;

    // Primero los que sí tienen teléfono (papás reales), después los demás — así los
    // registros sin número no consumen los cupos de la corrida.
    const conTelefono = leads.filter(l => (l.mobile && String(l.mobile) !== 'false') || (l.phone && String(l.phone) !== 'false'));
    const sinTelefono = leads.filter(l => !conTelefono.includes(l));
    const aProcesar = [...conTelefono.slice(0, MAX_LEADS_POR_CORRIDA), ...sinTelefono];

    console.log(`🎯 [Motor proactivo] ${conTelefono.length} con teléfono, ${sinTelefono.length} sin teléfono (se leerá el correo de cada uno)`);
    const numerosYaVistos = new Map(); // número → id del lead que sí se contactó
    for (const lead of aProcesar) {
      // Si dos leads de esta misma corrida traen el mismo teléfono (duplicados en Odoo),
      // solo se contacta el primero — la familia no debe recibir el mensaje dos veces.
      const telLead = String(
        (lead.mobile && String(lead.mobile) !== 'false') ? lead.mobile
        : ((lead.phone && String(lead.phone) !== 'false') ? lead.phone : '')
      ).replace(/\D/g, '');
      if (telLead && telLead.length >= 8) {
        const clave = telLead.slice(-8);
        if (numerosYaVistos.has(clave)) {
          // Se salta, pero hay que MARCARLO: si no, vuelve a aparecer como pendiente
          // en cada corrida (cada 10 minutos) y nunca sale de la lista.
          const idPrincipal = numerosYaVistos.get(clave);
          await odooCallLocal('crm.lead', 'message_post', [[lead.id]], {
            body: `♻️ <b>Registro repetido</b>: este papá ya existe como contacto y se está atendiendo en el lead #${idPrincipal} (número ...${clave}).<br>No se le escribió, para no mandarle dos mensajes a la misma familia. <i>No se cambió el estado de este lead — el equipo decide qué hacer con los duplicados.</i>`
          }).catch(() => {});
          continue;
        }
        numerosYaVistos.set(clave, lead.id);
      }
      const contactar = CANAL_CONTACTO_PROACTIVO === 'acrux' ? contactarLeadPorAcruxLab : contactarLeadPorWhatsApp;
      await contactar(tenant, lead);
      await new Promise(r => setTimeout(r, 3000)); // pausa entre envíos, para no saturar
    }
  } catch (e) {
    console.error('❌ Error en motorProactivoContactarLeads:', e.message);
  } finally {
    _procesandoMotorProactivo = false;
  }
}

setInterval(motorProactivoContactarLeads, 10 * 60000); // cada 10 minutos
setTimeout(motorProactivoContactarLeads, 30000);       // primera corrida a los 30 segundos de arrancar

// Pasa una conversación a estado "esperando_agente" y le asigna uno si hay disponible
// Genera un resumen breve usando IA del historial de conversación con KAI
async function generarResumenParaAgente(numeroOrigen) {
  const conv = conversaciones.get(numeroOrigen);
  const historial = conv?.historial || [];
  if (!historial.length) return 'El padre/madre acaba de iniciar la conversación, aún no ha compartido información.';

  const textoConversacion = historial.map(m => `${m.role === 'user' ? 'Padre' : 'KAI'}: ${m.content}`).join('\n');
  const promptResumen = `Resume en máximo 3 líneas, en texto plano sin asteriscos, lo que este padre/madre ya preguntó o compartió en la conversación con KAI, para que un asesor humano pueda continuar sin repetir preguntas. Incluye nombre del alumno/nivel si se mencionó, y cuál fue la última duda sin resolver. Conversación:\n\n${textoConversacion}`;

  const resumen = await llamarClaude('Eres un asistente que resume conversaciones de atención al cliente de forma breve y útil.', [{ role: 'user', content: promptResumen }], 200);
  return resumen || 'No se pudo generar resumen automático. Revisa el historial completo del chat.';
}

// Genera un resumen breve usando IA del historial de mensajes con el agente humano
async function generarResumenParaKai(conv) {
  const mensajesAgente = (conv.mensajes || []).filter(m => m.de === 'agente' || m.de === 'padre');
  if (!mensajesAgente.length) return null;

  const textoConversacion = mensajesAgente.map(m => `${m.de === 'padre' ? 'Padre' : 'Asesor'}: ${m.texto}`).join('\n');
  const promptResumen = `Resume en máximo 3 líneas, en texto plano sin asteriscos, lo que ocurrió en esta conversación entre un asesor humano y un padre de familia, para que el asistente KAI pueda retomar la conversación sin repetir lo ya resuelto. Conversación:\n\n${textoConversacion}`;

  const resumen = await llamarClaude('Eres un asistente que resume conversaciones de atención al cliente de forma breve y útil.', [{ role: 'user', content: promptResumen }], 200);
  return resumen || null;
}

async function iniciarHandoff(tenant, numero, nombre, motivoMsg) {
  let conv = await Conversacion.findOne({ tenant_id: tenant._id, numero, estado: { $ne: 'cerrado' } });
  if (!conv) {
    conv = await Conversacion.create({ tenant_id: tenant._id, numero, nombre, estado: 'esperando_agente', motivo: motivoMsg });
  } else {
    conv.estado = 'esperando_agente';
    conv.motivo = motivoMsg;
    conv.ultimaActividad = new Date();
  }

  // Generar resumen de KAI para que el agente vea contexto al entrar
  conv.resumen_kai = await generarResumenParaAgente(numero);

  // Si esta conversación YA tenía vendedora asignada (ej. desde el contacto proactivo
  // del formulario), se le entrega a ELLA — no se vuelve a sortear. El padre ya viene
  // siendo seguido por esa persona y cambiarla a media conversación no tiene sentido.
  let agente = null;
  if (conv.agente_id) {
    agente = await UsuarioPanel.findById(conv.agente_id);
  }
  if (!agente) {
    agente = await asignarAgenteLibre(tenant._id);
  }

  if (agente) {
    conv.estado = 'humano';
    conv.agente_id = agente._id;
    conv.agente_nombre = agente.nombre;
  }
  await conv.save();
  return { conv, agente };
}

// Frases que indican interés real de avanzar el proceso (no solo curiosidad)
// ===== SISTEMA DE 3 NIVELES DE CALOR DEL LEAD =====
// Nivel 1 — 🔴 Alta Intención: el padre quiere actuar YA (inscribir, agendar, confirmar)
// Nivel 2 — 🟡 Interesado: ya dio datos del alumno y preguntó cuotas/proceso, pero no pidió agendar
// Nivel 3 — ⚪ Exploratorio: solo hizo preguntas generales sin comprometerse a nada
//
// Esta función reemplaza al antiguo detector binario "detectaInteresReal".
// Devuelve { nivel: 1|2|3, etiqueta: string } o null si no hay suficiente señal todavía.
// Detector independiente de Nivel 1 (Alta Intención) — usado para decidir el handoff inmediato,
// sin necesitar el objeto Contacto completo (se evalúa antes de tenerlo actualizado).
// Detecta mensajes de PROVEEDORES ofreciendo productos/servicios al colegio (no son
// padres de familia). Caso real que lo motivó: una promotora de productos eléctricos
// escribió ofreciendo su catálogo, y como no decía nada de admisiones, la IA respondió
// de forma genérica ofreciendo conectarla con un asesor — y el mecanismo que evita que
// Kai incumpla sus propias promesas terminó convirtiendo eso en un traspaso real a una
// vendedora. Este filtro corre ANTES de que la IA responda, para que ni siquiera llegue
// a ese punto: si se detecta, se responde con un mensaje fijo y no se asigna vendedora
// ni se crea ningún lead.
function esProveedorOAjenoAAdmisiones(texto) {
  const t = (texto || '').toLowerCase();
  const señalesProveedor = /promotor(a)?\s+de\s+la\s+marca|represent(o|amos)\s+a\s+la\s+marca|distribuidor(a)?\s+(de|autorizad)|pongo\s+a\s+su\s+disposici[oó]n|ponemos\s+a\s+su\s+disposici[oó]n|nuestra\s+l[ií]nea\s+de\s+productos|cat[aá]logo\s+de\s+productos|precios\s+especiales\s+para|atenci[oó]n\s+personalizada\s+para\s+sus\s+requerimientos|le\s+comparto\s+(mi\s+contacto\s+y\s+)?(nuestro\s+)?cat[aá]logo/.test(t);
  const mencionaAdmision = /hijo|hija|alumn[oa]|inscrib|admisi[oó]n|colegiatura|matr[ií]cula|cupo|ni[ñn][oa]/.test(t);
  return señalesProveedor && !mencionaAdmision;
}
const MENSAJE_RESPUESTA_PROVEEDOR = 'Gracias por escribirnos 🙌 Este medio es exclusivo para temas de admisiones del Colegio Capouilliez. Para propuestas comerciales o de proveedores, le pedimos amablemente escribir a nuestro correo institucional. ¡Que tenga un excelente día!';

function esAltaIntencion(texto, ultimoMensajeBot) {
  const t = (texto || '').toLowerCase().trim();
  // Ojo con el plural: los papás muchas veces escriben como pareja ("NOS gustaría
  // agendar una cita"), y antes solo se reconocía el singular ("me gustaría"), así que
  // esa intención clarísima se pasaba por alto. También se agregó "cita" y "recorrido",
  // que es como suelen pedir la visita al colegio.
  const fraseAltaIntencion = /(quiero|quisiera|queremos|quisi[eé]ramos|deseo|deseamos|me gustar[ií]a|nos gustar[ií]a|necesito|necesitamos|estoy interesad[oa] en|estamos interesad[oa]s en|me interesa|nos interesa)\s+(inscribir|agendar|programar|coordinar|una (visita|cita)|el open house|conocer las instalaciones|que mi hijo|que mi hija|que (mi|el|la)\s*\w+\s*(estudie|entre|vaya))|c[oó]mo (inscribo|agendo|hago para inscribir)|quiero inscribirlo|quiero inscribirla|aparta(me)? (un cupo|lugar)|agendar (una )?(cita|visita|recorrido)|inscribir(lo|la)?\s*(a mi hijo|a mi hija)?$/.test(t);
  const esAfirmacionSimple = /^(s[ií]|s[ií] por favor|s[ií] claro|claro|dale|ok|okay|de acuerdo|perfecto|me parece bien|s[ií] me interesa|correcto|exacto|as[ií] es)\.?!?$/.test(t);
  const botPreguntoAgendar = /agendar|visita|asesor|coordinar|conectar(te)? con un asesor/.test((ultimoMensajeBot || '').toLowerCase());
  return fraseAltaIntencion || (esAfirmacionSimple && botPreguntoAgendar);
}

function calcularNivelInteres(texto, ultimoMensajeBot, contacto) {
  const t = (texto || '').toLowerCase().trim();

  // ---- NIVEL 1 — ALTA INTENCIÓN ----
  const fraseAltaIntencion = /(quiero|quisiera|deseo|me gustar[ií]a|necesito|estoy interesad[oa] en|me interesa)\s+(inscribir|agendar|una visita|el open house|que mi hijo|que mi hija|que (mi|el|la)\s*\w+\s*(estudie|entre|vaya))|c[oó]mo (inscribo|agendo|hago para inscribir)|quiero inscribirlo|quiero inscribirla|aparta(me)? (un cupo|lugar)|inscribir(lo|la)?\s*(a mi hijo|a mi hija)?$/.test(t);

  const esAfirmacionSimple = /^(s[ií]|s[ií] por favor|s[ií] claro|claro|dale|ok|okay|de acuerdo|perfecto|me parece bien|s[ií] me interesa|correcto|exacto|as[ií] es)\.?!?$/.test(t);
  const botPreguntoAgendar = /agendar|visita|asesor|coordinar|conectar(te)? con un asesor/.test((ultimoMensajeBot || '').toLowerCase());
  const confirmacionAgendar = esAfirmacionSimple && botPreguntoAgendar;

  if (fraseAltaIntencion || confirmacionAgendar) {
    return { nivel: 1, etiqueta: 'KAI — Alta Intención' };
  }

  // ---- NIVEL 2 — INTERESADO ----
  // Ya tiene datos clave del alumno capturados (nombre del alumno + nivel educativo)
  // y preguntó sobre cuotas, requisitos o proceso de admisión — señal de interés serio sin urgencia de agendar.
  const preguntoProcesoOcuotas = /cuota|colegiatura|precio|costo|requisito|inscripci[oó]n|proceso de admisi[oó]n|c[oó]mo es el proceso/.test(t);
  const tieneDatosClave = !!(contacto?.nombre_alumno && contacto?.nivel_interes);

  if (tieneDatosClave && preguntoProcesoOcuotas) {
    return { nivel: 2, etiqueta: 'KAI — Interesado' };
  }
  // (Quitado a propósito: antes también marcaba "Interesado" con solo tener nombre+nivel
  // capturados, sin importar la pregunta — eso etiquetaba casi cualquier lead nuevo de
  // WhatsApp como interesado apenas daba esos 2 datos básicos, demasiado pronto/prematuro.)

  // ---- NIVEL 3 — EXPLORATORIO ----
  // Si ya dio AL MENOS el nivel educativo de interés, cuenta como lead exploratorio (no solo curiosidad anónima).
  if (contacto?.nivel_interes) {
    return { nivel: 3, etiqueta: 'KAI — Exploratorio' };
  }

  return null; // Aún no hay suficiente señal para clasificar — no crear nada todavía
}

// Extrae datos del padre/alumno del historial usando IA, actualiza Contacto, y crea lead en Odoo si hay interés real
async function actualizarContactoYDetectarInteres(tenant, numero, mensajeUsuario, respuestaBot, historial, contactoExistente) {
  // 1. Extraer datos estructurados con IA (nombre, alumno, nivel, zona, colegio, correo, consentimiento marketing)
  const textoConversacion = historial.map(m => `${m.role === 'user' ? 'Padre' : 'KAI'}: ${m.content}`).join('\n');
  const promptExtraccion = `De esta conversación de WhatsApp entre un padre/madre y un asistente de admisiones escolar, extrae SOLO estos datos si están presentes (responde ÚNICAMENTE un JSON válido, sin texto adicional, sin markdown):
{"nombre":"nombre del padre/madre o null","nombre_alumno":"nombre del hijo/a o null","nivel_interes":"Preprimaria/Primaria/Básico/Bachillerato o null","fecha_nacimiento_alumno":"fecha si la dio o null","zona":"zona o null","colegio_actual":"colegio actual o null","correo":"correo o null","acepta_marketing":"true si el padre aceptó recibir noticias/promociones del colegio, false si lo rechazó explícitamente, o null si no se le ha preguntado o no respondió claro"}

Conversación:
${textoConversacion}`;

  let datosExtraidos = {};
  try {
    const respuestaIA = await llamarClaude('Extraes datos estructurados de conversaciones. Respondes solo JSON válido.', [{ role: 'user', content: promptExtraccion }], 300);
    if (respuestaIA) {
      const jsonLimpio = respuestaIA.replace(/```json|```/g, '').trim();
      datosExtraidos = JSON.parse(jsonLimpio);
    }
  } catch (e) { console.warn('⚠️ No se pudo extraer datos del contacto:', e.message); }

  // 2. Actualizar o crear el Contacto en MongoDB (memoria persistente)
  const update = { ultimo_contacto: new Date(), $inc: { total_conversaciones: contactoExistente ? 0 : 1 } };
  const setFields = {};
  Object.keys(datosExtraidos).forEach(k => {
    const valor = datosExtraidos[k];
    if (valor === null || valor === 'null' || valor === undefined) return;
    if (k === 'acepta_marketing') {
      // Solo registrar el consentimiento si aún no se había guardado uno (no sobrescribir un "no" con ambigüedad futura)
      if (contactoExistente?.acepta_marketing === null || contactoExistente?.acepta_marketing === undefined) {
        setFields.acepta_marketing = (valor === true || valor === 'true');
        setFields.acepta_marketing_fecha = new Date();
      }
      return;
    }
    setFields[k] = valor;
  });
  if (Object.keys(setFields).length) update.$set = setFields;
  if (!update.$set) update.$set = {};
  // Generar resumen corto de en qué quedó la conversación
  try {
    const resumenCorto = await llamarClaude('Resumes en una sola frase corta (máximo 15 palabras) en qué quedó una conversación de atención al cliente.', [{ role: 'user', content: `Última pregunta del padre: "${mensajeUsuario}". Última respuesta de KAI: "${respuestaBot}". Resume en una frase qué se habló.` }], 60);
    if (resumenCorto) update.$set.resumen_ultimo_contacto = resumenCorto.replace(/\*\*/g, '').trim();
  } catch (e) {}

  const contacto = await Contacto.findOneAndUpdate(
    { tenant_id: tenant._id, numero },
    update,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // 3. Calcular nivel de calor del lead y crear/actualizar en Odoo según corresponda
  const ultimoMsgBotPrevio = [...historial].reverse().find(m => m.role === 'assistant')?.content || respuestaBot;
  const resultado = calcularNivelInteres(mensajeUsuario, ultimoMsgBotPrevio, contacto);

  if (resultado) {
    const nivelMejoro = !contacto.nivel_calor || resultado.nivel < contacto.nivel_calor; // nivel 1 es "más caliente" que 3
    if (!contacto.odoo_lead_id) {
      // Primera vez que se detecta cualquier nivel — crear el lead en Odoo
      await crearCandidatoEnOdoo(tenant, contacto, numero, resultado);
    } else if (nivelMejoro) {
      // Ya existe el lead pero subió de calor — actualizar etiqueta/nivel en Odoo sin duplicar
      await actualizarNivelCandidatoEnOdoo(tenant, contacto, resultado);
    }
  }

  return contacto;
}

// Crea el lead "Candidato KAI" en Odoo a partir de los datos ya capturados en el Contacto
// Busca el ID de un tag de Odoo por nombre, o lo crea si no existe (cachea en memoria para no repetir consultas)
const _cacheTagsOdoo = {};
async function getOdooTagId(nombreTag) {
  if (_cacheTagsOdoo[nombreTag]) return _cacheTagsOdoo[nombreTag];
  try {
    const existentes = await odooCallLocal('crm.tag', 'search_read', [[['name', '=', nombreTag]]], { fields: ['id'], limit: 1 });
    if (existentes && existentes.length) {
      _cacheTagsOdoo[nombreTag] = existentes[0].id;
      return existentes[0].id;
    }
    const nuevoId = await odooCallLocal('crm.tag', 'create', [{ name: nombreTag }]);
    _cacheTagsOdoo[nombreTag] = nuevoId;
    return nuevoId;
  } catch (e) {
    console.error(`❌ Error obteniendo/creando tag "${nombreTag}":`, e.message);
    return null;
  }
}

// Crea el lead "Candidato KAI" en Odoo con la etiqueta correspondiente a su nivel de calor
async function crearCandidatoEnOdoo(tenant, contacto, numero, resultadoNivel) {
  if (contacto.odoo_lead_id) return contacto.odoo_lead_id; // ya existe en memoria

  // Los números de prueba del equipo NO generan leads: si no, cada prueba ensucia el CRM
  // con candidatos falsos que luego hay que depurar a mano.
  if (esNumeroDePrueba(numero)) {
    console.log(`🧪 [Prueba] ${numero} es número de pruebas — no se crea lead en Odoo`);
    return null;
  }

  // Verificación antes de crear — busca por teléfono (fijo y móvil) y por correo, para
  // no duplicar cuando el papá ya existe en Odoo por otro canal o por otro formulario.
  try {
    const existente = await buscarLeadExistente({ telefono: numero, correo: contacto.correo });
    if (existente) {
      contacto.odoo_lead_id = existente.id;
      await contacto.save();
      await anotarOrigenEnLead(existente.id, existente.active === false, `💬 Volvió a escribir por <b>WhatsApp</b> (${numero}).`);
      console.log(`🔗 Lead existente en Odoo vinculado — #${existente.id} para ${numero}${existente.active === false ? ' (estaba archivado, se reactivó)' : ''}`);

      // Si es un contacto de vuelta (ej. de años anteriores) que ya existe pero nunca
      // tuvo vendedor, no hace falta crear nada nuevo — este es el flujo normal de
      // reactivación. Solo se revisa si le falta vendedor y, si es así, se le asigna
      // uno por el reparto 1 a 1, igual que a cualquier candidato nuevo.
      await asignarVendedorSiFalta(tenant, existente);

      return existente.id;
    }
  } catch (e) {
    console.warn('⚠️ No se pudo verificar duplicados en Odoo:', e.message);
  }

  try {
    const teamId = tenant?.odoo_team_id || 1;
    const etiqueta = resultadoNivel?.etiqueta || 'KAI — Exploratorio';
    const nivel = resultadoNivel?.nivel || 3;

    const nombreLead = `Lead KAI — ${contacto.nombre || 'Sin nombre'}${contacto.nombre_alumno ? ' (hijo: ' + contacto.nombre_alumno + ')' : ''}`;
    const descripcion = [
      `Nivel de calor: ${etiqueta}`,
      contacto.nivel_interes ? `Nivel educativo de interés: ${contacto.nivel_interes}` : null,
      contacto.zona ? `Zona: ${contacto.zona}` : null,
      contacto.colegio_actual ? `Colegio actual: ${contacto.colegio_actual}` : null,
      `Capturado automáticamente por KAI vía WhatsApp.`
    ].filter(Boolean).join('\n');

    const tagId = await getOdooTagId(etiqueta);

    // Asignar un vendedor por reparto 1 a 1 (mismo mecanismo que WhatsApp/AcruxLab) —
    // si tiene vinculado su usuario de Odoo, se asigna también ahí como vendedor real.
    const agenteAsignado = await asignarAgenteLibre(tenant._id);

    const leadId = await odooCallLocal('crm.lead', 'create', [{
      name: nombreLead,
      phone: numero,
      partner_name: contacto.nombre || null,
      email_from: contacto.correo || null,
      description: descripcion,
      team_id: teamId,
      type: 'lead', // entra como Lead (bandeja de calificación), no directo como Oportunidad
      tag_ids: tagId ? [[6, 0, [tagId]]] : undefined,
      user_id: agenteAsignado?.odoo_user_id || false // explícito SIEMPRE, nunca undefined — si no hay vendedor, Odoo debe saber que es "ninguno", no asignárselo a KAI por defecto
    }]);

    if (leadId) {
      contacto.odoo_lead_id = leadId;
      contacto.nivel_calor = nivel;
      contacto.nivel_calor_etiqueta = etiqueta;
      await contacto.save();
      console.log(`✅ ${etiqueta} creado en Odoo — lead #${leadId} para ${numero}${agenteAsignado ? ` — asignado a ${agenteAsignado.nombre}` : ''}`);
    }
    return leadId;
  } catch (e) {
    console.error('❌ Error creando candidato en Odoo:', e.message);
    return null;
  }
}

// Cuando un contacto YA tiene lead en Odoo pero subió de nivel de calor (ej: de Exploratorio a Alta Intención),
// actualiza la etiqueta y el nombre del lead existente sin crear uno nuevo.
async function actualizarNivelCandidatoEnOdoo(tenant, contacto, resultadoNivel) {
  if (!contacto.odoo_lead_id) return;
  try {
    const etiqueta = resultadoNivel.etiqueta;
    const tagId = await getOdooTagId(etiqueta);
    const nuevoNombre = `Lead KAI — ${contacto.nombre || 'Sin nombre'}${contacto.nombre_alumno ? ' (hijo: ' + contacto.nombre_alumno + ')' : ''}`;

    await odooCallLocal('crm.lead', 'write', [[contacto.odoo_lead_id], {
      name: nuevoNombre,
      tag_ids: tagId ? [[6, 0, [tagId]]] : undefined
    }]);

    // Dejar registro del cambio de nivel en el chatter del lead
    await odooCallLocal('crm.lead', 'message_post', [[contacto.odoo_lead_id]], {
      body: `🌡️ Nivel de calor actualizado por KAI: ${contacto.nivel_calor_etiqueta || 'Sin nivel previo'} → ${etiqueta}`
    }).catch(()=>{});

    contacto.nivel_calor = resultadoNivel.nivel;
    contacto.nivel_calor_etiqueta = etiqueta;
    await contacto.save();
    console.log(`🌡️ Lead #${contacto.odoo_lead_id} subió de nivel a "${etiqueta}" para ${contacto.numero}`);
  } catch (e) {
    console.error('❌ Error actualizando nivel de candidato en Odoo:', e.message);
  }
}

// Para el caso de handoff inmediato (antes de tener el Contacto actualizado con los últimos datos)
async function crearCandidatoOdooSiNoExiste(tenant, numero, mensajeUsuario, historialPrevio) {
  let contacto = await Contacto.findOne({ tenant_id: tenant._id, numero });
  if (!contacto) {
    contacto = await Contacto.create({ tenant_id: tenant._id, numero, total_conversaciones: 1 });
  }
  if (contacto.odoo_lead_id) return; // ya existe
  // El handoff inmediato siempre implica Nivel 1 — Alta Intención (pidió agendar/inscribir)
  await crearCandidatoEnOdoo(tenant, contacto, numero, { nivel: 1, etiqueta: 'KAI — Alta Intención' });
}

// ===== OMNICHANNEL — funciones de envío por canal =====

// Enviar mensaje por Instagram DMs (requiere token de página con permisos instagram_manage_messages)
function enviarMensajeInstagram(recipientId, texto) {
  return new Promise((resolve) => {
    const TOKEN_PAGE = process.env.INSTAGRAM_PAGE_TOKEN || process.env.WHATSAPP_TOKEN;
    const body = JSON.stringify({
      recipient: { id: recipientId },
      message: { text: texto }
    });
    const req2 = https.request({
      hostname: 'graph.facebook.com',
      path: `/v22.0/me/messages?access_token=${TOKEN_PAGE}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (r) => { const chunks=[]; r.on('data',c=>chunks.push(c)); r.on('end',()=>{ try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch(e){resolve(null)} }); });
    req2.on('error', () => resolve(null));
    req2.write(body); req2.end();
  });
}

// Enviar mensaje por Facebook Messenger (requiere token de página con permisos pages_messaging)
function enviarMensajeMessenger(recipientId, texto) {
  return new Promise((resolve) => {
    const TOKEN_PAGE = process.env.MESSENGER_PAGE_TOKEN || process.env.WHATSAPP_TOKEN;
    const body = JSON.stringify({
      recipient: { id: recipientId },
      message: { text: texto },
      messaging_type: 'RESPONSE'
    });
    const req2 = https.request({
      hostname: 'graph.facebook.com',
      path: `/v22.0/me/messages?access_token=${TOKEN_PAGE}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (r) => { const chunks=[]; r.on('data',c=>chunks.push(c)); r.on('end',()=>{ try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch(e){resolve(null)} }); });
    req2.on('error', () => resolve(null));
    req2.write(body); req2.end();
  });
}

// Procesa un mensaje de cualquier canal — crea/actualiza Contacto y lead en Odoo con canal_origen
async function procesarMensajeOmnichannel(numero, nombre, mensaje, canal, tenant) {
  // Los números de prueba del equipo no generan nada en Odoo.
  if (esNumeroDePrueba(numero)) {
    console.log(`🧪 [Prueba] ${numero} (${canal}) es número de pruebas — no se crea lead ni candidato`);
    return;
  }

  // ===== INTERRUPTOR MAESTRO: KAI PAUSADO EN PRODUCCIÓN =====
  // Esta función crea/vincula leads en Odoo para TODO mensaje entrante, sin importar si
  // luego se responde o no — corre ANTES de responderConIA. Por eso, aunque las
  // respuestas ya estaban pausadas, los leads seguían creándose solos. Con esto, ya no.
  if (KAI_PAUSADO_PARA_PRODUCCION) {
    console.log(`⏸️ [Omnichannel] KAI pausado en producción — no se crea/toca ningún lead para ${numero} (${canal})`);
    return;
  }
  try {
    const teamId = tenant?.odoo_team_id || 1;

    // Buscar o crear contacto con el canal de origen registrado
    let contacto = await Contacto.findOne({ tenant_id: tenant._id, numero });
    if (!contacto) {
      contacto = await Contacto.create({
        tenant_id: tenant._id,
        numero,
        nombre: nombre || null,
        canal_origen: canal,
        total_conversaciones: 1,
        ultimo_contacto: new Date(),
        primer_contacto: new Date()
      });
    } else {
      // Si ya existía, registrar canal si no lo tenía
      if (!contacto.canal_origen) contacto.canal_origen = canal;
      if (nombre && !contacto.nombre) contacto.nombre = nombre;
      contacto.ultimo_contacto = new Date();
      await contacto.save();
    }

    // Crear lead en Odoo si no existe aún — con etiqueta de canal
    if (!contacto.odoo_lead_id) {
      const etiquetaCanal = {
        whatsapp:   'Canal — WhatsApp',
        instagram:  'Canal — Instagram',
        messenger:  'Canal — Messenger',
        lead_ads:   'Canal — Lead Ads Facebook',
        formulario: 'Canal — Formulario Web'
      }[canal] || 'Canal — Otro';

      const tagId = await getOdooTagId(etiquetaCanal);

      // Antes de crear: si este papá ya existe en Odoo (escribió antes por otro canal),
      // se vincula al lead que ya está en vez de abrir uno nuevo.
      const telParaBuscar = (numero.startsWith('ig_') || numero.startsWith('fb_')) ? null : numero;
      const yaExiste = await buscarLeadExistente({ telefono: telParaBuscar, correo: contacto.correo });
      if (yaExiste) {
        contacto.odoo_lead_id = yaExiste.id;
        await contacto.save();
        await anotarOrigenEnLead(yaExiste.id, yaExiste.active === false, `📲 Volvió a escribir por <b>${canal}</b>.`);
        await asignarVendedorSiFalta(tenant, yaExiste);
        console.log(`🔗 [${canal}] Lead existente vinculado — #${yaExiste.id}${yaExiste.active === false ? ' (estaba archivado, se reactivó)' : ''}`);
        return;
      }

      // SIEMPRE se asigna una vendedora real ANTES de crear el lead — nunca se deja el
      // campo sin poner. Si no se hace explícito (aunque sea "false"), Odoo por defecto
      // le pone como vendedor a quien está creando el registro — que es KAI mismo. Eso
      // fue justo la causa real de que 53 leads terminaran asignados a "Administrador".
      const agenteNuevo = await asignarAgenteLibre(tenant._id);

      const leadId = await odooCallLocal('crm.lead', 'create', [{
        name: `Lead KAI — ${nombre || 'Sin nombre'} (${etiquetaCanal})`,
        phone: telParaBuscar,
        partner_name: nombre || null,
        description: `Canal de origen: ${canal}\nCapturado automáticamente por KAI.`,
        team_id: teamId,
        type: 'lead', // entra como Lead, no directo como Oportunidad
        tag_ids: tagId ? [[6, 0, [tagId]]] : undefined,
        user_id: agenteNuevo?.odoo_user_id || false // explícito SIEMPRE, nunca undefined
      }]);
      if (leadId) {
        contacto.odoo_lead_id = leadId;
        await contacto.save();
        console.log(`✅ Lead Odoo creado desde ${canal} — #${leadId}`);
      }
    }
  } catch (e) {
    console.error(`❌ procesarMensajeOmnichannel [${canal}]:`, e.message);
  }
}

// ===== ENVÍO AUTOMÁTICO DE IMÁGENES SEGÚN CONTEXTO =====
// Detecta qué imagen es relevante para el mensaje del padre y la envía después de la respuesta de texto.
// Solo envía UNA imagen por mensaje para no saturar. Espera 1.5s después del texto para que se vea ordenado.

const REGLAS_IMAGEN = [
  // ── CUOTAS — nombres genéricos sin año, se actualizan desde el panel ──
  { keywords: ['cuota','colegiatura','mensualidad','precio','costo','cuánto cuesta','cuanto cuesta','cuánto es','cuanto es'], nivel: ['preprimaria','jardín','jardin','infantil','kínder','kinder','párvulos','parvulos','preparatoria'], categoria: 'cuotas', nivel_educativo: 'Preprimaria', nombre_contiene: 'Preprimaria' },
  { keywords: ['cuota','colegiatura','mensualidad','precio','costo','cuánto cuesta','cuanto cuesta','cuánto es','cuanto es'], nivel: ['primaria','primero','segundo','tercero','cuarto','quinto','sexto','1°','2°','3°','4°','5°','6°'], categoria: 'cuotas', nivel_educativo: 'Primaria', nombre_contiene: '(?<!Pre)Primaria' },
  { keywords: ['cuota','colegiatura','mensualidad','precio','costo','cuánto cuesta','cuanto cuesta','cuánto es','cuanto es'], nivel: ['secundaria','básico','basico','bachillerato','séptimo','octavo','noveno','décimo','7°','8°','9°','10°'], categoria: 'cuotas', nivel_educativo: 'Secundaria', nombre_contiene: 'Secundaria' },

  // ── PROCESO DE ADMISIÓN ──
  { keywords: ['proceso','admisión','admision','inscribir','inscripción','inscripcion','cómo aplico','como aplico','cómo ingreso','como ingreso'], nivel: ['jardín','jardin','infantil','kínder','kinder'], categoria: 'admision', nombre_contiene: 'Jardín' },
  { keywords: ['proceso','admisión','admision','inscribir','inscripción','inscripcion','cómo aplico','como aplico'], nivel: ['párvulos','parvulos','preparatoria'], categoria: 'admision', nombre_contiene: 'Párvulos' },
  { keywords: ['proceso','admisión','admision','inscribir','inscripción','inscripcion','cómo aplico','como aplico'], nivel: ['primaria','secundaria','básico','basico','bachillerato'], categoria: 'admision', nombre_contiene: 'Primaria y Secundaria' },

  // ── PAPELERÍA Y REQUISITOS ──
  { keywords: ['papelería','papeleria','documentos','qué necesito','que necesito','qué piden','que piden','qué documentos','que documentos'], nivel: [], categoria: 'admision', nombre_contiene: 'Papelería' },
  { keywords: ['requisito','nota mínima','nota minima','promedio','calificacion','calificación','aprobado','punteo'], nivel: [], categoria: 'admision', nombre_contiene: 'Requisitos' },

  // ── EDADES ──
  { keywords: ['edad','años tiene','cuántos años','cuantos años','a qué edad','a que edad','qué edad','que edad','tiene que tener'], nivel: [], categoria: 'admision', nombre_contiene: 'Edades' },

  // ── HORARIOS ──
  { keywords: ['horario','horarios','a qué hora','a que hora','cuándo entra','cuando entra','cuándo sale','cuando sale','qué hora entran','que hora entran','hora de entrada','hora de salida'], nivel: [], categoria: 'info_general', nombre_contiene: 'Horario' },

  // ── PROGRAMAS ACADÉMICOS ──
  { keywords: ['cómo es la','como es la','qué enseñan','que enseñan','metodología','metodologia','programa','plan de estudios','cómo trabajan','como trabajan'], nivel: ['preprimaria','jardín','jardin','infantil','kínder','kinder','párvulos','parvulos'], categoria: 'programas', nombre_contiene: 'Preprimaria' },
  { keywords: ['cómo es la','como es la','qué enseñan','que enseñan','metodología','metodologia','programa'], nivel: ['primaria','1°','2°','3°','4°','5°','6°'], categoria: 'programas', nombre_contiene: '(?<!Pre)Primaria' },
  { keywords: ['cómo es la','como es la','qué enseñan','que enseñan','metodología','metodologia','programa'], nivel: ['secundaria','básico','basico'], categoria: 'programas', nombre_contiene: 'Secundaria' },
  { keywords: ['bachillerato','carrera','ciencias y letras','qué bachillerato','que bachillerato'], nivel: [], categoria: 'programas', nombre_contiene: 'Bachillerato' },

  // ── UBICACIÓN ──
  { keywords: ['dónde están','donde estan','dirección','direccion','ubicación','ubicacion','cómo llego','como llego','zona 11','mapa','dónde queda','donde queda'], nivel: [], categoria: 'info_general', nombre_contiene: 'Ubicación' },

  // ── ACADEMIA AHA ──
  { keywords: ['extraescolar','extracurricular','academia','aha','natación','natacion','danza','teatro','guitarra','piano','ajedrez','arte','actividad fuera','actividades después','actividades despues'], nivel: [], categoria: 'academia_aha', nombre_contiene: 'Academia AHA' },
];

// Busca si el mensaje ACTUAL (más el nivel ya establecido EN ESTA MISMA conversación,
// nunca datos viejos de otra sesión/día) dispara alguna regla de imagen. Devuelve:
// - { regla, ambigua:false } si el tema Y el grado (en este mensaje o ya sabido en esta
//   sesión) están claros.
// - { regla:null, ambigua:true } si el tema es claro pero no hay ningún grado — ni en
//   este mensaje ni establecido antes en esta misma conversación — hay que PREGUNTAR.
// - null si el mensaje no tiene nada que ver con ningún tema de imagen.
// Compara si "keyword" aparece en "texto" — comparación simple por substring.
function contieneKeyword(texto, keyword) {
  return texto.includes(keyword);
}

// Cuando el papá pide VARIAS cosas en un mismo mensaje ("cuotas, requisitos, horarios y
// el proceso de admisión"), no basta con encontrar un tema: hay que mandarle todo lo que
// pidió. Esta función devuelve una regla por cada tema distinto que aparezca.
// ¿El mensaje es solo un agradecimiento o una despedida? En esos casos el padre NO está
// pidiendo nada — mandarle una imagen queda muy mal ("mil gracias por atenderme a pesar
// de la hora" → y KAI le manda otra vez los horarios). Merece una respuesta cálida y ya.
function esAgradecimientoOCierre(texto) {
  const t = (texto || '').toLowerCase().trim();
  if (!t || t.length > 200) return false; // los mensajes largos suelen traer preguntas
  // Si trae signo de pregunta o pide algo, NO es un cierre
  if (/\?|¿/.test(t)) return false;
  if (/(me pued|podr[ií]a|quisiera saber|necesito saber|me manda|env[ií]eme|mandeme|m[aá]ndame)/.test(t)) return false;

  const esCortesia = /(gracias|muchas gracias|mil gracias|te lo agradezco|se lo agradezco|agradecid[oa]|los felicito|felicidades|excelente|muy amable|qu[eé] amable|bendiciones|buen d[ií]a|buenas noches|feliz (d[ií]a|tarde|noche)|hasta luego|nos vemos|estar[eé] pendiente|quedo pendiente|lo revisar[eé]|le confirmo|les confirmo)/.test(t);
  return esCortesia;
}

function buscarTodasLasReglasCoincidentes(mensajeUsuario, nivelSesion, nivelesMultiplesSesion) {
  const t = (mensajeUsuario || '').toLowerCase();
  const nivelSesionLower = (nivelSesion || '').toLowerCase();
  const nivelesMultiplesLower = (nivelesMultiplesSesion || []).map(n => (n || '').toLowerCase());

  const candidatas = REGLAS_IMAGEN.filter(r => r.keywords.some(k => contieneKeyword(t, k)));
  if (!candidatas.length) return [];

  // Agrupar por tema (categoría + nombre de la imagen), para no repetir la misma
  const porTema = new Map();
  for (const r of candidatas) {
    const clave = `${r.categoria}|${r.nombre_contiene || r.nivel_educativo || ''}`;
    if (!porTema.has(clave)) porTema.set(clave, r);
  }

  // Quedarnos con las que corresponden al nivel del padre. Se agrupan por IMAGEN, no por
  // categoría: "requisitos" y "proceso de admisión" son dos imágenes distintas aunque
  // ambas sean de admisión, y el papá que pide las dos debe recibir las dos.
  //
  // Si el papá mencionó VARIOS niveles a la vez en algún mensaje anterior (ej. "tengo un
  // hijo en Preprimaria y otro en Primaria"), nivelesMultiplesSesion trae esa lista — y
  // una imagen que requiere nivel también cuenta como coincidencia si calza con
  // CUALQUIERA de esos niveles guardados, no solo con el nivel único de la sesión. Antes
  // esto se perdía: el padre mencionaba dos niveles, pero como no se puede saber "cuál
  // es EL nivel", el sistema se quedaba solo con uno y la otra información nunca llegaba.
  const seleccionadas = new Map();
  for (const r of porTema.values()) {
    const requiereNivel = r.nivel && r.nivel.length > 0;
    const coincideNivel = !requiereNivel
      || r.nivel.some(n => contieneKeyword(t, n))
      || (nivelSesionLower && r.nivel.some(n => nivelSesionLower.includes(n)))
      || (nivelesMultiplesLower.length && r.nivel.some(n => nivelesMultiplesLower.some(nm => nm.includes(n))));
    if (!coincideNivel) continue;
    const claveImagen = `${r.categoria}|${r.nombre_contiene || r.nivel_educativo || 'general'}`;
    if (!seleccionadas.has(claveImagen)) seleccionadas.set(claveImagen, r);
  }

  return [...seleccionadas.values()];
}

function buscarReglaImagenCoincidente(mensajeUsuario, nivelSesion) {
  const t = (mensajeUsuario || '').toLowerCase();
  const nivelSesionLower = (nivelSesion || '').toLowerCase();

  // Agrupar TODAS las reglas cuya keyword coincide con el mensaje — puede haber varias
  // (una por nivel/grado: Preprimaria, Primaria, Secundaria, etc.) bajo el mismo tema,
  // y hasta de temas distintos si comparten alguna palabra (ej. "bachillerato" es nivel
  // de Cuotas pero también keyword propia de Programas).
  const candidatas = REGLAS_IMAGEN.filter(regla => regla.keywords.some(k => contieneKeyword(t, k)));
  if (!candidatas.length) return null; // no tiene nada que ver con ningún tema de imagen

  // PRIORIDAD 1: candidatas con grado específico que SÍ coincide con ESTE mensaje.
  // Ojo: un mensaje puede mencionar VARIOS niveles ("mi hijo está en kinder, pero
  // quiero información para 1ro primaria"). En ese caso hay que quedarse con el que el
  // padre ya estableció antes (el que eligió en el menú), no con el primero que aparezca
  // en la lista de reglas — si no, se le manda la información del grado equivocado.
  const matchesEnMensaje = candidatas.filter(r => r.nivel && r.nivel.length > 0 && r.nivel.some(n => contieneKeyword(t, n)));
  if (matchesEnMensaje.length) {
    if (matchesEnMensaje.length > 1 && nivelSesionLower) {
      const coincideConSesion = matchesEnMensaje.find(r => r.nivel.some(n => nivelSesionLower.includes(n)));
      if (coincideConSesion) {
        return { regla: coincideConSesion, ambigua: false, categoria: coincideConSesion.categoria };
      }
    }
    return { regla: matchesEnMensaje[0], ambigua: false, categoria: matchesEnMensaje[0].categoria };
  }

  // PRIORIDAD 2: una candidata que no requiere grado/nivel (coincidencia directa)
  const sinNivelRequerido = candidatas.find(r => !r.nivel || r.nivel.length === 0);
  if (sinNivelRequerido) return { regla: sinNivelRequerido, ambigua: false, categoria: sinNivelRequerido.categoria };

  // PRIORIDAD 3: alguna candidata coincide con el grado ya establecido antes en la sesión
  if (nivelSesionLower) {
    const matchEnSesion = candidatas.find(r => r.nivel.some(n => nivelSesionLower.includes(n)));
    if (matchEnSesion) return { regla: matchEnSesion, ambigua: false, categoria: matchEnSesion.categoria };
  }

  // Ninguna candidata tiene el grado — el tema es claro, pero falta el grado. Guardamos
  // la CATEGORÍA (no una regla específica) para poder re-evaluar correctamente cuando
  // llegue el grado en un mensaje posterior.
  return { regla: null, ambigua: true, categoria: candidatas[0].categoria };
}

// Cuando ya sabemos la categoría pendiente (ej. "cuotas") y llega un mensaje que SOLO
// trae el grado (sin repetir la palabra clave del tema), busca entre TODAS las reglas
// de esa categoría cuál coincide con el grado — mismo principio que arriba, para no
// quedarse pegado en la primera regla de la categoría.
function completarTemaPendiente(categoria, nivelMencionado) {
  if (!categoria || !nivelMencionado) return null;
  const nivelLower = nivelMencionado.toLowerCase();
  const candidatas = REGLAS_IMAGEN.filter(r => r.categoria === categoria);
  const match = candidatas.find(r => !r.nivel || r.nivel.length === 0 || r.nivel.some(n => nivelLower.includes(n)));
  return match || null;
}

// Frases fijas y predefinidas (NUNCA generadas por la IA) que acompañan cada imagen —
// para que no se sienta frío mandar solo la imagen a secas, sin arriesgarnos a que se
// filtren precios/datos en texto libre. Si la imagen tiene su propio "caption" cargado
// desde el panel, ese se usa primero; si no, se usa esta frase genérica por categoría.
const DESCRIPCION_POR_CATEGORIA = {
  cuotas: '¡Con gusto! Aquí tienes la información de cuotas 📋',
  admision: '¡Claro! Aquí tienes el detalle del proceso de admisión 📋',
  programas: '¡Con gusto! Aquí tienes la información 📋',
  info_general: '¡Aquí tienes el detalle! 📋',
  academia_aha: '¡Con gusto! Aquí tienes la información de Academia AHA 📋'
};

function construirDescripcionImagen(imagenDirecta) {
  if (imagenDirecta.caption && imagenDirecta.caption.trim()) return imagenDirecta.caption.trim();
  return DESCRIPCION_POR_CATEGORIA[imagenDirecta.categoria] || '¡Aquí tienes la información! 📋';
}

// Detecta si un texto menciona un nivel educativo reconocible — se usa para "recordar"
// el nivel dentro de la sesión actual una vez que el padre/madre lo menciona.
// Detecta TODOS los niveles mencionados explícitamente en el texto — a diferencia de
// detectarNivelEnTexto, esta SÍ devuelve varios si el mensaje los trae. Se usa para
// casos reales de "tengo un hijo en Preprimaria y otro en Primaria", donde el padre de
// verdad necesita información de los dos niveles, no para decidir cuál es "el" nivel
// de la sesión (eso lo sigue haciendo detectarNivelEnTexto, sin cambios).
function detectarNivelesExplicitosEnMensaje(texto) {
  const t = (texto || '').toLowerCase();
  const detectados = [];
  if (/preprimaria|jard[ií]n|infantil|k[ií]nder|p[aá]rvulos|preparatoria/.test(t)) detectados.push('preprimaria');
  if (/secundaria|b[aá]sico|bachillerato|s[eé]ptimo|octavo|noveno|d[eé]cimo|7°|8°|9°|10°/.test(t)) detectados.push('secundaria');
  if (/primaria|primero|segundo|tercero|cuarto|quinto|sexto|1°|2°|3°|4°|5°|6°/.test(t)) detectados.push('primaria');
  return detectados;
}

// Calcula el nivel educativo a partir de una fecha de nacimiento en el texto del
// padre — de forma determinista, en código, NO dejándoselo a la IA. Antes la IA hacía
// el cálculo ella misma dentro del texto libre, y como el resultado nunca llegaba de
// vuelta al código, el sistema de imágenes automáticas nunca se enteraba de qué grado
// se había resuelto — por eso la conversación se quedaba dando vueltas sin mandar nunca
// la imagen real, y encima la IA terminaba mencionando precios en texto libre.
//
// REGLA OFICIAL (03_Admisión.pdf): la edad que cuenta es la que el niño/a CUMPLE entre
// el 1 de enero y el 30 de junio del ciclo (2027). Tabla: Jardín 2, Infantil 3,
// Kínder 4, Párvulos 5, Preparatoria 6, Primaria 7–12, Secundaria 13–16.
const MESES_ES = { enero:0, febrero:1, marzo:2, abril:3, mayo:4, junio:5, julio:6, agosto:7, septiembre:8, setiembre:8, octubre:9, noviembre:10, diciembre:11 };
function calcularNivelDesdeFecha(texto, anoCiclo = 2027) {
  const t = (texto || '').trim();
  let dia, mes, anio;

  // Formato DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY (también admite años de 2 dígitos)
  let m = t.match(/\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})\b/);
  if (m) {
    dia = parseInt(m[1]); mes = parseInt(m[2]) - 1; anio = parseInt(m[3]);
    if (anio < 100) anio += anio < 50 ? 2000 : 1900;
  } else {
    // Formato "9 de septiembre de 2021" / "9 de septiembre 2021"
    m = t.toLowerCase().match(/\b(\d{1,2})\s+de\s+([a-zñ]+)\s+(?:de\s+)?(\d{4})\b/);
    if (m && MESES_ES[m[2]] !== undefined) {
      dia = parseInt(m[1]); mes = MESES_ES[m[2]]; anio = parseInt(m[3]);
    }
  }
  if (dia === undefined || isNaN(new Date(anio, mes, dia).getTime()) || mes < 0 || mes > 11 || dia < 1 || dia > 31) return null;

  // Edad que cumple el 30 de junio del ciclo (si su cumpleaños ya pasó para esa fecha,
  // cuenta la edad que YA tiene en ese momento; si no ha pasado, la que tenía antes)
  const fechaCorte = new Date(anoCiclo, 5, 30); // 30 de junio (mes 5 = junio, base 0)
  let edad = anoCiclo - anio;
  const yaCumplioParaElCorte = (mes < 5) || (mes === 5 && dia <= 30);
  if (!yaCumplioParaElCorte) edad -= 1;

  const TABLA = { 2: 'jardín', 3: 'infantil', 4: 'kínder', 5: 'párvulos', 6: 'preparatoria' };
  if (TABLA[edad]) return TABLA[edad];
  if (edad >= 7 && edad <= 12) return 'primaria';
  if (edad >= 13 && edad <= 16) return 'secundaria';
  return null; // fuera de rango de edades que el colegio admite
}

function detectarNivelEnTexto(texto) {
  const t = (texto || '').toLowerCase();
  const detectados = [];
  if (/preprimaria|jard[ií]n|infantil|k[ií]nder|p[aá]rvulos|preparatoria/.test(t)) detectados.push('preprimaria');
  if (/secundaria|b[aá]sico|bachillerato|s[eé]ptimo|octavo|noveno|d[eé]cimo|7°|8°|9°|10°/.test(t)) detectados.push('secundaria');
  if (/primaria|primero|segundo|tercero|cuarto|quinto|sexto|1°|2°|3°|4°|5°|6°/.test(t)) detectados.push('primaria');

  // Si el mensaje menciona VARIOS niveles no se puede saber cuál es el que interesa.
  // Pasa seguido: "mi hijo está en kinder, pero quiero información para 1ro primaria".
  // Antes se devolvía el primero de la lista (preprimaria) y eso PISABA el nivel que el
  // padre ya había elegido en el menú, mandándole la información del grado equivocado.
  // Ante la duda, no se cambia nada: se respeta el nivel que ya estaba establecido.
  if (detectados.length > 1) return null;

  return detectados[0] || null;
}

async function detectarYEnviarImagen(tenant, mensajeUsuario, contacto, canal, numeroOrigen, idExterno) {
  try {
    const resultado = buscarReglaImagenCoincidente(mensajeUsuario);
    if (!resultado || resultado.ambigua || !resultado.regla) return; // ambigua = sin grado claro, no se manda nada
    const regla = resultado.regla;

    // Buscar imagen en MongoDB según la regla
    const filtro = { tenant_id: tenant._id, activo: true, categoria: regla.categoria };
    if (regla.nivel_educativo) filtro.nivel_educativo = { $in: [regla.nivel_educativo, 'Todos'] };
    if (regla.nombre_contiene) filtro.nombre = new RegExp(regla.nombre_contiene, 'i');

    const imagen = await ImagenMarketing.findOne(filtro).sort({ prioridad: -1, creado: -1 });
    if (!imagen) return;

    // Enviar según canal — sin esperar texto, porque en el caso de coincidencia clara
    // ya NO se manda ningún texto de KAI para este turno (ver responderConIA).
    if (canal === 'whatsapp') {
      await enviarImagenDesdeDB(imagen, numeroOrigen, '');
    }
    // Instagram y Messenger en modo lectura — no enviamos imágenes todavía

    console.log(`🖼️ Imagen automática enviada: "${imagen.nombre}" → ${numeroOrigen}`);
  } catch (e) {
    console.error('❌ Error enviando imagen automática:', e.message);
  }
}

async function responderConIA(tenant, mensajeUsuario, numeroOrigen) {
  // ===== INTERRUPTOR MAESTRO: KAI PAUSADO EN PRODUCCIÓN =====
  if (KAI_PAUSADO_PARA_PRODUCCION && !esNumeroDePrueba(numeroOrigen)) {
    console.log(`⏸️ [WhatsApp] KAI pausado en producción — no se responde a ${numeroOrigen} (número real)`);
    return '';
  }

  // ===== ¿ES UN PROVEEDOR OFRECIENDO PRODUCTOS/SERVICIOS, NO UN PADRE? =====
  // Se revisa ANTES que cualquier otra cosa — ni se busca lead, ni se asigna vendedora,
  // ni se llama a la IA. Solo se responde el mensaje fijo y ya.
  if (!esNumeroDePrueba(numeroOrigen) && esProveedorOAjenoAAdmisiones(mensajeUsuario)) {
    console.log(`📦 [WhatsApp] Mensaje de proveedor detectado (${numeroOrigen}) — se responde fijo, sin crear lead ni asignar vendedora`);
    return MENSAJE_RESPUESTA_PROVEEDOR;
  }

  // ===== ¿ESTE PAPÁ YA ES DE ALGUIEN EN ODOO? =====
  // Misma regla que en AcruxLab: si ya está como OPORTUNIDAD (esas son de Sylvia) o ya
  // tiene un vendedor asignado, ya lo está trabajando una persona y KAI no debe meterse.
  // KAI solo atiende a los NUEVOS. Se revisa antes que nada, para no responder por error.
  try {
    // Los números de prueba del equipo se saltan esta regla: siempre se les atiende.
    const leadDueño = esNumeroDePrueba(numeroOrigen) ? null : await buscarLeadExistente({ telefono: numeroOrigen });
    // Igual que en AcruxLab: solo las OPORTUNIDADES bloquean. Tener vendedor asignado
    // no basta, porque KAI mismo asigna vendedora y sigue atendiendo hasta el traspaso.
    if (leadDueño && leadDueño.active !== false && leadDueño.type === 'opportunity') {
      // Las OPORTUNIDADES son de Sylvia por regla del colegio.
      const esOportunidad = leadDueño.type === 'opportunity';
      let duenio = leadDueño.user_id?.[1] || null;
      let duenioId = null;
      if (esOportunidad) {
        const sylvia = await UsuarioPanel.findOne({ tenant_id: tenant._id, activo: true, nombre: new RegExp('sylvia', 'i') });
        if (sylvia) { duenio = sylvia.nombre; duenioId = sylvia._id; }
        else duenio = duenio || 'Sylvia';
      }
      let conv = await Conversacion.findOne({ tenant_id: tenant._id, numero: numeroOrigen, estado: { $ne: 'cerrado' } });
      if (!conv) {
        conv = await Conversacion.create({
          tenant_id: tenant._id, numero: numeroOrigen, canal: 'whatsapp', estado: 'humano',
          agente_nombre: duenio || 'Sin asignar',
          ...(duenioId ? { agente_id: duenioId } : {}),
          motivo: `Ya es ${esOportunidad ? 'OPORTUNIDAD' : 'lead asignado'} de ${duenio} (#${leadDueño.id})`,
          mensajes: [{ de: 'padre', texto: mensajeUsuario, fecha: new Date() }],
          ultimaActividad: new Date()
        });
      } else {
        conv.estado = 'humano';
        conv.agente_nombre = duenio || conv.agente_nombre;
        if (duenioId) conv.agente_id = duenioId;
        conv.mensajes.push({ de: 'padre', texto: mensajeUsuario, fecha: new Date() });
        conv.ultimaActividad = new Date();
        await conv.save();
      }
      console.log(`🔒 [WhatsApp] ${numeroOrigen} es ${esOportunidad ? 'OPORTUNIDAD → ' + duenio : 'lead de ' + duenio} (#${leadDueño.id}) — KAI no responde`);
      return null; // null = KAI no contesta; el chat le queda pendiente a esa persona
    }
  } catch (e) {
    console.error(`⚠️ [WhatsApp] No se pudo verificar si ${numeroOrigen} ya tiene dueño en Odoo: ${e.message}`);
  }

  // ===== VERIFICAR SI YA HAY HANDOFF ACTIVO =====
  const convActiva = await Conversacion.findOne({ tenant_id: tenant._id, numero: numeroOrigen, estado: { $in: ['humano', 'esperando_agente'] } });
  if (convActiva) {
    // Calcular hace cuánto fue el último mensaje del AGENTE (no del padre) — si nunca respondió, usar la fecha de creación del handoff
    const ultimoMsgAgente = [...(convActiva.mensajes || [])].reverse().find(m => m.de === 'agente');

    // Si una agente YA respondió al menos una vez, el chat es suyo — KAI no se mete más,
    // ni aunque tarde en contestar. El padre espera seguir con ella, no con el bot.
    // El chat le queda marcado como pendiente en su bandeja.
    if (ultimoMsgAgente) {
      convActiva.mensajes.push({ de: 'padre', texto: mensajeUsuario });
      convActiva.ultimaActividad = new Date();
      await convActiva.save();
      return null; // null = no responder automáticamente; contesta la agente desde el panel
    }

    // Nadie la ha atendido todavía: si lleva 30+ minutos abandonada, KAI la retoma para
    // no dejar a la familia en silencio (aquí no hay agente "dueña" a quien respetar).
    const ultimaRespuestaAgenteFecha = convActiva.creado;
    const minutosSinRespuestaAgente = (Date.now() - new Date(ultimaRespuestaAgenteFecha).getTime()) / (1000 * 60);

    const MINUTOS_AUTO_RECUPERACION = 30;

    if (minutosSinRespuestaAgente >= MINUTOS_AUTO_RECUPERACION) {
      // El agente no respondió en 30+ minutos — KAI retoma automáticamente para no dejar al padre sin atención
      console.log(`🔄 Auto-recuperación: KAI retoma conversación de ${numeroOrigen} tras ${Math.round(minutosSinRespuestaAgente)} min sin respuesta del agente`);
      convActiva.mensajes.push({ de: 'padre', texto: mensajeUsuario });

      const resumenAgente = await generarResumenParaKai(convActiva);
      convActiva.resumen_agente = resumenAgente;
      // Antes se marcaba como 'cerrado' aquí, y eso hacía que el chat DESAPARECIERA del
      // panel de un momento a otro (el famoso "se van y vienen"). Ahora pasa a modo 'bot':
      // KAI retoma la atención, pero la conversación sigue visible para todos.
      convActiva.estado = 'bot';
      convActiva.ultimaActividad = new Date();
      await convActiva.save();

      // Inyectar el contexto en la memoria de KAI para que no repita preguntas, igual que en "Devolver a KAI" manual
      if (!conversaciones.has(numeroOrigen)) conversaciones.set(numeroOrigen, { historial: [], ultimaActividad: Date.now() });
      const ctx = conversaciones.get(numeroOrigen);
      if (resumenAgente) {
        ctx.historial.push({ role: 'assistant', content: `(Contexto interno — no mostrar tal cual: mientras hablaba con un asesor humano, esto ocurrió: ${resumenAgente}. El asesor no pudo responder a tiempo, así que retomas tú la conversación. Hazlo con naturalidad, sin mencionar este resumen ni que el asesor no respondió, solo continúa ayudando.)` });
      }
      // No retornar null aquí — dejar que el flujo continúe hacia abajo y KAI genere una respuesta normal
    } else {
      // Todavía dentro del tiempo de espera — el agente puede seguir respondiendo manualmente
      convActiva.mensajes.push({ de: 'padre', texto: mensajeUsuario });
      convActiva.ultimaActividad = new Date();
      await convActiva.save();
      return null; // null = no enviar respuesta automática, el agente responde manualmente desde el panel
    }
  }

  // ===== IMAGEN DIRECTA — sin pasar por la IA en absoluto =====
  // Si el tema es claro (cuotas, horarios, requisitos, etc.) Y el grado ya viene
  // especificado en ESTE mensaje O ya se estableció ANTES en esta misma conversación,
  // mandamos la imagen de una vez, sin generar ningún texto — así KAI queda "listo"
  // para dar cuotas/requisitos/horarios sin que le repitan el grado cada vez, pero sin
  // el riesgo de adivinar con datos viejos de OTRA conversación/día distinto.
  const esNuevaSesionEnMemoria = !conversaciones.has(numeroOrigen);
  if (esNuevaSesionEnMemoria) conversaciones.set(numeroOrigen, { historial: [], ultimaActividad: Date.now() });
  const ctxSesion = conversaciones.get(numeroOrigen);

  // ===== MODO NO INTERACTIVO — nuevo esquema, solo números de prueba por ahora =====
  if (MODO_NO_INTERACTIVO_SOLO_PRUEBAS && esNumeroDePrueba(numeroOrigen)) {
    return await manejarModoNoInteractivoWhatsApp(tenant, mensajeUsuario, ctxSesion, numeroOrigen);
  }

  // Recuperar SOLO el nivel guardado (para las imágenes) — el resto de la memoria
  // (nombre, saludo de "qué gusto verte de vuelta", etc.) ya lo maneja más abajo la
  // sección "MEMORIA PERSISTENTE", no lo dupliques aquí o descuadra ese conteo.
  if (esNuevaSesionEnMemoria) {
    const contactoExistente = await Contacto.findOne({ tenant_id: tenant._id, numero: numeroOrigen });
    if (contactoExistente?.nivel_interes) {
      ctxSesion.nivelSesion = detectarNivelEnTexto(contactoExistente.nivel_interes) || ctxSesion.nivelSesion;
    }
  }

  const nivelMencionadoAhora = detectarNivelEnTexto(mensajeUsuario);
  if (nivelMencionadoAhora) ctxSesion.nivelSesion = nivelMencionadoAhora; // lo dicho en ESTE mensaje manda sobre lo anterior

  // Si el mensaje menciona VARIOS niveles a la vez (ej. "Preprimaria y Primaria", papá
  // con hijos en dos grados distintos), se guardan TODOS — para que un mensaje genérico
  // posterior ("cuotas, requisitos y horarios") mande la información de ambos, no solo
  // del nivel único de la sesión. Mismo tratamiento que en AcruxLab.
  const nivelesExplicitosAhora = detectarNivelesExplicitosEnMensaje(mensajeUsuario);
  if (nivelesExplicitosAhora.length > 1) {
    ctxSesion.nivelesMultiples = [...new Set([...(ctxSesion.nivelesMultiples || []), ...nivelesExplicitosAhora])];
  }

  // Si había una PREGUNTA PENDIENTE (ej: "¿cuotas de qué grado?") y este mensaje trae un
  // grado, completar esa pregunta pendiente tiene prioridad sobre cualquier otra cosa —
  // aunque el mensaje también toque, por casualidad, la palabra clave de un tema distinto
  // (ej. "bachillerato" es grado de Cuotas pero también palabra propia de Programas). El
  // padre está respondiendo la pregunta que le acabamos de hacer, no cambiando de tema.
  // Si el mensaje no trae una PALABRA de nivel pero SÍ parece una fecha de nacimiento,
  // el código la calcula él mismo — determinista, para que ese cálculo sí llegue al
  // sistema de imágenes (antes se perdía: la IA lo calculaba solo en el texto, el
  // código nunca se enteraba, y la conversación se quedaba dando vueltas sin mandar
  // nunca la imagen real). Mismo tratamiento que en AcruxLab.
  // Se calcula SIEMPRE, incluso si el mensaje también trae una palabra de nivel — un
  // mismo mensaje puede traer la fecha de UN hijo y el grado de OTRO a la vez (ej.
  // "9 de septiembre 2021 y para 3° Primaria"), y antes, con la palabra "primaria"
  // presente, ni siquiera se intentaba leer la fecha del primer niño.
  const nivelPorFecha = calcularNivelDesdeFecha(mensajeUsuario);
  const nivelParaCompletarTema = nivelMencionadoAhora || nivelPorFecha;
  if (nivelPorFecha) {
    if (!nivelMencionadoAhora) ctxSesion.nivelSesion = nivelPorFecha;
    ctxSesion.nivelesMultiples = [...new Set([...(ctxSesion.nivelesMultiples || []), nivelPorFecha])];
  }

  let matchImagen = null;

  // Mismo disparo directo que en AcruxLab: Preprimaria mencionada de forma genérica,
  // sin sub-grado específico todavía, manda la tabla de edades sin depender de ninguna
  // palabra que Kai escriba en su respuesta.
  const mencionaSubNivelPreprimaria = /jard[ií]n|infantil|k[ií]nder|p[aá]rvulos|preparatoria/i.test(mensajeUsuario);
  if (nivelMencionadoAhora === 'preprimaria' && !mencionaSubNivelPreprimaria && !ctxSesion.subNivelPreprimariaConfirmado) {
    const reglaEdades = REGLAS_IMAGEN.find(r => r.nombre_contiene === 'Edades');
    if (reglaEdades) matchImagen = { regla: reglaEdades, ambigua: false };
  }
  if (mencionaSubNivelPreprimaria) ctxSesion.subNivelPreprimariaConfirmado = true;

  if (!matchImagen && nivelParaCompletarTema && ctxSesion.temaPendienteCategoria) {
    const reglaCompletada = completarTemaPendiente(ctxSesion.temaPendienteCategoria, nivelParaCompletarTema);
    if (reglaCompletada) matchImagen = { regla: reglaCompletada, ambigua: false };
  }
  if (!matchImagen && !esAgradecimientoOCierre(mensajeUsuario)) {
    matchImagen = buscarReglaImagenCoincidente(mensajeUsuario, ctxSesion.nivelSesion);
  }

  // "Modo Visual" — Política de Recuperación de Imágenes: si el padre/madre pide ver
  // imágenes explícitamente ("muéstrame", "quiero ver", "envía imágenes", "fotografías",
  // "necesito las imágenes") y ya había un tema pendiente + el nivel ya se sabe (de este
  // mensaje o de antes en la sesión), se manda de una vez — sin volver a preguntar nada
  // que ya se sepa, tal como pide la política.
  const PALABRAS_MODO_VISUAL = ['muéstrame', 'muestrame', 'quiero ver', 'envía imágenes', 'envia imagenes', 'fotografías', 'fotografias', 'necesito las imágenes', 'necesito las imagenes', 'mándame las imágenes', 'mandame las imagenes'];
  const esModoVisual = PALABRAS_MODO_VISUAL.some(p => mensajeUsuario.toLowerCase().includes(p));
  if (!matchImagen && esModoVisual && ctxSesion.temaPendienteCategoria && ctxSesion.nivelSesion) {
    const reglaCompletada = completarTemaPendiente(ctxSesion.temaPendienteCategoria, ctxSesion.nivelSesion);
    if (reglaCompletada) matchImagen = { regla: reglaCompletada, ambigua: false };
  }

  if (matchImagen && matchImagen.ambigua) {
    ctxSesion.temaPendienteCategoria = matchImagen.categoria; // recordar para cuando llegue el grado solo
  }

  if (matchImagen && !matchImagen.ambigua && matchImagen.regla) {
    ctxSesion.temaPendienteCategoria = null; // ya se resolvió, no queda nada pendiente

    // El papá puede pedir VARIAS cosas en un solo mensaje ("cuotas, requisitos, horarios
    // y el proceso de admisión"), o necesitar el mismo tema para VARIOS niveles (hijos en
    // grados distintos). Antes solo se mandaba la primera coincidencia y el resto se
    // perdía. Mismo tratamiento que ya funciona en AcruxLab.
    const nivelParaBuscar = nivelMencionadoAhora || ctxSesion.nivelSesion;
    let reglasAEnviar = buscarTodasLasReglasCoincidentes(mensajeUsuario, nivelParaBuscar, ctxSesion.nivelesMultiples);
    if (!reglasAEnviar.length || !reglasAEnviar.some(r => r.categoria === matchImagen.regla.categoria)) {
      reglasAEnviar = [matchImagen.regla];
    }

    const enviadas = [];
    for (const regla of reglasAEnviar) {
      const filtroImg = { tenant_id: tenant._id, activo: true, categoria: regla.categoria };
      if (regla.nivel_educativo) filtroImg.nivel_educativo = { $in: [regla.nivel_educativo, 'Todos'] };
      if (regla.nombre_contiene) filtroImg.nombre = new RegExp(regla.nombre_contiene, 'i');
      const imagenDirecta = await ImagenMarketing.findOne(filtroImg).sort({ prioridad: -1, creado: -1 });
      if (!imagenDirecta) continue;

      try {
        await enviarImagenDesdeDB(imagenDirecta, numeroOrigen, construirDescripcionImagen(imagenDirecta));
        enviadas.push(imagenDirecta.nombre);
        console.log(`🖼️ Imagen directa enviada (sin texto): "${imagenDirecta.nombre}" → ${numeroOrigen}`);
        if (reglasAEnviar.length > 1) await new Promise(r => setTimeout(r, 1800)); // respiro entre imágenes
      } catch (e) {
        console.error(`❌ Error enviando imagen "${imagenDirecta.nombre}" a ${numeroOrigen}:`, e.message);
      }
    }

    if (enviadas.length) {
      ctxSesion.historial.push({ role: 'user', content: mensajeUsuario });
      ctxSesion.historial.push({ role: 'assistant', content: `[NOTA DE SISTEMA — esto NO es algo que tú dijiste ni debes imitar este formato de frase: el sistema envió automáticamente ${enviadas.length === 1 ? 'la imagen' : 'las imágenes'} "${enviadas.join('", "')}" con el detalle completo de ${enviadas.length === 1 ? 'ESE tema' : 'ESOS temas'}. No repitas estos datos en texto. Recuerda: tú NUNCA controlas ni sabes con certeza si se manda una imagen en otros mensajes — eso lo decide el sistema por separado según palabras clave. Jamás afirmes "te mandé la imagen" o "aquí tienes las imágenes" a menos que este mensaje de sistema aparezca de verdad para ESE turno.]` });
      ctxSesion.ultimaActividad = Date.now();
      return ''; // texto vacío = no se manda ningún mensaje de texto, solo la(s) imagen(es)
    }
  }

  // ===== DETECTAR SOLICITUD DE AGENTE — solo transferir si ya hay contexto o el padre insiste =====
  // (La recuperación de memoria desde MongoDB ya se maneja arriba, en el bloque de
  // "IMAGEN DIRECTA" — ahí se crea la sesión en memoria y se inyecta el contexto del
  // contacto la primera vez, sin importar si ese mensaje disparó una imagen o no.)

  const historialPrevio = conversaciones.get(numeroOrigen)?.historial || [];
  const yaHayContexto = historialPrevio.length >= 4; // al menos 2 intercambios (pregunta+respuesta x2)
  const insisteExplicito = detectaInsistenciaAgente(mensajeUsuario);
  const ultimoMsgBot = [...historialPrevio].reverse().find(m => m.role === 'assistant')?.content || '';
  const mostroInteresReal = esAltaIntencion(mensajeUsuario, ultimoMsgBot); // Nivel 1 = quiere agendar/inscribir = transferir directo

  if ((detectaSolicitudAgente(mensajeUsuario) && (yaHayContexto || insisteExplicito)) || mostroInteresReal) {
    const motivoHandoff = mostroInteresReal ? `Interesado en avanzar: ${mensajeUsuario}` : mensajeUsuario;
    const { conv, agente } = await iniciarHandoff(tenant, numeroOrigen, null, motivoHandoff);
    conv.mensajes.push({ de: 'padre', texto: mensajeUsuario });
    const msg = construirMensajeTraspaso(agente?.nombre, mostroInteresReal);
    conv.mensajes.push({ de: 'bot', texto: msg });
    await conv.save();

    // Crear/actualizar el candidato en Odoo también cuando el handoff fue por interés real
    if (mostroInteresReal) {
      crearCandidatoOdooSiNoExiste(tenant, numeroOrigen, mensajeUsuario, historialPrevio)
        .catch(e => console.error('❌ Error creando candidato en handoff:', e.message));
    }

    return msg;
  }
  // Si pidió asesor pero aún no hay contexto suficiente, KAI continúa la conversación normalmente
  // intentando avanzar el proceso (esto se maneja en el system prompt de buildSystemPrompt)

  if (!conversaciones.has(numeroOrigen)) conversaciones.set(numeroOrigen, { historial: [], ultimaActividad: Date.now() });
  const conv = conversaciones.get(numeroOrigen);

  // Si la conversación había sido cerrada por inactividad (1h), reiniciar el historial activo
  // pero la memoria persistente (Contacto) sigue intacta, así que KAI no pierde el contexto del padre.
  const fueRecienCerrada = conv.cerrada === true;
  if (fueRecienCerrada) {
    conv.historial = [];
    conv.cerrada = false;
  }

  const inactivoPor = Date.now() - (conv.ultimaActividad || Date.now());
  const llevaInactivo3h = !fueRecienCerrada && inactivoPor >= (3 * 60 * 60 * 1000) && conv.historial.length > 0;
  conv.ultimaActividad = Date.now();
  const historial = conv.historial;
  historial.push({ role: 'user', content: mensajeUsuario });
  if (historial.length > 16) historial.splice(0, 2);
  const systemPrompt = buildSystemPrompt(tenant);
  let contextoExtra = '';
  if (llevaInactivo3h) {
    contextoExtra += '\n\n⏰ CONTEXTO: Esta conversación estuvo inactiva por más de 3 horas. El padre/madre acaba de volver a escribir. Salúdalo con calidez retomando la conversación, sin mencionar el tiempo de inactividad de forma incómoda.';
  }
  if (fueRecienCerrada) {
    contextoExtra += '\n\n🔄 CONTEXTO: La conversación anterior se cerró automáticamente porque el padre/madre no respondió en un tiempo. Ahora acaba de escribir de nuevo. Salúdalo con calidez como si retomaras la conversación, usando la memoria que tengas de él si aplica, sin mencionar el cierre automático.';
  }

  // ===== MEMORIA PERSISTENTE — cargar contacto de la BD =====
  let contacto = await Contacto.findOne({ tenant_id: tenant._id, numero: numeroOrigen });
  const esPrimeraVezEnEstaSesion = !conv.memoriaSaludoHecho; // bandera dedicada — no falla aunque antes hubiera un envío de imagen sin texto en esta sesión
  conv.memoriaSaludoHecho = true;

  // 🔍 Diagnóstico temporal — para atrapar el bug de "no me reconoció" la próxima vez.
  console.log(`🔍 [MEMORIA] ${numeroOrigen} | mensaje="${mensajeUsuario}" | esPrimeraVezSesion=${esPrimeraVezEnEstaSesion} | historial.length=${historial.length} | contacto_encontrado=${!!contacto} | contacto.nombre="${contacto?.nombre}"`);

  if (contacto && esPrimeraVezEnEstaSesion && contacto.nombre) {
    // Ya no exigimos que haya pasado un tiempo mínimo desde el último contacto — si es la
    // primera vez de ESTA sesión (el servidor se reinició, o volvió después de cerrado)
    // y ya sabemos quién es, siempre lo reconocemos, sin importar cuánto tiempo pasó.
    contextoExtra += `\n\n🧠 MEMORIA DEL CONTACTO: Este número ya escribió antes (${contacto.total_conversaciones} veces). `;
    if (contacto.nombre) contextoExtra += `Se llama ${contacto.nombre}. `;
    if (contacto.nombre_alumno) contextoExtra += `Pregunta por su hijo/a ${contacto.nombre_alumno}. `;
    if (contacto.nivel_interes) contextoExtra += `Interesado en nivel ${contacto.nivel_interes}. `;
    if (contacto.resumen_ultimo_contacto) contextoExtra += `Última vez se habló de: ${contacto.resumen_ultimo_contacto}. `;
    contextoExtra += `Salúdalo por su nombre reconociendo que ya hablaron antes, y pregúntale directamente en qué le puedes ayudar hoy con respecto a su nivel de interés (si lo sabes) — sin repetir preguntas que ya respondió. Usa un formato similar a: "¡Hola ${contacto.nombre || ''}! Qué gusto verte de vuelta 😊\\n\\n¿En qué te puedo ayudar hoy${contacto.nivel_interes ? ` con respecto a ${contacto.nivel_interes}` : ''} en el Colegio Capouilliez?"`;
  }

  // Si llegamos aquí con matchImagen ambiguo, es porque el tema es claro (cuotas,
  // papelería, edades, etc.) pero el mensaje actual NO especifica el grado — en vez de
  // adivinar con datos guardados (eso causaba el bug de mandar la imagen equivocada),
  // le pedimos a KAI que pregunte el grado, sin dar ningún número ni mandar imagen todavía.
  if (matchImagen && matchImagen.ambigua) {
    contextoExtra += '\n\n📌 IMPORTANTE: El padre/madre preguntó sobre un tema (cuotas, proceso, etc.) pero no especificó el grado/nivel exacto. NO des ningún número, precio, o dato específico todavía — primero pregúntale amablemente en qué grado o nivel está interesado, para poder darle el dato exacto (o mandarle la imagen correcta) en cuanto lo diga.';
  }

  try {
    const [faqs, docs] = await Promise.all([
      FAQ.find({ tenant_id: tenant._id, activo: true }).limit(20),
      Documento.find({ tenant_id: tenant._id, activo: true }).sort({ tipo: 1, creado: -1 }).limit(15)
    ]);
    if (faqs.length) contextoExtra += '\n\nPREGUNTAS FRECUENTES:\n' + faqs.map(f => `P: ${f.pregunta}\nR: ${f.respuesta}`).join('\n\n');
    contextoExtra += buildDocsContext(docs);
  } catch (e) {}
  console.log(`🔍 [HISTORIAL antes de llamar a Claude] ${numeroOrigen} | ${historial.length} mensajes: ${JSON.stringify(historial.map(m=>({role:m.role, preview:(m.content||'').substring(0,40)})))}`);
  const reply = await llamarClaude(systemPrompt + contextoExtra, historial, 600);
  const respuestaLimpia = reply ? reply.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1') : null;

  if (!respuestaLimpia) {
    // La IA no pudo responder (llave/crédito agotado, error de red, etc.) — en vez de
    // mostrarle al padre/madre un mensaje de error técnico, lo transferimos directo a
    // un vendedor disponible, para que nunca vea que algo se rompió del lado de KAI.
    console.error(`⚠️ Claude no respondió — transfiriendo a humano automáticamente para ${numeroOrigen}`);
    const { agente } = await iniciarHandoff(tenant, numeroOrigen, contacto?.nombre || null, `[Traslado automático: KAI no pudo responder — posible falla técnica]`);
    const respuesta = construirMensajeTraspaso(agente?.nombre, false);
    return respuesta;
  }

  const respuesta = respuestaLimpia;
  historial.push({ role: 'assistant', content: respuesta });

  // ===== VERIFICACIÓN DE CONSISTENCIA (mismo principio que en AcruxLab) =====
  // Si KAI dijo algo como "te conecto con un asesor" por su cuenta, sin que nuestra
  // detección determinística lo haya disparado, forzamos el traspaso real para que
  // el sistema haga lo mismo que KAI acaba de prometer.
  const PARECE_PROMESA_DE_ASESOR = /te (conecto|paso|comunico) (ahora|con)|un asesor te|con (un asesor|nuestro asesor)|le (conecto|paso|comunico)/i.test(respuesta);
  if (PARECE_PROMESA_DE_ASESOR && estaDentroDeHorarioLaboral()) {
    iniciarHandoff(tenant, numeroOrigen, contacto?.nombre || null, '[Consistencia: KAI prometió un asesor en texto]')
      .then(() => console.log(`🔧 [Consistencia] KAI prometió un asesor en texto — se forzó el traspaso real para ${numeroOrigen}`))
      .catch(e => console.error('❌ Error forzando traspaso de consistencia:', e.message));
  }

  // ===== ACTUALIZAR/CREAR CONTACTO Y DETECTAR INTERÉS REAL (async, no bloquea respuesta) =====
  actualizarContactoYDetectarInteres(tenant, numeroOrigen, mensajeUsuario, respuesta, historial, contacto)
    .catch(e => console.error('❌ Error actualizando contacto:', e.message));

  return respuesta;
}

// ===== WEBHOOK TWILIO =====
// ===== WEBHOOK META WHATSAPP CLOUD API =====

// GET — verificación inicial que pide Meta al guardar el webhook
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook de Meta verificado correctamente');
    return res.status(200).send(challenge);
  }
  console.error('❌ Verificación de webhook fallida — token no coincide');
  res.sendStatus(403);
});

// Enviar mensaje de texto vía Meta WhatsApp Cloud API
function enviarWhatsAppMeta(numeroDestino, texto) {
  return new Promise((resolve) => {
    const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
    const TOKEN_WA = process.env.WHATSAPP_TOKEN;
    if (!PHONE_ID || !TOKEN_WA) { console.error('❌ Falta WHATSAPP_PHONE_ID o WHATSAPP_TOKEN'); return resolve(null); }

    const body = JSON.stringify({
      messaging_product: 'whatsapp',
      to: numeroDestino.replace(/\D/g, ''),
      type: 'text',
      text: { body: texto }
    });

    const req2 = https.request({
      hostname: 'graph.facebook.com',
      path: `/v22.0/${PHONE_ID}/messages`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN_WA}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        const respuestaTexto = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(respuestaTexto); } catch(e) { json = { raw: respuestaTexto }; }
        // Antes los errores de Meta se descartaban en silencio: si un envío fallaba
        // (ventana de 24h cerrada, token vencido, número inválido...), nadie se enteraba
        // y parecía que se había mandado bien. Ahora queda registrado en los logs.
        if (json && json.error) {
          console.error(`❌ [META] Envío a ${numeroDestino} RECHAZADO — código ${json.error.code}: ${json.error.message}${json.error.error_data && json.error.error_data.details ? ' | ' + json.error.error_data.details : ''}`);
        }
        resolve(json);
      });
    });
    req2.on('error', (e) => { console.error('❌ Error enviando WhatsApp:', e.message); resolve(null); });
    req2.write(body);
    req2.end();
  });
}

// Sube una imagen (base64) a los servidores de Meta y devuelve el media_id necesario para enviarla
function subirImagenAMeta(imagenBase64, mimeType) {
  return new Promise((resolve) => {
    const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
    const TOKEN_WA = process.env.WHATSAPP_TOKEN;
    if (!PHONE_ID || !TOKEN_WA) { console.error('❌ Falta WHATSAPP_PHONE_ID o WHATSAPP_TOKEN'); return resolve(null); }

    const buffer = Buffer.from(imagenBase64, 'base64');
    const boundary = '----KaiBoundary' + Date.now();
    const parts = [];
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="messaging_product"\r\n\r\nwhatsapp\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="imagen.jpg"\r\nContent-Type: ${mimeType}\r\n\r\n`));
    parts.push(buffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    const req2 = https.request({
      hostname: 'graph.facebook.com',
      path: `/v22.0/${PHONE_ID}/media`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN_WA}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    }, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(parsed.id || null);
        } catch (e) { resolve(null); }
      });
    });
    req2.on('error', (e) => { console.error('❌ Error subiendo imagen a Meta:', e.message); resolve(null); });
    req2.write(body);
    req2.end();
  });
}

// Envía una imagen ya subida (media_id) a un número de WhatsApp, con texto opcional (caption)
function enviarImagenWhatsAppMeta(numeroDestino, mediaId, caption) {
  return new Promise((resolve) => {
    const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
    const TOKEN_WA = process.env.WHATSAPP_TOKEN;
    if (!PHONE_ID || !TOKEN_WA) { console.error('❌ Falta WHATSAPP_PHONE_ID o WHATSAPP_TOKEN'); return resolve(null); }

    const body = JSON.stringify({
      messaging_product: 'whatsapp',
      to: numeroDestino.replace(/\D/g, ''),
      type: 'image',
      image: { id: mediaId, caption: caption || '' }
    });

    const req2 = https.request({
      hostname: 'graph.facebook.com',
      path: `/v22.0/${PHONE_ID}/messages`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN_WA}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => { const texto = Buffer.concat(chunks).toString('utf8'); try { resolve(JSON.parse(texto)); } catch(e) { resolve({ raw: texto }); } });
    });
    req2.on('error', (e) => { console.error('❌ Error enviando imagen WhatsApp:', e.message); resolve(null); });
    req2.write(body);
    req2.end();
  });
}

// Sube una imagen como "adjunto reutilizable" a Instagram/Messenger (mismo mecanismo
// para ambos vía Graph API) y devuelve el attachment_id para enviarla después.
function subirImagenAdjuntoMeta(imagenBase64, mimeType, tokenPagina) {
  return new Promise((resolve) => {
    if (!tokenPagina) return resolve(null);
    const buffer = Buffer.from(imagenBase64, 'base64');
    const boundary = '----KaiBoundary' + Date.now();
    const mensajePart = JSON.stringify({ message: { attachment: { type: 'image', payload: { is_reusable: true } } } });
    const parts = [];
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\n${mensajePart}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="filedata"; filename="imagen.jpg"\r\nContent-Type: ${mimeType}\r\n\r\n`));
    parts.push(buffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    const req2 = https.request({
      hostname: 'graph.facebook.com',
      path: `/v22.0/me/message_attachments?access_token=${tokenPagina}`,
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
    }, (r) => { const chunks=[]; r.on('data',c=>chunks.push(c)); r.on('end',()=>{ try{ resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')).attachment_id || null); }catch(e){ resolve(null); } }); });
    req2.on('error', () => resolve(null));
    req2.write(body); req2.end();
  });
}

// Envía una imagen ya subida (attachment_id) por Instagram o Messenger
function enviarImagenAdjuntoMeta(recipientId, attachmentId, tokenPagina, caption) {
  return new Promise((resolve) => {
    if (!tokenPagina) return resolve(null);
    const body = JSON.stringify({
      recipient: { id: recipientId },
      message: { attachment: { type: 'image', payload: { attachment_id: attachmentId } } }
    });
    const req2 = https.request({
      hostname: 'graph.facebook.com',
      path: `/v22.0/me/messages?access_token=${tokenPagina}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (r) => { const chunks=[]; r.on('data',c=>chunks.push(c)); r.on('end',()=>{
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        // Si hay caption, mandarlo como mensaje de texto aparte (los adjuntos de imagen no llevan texto junto)
        if (caption) enviarMensajeMessenger(recipientId, caption).catch(()=>{});
        resolve(parsed);
      } catch(e){ resolve(null); }
    }); });
    req2.on('error', () => resolve(null));
    req2.write(body); req2.end();
  });
}

// Función de conveniencia: sube + envía una imagen (de la BD o subida ad-hoc) por Instagram/Messenger
async function enviarImagenInstagramOMessenger(canal, imagenBase64, mimeType, recipientId, caption) {
  const tokenPagina = canal === 'instagram'
    ? (process.env.INSTAGRAM_PAGE_TOKEN || process.env.WHATSAPP_TOKEN)
    : (process.env.MESSENGER_PAGE_TOKEN || process.env.WHATSAPP_TOKEN);
  const attachmentId = await subirImagenAdjuntoMeta(imagenBase64, mimeType, tokenPagina);
  if (!attachmentId) return { ok: false, error: 'No se pudo subir la imagen a Meta (revisar token de página)' };
  const resultado = await enviarImagenAdjuntoMeta(recipientId, attachmentId, tokenPagina, caption);
  if (resultado && resultado.message_id) return { ok: true, mensaje_id: resultado.message_id };
  return { ok: false, error: resultado?.error?.message || 'Error desconocido al enviar imagen', detalle: resultado };
}

// Función de conveniencia: sube + envía una imagen de la base de datos a un número, en un solo paso
async function enviarImagenDesdeDB(imagenDoc, numeroDestino, caption) {
  const mediaId = await subirImagenAMeta(imagenDoc.imagen_base64, imagenDoc.mime_type);
  if (!mediaId) return { ok: false, error: 'No se pudo subir la imagen a Meta' };
  const resultado = await enviarImagenWhatsAppMeta(numeroDestino, mediaId, caption);
  if (resultado && resultado.messages) {
    imagenDoc.veces_enviada = (imagenDoc.veces_enviada || 0) + 1;
    await imagenDoc.save().catch(()=>{});
    return { ok: true, mensaje_id: resultado.messages[0]?.id };
  }
  return { ok: false, error: resultado?.error?.message || 'Error desconocido al enviar imagen', detalle: resultado };
}

// ===== CIERRE PROACTIVO POR INACTIVIDAD (1 HORA) =====
// ===== MODO NO INTERACTIVO — nuevo esquema, en prueba solo con números de prueba =====
// A pedido explícito: Kai deja de "conversar" — solo saluda, pregunta el nivel, entrega
// una secuencia FIJA de contenido (video + imágenes) y cierra pasando el caso a una
// asesora. Sin preguntas de seguimiento, sin cálculos, sin negociar el tono.
// Por ahora SOLO corre para los números de prueba — el resto del equipo sigue con el
// flujo conversacional normal hasta que se decida activarlo para todos.
const MODO_NO_INTERACTIVO_SOLO_PRUEBAS = true;

const MENSAJE_VIDEO_PROYECTO_NI = 'Con gusto le presentamos nuestro proyecto educativo basado en excelencia y valores. https://youtu.be/tZbsAKo2_g4';

const MENSAJE_CIERRE_NO_INTERACTIVO =
  '¡Gracias por comunicarte con nosotros! 😊\n' +
  'Una de nuestras asesoras de Admisiones continuará la conversación y con gusto te brindará información más detallada, además de resolver cualquier duda que tengas.\n' +
  '¡Será un placer acompañarte en este proceso! 📚✨';

// Cada nivel: la secuencia fija de imágenes a mandar, en orden, usando los mismos
// filtros (categoría/nivel_educativo/nombre) que ya usa el sistema de imágenes normal —
// así no se depende de adivinar nombres de archivo, se reutiliza el banco tal cual está.
const SECUENCIA_IMAGENES_NO_INTERACTIVO = {
  preprimaria: [
    { categoria: 'programas', nombre_contiene: 'Preprimaria' },
    { categoria: 'info_general', nombre_contiene: 'Horario' },
    { categoria: 'cuotas', nivel_educativo: 'Preprimaria', nombre_contiene: 'Preprimaria' }
  ],
  primaria: [
    { categoria: 'programas', nombre_contiene: '(?<!Pre)Primaria' },
    { categoria: 'admision', nombre_contiene: 'Requisitos' },
    { categoria: 'info_general', nombre_contiene: 'Horario' },
    { categoria: 'cuotas', nivel_educativo: 'Primaria', nombre_contiene: '(?<!Pre)Primaria' }
  ],
  secundaria: [
    { categoria: 'programas', nombre_contiene: 'Secundaria' },
    { categoria: 'admision', nombre_contiene: 'Requisitos' },
    { categoria: 'info_general', nombre_contiene: 'Horario' },
    { categoria: 'cuotas', nivel_educativo: 'Secundaria', nombre_contiene: 'Secundaria' }
  ]
};

const MENU_NIVEL_NI = '¡Hola! 👋 Bienvenido al Colegio Capouilliez.\n\n¿En qué nivel está interesado? Marque el número:\n1. Preprimaria\n2. Primaria\n3. Secundaria (Básico y Bachillerato en Ciencias y Letras)';

// Devuelve TODOS los niveles mencionados en el mensaje (puede ser más de uno — "1, 2 y
// 3" es una respuesta real y predecible de un papá con varios hijos). Antes solo
// devolvía el primero que encontraba y se detenía ahí.
function detectarNivelesMenuNI(texto) {
  const t = (texto || '').trim().toLowerCase();
  const detectados = [];

  // "Todos", "los tres", etc. — pide los tres niveles de una vez.
  if (/\btodos\b|\btodas\b|\blos tres\b|\blas tres\b/.test(t)) return ['preprimaria', 'primaria', 'secundaria'];

  // Cada nivel se reconoce por: el número (en cualquier parte del mensaje, no solo al
  // inicio — "Gracias, ahora el 2?" debe funcionar), un ordinal en palabras, o el
  // nombre real del nivel/grado.
  if (/\b1\b|\bprimero\b|\bprimera\b/.test(t) || /preprimaria|jard[ií]n|infantil|k[ií]nder|p[aá]rvulos|preparatoria/.test(t)) detectados.push('preprimaria');
  if (/\b2\b|\bsegundo\b|\bsegunda\b/.test(t) || /\bprimaria\b/.test(t)) detectados.push('primaria');
  if (/\b3\b|\btercero\b|\btercera\b/.test(t) || /secundaria|b[aá]sico|bachillerato/.test(t)) detectados.push('secundaria');
  return detectados;
}
// Se deja esta versión (un solo nivel) por si algo más la usa — ahora es un simple atajo.
function detectarNivelMenuNI(texto) {
  return detectarNivelesMenuNI(texto)[0] || null;
}

// Busca y devuelve la imagen del banco para un filtro de la secuencia, sin enviarla —
// el envío real lo hace cada canal a su manera (AcruxLab vs WhatsApp son distintos).
async function buscarImagenSecuenciaNI(tenant, filtroBase) {
  const filtro = { tenant_id: tenant._id, activo: true, categoria: filtroBase.categoria };
  if (filtroBase.nivel_educativo) filtro.nivel_educativo = { $in: [filtroBase.nivel_educativo, 'Todos'] };
  if (filtroBase.nombre_contiene) filtro.nombre = new RegExp(filtroBase.nombre_contiene, 'i');
  return ImagenMarketing.findOne(filtro).sort({ prioridad: -1, creado: -1 });
}

// Maneja TODO el flujo no interactivo para AcruxLab: saluda, espera el nivel, entrega
// la secuencia fija de imágenes, y cierra pasando el caso a una asesora — sin ninguna
// otra interacción de por medio. Se usa `conv` (memoria en RAM) para el estado.
async function manejarModoNoInteractivoAcrux(tenant, mensajeUsuario, conv, contactoId) {
  if (!conv.nivelesNoInteractivoEnviados) conv.nivelesNoInteractivoEnviados = [];

  const nivelesDetectados = detectarNivelesMenuNI(mensajeUsuario);
  const nivelesNuevos = nivelesDetectados.filter(n => !conv.nivelesNoInteractivoEnviados.includes(n));

  // No mencionó ningún nivel nuevo (puede que no haya mencionado ninguno, o que ya se
  // le hayan mandado todos los que menciona — ej. repite "1" dos veces).
  if (!nivelesNuevos.length) {
    if (conv.nivelesNoInteractivoEnviados.length) return { texto: null, handoff: false }; // ya se le mandó al menos uno, queda con la asesora
    if (conv.noInteractivoSaludado) return { texto: null, handoff: false }; // ya se le preguntó, esperando que conteste
    conv.noInteractivoSaludado = true;
    return { texto: MENU_NIVEL_NI, handoff: false };
  }

  // Uno o más niveles nuevos — se manda la secuencia completa de CADA UNO, en orden
  // (un papá puede pedir varios de una vez: "1, 2 y 3" — eso es normal y predecible).
  for (const nivel of nivelesNuevos) {
    await enviarTextoAcruxLab(contactoId, MENSAJE_VIDEO_PROYECTO_NI);
    for (const filtro of SECUENCIA_IMAGENES_NO_INTERACTIVO[nivel]) {
      const img = await buscarImagenSecuenciaNI(tenant, filtro);
      if (!img) { console.log(`⚠️ [No interactivo] No se encontró imagen en el banco para: ${JSON.stringify(filtro)}`); continue; }
      try {
        const adjunto = await subirImagenNuevaAcrux(img.imagen_base64, `${img.nombre}.jpg`, img.mime_type || 'image/jpeg', contactoId);
        await odooCallLocal('acrux.chat.conversation', 'send_message', [[contactoId], {
          text: construirDescripcionImagen(img), from_me: true, ttype: 'image', res_model: 'ir.attachment', res_id: adjunto.id,
          id: -2, date_message: new Date().toISOString().replace('T', ' ').substring(0, 19), button_ids: []
        }], { context: { lang: 'es_GT', tz: 'America/Guatemala', is_acrux_chat_room: true } });
        console.log(`🖼️ [No interactivo] Imagen enviada: "${img.nombre}" → contacto ${contactoId}`);
      } catch (e) { console.error(`❌ [No interactivo] Falló imagen "${img.nombre}": ${e.message}`); }
      await new Promise(r => setTimeout(r, 1500));
    }
    conv.nivelesNoInteractivoEnviados.push(nivel);
  }

  // ===== ASIGNACIÓN DE VENDEDORA — DESACTIVADA TEMPORALMENTE A PEDIDO =====
  // Poner modo:'humano' bloqueaba que Kai volviera a responder en mensajes siguientes
  // (el propio sistema respeta cuando un humano ya tiene el chat, y no distinguía que
  // era la propia prueba). Se deja pendiente hasta reactivarla a propósito, una vez que
  // el resto del flujo esté confirmado.
  // try {
  //   const asignExistente = await AsignacionAcrux.findOne({ tenant_id: tenant._id, contacto_id: contactoId });
  //   let agenteParaAsignar = null;
  //   if (asignExistente?.agente_id) {
  //     agenteParaAsignar = await UsuarioPanel.findById(asignExistente.agente_id);
  //   } else {
  //     agenteParaAsignar = await asignarAgenteLibre(tenant._id);
  //   }
  //   await AsignacionAcrux.findOneAndUpdate(
  //     { tenant_id: tenant._id, contacto_id: contactoId },
  //     {
  //       modo: 'humano', fecha_modo_humano: new Date(),
  //       ...(agenteParaAsignar ? { agente_id: agenteParaAsignar._id, agente_nombre: agenteParaAsignar.nombre } : {})
  //     },
  //     { upsert: true, setDefaultsOnInsert: true }
  //   );
  //   console.log(`👤 [No interactivo] Traspaso a ${agenteParaAsignar?.nombre || 'nadie disponible'} — contacto ${contactoId}`);
  // } catch (e) { console.error(`❌ [No interactivo] Falló asignar vendedor: ${e.message}`); }

  return { texto: MENSAJE_CIERRE_NO_INTERACTIVO, handoff: true };
}

// Misma lógica que la versión de AcruxLab, pero mandando por WhatsApp/Meta directo.
// Devuelve un texto (que el llamador envía normal) o '' para no mandar nada.
async function manejarModoNoInteractivoWhatsApp(tenant, mensajeUsuario, ctxSesion, numeroOrigen) {
  if (!ctxSesion.nivelesNoInteractivoEnviados) ctxSesion.nivelesNoInteractivoEnviados = [];

  // El panel ("Chats en Vivo") lee de este modelo, no de la memoria en RAM — sin esto,
  // lo que se manda por WhatsApp nunca queda visible ahí, aunque el padre sí lo reciba.
  let conversacionDB = await Conversacion.findOne({ tenant_id: tenant._id, numero: numeroOrigen, estado: { $ne: 'cerrado' } });
  if (!conversacionDB) {
    conversacionDB = await Conversacion.create({ tenant_id: tenant._id, numero: numeroOrigen, canal: 'whatsapp', estado: 'bot', mensajes: [] });
  }
  conversacionDB.mensajes.push({ de: 'padre', texto: mensajeUsuario, fecha: new Date() });

  const nivelesDetectados = detectarNivelesMenuNI(mensajeUsuario);
  const nivelesNuevos = nivelesDetectados.filter(n => !ctxSesion.nivelesNoInteractivoEnviados.includes(n));

  if (!nivelesNuevos.length) {
    if (ctxSesion.nivelesNoInteractivoEnviados.length) { await conversacionDB.save(); return ''; }
    if (ctxSesion.noInteractivoSaludado) { await conversacionDB.save(); return ''; }
    ctxSesion.noInteractivoSaludado = true;
    conversacionDB.mensajes.push({ de: 'bot', texto: MENU_NIVEL_NI, fecha: new Date() });
    conversacionDB.ultimaActividad = new Date();
    await conversacionDB.save();
    return MENU_NIVEL_NI;
  }

  for (const nivel of nivelesNuevos) {
    await enviarWhatsAppMeta(numeroOrigen, MENSAJE_VIDEO_PROYECTO_NI);
    conversacionDB.mensajes.push({ de: 'bot', texto: MENSAJE_VIDEO_PROYECTO_NI, fecha: new Date() });

    for (const filtro of SECUENCIA_IMAGENES_NO_INTERACTIVO[nivel]) {
      const img = await buscarImagenSecuenciaNI(tenant, filtro);
      if (!img) { console.log(`⚠️ [No interactivo][WhatsApp] No se encontró imagen para: ${JSON.stringify(filtro)}`); continue; }
      const descripcion = construirDescripcionImagen(img);
      try {
        await enviarImagenDesdeDB(img, numeroOrigen, descripcion);
        conversacionDB.mensajes.push({
          de: 'bot', texto: `🖼️ ${descripcion}`,
          imagen_base64: img.imagen_base64, imagen_mime: img.mime_type || 'image/jpeg',
          fecha: new Date()
        });
      } catch (e) {
        console.error(`❌ [No interactivo][WhatsApp] Falló imagen "${img.nombre}": ${e.message}`);
        conversacionDB.mensajes.push({ de: 'bot', texto: `⚠️ (falló el envío de la imagen "${img.nombre}")`, fecha: new Date() });
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    ctxSesion.nivelesNoInteractivoEnviados.push(nivel);
  }

  conversacionDB.mensajes.push({ de: 'bot', texto: MENSAJE_CIERRE_NO_INTERACTIVO, fecha: new Date() });
  conversacionDB.ultimaActividad = new Date();
  await conversacionDB.save();

  // ===== ASIGNACIÓN DE VENDEDORA — DESACTIVADA TEMPORALMENTE, mismo motivo que en AcruxLab =====
  // try {
  //   const agenteParaAsignar = await asignarAgenteLibre(tenant._id);
  //   await Conversacion.findOneAndUpdate(
  //     { tenant_id: tenant._id, numero: numeroOrigen, estado: { $ne: 'cerrado' } },
  //     {
  //       estado: 'humano',
  //       ...(agenteParaAsignar ? { agente_id: agenteParaAsignar._id, agente_nombre: agenteParaAsignar.nombre } : {})
  //     },
  //     { upsert: false }
  //   );
  //   console.log(`👤 [No interactivo][WhatsApp] Traspaso a ${agenteParaAsignar?.nombre || 'nadie disponible'} — ${numeroOrigen}`);
  // } catch (e) { console.error(`❌ [No interactivo][WhatsApp] Falló asignar vendedor: ${e.message}`); }

  return MENSAJE_CIERRE_NO_INTERACTIVO;
}


const MINUTOS_CIERRE_INACTIVIDAD = 60; // 1 hora

// Revisa cada 5 minutos las conversaciones activas con KAI (no las que ya están con un agente humano)
// y cierra con un mensaje de despedida las que llevan 1 hora sin que el padre responda.
setInterval(async () => {
  try {
    const ahora = Date.now();
    const limiteMs = MINUTOS_CIERRE_INACTIVIDAD * 60 * 1000;

    for (const [numero, conv] of conversaciones.entries()) {
      if (conv.cerrada) continue; // ya se cerró, no volver a mandar el mensaje
      if (!conv.historial || !conv.historial.length) continue; // nunca hubo conversación real
      // Si el padre NUNCA ha escrito (solo KAI, por contacto proactivo del formulario),
      // mandarle "no tuvimos respuesta de tu parte" queda fuera de lugar: él no inició
      // nada. Esos casos se dejan en paz esperando a que conteste cuando pueda.
      const padreYaEscribio = conv.historial.some(m => m.role === 'user');
      if (!padreYaEscribio) continue;
      const inactivoPor = ahora - (conv.ultimaActividad || ahora);
      if (inactivoPor < limiteMs) continue; // aún no pasa 1 hora

      // No cerrar si la conversación está en manos de un agente humano (eso lo maneja el agente, no KAI)
      const enHandoff = await Conversacion.findOne({ numero, estado: { $in: ['humano', 'esperando_agente'] } });
      if (enHandoff) { conv.ultimaActividad = ahora; continue; } // reiniciar el contador mientras esté con humano

      // Enviar mensaje de cierre y marcar como cerrada para no repetirlo
      try {
        // ===== INTERRUPTOR MAESTRO: KAI PAUSADO EN PRODUCCIÓN =====
        // Este cron manda directo por WhatsApp, sin pasar por responderConIA — por eso
        // seguía funcionando aunque las respuestas ya estaban pausadas.
        if (KAI_PAUSADO_PARA_PRODUCCION && !esNumeroDePrueba(numero)) {
          console.log(`⏸️ [Cierre por inactividad] KAI pausado en producción — no se cierra ${numero}`);
          continue;
        }
        const tenant = await Tenant.findOne({ activo: true }); // ajustar si hay multi-tenant real
        await enviarWhatsAppMeta(numero, MENSAJE_CIERRE_INACTIVIDAD);
        conv.cerrada = true;
        console.log(`👋 Conversación cerrada por inactividad (${MINUTOS_CIERRE_INACTIVIDAD} min) — ${numero}`);

        // Actualizar el contacto con el resumen de cierre
        if (tenant) {
          await Contacto.findOneAndUpdate(
            { tenant_id: tenant._id, numero },
            { $set: { resumen_ultimo_contacto: 'Conversación cerrada automáticamente por inactividad (1 hora sin respuesta).' } }
          ).catch(()=>{});
        }
      } catch (e) {
        console.error(`❌ Error cerrando conversación inactiva de ${numero}:`, e.message);
      }
    }
  } catch (e) { console.error('❌ Error en verificador de cierre por inactividad:', e.message); }
}, 5 * 60 * 1000); // revisa cada 5 minutos

// ===== MOTOR DE SEGMENTACIÓN PARA REACTIVACIÓN DE MARKETING =====
// Clasifica a cada Contacto en un segmento según hace cuánto fue su última conversación.
// Esto NO envía mensajes — solo etiqueta el segmento para que Campañas WhatsApp pueda filtrar por él.
//
// Segmentos:
//   activo        — conversó en los últimos 7 días, sigue caliente, no necesita reactivación
//   seguimiento   — entre 7 y 30 días sin escribir, candidato a un mensaje de valor (no venta dura)
//   reactivacion  — entre 30 y 60 días sin escribir, necesita un empujón (Open House, fechas límite)
//   frio          — más de 60 días sin escribir, requiere campaña de remarketing fuerte o descartar
const DIAS_SEGUIMIENTO = 7;
const DIAS_REACTIVACION = 30;
const DIAS_FRIO = 60;

async function actualizarSegmentosReactivacion() {
  try {
    const ahora = Date.now();
    const contactos = await Contacto.find({}); // todos los tenants — si hay multi-tenant real, filtrar aquí
    let cambios = 0;

    for (const c of contactos) {
      const diasInactivo = (ahora - new Date(c.ultimo_contacto).getTime()) / (1000 * 60 * 60 * 24);
      let nuevoSegmento = 'activo';
      if (diasInactivo >= DIAS_FRIO) nuevoSegmento = 'frio';
      else if (diasInactivo >= DIAS_REACTIVACION) nuevoSegmento = 'reactivacion';
      else if (diasInactivo >= DIAS_SEGUIMIENTO) nuevoSegmento = 'seguimiento';

      if (c.segmento_reactivacion !== nuevoSegmento) {
        c.segmento_reactivacion = nuevoSegmento;
        await c.save();
        cambios++;
      }
    }
    if (cambios > 0) console.log(`🎯 Segmentación de reactivación actualizada — ${cambios} contacto(s) cambiaron de segmento`);
  } catch (e) { console.error('❌ Error actualizando segmentos de reactivación:', e.message); }
}

// Corre una vez al iniciar el servidor, y luego cada 24 horas
setTimeout(actualizarSegmentosReactivacion, 30 * 1000); // esperar 30s a que MongoDB esté listo
setInterval(actualizarSegmentosReactivacion, 24 * 60 * 60 * 1000);

// Respaldo automático diario de TODOS los mensajes de AcruxLab — para que nunca vuelva
// a depender de que alguien lo corra a mano. No duplica lo que ya está guardado.
async function respaldoAutomaticoDiario() {
  try {
    const tenant = await Tenant.findOne({ activo: true });
    if (!tenant) return;
    const todasLasConv = await odooCallLocal('acrux.chat.conversation', 'search_read', [[]], { fields: ['id'], limit: 5000 }).catch(() => []);
    let guardados = 0;
    for (const conv of (todasLasConv || [])) {
      const mensajes = await odooCallLocal('acrux.chat.message', 'search_read',
        [[['contact_id', '=', conv.id]]], { fields: ['id', 'text', 'from_me', 'date_message'], limit: 500, order: 'date_message asc' }
      ).catch(() => []);
      for (const m of mensajes) {
        try {
          await MensajeRespaldo.create({
            tenant_id: tenant._id, contacto_id_acrux: conv.id, mensaje_id_odoo: m.id,
            de: m.from_me ? 'colegio' : 'padre', texto: m.text || '',
            fecha_mensaje: m.date_message ? new Date(m.date_message.replace(' ', 'T') + 'Z') : null
          });
          guardados++;
        } catch (e) { /* ya existía, normal */ }
      }
    }
    console.log(`💾 [Respaldo diario] ${guardados} mensajes nuevos guardados de ${(todasLasConv || []).length} conversaciones`);
  } catch (e) { console.error('❌ [Respaldo diario] Error:', e.message); }
}
setInterval(respaldoAutomaticoDiario, 24 * 60 * 60 * 1000);
setTimeout(respaldoAutomaticoDiario, 60 * 1000); // primera corrida 1 minuto después de arrancar

// ===== MOTOR DE CONTACTO PROACTIVO — KAI revisa Odoo y contacta leads nuevos por WhatsApp =====
// Corre cada 30 minutos. Busca leads en Odoo que tienen teléfono pero KAI nunca contactó.
// Los contacta por WhatsApp, captura respuesta en flujo normal, asigna a Cindy o Vanessa.

const TAG_KAI_CONTACTADO = 'KAI — Contactado';
const TAG_KAI_SIN_WHATSAPP = 'KAI — Sin WhatsApp';

async function motorContactoProactivo() {
  try {
    const tenant = await Tenant.findOne({ activo: true });
    if (!tenant) return;

    const tagContactadoId = await getOdooTagId(TAG_KAI_CONTACTADO);
    const tagSinWAId = await getOdooTagId(TAG_KAI_SIN_WHATSAPP);

    // Leads en Odoo con teléfono que KAI aún no contactó
    // Leads SIN ASIGNAR — igual que la vista "Sin asignar" en Odoo
    const leads = await odooCallLocal('crm.lead', 'search_read',
      [[
        ['active', '=', true],
        ['user_id', '=', false],
      ]],
      { fields: ['id', 'name', 'phone', 'partner_name', 'email_from', 'tag_ids', 'stage_id', 'user_id', 'create_date', 'type'], limit: 100 }
    );

    if (!leads || !leads.length) return;
    console.log(`📡 Motor proactivo: ${leads.length} lead(s) para contactar`);

    for (const lead of leads) {
      try {
        let telefono = String(lead.phone || '').replace(/\D/g, '');
        if (telefono.length === 8) telefono = '502' + telefono;
        if (telefono.length < 10) {
          await odooCallLocal('crm.lead', 'write', [[lead.id], { tag_ids: [[4, tagSinWAId]] }]);
          continue;
        }

        // Crear o vincular contacto en MongoDB
        let contacto = await Contacto.findOne({ tenant_id: tenant._id, numero: telefono });
        if (!contacto) {
          contacto = await Contacto.create({
            tenant_id: tenant._id, numero: telefono,
            nombre: lead.partner_name || null, correo: lead.email_from || null,
            canal_origen: 'lead_ads', odoo_lead_id: lead.id,
            ultimo_contacto: new Date(), primer_contacto: new Date(), total_conversaciones: 0
          });
        } else if (!contacto.odoo_lead_id) {
          contacto.odoo_lead_id = lead.id;
          await contacto.save();
        }

        // Mensaje de primer contacto personalizado
        const nombre = lead.partner_name ? lead.partner_name.split(' ')[0] : null;
        const saludo = nombre ? `Hola ${nombre}` : 'Hola';
        const mensaje = `${saludo} 👋 Te escribimos del *Colegio Capouilliez*.\n\nRecibimos tu información y queremos ayudarte con el proceso de admisiones 🏫\n\n¿Para qué nivel educativo estás buscando información?\n\n1️⃣ Preprimaria (2-6 años)\n2️⃣ Primaria (7-12 años)\n3️⃣ Secundaria (13-16 años)`;

        const resultado = await enviarWhatsAppMeta(telefono, mensaje);

        if (resultado?.messages?.length) {
          // Marcar como contactado en Odoo
          await odooCallLocal('crm.lead', 'write', [[lead.id], { tag_ids: [[4, tagContactadoId]] }]);
          await odooCallLocal('crm.lead', 'message_post', [[lead.id]], {
            body: `📱 KAI contactó por WhatsApp (${telefono}) con mensaje de bienvenida. Esperando respuesta.`
          }).catch(() => {});

          // Asignar asesora con menos carga
          const agentes = await UsuarioPanel.find({ tenant_id: tenant._id, role: 'vendedor', activo: true });
          if (agentes.length) {
            let menorCarga = agentes[0], menorCount = Infinity;
            for (const a of agentes) {
              const c = await Conversacion.countDocuments({ tenant_id: tenant._id, agente_id: a._id, estado: { $in: ['humano','esperando_agente'] } });
              if (c < menorCount) { menorCount = c; menorCarga = a; }
            }
            if (menorCarga.odoo_user_id) {
              await odooCallLocal('crm.lead', 'write', [[lead.id], { user_id: menorCarga.odoo_user_id }]).catch(() => {});
            }
          }

          console.log(`✅ KAI contactó lead #${lead.id} (${nombre || telefono})`);
          await new Promise(r => setTimeout(r, 3000));
        } else {
          await odooCallLocal('crm.lead', 'write', [[lead.id], { tag_ids: [[4, tagSinWAId]] }]);
          console.log(`⚠️ Sin WhatsApp válido — lead #${lead.id} (${telefono})`);
        }
      } catch(e) { console.error(`❌ Lead #${lead.id}:`, e.message); }
    }
  } catch(e) { console.error('❌ Motor proactivo:', e.message); }
}

// Motor proactivo DESHABILITADO hasta validación completa
// Para activar: usar endpoint POST /api/motor/activar desde el panel
// setTimeout(() => motorContactoProactivo(), 2 * 60 * 1000);
// setInterval(() => motorContactoProactivo(), 30 * 60 * 1000);

// POST — mensajes entrantes reales de WhatsApp
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responder rápido a Meta, procesar después

  try {
    const body = req.body;
    const object = body.object; // 'whatsapp_business_account' | 'instagram' | 'page'

    // ── DETECTAR CANAL ──────────────────────────────────────────────────────
    let canal = null;
    let numeroOrigen = null;
    let nombreCliente = null;
    let mensajeUsuario = null;
    let idExterno = null; // id único del remitente en ese canal

    if (object === 'whatsapp_business_account') {
      const value = body.entry?.[0]?.changes?.[0]?.value;
      const mensaje = value?.messages?.[0];
      if (!mensaje || !mensaje.text?.body) return;
      canal = 'whatsapp';
      numeroOrigen = mensaje.from;
      mensajeUsuario = mensaje.text.body;
      nombreCliente = value?.contacts?.[0]?.profile?.name || null;
      idExterno = mensaje.from;

    } else if (object === 'instagram') {
      const messaging = body.entry?.[0]?.messaging?.[0];
      if (!messaging?.message?.text) return;
      canal = 'instagram';
      idExterno = messaging.sender.id;
      mensajeUsuario = messaging.message.text;
      // Instagram no da número de teléfono directamente — usamos su PSID como identificador
      numeroOrigen = `ig_${idExterno}`;
      nombreCliente = await obtenerNombreFacebook(idExterno, process.env.INSTAGRAM_PAGE_TOKEN || process.env.WHATSAPP_TOKEN) || 'IG — Orgánico';

    } else if (object === 'page') {
      const messaging = body.entry?.[0]?.messaging?.[0];
      if (!messaging?.message?.text) return;
      canal = 'messenger';
      idExterno = messaging.sender.id;
      mensajeUsuario = messaging.message.text;
      numeroOrigen = `fb_${idExterno}`;
      nombreCliente = await obtenerNombreFacebook(idExterno, process.env.MESSENGER_PAGE_TOKEN || process.env.WHATSAPP_TOKEN) || 'FB — Orgánico';

    } else {
      return; // evento desconocido
    }

    console.log(`📩 [${canal.toUpperCase()}] de ${nombreCliente || numeroOrigen}: ${mensajeUsuario}`);

    // ── GUARDAR LOG INMEDIATO — antes de cualquier procesamiento ────────────
    const phoneIdRecibido = body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
    const tenant = await Tenant.findOne({ whatsapp_phone_id: phoneIdRecibido, activo: true })
                || await Tenant.findOne({ activo: true });
    if (!tenant) return;

    const logEntry = await MessageLog.create({
      tenant_id: tenant._id,
      from: numeroOrigen,
      message: mensajeUsuario,
      canal,
      procesado: false, // se marca true al final si todo salió bien
      fecha: new Date()
    }).catch(() => null);

    // ── TENANT ya declarado arriba ───────────────────────────────────────────
    const limite_info = await verificarLimite(tenant._id, tenant.plan);
    if (limite_info.agotado) return;
    await notificarAdminSiNecesario(tenant, limite_info);

    // ── DEDUPLICACIÓN — buscar si ya existe el contacto por número/id ───────
    // Si el padre escribió por WhatsApp antes y ahora escribe por Instagram,
    // puede que tengamos su teléfono en el Contacto de WhatsApp.
    // La deduplicación busca primero por el idExterno exacto, luego por correo si lo tenemos.
    let contactoExistente = await Contacto.findOne({ tenant_id: tenant._id, numero: numeroOrigen });

    // Registrar el canal de origen si es nuevo
    if (contactoExistente && !contactoExistente.canal_origen) {
      contactoExistente.canal_origen = canal;
      await contactoExistente.save();
    }

    // Actualizar nombre si lo recibimos y no lo teníamos
    if (contactoExistente && nombreCliente && !contactoExistente.nombre) {
      contactoExistente.nombre = nombreCliente;
      await contactoExistente.save();
    }

    // ── FUNCIÓN DE RESPUESTA POR CANAL ──────────────────────────────────────
    // ── CANALES EN MODO LECTURA PARA KAI (el bot NO auto-responde ni crea lead en Odoo) ──
    // Instagram y Messenger: el mensaje SÍ aparece en "Chats en Vivo" para que un agente
    // humano lo atienda manualmente (y sí se le puede responder — ver /api/conversaciones/:id/responder).
    // KAI simplemente no interviene en estos canales todavía, mientras se observa qué piden.
    // Para que KAI empiece a responder solo aquí también, quitar el canal de este array.
    const CANALES_SOLO_LECTURA = ['instagram', 'messenger'];

    const enviarRespuesta = async (numero, texto) => {
      if (CANALES_SOLO_LECTURA.includes(canal)) return;
      if (canal === 'whatsapp') await enviarWhatsAppMeta(numero, texto);
      else if (canal === 'instagram') await enviarMensajeInstagram(idExterno, texto);
      else if (canal === 'messenger') await enviarMensajeMessenger(idExterno, texto);
    };

    // ── PROCESAR CON KAI ────────────────────────────────────────────────────
    await procesarMensajeOmnichannel(numeroOrigen, nombreCliente, mensajeUsuario, canal, tenant);

    // Canales en solo lectura: solo guardar en MongoDB y mostrar en panel — sin Odoo, sin respuesta
    if (CANALES_SOLO_LECTURA.includes(canal)) {
      // Guardar/actualizar contacto en MongoDB (sin tocar Odoo)
      await Contacto.findOneAndUpdate(
        { tenant_id: tenant._id, numero: numeroOrigen },
        {
          $set: { canal_origen: canal, ultimo_contacto: new Date(), nombre: nombreCliente || undefined },
          $inc: { total_conversaciones: 1 },
          $setOnInsert: { primer_contacto: new Date() }
        },
        { upsert: true, new: true }
      ).catch(()=>{});

      // Crear o actualizar conversación en panel para que aparezca en Chats en Vivo
      let conv = await Conversacion.findOne({ tenant_id: tenant._id, numero: numeroOrigen, estado: { $ne: 'cerrado' } });
      if (!conv) {
        conv = await Conversacion.create({
          tenant_id: tenant._id,
          numero: numeroOrigen,
          canal: canal,
          estado: 'esperando_agente',
          mensajes: [{ de: 'padre', texto: mensajeUsuario, fecha: new Date() }],
          ultimaActividad: new Date()
        });
      } else {
        conv.mensajes.push({ de: 'padre', texto: mensajeUsuario, fecha: new Date() });
        conv.ultimaActividad = new Date();
        await conv.save();
      }

      if (logEntry) {
        logEntry.procesado = true;
        logEntry.response = '[modo lectura — visible en panel]';
        await logEntry.save().catch(()=>{});
      }
      console.log(`👁️  [${canal.toUpperCase()}] Mensaje en panel — ${nombreCliente || numeroOrigen}: ${mensajeUsuario}`);
      return;
    }

    const respuesta = await responderConIA(tenant, mensajeUsuario, numeroOrigen);

    // ── GUARDAR EL CHAT AUNQUE KAI LO ESTÉ ATENDIENDO SOLO ──────────────────
    // Antes solo se guardaba cuando había traspaso a un humano; los chats que KAI
    // atendía completos vivían únicamente en memoria y desaparecían — por eso no se
    // veían en el panel ni se podía supervisar qué les había contestado.
    // Se guardan con estado 'bot' para poder mostrarlos/ocultarlos aparte y no
    // revolverlos con la bandeja de atención humana de las vendedoras.
    try {
      let convBot = await Conversacion.findOne({ tenant_id: tenant._id, numero: numeroOrigen, estado: { $ne: 'cerrado' } });
      if (!convBot) {
        convBot = await Conversacion.create({
          tenant_id: tenant._id,
          numero: numeroOrigen,
          nombre: nombreCliente || null,
          canal: canal,
          estado: 'bot',
          mensajes: [{ de: 'padre', texto: mensajeUsuario, fecha: new Date() }],
          ultimaActividad: new Date()
        });
      } else {
        // Si hubo traspaso a humano, esa ruta YA guardó estos mismos mensajes —
        // aquí solo agregamos lo que falte, para no duplicar nada en el historial.
        const ultimoPadre = [...convBot.mensajes].reverse().find(m => m.de === 'padre');
        if (!ultimoPadre || ultimoPadre.texto !== mensajeUsuario) {
          convBot.mensajes.push({ de: 'padre', texto: mensajeUsuario, fecha: new Date() });
        }
        if (!convBot.nombre && nombreCliente) convBot.nombre = nombreCliente;
        convBot.ultimaActividad = new Date();
      }
      if (respuesta) {
        const ultimoBot = [...convBot.mensajes].reverse().find(m => m.de === 'bot');
        if (!ultimoBot || ultimoBot.texto !== respuesta) {
          convBot.mensajes.push({ de: 'bot', texto: respuesta, fecha: new Date() });
          convBot.ultimaActividad = new Date();
        }
      }
      await convBot.save();
    } catch (e) {
      console.error('❌ No se pudo guardar el chat de KAI en el panel:', e.message);
    }

    if (respuesta === null) {
      console.log(`⏸️  KAI pausado para ${numeroOrigen} — agente humano activo`);
      return;
    }

    if (logEntry) {
      logEntry.response = respuesta;
      logEntry.procesado = true;
      await logEntry.save().catch(()=>{});
    }

    if (respuesta) {
      // Si viene vacío, es porque responderConIA ya mandó una imagen directa y no hay
      // ningún texto que enviar para este turno (ver el corte temprano dentro de la función).
      await enviarRespuesta(numeroOrigen, respuesta);
      console.log(`✅ [${canal.toUpperCase()}] Respuesta enviada a ${numeroOrigen}`);
    } else {
      console.log(`🖼️ [${canal.toUpperCase()}] Se envió solo imagen (sin texto) a ${numeroOrigen}`);
    }

  } catch (err) {
    console.error('❌ WEBHOOK error:', err);
    // Si teníamos un logEntry pendiente, marcarlo con el error para que no se pierda el rastro
    if (typeof logEntry !== 'undefined' && logEntry) {
      logEntry.procesado = false;
      logEntry.error = err.message;
      await logEntry.save().catch(()=>{});
    }
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
      await procesarMensajeWhatsApp(telefonoFinal, 'Visitante Web', ultimoMensaje, 1, 'KAI Web').catch(() => {});
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
      { id: user._id, email: user.email, nombre: user.nombre, tenant_id: user.tenant_id, role, sedes: user.sedes || [] },
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
    const { nombre, role, sedes, activo, password, odoo_user_id } = req.body;
    const update = { nombre, role, sedes: sedes || [], activo };
    if (password) update.password = await bcrypt.hash(password, 10);
    if (odoo_user_id !== undefined) update.odoo_user_id = odoo_user_id ? parseInt(odoo_user_id) : null;
    await UsuarioPanel.findOneAndUpdate({ _id: req.params.id, tenant_id: req.user.tenant_id }, update);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Cambiar mi propia contraseña (cualquier usuario logueado, sin necesitar ser admin)
app.post('/api/mi-cuenta/cambiar-password', authMiddleware, async (req, res) => {
  try {
    const { passwordActual, passwordNueva } = req.body;
    if (!passwordActual || !passwordNueva) return res.status(400).json({ ok: false, error: 'Contraseña actual y nueva requeridas' });
    if (passwordNueva.length < 6) return res.status(400).json({ ok: false, error: 'La nueva contraseña debe tener al menos 6 caracteres' });

    const user = await UsuarioPanel.findById(req.user.id);
    if (!user) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });

    const valid = await bcrypt.compare(passwordActual, user.password);
    if (!valid) return res.status(401).json({ ok: false, error: 'Contraseña actual incorrecta' });

    user.password = await bcrypt.hash(passwordNueva, 10);
    await user.save();
    res.json({ ok: true, mensaje: 'Contraseña actualizada correctamente' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Admin resetea la contraseña de cualquier usuario de su tenant (para cuando un usuario olvida su clave)
app.post('/api/usuarios/:id/resetear-password', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Solo administradores pueden resetear contraseñas' });
    const { passwordNueva } = req.body;
    if (!passwordNueva || passwordNueva.length < 6) return res.status(400).json({ ok: false, error: 'La nueva contraseña debe tener al menos 6 caracteres' });

    const user = await UsuarioPanel.findOneAndUpdate(
      { _id: req.params.id, tenant_id: req.user.tenant_id },
      { password: await bcrypt.hash(passwordNueva, 10) },
      { new: true }
    );
    if (!user) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    res.json({ ok: true, mensaje: `Contraseña de ${user.nombre} reseteada correctamente` });
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
const ODOO_URL  = process.env.ODOO_URL  || 'alba.capouilliez.edu.gt';
const ODOO_DB   = process.env.ODOO_DB   || '';
const ODOO_USER_ODOO = process.env.ODOO_USER || 'admin';
const ODOO_PASS_ODOO = process.env.ODOO_PASSWORD || '';
let odooUID = null;

function odooRPC(path, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'call', id: Math.floor(Math.random() * 99999), params });
    const options = { hostname: ODOO_URL, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { const p = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (p.error) reject(new Error(JSON.stringify(p.error))); else resolve(p.result); } catch(e) { reject(e); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

async function getOdooUID() {
  if (odooUID) return odooUID;
  const uid = await odooRPC('/jsonrpc', { service: 'common', method: 'authenticate', args: [ODOO_DB, ODOO_USER_ODOO, ODOO_PASS_ODOO, {}] });
  if (!uid) throw new Error('Odoo auth fallida — revisa ODOO_DB, ODOO_USER y ODOO_PASSWORD en Railway');
  odooUID = uid; // solo cachear si fue exitoso
  return odooUID;
}

async function odooCallLocal(model, method, args, kwargs = {}) {
  const uid = await getOdooUID();
  return odooRPC('/jsonrpc', { service: 'object', method: 'execute_kw', args: [ODOO_DB, uid, ODOO_PASS_ODOO, model, method, args, kwargs] });
}

// ===== Sesión WEB de Odoo (distinta de la API/XML-RPC de arriba) =====
// Subir una imagen NUEVA al ChatRoom no se puede hacer por /jsonrpc — es un controlador
// web protegido con cookie de sesión + token CSRF (confirmado viendo la petición real
// del navegador: POST /web/binary/upload_attachment_chat).
let odooWebSession = null; // { cookie, csrfToken, expiraEn }

function odooWebRequest(path, method, headers, bodyBuffer) {
  return new Promise((resolve, reject) => {
    const options = { hostname: ODOO_URL, path, method, headers };
    const req = https.request(options, (resp) => {
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => resolve({ statusCode: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

async function obtenerSesionWebOdoo() {
  if (odooWebSession && odooWebSession.expiraEn > Date.now()) return odooWebSession;

  // 1. Autenticar por la ruta web (no /jsonrpc) para conseguir la cookie de sesión
  const bodyAuth = JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { db: ODOO_DB, login: ODOO_USER_ODOO, password: ODOO_PASS_ODOO } });
  const respAuth = await odooWebRequest('/web/session/authenticate', 'POST', { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyAuth) }, bodyAuth);
  const setCookie = respAuth.headers['set-cookie'];
  if (!setCookie) throw new Error('No se pudo iniciar sesión web en Odoo (sin cookie de sesión) — revisar usuario/contraseña');
  const cookie = setCookie.map(c => c.split(';')[0]).join('; ');

  // 2. Cargar una página autenticada para extraer el token CSRF embebido
  const respPagina = await odooWebRequest('/web', 'GET', { Cookie: cookie }, null);
  const html = respPagina.body.toString('utf8');
  const match = html.match(/csrf_token:\s*["']([^"']+)["']/i);
  const csrfToken = match ? match[1] : null;
  if (!csrfToken) throw new Error('No se pudo extraer el token CSRF de la sesión web de Odoo');

  odooWebSession = { cookie, csrfToken, expiraEn: Date.now() + 20 * 60 * 1000 }; // margen de 20 min
  return odooWebSession;
}

// Sube una imagen nueva (base64) al ChatRoom de AcruxLab y devuelve el ir.attachment creado.
// Mismos campos que la petición real capturada del navegador (conversation_id, connector_type, etc).
async function subirImagenNuevaAcrux(imagenBase64, filename, mimetype, conversationId) {
  const sesion = await obtenerSesionWebOdoo();
  const buffer = Buffer.from(imagenBase64, 'base64');
  const boundary = '----KaiAcruxBoundary' + Date.now();
  const campo = (nombre, valor) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${nombre}"\r\n\r\n${valor}\r\n`);
  const partes = [
    campo('csrf_token', sesion.csrfToken),
    campo('conversation_id', conversationId),
    campo('connector_type', 'apichat.io'),
    campo('is_pending', 'false'),
    campo('temporary_id', 'kai-' + Date.now()),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="ufile"; filename="${filename}"\r\nContent-Type: ${mimetype}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ];
  const body = Buffer.concat(partes);

  const resp = await odooWebRequest('/web/binary/upload_attachment_chat', 'POST', {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': body.length,
    'Cookie': sesion.cookie
  }, body);

  let parsed;
  try { parsed = JSON.parse(resp.body.toString('utf8')); } catch (e) {
    throw new Error('Respuesta no válida al subir la imagen (¿sesión/CSRF vencidos?): ' + resp.body.toString('utf8').substring(0, 300));
  }
  if (!parsed.id) throw new Error('La subida no devolvió un ID de adjunto: ' + JSON.stringify(parsed).substring(0, 300));
  return parsed; // { id, filename, mimetype, size, ... }
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
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => { const texto = Buffer.concat(chunks).toString('utf8'); try { resolve(JSON.parse(texto)); } catch(e) { resolve({ raw: texto }); } });
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
app.get('/api/odoo/test', authMiddleware, async (req, res) => {
  try {
    const info = await testConexion();
    if (!info) return res.status(500).json({ ok: false, error: 'No se pudo conectar a Odoo' });
    res.json({ ok: true, version: info.server_version, serie: info.server_serie });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Leer TODOS los campos de un lead específico por ID
// Leer mensajes del chatter de un lead y parsear datos del padre
app.get('/api/odoo/leer-mensajes/:id', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    // Leer los mensajes del lead
    const mensajes = await odooCallLocal('mail.message', 'search_read',
      [[['res_id', '=', id], ['model', '=', 'crm.lead'], ['message_type', 'in', ['email', 'comment']]]],
      { fields: ['body', 'date', 'author_id', 'message_type'], limit: 10, order: 'date asc' }
    ) || [];

    // Parsear el cuerpo HTML para extraer datos del formulario
    const datosParseados = {};
    let esAdmisiones = false;
    const TEMAS_ADMISIONES = ['admisiones','inscripcion','inscripción','colegio','primaria','preprimaria','secundaria','bachillerato','kinder','jardin','jardín','cuota','matricula'];

    for (const msg of mensajes) {
      const body = (msg.body || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      const bodyLower = body.toLowerCase();

      // Detectar si es sobre admisiones
      if (TEMAS_ADMISIONES.some(t => bodyLower.includes(t))) esAdmisiones = true;

      // Buscar patrones
      // Parser — el texto viene como "Nombre Carlos Escobar Correo email Teléfono 12345 Tema X Mensaje Y"
      // Separamos por palabras clave conocidas
      const KEYS = ['nombre','correo','n\u00famero de telefono','n\u00famero de tel\u00e9fono','telefono','tel\u00e9fono','celular','tema','asunto','mensaje','nivel','grado','lead'];
      const keysRegex = new RegExp('(' + KEYS.join('|') + ')\\s+', 'gi');
      const partes = body.replace(keysRegex, '|||$1|||').split('|||').filter(Boolean);
      
      for (let i = 0; i < partes.length; i++) {
        const llave = partes[i].trim().toLowerCase();
        const valor = (partes[i+1]||'').trim();
        if (!valor) continue;
        
        if (llave === 'nombre' && !datosParseados.nombre) {
          datosParseados.nombre = valor.replace(/[|]+.*/,'').trim();
          i++;
        } else if ((llave === 'correo' || llave === 'email') && !datosParseados.correo) {
          const em = valor.match(/[\w\.\-]+@[\w\.\-]+\.\w+/);
          if (em && !em[0].includes('capouilliez')) { datosParseados.correo = em[0]; i++; }
        } else if (llave.includes('tel') || llave.includes('n\u00famero') || llave === 'celular') {
          if (!datosParseados.telefono) {
            const num = valor.replace(/\D/g,'');
            if (num.length >= 8) { datosParseados.telefono = num.length === 8 ? '502'+num : num; i++; }
          }
        } else if ((llave === 'tema' || llave === 'asunto') && !datosParseados.tema) {
          datosParseados.tema = valor.replace(/[|]+.*/,'').trim(); i++;
        } else if (llave === 'mensaje' && !datosParseados.mensaje) {
          datosParseados.mensaje = valor.replace(/[|]+.*/,'').trim().substring(0,200); i++;
        } else if ((llave === 'nivel' || llave === 'grado') && !datosParseados.nivel) {
          // Limpiar basura — tomar solo la primera palabra/frase antes de signos de pregunta o undefined
          const nivelLimpio = valor.replace(/[|]+.*/,'').replace(/\s*¿.*$/,'').replace(/undefined/gi,'').trim();
          if (nivelLimpio) { datosParseados.nivel = nivelLimpio; i++; }
        }
      }

      // Fallbacks con regex
      if (!datosParseados.correo) {
        const em = body.match(/[\w\.\-]+@[\w\.\-]+\.\w+/);
        if (em && !em[0].includes('capouilliez')) datosParseados.correo = em[0];
      }
      if (!datosParseados.telefono) {
        const t = body.match(/\b([2345]\d{7})\b/);
        if (t) datosParseados.telefono = '502' + t[1];
      }
    }

    res.json({
      ok: true,
      lead_id: id,
      es_admisiones: esAdmisiones,
      mensajes: mensajes.map(m => ({
        fecha: m.date,
        autor: m.author_id?.[1],
        cuerpo: (m.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g,' ').trim().substring(0, 500)
      })),
      datos_parseados: datosParseados
    });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Actualizar lead en Odoo con datos parseados del formulario
// Traduce lo que llegue como "nivel" (español, variantes) al ID real del registro en
// el modelo capouilliez.carrer — el campo visible en pantalla es capo_level_of_interests
// (many2many, plural), NO capo_level_of_interest (singular, que está comentado/oculto
// en la vista y por eso nunca se veía aunque la escritura "funcionara").
// IDs confirmados en Odoo: 1=Preprimaria, 2=Primaria, 3=Básico, 4=Bachillerato en
// Ciencias y Letras, 13=Diversificado. (Se ignoran los duplicados/typos: 5 y 14).
const CARRERA_IDS = {
  PREPRIMARIA: 1,
  PRIMARIA: 2,
  BASICO: 3,
  BACHILLERATO: 4,
  DIVERSIFICADO: 13
};

function normalizarNivelOdoo(valor) {
  const v = String(valor || '').toLowerCase().trim();
  if (/pre.?primaria|preprimaria|kinder|inicial|infantil|maternal|p[aá]rvulos/.test(v)) {
    return { ids: [CARRERA_IDS.PREPRIMARIA], aproximado: false };
  }
  if (/primaria/.test(v)) {
    return { ids: [CARRERA_IDS.PRIMARIA], aproximado: false };
  }
  if (/b[aá]sico/.test(v)) {
    return { ids: [CARRERA_IDS.BASICO], aproximado: false };
  }
  if (/bachillerato/.test(v)) {
    return { ids: [CARRERA_IDS.BACHILLERATO], aproximado: false };
  }
  if (/diversificado/.test(v)) {
    return { ids: [CARRERA_IDS.DIVERSIFICADO], aproximado: false };
  }
  if (/secundaria/.test(v)) {
    // "Secundaria" genérico no distingue Básico/Bachillerato/Diversificado en este
    // colegio — usamos Básico como el más cercano, pero avisamos que es aproximado.
    return { ids: [CARRERA_IDS.BASICO], aproximado: true };
  }
  return null;
}

app.post('/api/odoo/actualizar-lead', authMiddleware, async (req, res) => {
  try {
    const { lead_id, nombre, telefono, correo, nivel, zona } = req.body;
    if (!lead_id) return res.status(400).json({ ok: false, error: 'lead_id requerido' });

    const updates = {};
    if (nombre) updates.contact_name = nombre; // corregido: antes iba a partner_name (Nombre de compañía), no al "Nombre del contacto"
    if (telefono) updates.phone = telefono;
    if (correo) updates.email_from = correo;
    if (zona) updates.x_studio_notas_1 = zona;

    let nivelNoReconocido = null;
    let nivelAproximado = false;
    if (nivel) {
      const resultado = normalizarNivelOdoo(nivel);
      if (resultado) {
        updates.capo_level_of_interests = [[6, 0, resultado.ids]]; // comando many2many: reemplaza con estos IDs
        nivelAproximado = resultado.aproximado;
      } else {
        nivelNoReconocido = nivel; // se avisa en la respuesta, no se escribe para no mandar un valor inválido
      }
    }

    await odooCallLocal('crm.lead', 'write', [[lead_id], updates]);
    await odooCallLocal('crm.lead', 'message_post', [[lead_id]], {
      body: `📋 Datos actualizados desde el panel KAI: ${Object.entries(updates).filter(([k])=>k!=='capo_level_of_interests').map(([k,v])=>`${k}: ${v}`).join(', ')}${updates.capo_level_of_interests ? `, Nivel: ${nivel}` : ''}`
    }).catch(()=>{});

    res.json({
      ok: true,
      mensaje: 'Lead actualizado en Odoo correctamente',
      aviso_nivel: nivelNoReconocido
        ? `El valor de Nivel "${nivelNoReconocido}" no se reconoció (se esperaba algo como Preprimaria/Primaria/Básico/Bachillerato/Diversificado) — no se escribió para evitar un dato inválido.`
        : (nivelAproximado ? `El valor "${nivel}" se guardó como "Básico" por aproximación — este colegio distingue Básico/Bachillerato/Diversificado dentro de Secundaria. Revisar si corresponde.` : null)
    });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/odoo/leads/:id/detalle', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'ID requerido' });

    // Primero obtener los campos disponibles en el modelo
    const campos = await odooCallLocal('crm.lead', 'fields_get', [], { attributes: ['string', 'type'] });

    // Leer el lead con todos sus campos
    const leads = await odooCallLocal('crm.lead', 'read', [[id]], {});

    if (!leads || !leads.length) return res.status(404).json({ ok: false, error: 'Lead no encontrado' });

    const lead = leads[0];

    // Filtrar campos vacíos para no saturar la respuesta
    const datosFiltrados = {};
    for (const [campo, valor] of Object.entries(lead)) {
      if (valor !== false && valor !== null && valor !== '' && valor !== undefined) {
        datosFiltrados[campo] = {
          valor,
          etiqueta: campos[campo]?.string || campo,
          tipo: campos[campo]?.type || 'unknown'
        };
      }
    }

    res.json({ ok: true, id, total_campos: Object.keys(datosFiltrados).length, datos: datosFiltrados });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
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

// ===== IMÁGENES DE MARKETING — gestión y envío =====

// Subir una imagen nueva (base64 enviado desde el panel)
// Carga masiva de imágenes — solo admin — recibe array de imágenes
// Eliminar TODAS las imágenes (activas e inactivas) y recargar el seed
app.post('/api/imagenes/reset', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
    const eliminadas = await ImagenMarketing.deleteMany({ tenant_id: req.user.tenant_id });
    // Recargar seed inmediatamente
    await seedImagenes();
    const total = await ImagenMarketing.countDocuments({ tenant_id: req.user.tenant_id, activo: true });
    res.json({ ok: true, eliminadas: eliminadas.deletedCount, recargadas: total });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/imagenes/bulk', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Solo admin' });
    const { imagenes } = req.body;
    if (!Array.isArray(imagenes) || !imagenes.length) return res.status(400).json({ ok: false, error: 'Array de imágenes requerido' });

    const resultados = [];
    for (const img of imagenes) {
      // Verificar si ya existe una imagen con ese nombre para no duplicar
      const existe = await ImagenMarketing.findOne({ tenant_id: req.user.tenant_id, nombre: img.nombre });
      if (existe) { resultados.push({ nombre: img.nombre, status: 'ya existe' }); continue; }
      await ImagenMarketing.create({
        tenant_id: req.user.tenant_id,
        nombre: img.nombre,
        categoria: img.categoria || 'general',
        nivel_educativo: img.nivel_educativo || 'Todos',
        imagen_base64: img.imagen_base64,
        mime_type: img.mime_type || 'image/jpeg',
        subida_por_nombre: 'Admin — carga masiva'
      });
      resultados.push({ nombre: img.nombre, status: 'creada' });
    }
    const creadas = resultados.filter(r => r.status === 'creada').length;
    res.json({ ok: true, mensaje: `${creadas} imágenes subidas, ${resultados.length - creadas} ya existían`, resultados });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/imagenes', authMiddleware, async (req, res) => {
  try {
    if (!['admin', 'vendedor'].includes(req.user.role)) return res.status(403).json({ ok: false, error: 'Sin permisos' });
    const { nombre, categoria, nivel_educativo, imagen_base64, mime_type, prioridad } = req.body;
    if (!nombre || !imagen_base64) return res.status(400).json({ ok: false, error: 'Nombre e imagen son requeridos' });

    const img = await ImagenMarketing.create({
      tenant_id: req.user.tenant_id,
      nombre, categoria: categoria || 'general', nivel_educativo: nivel_educativo || 'Todos',
      imagen_base64, mime_type: mime_type || 'image/jpeg', prioridad: parseInt(prioridad) || 0,
      subida_por: req.user.id, subida_por_nombre: req.user.nombre || req.user.email
    });
    res.json({ ok: true, imagen: { _id: img._id, nombre: img.nombre, categoria: img.categoria, nivel_educativo: img.nivel_educativo, prioridad: img.prioridad } });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Listar imágenes (sin el base64 completo, para que la lista cargue rápido)
// Editar una imagen ya subida (por ejemplo, ajustar su prioridad de envío)
app.put('/api/imagenes/:id', authMiddleware, async (req, res) => {
  try {
    if (!['admin', 'vendedor'].includes(req.user.role)) return res.status(403).json({ ok: false, error: 'Sin permisos' });
    const { nombre, categoria, nivel_educativo, prioridad, caption } = req.body;
    const update = {};
    if (nombre !== undefined) update.nombre = nombre;
    if (categoria !== undefined) update.categoria = categoria;
    if (nivel_educativo !== undefined) update.nivel_educativo = nivel_educativo;
    if (prioridad !== undefined) update.prioridad = parseInt(prioridad) || 0;
    if (caption !== undefined) update.caption = caption;
    const img = await ImagenMarketing.findOneAndUpdate({ _id: req.params.id, tenant_id: req.user.tenant_id }, update, { new: true });
    if (!img) return res.status(404).json({ ok: false, error: 'Imagen no encontrada' });
    res.json({ ok: true, imagen: { _id: img._id, nombre: img.nombre, categoria: img.categoria, nivel_educativo: img.nivel_educativo, prioridad: img.prioridad, caption: img.caption } });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/imagenes', authMiddleware, async (req, res) => {
  try {
    const { categoria, nivel_educativo } = req.query;
    const filtro = { tenant_id: req.user.tenant_id, activo: true };
    if (categoria) filtro.categoria = categoria;
    if (nivel_educativo) filtro.nivel_educativo = nivel_educativo;
    const imagenes = await ImagenMarketing.find(filtro).select('-imagen_base64').sort({ creado: -1 });
    res.json({ ok: true, imagenes });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Ver una imagen específica (con su base64, para previsualizar)
app.get('/api/imagenes/:id', authMiddleware, async (req, res) => {
  try {
    const img = await ImagenMarketing.findOne({ _id: req.params.id, tenant_id: req.user.tenant_id });
    if (!img) return res.status(404).json({ ok: false, error: 'No encontrada' });
    res.json({ ok: true, imagen: img });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Eliminar (desactivar) una imagen
app.delete('/api/imagenes/:id', authMiddleware, async (req, res) => {
  try {
    if (!['admin', 'vendedor'].includes(req.user.role)) return res.status(403).json({ ok: false, error: 'Sin permisos' });
    await ImagenMarketing.findOneAndUpdate({ _id: req.params.id, tenant_id: req.user.tenant_id }, { activo: false });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ===== ENVÍO DE PRUEBA — manda una imagen y/o texto a un número de prueba antes de la campaña real =====
app.post('/api/campana/prueba-numero', authMiddleware, async (req, res) => {
  try {
    const { numero_prueba, mensaje, imagen_id } = req.body;
    if (!numero_prueba) return res.status(400).json({ ok: false, error: 'Número de prueba requerido' });

    const resultados = {};

    if (mensaje) {
      const r = await enviarWhatsAppMeta(numero_prueba, mensaje);
      resultados.texto = r?.messages ? { ok: true, id: r.messages[0]?.id } : { ok: false, error: r?.error?.message || 'Error enviando texto' };
    }

    if (imagen_id) {
      const img = await ImagenMarketing.findOne({ _id: imagen_id, tenant_id: req.user.tenant_id });
      if (!img) {
        resultados.imagen = { ok: false, error: 'Imagen no encontrada' };
      } else {
        resultados.imagen = await enviarImagenDesdeDB(img, numero_prueba, mensaje && !resultados.texto ? mensaje : '');
      }
    }

    res.json({ ok: true, mensaje: 'Prueba enviada — revisa el WhatsApp del número de prueba', resultados });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ===== CAMPAÑA MASIVA REAL — envía a todos los contactos que cumplan los filtros =====
app.post('/api/campana/enviar', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Solo administradores pueden enviar campañas masivas' });

    const { mensaje, imagen_id, filtros, confirmar } = req.body;
    if (!mensaje && !imagen_id) return res.status(400).json({ ok: false, error: 'Se requiere mensaje o imagen' });
    if (!confirmar) return res.status(400).json({ ok: false, error: 'Debes confirmar el envío (confirmar:true) — esta acción no se puede deshacer' });

    // Construir el filtro de destinatarios — SIEMPRE exige consentimiento de marketing
    const filtroContactos = { tenant_id: req.user.tenant_id, acepta_marketing: true };
    if (filtros?.nivel_calor) filtroContactos.nivel_calor = filtros.nivel_calor;
    if (filtros?.segmento) filtroContactos.segmento_reactivacion = filtros.segmento;
    if (filtros?.zona) filtroContactos.zona = new RegExp(filtros.zona, 'i');
    if (filtros?.nivel_interes) filtroContactos.nivel_interes = new RegExp(filtros.nivel_interes, 'i');

    const destinatarios = await Contacto.find(filtroContactos).limit(1000);
    if (!destinatarios.length) return res.json({ ok: true, mensaje: 'No hay destinatarios que cumplan los filtros', total_enviados: 0 });

    let imagenDoc = null;
    if (imagen_id) {
      imagenDoc = await ImagenMarketing.findOne({ _id: imagen_id, tenant_id: req.user.tenant_id });
      if (!imagenDoc) return res.status(404).json({ ok: false, error: 'Imagen no encontrada' });
    }

    // Enviar en segundo plano para no bloquear la respuesta HTTP
    res.json({ ok: true, mensaje: `Campaña iniciada — enviando a ${destinatarios.length} contacto(s) en segundo plano`, total_destinatarios: destinatarios.length });

    (async () => {
      let exitosos = 0, fallidos = 0;
      const PAUSA_MS = 3000; // 3 segundos entre envíos — Meta recomienda no más de 20/min para evitar bloqueos
      const TOPE_DIARIO = 200; // nunca más de 200 mensajes por día en un mismo número

      // Verificar tope diario — contar cuántos enviamos hoy ya
      const hoyInicio = new Date(); hoyInicio.setHours(0,0,0,0);
      const enviadosHoy = await Contacto.countDocuments({
        tenant_id: req.user.tenant_id,
        ultima_campana_enviada: { $gte: hoyInicio }
      });
      const disponibles = Math.max(0, TOPE_DIARIO - enviadosHoy);
      if (disponibles === 0) {
        console.log(`⚠️ Tope diario de ${TOPE_DIARIO} mensajes alcanzado — campaña cancelada`);
        return;
      }
      const destinatariosLimitados = destinatarios.slice(0, disponibles);
      if (destinatariosLimitados.length < destinatarios.length) {
        console.log(`⚠️ Campaña limitada a ${disponibles} envíos (tope diario de ${TOPE_DIARIO})`);
      }

      for (const c of destinatariosLimitados) {
        // No enviar a contactos que llevan más de 60 días sin responder (segmento frío) — alto riesgo de bloqueo
        if (c.segmento_reactivacion === 'frio' && !filtros?.segmento) {
          console.log(`⏭️ Saltando ${c.numero} — segmento frío (60+ días sin actividad)`);
          continue;
        }
        try {
          if (imagenDoc) {
            await enviarImagenDesdeDB(imagenDoc, c.numero, mensaje || '');
          } else {
            await enviarWhatsAppMeta(c.numero, mensaje);
          }
          c.ultima_campana_enviada = new Date();
          c.campanas_recibidas = (c.campanas_recibidas || 0) + 1;
          await c.save();
          exitosos++;
        } catch (e) { fallidos++; console.error(`❌ Error enviando campaña a ${c.numero}:`, e.message); }
        await new Promise(r => setTimeout(r, PAUSA_MS)); // pausa entre envíos
      }
      console.log(`📣 Campaña finalizada — ${exitosos} exitosos, ${fallidos} fallidos de ${destinatariosLimitados.length} destinatarios`);
    })();

  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});



// Listar contactos con filtros: nivel de calor, segmento de reactivación, zona, nivel educativo, consentimiento
// ===== LEAD ADS — recibe notificación de Facebook cuando alguien llena un formulario de Lead Ad =====
app.post('/api/lead-ads', async (req, res) => {
  res.sendStatus(200);
  try {
    const { leadgen_id, page_id } = req.body.entry?.[0]?.changes?.[0]?.value || {};
    if (!leadgen_id) return;

    // Consultar los datos del formulario a la Graph API de Meta
    const TOKEN_PAGE = process.env.MESSENGER_PAGE_TOKEN || process.env.WHATSAPP_TOKEN;
    const leadData = await new Promise((resolve) => {
      const req2 = https.request({
        hostname: 'graph.facebook.com',
        path: `/v22.0/${leadgen_id}?access_token=${TOKEN_PAGE}`,
        method: 'GET'
      }, (r) => { const chunks=[]; r.on('data',c=>chunks.push(c)); r.on('end',()=>{ try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch(e){resolve(null)} }); });
      req2.on('error', ()=>resolve(null)); req2.end();
    });

    if (!leadData?.field_data) return;

    const campos = {};
    leadData.field_data.forEach(f => { campos[f.name] = f.values?.[0]; });
    const nombre = campos.full_name || campos.first_name || 'Sin nombre';
    const telefono = (campos.phone_number || '').replace(/\D/g,'');
    const correo = campos.email || null;
    const nivel = campos.grado_interes || campos.nivel || null;

    const tenant = await Tenant.findOne({ activo: true });
    if (!tenant) return;

    const numero = telefono ? `502${telefono.slice(-8)}` : `fb_lead_${leadgen_id}`;

    // ===== INTERRUPTOR MAESTRO: KAI PAUSADO EN PRODUCCIÓN =====
    if (KAI_PAUSADO_PARA_PRODUCCION && !esNumeroDePrueba(numero)) {
      console.log(`⏸️ [Lead Ads] KAI pausado en producción — no se procesa ${numero}`);
      return;
    }

    // Crear/actualizar contacto con canal lead_ads
    let contacto = await Contacto.findOne({ tenant_id: tenant._id, numero });
    if (!contacto) {
      contacto = await Contacto.create({
        tenant_id: tenant._id, numero,
        nombre, correo, nivel_interes: nivel,
        canal_origen: 'lead_ads',
        ultimo_contacto: new Date(), primer_contacto: new Date(), total_conversaciones: 1
      });
    }

    // Crear lead en Odoo directamente con los datos del formulario
    if (!contacto.odoo_lead_id) {
      // Verificar antes de crear: este papá pudo haber llenado otro formulario o
      // escrito por WhatsApp antes. Si ya está, se vincula en vez de duplicar.
      const yaExiste = await buscarLeadExistente({ telefono, correo });
      if (yaExiste) {
        contacto.odoo_lead_id = yaExiste.id;
        await contacto.save();
        await anotarOrigenEnLead(yaExiste.id, yaExiste.active === false, `📋 Volvió a escribir por <b>Lead Ads de Facebook</b>.`);
        await asignarVendedorSiFalta(tenant, yaExiste);
        console.log(`🔗 [Lead Ads] Lead existente vinculado — #${yaExiste.id}${yaExiste.active === false ? ' (reactivado)' : ''}`);
      } else {
        const tagId = await getOdooTagId('Canal — Lead Ads Facebook');
        const agenteNuevo = await asignarAgenteLibre(tenant._id); // nunca se deja sin vendedor explícito
        const leadId = await odooCallLocal('crm.lead', 'create', [{
          name: `Lead Ads — ${nombre}`,
          phone: telefono || null,
          email_from: correo || null,
          partner_name: nombre,
          description: `Formulario de Lead Ad completado.\nNivel de interés: ${nivel || 'No especificado'}\nCapturado automáticamente por KAI.`,
          team_id: tenant?.odoo_team_id || 1,
          type: 'lead', // entra como Lead, no directo como Oportunidad
          tag_ids: tagId ? [[6, 0, [tagId]]] : undefined,
          user_id: agenteNuevo?.odoo_user_id || false
        }]);
        if (leadId) { contacto.odoo_lead_id = leadId; await contacto.save(); }
      }
    }
    console.log(`✅ Lead Ads procesado — ${nombre} (${telefono})`);
  } catch (e) { console.error('❌ Lead Ads webhook:', e.message); }
});

// ===== FORMULARIO WEB — el webmaster agrega un fetch() al botón de envío del formulario =====
app.post('/api/lead-web', async (req, res) => {
  try {
    const { nombre, telefono, correo, nivel_interes, mensaje } = req.body;
    if (!nombre && !telefono && !correo) return res.status(400).json({ ok: false, error: 'Se requiere al menos nombre, teléfono o correo' });

    const tenant = await Tenant.findOne({ activo: true });
    if (!tenant) return res.status(500).json({ ok: false, error: 'Tenant no encontrado' });

    const numero = telefono ? `502${String(telefono).replace(/\D/g,'').slice(-8)}` : `web_${Date.now()}`;

    // ===== INTERRUPTOR MAESTRO: KAI PAUSADO EN PRODUCCIÓN =====
    if (KAI_PAUSADO_PARA_PRODUCCION && !esNumeroDePrueba(numero)) {
      console.log(`⏸️ [Formulario Web] KAI pausado en producción — no se procesa ${numero}`);
      return res.json({ ok: true, mensaje: 'Recibido (KAI en pausa temporal)' });
    }

    let contacto = await Contacto.findOne({ tenant_id: tenant._id, numero });
    if (!contacto) {
      contacto = await Contacto.create({
        tenant_id: tenant._id, numero,
        nombre: nombre || null, correo: correo || null,
        nivel_interes: nivel_interes || null,
        canal_origen: 'formulario',
        ultimo_contacto: new Date(), primer_contacto: new Date(), total_conversaciones: 1
      });
    }

    if (!contacto.odoo_lead_id) {
      // Verificar antes de crear — el mismo papá puede llenar el formulario varias veces
      // o ya haber escrito por otro canal.
      const yaExiste = await buscarLeadExistente({ telefono, correo });
      if (yaExiste) {
        contacto.odoo_lead_id = yaExiste.id;
        await contacto.save();
        await anotarOrigenEnLead(yaExiste.id, yaExiste.active === false, `📋 Volvió a escribir por el <b>formulario web</b>.${mensaje ? '<br>Mensaje: ' + mensaje : ''}`);
        await asignarVendedorSiFalta(tenant, yaExiste);
        console.log(`🔗 [Formulario web] Lead existente vinculado — #${yaExiste.id}${yaExiste.active === false ? ' (reactivado)' : ''}`);
      } else {
        const tagId = await getOdooTagId('Canal — Formulario Web');
        const agenteNuevo = await asignarAgenteLibre(tenant._id); // nunca se deja sin vendedor explícito
        const leadId = await odooCallLocal('crm.lead', 'create', [{
          name: `Formulario Web — ${nombre || correo || telefono}`,
          phone: telefono || null,
          email_from: correo || null,
          partner_name: nombre || null,
          description: `Formulario web completado.\n${mensaje ? 'Mensaje: ' + mensaje : ''}\nNivel de interés: ${nivel_interes || 'No especificado'}\nCapturado automáticamente por KAI.`,
          team_id: tenant?.odoo_team_id || 1,
          type: 'lead', // entra como Lead, no directo como Oportunidad
          tag_ids: tagId ? [[6, 0, [tagId]]] : undefined,
          user_id: agenteNuevo?.odoo_user_id || false
        }]);
        if (leadId) { contacto.odoo_lead_id = leadId; await contacto.save(); }
      }
    }

    res.json({ ok: true, mensaje: 'Contacto registrado correctamente' });
    console.log(`✅ Formulario web — ${nombre} (${telefono || correo})`);
  } catch (e) {
    console.error('❌ Lead web:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/contactos', authMiddleware, async (req, res) => {
  try {
    const { nivel_calor, segmento, zona, nivel_interes, solo_con_consentimiento } = req.query;
    const filtro = { tenant_id: req.user.tenant_id };
    if (nivel_calor) filtro.nivel_calor = parseInt(nivel_calor);
    if (segmento) filtro.segmento_reactivacion = segmento;
    if (zona) filtro.zona = new RegExp(zona, 'i');
    if (nivel_interes) filtro.nivel_interes = new RegExp(nivel_interes, 'i');
    if (solo_con_consentimiento === 'true') filtro.acepta_marketing = true;

    const contactos = await Contacto.find(filtro).sort({ ultimo_contacto: -1 }).limit(500);
    res.json({ ok: true, total: contactos.length, contactos });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Resumen agregado de segmentos — para mostrar tarjetas en el dashboard de Marketing
app.get('/api/contactos/resumen', authMiddleware, async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const [porSegmento, porNivelCalor, totalConsentimiento, totalContactos, porCanal] = await Promise.all([
      Contacto.aggregate([{ $match: { tenant_id: tenantId } }, { $group: { _id: '$segmento_reactivacion', total: { $sum: 1 } } }]),
      Contacto.aggregate([{ $match: { tenant_id: tenantId, nivel_calor: { $ne: null } } }, { $group: { _id: '$nivel_calor', total: { $sum: 1 } } }]),
      Contacto.countDocuments({ tenant_id: tenantId, acepta_marketing: true }),
      Contacto.countDocuments({ tenant_id: tenantId }),
      Contacto.aggregate([{ $match: { tenant_id: tenantId } }, { $group: { _id: '$canal_origen', total: { $sum: 1 } } }])
    ]);
    res.json({
      ok: true,
      total_contactos: totalContactos,
      con_consentimiento_marketing: totalConsentimiento,
      por_segmento: Object.fromEntries(porSegmento.map(s => [s._id || 'activo', s.total])),
      por_nivel_calor: Object.fromEntries(porNivelCalor.map(n => [n._id, n.total])),
      por_canal: Object.fromEntries(porCanal.map(c => [c._id || 'whatsapp', c.total]))
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Mensajes no procesados — para detectar si algo falló silenciosamente
// ===== LIMPIAR TAGS KAI DE ODOO — para corregir etiquetado incorrecto =====
app.post('/api/odoo/limpiar-tags-kai', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
    const { tag_id } = req.body;
    if (!tag_id) return res.status(400).json({ ok: false, error: 'tag_id requerido' });

    // Buscar todos los leads que tienen este tag
    const leads = await odooCallLocal('crm.lead', 'search_read',
      [[['tag_ids', 'in', [tag_id]]]],
      { fields: ['id', 'name', 'tag_ids'], limit: 1000 }
    ) || [];

    if (!leads.length) return res.json({ ok: true, mensaje: 'No hay leads con ese tag', total: 0 });

    // Quitar el tag de cada lead (comando 3 = remove)
    const ids = leads.map(l => l.id);
    await odooCallLocal('crm.lead', 'write', [ids, {
      tag_ids: [[3, tag_id]] // comando 3 = quitar este tag sin tocar los demás
    }]);

    res.json({ ok: true, mensaje: `Tag eliminado de ${ids.length} leads correctamente`, total: ids.length });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Contactar un lead específico con KAI por WhatsApp
app.post('/api/motor/contactar-lead', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
    const { lead_id, telefono } = req.body;
    if (!lead_id || !telefono) return res.status(400).json({ ok: false, error: 'lead_id y telefono requeridos' });

    const tenant = await Tenant.findOne({ _id: req.user.tenant_id });
    const tagContactadoId = await getOdooTagId(TAG_KAI_CONTACTADO);
    const tagSinWAId = await getOdooTagId(TAG_KAI_SIN_WHATSAPP);

    // Obtener datos del lead
    const leads = await odooCallLocal('crm.lead', 'read', [[lead_id]], {});
    if (!leads?.length) return res.status(404).json({ ok: false, error: 'Lead no encontrado' });
    const lead = leads[0];

    let telefonoLimpio = String(telefono).replace(/\D/g, '');
    if (telefonoLimpio.length === 8) telefonoLimpio = '502' + telefonoLimpio;

    const nombre = lead.partner_name || lead.contact_name || null;
    const primerNombre = nombre ? nombre.split(' ')[0] : null;
    const saludo = primerNombre ? `Hola ${primerNombre}` : 'Hola';
    const mensaje = `${saludo} 👋 Te escribimos del *Colegio Capouilliez*.\n\nRecibimos tu información y queremos ayudarte con el proceso de admisiones 🏫\n\n¿Para qué nivel educativo estás buscando información?\n\n1️⃣ Preprimaria (2-6 años)\n2️⃣ Primaria (7-12 años)\n3️⃣ Secundaria (13-16 años)`;

    const resultado = await enviarWhatsAppMeta(telefonoLimpio, mensaje);
    if (resultado?.messages?.length) {
      await odooCallLocal('crm.lead', 'write', [[lead_id], { tag_ids: [[4, tagContactadoId]] }]);
      await odooCallLocal('crm.lead', 'message_post', [[lead_id]], {
        body: `📱 KAI contactó por WhatsApp (${telefonoLimpio}) — iniciado manualmente desde el panel.`
      }).catch(() => {});

      // Crear contacto en MongoDB si no existe
      let contacto = await Contacto.findOne({ tenant_id: tenant._id, numero: telefonoLimpio });
      if (!contacto) {
        await Contacto.create({ tenant_id: tenant._id, numero: telefonoLimpio, nombre, odoo_lead_id: lead_id, canal_origen: 'lead_ads', ultimo_contacto: new Date(), primer_contacto: new Date() });
      }
      res.json({ ok: true, mensaje: `KAI contactó a ${nombre||telefonoLimpio} por WhatsApp` });
    } else {
      await odooCallLocal('crm.lead', 'write', [[lead_id], { tag_ids: [[4, tagSinWAId]] }]);
      res.json({ ok: false, error: 'No se pudo enviar el mensaje — número inválido o fuera de la ventana de 24h' });
    }
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Asignar un lead a un vendedor específico
app.post('/api/motor/asignar-vendedor', authMiddleware, async (req, res) => {
  try {
    const { lead_id, vendedor_id } = req.body;
    if (!lead_id || !vendedor_id) return res.status(400).json({ ok: false, error: 'lead_id y vendedor_id requeridos' });

    const vendedor = await UsuarioPanel.findOne({ _id: vendedor_id, tenant_id: req.user.tenant_id });
    if (!vendedor) return res.status(404).json({ ok: false, error: 'Vendedor no encontrado' });

    // Registrar nota en Odoo
    await odooCallLocal('crm.lead', 'message_post', [[lead_id]], {
      body: `👤 Lead asignado manualmente desde el panel KAI a ${vendedor.nombre || vendedor.email}.`
    }).catch(() => {});

    // Si el vendedor tiene odoo_user_id, asignarlo en Odoo también
    if (vendedor.odoo_user_id) {
      await odooCallLocal('crm.lead', 'write', [[lead_id], { user_id: vendedor.odoo_user_id }]).catch(() => {});
    }

    res.json({ ok: true, mensaje: `Lead asignado a ${vendedor.nombre || vendedor.email}` });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ===== ESCÁNER DE LEADS — ver qué hay en Odoo antes de contactar =====
app.get('/api/motor/escanear', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
    const tagContactadoId = await getOdooTagId(TAG_KAI_CONTACTADO);
    const tagSinWAId = await getOdooTagId(TAG_KAI_SIN_WHATSAPP);

    // Leads SIN ASIGNAR de los últimos 30 días que KAI todavía NO ha contactado.
    // Antes no se excluían los ya contactados y seguían apareciendo como "pendientes"
    // aunque ya se les hubiera escrito — daba la impresión de que no se había hecho nada.
    const hace30d = new Date(Date.now() - 30*24*60*60*1000).toISOString().replace('T',' ').substring(0,19);
    const pendientes = await odooCallLocal('crm.lead', 'search_read',
      [[
        ['active', '=', true],
        ['user_id', '=', false],
        ['create_date', '>=', hace30d],
        ['tag_ids', 'not in', [tagContactadoId, tagSinWAId]],
      ]],
      { fields: ['id','name','phone','mobile','partner_name','contact_name','email_from','stage_id','tag_ids','user_id','create_date','type','team_id','fb_form_id','x_studio_comentarios','x_studio_notas_1'], limit: 200 }
    ) || [];

    // Leads que KAI YA contactó — antes esta lista estaba siempre vacía y por eso
    // nunca se veían en el panel. Se cruzan con MongoDB para saber si el padre ya
    // contestó y en qué nivel de interés va.
    const contactadosOdoo = await odooCallLocal('crm.lead', 'search_read',
      [[['active', '=', true], ['tag_ids', 'in', [tagContactadoId]], ['create_date', '>=', hace30d]]],
      { fields: ['id', 'name', 'phone', 'mobile', 'partner_name', 'contact_name', 'email_from', 'create_date', 'user_id', 'x_studio_comentarios'], limit: 100, order: 'create_date desc' }
    ) || [];

    const contactados = await Promise.all(contactadosOdoo.map(async (l) => {
      const tel = (l.mobile && String(l.mobile) !== 'false') ? l.mobile : ((l.phone && String(l.phone) !== 'false') ? l.phone : null);
      const telLimpio = tel ? String(tel).replace(/\D/g, '') : null;
      const contactoMongo = telLimpio
        ? await Contacto.findOne({ tenant_id: req.user.tenant_id, numero: telLimpio })
            .select('nombre nivel_interes nivel_calor_etiqueta ultimo_contacto total_conversaciones')
        : null;

      // ¿Ya contestó? Si tiene más de una interacción registrada es que hubo diálogo.
      const yaRespondio = !!(contactoMongo && (contactoMongo.total_conversaciones || 0) > 0);

      return {
        id: l.id,
        nombre: l.partner_name || l.contact_name || l.name,
        telefono: tel,
        email: l.email_from || null,
        nivel: contactoMongo?.nivel_interes || l.x_studio_comentarios || null,
        vendedor: l.user_id?.[1] || null,
        contactado_el: l.create_date?.substring(0, 16),
        ya_respondio: yaRespondio,
        clasificacion: contactoMongo?.nivel_calor_etiqueta || (yaRespondio ? 'En conversación con KAI' : 'Esperando respuesta'),
        ultima_actividad: contactoMongo?.ultimo_contacto || null
      };
    }));

    // Leads sin WhatsApp válido
    const sinWA = await odooCallLocal('crm.lead', 'search_read',
      [[['type','=','opportunity'],['tag_ids','in',[tagSinWAId]]]],
      { fields: ['id','name','phone','partner_name'], limit: 50 }
    ) || [];

    // Detectar duplicados dentro de la propia lista (mismo teléfono o correo) — esto
    // pasa cuando el formulario de Admisiones llega dos veces por correo y Odoo crea
    // dos leads distintos para la misma persona. No los ocultamos ni los tocamos,
    // solo los marcamos para que el equipo sepa que hay que revisar antes de atender.
    const vistorTelefono = {};
    const vistoPorCorreo = {};
    const pendientesConDuplicado = pendientes.map(l => {
      const tel = (l.mobile && String(l.mobile) !== 'false') ? l.mobile : ((l.phone && String(l.phone) !== 'false') ? l.phone : null);
      const telLimpio = tel ? String(tel).replace(/\D/g, '').slice(-8) : null;
      const correo = (l.email_from || '').toLowerCase().trim() || null;
      let duplicadoDe = null;
      if (telLimpio && vistorTelefono[telLimpio]) duplicadoDe = vistorTelefono[telLimpio];
      else if (correo && vistoPorCorreo[correo]) duplicadoDe = vistoPorCorreo[correo];
      if (telLimpio && !vistorTelefono[telLimpio]) vistorTelefono[telLimpio] = l.id;
      if (correo && !vistoPorCorreo[correo]) vistoPorCorreo[correo] = l.id;
      return { l, tel, correo, duplicadoDe };
    });

    // Segunda pasada: el duplicado real puede estar FUERA de este lote — por ejemplo,
    // si el lead bueno ya tiene vendedor asignado, Odoo ya no lo muestra como "sin
    // asignar" y por eso nunca se compara contra él en el paso anterior. Aquí se usa
    // nuestro propio registro "Contacto" (Mongo) en vez de buscar directo en Odoo —
    // es la MISMA fuente que ya usa el motor cada 10 minutos para detectar este mismo
    // duplicado con éxito (se ve en su nota del chatter: "ya se le escribió, lead
    // #40298"), así que es más confiable que repetir una búsqueda distinta en Odoo.
    for (const item of pendientesConDuplicado) {
      if (item.duplicadoDe) continue; // ya se detectó dentro del lote, no hace falta más
      if (!item.tel) continue;
      try {
        const ultimos8 = String(item.tel).replace(/\D/g, '').slice(-8);
        if (ultimos8.length !== 8) continue;
        const contacto = await Contacto.findOne({
          tenant_id: req.user.tenant_id,
          numero: new RegExp(ultimos8 + '$'),
          odoo_lead_id: { $ne: null }
        });
        if (contacto?.odoo_lead_id && contacto.odoo_lead_id !== item.l.id) item.duplicadoDe = contacto.odoo_lead_id;
      } catch (e) { /* si falla para uno, no bloquea a los demás */ }
    }

    // Para cada pendiente CON teléfono, revisar si KAI ya le tiene vendedor asignado
    // internamente aunque Odoo diga "sin asignar" (esta vista filtra por user_id=false,
    // así que si KAI ya asignó pero no se sincronizó a Odoo, aquí se vería vacío y
    // parecería que nadie lo tiene — justo la sorpresa que no queremos repetir).
    const vendedorEnKaiPorLead = {};
    for (const { l } of pendientesConDuplicado) {
      const tel = (l.mobile && String(l.mobile) !== 'false') ? l.mobile : ((l.phone && String(l.phone) !== 'false') ? l.phone : null);
      if (!tel) continue;
      const telLimpio = String(tel).replace(/\D/g, '');
      try {
        const convsAcrux = await odooCallLocal('acrux.chat.conversation', 'search_read',
          [[['number', 'like', telLimpio.slice(-8)]]], { fields: ['id'], limit: 1 });
        if (convsAcrux && convsAcrux.length) {
          const asignAcrux = await AsignacionAcrux.findOne({ tenant_id: req.user.tenant_id, contacto_id: convsAcrux[0].id });
          if (asignAcrux?.agente_nombre) vendedorEnKaiPorLead[l.id] = asignAcrux.agente_nombre;
        }
      } catch (e) { /* si falla para uno, no bloquea a los demás */ }
    }

    res.json({
      ok: true,
      resumen: {
        pendientes_de_contactar: pendientes.length,
        contactados_por_kai: contactados.length,
        ya_respondieron: contactados.filter(c => c.ya_respondio).length,
  
        sin_whatsapp_valido: sinWA.length
      },
      // Los duplicados NO se muestran en "Pendientes" — no se les toca nada en Odoo (ni
      // etiqueta ni vendedor, eso lo decide el equipo a mano), simplemente se sacan de
      // esta lista para no generar trabajo repetido ni ruido visual. El que ya existía
      // (lead_principal) sigue su curso normal; el duplicado queda intacto en Odoo, solo
      // deja de aparecer aquí.
      pendientes: pendientesConDuplicado.filter(({ duplicadoDe }) => !duplicadoDe).map(({ l, duplicadoDe }) => ({
        id: l.id,
        nombre: l.name,
        contacto: l.partner_name || l.contact_name || null,
        vendedor_en_kai: vendedorEnKaiPorLead[l.id] || null,
        telefono: (l.mobile && String(l.mobile) !== 'false') ? l.mobile : ((l.phone && String(l.phone) !== 'false') ? l.phone : null),
        email: l.email_from || null,
        nivel: l.x_studio_comentarios || null,
        zona: l.x_studio_notas_1 || null,
        formulario: l.fb_form_id?.[1] || null,
        equipo: l.team_id?.[1] || null,
        tipo: l.type || null,
        fecha_creacion: l.create_date?.substring(0,16),
        posible_duplicado: !!duplicadoDe,
        duplicado_de_id: duplicadoDe
      })),
      contactados,
      sin_whatsapp: sinWA.map(l => ({ id: l.id, nombre: l.partner_name || l.name, telefono: l.phone }))
    });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ===== PRUEBA DEL MOTOR — enviar a UN número específico sin tocar leads reales =====
app.post('/api/motor/prueba', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
    const { telefono, nombre } = req.body;
    if (!telefono) return res.status(400).json({ ok: false, error: 'Teléfono requerido' });

    const telefonoLimpio = String(telefono).replace(/\D/g,'');
    const tel = telefonoLimpio.length === 8 ? '502' + telefonoLimpio : telefonoLimpio;
    const primerNombre = nombre ? nombre.split(' ')[0] : null;
    const saludo = primerNombre ? `Hola ${primerNombre}` : 'Hola';

    const mensaje = `${saludo} 👋 Te escribimos del *Colegio Capouilliez*.\n\nRecibimos tu información y queremos ayudarte con el proceso de admisiones 🏫\n\n¿Para qué nivel educativo estás buscando información?\n\n1️⃣ Preprimaria (2-6 años)\n2️⃣ Primaria (7-12 años)\n3️⃣ Secundaria (13-16 años)`;

    const resultado = await enviarWhatsAppMeta(tel, mensaje);

    if (resultado?.messages?.length) {
      res.json({ ok: true, mensaje: `✅ Mensaje enviado a ${tel}`, whatsapp_id: resultado.messages[0].id });
    } else {
      res.json({ ok: false, error: 'Meta no confirmó el envío', detalle: resultado });
    }
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ===== ACTIVAR MOTOR MANUALMENTE — sin esperar los 30 min =====
app.post('/api/motor/activar', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
    res.json({ ok: true, mensaje: 'Motor de contacto proactivo iniciado — revisa los logs de Railway' });
    motorContactoProactivo(); // corre en segundo plano
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Revisa las conversaciones que KAI atiende SOLO (sin vendedora, modo bot) y detecta
// cuáles quedaron A MEDIAS: el papá preguntó algo y nunca se le mandó. Usa la IA para
// leer el diálogo completo y decidir qué falta. Con ?enviar=1 manda lo que falta.
// GET /api/dashboard/kai-a-medias?dias=3
app.get('/api/dashboard/kai-a-medias', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const tenantId = req.user.tenant_id;
    const dias = Math.min(parseInt(req.query.dias) || 3, 14);
    const desde = new Date(Date.now() - dias * 24 * 3600 * 1000);
    const ejecutar = req.query.enviar === '1';

    // ===== FUENTE DE DATOS CORREGIDA =====
    // La conversación real vive en AcruxLab (Odoo), no en la colección local de Mongo
    // — esa solo se usa para el canal Meta antiguo, que ya no es donde llega el tráfico.
    // Se toman las conversaciones que KAI atiende SOLO: modo 'bot' en AsignacionAcrux
    // (o sin registro, que también cuenta como "de KAI").
    const asignsHumano = await AsignacionAcrux.find({ tenant_id: tenantId, modo: 'humano' }).select('contacto_id');
    const idsHumano = new Set(asignsHumano.map(a => a.contacto_id));

    const desdeStr = desde.toISOString().replace('T', ' ').substring(0, 19);
    const mensajesRecientes = await odooCallLocal('acrux.chat.message', 'search_read',
      [[['date_message', '>=', desdeStr]]],
      { fields: ['id', 'text', 'date_message', 'contact_id', 'from_me'], limit: 3000, order: 'date_message asc' }
    ) || [];

    const porContacto = {};
    mensajesRecientes.forEach(m => {
      if (!m.contact_id) return;
      const cid = m.contact_id[0];
      if (idsHumano.has(cid)) return; // esa es de una vendedora, no de KAI
      if (!porContacto[cid]) porContacto[cid] = { id: cid, nombre: m.contact_id[1], mensajes: [] };
      porContacto[cid].mensajes.push(m);
    });

    // Solo las que tienen conversación real (al menos 2 mensajes)
    const candidatas = Object.values(porContacto).filter(c => c.mensajes.length >= 2);
    if (!candidatas.length) {
      return res.json({ ok: true, total: 0, mensaje: 'No hay conversaciones de KAI (solo) en ese rango' });
    }

    // Números reales, para poder contactar después
    const idsConv = candidatas.map(c => c.id);
    const convsOdoo = await odooCallLocal('acrux.chat.conversation', 'read', [idsConv, ['id', 'number', 'name']]).catch(() => []) || [];
    const numeroPorId = {}; convsOdoo.forEach(c => { numeroPorId[c.id] = c.number; });

    const extractos = candidatas.slice(0, 30).map((c, i) => {
      const dialogo = c.mensajes.slice(-10).map(m => {
        const quien = m.from_me ? 'KAI' : 'PAPÁ';
        return `${quien}: ${String(m.text || '').substring(0, 200)}`;
      }).join('\n');
      return `--- Conversación ${i} (${c.nombre}) ---\n${dialogo}`;
    }).join('\n\n');

    const systemPrompt = `Eres un supervisor de admisiones del Colegio Capouilliez. Revisas conversaciones que el asistente KAI atendió SOLO (sin ninguna asesora), buscando charlas que quedaron A MEDIAS: el papá preguntó algo específico (cuotas, requisitos, horarios, proceso de admisión, edades, ubicación, papelería) y nunca se le respondió, o solo se le respondió parte de lo que pidió, o la respuesta de KAI se cortó a medio texto.

NO reportes conversaciones que:
- Terminaron con el papá agradeciendo o despidiéndose sin pedir nada más.
- El papá aún no ha hecho ninguna pregunta específica (solo saludó o dio información general sin pedir nada).
- Ya se le respondió completo, aunque la conversación siga abierta.

RESPONDE ÚNICAMENTE CON EL ARREGLO JSON. No escribas explicaciones, ni texto antes o después, ni marques con \`\`\`. La primera letra de tu respuesta debe ser "[" y la última "]".

Formato exacto:
[{"conversacion": 0, "que_pidio_y_no_recibio": "descripción de lo que falta", "temas_faltantes": ["cuotas","admision","info_general"], "nivel_mencionado": "Preprimaria|Primaria|Secundaria|null"}]

Los valores válidos para "temas_faltantes" son EXACTAMENTE estos (en minúscula): cuotas, admision, info_general, programas. Si una conversación está completa, no la incluyas. Si ninguna quedó a medias, responde exactamente: []`;

    const respuesta = await llamarClaude(systemPrompt, [{ role: 'user', content: extractos.substring(0, 14000) }], 3000);
    if (!respuesta) return res.json({ ok: false, error: 'La IA no respondió (revisar saldo de Anthropic)' });

    let hallazgos;
    try {
      // La IA a veces agrega explicación antes/después pese a la instrucción — se
      // extrae solo el tramo entre el primer '[' y el último ']', que es el JSON real.
      let limpio = respuesta.replace(/```json|```/g, '').trim();
      const inicio = limpio.indexOf('[');
      const fin = limpio.lastIndexOf(']');
      if (inicio === -1 || fin === -1 || fin < inicio) throw new Error('No se encontró un arreglo JSON en la respuesta');
      limpio = limpio.substring(inicio, fin + 1);
      hallazgos = JSON.parse(limpio);
    } catch (e) {
      return res.json({ ok: false, error: 'La IA devolvió un formato inesperado', respuesta_cruda: respuesta.substring(0, 1500) });
    }

    const resultado = [];
    for (const h of (hallazgos || [])) {
      const conv = candidatas[h.conversacion];
      if (!conv) continue;
      const numero = numeroPorId[conv.id];
      if (!numero) continue;

      const item = {
        nombre: conv.nombre || numero,
        numero,
        que_falta: h.que_pidio_y_no_recibio,
        temas: h.temas_faltantes || [],
        nivel: h.nivel_mencionado || null,
        enviado: false
      };

      if (ejecutar && item.temas.length) {
        // Buscar y mandar las imágenes de los temas que faltaron
        const enviadas = [];
        for (const tema of item.temas) {
          const filtro = { tenant_id: tenantId, activo: true, categoria: tema };
          if (item.nivel) filtro.nivel_educativo = { $in: [item.nivel, 'Todos'] };
          const img = await ImagenMarketing.findOne(filtro).sort({ prioridad: -1, creado: -1 });
          if (!img) continue;
          try {
            const textoDisculpa = enviadas.length === 0
              ? `Disculpa la demora en completar tu información 🙏\n\n${construirDescripcionImagen(img)}`
              : construirDescripcionImagen(img);
            await enviarTextoAcruxLab(conv.id, textoDisculpa);
            await new Promise(r => setTimeout(r, 1200));
            const adjunto = await subirImagenNuevaAcrux(img.imagen_base64, `${img.nombre}.jpg`, img.mime_type || 'image/jpeg', conv.id);
            await odooCallLocal('acrux.chat.conversation', 'send_message',
              [[conv.id], { text: construirDescripcionImagen(img), from_me: true, ttype: 'image', res_model: 'ir.attachment', res_id: adjunto.id, id: -2, date_message: new Date().toISOString().replace('T', ' ').substring(0, 19), button_ids: [] }],
              { context: { lang: 'es_GT', tz: 'America/Guatemala', is_acrux_chat_room: true } }
            );
            enviadas.push(img.nombre);
            await new Promise(r => setTimeout(r, 1800));
          } catch (e) {
            console.error(`❌ [Charlas a medias] Error enviando "${tema}" a ${numero}: ${e.message}`);
          }
        }
        item.enviado = enviadas.length > 0;
        item.imagenes_enviadas = enviadas;
      }

      resultado.push(item);
    }

    res.json({
      ok: true,
      modo: ejecutar ? 'EJECUTADO' : 'VISTA PREVIA — agrega ?enviar=1 para mandar lo que falta',
      conversaciones_revisadas: candidatas.length,
      a_medias_encontradas: resultado.length,
      detalle: resultado
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Diagnóstico: por qué KAI no bloqueó a un número que ya es Oportunidad de Sylvia.
// Muestra los datos crudos del lead en Odoo para ver si el criterio de "oportunidad"
// coincide con cómo Sylvia realmente lo marca (puede ser el campo type, o la etapa).
// GET /api/debug/oportunidad-detalle?numero=502XXXXXXXX
app.get('/api/debug/oportunidad-detalle', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const numero = String(req.query.numero || '').replace(/\D/g, '');
    if (!numero) return res.json({ ok: false, error: 'Falta ?numero=' });

    const condiciones = condicionesTelefono(numero);
    const dominioTel = [];
    for (let i = 0; i < condiciones.length - 1; i++) dominioTel.push('|');
    condiciones.forEach(c => dominioTel.push(c));

    const leads = await odooCallLocal('crm.lead', 'search_read',
      [dominioTel],
      { fields: ['id', 'name', 'partner_name', 'phone', 'mobile', 'type', 'stage_id', 'user_id', 'active', 'probability', 'tag_ids'], limit: 10, order: 'create_date desc' }
    ) || [];

    if (!leads.length) return res.json({ ok: true, encontrados: 0, mensaje: 'No hay ningún lead en Odoo con ese número' });

    res.json({
      ok: true,
      encontrados: leads.length,
      leads: leads.map(l => ({
        id: l.id,
        nombre: l.partner_name || l.name,
        tipo_campo: l.type,
        detectado_como_oportunidad_por_KAI: l.type === 'opportunity' ? 'SÍ' : 'NO — solo detecta type=opportunity',
        etapa: l.stage_id?.[1] || null,
        vendedor: l.user_id?.[1] || 'ninguno',
        activo: l.active,
        probabilidad: l.probability
      }))
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ===== DASHBOARD DE EVALUACIÓN — distribución de leads + calidad del trato =====
// Devuelve todo lo que necesita el panel: cuánto atendió cada vendedora, cómo repartió
// KAI los leads, y las charlas que quedaron a medias (papás esperando respuesta).
// GET /api/dashboard/evaluacion?dias=7
// ===== REPORTE DIARIO DE LEADS EN EXCEL =====
// Para que el equipo tenga visibilidad de todo lo que ingresó y cómo va cada uno,
// sin depender de revisar chat por chat. Trae: fecha de ingreso, nombre, teléfono,
// nivel, canal, vendedor asignado, si se atendió, y el resumen de cómo va la
// conversación. Pensado para sacarse cada 7 días al inicio, y luego a diario.
// GET /api/reportes/leads-excel?dias=7
app.get('/api/reportes/leads-excel', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  if (!XLSX) return res.status(500).json({ ok: false, error: 'Falta instalar la librería "xlsx" en el servidor (agrégala a package.json y vuelve a desplegar). El resto de KAI funciona normal.' });
  try {
    let desde, hasta;
    if (req.query.desde && req.query.hasta) {
      desde = new Date(req.query.desde + 'T00:00:00');
      hasta = new Date(req.query.hasta + 'T23:59:59');
    } else {
      const dias = parseInt(req.query.dias) || 7;
      desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
      hasta = new Date();
    }

    // Límite de tiempo para las consultas a Odoo — si Odoo no responde rápido, el
    // reporte sigue sin esos datos en vez de quedarse colgado hasta que Railway corte
    // la conexión (eso fue lo que causó el 502 la primera vez: la llamada a Odoo nunca
    // terminaba, y no había ningún límite que la cortara).
    const conLimite = (promesa, ms = 8000) => Promise.race([
      promesa,
      new Promise(resolve => setTimeout(() => resolve(null), ms))
    ]);

    const contactos = await Contacto.find({
      tenant_id: req.user.tenant_id,
      primer_contacto: { $gte: desde, $lte: hasta },
      numero: { $nin: NUMEROS_DE_PRUEBA }
    }).sort({ primer_contacto: -1 }).limit(500).lean();

    // Traer de un solo golpe (no uno por uno) el vendedor/etapa/etiqueta real en Odoo
    // para todos los que ya tienen lead creado.
    const idsOdoo = contactos.filter(c => c.odoo_lead_id).map(c => c.odoo_lead_id);
    let porLeadOdoo = {};
    if (idsOdoo.length) {
      const leadsOdoo = await conLimite(
        odooCallLocal('crm.lead', 'read', [idsOdoo, ['id', 'user_id', 'stage_id', 'type', 'active', 'tag_ids']]).catch(() => [])
      ) || [];
      let nombresTag = {};
      const idsTags = [...new Set((leadsOdoo || []).flatMap(l => l.tag_ids || []))];
      if (idsTags.length) {
        const tags = await conLimite(
          odooCallLocal('crm.tag', 'read', [idsTags, ['id', 'name']]).catch(() => [])
        ) || [];
        (tags || []).forEach(t => { nombresTag[t.id] = t.name; });
      }
      (leadsOdoo || []).forEach(l => {
        porLeadOdoo[l.id] = {
          vendedor: l.user_id?.[1] || 'Sin asignar',
          etapa: l.stage_id?.[1] || '',
          tipo: l.type === 'opportunity' ? 'Oportunidad' : 'Lead',
          activo: l.active,
          etiquetas: (l.tag_ids || []).map(t => nombresTag[t]).filter(Boolean).join(', ')
        };
      });
    }

    const filas = contactos.map(c => {
      const odoo = c.odoo_lead_id ? porLeadOdoo[c.odoo_lead_id] : null;
      return {
        'Fecha de ingreso': c.primer_contacto ? new Date(c.primer_contacto).toLocaleString('es-GT', { timeZone: 'America/Guatemala' }) : '',
        'Padre/Madre': c.nombre || '(sin nombre)',
        'Alumno': c.nombre_alumno || '',
        'Teléfono': c.numero,
        'Correo': c.correo || '',
        'Nivel de interés': c.nivel_interes || '',
        'Canal': c.canal_origen || '',
        'Vendedor asignado': odoo?.vendedor || (c.odoo_lead_id ? 'No se pudo leer de Odoo (tardó demasiado)' : 'Sin lead en Odoo todavía'),
        'Tipo': odoo?.tipo || '',
        'Etapa en Odoo': odoo?.etapa || '',
        'Etiquetas': odoo?.etiquetas || '',
        '¿Se atendió?': c.total_conversaciones > 0 ? 'Sí' : 'No',
        'Total de conversaciones': c.total_conversaciones || 0,
        'Cómo va (resumen)': c.resumen_ultimo_contacto || '',
        'Última actividad': c.ultimo_contacto ? new Date(c.ultimo_contacto).toLocaleString('es-GT', { timeZone: 'America/Guatemala' }) : '',
        'Nivel de calor': c.nivel_calor_etiqueta || ''
      };
    });

    const libro = XLSX.utils.book_new();
    const hoja = XLSX.utils.json_to_sheet(filas);
    hoja['!cols'] = [
      { wch: 18 }, { wch: 22 }, { wch: 18 }, { wch: 15 }, { wch: 24 }, { wch: 14 }, { wch: 10 },
      { wch: 22 }, { wch: 12 }, { wch: 16 }, { wch: 20 }, { wch: 10 }, { wch: 10 }, { wch: 50 }, { wch: 18 }, { wch: 20 }
    ];
    const etiquetaHoja = (req.query.desde && req.query.hasta)
      ? `${req.query.desde} al ${req.query.hasta}`
      : `Últimos ${parseInt(req.query.dias) || 7} días`;
    XLSX.utils.book_append_sheet(libro, hoja, etiquetaHoja.substring(0, 31)); // Excel limita el nombre de hoja a 31 caracteres

    // Segunda hoja: auditoría histórica de leads perdidos (siempre a 45 días, sin
    // importar el período del reporte principal, para tener visibilidad completa desde
    // que se lanzó KAI). Con límite de tiempo — si Odoo tarda demasiado revisando el
    // chatter de tantos leads, el reporte principal se entrega igual, solo sin esta hoja.
    const auditoria = await conLimite(auditarLeadsPerdidos(45).catch(() => null), 15000);
    if (auditoria && auditoria.length) {
      const filasAuditoria = auditoria.map(a => ({
        'Lead': a.lead,
        'Nombre': a.nombre,
        'Teléfono': a.telefono || '',
        'Correo': a.correo || '',
        'Vendedor': a.vendedor,
        'Tipo': a.tipo,
        'Etapa': a.etapa,
        'Motivo de pérdida (Odoo)': a.motivo_perdida || '',
        'Etiquetas': (a.etiquetas || []).join(', '),
        'Creado': a.creado,
        'Última modificación': a.ultima_modificacion,
        'Días entre creación y último mensaje': a.dias_entre_creacion_y_ultimo_mensaje,
        'Total mensajes en chatter': a.total_mensajes_chatter,
        'Quién escribió en el chatter': (a.autores_en_el_chatter || []).join(', '),
        'Causa probable': a.causa_probable
      }));
      const hojaAuditoria = XLSX.utils.json_to_sheet(filasAuditoria);
      hojaAuditoria['!cols'] = [
        { wch: 8 }, { wch: 22 }, { wch: 15 }, { wch: 24 }, { wch: 18 }, { wch: 12 }, { wch: 16 },
        { wch: 20 }, { wch: 20 }, { wch: 18 }, { wch: 18 }, { wch: 14 }, { wch: 12 }, { wch: 22 }, { wch: 60 }
      ];
      XLSX.utils.book_append_sheet(libro, hojaAuditoria, 'Auditoría de perdidos');
    }

    const buffer = XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' });
    const nombreArchivo = `Reporte_Leads_KAI_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo}"`);
    res.send(buffer);
  } catch (e) {
    console.error('❌ [Reporte Excel] Error generando el reporte:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Busca TODAS las Oportunidades (y leads) que hoy están asignadas al usuario de
// SERVICIO de KAI (el mismo con el que KAI inicia sesión en Odoo — "Administrador").
// Esto NUNCA debería pasar: KAI nunca debe quedar como "vendedor" de nada. Si aparece
// alguna, revisa el chatter para ver el registro de cambio de vendedor (Odoo lo rastrea
// automáticamente en los campos con seguimiento) y así saber CUÁNDO y CÓMO pasó, en vez
// de suponerlo.
// GET /api/debug/oportunidades-mal-asignadas
app.get('/api/debug/oportunidades-mal-asignadas', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const uidServicio = await getOdooUID();

    const leads = await odooCallLocal('crm.lead', 'search_read',
      [[['user_id', '=', uidServicio], ['active', '=', true]]],
      { fields: ['id', 'name', 'partner_name', 'contact_name', 'phone', 'email_from', 'type', 'stage_id', 'create_date', 'write_date'], limit: 100, order: 'write_date desc' }
    ) || [];

    if (!leads.length) return res.json({ ok: true, total: 0, mensaje: 'No hay ninguna Oportunidad ni Lead asignado al usuario de servicio de KAI ahora mismo.' });

    const detalle = [];
    for (const l of leads) {
      // Buscamos específicamente los mensajes de seguimiento de campo ("Salesperson"/
      // "Vendedor" cambiado), que Odoo genera automáticamente sin que nosotros lo pidamos.
      const mensajes = await odooCallLocal('mail.message', 'search_read',
        [[['model', '=', 'crm.lead'], ['res_id', '=', l.id]]],
        { fields: ['body', 'date', 'author_id', 'subtype_id'], limit: 30, order: 'date desc' }
      ).catch(() => []);

      const notaDeCambioDeVendedor = mensajes.find(m => /vendedor|salesperson|responsable/i.test(m.body || ''));

      detalle.push({
        lead: l.id,
        nombre: l.partner_name || l.contact_name || l.name,
        telefono: l.phone || null,
        correo: l.email_from || null,
        tipo: l.type === 'opportunity' ? 'Oportunidad' : 'Lead',
        etapa: l.stage_id?.[1] || '',
        creado: l.create_date,
        ultima_modificacion: l.write_date,
        nota_de_cambio_de_vendedor: notaDeCambioDeVendedor
          ? { fecha: notaDeCambioDeVendedor.date, autor: notaDeCambioDeVendedor.author_id?.[1] || null, texto: (notaDeCambioDeVendedor.body || '').replace(/<[^>]+>/g, ' ').trim().substring(0, 300) }
          : 'No se encontró una nota de cambio de vendedor en el chatter — revisar a mano en Odoo',
        ultimos_5_mensajes: mensajes.slice(0, 5).map(m => ({ fecha: m.date, autor: m.author_id?.[1] || null, texto: (m.body || '').replace(/<[^>]+>/g, ' ').trim().substring(0, 200) }))
      });
    }

    res.json({ ok: true, total: detalle.length, leads: detalle });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/dashboard/evaluacion', authMiddleware, async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const dias = Math.min(parseInt(req.query.dias) || 7, 90);
    const desde = new Date(Date.now() - dias * 24 * 3600 * 1000);

    // ===== 1. DISTRIBUCIÓN DE LEADS POR VENDEDORA =====
    // Se combinan las DOS fuentes reales: la colección local (canal Meta) y
    // AsignacionAcrux (canal AcruxLab, que es donde vive casi todo el tráfico actual).
    // Contar solo una de las dos daba un panorama incompleto y engañoso.
    const vendedoras = await UsuarioPanel.find({ tenant_id: tenantId, activo: true }).select('nombre email role');
    const porVendedora = {};
    vendedoras.forEach(v => {
      porVendedora[v._id.toString()] = {
        nombre: v.nombre, rol: v.role,
        asignados: 0, respondidos: 0, pendientes: 0, cerrados: 0
      };
    });

    const convs = await Conversacion.find({
      tenant_id: tenantId,
      ultimaActividad: { $gte: desde }
    }).select('agente_id agente_nombre estado mensajes ultimaActividad');

    let sinAsignar = 0;
    for (const c of convs) {
      const clave = c.agente_id?.toString();
      const registro = clave && porVendedora[clave] ? porVendedora[clave] : null;
      if (!registro) { if (c.estado !== 'bot') sinAsignar++; continue; }

      registro.asignados++;
      if (c.estado === 'cerrado') registro.cerrados++;

      const respondioAgente = (c.mensajes || []).some(m => m.de === 'agente');
      if (respondioAgente) registro.respondidos++;

      const ultimo = (c.mensajes || [])[c.mensajes.length - 1];
      if (ultimo && ultimo.de === 'padre' && c.estado !== 'bot' && c.estado !== 'cerrado') {
        registro.pendientes++;
      }
    }

    // ===== Sumar AcruxLab =====
    const asignsAcrux = await AsignacionAcrux.find({
      tenant_id: tenantId,
      $or: [{ fecha_modo_humano: { $gte: desde } }, { fecha_asignado: { $gte: desde } }]
    }).select('agente_id agente_nombre modo contacto_id fecha_asignado');

    // Para saber quién respondió y quién quedó pendiente, se necesita leer los mensajes
    // reales de cada conversación de AcruxLab.
    const idsAcrux = asignsAcrux.filter(a => a.agente_id).map(a => a.contacto_id);
    let mensajesAcrux = [];
    if (idsAcrux.length) {
      mensajesAcrux = await odooCallLocal('acrux.chat.message', 'search_read',
        [[['contact_id', 'in', idsAcrux], ['date_message', '>=', desde.toISOString().replace('T', ' ').substring(0, 19)]]],
        { fields: ['contact_id', 'from_me', 'date_message'], limit: 5000 }
      ) || [];
    }
    const mensajesPorContacto = {};
    mensajesAcrux.forEach(m => {
      const cid = m.contact_id?.[0];
      if (!cid) return;
      if (!mensajesPorContacto[cid]) mensajesPorContacto[cid] = [];
      mensajesPorContacto[cid].push(m);
    });

    for (const a of asignsAcrux) {
      const clave = a.agente_id?.toString();
      const registro = clave && porVendedora[clave] ? porVendedora[clave] : null;
      if (!registro) { if (a.modo !== 'bot') sinAsignar++; continue; }

      registro.asignados++;
      const msgs = (mensajesPorContacto[a.contacto_id] || []).sort((x, y) => x.date_message.localeCompare(y.date_message));
      if (!msgs.length) continue;

      const respondioAgente = msgs.some(m => m.from_me);
      if (respondioAgente) registro.respondidos++;

      const ultimo = msgs[msgs.length - 1];
      if (ultimo && !ultimo.from_me && a.modo !== 'bot') registro.pendientes++;
    }

    // Balance del reparto: qué tan parejo quedó entre las asesoras (no admin)
    const soloAsesoras = Object.values(porVendedora).filter(v => v.rol === 'vendedor');
    const totalAsesoras = soloAsesoras.reduce((s, v) => s + v.asignados, 0);
    const balance = soloAsesoras.length && totalAsesoras
      ? soloAsesoras.map(v => ({ nombre: v.nombre, asignados: v.asignados, porcentaje: Math.round(v.asignados / totalAsesoras * 100) }))
      : [];

    // ===== 2. CHARLAS A MEDIAS =====
    // Igual que arriba: se combinan las dos fuentes reales.
    const aMedias = [];
    for (const c of convs) {
      if (c.estado === 'cerrado' || c.estado === 'bot') continue;
      const msgs = c.mensajes || [];
      if (!msgs.length) continue;
      const ultimo = msgs[msgs.length - 1];
      if (ultimo.de === 'padre') {
        const horas = Math.round((Date.now() - new Date(ultimo.fecha).getTime()) / 3600000);
        aMedias.push({
          nombre: c.nombre || c.numero,
          asignada_a: c.agente_nombre || 'SIN ASIGNAR',
          ultimo_mensaje: String(ultimo.texto || '').substring(0, 80),
          horas_esperando: horas
        });
      }
    }
    // AcruxLab
    for (const a of asignsAcrux) {
      if (a.modo === 'bot') continue; // esas las cubre el reporte de "KAI a medias"
      const msgs = (mensajesPorContacto[a.contacto_id] || []).sort((x, y) => x.date_message.localeCompare(y.date_message));
      if (!msgs.length) continue;
      const ultimo = msgs[msgs.length - 1];
      if (!ultimo.from_me) {
        const horas = Math.round((Date.now() - new Date(ultimo.date_message + 'Z').getTime()) / 3600000);
        aMedias.push({
          nombre: a.agente_nombre ? `Conversación #${a.contacto_id}` : `#${a.contacto_id}`,
          asignada_a: a.agente_nombre || 'SIN ASIGNAR',
          ultimo_mensaje: '(ver en ChatRoom — AcruxLab)',
          horas_esperando: horas
        });
      }
    }
    aMedias.sort((a, b) => b.horas_esperando - a.horas_esperando);

    res.json({
      ok: true,
      dias_evaluados: dias,
      distribucion: {
        por_vendedora: Object.values(porVendedora).filter(v => v.asignados > 0),
        sin_asignar: sinAsignar,
        balance_del_reparto: balance
      },
      charlas_a_medias: {
        total: aMedias.length,
        detalle: aMedias.slice(0, 30)
      }
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Evaluación de CÓMO trató KAI a los papás — usa la IA para revisar las conversaciones
// y detectar problemas de trato (respuestas cortantes, fuera de lugar, temas ignorados).
// Es la base del "aprendizaje": encuentra los errores para convertirlos en reglas.
// GET /api/dashboard/calidad-trato?dias=3
app.get('/api/dashboard/calidad-trato', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const tenantId = req.user.tenant_id;
    const dias = Math.min(parseInt(req.query.dias) || 3, 14);
    const desde = new Date(Date.now() - dias * 24 * 3600 * 1000);

    // Tomamos conversaciones donde KAI participó (tiene mensajes de bot)
    const convs = await Conversacion.find({
      tenant_id: tenantId,
      ultimaActividad: { $gte: desde },
      'mensajes.de': 'bot'
    }).select('numero nombre mensajes').limit(40);

    if (!convs.length) return res.json({ ok: true, total: 0, mensaje: 'No hay conversaciones de KAI en ese rango' });

    // Armamos un extracto de cada conversación para que la IA la evalúe
    const extractos = convs.map((c, i) => {
      const dialogo = (c.mensajes || []).slice(-8).map(m => {
        const quien = m.de === 'padre' ? 'PAPÁ' : (m.de === 'bot' ? 'KAI' : 'ASESORA');
        return `${quien}: ${String(m.texto || '').substring(0, 200)}`;
      }).join('\n');
      return `--- Conversación ${i} (${c.nombre || c.numero}) ---\n${dialogo}`;
    }).join('\n\n');

    const systemPrompt = `Eres un supervisor de calidad del Colegio Capouilliez. Revisas cómo el asistente KAI trató a los padres de familia que escribieron por WhatsApp. Los padres son clientes que merecen un trato cálido, claro y respetuoso.

Por cada conversación con algún problema, repórtalo. Busca específicamente:
- Respuestas cortantes o frías cuando el padre fue amable.
- Que KAI ignore parte de lo que el padre preguntó (responder solo una cosa cuando pidió varias).
- Que KAI mande información que NO corresponde a lo que se pidió (ej. imagen equivocada).
- Que KAI responda una cortesía vacía a un mensaje importante.
- Saludos repetidos o preguntar algo que el padre ya había dicho (ej. su nombre).
- Charlas que quedaron a medias: el padre preguntó algo y KAI no lo resolvió.

Devuelve ÚNICAMENTE un arreglo JSON, sin markdown:
[{"conversacion": 0, "problema": "descripción breve del problema", "gravedad": "alta|media|baja", "regla_sugerida": "qué regla evitaría esto a futuro"}]

Si una conversación estuvo BIEN, no la incluyas. Si todas estuvieron bien, devuelve [].

RESPONDE ÚNICAMENTE CON EL ARREGLO JSON. No escribas explicaciones antes ni después. La primera letra de tu respuesta debe ser "[" y la última "]".`;

    const respuesta = await llamarClaude(systemPrompt, [{ role: 'user', content: extractos.substring(0, 14000) }], 3000);
    if (!respuesta) return res.json({ ok: false, error: 'La IA no respondió (revisar saldo de Anthropic)' });

    let hallazgos;
    try {
      let limpio = respuesta.replace(/```json|```/g, '').trim();
      const inicio = limpio.indexOf('[');
      const fin = limpio.lastIndexOf(']');
      if (inicio === -1 || fin === -1 || fin < inicio) throw new Error('No se encontró un arreglo JSON en la respuesta');
      limpio = limpio.substring(inicio, fin + 1);
      hallazgos = JSON.parse(limpio);
    } catch (e) {
      return res.json({ ok: false, error: 'La IA devolvió un formato inesperado', respuesta_cruda: respuesta.substring(0, 1500) });
    }

    // Enriquecer con el nombre del papá
    const detalle = (hallazgos || []).map(h => ({
      papa: convs[h.conversacion]?.nombre || convs[h.conversacion]?.numero || '?',
      problema: h.problema,
      gravedad: h.gravedad,
      regla_sugerida: h.regla_sugerida
    }));

    res.json({
      ok: true,
      conversaciones_revisadas: convs.length,
      problemas_encontrados: detalle.length,
      resumen: {
        alta: detalle.filter(d => d.gravedad === 'alta').length,
        media: detalle.filter(d => d.gravedad === 'media').length,
        baja: detalle.filter(d => d.gravedad === 'baja').length
      },
      hallazgos: detalle
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ===== DASHBOARD DE MONITOREO — para Sylvia =====
app.get('/api/monitoreo/dashboard', authMiddleware, async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const ahora = new Date();
    const hace1h = new Date(ahora - 60*60*1000);
    const hace24h = new Date(ahora - 24*60*60*1000);

    // Chats activos por asesora
    const chatsActivos = await Conversacion.aggregate([
      { $match: { tenant_id: tenantId, estado: { $in: ['humano', 'esperando_agente'] } } },
      { $group: { _id: '$agente_nombre', total: { $sum: 1 }, ids: { $push: '$_id' } } }
    ]);

    // Chats sin respuesta hace más de 30 minutos
    const hace30min = new Date(ahora - 30*60*1000);
    const sinRespuesta = await Conversacion.find({
      tenant_id: tenantId,
      estado: { $in: ['humano', 'esperando_agente'] },
      ultimaActividad: { $lt: hace30min }
    }).select('numero nombre agente_nombre ultimaActividad');

    // Tiempo promedio de respuesta por asesora (últimas 24h)
    const convs24h = await Conversacion.find({
      tenant_id: tenantId,
      estado: { $ne: 'bot' },
      creado: { $gte: hace24h }
    }).select('agente_nombre mensajes creado ultimaActividad');

    // Calcular tiempo promedio de primera respuesta por asesora
    const tiemposPorAgente = {};
    convs24h.forEach(conv => {
      if (!conv.agente_nombre || !conv.mensajes?.length) return;
      const primerMsgPadre = conv.mensajes.find(m => m.de === 'padre');
      const primerRespAgente = conv.mensajes.find(m => m.de === 'agente');
      if (primerMsgPadre && primerRespAgente) {
        const espera = new Date(primerRespAgente.fecha) - new Date(primerMsgPadre.fecha);
        if (espera > 0) {
          if (!tiemposPorAgente[conv.agente_nombre]) tiemposPorAgente[conv.agente_nombre] = [];
          tiemposPorAgente[conv.agente_nombre].push(Math.round(espera / 60000)); // en minutos
        }
      }
    });

    const promediosPorAgente = Object.entries(tiemposPorAgente).map(([agente, tiempos]) => ({
      agente,
      promedio_minutos: Math.round(tiempos.reduce((a,b)=>a+b,0) / tiempos.length),
      total_atendidos: tiempos.length
    }));

    // Resumen general
    const totalActivos = await Conversacion.countDocuments({ tenant_id: tenantId, estado: { $in: ['humano','esperando_agente'] } });
    const totalBot = await Conversacion.countDocuments({ tenant_id: tenantId, estado: 'bot' });
    const totalHoy = await Conversacion.countDocuments({ tenant_id: tenantId, creado: { $gte: hace24h } });

    res.json({
      ok: true,
      resumen: {
        chats_activos_total: totalActivos,
        chats_con_kai: totalBot,
        chats_nuevos_24h: totalHoy,
        sin_respuesta_30min: sinRespuesta.length
      },
      por_asesora: chatsActivos.map(a => ({
        asesora: a._id || 'Sin asignar',
        chats_activos: a.total
      })),
      sin_respuesta: sinRespuesta.map(c => ({
        numero: c.numero,
        nombre: c.nombre || 'Sin nombre',
        asesora: c.agente_nombre || 'Sin asignar',
        minutos_sin_respuesta: Math.round((ahora - new Date(c.ultimaActividad)) / 60000)
      })),
      tiempos_respuesta: promediosPorAgente
    });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ===== ACRUXLAB CHATROOM — Diagnóstico y lectura de mensajes =====

// Paso 1: Diagnóstico — confirmar que podemos leer acrux.chat.message
app.get('/api/debug/acrux-mensajes', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false });

    // Leer los últimos 10 mensajes entrantes (from_me = false = del padre)
    const mensajes = await odooCallLocal('acrux.chat.message', 'search_read',
      [[['from_me', '=', false]]],
      {
        fields: ['id', 'text', 'date_message', 'contact_name', 'contact_number', 'from_me', 'msgid', 'read_date', 'event'],
        limit: 10,
        order: 'date_message desc'
      }
    );

    if (!mensajes) return res.json({ ok: false, error: 'No se pudo leer acrux.chat.message — verificar permisos' });

    res.json({
      ok: true,
      total_leidos: mensajes.length,
      mensaje: 'Lectura exitosa de AcruxLab ChatRoom',
      mensajes: mensajes.map(m => ({
        id: m.id,
        fecha: m.date_message,
        de: m.contact_name || m.contact_number,
        texto: (m.text || '').substring(0, 100),
        leido: !!m.read_date,
        evento: m.event
      }))
    });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message, nota: 'Si el error es "Model not found", AcruxLab no está instalado o el usuario no tiene permisos' });
  }
});

// Paso 2: Leer conversaciones activas del ChatRoom
// Nota: el modelo "acrux.chat.conversation" puede no existir con ese nombre exacto
// en esta instalación de AcruxLab (o el usuario Odoo no tiene permiso sobre él).
// Por eso separamos cada intento en su propio try/catch: si "conversation" falla,
// igual devolvemos algo útil armando conversaciones a partir de acrux.chat.message
// (que ya confirmamos que SÍ funciona), agrupando por contact_number.
app.get('/api/debug/acrux-conversaciones', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });

  const resultado = { ok: true, modelo_conversation: { disponible: false }, fallback_agrupado: null };

  // Intento 1: modelo dedicado acrux.chat.conversation (puede no existir)
  try {
    const campos = await odooCallLocal('acrux.chat.conversation', 'fields_get', [], { attributes: ['string', 'type'] });
    const camposDisponibles = campos ? Object.keys(campos).slice(0, 30) : [];
    const convs = await odooCallLocal('acrux.chat.conversation', 'search_read',
      [[]],
      { fields: ['id', 'create_date', 'write_date'], limit: 5, order: 'write_date desc' }
    );
    resultado.modelo_conversation = {
      disponible: true,
      campos_disponibles: camposDisponibles,
      total: convs ? convs.length : 0,
      conversaciones: convs || []
    };
  } catch (e) {
    resultado.modelo_conversation = {
      disponible: false,
      error: e.message,
      nota: 'No se pudo usar acrux.chat.conversation. Puede que el nombre del modelo sea otro, o que no exista como tal. Usar el fallback agrupado en su lugar.'
    };
  }

  // Intento 2 (fallback confiable): agrupar acrux.chat.message por contact_number
  try {
    const mensajes = await odooCallLocal('acrux.chat.message', 'search_read',
      [[]],
      { fields: ['id', 'text', 'date_message', 'contact_name', 'contact_number', 'from_me'], limit: 200, order: 'date_message desc' }
    );
    const porNumero = {};
    (mensajes || []).forEach(m => {
      const num = m.contact_number || 'sin_numero';
      if (!porNumero[num]) porNumero[num] = { numero: num, nombre: m.contact_name || num, total_mensajes: 0, ultimo_mensaje: null, ultima_fecha: null };
      porNumero[num].total_mensajes++;
      if (!porNumero[num].ultima_fecha || m.date_message > porNumero[num].ultima_fecha) {
        porNumero[num].ultima_fecha = m.date_message;
        porNumero[num].ultimo_mensaje = (m.text || '').substring(0, 100);
      }
    });
    resultado.fallback_agrupado = {
      disponible: true,
      total_conversaciones: Object.keys(porNumero).length,
      conversaciones: Object.values(porNumero).sort((a, b) => (b.ultima_fecha || '').localeCompare(a.ultima_fecha || ''))
    };
  } catch (e) {
    resultado.fallback_agrupado = { disponible: false, error: e.message };
  }

  res.json(resultado);
});

// Paso 3: Método de envío — probar que podemos responder por AcruxLab
app.post('/api/debug/acrux-enviar-prueba', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
    const { conversation_id, texto } = req.body;
    if (!conversation_id || !texto) return res.status(400).json({ ok: false, error: 'conversation_id y texto requeridos' });

    // Intentar enviar por el método de AcruxLab
    const resultado = await odooCallLocal('acrux.chat.conversation', 'action_send_message',
      [[parseInt(conversation_id)], texto]
    );

    res.json({ ok: true, resultado, nota: 'Si resultado es null pero no hay error, el mensaje se envió' });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message, nota: 'El método action_send_message puede tener un nombre diferente en tu versión de AcruxLab' });
  }
});

// ===== ACRUXLAB CHATROOM — Lectura real para el panel (Fase 1: solo lectura) =====
// Estos endpoints NO escriben nada en Odoo. Solo leen acrux.chat.message y arman
// conversaciones agrupando por contact_number, para mostrarlas en "Chats en Vivo".
// Cuando se autorice la Fase 2 (KAI respondiendo por este número), se agregará
// un endpoint de envío aparte — este bloque se queda solo de lectura.

// Extrae el número de WhatsApp del msgid, formato típico: "false_50256338598@c.us_XXXXX"
function extraerNumeroDeMsgid(msgid) {
  const m = String(msgid || '').match(/_(\d{8,15})@/);
  return m ? m[1] : null;
}

// ===== MÉTRICAS DE ATENCIÓN (vista gerencial) — solo lectura =====
// Calcula, a partir de los mensajes reales de AcruxLab:
// - Tiempo de primera respuesta por conversación (desde el primer mensaje del padre
//   hasta la primera respuesta humana), agregado por agente.
// - Volumen de conversaciones atendidas por cada agente.
// - Conversaciones que llevan mensaje del padre sin ninguna respuesta todavía.
// Helper: métricas de AcruxLab para un rango de fechas específico (reutilizable
// para el periodo actual, el periodo anterior de comparación, y la tendencia diaria).
async function calcularMetricasAcruxPeriodo(desdeISO, hastaISO) {
  const mensajes = await odooCallLocal('acrux.chat.message', 'search_read',
    [[['date_message', '>=', desdeISO], ['date_message', '<', hastaISO]]],
    { fields: ['contact_id', 'from_me', 'date_message'], limit: 20000, order: 'date_message asc' }
  ) || [];

  const porContacto = {};
  mensajes.forEach(m => {
    if (!m.contact_id) return;
    const id = m.contact_id[0];
    if (!porContacto[id]) porContacto[id] = [];
    porContacto[id].push(m);
  });

  let total = 0, sinResponder = 0;
  const tiempos = [];
  const porDia = {}; // 'YYYY-MM-DD' -> { conversaciones, tiempos: [] }

  Object.values(porContacto).forEach(msgs => {
    total++;
    const primerPadre = msgs.find(m => !m.from_me);
    if (!primerPadre) return;
    const dia = primerPadre.date_message.substring(0, 10);
    if (!porDia[dia]) porDia[dia] = { conversaciones: 0, tiempos: [] };
    porDia[dia].conversaciones++;

    const primeraRespuesta = msgs.find(m => m.from_me && m.date_message > primerPadre.date_message);
    if (!primeraRespuesta) { sinResponder++; return; }
    const minutos = (new Date(primeraRespuesta.date_message.replace(' ', 'T') + 'Z') - new Date(primerPadre.date_message.replace(' ', 'T') + 'Z')) / 60000;
    tiempos.push(minutos);
    porDia[dia].tiempos.push(minutos);
  });

  const promedio = arr => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null;
  return {
    total_conversaciones: total,
    tiempo_promedio_min: promedio(tiempos),
    sin_responder: sinResponder,
    por_dia: Object.entries(porDia).map(([fecha, d]) => ({ fecha, conversaciones: d.conversaciones, tiempo_promedio_min: promedio(d.tiempos) }))
  };
}

// Helper: métricas de un canal de Meta (whatsapp/instagram/messenger), guardado en Mongo.
async function calcularMetricasMongoPeriodo(canal, desdeDate, hastaDate, tenantId) {
  const conversaciones = await Conversacion.find({
    tenant_id: tenantId, canal, creado: { $gte: desdeDate, $lt: hastaDate }
  }).select('mensajes estado creado').lean();

  let total = 0, sinResponder = 0, cerradas = 0;
  const tiempos = [];
  const porDia = {};

  conversaciones.forEach(conv => {
    total++;
    if (conv.estado === 'cerrado') cerradas++;
    const msgs = (conv.mensajes || []).slice().sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
    const primerPadre = msgs.find(m => m.de === 'padre');
    if (!primerPadre) return;
    const dia = new Date(primerPadre.fecha).toISOString().substring(0, 10);
    if (!porDia[dia]) porDia[dia] = { conversaciones: 0, tiempos: [] };
    porDia[dia].conversaciones++;

    const primeraRespuesta = msgs.find(m => m.de === 'agente' && new Date(m.fecha) > new Date(primerPadre.fecha));
    if (!primeraRespuesta) { sinResponder++; return; }
    const minutos = (new Date(primeraRespuesta.fecha) - new Date(primerPadre.fecha)) / 60000;
    tiempos.push(minutos);
    porDia[dia].tiempos.push(minutos);
  });

  const promedio = arr => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null;
  return {
    total_conversaciones: total,
    tiempo_promedio_min: promedio(tiempos),
    sin_responder: sinResponder,
    cerradas,
    por_dia: Object.entries(porDia).map(([fecha, d]) => ({ fecha, conversaciones: d.conversaciones, tiempo_promedio_min: promedio(d.tiempos) }))
  };
}

// ===== MÉTRICAS GENERALES (todos los canales) — vista gerencial consolidada =====
// Combina AcruxLab (Odoo) + WhatsApp/Instagram/Messenger (Mongo): por canal,
// comparación contra el periodo anterior, y tendencia diaria combinada.
// NOTA sobre "conversión": para WhatsApp/IG/Messenger se usa el estado "cerrado"
// como aproximación (no confirma inscripción real, solo que se marcó resuelta).
// Para AcruxLab todavía no tenemos un campo confiable de "ganado" — falta confirmarlo.
app.get('/api/metricas-generales', authMiddleware, async (req, res) => {
  if (req.user.role === 'vendedor') return res.status(403).json({ ok: false, error: 'Las métricas son solo para administración' });
  try {
    const dias = Math.min(parseInt(req.query.dias) || 7, 90);
    const ahora = new Date();
    const desdeActual = new Date(ahora.getTime() - dias * 86400000);
    const desdeAnterior = new Date(desdeActual.getTime() - dias * 86400000);

    const desdeActualISO = desdeActual.toISOString().replace('T', ' ').substring(0, 19);
    const hastaActualISO = ahora.toISOString().replace('T', ' ').substring(0, 19);
    const desdeAnteriorISO = desdeAnterior.toISOString().replace('T', ' ').substring(0, 19);

    const [acruxActual, acruxAnterior, waActual, waAnterior, igActual, igAnterior, fbActual, fbAnterior] = await Promise.all([
      calcularMetricasAcruxPeriodo(desdeActualISO, hastaActualISO),
      calcularMetricasAcruxPeriodo(desdeAnteriorISO, desdeActualISO),
      calcularMetricasMongoPeriodo('whatsapp', desdeActual, ahora, req.user.tenant_id),
      calcularMetricasMongoPeriodo('whatsapp', desdeAnterior, desdeActual, req.user.tenant_id),
      calcularMetricasMongoPeriodo('instagram', desdeActual, ahora, req.user.tenant_id),
      calcularMetricasMongoPeriodo('instagram', desdeAnterior, desdeActual, req.user.tenant_id),
      calcularMetricasMongoPeriodo('messenger', desdeActual, ahora, req.user.tenant_id),
      calcularMetricasMongoPeriodo('messenger', desdeAnterior, desdeActual, req.user.tenant_id)
    ]);

    const promedio = arr => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null;
    const cambioPct = (actual, anterior) => (anterior && anterior > 0) ? Math.round(((actual - anterior) / anterior) * 1000) / 10 : null;

    const porCanal = [
      { canal: 'AcruxLab (Número Oficial)', ...acruxActual, tasa_cierre_pct: null },
      { canal: 'WhatsApp', ...waActual, tasa_cierre_pct: waActual.total_conversaciones ? Math.round(waActual.cerradas / waActual.total_conversaciones * 1000) / 10 : null },
      { canal: 'Instagram', ...igActual, tasa_cierre_pct: igActual.total_conversaciones ? Math.round(igActual.cerradas / igActual.total_conversaciones * 1000) / 10 : null },
      { canal: 'Messenger', ...fbActual, tasa_cierre_pct: fbActual.total_conversaciones ? Math.round(fbActual.cerradas / fbActual.total_conversaciones * 1000) / 10 : null }
    ];

    const totalActual = acruxActual.total_conversaciones + waActual.total_conversaciones + igActual.total_conversaciones + fbActual.total_conversaciones;
    const totalAnterior = acruxAnterior.total_conversaciones + waAnterior.total_conversaciones + igAnterior.total_conversaciones + fbAnterior.total_conversaciones;
    const tiempoPromActual = promedio([acruxActual, waActual, igActual, fbActual].flatMap(c => c.tiempo_promedio_min != null ? [c.tiempo_promedio_min] : []));
    const tiempoPromAnterior = promedio([acruxAnterior, waAnterior, igAnterior, fbAnterior].flatMap(c => c.tiempo_promedio_min != null ? [c.tiempo_promedio_min] : []));

    // Tendencia diaria combinada (todos los canales juntos, por fecha)
    const combinarPorDia = {};
    [acruxActual, waActual, igActual, fbActual].forEach(c => {
      (c.por_dia || []).forEach(d => {
        if (!combinarPorDia[d.fecha]) combinarPorDia[d.fecha] = { conversaciones: 0, tiempos: [] };
        combinarPorDia[d.fecha].conversaciones += d.conversaciones;
        if (d.tiempo_promedio_min != null) combinarPorDia[d.fecha].tiempos.push(d.tiempo_promedio_min);
      });
    });
    const tendenciaDiaria = Object.entries(combinarPorDia)
      .map(([fecha, d]) => ({ fecha, conversaciones: d.conversaciones, tiempo_promedio_min: promedio(d.tiempos) }))
      .sort((a, b) => a.fecha.localeCompare(b.fecha));

    const cerradasTotal = waActual.cerradas + igActual.cerradas + fbActual.cerradas;
    const totalConCierre = waActual.total_conversaciones + igActual.total_conversaciones + fbActual.total_conversaciones;

    res.json({
      ok: true,
      periodo_dias: dias,
      resumen_general: {
        total_conversaciones: totalActual,
        tiempo_promedio_min: tiempoPromActual,
        sin_responder_aun: acruxActual.sin_responder + waActual.sin_responder + igActual.sin_responder + fbActual.sin_responder
      },
      comparacion_periodo_anterior: {
        conversaciones_cambio_pct: cambioPct(totalActual, totalAnterior),
        tiempo_respuesta_cambio_pct: cambioPct(tiempoPromActual, tiempoPromAnterior)
      },
      por_canal: porCanal,
      tendencia_diaria: tendenciaDiaria,
      tasa_cierre_aproximada: {
        nota: 'Solo disponible para WhatsApp/Instagram/Messenger (estado "cerrado" en el panel). AcruxLab aún no tiene un campo confiable de resultado/ganado confirmado.',
        porcentaje: totalConCierre ? Math.round(cerradasTotal / totalConCierre * 1000) / 10 : null
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/acrux/metricas', authMiddleware, async (req, res) => {
  if (req.user.role === 'vendedor') return res.status(403).json({ ok: false, error: 'Las métricas son solo para administración' });
  try {
    const dias = Math.min(parseInt(req.query.dias) || 30, 90);
    const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);

    const mensajes = await odooCallLocal('acrux.chat.message', 'search_read',
      [[['date_message', '>=', desde]]],
      { fields: ['contact_id', 'from_me', 'date_message', 'user_id', 'ttype'], limit: 20000, order: 'date_message asc' }
    ) || [];

    const porContacto = {};
    mensajes.forEach(m => {
      if (!m.contact_id) return;
      const id = m.contact_id[0];
      if (!porContacto[id]) porContacto[id] = { nombre: m.contact_id[1], mensajes: [] };
      porContacto[id].mensajes.push(m);
    });

    const porAgente = {}; // { nombre: { conversaciones: Set, tiemposRespuestaMin: [], mensajesEnviados: 0 } }
    let sinResponderAun = 0;
    let totalConversaciones = 0;
    const tiemposGenerales = [];

    Object.values(porContacto).forEach(conv => {
      totalConversaciones++;
      const msgs = conv.mensajes; // ya vienen ordenados asc por fecha
      const primerPadre = msgs.find(m => !m.from_me);
      if (!primerPadre) return; // conversación sin ningún mensaje del padre en el rango

      const primeraRespuesta = msgs.find(m => m.from_me && m.date_message > primerPadre.date_message && m.user_id);
      if (!primeraRespuesta) { sinResponderAun++; return; }

      const minutos = (new Date(primeraRespuesta.date_message.replace(' ', 'T') + 'Z') - new Date(primerPadre.date_message.replace(' ', 'T') + 'Z')) / 60000;
      tiemposGenerales.push(minutos);

      const agente = primeraRespuesta.user_id[1];
      if (!porAgente[agente]) porAgente[agente] = { conversaciones: new Set(), tiemposRespuestaMin: [], mensajesEnviados: 0 };
      porAgente[agente].conversaciones.add(conv.nombre);
      porAgente[agente].tiemposRespuestaMin.push(minutos);
    });

    // Volumen total de mensajes enviados por cada agente (no solo la primera respuesta)
    mensajes.forEach(m => {
      if (m.from_me && m.user_id) {
        const agente = m.user_id[1];
        if (!porAgente[agente]) porAgente[agente] = { conversaciones: new Set(), tiemposRespuestaMin: [], mensajesEnviados: 0 };
        porAgente[agente].mensajesEnviados++;
      }
    });

    const promedio = arr => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null;

    const resultado = Object.entries(porAgente).map(([agente, d]) => ({
      agente,
      conversaciones_atendidas: d.conversaciones.size,
      tiempo_promedio_primera_respuesta_min: promedio(d.tiemposRespuestaMin),
      mensajes_enviados: d.mensajesEnviados
    })).sort((a, b) => b.conversaciones_atendidas - a.conversaciones_atendidas);

    res.json({
      ok: true,
      periodo_dias: dias,
      resumen_general: {
        total_conversaciones: totalConversaciones,
        tiempo_promedio_primera_respuesta_min: promedio(tiemposGenerales),
        sin_responder_aun: sinResponderAun
      },
      por_agente: resultado
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/acrux/conversaciones', authMiddleware, async (req, res) => {
  try {
    const limite = Math.min(parseInt(req.query.limit) || 300, 1000);
    const mensajes = await odooCallLocal('acrux.chat.message', 'search_read',
      [[]],
      { fields: ['id', 'text', 'date_message', 'contact_id', 'msgid', 'from_me', 'read_date', 'user_id'], limit: limite, order: 'date_message desc' }
    );

    if (!mensajes) return res.json({ ok: false, error: 'No se pudo leer acrux.chat.message' });

    const porContacto = {};
    mensajes.forEach(m => {
      // contact_id viene como [id, "Nombre"] cuando existe, o false si el mensaje no tiene contacto vinculado
      if (!m.contact_id) return;
      const contactoId = m.contact_id[0];
      if (!porContacto[contactoId]) {
        porContacto[contactoId] = {
          contacto_id: contactoId,
          nombre: m.contact_id[1] || 'Sin nombre',
          numero: extraerNumeroDeMsgid(m.msgid),
          total_mensajes: 0,
          no_leidos: 0,
          ultimo_mensaje: null,
          ultima_fecha: null,
          ultimo_de: null,
          agente: null, // último agente humano que respondió (user_id del mensaje saliente más reciente)
          etiquetas: [],
          prioridad: '0',
          nota: null
        };
      }
      const c = porContacto[contactoId];
      c.total_mensajes++;
      if (!m.from_me && !m.read_date) c.no_leidos++;
      if (!c.numero) c.numero = extraerNumeroDeMsgid(m.msgid); // por si el primer mensaje encontrado no traía msgid parseable
      if (!c.ultima_fecha || m.date_message > c.ultima_fecha) {
        c.ultima_fecha = m.date_message;
        c.ultimo_mensaje = (m.text || '').substring(0, 120);
        c.ultimo_de = m.from_me ? 'agente' : 'padre';
      }
      if (m.from_me && m.user_id && (!c._fechaAgente || m.date_message > c._fechaAgente)) {
        c.agente = m.user_id[1];
        c._fechaAgente = m.date_message;
      }
    });
    // Limpiar campo auxiliar interno antes de responder
    Object.values(porContacto).forEach(c => { c.agente_fecha = c._fechaAgente || null; delete c._fechaAgente; });

    // Clasificación real (Prioridad/Etiquetas/Nota) — directo desde acrux.chat.conversation
    // en un solo lote, usando los mismos contacto_id que ya tenemos. Ya no se cruza por
    // teléfono contra crm.lead (eso generaba ambigüedad con leads duplicados).
    try {
      const contactoIds = Object.keys(porContacto).map(Number);
      if (contactoIds.length) {
        const conversacionesOdoo = await odooCallLocal('acrux.chat.conversation', 'read',
          [contactoIds, ['id', 'priority', 'tag_ids', 'note']]
        ) || [];

        const idsTagsUsados = [...new Set(conversacionesOdoo.flatMap(c => c.tag_ids || []))];
        let nombresTag = {};
        if (idsTagsUsados.length) {
          // Este modelo a veces da AccessError (falta de permiso en Odoo para el
          // usuario de servicio) — no debe tumbar toda la lista de conversaciones por
          // eso, solo se quedan sin nombre de etiqueta esta vez.
          try {
            const tags = await odooCallLocal('acrux.chat.conversation.tag', 'read', [idsTagsUsados, ['id', 'name']]);
            (tags || []).forEach(t => { nombresTag[t.id] = t.name; });
          } catch (e) { /* sin permiso en Odoo para este modelo — se sigue sin nombres de etiqueta */ }
        }

        conversacionesOdoo.forEach(co => {
          const c = porContacto[co.id];
          if (!c) return;
          c.etiquetas = (co.tag_ids || []).map(id => nombresTag[id]).filter(Boolean);
          c.prioridad = co.priority || '0';
          c.nota = (co.note || '').trim() || null;
        });
      }
    } catch (e) {
      // Si el cruce con Odoo falla, seguimos mostrando los chats sin etiquetas (no bloqueante)
    }

    let conversaciones = Object.values(porContacto).sort((a, b) => (b.ultima_fecha || '').localeCompare(a.ultima_fecha || ''));

    // Asegurar que toda conversación sin respuesta humana todavía ya tenga un vendedor
    // asignado por reparto 1 a 1 (Cindy/Vanessa), desde que llega el mensaje — no hace
    // falta que alguien conteste primero para que quede "en la bandeja" de alguien.
    try {
      await asegurarAsignacionesAcrux(req.user.tenant_id, conversaciones);
    } catch (e) {
      // Si falla la asignación automática, seguimos mostrando los chats sin asignar (no bloqueante)
    }

    // El orden ya no depende de "modo" (bot/humano) — el criterio real que importa es
    // si el padre está esperando respuesta o no. Eso lo separa el frontend en dos
    // secciones visuales; aquí solo se mantiene el orden por actividad más reciente.

// Distingue un mensaje de Instagram/Messenger que parece un LEAD real (pregunta,
// datos de contacto, mención de nivel/grado) de una simple reacción o comentario suelto
// a una publicación (solo emojis, "gracias", "felicitaciones", un enlace sin contexto).
// Esto es lo que antes hacía que TODO apareciera igual de urgente en "esperando
// respuesta" — con esto, las reacciones bajan a su propia sección, sin mezclarse con
// los leads de verdad.
function esLeadRealSocial(texto) {
  const t = (texto || '').trim();
  if (!t) return false;
  const tieneEmail = /@/.test(t);
  const tieneNivel = /preprimaria|primaria|secundaria|bachillerato|kinder|kínder|párvulos|parvulos|jardín|jardin|infantil|preparatoria|grado|matr[ií]cula|inscripci[oó]n|admisi[oó]n|mensualidad|colegiatura|cuota|precio|informaci[oó]n/i.test(t);
  const tieneTelefono = /\d{8,}/.test(t.replace(/\D/g, '').length >= 8 ? t.replace(/\D/g, '') : '');
  // Si al quitar emojis y espacios casi no queda nada (solo un emoji, "🔥", "😍"), es reacción.
  const soloEmojiOMuyCorto = t.replace(/[\p{Emoji}\s]/gu, '').length < 8;
  const suficientesPalabras = t.split(/\s+/).filter(Boolean).length >= 4;
  return tieneEmail || tieneNivel || tieneTelefono || (!soloEmojiOMuyCorto && suficientesPalabras);
}

// ===== FUSIÓN CON INSTAGRAM / MESSENGER =====
    // Antes vivían en una pestaña aparte ("WhatsApp / IG / Messenger"). Ahora aparecen
    // aquí mismo, junto al número oficial, para que las vendedoras tengan una sola
    // bandeja — tal como se pidió. Son de solo lectura (no se les puede responder desde
    // aquí, coincide con CANALES_SOLO_LECTURA), pero sí deben verse en la misma lista.
    // El contacto_id de estos se marca con el prefijo "social_" (usando el _id de Mongo)
    // para que el frontend sepa distinguirlos al abrir el chat.
    try {
      const socialConvs = await Conversacion.find({
        tenant_id: req.user.tenant_id,
        canal: { $in: ['instagram', 'messenger'] }
      }).sort({ ultimaActividad: -1 }).limit(200).lean();

      const socialMapeadas = socialConvs.map(c => {
        const ultimo = (c.mensajes || [])[c.mensajes.length - 1];
        const textoUltimo = ultimo ? String(ultimo.texto || '') : '';
        return {
          contacto_id: `social_${c._id}`,
          nombre: c.nombre || (c.canal === 'instagram' ? 'IG — Orgánico' : 'FB — Orgánico'),
          numero: c.numero,
          canal: c.canal,
          es_social: true,
          solo_lectura: true,
          es_lead_real: esLeadRealSocial(textoUltimo),
          total_mensajes: (c.mensajes || []).length,
          no_leidos: 0,
          ultimo_mensaje: textoUltimo.substring(0, 120) || null,
          ultima_fecha: c.ultimaActividad ? new Date(c.ultimaActividad).toISOString().replace('T', ' ').substring(0, 19) : null,
          ultimo_de: (ultimo?.de === 'padre' && !c.revisado_social) ? 'padre' : 'agente',
          revisado_social: !!c.revisado_social,
          agente: c.agente_nombre || null,
          agente_fecha: null,
          etiquetas: [`Canal — ${c.canal === 'instagram' ? 'Instagram' : 'Messenger'}`],
          prioridad: '0',
          nota: null
        };
      });

      // Solo se trasladan los que parecen un lead real (con datos: correo, nivel,
      // teléfono, o un mensaje con contenido) — las reacciones sueltas a publicaciones
      // (emojis, "gracias", "felicidades") no interesan y no deben aparecer aquí.
      const socialConDatos = socialMapeadas.filter(c => c.es_lead_real);

      conversaciones = [...conversaciones, ...socialConDatos]
        .sort((a, b) => (b.ultima_fecha || '').localeCompare(a.ultima_fecha || ''));
    } catch (e) {
      // Si falla traer lo de Instagram/Messenger, se sigue mostrando AcruxLab normal (no bloqueante)
    }

    // Filtro por usuario: admin y viewer supervisan todo; vendedor solo ve lo suyo + lo sin atender
    // Verificamos el rol directo en la base de datos (no solo el del token) — así, si el
    // rol de alguien cambió después de que inició sesión, se respeta de inmediato sin
    // necesitar que cierre sesión y vuelva a entrar.
    const usuarioActual = await UsuarioPanel.findById(req.user.id).select('role');
    const rolReal = usuarioActual?.role || req.user.role;
    const esSupervisor = rolReal === 'admin' || rolReal === 'viewer';
    if (!esSupervisor) {
      // Comparación flexible por palabras, no exacta — en Odoo el nombre completo puede
      // traer un segundo apellido/nombre distinto al que está guardado en KAI (ej.
      // "Vanessa Lopez Carreto" en Odoo vs "Vanessa Carreto" en KAI). Si comparamos
      // exacto, nunca hace match y sus propios chats quedan invisibles para ella.
      const normalizar = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/\s+/).filter(Boolean);
      const misPalabras = normalizar(req.user.nombre);
      const nombreCoincide = (agente) => {
        const palabrasAgente = normalizar(agente);
        if (!palabrasAgente.length || !misPalabras.length) return false;
        // Coincide si comparten al menos 2 palabras (o todas, si el nombre es de 1 sola palabra)
        const coincidencias = misPalabras.filter(p => palabrasAgente.includes(p)).length;
        return coincidencias >= Math.min(2, misPalabras.length);
      };
      conversaciones = conversaciones.filter(c => !c.agente || nombreCoincide(c.agente));
    }

    res.json({ ok: true, canal: 'acrux_whatsapp', solo_lectura: false, es_supervisor: esSupervisor, total: conversaciones.length, conversaciones });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/acrux/conversaciones/:contactoId', authMiddleware, async (req, res) => {
  try {
    const contactoId = parseInt(req.params.contactoId);
    if (!contactoId) return res.json({ ok: false, error: 'ID de contacto inválido' });

    const mensajes = await odooCallLocal('acrux.chat.message', 'search_read',
      [[['contact_id', '=', contactoId]]],
      { fields: ['id', 'text', 'date_message', 'contact_id', 'msgid', 'from_me', 'read_date', 'user_id', 'ttype', 'res_model', 'res_id'], limit: 500, order: 'date_message asc' }
    );

    if (!mensajes) return res.json({ ok: false, error: 'No se pudo leer los mensajes de este contacto' });

    // Las imágenes vienen como ttype='image' apuntando a un ir.attachment (res_id) —
    // las traemos en un solo lote y las adjuntamos en base64 a cada mensaje.
    const idsAdjuntos = mensajes.filter(m => m.ttype === 'image' && m.res_model === 'ir.attachment' && m.res_id).map(m => m.res_id);
    let adjuntosPorId = {};
    if (idsAdjuntos.length) {
      try {
        const adjuntos = await odooCallLocal('ir.attachment', 'read', [idsAdjuntos, ['id', 'datas', 'mimetype']]);
        (adjuntos || []).forEach(a => { adjuntosPorId[a.id] = { base64: a.datas, mime: a.mimetype || 'image/jpeg' }; });
      } catch (e) { /* si falla, los mensajes de imagen se muestran solo con su texto */ }
    }

    const numero = mensajes.map(m => extraerNumeroDeMsgid(m.msgid)).find(Boolean) || null;
    const nombre = mensajes.find(m => m.contact_id)?.contact_id?.[1] || null;
    const asignacion = await AsignacionAcrux.findOne({ tenant_id: req.user.tenant_id, contacto_id: contactoId });

    res.json({
      ok: true,
      canal: 'acrux_whatsapp',
      solo_lectura: false, // Fase 2: el agente ya puede responder (ver /api/acrux/responder)
      contacto_id: contactoId,
      numero,
      nombre: nombre || numero || 'Sin nombre',
      modo: asignacion?.modo || 'bot',
      agente_asignado: asignacion?.agente_nombre || null,
      resumen_kai: asignacion?.resumen_kai || null,
      mensajes: mensajes.map(m => {
        const adjunto = m.ttype === 'image' ? adjuntosPorId[m.res_id] : null;
        return {
          de: m.from_me ? 'agente' : 'padre',
          texto: m.text || '',
          fecha: m.date_message,
          leido: !!m.read_date,
          agente: m.from_me ? (m.user_id ? m.user_id[1] : null) : null,
          es_imagen: m.ttype === 'image',
          imagen_base64: adjunto?.base64 || null,
          imagen_mime: adjunto?.mime || null
        };
      })
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== ACRUXLAB — Fase 2: el agente responde de verdad por el número oficial =====
// PRIMERA vez que escribimos algo hacia AcruxLab (todo lo anterior era solo lectura).
// Creamos un registro en acrux.chat.message con from_me=true; si el módulo de AcruxLab
// está bien instalado, su propio create()/write() debería disparar el envío real por
// WhatsApp. Esto hay que probarlo con un mensaje de prueba real antes de confiar en él.
// Diagnóstico: revisar el último mensaje SALIENTE (from_me=true) ya creado para un contacto,
// sin tener que mandar otro — útil para ver por qué el que ya se probó no llegó de verdad.
// Diagnóstico: comparar leads duplicados directamente por ID, para confirmar si
// realmente ninguno tiene la Nota llena (y por eso cae al más reciente) o si hay
// algún otro problema en la selección.
// Diagnóstico: ver los campos reales de acrux.chat.conversation (el modelo de la
// conversación, no del mensaje ni del lead). Sospecha: las etiquetas tipo "Cindy"/
// "Infantil" que se ven en el ChatRoom real viven aquí, no en crm.lead.
// Revisa el módulo de AcruxLab (whatsapp_connector) directamente en Odoo — versión
// instalada y fecha de la última actualización. Si alguien (el proveedor del módulo,
// o el equipo de TI del colegio) actualizó AcruxLab recientemente, aquí debería
// notarse — es la forma más directa de confirmar "¿cambiaron algo en Odoo?" con datos,
// no con sospecha.
// GET /api/debug/version-modulo-acrux
// Prueba controlada: SOLO lee una conversación (ni un solo write), y compara el agente
// antes y después — para confirmar si el simple hecho de leerla vía API (lo que hace
// nuestro propio motor cada 45 segundos, sin que ningún humano abra nada) ya dispara el
// mismo "auto-reclamo" que se vio al pasar el mouse en la interfaz de Odoo.
// GET /api/debug/probar-solo-lectura?contacto_id=8688
app.get('/api/debug/probar-solo-lectura', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const contactoId = parseInt(req.query.contacto_id);
    if (!contactoId) return res.json({ ok: false, error: 'Falta ?contacto_id=' });

    const antes = await odooCallLocal('acrux.chat.conversation', 'read', [[contactoId], ['id', 'agent_id']]);
    // Una lectura más, simulando exactamente lo que hace el motor cada 45 segundos
    // (search_read sobre mensajes recientes) — sin ningún write de por medio.
    await odooCallLocal('acrux.chat.message', 'search_read', [[['contact_id', '=', contactoId]]], { fields: ['id'], limit: 5 });
    const despues = await odooCallLocal('acrux.chat.conversation', 'read', [[contactoId], ['id', 'agent_id']]);

    res.json({
      ok: true,
      agente_antes: antes?.[0]?.agent_id?.[1] || 'ninguno',
      agente_despues: despues?.[0]?.agent_id?.[1] || 'ninguno',
      cambio_solo_por_leer: (antes?.[0]?.agent_id?.[1] || null) !== (despues?.[0]?.agent_id?.[1] || null)
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/debug/version-modulo-acrux', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const modulos = await odooCallLocal('ir.module.module', 'search_read',
      [[['name', 'like', 'whatsapp']]],
      { fields: ['name', 'shortdesc', 'installed_version', 'latest_version', 'state', 'write_date'] }
    ).catch(e => ({ error: e.message }));

    res.json({ ok: true, modulos: modulos || [], nota: 'Si "write_date" es reciente, alguien tocó/actualizó el módulo hace poco.' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/debug/acrux-campos-conversacion/:contactoId', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const contactoId = parseInt(req.params.contactoId);
    const campos = await odooCallLocal('acrux.chat.conversation', 'fields_get', [], { attributes: ['string', 'type', 'relation'] });
    const listaCampos = campos ? Object.entries(campos).map(([tecnico, def]) => ({ campo_tecnico: tecnico, etiqueta: def.string, tipo: def.type, relacion: def.relation || null })) : [];

    let registroCompleto = null;
    let etiquetasResueltas = [];
    if (contactoId) {
      const detalle = await odooCallLocal('acrux.chat.conversation', 'read', [[contactoId], []]);
      registroCompleto = detalle?.[0] || null;
      if (registroCompleto?.tag_ids?.length) {
        try {
          const tags = await odooCallLocal('acrux.chat.conversation.tag', 'read', [registroCompleto.tag_ids, ['id', 'name', 'color']]);
          etiquetasResueltas = tags || [];
        } catch (e) { /* sin permiso en Odoo para este modelo */ }
      }
    }

    res.json({ ok: true, total_campos: listaCampos.length, campos: listaCampos, registro: registroCompleto, etiquetas_resueltas: etiquetasResueltas });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/debug/comparar-leads/:ids', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const ids = req.params.ids.split(',').map(Number).filter(Boolean);
    const leads = await odooCallLocal('crm.lead', 'search_read',
      [[['id', 'in', ids]]],
      { fields: ['id', 'name', 'partner_name', 'contact_name', 'type', 'stage_id', 'phone', 'mobile', 'priority', 'tag_ids', 'x_studio_notas_1', 'x_studio_comentarios', 'write_date', 'create_date'] }
    );
    let etiquetas = {};
    const idsTagsUsados = [...new Set((leads || []).flatMap(l => l.tag_ids || []))];
    if (idsTagsUsados.length) {
      const tags = await odooCallLocal('crm.tag', 'search_read', [[['id', 'in', idsTagsUsados]]], { fields: ['id', 'name'] });
      (tags || []).forEach(t => { etiquetas[t.id] = t.name; });
    }
    res.json({ ok: true, leads: (leads || []).map(l => ({ ...l, tag_ids: (l.tag_ids || []).map(id => etiquetas[id]) })) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/debug/acrux-ultimo-saliente/:contactoId', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const contactoId = parseInt(req.params.contactoId);
    const limite = Math.min(parseInt(req.query.limit) || 3, 200);
    const domain = [['contact_id', '=', contactoId]];
    if (req.query.solo_ttype) domain.push(['ttype', '=', req.query.solo_ttype]);
    if (!req.query.todos) domain.push(['from_me', '=', true]);
    const mensajes = await odooCallLocal('acrux.chat.message', 'search_read',
      [domain],
      { fields: [], limit: limite, order: 'date_message desc' }
    );
    res.json({ ok: true, mensajes });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== Plantillas de respuesta rápida del ChatRoom (el panel del rayo ⚡) =====
app.get('/api/acrux/plantillas', authMiddleware, async (req, res) => {
  try {
    const uid = await getOdooUID();
    const plantillas = await odooRPC('/jsonrpc', { service: 'object', method: 'execute_kw', args: [ODOO_DB, uid, ODOO_PASS_ODOO, 'acrux.chat.default.answer', 'get_for_chatroom', [], { context: { is_acrux_chat_room: true } }] });
    res.json({
      ok: true,
      plantillas: (plantillas || []).map(p => ({
        id: p.id,
        nombre: p.name,
        es_imagen: p.ttype === 'image',
        texto: p.ttype === 'text' ? (p.text || p.name) : null
      }))
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Devuelve una conversación de AcruxLab a modo "bot" — para que KAI retome cuando
// el agente humano ya terminó de ayudar.
// Marca un chat como "en seguimiento humano" SIN necesidad de escribirle primero —
// para casos como agendar una visita por teléfono, donde la vendedora ya está
// trabajando al papá pero nunca escribió en el ChatRoom (así que el semáforo normal
// nunca lo habría detectado, y KAI seguiría atendiéndolo como si nadie lo tuviera).
// Sincroniza el agente de UNA conversación puntual de AcruxLab en Odoo — para probar el
// mecanismo con un solo caso real (ej. Karen Fuentes) ANTES de confiar en que el arreglo
// automático (ya en el código, pero conviene probarlo primero) funcione con todas las
// vendedoras. Solo toca la conversación que le pases, nada más.
// GET /api/debug/probar-sincronizar-agente?contacto_id=6927
// Muestra el registro CRUDO de AsignacionAcrux para una conversación — para detectar
// inconsistencias entre agente_id y agente_nombre (que no deberían pasar nunca, pero
// pasó con Karen Fuentes: el nombre decía Sylvia, el ID apuntaba a Cindy).
// GET /api/debug/ver-asignacion-cruda?contacto_id=6927
app.get('/api/debug/ver-asignacion-cruda', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const contactoId = parseInt(req.query.contacto_id);
    const asign = await AsignacionAcrux.findOne({ tenant_id: req.user.tenant_id, contacto_id: contactoId }).lean();
    if (!asign) return res.json({ ok: false, error: 'No existe registro de AsignacionAcrux para esa conversación' });

    const usuarioPorId = asign.agente_id ? await UsuarioPanel.findById(asign.agente_id).select('nombre email') : null;

    res.json({
      ok: true,
      registro_completo: asign,
      usuario_real_al_que_apunta_agente_id: usuarioPorId ? { id: usuarioPorId._id, nombre: usuarioPorId.nombre, email: usuarioPorId.email } : 'agente_id no existe o es nulo',
      coincide: usuarioPorId ? (usuarioPorId.nombre === asign.agente_nombre) : null
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Corrige el agente_id de UN registro puntual de AsignacionAcrux, cuando ya se confirmó
// con evidencia (Odoo + chatter) cuál es el vendedor correcto. Por email, para no
// depender de coincidencia de nombres. Sin ?aplicar=1 solo muestra qué haría.
// GET /api/debug/corregir-agente-id?contacto_id=6927&email=sylvia@capouilliez.edu.gt
// ===== AUDITORÍA: CONVERSACIONES DONDE ODOO DICE "ADMINISTRADOR" PERO NUESTRO SISTEMA
// SABE QUE ES DE UNA VENDEDORA REAL =====
// De SOLO LECTURA — no escribe absolutamente nada en Odoo ni en Mongo. Busca todas las
// conversaciones de AcruxLab activas (status='current') cuyo agente en Odoo es el
// usuario de servicio de KAI ("Administrador"), y las cruza con nuestro registro interno
// (AsignacionAcrux). Para cada una, además, revisa si el registro interno mismo está
// consistente (agente_id apunta al mismo nombre que agente_nombre) — porque ya
// encontramos un caso (Karen Fuentes) donde el registro interno también estaba mal.
// GET /api/debug/auditoria-agentes-acrux
// Reporte consolidado, en TEXTO legible (no JSON), de una lista de conversaciones
// puntuales — para compartir directo con el equipo y que confirmen. Para cada una
// verifica: el modo real (humano/bot — nunca sugiere tocar si Kai sigue atendiendo),
// el vendedor guardado, y el tipo real del lead en Odoo (Lead u Oportunidad).
// GET /api/debug/reporte-para-confirmar?contactos=8540,8537,2380,8509
// Busca TODOS los mensajes que salieron del número oficial en la última X horas, en
// CUALQUIER conversación, y marca cuáles son de números reales (no de prueba) — para
// encontrar con evidencia directa si algo sigue saliendo pese a la pausa, sin depender
// de que alguien indique el número exacto.
// GET /api/debug/actividad-reciente-acrux?horas=1
app.get('/api/debug/actividad-reciente-acrux', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const horas = parseFloat(req.query.horas) || 1;
    const desde = new Date(Date.now() - horas * 60 * 60 * 1000);
    const desdeStr = desde.toISOString().replace('T', ' ').substring(0, 19);

    // Mensajes salientes ("from_me") recientes, en cualquier conversación
    const mensajes = await odooCallLocal('acrux.chat.message', 'search_read',
      [[['from_me', '=', true], ['date_message', '>=', desdeStr]]],
      { fields: ['id', 'contact_id', 'text', 'date_message'], limit: 200, order: 'date_message desc' }
    ) || [];

    if (!mensajes.length) return res.json({ ok: true, total: 0, mensaje: `No salió ningún mensaje del número oficial en la última${horas === 1 ? ' hora' : 's ' + horas + ' horas'}.` });

    // Traer el número de cada conversación para poder filtrar los de prueba
    const idsConv = [...new Set(mensajes.map(m => m.contact_id?.[0]).filter(Boolean))];
    const conversaciones = await odooCallLocal('acrux.chat.conversation', 'read', [idsConv, ['id', 'number']]).catch(() => []);
    const numeroPorConvId = {};
    (conversaciones || []).forEach(c => { numeroPorConvId[c.id] = c.number; });

    const detalle = mensajes.map(m => {
      const numero = numeroPorConvId[m.contact_id?.[0]] || 'desconocido';
      const esPrueba = esNumeroDePrueba(numero);
      return {
        conversacion: m.contact_id?.[0], numero,
        es_numero_de_prueba: esPrueba,
        fecha: m.date_message,
        texto: (m.text || '').substring(0, 150)
      };
    });

    const reales = detalle.filter(d => !d.es_numero_de_prueba);

    res.json({
      ok: true,
      total_mensajes_salientes: detalle.length,
      total_de_numeros_de_prueba: detalle.length - reales.length,
      total_de_numeros_reales_ALERTA: reales.length,
      detalle_numeros_reales: reales,
      detalle_completo: detalle
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ===== REPORTE: TODOS LOS ATENDIDOS ESTA SEMANA + VISIBILIDAD REAL EN ODOO =====
// De SOLO LECTURA. Trae cada conversación de AcruxLab que Kai puso en modo "humano"
// (es decir, que atendió y traspasó) en el período pedido, y para cada una revisa si el
// agente que Odoo muestra HOY es una vendedora real y visible, o si sigue siendo
// "Administrador" — que es lo que la deja invisible en el ChatRoom de cada vendedora.
// GET /api/debug/reporte-atendidos-semana?dias=7
// ===== REPORTE: TODOS LOS CONTACTOS DE UN RANGO DE FECHAS EXACTO, SIN EXCEPCIÓN =====
// De SOLO LECTURA. A diferencia del reporte de "atendidos", este trae TODO — sin
// filtrar por si se traspasó o no — para poder rastrear qué pasó con cada lead que
// entró en el rango, esté como esté (bot, humano, sin responder, lo que sea).
// GET /api/debug/reporte-rango-fechas?desde=2026-07-17&hasta=2026-07-24
// Copia los mensajes de una o varias conversaciones de AcruxLab a NUESTRA base de
// datos, para tener respaldo propio, independiente de Odoo. Se puede correr las veces
// que se quiera — no duplica mensajes ya guardados (por mensaje_id_odoo único).
// GET /api/debug/respaldar-mensajes?contactos=6081,8641,7536 (o ?todos=1 para respaldar
// TODAS las conversaciones existentes en Odoo, en lote)
app.get('/api/debug/respaldar-mensajes', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    let contactoIds;
    if (req.query.desde && req.query.hasta) {
      // Acotado por rango de fechas — mucho más rápido que "todos", evita el 502 por
      // tardar demasiado. Filtra por cuándo se creó la conversación en Odoo.
      const desdeStr = req.query.desde + ' 00:00:00';
      const hastaStr = req.query.hasta + ' 23:59:59';
      const conv = await odooCallLocal('acrux.chat.conversation', 'search_read',
        [[['create_date', '>=', desdeStr], ['create_date', '<=', hastaStr]]], { fields: ['id'], limit: 2000 }
      ).catch(() => []);
      contactoIds = (conv || []).map(c => c.id);
    } else if (req.query.todos === '1') {
      const todasLasConv = await odooCallLocal('acrux.chat.conversation', 'search_read', [[]], { fields: ['id'], limit: 5000 }).catch(() => []);
      contactoIds = (todasLasConv || []).map(c => c.id);
    } else {
      contactoIds = String(req.query.contactos || '').split(',').map(n => parseInt(n.trim())).filter(Boolean);
    }
    if (!contactoIds.length) return res.json({ ok: false, error: 'Falta ?contactos=6081,8641,... o ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD o ?todos=1' });

    // Responde DE INMEDIATO — el trabajo sigue en segundo plano, para nunca toparse con
    // el límite de tiempo de Railway (eso fue lo que causó el 502 la primera vez).
    const tenantId = req.user.tenant_id; // se captura ahora, por si "req" ya no es válido más tarde
    res.json({ ok: true, mensaje: `Respaldo iniciado en segundo plano para ${contactoIds.length} conversación(es). Revisa el avance en unos minutos con /api/debug/ver-respaldo, o mira los logs del servidor.`, total_conversaciones: contactoIds.length });

    (async () => {
      let totalGuardados = 0, totalYaExistian = 0, conversacionesProcesadas = 0;
      const errores = [];

      for (const contactoId of contactoIds) {
        try {
          const conv = await odooCallLocal('acrux.chat.conversation', 'read', [[contactoId], ['id', 'number']]);
          const numero = conv?.[0]?.number ? String(conv[0].number).replace(/\D/g, '') : null;

          const mensajes = await odooCallLocal('acrux.chat.message', 'search_read',
            [[['contact_id', '=', contactoId]]],
            { fields: ['id', 'text', 'from_me', 'date_message'], limit: 500, order: 'date_message asc' }
          ).catch(() => []);

          for (const m of mensajes) {
            try {
              await MensajeRespaldo.create({
                tenant_id: tenantId,
                contacto_id_acrux: contactoId,
                numero,
                mensaje_id_odoo: m.id,
                de: m.from_me ? 'colegio' : 'padre',
                texto: m.text || '',
                fecha_mensaje: m.date_message ? new Date(m.date_message.replace(' ', 'T') + 'Z') : null
              });
              totalGuardados++;
            } catch (e) {
              if (e.code === 11000) totalYaExistian++; // ya estaba respaldado, no es error real
              else throw e;
            }
          }
          conversacionesProcesadas++;
        } catch (e) { errores.push({ contacto_id: contactoId, error: e.message }); }
      }
      console.log(`💾 [Respaldo manual] Terminado — ${conversacionesProcesadas} conversaciones, ${totalGuardados} mensajes nuevos, ${totalYaExistian} ya existían, ${errores.length} errores`);
    })().catch(e => console.error('❌ [Respaldo manual] Error en segundo plano:', e.message));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Consulta el respaldo propio — funciona aunque Odoo esté caído o haya perdido datos.
// GET /api/debug/ver-respaldo?numero=502... o ?contacto_id=6081
// ===== CONFIRMAR Y MARCAR CASOS SIN CONVERSACIÓN REAL EN ACRUXLAB =====
// Para cada número de la lista: busca la conversación con el método individual
// (confiable, no el masivo que puede fallar si hay más de 5000 conversaciones). Si
// confirma que NO existe, deja una nota clara en el chatter del lead para que el
// equipo le dé seguimiento MANUAL hoy mismo — no se le escribe nada automático,
// no se toca el estado, no se asigna nada. Solo se avisa con evidencia.
// GET /api/debug/confirmar-y-marcar-sin-contacto?numeros=502...,502...&aplicar=1
app.get('/api/debug/confirmar-y-marcar-sin-contacto', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const numeros = String(req.query.numeros || '').split(',').map(n => n.trim()).filter(Boolean);
    if (!numeros.length) return res.json({ ok: false, error: 'Falta ?numeros=502...,502...' });
    const aplicar = req.query.aplicar === '1';

    const resultado = [];
    for (const numero of numeros) {
      const ultimos8 = numero.replace(/\D/g, '').slice(-8);
      const conv = await odooCallLocal('acrux.chat.conversation', 'search_read',
        [[['number', 'like', ultimos8]]], { fields: ['id'], limit: 1, context: { active_test: false } }
      ).catch(() => []);

      if (conv && conv.length) {
        resultado.push({ numero, confirmado_sin_conversacion: false, accion: 'Sí tiene conversación — no se toca, no era un caso real' });
        continue;
      }

      // Confirmado: no existe conversación real. Buscar el lead vinculado para dejar la nota.
      const contacto = await Contacto.findOne({ tenant_id: req.user.tenant_id, numero: numero.replace(/\D/g, '') }).lean();
      const item = { numero, nombre: contacto?.nombre || null, nivel: contacto?.nivel_interes || null, confirmado_sin_conversacion: true, lead_odoo_id: contacto?.odoo_lead_id || null };

      if (contacto?.odoo_lead_id && aplicar) {
        await odooCallLocal('crm.lead', 'message_post', [[contacto.odoo_lead_id]], {
          body: `⚠️ <b>Revisión del 24/07</b>: se confirmó que este contacto NO tiene ninguna conversación real en AcruxLab, a pesar de que nuestro sistema lo marcó como "ya contactado" el ${contacto.ultimo_contacto ? new Date(contacto.ultimo_contacto).toLocaleDateString('es-GT') : ''}. Es muy probable que el mensaje nunca haya llegado de verdad. <b>Requiere seguimiento manual del equipo hoy mismo.</b>`
        }).catch(e => { item.error_nota = e.message; });
        item.accion = 'Nota dejada en el chatter del lead';
      } else if (!contacto?.odoo_lead_id) {
        item.accion = 'Sin lead vinculado — revisar a mano';
      } else {
        item.accion = 'Confirmado — vista previa (agrega &aplicar=1 para dejar la nota en Odoo)';
      }
      resultado.push(item);
    }

    const confirmados = resultado.filter(r => r.confirmado_sin_conversacion);
    res.json({
      ok: true,
      modo: aplicar ? 'EJECUTADO — notas dejadas en Odoo' : 'VISTA PREVIA — agrega &aplicar=1 para dejar la nota',
      total_revisados: resultado.length,
      total_confirmados_sin_conversacion: confirmados.length,
      lista_para_llamar_hoy: confirmados.map(c => ({ numero: c.numero, nombre: c.nombre, nivel: c.nivel })),
      detalle: resultado
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ===== COMPARACIÓN: NUESTRO RESPALDO vs LO QUE EXISTE EN ODOO AHORA MISMO =====
// De SOLO LECTURA. Responde directamente la pregunta "¿las conversaciones que Kai
// atendió quedan SOLO en nuestro sistema, o también en AcruxLab?" — con números
// exactos, no con impresiones. Para cada conversación que Kai tocó en el rango,
// confirma si esa misma conversación EXISTE en Odoo ahora mismo.
// GET /api/debug/comparar-respaldo-vs-odoo?desde=2026-07-17&hasta=2026-07-24
// Completa el nombre real de los contactos de Instagram/Messenger que YA EXISTÍAN
// antes de hoy (cuando se guardaba "null" a propósito) — consulta la Graph API de Meta
// para cada uno que todavía no tenga un nombre real. De solo escritura sobre nuestra
// propia base de datos (Mongo), nunca toca Odoo.
// GET /api/debug/completar-nombres-sociales?aplicar=1
app.get('/api/debug/completar-nombres-sociales', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const aplicar = req.query.aplicar === '1';
    const sinNombreReal = await Conversacion.find({
      tenant_id: req.user.tenant_id,
      canal: { $in: ['instagram', 'messenger'] },
      $or: [
        { nombre: null },
        { nombre: /^(IG|FB) — Orgánico$/ },
        { nombre: /^(ig|fb)_/ }
      ]
    }).select('_id numero canal nombre').lean();

    if (!sinNombreReal.length) return res.json({ ok: true, total: 0, mensaje: 'No hay ninguno pendiente — todos ya tienen nombre real o ya se intentó.' });

    const detalle = [];
    for (const c of sinNombreReal) {
      const psid = String(c.numero || '').replace(/^(ig_|fb_)/, '');
      const token = c.canal === 'instagram'
        ? (process.env.INSTAGRAM_PAGE_TOKEN || process.env.WHATSAPP_TOKEN)
        : (process.env.MESSENGER_PAGE_TOKEN || process.env.WHATSAPP_TOKEN);
      const nombreReal = await obtenerNombreFacebook(psid, token);

      if (nombreReal && aplicar) {
        await Conversacion.updateOne({ _id: c._id }, { nombre: nombreReal });
      }
      detalle.push({ contacto_id: `social_${c._id}`, numero: c.numero, nombre_antes: c.nombre, nombre_encontrado: nombreReal || '(no disponible en Meta)' });
    }

    res.json({
      ok: true,
      modo: aplicar ? 'EJECUTADO' : 'VISTA PREVIA — agrega &aplicar=1 para guardar',
      total_revisados: detalle.length,
      total_con_nombre_encontrado: detalle.filter(d => d.nombre_encontrado !== '(no disponible en Meta)').length,
      detalle
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/debug/comparar-respaldo-vs-odoo', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const desde = new Date(req.query.desde + 'T00:00:00');
    const hasta = new Date(req.query.hasta + 'T23:59:59');
    if (isNaN(desde) || isNaN(hasta)) return res.json({ ok: false, error: 'Formato: ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD' });

    // Todas las conversaciones donde Kai escribió algo (respaldo propio) en el rango
    const contactoIds = await MensajeRespaldo.distinct('contacto_id_acrux', {
      tenant_id: req.user.tenant_id,
      de: 'colegio',
      fecha_mensaje: { $gte: desde, $lte: hasta }
    });

    if (!contactoIds.length) return res.json({ ok: true, total: 0, mensaje: 'No hay mensajes de Kai respaldados en ese rango (revisa que el respaldo se haya corrido para esas fechas).' });

    // Verificar, uno por uno, si esa conversación existe HOY en Odoo
    const detalle = [];
    for (const id of contactoIds) {
      const conv = await odooCallLocal('acrux.chat.conversation', 'read', [[id], ['id', 'number', 'agent_id']]).catch(() => null);
      const numeroDeMongo = await MensajeRespaldo.findOne({ contacto_id_acrux: id }).select('numero').lean();
      detalle.push({
        contacto_id: id,
        numero: numeroDeMongo?.numero || null,
        existe_en_odoo_ahora: !!(conv && conv.length),
        agente_en_odoo: conv?.[0]?.agent_id?.[1] || null
      });
    }

    const siExisten = detalle.filter(d => d.existe_en_odoo_ahora);
    const noExisten = detalle.filter(d => !d.existe_en_odoo_ahora);

    res.json({
      ok: true,
      rango: { desde: req.query.desde, hasta: req.query.hasta },
      total_conversaciones_donde_kai_escribio: detalle.length,
      existen_en_los_dos_lados: siExisten.length,
      solo_en_nuestro_respaldo_no_en_odoo: noExisten.length,
      porcentaje_visible_en_odoo: `${Math.round((siExisten.length / detalle.length) * 100)}%`,
      detalle_de_los_que_faltan_en_odoo: noExisten,
      detalle_completo: detalle
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Cuenta cuántos mensajes ya se han respaldado — para revisar el avance del proceso en
// segundo plano sin tener que esperar a que termine.
// GET /api/debug/progreso-respaldo
// Prueba directa: busca UNA imagen de la secuencia no interactiva y la intenta enviar
// por AcruxLab, devolviendo el error real si falla — para diagnosticar sin tener que
// repetir todo el flujo de conversación.
// GET /api/debug/probar-imagen-no-interactivo?nivel=preprimaria&contacto_id=8657
app.get('/api/debug/probar-imagen-no-interactivo', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const nivel = req.query.nivel;
    const contactoId = parseInt(req.query.contacto_id);
    if (!nivel || !SECUENCIA_IMAGENES_NO_INTERACTIVO[nivel]) return res.json({ ok: false, error: 'Falta ?nivel=preprimaria|primaria|secundaria' });
    if (!contactoId) return res.json({ ok: false, error: 'Falta ?contacto_id= (una conversación real de AcruxLab)' });

    const tenant = await Tenant.findOne({ activo: true });
    const resultados = [];
    for (const filtro of SECUENCIA_IMAGENES_NO_INTERACTIVO[nivel]) {
      const img = await buscarImagenSecuenciaNI(tenant, filtro);
      if (!img) { resultados.push({ filtro, encontrada: false }); continue; }
      try {
        const adjunto = await subirImagenNuevaAcrux(img.imagen_base64, `${img.nombre}.jpg`, img.mime_type || 'image/jpeg', contactoId);
        await odooCallLocal('acrux.chat.conversation', 'send_message', [[contactoId], {
          text: construirDescripcionImagen(img), from_me: true, ttype: 'image', res_model: 'ir.attachment', res_id: adjunto.id,
          id: -2, date_message: new Date().toISOString().replace('T', ' ').substring(0, 19), button_ids: []
        }], { context: { lang: 'es_GT', tz: 'America/Guatemala', is_acrux_chat_room: true } });
        resultados.push({ filtro, encontrada: true, imagen: img.nombre, enviada: true });
      } catch (e) {
        resultados.push({ filtro, encontrada: true, imagen: img.nombre, enviada: false, error: e.message });
      }
    }
    res.json({ ok: true, resultados });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/debug/progreso-respaldo', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const total = await MensajeRespaldo.countDocuments({ tenant_id: req.user.tenant_id });
    const conversacionesDistintas = (await MensajeRespaldo.distinct('contacto_id_acrux', { tenant_id: req.user.tenant_id })).length;
    res.json({ ok: true, total_mensajes_respaldados: total, total_conversaciones_distintas: conversacionesDistintas });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/debug/ver-respaldo', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const filtro = { tenant_id: req.user.tenant_id };
    if (req.query.numero) filtro.numero = String(req.query.numero).replace(/\D/g, '');
    if (req.query.contacto_id) filtro.contacto_id_acrux = parseInt(req.query.contacto_id);
    if (!filtro.numero && !filtro.contacto_id_acrux) return res.json({ ok: false, error: 'Falta ?numero= o ?contacto_id=' });

    const mensajes = await MensajeRespaldo.find(filtro).sort({ fecha_mensaje: 1 }).limit(500).lean();
    res.json({ ok: true, total: mensajes.length, mensajes: mensajes.map(m => ({ de: m.de, texto: m.texto, fecha: m.fecha_mensaje })) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ===== COMPARACIÓN DIRECTA: MENSAJES EN ODOO VS. MENSAJES EN NUESTRO PROPIO SISTEMA =====
// De SOLO LECTURA. Para confirmar (o descartar) con evidencia si las conversaciones
// están de verdad en los dos lados o solo en uno. Para cada contacto del rango, cuenta
// los mensajes reales que existen HOY en Odoo (acrux.chat.message) y los compara contra
// los que tenemos en nuestro propio respaldo (MensajeRespaldo) y en el modelo de
// WhatsApp directo (Conversacion). Si un número aparece con mensajes en KAI pero 0 en
// Odoo, ahí SÍ habría evidencia real de que "solo Kai se quedó con la conversación".
// GET /api/debug/comparar-odoo-vs-kai?desde=2026-07-17&hasta=2026-07-24
app.get('/api/debug/comparar-odoo-vs-kai', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const desde = new Date(req.query.desde + 'T00:00:00');
    const hasta = new Date(req.query.hasta + 'T23:59:59');
    if (isNaN(desde) || isNaN(hasta)) return res.json({ ok: false, error: 'Formato: ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD' });

    const contactos = await Contacto.find({
      tenant_id: req.user.tenant_id,
      primer_contacto: { $gte: desde, $lte: hasta },
      numero: { $nin: NUMEROS_DE_PRUEBA }
    }).sort({ primer_contacto: 1 }).limit(500).lean();

    if (!contactos.length) return res.json({ ok: true, total: 0, mensaje: `Ningún contacto entre ${req.query.desde} y ${req.query.hasta}` });

    // Todas las conversaciones de AcruxLab, para encontrar el ID de cada número
    const conversacionesOdoo = await odooCallLocal('acrux.chat.conversation', 'search_read',
      [[]], { fields: ['id', 'number'], limit: 5000 }
    ).catch(() => []);
    const convIdPorNumero = {};
    (conversacionesOdoo || []).forEach(c => { const n = String(c.number || '').replace(/\D/g, ''); if (n) convIdPorNumero[n] = c.id; });

    const detalle = [];
    for (const c of contactos) {
      const convId = convIdPorNumero[c.numero];
      let mensajesEnOdoo = 0;
      if (convId) {
        const msgs = await odooCallLocal('acrux.chat.message', 'search_read',
          [[['contact_id', '=', convId]]], { fields: ['id'], limit: 1000 }
        ).catch(() => []);
        mensajesEnOdoo = (msgs || []).length;
      }

      const mensajesEnRespaldo = await MensajeRespaldo.countDocuments({ tenant_id: req.user.tenant_id, numero: c.numero });
      const mensajesEnConversacionWA = await Conversacion.findOne({ tenant_id: req.user.tenant_id, numero: c.numero }).select('historial').lean();
      const totalEnConversacionWA = mensajesEnConversacionWA?.historial?.length || 0;

      const totalEnKai = mensajesEnRespaldo + totalEnConversacionWA;
      let veredicto;
      if (mensajesEnOdoo > 0 && totalEnKai > 0) veredicto = '✅ Existe en los dos lados';
      else if (mensajesEnOdoo > 0 && totalEnKai === 0) veredicto = '✅ Existe en Odoo (aún no respaldado en KAI, no es un problema)';
      else if (mensajesEnOdoo === 0 && totalEnKai > 0) veredicto = '⚠️ SOLO en KAI — esto es lo que reportan las vendedoras, revisar';
      else veredicto = '⚠️ No se encontró en ningún lado';

      detalle.push({
        numero: c.numero,
        nombre: c.nombre || '(sin nombre)',
        canal: c.canal_origen || '',
        primer_contacto: c.primer_contacto,
        conversacion_id_odoo: convId || null,
        mensajes_en_odoo: mensajesEnOdoo,
        mensajes_en_kai: totalEnKai,
        veredicto
      });
    }

    res.json({
      ok: true,
      rango: { desde: req.query.desde, hasta: req.query.hasta },
      total: detalle.length,
      en_los_dos_lados: detalle.filter(d => d.veredicto.startsWith('✅ Existe en los dos')).length,
      solo_en_odoo: detalle.filter(d => d.veredicto.includes('Existe en Odoo')).length,
      solo_en_kai_confirmado: detalle.filter(d => d.veredicto.includes('SOLO en KAI')).length,
      en_ningun_lado: detalle.filter(d => d.veredicto.includes('No se encontró')).length,
      detalle
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/debug/reporte-rango-fechas', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const desde = new Date(req.query.desde + 'T00:00:00');
    const hasta = new Date(req.query.hasta + 'T23:59:59');
    if (isNaN(desde) || isNaN(hasta)) return res.json({ ok: false, error: 'Formato: ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD' });

    const contactos = await Contacto.find({
      tenant_id: req.user.tenant_id,
      primer_contacto: { $gte: desde, $lte: hasta },
      numero: { $nin: NUMEROS_DE_PRUEBA }
    }).sort({ primer_contacto: 1 }).lean();

    if (!contactos.length) return res.json({ ok: true, total: 0, mensaje: `Ningún contacto entre ${req.query.desde} y ${req.query.hasta}` });

    // Vendedor real en Odoo, de un solo golpe
    const idsOdoo = contactos.filter(c => c.odoo_lead_id).map(c => c.odoo_lead_id);
    let porLeadOdoo = {};
    if (idsOdoo.length) {
      const leadsOdoo = await odooCallLocal('crm.lead', 'read',
        [idsOdoo, ['id', 'user_id', 'stage_id', 'type', 'active']], { context: { active_test: false } }
      ).catch(() => []);
      (leadsOdoo || []).forEach(l => {
        porLeadOdoo[l.id] = { vendedor: l.user_id?.[1] || 'Sin asignar', etapa: l.stage_id?.[1] || '', tipo: l.type === 'opportunity' ? 'Oportunidad' : 'Lead', activo: l.active };
      });
    }

    // Estado real de AsignacionAcrux (modo, agente) para cada uno
    const asignaciones = await AsignacionAcrux.find({ tenant_id: req.user.tenant_id }).lean();
    const asignPorContactoId = {};
    asignaciones.forEach(a => { asignPorContactoId[a.contacto_id] = a; });

    // Vincular por número -> conversación de AcruxLab, para saber el contacto_id de cada
    // uno. Se compara por los ÚLTIMOS 8 DÍGITOS, no por el número completo — porque
    // Odoo puede guardar el mismo número con espacios, guiones, o sin código de país
    // (ya nos pasó antes con Nery Mejía: "+502 4214 0856" vs "50242140856").
    const conversaciones = await odooCallLocal('acrux.chat.conversation', 'search_read',
      [[]], { fields: ['id', 'number'], limit: 5000 }
    ).catch(() => []);
    const convIdPorUltimos8 = {};
    (conversaciones || []).forEach(c => {
      const n = String(c.number || '').replace(/\D/g, '');
      const ultimos8 = n.slice(-8);
      if (ultimos8.length === 8) convIdPorUltimos8[ultimos8] = c.id;
    });

    const detalle = contactos.map(c => {
      const odoo = c.odoo_lead_id ? porLeadOdoo[c.odoo_lead_id] : null;
      const ultimos8DelContacto = String(c.numero || '').replace(/\D/g, '').slice(-8);
      const convId = convIdPorUltimos8[ultimos8DelContacto];
      const asign = convId ? asignPorContactoId[convId] : null;
      return {
        numero: c.numero,
        nombre: c.nombre || '(sin nombre)',
        nivel: c.nivel_interes || '',
        canal: c.canal_origen || '',
        primer_contacto: c.primer_contacto,
        ultimo_contacto: c.ultimo_contacto,
        total_conversaciones: c.total_conversaciones || 0,
        vendedor_en_odoo: odoo?.vendedor || (c.odoo_lead_id ? 'lead sin datos' : 'sin lead vinculado'),
        tipo_en_odoo: odoo?.tipo || '',
        etapa_en_odoo: odoo?.etapa || '',
        modo_en_kai: asign?.modo || 'sin registro',
        vendedor_segun_kai: asign?.agente_nombre || null,
        contacto_id_acrux: convId || null,
        conversacion_encontrada_en_odoo: !!convId
      };
    });

    res.json({
      ok: true,
      rango: { desde: req.query.desde, hasta: req.query.hasta },
      total: detalle.length,
      sin_conversacion_encontrada_en_odoo: detalle.filter(d => !d.conversacion_encontrada_en_odoo).length,
      detalle
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ===== AUDITORÍA: QUÉ LE HIZO KAI A TODAS LAS OPORTUNIDADES =====
// De SOLO LECTURA. Trae TODAS las Oportunidades (activas Y archivadas) y revisa, en el
// chatter de cada una, si hay algún mensaje escrito por Kai (nuestras notas tienen
// firmas reconocibles: 🌡️ cambio de calor, 📱 contacto, ♻️ duplicado, ⚠️ revisiones).
// Así se sabe con certeza si Kai archivó algo, le cambió el vendedor, o solo dejó nota.
// GET /api/debug/auditoria-oportunidades
app.get('/api/debug/auditoria-oportunidades', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const oportunidades = await odooCallLocal('crm.lead', 'search_read',
      [[['type', '=', 'opportunity']]],
      { fields: ['id', 'name', 'partner_name', 'contact_name', 'phone', 'user_id', 'stage_id', 'active', 'tag_ids', 'write_date'], limit: 500, context: { active_test: false } }
    ) || [];

    if (!oportunidades.length) return res.json({ ok: true, total: 0, mensaje: 'No hay ninguna Oportunidad en Odoo.' });

    const idsTags = [...new Set(oportunidades.flatMap(o => o.tag_ids || []))];
    let nombresTag = {};
    if (idsTags.length) {
      const tags = await odooCallLocal('crm.tag', 'read', [idsTags, ['id', 'name']]).catch(() => []);
      (tags || []).forEach(t => { nombresTag[t.id] = t.name; });
    }

    const FIRMAS_DE_KAI = /🌡️|📱 KAI|♻️.*Registro repetido|⚠️.*Revisión del|KAI leyó el correo|Nivel de calor actualizado por KAI/;

    const detalle = [];
    for (const o of oportunidades) {
      const mensajes = await odooCallLocal('mail.message', 'search_read',
        [[['model', '=', 'crm.lead'], ['res_id', '=', o.id]]],
        { fields: ['body', 'date', 'author_id'], limit: 50, order: 'date asc' }
      ).catch(() => []);

      const mensajesDeKai = mensajes.filter(m => FIRMAS_DE_KAI.test(m.body || '') || m.author_id?.[1] === 'Administrador');
      const etiquetas = (o.tag_ids || []).map(t => nombresTag[t]).filter(Boolean);

      detalle.push({
        lead: o.id,
        nombre: o.partner_name || o.contact_name || o.name,
        telefono: o.phone || null,
        vendedor_actual: o.user_id?.[1] || 'Sin asignar',
        etapa: o.stage_id?.[1] || '',
        activo: o.active,
        etiquetas,
        kai_le_escribio_algo: mensajesDeKai.length > 0,
        cuantos_mensajes_de_kai: mensajesDeKai.length,
        ultima_modificacion: o.write_date,
        notas_de_kai: mensajesDeKai.map(m => ({ fecha: m.date, texto: (m.body || '').replace(/<[^>]+>/g, ' ').trim().substring(0, 200) }))
      });
    }

    res.json({
      ok: true,
      total_oportunidades: detalle.length,
      archivadas: detalle.filter(d => !d.activo).length,
      activas: detalle.filter(d => d.activo).length,
      con_alguna_nota_de_kai: detalle.filter(d => d.kai_le_escribio_algo).length,
      sin_ninguna_nota_de_kai: detalle.filter(d => !d.kai_le_escribio_algo).length,
      detalle
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/debug/reporte-atendidos-semana', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const dias = parseInt(req.query.dias) || 7;
    const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);

    // Todo lo que Kai atendió y marcó como traspasado a humano en el período
    const asignaciones = await AsignacionAcrux.find({
      tenant_id: req.user.tenant_id,
      modo: 'humano',
      fecha_modo_humano: { $gte: desde }
    }).sort({ fecha_modo_humano: -1 }).limit(300).lean();

    if (!asignaciones.length) return res.json({ ok: true, total: 0, mensaje: `No hay conversaciones atendidas y traspasadas en los últimos ${dias} días.` });

    const idsConv = asignaciones.map(a => a.contacto_id);
    const conversacionesOdoo = await odooCallLocal('acrux.chat.conversation', 'read',
      [idsConv, ['id', 'number', 'agent_id', 'status']]
    ).catch(() => []);
    const convPorId = {};
    (conversacionesOdoo || []).forEach(c => { convPorId[c.id] = c; });

    const detalle = asignaciones.map(a => {
      const conv = convPorId[a.contacto_id];
      const agenteEnOdoo = conv?.agent_id?.[1] || 'ninguno';
      const esInvisibleParaElEquipo = !agenteEnOdoo || /^administrador$/i.test(agenteEnOdoo);
      return {
        contacto_id: a.contacto_id,
        numero: conv?.number || 'desconocido',
        vendedora_segun_kai: a.agente_nombre || 'ninguna',
        agente_visible_en_odoo: agenteEnOdoo,
        visible_para_el_equipo: !esInvisibleParaElEquipo,
        fecha_traspaso: a.fecha_modo_humano
      };
    });

    const invisibles = detalle.filter(d => !d.visible_para_el_equipo);

    res.json({
      ok: true,
      periodo_dias: dias,
      total_atendidos_y_traspasados: detalle.length,
      total_invisibles_para_el_equipo: invisibles.length,
      total_visibles: detalle.length - invisibles.length,
      detalle_invisibles: invisibles,
      detalle_completo: detalle
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/debug/reporte-para-confirmar', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const contactoIds = String(req.query.contactos || '').split(',').map(n => parseInt(n.trim())).filter(Boolean);
    if (!contactoIds.length) return res.json({ ok: false, error: 'Falta ?contactos=8540,8537,...' });

    const asignaciones = await AsignacionAcrux.find({ tenant_id: req.user.tenant_id, contacto_id: { $in: contactoIds } }).lean();
    const porContacto = {};
    asignaciones.forEach(a => { porContacto[a.contacto_id] = a; });

    const conversacionesOdoo = await odooCallLocal('acrux.chat.conversation', 'read',
      [contactoIds, ['id', 'number', 'agent_id', 'status']]
    ).catch(() => []);
    const convPorId = {};
    (conversacionesOdoo || []).forEach(c => { convPorId[c.id] = c; });

    let texto = `REPORTE PARA CONFIRMAR — ${new Date().toLocaleString('es-GT', { timeZone: 'America/Guatemala' })}\n`;
    texto += `${'='.repeat(60)}\n\n`;

    for (const id of contactoIds) {
      const asign = porContacto[id];
      const conv = convPorId[id];
      texto += `Conversación #${id} — ${conv?.number || 'número desconocido'}\n`;
      if (!asign) {
        texto += `  Sin registro interno — nada que confirmar.\n\n`;
        continue;
      }
      texto += `  Modo en KAI: ${asign.modo === 'humano' ? '👤 humano' : '🤖 bot (KAI todavía atendiendo)'}\n`;
      texto += `  Vendedor guardado: ${asign.agente_nombre || 'ninguno'}\n`;
      texto += `  Agente actual en Odoo: ${conv?.agent_id?.[1] || 'ninguno'}\n`;

      // Buscar el lead vinculado por nuestro propio Contacto (más confiable que por teléfono)
      const numeroLimpio = String(conv?.number || '').replace(/\D/g, '');
      const contacto = numeroLimpio ? await Contacto.findOne({ tenant_id: req.user.tenant_id, numero: numeroLimpio }).lean() : null;
      if (contacto?.odoo_lead_id) {
        const lead = await odooCallLocal('crm.lead', 'read', [[contacto.odoo_lead_id], ['id', 'type', 'stage_id', 'user_id']], { context: { active_test: false } }).catch(() => null);
        if (lead?.[0]) {
          texto += `  Tipo en Odoo: ${lead[0].type === 'opportunity' ? '🔴 OPORTUNIDAD' : 'Lead'} (${lead[0].stage_id?.[1] || ''})\n`;
          texto += `  Vendedor en el lead de Odoo: ${lead[0].user_id?.[1] || 'Sin asignar'}\n`;
        }
      } else {
        texto += `  Sin vínculo de lead guardado en nuestro sistema.\n`;
      }

      texto += `  → ${asign.modo === 'humano' ? '✅ Se puede sincronizar con confianza' : '⛔ NO tocar — Kai sigue atendiendo'}\n\n`;
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(texto);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/debug/auditoria-agentes-acrux', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const uidServicio = await getOdooUID();

    // 1) Todas las conversaciones activas que Odoo cree que son de "Administrador"
    const conversaciones = await odooCallLocal('acrux.chat.conversation', 'search_read',
      [[['agent_id', '=', uidServicio], ['status', '=', 'current']]],
      { fields: ['id', 'number', 'write_date'], limit: 500 }
    ) || [];

    if (!conversaciones.length) {
      return res.json({ ok: true, total: 0, mensaje: 'No hay ninguna conversación activa donde Odoo diga "Administrador" — nada que revisar.' });
    }

    const idsConversacion = conversaciones.map(c => c.id);

    // 2) Nuestro registro interno para esas mismas conversaciones, todas de un golpe
    const asignaciones = await AsignacionAcrux.find({
      tenant_id: req.user.tenant_id,
      contacto_id: { $in: idsConversacion }
    }).lean();
    const porContactoId = {};
    asignaciones.forEach(a => { porContactoId[a.contacto_id] = a; });

    // 3) Todos los usuarios del panel, para comparar agente_id -> nombre real sin
    // hacer una consulta por cada conversación (evita N+1 contra Mongo).
    const usuarios = await UsuarioPanel.find({ tenant_id: req.user.tenant_id }).select('nombre email odoo_user_id').lean();
    const usuariosPorId = {};
    usuarios.forEach(u => { usuariosPorId[u._id.toString()] = u; });

    // 4) El TIPO real (Lead u Oportunidad) de cada uno — usando el vínculo directo que
    // guarda nuestro propio Contacto (odoo_lead_id), NUNCA una búsqueda por teléfono,
    // porque ya sabemos que el formato del número guardado en Odoo puede no coincidir
    // (nos pasó con Nery Mejía). Este es el dato más importante de esta revisión: si
    // alguno YA es Oportunidad y sigue mal asignado, es más urgente que uno que sigue
    // como Lead simple.
    const numeros = conversaciones.map(c => String(c.number || '').replace(/\D/g, ''));
    const contactos = await Contacto.find({ tenant_id: req.user.tenant_id, numero: { $in: numeros } }).select('numero odoo_lead_id').lean();
    const contactoPorNumero = {};
    contactos.forEach(c => { contactoPorNumero[c.numero] = c; });

    const idsLeadsAConsultar = contactos.filter(c => c.odoo_lead_id).map(c => c.odoo_lead_id);
    let leadsPorId = {};
    if (idsLeadsAConsultar.length) {
      const leadsOdoo = await odooCallLocal('crm.lead', 'read',
        [idsLeadsAConsultar, ['id', 'type', 'stage_id', 'active', 'user_id']],
        { context: { active_test: false } }
      ).catch(() => []);
      (leadsOdoo || []).forEach(l => { leadsPorId[l.id] = l; });
    }

    const detalle = [];
    for (const conv of conversaciones) {
      const asign = porContactoId[conv.id];

      if (!asign || asign.modo !== 'humano' || !asign.agente_id) {
        // KAI todavía la está atendiendo de verdad (modo bot), o no hay ningún registro —
        // en ese caso "Administrador" en Odoo es CORRECTO, no hay nada que corregir.
        continue;
      }

      const usuarioReal = usuariosPorId[asign.agente_id.toString()];
      const consistente = usuarioReal && usuarioReal.nombre === asign.agente_nombre;

      const numeroLimpio = String(conv.number || '').replace(/\D/g, '');
      const contacto = contactoPorNumero[numeroLimpio];
      const leadReal = contacto?.odoo_lead_id ? leadsPorId[contacto.odoo_lead_id] : null;

      detalle.push({
        contacto_id: conv.id,
        numero: conv.number,
        agente_nombre_guardado: asign.agente_nombre,
        agente_id_apunta_a: usuarioReal ? usuarioReal.nombre : '⚠️ ese agente_id ya no existe como usuario',
        registro_interno_consistente: consistente,
        se_corregiria_a: consistente ? asign.agente_nombre : (usuarioReal ? usuarioReal.nombre : 'NECESITA REVISIÓN MANUAL'),
        lead_odoo_id: contacto?.odoo_lead_id || null,
        tipo_en_odoo: leadReal ? (leadReal.type === 'opportunity' ? '🔴 OPORTUNIDAD' : 'Lead') : 'No se encontró vínculo — revisar a mano',
        etapa_en_odoo: leadReal?.stage_id?.[1] || null,
        vendedor_en_el_lead_de_odoo: leadReal?.user_id?.[1] || 'Sin asignar',
        lead_activo: leadReal?.active ?? null,
        ultima_actividad_en_odoo: conv.write_date
      });
    }

    res.json({
      ok: true,
      total_conversaciones_como_administrador_en_odoo: conversaciones.length,
      total_que_de_verdad_necesitan_corregirse: detalle.length,
      con_registro_interno_inconsistente: detalle.filter(d => !d.registro_interno_consistente).length,
      con_registro_interno_ok_solo_falta_sincronizar: detalle.filter(d => d.registro_interno_consistente).length,
      que_ya_son_oportunidad: detalle.filter(d => d.tipo_en_odoo === '🔴 OPORTUNIDAD').length,
      detalle
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/debug/corregir-agente-id', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const contactoId = parseInt(req.query.contacto_id);
    const email = String(req.query.email || '').trim();
    if (!contactoId || !email) return res.json({ ok: false, error: 'Faltan ?contacto_id= y ?email=' });

    const asign = await AsignacionAcrux.findOne({ tenant_id: req.user.tenant_id, contacto_id: contactoId });
    if (!asign) return res.json({ ok: false, error: 'No existe ese registro' });

    const vendedorCorrecto = await UsuarioPanel.findOne({ tenant_id: req.user.tenant_id, email: new RegExp('^' + email + '$', 'i') });
    if (!vendedorCorrecto) return res.json({ ok: false, error: `No existe un usuario con el correo "${email}"` });

    if (req.query.aplicar !== '1') {
      return res.json({
        ok: true, modo: 'VISTA PREVIA — agrega &aplicar=1 para corregir de verdad',
        antes: { agente_id: asign.agente_id, agente_nombre: asign.agente_nombre },
        despues: { agente_id: vendedorCorrecto._id, agente_nombre: vendedorCorrecto.nombre }
      });
    }

    asign.agente_id = vendedorCorrecto._id;
    asign.agente_nombre = vendedorCorrecto.nombre;
    await asign.save();

    res.json({ ok: true, modo: 'EJECUTADO', corregido_a: vendedorCorrecto.nombre });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/debug/probar-sincronizar-agente', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const contactoId = parseInt(req.query.contacto_id);
    if (!contactoId) return res.json({ ok: false, error: 'Falta ?contacto_id= (el ID de la conversación de AcruxLab)' });

    const asign = await AsignacionAcrux.findOne({ tenant_id: req.user.tenant_id, contacto_id: contactoId });
    if (!asign?.agente_id) return res.json({ ok: false, error: 'Esta conversación no tiene ningún agente asignado en nuestro sistema (Mongo) — nada que sincronizar.' });
    if (asign.modo !== 'humano') {
      return res.json({
        ok: false,
        error: `Esta conversación está en modo "${asign.modo}" — KAI todavía la puede estar atendiendo. Sincronizar el agente aquí sería incorrecto: le diría a Odoo que ya hay un humano cuando puede que no. Solo se sincroniza si modo === 'humano'.`,
        modo_actual: asign.modo,
        agente_guardado_para_cuando_pase_a_humano: asign.agente_nombre
      });
    }

    const agente = await UsuarioPanel.findById(asign.agente_id);
    if (!agente) return res.json({ ok: false, error: 'El agente asignado en Mongo ya no existe como usuario del panel.' });
    if (!agente.odoo_user_id) return res.json({ ok: false, error: `${agente.nombre} no tiene su odoo_user_id configurado en Usuarios y Sedes — no se puede sincronizar sin eso.` });

    // Estado ANTES, para comparar
    const antes = await odooCallLocal('acrux.chat.conversation', 'read', [[contactoId], ['id', 'agent_id', 'status']]);
    if (!antes || !antes.length) return res.json({ ok: false, error: `No existe la conversación #${contactoId} en Odoo.` });

    if (req.query.aplicar !== '1') {
      return res.json({
        ok: true, modo: 'VISTA PREVIA — agrega &aplicar=1 para escribir de verdad',
        conversacion: contactoId,
        agente_actual_en_odoo: antes[0].agent_id?.[1] || 'ninguno',
        se_cambiaria_a: agente.nombre,
        agente_en_nuestro_sistema: asign.agente_nombre
      });
    }

    await odooCallLocal('acrux.chat.conversation', 'write', [[contactoId], { agent_id: agente.odoo_user_id }]);
    const despues = await odooCallLocal('acrux.chat.conversation', 'read', [[contactoId], ['id', 'agent_id', 'status']]);

    res.json({
      ok: true, modo: 'EJECUTADO',
      conversacion: contactoId,
      agente_antes: antes[0].agent_id?.[1] || 'ninguno',
      agente_despues: despues[0].agent_id?.[1] || 'ninguno',
      status: despues[0].status
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Libera de inmediato una conversación que se haya quedado pegada a un usuario por
// accidente (ej. el supervisor la abrió en Odoo y con solo pasar el mouse, Odoo se la
// asignó). Pone el agente de vuelta al usuario de servicio de Kai, para que cualquier
// vendedora la pueda ver y tomar de nuevo con normalidad.
// POST /api/acrux/liberar  { contacto_id: 8657 }
// Equivalente de "Soltar" para Instagram/Messenger — no existen en Odoo, así que en vez
// de liberar un agente, se marca como revisado para que salga de "esperando respuesta".
// POST /api/acrux/marcar-revisado-social  { conversacion_id: "6a5774e..." }
app.post('/api/acrux/marcar-revisado-social', authMiddleware, async (req, res) => {
  try {
    const { conversacion_id } = req.body;
    if (!conversacion_id) return res.status(400).json({ ok: false, error: 'conversacion_id es requerido' });
    await Conversacion.updateOne(
      { _id: conversacion_id, tenant_id: req.user.tenant_id },
      { revisado_social: true }
    );
    res.json({ ok: true, mensaje: 'Marcado como revisado — ya no aparece en "esperando respuesta"' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/acrux/liberar', authMiddleware, async (req, res) => {
  try {
    const { contacto_id } = req.body;
    if (!contacto_id) return res.status(400).json({ ok: false, error: 'contacto_id es requerido' });
    if (String(contacto_id).startsWith('social_') || isNaN(Number(contacto_id))) {
      return res.json({ ok: false, error: 'Esta conversación no existe en Odoo (es de Instagram/Messenger) — no aplica soltar aquí.' });
    }

    const uidServicio = await getOdooUID();
    await odooCallLocal('acrux.chat.conversation', 'write', [[contacto_id], { agent_id: uidServicio }]).catch(e => {
      throw new Error(`No se pudo liberar en Odoo: ${e.message}`);
    });

    // Si nuestro propio registro también quedó apuntando al supervisor por error, se
    // regresa a bot para que el reparto normal (o la vendedora real) lo pueda tomar.
    await AsignacionAcrux.updateOne(
      { tenant_id: req.user.tenant_id, contacto_id },
      { modo: 'bot', agente_id: null, agente_nombre: null }
    ).catch(() => {});

    res.json({ ok: true, mensaje: 'Conversación liberada — ya la puede ver y tomar cualquier vendedora' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/acrux/tomar-seguimiento', authMiddleware, async (req, res) => {
  try {
    const { contacto_id } = req.body;
    if (!contacto_id) return res.status(400).json({ ok: false, error: 'contacto_id es requerido' });
    if (String(contacto_id).startsWith('social_')) return res.json({ ok: false, error: 'No aplica para Instagram/Messenger' });
    await AsignacionAcrux.findOneAndUpdate(
      { tenant_id: req.user.tenant_id, contacto_id },
      {
        modo: 'humano',
        fecha_modo_humano: new Date(),
        agente_id: req.user.id,
        agente_nombre: req.user.nombre,
        sin_auto_recuperacion: true // que no se le devuelva solo a KAI por inactividad
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
    res.json({ ok: true, mensaje: `Marcado como en seguimiento de ${req.user.nombre} — KAI ya no le escribirá` });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/acrux/devolver-a-kai', authMiddleware, async (req, res) => {
  try {
    const { contacto_id } = req.body;
    if (!contacto_id) return res.status(400).json({ ok: false, error: 'contacto_id es requerido' });
    if (String(contacto_id).startsWith('social_')) return res.json({ ok: false, error: 'No aplica para Instagram/Messenger' });
    await AsignacionAcrux.findOneAndUpdate(
      { tenant_id: req.user.tenant_id, contacto_id },
      { modo: 'bot' }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/acrux/responder', authMiddleware, async (req, res) => {
  try {
    const { contacto_id, mensaje, plantilla_id, imagen_id, imagen_base64, imagen_mime, imagen_nombre } = req.body;
    if (!contacto_id) return res.status(400).json({ ok: false, error: 'contacto_id es requerido' });
    if (!mensaje && !plantilla_id && !imagen_id && !imagen_base64) return res.status(400).json({ ok: false, error: 'mensaje, plantilla_id, imagen_id o imagen_base64 son requeridos' });

    // Un agente humano respondiendo manualmente desde el panel = KAI debe dejar de
    // auto-responder este contacto de aquí en adelante (pasa a modo "humano").
    try {
      await AsignacionAcrux.findOneAndUpdate(
        { tenant_id: req.user.tenant_id, contacto_id },
        { modo: 'humano', fecha_modo_humano: new Date(), $setOnInsert: { agente_id: req.user.id, agente_nombre: req.user.nombre } },
        { upsert: true }
      );
    } catch (e) { /* no bloquea el envío si esto falla */ }

    let valoresMensaje;
    if (imagen_id) {
      // Enviar una imagen ya existente en el Banco de Imágenes, elegida desde el panel
      // de "Imágenes sugeridas" — mismo flujo que una imagen nueva, pero el archivo
      // sale del Banco en vez de subirlo desde la computadora del agente.
      const imgBanco = await ImagenMarketing.findOne({ _id: imagen_id, tenant_id: req.user.tenant_id });
      if (!imgBanco) return res.json({ ok: false, error: 'Imagen no encontrada en el Banco' });
      const adjunto = await subirImagenNuevaAcrux(imgBanco.imagen_base64, `${imgBanco.nombre}.jpg`, imgBanco.mime_type || 'image/jpeg', contacto_id);
      valoresMensaje = {
        text: mensaje || construirDescripcionImagen(imgBanco),
        from_me: true, ttype: 'image', res_model: 'ir.attachment', res_id: adjunto.id,
        id: -2, date_message: new Date().toISOString().replace('T', ' ').substring(0, 19), button_ids: []
      };
    } else if (imagen_base64) {
      // Imagen NUEVA subida desde la computadora del agente — primero se sube como
      // adjunto real (ir.attachment) vía sesión web + CSRF, y luego se referencia
      // igual que una plantilla ya existente.
      const adjunto = await subirImagenNuevaAcrux(imagen_base64, imagen_nombre || 'imagen.jpg', imagen_mime || 'image/jpeg', contacto_id);
      valoresMensaje = {
        text: mensaje || '',
        from_me: true,
        ttype: 'image',
        res_model: 'ir.attachment',
        res_id: adjunto.id,
        id: -2,
        date_message: new Date().toISOString().replace('T', ' ').substring(0, 19),
        button_ids: []
      };
    } else if (plantilla_id) {
      // Enviar una plantilla del panel de respuestas rápidas — puede ser texto o imagen.
      // Reutilizamos el mismo attachment (res_model/res_id) al que ya apunta la plantilla,
      // en vez de subir un archivo nuevo — es la forma más segura de probarlo primero.
      const plantillas = await odooRPC('/jsonrpc', { service: 'object', method: 'execute_kw', args: [ODOO_DB, await getOdooUID(), ODOO_PASS_ODOO, 'acrux.chat.default.answer', 'get_for_chatroom', [], { context: { is_acrux_chat_room: true } }] });
      const plantilla = (plantillas || []).find(p => p.id === plantilla_id);
      if (!plantilla) return res.json({ ok: false, error: 'Plantilla no encontrada' });

      valoresMensaje = {
        text: plantilla.ttype === 'text' ? (plantilla.text || plantilla.name) : (mensaje || ''),
        from_me: true,
        ttype: plantilla.ttype || 'text',
        res_model: plantilla.res_model || '',
        res_id: plantilla.res_id || 0,
        id: -2,
        date_message: new Date().toISOString().replace('T', ' ').substring(0, 19),
        button_ids: []
      };
    } else {
      // Llamada real capturada del ChatRoom (Network tab): el envío verdadero es un método
      // propio del modelo acrux.chat.conversation, NO un create() sobre acrux.chat.message.
      // El contexto "is_acrux_chat_room: true" parece ser la bandera que dispara el envío real.
      valoresMensaje = {
        text: mensaje,
        from_me: true,
        ttype: 'text',
        res_model: '',
        res_id: 0,
        id: -2,
        date_message: new Date().toISOString().replace('T', ' ').substring(0, 19),
        button_ids: []
      };
    }

    const resultado = await odooCallLocal(
      'acrux.chat.conversation',
      'send_message',
      [[contacto_id], valoresMensaje],
      { context: { lang: 'es_GT', tz: 'America/Guatemala', is_acrux_chat_room: true } }
    );

    // Diagnóstico: releer el último mensaje saliente de este contacto para confirmar
    // que esta vez sí quedó con msgid real (señal de que WhatsApp lo recibió).
    let diagnostico = null;
    try {
      const releido = await odooCallLocal('acrux.chat.message', 'search_read',
        [[['contact_id', '=', contacto_id], ['from_me', '=', true]]],
        { fields: ['id', 'msgid', 'error_msg', 'event', 'try_count', 'date_message'], limit: 1, order: 'date_message desc' }
      );
      diagnostico = releido?.[0] || null;
    } catch (e) {
      diagnostico = { error_al_releer: e.message };
    }

    res.json({
      ok: true,
      resultado,
      diagnostico,
      aviso: 'Mensaje enviado con send_message. Confirma con el destinatario real que le llegó, y revisa que "diagnostico.msgid" ya no venga vacío.'
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Cruce solo-lectura: dado un número de WhatsApp, buscar el lead de Odoo asociado
// y devolver los campos que Sylvia usa para clasificar (Prioridad / Etiquetas / Nota).
// No escribe nada — únicamente lectura, para mostrarlo junto al chat de AcruxLab.
// ===== CLASIFICACIÓN REAL — directo desde acrux.chat.conversation (no crm.lead) =====
// Descubrimos que Prioridad, Etiquetas y Nota viven en el propio registro de la
// conversación de AcruxLab, identificado por el mismo contacto_id que ya usamos.
// Esto reemplaza el cruce por teléfono contra crm.lead (que dependía de encontrar
// el lead correcto entre posibles duplicados) — aquí no hay ambigüedad posible.
// Infiere el nivel educativo (mismo enum que usa el catálogo de imágenes) a partir de
// las etiquetas de grado que ya tenemos en AcruxLab (ej. "Kinder", "10°", "Jardín").
// Los números solos (sin la palabra) se interpretan con la numeración típica de
// Guatemala: 1°-6° = Primaria, 7°-9° = Básico, 10°-12° = Bachillerato/Diversificado.
function inferirNivelDesdeEtiquetas(etiquetas) {
  for (const et of (etiquetas || [])) {
    const v = et.toLowerCase();
    if (/jard[ií]n/.test(v)) return 'Jardín';
    if (/kinder|k[ií]nder|p[aá]rvulos|prepa|infantil/.test(v)) return 'Kínder';
    if (/bachillerato|diversificado/.test(v)) return 'Bachillerato';
    if (/b[aá]sico/.test(v)) return 'Básico';
    if (/secundaria/.test(v)) return 'Secundaria';
    if (/primaria/.test(v)) return 'Primaria';
    const soloNumero = v.match(/^(\d{1,2})°?$/);
    if (soloNumero) {
      const n = parseInt(soloNumero[1]);
      if (n >= 1 && n <= 6) return 'Primaria';
      if (n >= 7 && n <= 9) return 'Básico';
      if (n >= 10 && n <= 12) return 'Bachillerato';
    }
  }
  return null;
}

app.get('/api/acrux/clasificacion/:contactoId', authMiddleware, async (req, res) => {
  try {
    const contactoId = parseInt(req.params.contactoId);
    if (!contactoId) return res.json({ ok: false, error: 'ID de contacto inválido' });

    // Se intenta primero con todos los campos; si Odoo da error de permisos en alguno
    // (pasa con ciertos registros, ej. campos calculados que dependen de otro modelo al
    // que no siempre hay acceso), se reintenta con un grupo básico que casi nunca falla,
    // en vez de mostrarle un error crudo de Odoo a la vendedora.
    let detalle;
    try {
      detalle = await odooCallLocal('acrux.chat.conversation', 'read',
        [[contactoId], ['id', 'name', 'number', 'number_format', 'priority', 'tag_ids', 'note', 'status', 'unanswered', 'last_activity', 'partner_info']]
      );
    } catch (e) {
      console.error(`⚠️ [Clasificación] Falló con todos los campos para #${contactoId}, reintentando básico: ${e.message}`);
      detalle = await odooCallLocal('acrux.chat.conversation', 'read',
        [[contactoId], ['id', 'name', 'number', 'priority', 'tag_ids', 'note', 'status']]
      );
    }
    const conv = detalle?.[0];
    if (!conv) return res.json({ ok: false, error: 'No se encontró la conversación en AcruxLab' });

    let etiquetas = [];
    if (conv.tag_ids && conv.tag_ids.length) {
      try {
        const tags = await odooCallLocal('acrux.chat.conversation.tag', 'read', [conv.tag_ids, ['id', 'name']]);
        etiquetas = (tags || []).map(t => t.name);
      } catch (e) { /* sin permiso en Odoo para "Chat Conversation Tags" — se sigue sin nombres de etiqueta */ }
    }

    // partner_info trae texto libre tipo "Email: x\nTeléfono: y\nUbicación: z"
    let correo = null, ubicacion = null;
    (conv.partner_info || '').split('\n').forEach(linea => {
      if (/^email:/i.test(linea)) correo = linea.split(':').slice(1).join(':').trim();
      if (/^ubicaci/i.test(linea)) ubicacion = linea.split(':').slice(1).join(':').trim();
    });

    // Inferir el nivel educativo real a partir de las etiquetas de grado que ya
    // tenemos (ej. "Kinder", "10°", "Jardín") — para sugerir imágenes del catálogo
    // igual que ya se hace en el canal de WhatsApp/IG/Messenger.
    // ⚠️ IMAGENES_SUGERIDAS_ACRUX_ACTIVO: construido y probado, pero apagado a propósito
    // hasta que se autorice pasar AcruxLab a producción. Cambiar a `true` para activarlo.
    const IMAGENES_SUGERIDAS_ACRUX_ACTIVO = false;
    const nivelInferido = inferirNivelDesdeEtiquetas(etiquetas);
    let imagenesSugeridas = [];
    if (IMAGENES_SUGERIDAS_ACRUX_ACTIVO) {
      try {
        imagenesSugeridas = await ImagenMarketing.find({
          tenant_id: req.user.tenant_id,
          activo: true,
          $or: nivelInferido ? [{ nivel_educativo: nivelInferido }, { nivel_educativo: 'Todos' }] : [{ nivel_educativo: 'Todos' }]
        }).select('nombre categoria nivel_educativo').limit(6);
      } catch (e) { /* si falla, seguimos sin sugerencias — no bloqueante */ }
    }

    res.json({
      ok: true,
      contacto_id: conv.id,
      nombre_contacto: conv.name,
      numero: conv.number_format || conv.number,
      correo,
      ubicacion,
      prioridad: conv.priority || '0',
      etiquetas,
      nota: (conv.note || '').trim() || null,
      estado: conv.status || null,
      sin_responder: !!conv.unanswered,
      ultima_actividad: conv.last_activity || null,
      nivel_inferido: nivelInferido,
      imagenes_sugeridas: imagenesSugeridas
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/acrux/lead-por-telefono/:numero', authMiddleware, async (req, res) => {
  try {
    const numero = (req.params.numero || '').replace(/\D/g, '').slice(-8); // últimos 8 dígitos, sin +502 ni espacios
    if (!numero) return res.json({ ok: false, error: 'Número inválido' });

    const leads = await odooCallLocal('crm.lead', 'search_read',
      [[['type', 'in', ['lead', 'opportunity']]]],
      { fields: ['id', 'name', 'partner_name', 'contact_name', 'phone', 'mobile', 'email_from', 'city', 'priority', 'tag_ids', 'x_studio_notas_1', 'x_studio_comentarios', 'write_date'], limit: 8000, order: 'write_date desc' }
    ) || [];

    const coincidencias = leads.filter(l => {
      const tel = String(l.phone || '').replace(/\D/g, '').slice(-8);
      const mov = String(l.mobile || '').replace(/\D/g, '').slice(-8);
      return tel === numero || mov === numero;
    });

    if (!coincidencias.length) return res.json({ ok: true, encontrado: false });

    // Puede haber leads duplicados con el mismo teléfono (mismo padre escribiendo por
    // más de un canal — típicamente uno real donde Sylvia trabaja, y otro que KAI crea
    // solo por el canal de Meta). Entre duplicados, preferimos el que tenga la Nota
    // (x_studio_notas_1) llena — ahí es donde vive el nombre real del alumno — en vez
    // de simplemente el más recientemente actualizado, que suele ser el auto-generado.
    const conNota = coincidencias.filter(l => l.x_studio_notas_1 && l.x_studio_notas_1.trim());
    const lead = conNota.length ? conNota[0] : coincidencias[0];

    let etiquetas = [];
    if (lead.tag_ids && lead.tag_ids.length) {
      const tags = await odooCallLocal('crm.tag', 'search_read', [[['id', 'in', lead.tag_ids]]], { fields: ['id', 'name'] });
      etiquetas = (tags || []).map(t => t.name);
    }

    // Respaldo: cuando la Nota real (x_studio_notas_1) todavía está vacía porque Sylvia
    // no ha trabajado este lead a mano, KAI a veces ya dejó el nombre del alumno en el
    // propio nombre del lead, con el patrón "(hijo: NOMBRE)" o "(hija: NOMBRE)".
    const matchHijo = (lead.name || '').match(/\(hij[oa]:\s*([^)]+)\)/i);
    const alumnoDesdeNombreLead = matchHijo ? matchHijo[1].trim() : null;

    res.json({
      ok: true,
      encontrado: true,
      lead_id: lead.id,
      posible_duplicado: coincidencias.length > 1,
      otros_leads_mismo_telefono: coincidencias.length > 1 ? coincidencias.filter(l => l.id !== lead.id).map(l => ({ id: l.id, nombre: l.name, actualizado: l.write_date })) : [],
      // Contacto = el padre/madre/encargado (quien escribe por WhatsApp), NO el alumno
      contacto_nombre: lead.contact_name || lead.partner_name || null,
      contacto_telefono: lead.phone || lead.mobile || null,
      contacto_correo: lead.email_from || null,
      contacto_ubicacion: lead.city || null,
      prioridad: lead.priority || '0', // Odoo: '0'..'3' = número de estrellas
      etiquetas,
      // Nota = donde Sylvia escribe el/los nombre(s) del alumno + anotaciones breves.
      // Si aún está vacía, usamos el nombre del alumno que KAI haya detectado como respaldo.
      nota: lead.x_studio_notas_1 || (alumnoDesdeNombreLead ? `${alumnoDesdeNombreLead} (detectado por KAI, aún sin confirmar por Sylvia)` : null),
      nivel: lead.x_studio_comentarios || null // ⚠️ pendiente #1: este mapeo de "Nivel" está sin confirmar
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== DIAGNÓSTICO — Automatizaciones/alias de Odoo que crean leads desde correo =====
// El formulario de admisiones NO pasa por KAI: llega por correo a capouilliez@gmail.com
// y Odoo lo convierte en lead solo (alias de correo / email-to-lead). Este endpoint es
// SOLO LECTURA — busca qué automatización o alias está mapeando mal "Nombre" y "Nivel",
// para que se corrija desde Odoo Studio (no desde aquí).
// ===== DIAGNÓSTICO — Nombre técnico real de los campos personalizados de crm.lead =====
// Solo lectura. Sirve para identificar, por ejemplo, cuál es el campo técnico real de
// "Nivel" (el que se ve en el formulario de Odoo), para corregir el mapeo en
// /api/odoo/actualizar-lead sin adivinar nombres de campo.
// ===== DIAGNÓSTICO — Campos reales de acrux.chat.message =====
// contact_name / contact_number vienen en false en los mensajes reales — hay que
// encontrar el campo correcto que identifica al contacto/conversación en este modelo.
app.get('/api/debug/acrux-campos-mensaje', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const campos = await odooCallLocal('acrux.chat.message', 'fields_get', [], { attributes: ['string', 'type', 'relation'] });
    if (!campos) return res.json({ ok: false, error: 'No se pudo leer fields_get' });

    const listaCampos = Object.entries(campos).map(([tecnico, def]) => ({
      campo_tecnico: tecnico, etiqueta: def.string, tipo: def.type, relacion: def.relation || null
    }));

    // Traer 1 mensaje completo con TODOS los campos (sin especificar 'fields') para ver qué trae valor real
    const idsMuestra = await odooCallLocal('acrux.chat.message', 'search', [[]], { limit: 1, order: 'date_message desc' });
    let mensajeCompleto = null;
    if (idsMuestra && idsMuestra.length) {
      const detalle = await odooCallLocal('acrux.chat.message', 'read', [idsMuestra, []]);
      mensajeCompleto = detalle?.[0] || null;
    }

    res.json({ ok: true, total_campos: listaCampos.length, campos: listaCampos, mensaje_de_muestra_completo: mensajeCompleto });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Diagnóstico: opciones válidas de un campo tipo "selection" (ej. capo_level_of_interest)
// Diagnóstico: leer la vista de formulario real de "Admisiones" (crm.lead) y buscar
// qué campo técnico corresponde a la etiqueta visible "Nivel" — esto puede ser distinto
// de field.string en fields_get, porque la vista puede sobreescribir la etiqueta mostrada.
app.get('/api/debug/vista-formulario-lead', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const uid = await getOdooUID();

    // Buscar el view_id específico de la acción "Admisiones" (la que se ve en pantalla,
    // action=1018 según la URL) — la vista genérica del modelo puede ser otra distinta.
    let viewIdEspecifico = false;
    try {
      const accion = await odooRPC('/jsonrpc', { service: 'object', method: 'execute_kw', args: [ODOO_DB, uid, ODOO_PASS_ODOO, 'ir.actions.act_window', 'read', [[parseInt(req.query.action_id) || 1018]], { fields: ['view_id', 'views', 'res_model'] }] });
      const act = accion?.[0];
      viewIdEspecifico = act?.view_id?.[0] || (act?.views || []).find(v => v[1] === 'form')?.[0] || false;
    } catch (e) { /* si falla, seguimos con false (vista por defecto) */ }

    let resultado;
    try {
      resultado = await odooRPC('/jsonrpc', { service: 'object', method: 'execute_kw', args: [ODOO_DB, uid, ODOO_PASS_ODOO, 'crm.lead', 'get_views', [[[viewIdEspecifico, 'form']]], { options: {} }] });
    } catch (eInterno) {
      return res.json({ ok: false, error_completo: eInterno.message, nota: 'Falló get_views — revisa el traceback completo aquí abajo', view_id_usado: viewIdEspecifico });
    }
    const arch = resultado?.views?.form?.arch || null;
    if (!arch) return res.json({ ok: false, error: 'No se pudo obtener el arch de la vista', crudo: resultado });

    // Buscar el texto literal "Nivel" donde sea que aparezca, y devolver el contexto
    // alrededor — más confiable que intentar parsear la estructura XML con regex exacto.
    const fragmentos = [];
    const textoBusqueda = arch.toLowerCase();
    let idx = textoBusqueda.indexOf('nivel');
    while (idx !== -1 && fragmentos.length < 15) {
      fragmentos.push(arch.substring(Math.max(0, idx - 120), idx + 130));
      idx = textoBusqueda.indexOf('nivel', idx + 5);
    }

    res.json({ ok: true, view_id_usado: viewIdEspecifico, total_apariciones_de_nivel: fragmentos.length, fragmentos, arch_length: arch.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Diagnóstico: encontrar dónde viven las "respuestas rápidas" del ChatRoom (el panel
// con el rayo ⚡ que ya vimos en capturas). Probamos los candidatos más probables.
app.get('/api/debug/plantillas-chatroom', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const uid = await getOdooUID();
    const resultado = await odooRPC('/jsonrpc', { service: 'object', method: 'execute_kw', args: [ODOO_DB, uid, ODOO_PASS_ODOO, 'acrux.chat.default.answer', 'get_for_chatroom', [], { context: { is_acrux_chat_room: true } }] });
    return res.json({ ok: true, via: 'get_for_chatroom', resultado });
  } catch (eMetodo) {
    // Si el método propio falla, probamos leer el modelo directo como respaldo
    try {
      const registros = await odooCallLocal('acrux.chat.default.answer', 'search_read', [[]], { fields: [], limit: 100 });
      return res.json({ ok: true, via: 'search_read', registros });
    } catch (eModelo) {
      return res.json({ ok: false, error_metodo: eMetodo.message, error_modelo: eModelo.message });
    }
  }
});

// Diagnóstico: ver si la autenticación de sesión web funciona, y el HTML crudo
// alrededor de "csrf" para ajustar el patrón de extracción si hace falta.
app.get('/api/debug/sesion-web-odoo', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const bodyAuth = JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { db: ODOO_DB, login: ODOO_USER_ODOO, password: ODOO_PASS_ODOO } });
    const respAuth = await odooWebRequest('/web/session/authenticate', 'POST', { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyAuth) }, bodyAuth);
    const setCookie = respAuth.headers['set-cookie'];
    const cuerpoAuth = JSON.parse(respAuth.body.toString('utf8'));

    if (!setCookie) {
      return res.json({ ok: false, error: 'Sin cookie de sesión', respuesta_auth: cuerpoAuth });
    }
    const cookie = setCookie.map(c => c.split(';')[0]).join('; ');

    const respPagina = await odooWebRequest('/web', 'GET', { Cookie: cookie }, null);
    const html = respPagina.body.toString('utf8');
    const idx = html.toLowerCase().indexOf('csrf');
    const fragmento = idx !== -1 ? html.substring(Math.max(0, idx - 100), idx + 300) : null;

    res.json({
      ok: true,
      sesion_autenticada: !!cuerpoAuth?.result?.uid,
      uid_sesion: cuerpoAuth?.result?.uid || null,
      status_pagina_web: respPagina.statusCode,
      largo_html: html.length,
      contiene_csrf: idx !== -1,
      fragmento_alrededor_de_csrf: fragmento
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Diagnóstico: ver el valor CRUDO del rol de un usuario, tal cual está en la base de
// datos — para descartar que la pantalla de Usuarios muestre una etiqueta distinta al
// valor real guardado (ej. mayúsculas, espacios, u otro valor inesperado).
// Diagnóstico: ver cuántas conversaciones tiene asignadas cada vendedor, en cada canal,
// para confirmar si el reparto 1 a 1 realmente está siendo parejo o hay un problema.
// Diagnóstico: ver el estado REAL guardado en MongoDB para un número específico —
// para confirmar si el nombre/memoria se perdió de verdad, o es otra cosa.
app.get('/api/debug/contacto/:numero', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const numero = req.params.numero;
    const contacto = await Contacto.findOne({ tenant_id: req.user.tenant_id, numero });
    res.json({ ok: true, encontrado: !!contacto, contacto });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Diagnóstico COMPLETO — todo de una vez, sin teorías: roles reales de cada usuario,
// asignaciones guardadas en AsignacionAcrux, y los últimos 20 registros crudos de
// AcruxLab con el agente que cada uno tiene ANTES de cualquier filtro.
// CORRECCIÓN ÚNICA (no automática, hay que llamarla a propósito): revisa TODAS las
// asignaciones ya guardadas en AsignacionAcrux, las compara contra quién realmente
// respondió en Odoo (el agente derivado del último mensaje saliente real), y corrige
// cualquier caso donde no coincidan — por ejemplo, chats que Vanessa o Sylvia
// atendieron de verdad pero quedaron mal guardados como "Cindy Godoy" por el bug
// anterior del reparto automático.
// ===== FORMULARIO DE ADMISIONES QUE LLEGA POR CORREO =====
// Estos leads entran a Odoo con el cuerpo del correo en "description" y sin los campos
// llenos (nombre, teléfono, nivel...), por eso quedan sin teléfono y hay que copiarlos
// a mano. Aquí KAI lee ese texto y saca los datos para poder grabarlos automáticamente.
async function extraerDatosDelFormulario(leadId) {
  const leads = await odooCallLocal('crm.lead', 'read', [[leadId]], {
    fields: ['id', 'name', 'description', 'email_from', 'phone', 'mobile', 'partner_name', 'contact_name']
  });
  if (!leads?.length) return { ok: false, error: 'Lead no encontrado' };
  const lead = leads[0];

  // El texto del formulario puede estar en dos lugares: en el campo "description" del
  // lead, o —lo más común cuando el lead nace de un correo— en el historial de mensajes
  // (el chatter). Buscamos en ambos y nos quedamos con el que traiga más contenido.
  const limpiarHtml = (txt) => String(txt || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  let cuerpo = limpiarHtml(lead.description);

  if (cuerpo.length < 40) {
    try {
      const mensajes = await odooCallLocal('mail.message', 'search_read',
        [[
          ['model', '=', 'crm.lead'],
          ['res_id', '=', leadId],
          ['message_type', '=', 'email']   // SOLO correos entrantes
        ]],
        { fields: ['id', 'body', 'subject', 'date', 'message_type'], limit: 10, order: 'date asc' }
      ) || [];
      // Ojo: hay que excluir los correos que SALEN del colegio (respuestas automáticas
      // tipo "Gracias por su interés..."). Antes se tomaba el mensaje más largo y casi
      // siempre ganaba esa plantilla de respuesta, no el formulario que llenó la persona.
      const entrantes = mensajes.filter(m => m.message_type === 'email');
      const cuerposMensajes = entrantes.map(m => limpiarHtml(m.body)).filter(t => t.length > 40);
      if (cuerposMensajes.length) {
        cuerpo = cuerposMensajes[0]; // el primero = el formulario original que llegó
      }
    } catch (e) {
      console.error(`⚠️ No se pudo leer el historial del lead ${leadId}: ${e.message}`);
    }
  }

  if (!cuerpo || cuerpo.length < 20) {
    return { ok: false, error: 'No se encontró el texto del formulario ni en la descripción ni en el historial de mensajes del lead' };
  }

  const systemPrompt = `Eres un asistente que revisa correos que llegan al Colegio Capouilliez (Guatemala).
Te voy a dar el texto de un correo. Devuelve ÚNICAMENTE un objeto JSON, sin explicaciones ni markdown.

Formato exacto:
{
  "es_formulario_admisiones": true o false,
  "tema": "texto del asunto o tema del formulario, o null",
  "motivo_descarte": "si es_formulario_admisiones es false, explica brevemente por qué; si es true, null",
  "nombre_padre": "texto o null",
  "nombre_alumno": "texto o null",
  "telefono": "solo dígitos, o null",
  "correo": "texto o null",
  "nivel": "Preprimaria, Primaria, Secundaria, o null",
  "zona": "texto o null",
  "notas": "cualquier dato adicional relevante, o null"
}

MUY IMPORTANTE — "es_formulario_admisiones" debe ser FALSE si:
- La persona busca EMPLEO o manda su currículum (ej. tema "Trabaja con nosotros"). Esto NO es una admisión.
- Es un boletín, publicidad, notificación automática o correo masivo.
- Es una respuesta automática enviada POR el colegio.
- Es un proveedor ofreciendo productos o servicios al colegio.

OJO — NO te dejes llevar por el TONO del mensaje. Muchos padres escriben de forma muy
formal o protocolaria ("El motivo de la presente es para manifestar nuestro interés...",
"solicitar su valioso apoyo...") y AUN ASÍ son padres buscando inscribir a su hijo.
Lo que decide es el CONTENIDO, no el estilo. Si menciona a su hijo, un grado o nivel, la
edad del niño, pide información de admisión, o quiere agendar una visita o recorrido por
las instalaciones → es TRUE, aunque suene a carta de oficina.

Solo pon TRUE cuando sea un padre/madre interesado en inscribir a un alumno.

Otras reglas:
- Si un dato no aparece con claridad, pon null. NO inventes datos.
- Básico y Bachillerato cuentan como "Secundaria".
- El teléfono debe ser solo dígitos, sin espacios ni símbolos.`;

  const respuesta = await llamarClaude(systemPrompt, [{ role: 'user', content: cuerpo.substring(0, 6000) }], 700);
  if (!respuesta) return { ok: false, error: 'La IA no devolvió respuesta (puede ser saldo agotado o fallo de conexión con Anthropic)', texto_leido: cuerpo.substring(0, 600) };

  let datos;
  try {
    // La IA puede agregar texto antes/después pese a la instrucción — se extrae solo
    // el tramo entre la primera '{' y la última '}', que es el objeto JSON real.
    let limpio = respuesta.replace(/```json|```/g, '').trim();
    const inicio = limpio.indexOf('{');
    const fin = limpio.lastIndexOf('}');
    if (inicio === -1 || fin === -1 || fin < inicio) throw new Error('No se encontró un objeto JSON en la respuesta');
    limpio = limpio.substring(inicio, fin + 1);
    datos = JSON.parse(limpio);
  } catch (e) {
    return { ok: false, error: 'La IA devolvió un formato inesperado', respuesta_cruda: respuesta };
  }

  // Normalizar el teléfono al formato de Guatemala
  if (datos.telefono) {
    let tel = String(datos.telefono).replace(/\D/g, '');
    if (tel.length === 8) tel = '502' + tel;
    datos.telefono = tel.length >= 11 ? tel : null;
  }

  return { ok: true, lead_id: leadId, datos, texto_original: cuerpo.substring(0, 1500) };
}

// Diagnóstico — muestra TODO lo que trae un lead (campos con texto + historial de
// mensajes), para ubicar dónde quedó guardado el contenido del formulario.
app.get('/api/motor/formulario/inspeccionar/:leadId', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const leadId = parseInt(req.params.leadId);
    const leads = await odooCallLocal('crm.lead', 'read', [[leadId]], {}) || [];
    if (!leads.length) return res.json({ ok: false, error: 'Lead no encontrado' });

    // Solo los campos que traen texto de verdad (los vacíos no sirven para nada aquí)
    const camposConTexto = {};
    for (const [k, v] of Object.entries(leads[0])) {
      if (typeof v === 'string' && v.trim().length > 3) camposConTexto[k] = v.substring(0, 800);
    }

    let mensajes = [];
    try {
      mensajes = await odooCallLocal('mail.message', 'search_read',
        [[['model', '=', 'crm.lead'], ['res_id', '=', leadId]]],
        { fields: ['id', 'subject', 'body', 'message_type', 'date'], limit: 10, order: 'date asc' }
      ) || [];
    } catch (e) { mensajes = [{ error: e.message }]; }

    res.json({
      ok: true,
      lead_id: leadId,
      campos_con_texto: camposConTexto,
      total_mensajes_en_chatter: mensajes.length,
      mensajes: mensajes.map(m => ({
        id: m.id, tipo: m.message_type, fecha: m.date, asunto: m.subject,
        cuerpo: String(m.body || '').substring(0, 1200)
      }))
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Vista previa — NO graba nada en Odoo, solo muestra qué se extrajo
app.get('/api/motor/formulario/extraer/:leadId', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const resultado = await extraerDatosDelFormulario(parseInt(req.params.leadId));
    res.json(resultado);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Graba en Odoo los datos extraídos, dejando el lead igual que los que sí traen teléfono
app.post('/api/motor/formulario/grabar/:leadId', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const leadId = parseInt(req.params.leadId);
    const extraccion = await extraerDatosDelFormulario(leadId);
    if (!extraccion.ok) return res.json(extraccion);

    const d = extraccion.datos;
    if (!d.es_formulario_admisiones) {
      // Lo marcamos y dejamos el motivo en Odoo, para que el equipo sepa que ya se revisó
      // y por qué no aplica (solicitud de empleo, boletín, etc.) sin tener que abrirlo.
      const tagSinWAId = await getOdooTagId(TAG_KAI_SIN_WHATSAPP);
      await odooCallLocal('crm.lead', 'write', [[leadId], { tag_ids: [[4, tagSinWAId]] }]).catch(() => {});
      await odooCallLocal('crm.lead', 'message_post', [[leadId]], {
        body: `🤖 KAI revisó este correo y NO es una solicitud de admisión.<br>` +
              `• Tema: ${d.tema || '—'}<br>` +
              `• Motivo: ${d.motivo_descarte || 'no corresponde a admisiones'}<br>` +
              `• Remitente: ${d.nombre_padre || '—'} ${d.correo ? '(' + d.correo + ')' : ''}<br>` +
              `No se contactará por WhatsApp. Queda para que el equipo decida qué hacer.`
      }).catch(() => {});
      return res.json({ ok: false, descartado: true, error: 'Este correo no es una solicitud de admisión', datos: d });
    }

    const actualizacion = {};
    if (d.nombre_padre) { actualizacion.contact_name = d.nombre_padre; actualizacion.partner_name = d.nombre_padre; }
    if (d.telefono) actualizacion.phone = d.telefono;
    if (d.correo) actualizacion.email_from = d.correo;
    if (d.nombre_padre) actualizacion.name = `Formulario Admisiones — ${d.nombre_padre}`;

    if (!Object.keys(actualizacion).length) {
      return res.json({ ok: false, error: 'No se encontró ningún dato aprovechable en el correo', datos: d });
    }

    await odooCallLocal('crm.lead', 'write', [[leadId], actualizacion]);
    await odooCallLocal('crm.lead', 'message_post', [[leadId]], {
      body: `🤖 KAI leyó el correo del formulario y completó los datos automáticamente:<br>` +
            `• Padre/Madre: ${d.nombre_padre || '—'}<br>` +
            `• Alumno: ${d.nombre_alumno || '—'}<br>` +
            `• Teléfono: ${d.telefono || '—'}<br>` +
            `• Nivel: ${d.nivel || '—'}<br>` +
            `• Zona: ${d.zona || '—'}` +
            (d.notas ? `<br>• Notas: ${d.notas}` : '')
    }).catch(() => {});

    res.json({ ok: true, lead_id: leadId, datos_grabados: actualizacion, extraido: d });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// MOTOR PROACTIVO — ejecución manual y controlada, para probar antes de automatizar.
// GET  /api/motor/proactivo/vista-previa      → muestra a quién contactaría, SIN enviar nada
// POST /api/motor/proactivo/ejecutar {limite} → contacta de verdad, máximo "limite" leads
app.get('/api/motor/proactivo/vista-previa', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const limite = Math.min(parseInt(req.query.limite) || 20, 100);
    const leads = await buscarLeadsPendientesDeContactar(limite);
    res.json({
      ok: true,
      motor_automatico_activo: MOTOR_PROACTIVO_ACTIVO,
      dentro_de_horario: estaDentroDeHorarioLaboral(),
      total_por_contactar: leads.length,
      leads: leads.map(l => {
        const tel = (l.mobile && String(l.mobile) !== 'false') ? l.mobile : ((l.phone && String(l.phone) !== 'false') ? l.phone : null);
        const nombreLead = l.partner_name || l.contact_name || l.name;
        const nivel = normalizarNivelParaMensaje(l.x_studio_comentarios);
        return {
          lead_id: l.id,
          nombre: nombreLead,
          telefono: tel,
          correo: l.email_from || null,
          nivel_detectado: nivel,
          creado: l.create_date?.substring(0, 16),
          se_puede_contactar: !!tel,
          MENSAJE_QUE_RECIBIRIA: tel ? MENSAJE_PRIMER_CONTACTO(nombreLead ? nombreLead.split(' ')[0] : null, nivel) : null
        };
      })
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/motor/proactivo/ejecutar', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const limite = Math.min(parseInt(req.body?.limite) || 1, 25); // por defecto SOLO 1, a propósito
    const incluirSinTelefono = req.body?.incluir_sin_telefono === true;
    const tenant = await Tenant.findOne({ _id: req.user.tenant_id });
    const todos = await buscarLeadsPendientesDeContactar(limite * 4);

    // Priorizar los que sí tienen teléfono: si se pide contactar 1, que sea un papá real
    // y no un correo del formulario sin número.
    const conTelefono = todos.filter(l => (l.mobile && String(l.mobile) !== 'false') || (l.phone && String(l.phone) !== 'false'));
    const leads = incluirSinTelefono ? todos.slice(0, limite) : conTelefono.slice(0, limite);

    const resultados = [];
    const numerosVistos = new Map();
    for (const lead of leads) {
      const telLead = String(
        (lead.mobile && String(lead.mobile) !== 'false') ? lead.mobile
        : ((lead.phone && String(lead.phone) !== 'false') ? lead.phone : '')
      ).replace(/\D/g, '');
      if (telLead && telLead.length >= 8) {
        const clave = telLead.slice(-8);
        if (numerosVistos.has(clave)) {
          const idPrincipal = numerosVistos.get(clave);
          await odooCallLocal('crm.lead', 'message_post', [[lead.id]], {
            body: `♻️ <b>Registro repetido</b>: este papá ya existe como contacto y se está atendiendo en el lead #${idPrincipal} (número ...${clave}).<br>No se le escribió, para no duplicar mensajes. <i>No se cambió el estado de este lead — el equipo decide qué hacer con los duplicados.</i>`
          }).catch(() => {});
          resultados.push({ lead_id: lead.id, nombre: lead.partner_name || lead.contact_name || lead.name, ok: false, motivo: 'repetido_no_contactado', se_atiende_en_lead: idPrincipal });
          continue;
        }
        numerosVistos.set(clave, lead.id);
      }
      const contactar = CANAL_CONTACTO_PROACTIVO === 'acrux' ? contactarLeadPorAcruxLab : contactarLeadPorWhatsApp;
      const r = await contactar(tenant, lead);
      resultados.push({ lead_id: lead.id, nombre: lead.partner_name || lead.contact_name || lead.name, ...r });
      await new Promise(x => setTimeout(x, 3000));
    }

    res.json({
      ok: true,
      contactados: resultados.filter(r => r.ok).length,
      fallidos: resultados.filter(r => !r.ok).length,
      detalle: resultados
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Lleva una conversación a AcruxLab (número oficial) SIN enviarle nada al padre:
// crea la conversación en el ChatRoom, le deja la nota con el resumen de lo que KAI
// habló, y se la asigna a la vendedora. Sirve para los contactos que salieron por el
// número de pruebas de Meta y deben continuar por el número oficial del colegio.
async function migrarConversacionAAcruxLab(tenant, numero, nombre, resumen, vendedor) {
  const tel = String(numero).replace(/\D/g, '');
  if (tel.length < 11) return { ok: false, motivo: 'telefono_invalido' };

  let conversacion;
  try {
    conversacion = await obtenerOCrearConversacionAcrux(tel, nombre);
  } catch (e) {
    return { ok: false, motivo: 'no_se_pudo_crear', detalle: e.message };
  }

  // La nota es interna del ChatRoom — el padre NO la ve. Aquí queda el contexto para
  // que la vendedora sepa de qué se habló antes sin tener que preguntar de nuevo.
  const nota = `🤖 Conversación iniciada por KAI.\n` +
               (resumen ? `\nResumen de lo hablado:\n${resumen}\n` : '') +
               `\n(El primer contacto salió por el número de pruebas; continuar desde este número oficial.)`;
  await odooCallLocal('acrux.chat.conversation', 'write', [[conversacion.id], { note: nota }]).catch(() => {});

  // Si una migración anterior le dejó puesto el agente en Odoo, lo liberamos: mientras
  // esté ahí, el ChatRoom bloquea a KAI y la conversación se queda muerta esperando.
  if (conversacion.agente) {
    await odooCallLocal('acrux.chat.conversation', 'write', [[conversacion.id], { agent_id: false }]).catch(() => {});
    console.log(`🔓 [Migración] Se liberó el agente de la conversación ${conversacion.id} para que KAI pueda atenderla`);
  }

  // OJO: aquí NO se escribe `agent_id` en Odoo a propósito. Ese campo es el "semáforo"
  // del ChatRoom: si tiene un agente humano, KAI no puede escribir en la conversación.
  // Como queremos que KAI la atienda primero, la dejamos libre y llevamos la asignación
  // de la vendedora en nuestro propio registro (AsignacionAcrux), que sí se respeta en
  // el traspaso posterior.

  await AsignacionAcrux.findOneAndUpdate(
    { tenant_id: tenant._id, contacto_id: conversacion.id },
    {
      $set: {
        // En modo 'bot': KAI los atiende cuando contesten (pide datos, manda imágenes)
        // y se los traspasa a la vendedora cuando muestren interés real. Si se dejaran
        // en 'humano', quedarían esperando a que la vendedora escriba a mano.
        modo: 'bot',
        fecha_modo_humano: null,
        resumen_kai: resumen || null,
        agente_id: vendedor?._id || null,
        agente_nombre: vendedor?.nombre || null
      }
    },
    { upsert: true, setDefaultsOnInsert: true }
  ).catch(() => {});

  console.log(`🔀 [Migración] ${tel} llevado a AcruxLab (conv #${conversacion.id}${conversacion.creada ? ', nueva' : ''})${vendedor ? ' — ' + vendedor.nombre : ''}`);
  return { ok: true, conversacion_acrux: conversacion.id, creada: conversacion.creada, vendedor: vendedor?.nombre || null };
}

// Migra a AcruxLab los contactos que KAI contactó por el número de pruebas de Meta.
// No envía ningún mensaje: solo abre la conversación en el número oficial con el
// contexto, para que las vendedoras continúen ahí.
// GET  ?vista_previa=1  → muestra a quiénes migraría, sin tocar nada
app.post('/api/motor/migrar-a-acrux', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const tenant = await Tenant.findOne({ _id: req.user.tenant_id });
    const soloVistaPrevia = req.body?.vista_previa === true;

    // Contactos que vinieron del formulario y fueron contactados por KAI
    const contactos = await Contacto.find({
      tenant_id: req.user.tenant_id,
      canal_origen: 'formulario_admisiones'
    }).sort({ ultimo_contacto: -1 }).limit(50);

    if (soloVistaPrevia) {
      return res.json({
        ok: true,
        vista_previa: true,
        total: contactos.length,
        contactos: contactos.map(c => ({ numero: c.numero, nombre: c.nombre, nivel: c.nivel_interes, lead: c.odoo_lead_id }))
      });
    }

    const resultados = [];
    for (const c of contactos) {
      const conv = await Conversacion.findOne({ tenant_id: tenant._id, numero: c.numero }).sort({ ultimaActividad: -1 });
      const vendedor = conv?.agente_id ? await UsuarioPanel.findById(conv.agente_id) : await asignarAgenteLibre(tenant._id);
      const resumen = conv?.resumen_kai || (c.nivel_interes ? `Solicitud del Formulario de Admisiones para ${c.nivel_interes}.${c.zona ? ' Zona: ' + c.zona + '.' : ''}` : null);

      const r = await migrarConversacionAAcruxLab(tenant, c.numero, c.nombre, resumen, vendedor);
      resultados.push({ numero: c.numero, nombre: c.nombre, ...r });
      await new Promise(x => setTimeout(x, 1200));
    }

    res.json({
      ok: true,
      migrados: resultados.filter(r => r.ok).length,
      fallidos: resultados.filter(r => !r.ok).length,
      detalle: resultados
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Estado REAL en Odoo de los leads que KAI contactó: si tienen vendedor asignado allá,
// qué etiquetas traen, y a quién los tenemos asignados nosotros. Con ?asignar=1 escribe
// en Odoo el vendedor que ya tenemos registrado (requiere odoo_user_id configurado).
// Corrige la etiqueta "KAI — Contactado" en lote: busca contactos del Formulario de
// Admisiones que YA fueron contactados de verdad (Contacto.ultimo_contacto tiene fecha)
// pero cuyo lead en Odoo se quedó con una etiqueta vieja (ej. "Exploratorio") porque el
// primer intento de escritura falló en silencio. Sin ?aplicar=1 solo lista, no toca nada.
// GET /api/debug/corregir-etiquetas-contactados
app.get('/api/debug/corregir-etiquetas-contactados', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const aplicar = req.query.aplicar === '1';

    // Filtro opcional: si viene ?numeros=502...,502...,502... solo se revisan esos
    // teléfonos exactos — para corregir un grupo puntual sin tocar el histórico completo.
    const filtro = { tenant_id: req.user.tenant_id, odoo_lead_id: { $ne: null }, ultimo_contacto: { $ne: null } };
    if (req.query.numeros) {
      const listaNumeros = String(req.query.numeros).split(',').map(n => n.replace(/\D/g, '').slice(-8)).filter(Boolean);
      filtro.numero = { $in: listaNumeros.map(n => new RegExp(n + '$')) };
    }

    const contactos = await Contacto.find(filtro).select('numero nombre odoo_lead_id ultimo_contacto').limit(200);

    if (!contactos.length) return res.json({ ok: true, total: 0, mensaje: 'No hay contactos ya contactados para revisar' });

    const ids = contactos.map(c => c.odoo_lead_id);
    const leads = await odooCallLocal('crm.lead', 'read', [ids, ['id', 'name', 'partner_name', 'tag_ids']]) || [];
    const tagContactadoId = await getOdooTagId(TAG_KAI_CONTACTADO);

    const detalle = [];
    let corregidos = 0;
    for (const c of contactos) {
      const l = leads.find(x => x.id === c.odoo_lead_id);
      if (!l) continue;
      const yaTieneEtiqueta = (l.tag_ids || []).includes(tagContactadoId);
      const item = {
        lead: l.id, nombre: l.partner_name || l.name || c.nombre,
        numero: c.numero, ya_tenia_etiqueta: yaTieneEtiqueta, accion: null
      };
      if (!yaTieneEtiqueta) {
        if (aplicar) {
          await odooCallLocal('crm.lead', 'write', [[l.id], { tag_ids: [[4, tagContactadoId]] }]).catch(e => { item.error = e.message; });
          item.accion = item.error ? 'falló' : 'etiquetado';
          if (!item.error) corregidos++;
        } else {
          item.accion = 'se etiquetaría';
        }
        detalle.push(item);
      }
    }

    res.json({
      ok: true,
      modo: aplicar ? 'EJECUTADO' : 'VISTA PREVIA — agrega ?aplicar=1 para corregir de verdad',
      total_revisados: contactos.length,
      con_etiqueta_faltante: detalle.length,
      corregidos,
      detalle
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ===== AUDITORÍA HISTÓRICA: LEADS DEL FORMULARIO QUE TERMINARON EN "PERDIDO" =====
// Trae TODO el histórico desde que se lanzó KAI (por defecto 45 días, ajustable) —
// leads del canal Formulario Admisiones que hoy están archivados/perdidos — junto con
// su chatter COMPLETO. Es de solo lectura, no toca nada. La idea es ver con evidencia
// real (no suposición) si el archivo fue: (a) KAI marcándolo mal por el bug antiguo ya
// corregido, (b) el equipo archivándolo a mano por una razón legítima, o (c) otra causa.
// Se usa tanto desde el endpoint de diagnóstico como desde el reporte en Excel, para no
// duplicar la lógica.
async function auditarLeadsPerdidos(dias) {
  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);

  const leads = await odooCallLocal('crm.lead', 'search_read',
    [[
      ['active', '=', false],
      ['create_date', '>=', desde],
      '|', ['name', 'ilike', 'Formulario Admisiones'], ['name', 'ilike', 'Lead KAI']
    ]],
    { fields: ['id', 'name', 'partner_name', 'contact_name', 'phone', 'email_from', 'user_id', 'type', 'stage_id', 'lost_reason_id', 'create_date', 'write_date', 'tag_ids'], limit: 300, order: 'create_date asc', context: { active_test: false } }
  ) || [];

  if (!leads.length) return [];

  const idsTags = [...new Set(leads.flatMap(l => l.tag_ids || []))];
  let nombresTag = {};
  if (idsTags.length) {
    const tags = await odooCallLocal('crm.tag', 'read', [idsTags, ['id', 'name']]).catch(() => []);
    (tags || []).forEach(t => { nombresTag[t.id] = t.name; });
  }

  const detalle = [];
  for (const l of leads) {
    const mensajes = await odooCallLocal('mail.message', 'search_read',
      [[['model', '=', 'crm.lead'], ['res_id', '=', l.id]]],
      { fields: ['body', 'date', 'author_id'], limit: 50, order: 'date asc' }
    ).catch(() => []);

    const textoChatter = mensajes.map(m => (m.body || '').replace(/<[^>]+>/g, ' ').trim()).join(' | ');

    let causaProbable = 'Sin evidencia clara en el chatter — revisar a mano';
    if (/registro repetido/i.test(textoChatter)) {
      causaProbable = 'KAI detectó duplicado (con la regla actual, esto NO archiva — si está perdido, alguien lo archivó después a mano)';
    }
    if (/marcado.{0,20}perdido|perdido.{0,20}autom[aá]tic/i.test(textoChatter)) {
      causaProbable = '⚠️ Posible marca automática antigua — texto de "perdido" encontrado en el chatter, revisar fecha exacta';
    }
    const autores = [...new Set(mensajes.map(m => m.author_id?.[1]).filter(Boolean))];
    const diasEntreCreacionYUltimoMensaje = mensajes.length
      ? Math.round((new Date(mensajes[mensajes.length - 1].date) - new Date(l.create_date)) / (1000 * 60 * 60 * 24))
      : null;

    detalle.push({
      lead: l.id,
      nombre: l.partner_name || l.contact_name || l.name,
      telefono: l.phone || null,
      correo: l.email_from || null,
      vendedor: l.user_id?.[1] || 'Sin asignar',
      tipo: l.type === 'opportunity' ? 'Oportunidad' : 'Lead',
      etapa: l.stage_id?.[1] || '',
      motivo_perdida: l.lost_reason_id?.[1] || null,
      etiquetas: (l.tag_ids || []).map(t => nombresTag[t]).filter(Boolean),
      creado: l.create_date,
      ultima_modificacion: l.write_date,
      dias_entre_creacion_y_ultimo_mensaje: diasEntreCreacionYUltimoMensaje,
      total_mensajes_chatter: mensajes.length,
      autores_en_el_chatter: autores,
      causa_probable: causaProbable,
      primeros_mensajes: mensajes.slice(0, 5).map(m => ({ fecha: m.date, autor: m.author_id?.[1] || null, texto: (m.body || '').replace(/<[^>]+>/g, ' ').trim().substring(0, 250) }))
    });
  }

  return detalle;
}

// GET /api/debug/auditoria-perdidos?dias=45
app.get('/api/debug/auditoria-perdidos', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const dias = parseInt(req.query.dias) || 45;
    const detalle = await auditarLeadsPerdidos(dias);
    if (!detalle.length) return res.json({ ok: true, total: 0, mensaje: `No hay leads perdidos del Formulario en los últimos ${dias} días`, leads: [] });

    res.json({
      ok: true,
      periodo_dias: dias,
      total_perdidos_en_el_periodo: detalle.length,
      resumen_por_causa: detalle.reduce((acc, d) => { acc[d.causa_probable] = (acc[d.causa_probable] || 0) + 1; return acc; }, {}),
      resumen_por_vendedor: detalle.reduce((acc, d) => { acc[d.vendedor] = (acc[d.vendedor] || 0) + 1; return acc; }, {}),
      leads: detalle
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/debug/estado-leads-odoo', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    // Filtro opcional: si viene ?numeros=502...,502... solo se revisan/tocan esos
    // teléfonos exactos — para no repetir el caso de tocar de golpe todo el histórico.
    const filtro = { tenant_id: req.user.tenant_id, canal_origen: 'formulario_admisiones', odoo_lead_id: { $ne: null } };
    if (req.query.numeros) {
      const listaNumeros = String(req.query.numeros).split(',').map(n => n.replace(/\D/g, '').slice(-8)).filter(Boolean);
      filtro.numero = { $in: listaNumeros.map(n => new RegExp(n + '$')) };
    }
    const contactos = await Contacto.find(filtro).limit(100);

    if (!contactos.length) return res.json({ ok: true, total: 0, leads: [] });

    const ids = contactos.map(c => c.odoo_lead_id);
    const leadsOdoo = await odooCallLocal('crm.lead', 'read', [ids], {
      fields: ['id', 'name', 'user_id', 'tag_ids', 'phone', 'partner_name', 'type', 'stage_id']
    }) || [];
    const porId = {}; leadsOdoo.forEach(l => { porId[l.id] = l; });

    // Nombres de las etiquetas, para que se entienda sin ver IDs
    const idsTags = [...new Set(leadsOdoo.flatMap(l => l.tag_ids || []))];
    let nombresTag = {};
    if (idsTags.length) {
      const tags = await odooCallLocal('crm.lead.tag', 'read', [idsTags, ['id', 'name']]).catch(() => null)
                || await odooCallLocal('crm.tag', 'read', [idsTags, ['id', 'name']]).catch(() => []);
      (tags || []).forEach(t => { nombresTag[t.id] = t.name; });
    }

    const debeAsignar = req.query.asignar === '1';
    // Opcional: forzar que TODOS vayan a un vendedor concreto, en vez del reparto
    // automático. Útil cuando el equipo ya decidió quién los va a trabajar.
    // Ej: ?asignar=1&forzar=vanessa.carreto@capouilliez.edu.gt
    let vendedorForzado = null;
    if (req.query.forzar) {
      vendedorForzado = await UsuarioPanel.findOne({
        tenant_id: req.user.tenant_id,
        email: new RegExp('^' + String(req.query.forzar).trim() + '$', 'i')
      });
      if (!vendedorForzado) return res.json({ ok: false, error: `No existe un usuario con el correo "${req.query.forzar}"` });
    }
    let asignados = 0;
    const resultado = [];

    for (const c of contactos) {
      const l = porId[c.odoo_lead_id];
      if (!l) { resultado.push({ lead: c.odoo_lead_id, nombre: c.nombre, error: 'no encontrado en Odoo' }); continue; }

      // A quién lo tenemos asignado nosotros. OJO: hay que revisar las DOS fuentes reales:
      // la colección local "Conversacion" (canal Meta antiguo) Y "AsignacionAcrux" (canal
      // AcruxLab, que es donde vive prácticamente todo el tráfico real hoy). Antes solo se
      // miraba la primera, así que estos leads siempre salían "ninguno" aunque sí tuvieran
      // vendedora asignada — solo que en el otro canal.
      const conv = await Conversacion.findOne({ tenant_id: req.user.tenant_id, numero: c.numero }).sort({ ultimaActividad: -1 });
      let vendedorKai = conv?.agente_id ? await UsuarioPanel.findById(conv.agente_id) : null;
      let asignAcrux = null;

      if (!vendedorKai) {
        try {
          const convsAcrux = await odooCallLocal('acrux.chat.conversation', 'search_read',
            [[['number', '=', c.numero]]], { fields: ['id'], limit: 1 });
          if (convsAcrux && convsAcrux.length) {
            asignAcrux = await AsignacionAcrux.findOne({ tenant_id: req.user.tenant_id, contacto_id: convsAcrux[0].id });
            if (asignAcrux?.agente_id) vendedorKai = await UsuarioPanel.findById(asignAcrux.agente_id);
          }
        } catch (e) { /* si Odoo falla aquí, seguimos sin bloquear el resto */ }
      }

      // Si se pidió forzar un vendedor concreto, ese manda sobre lo que hubiera.
      let asignadoAhoraEnKai = false;
      if (debeAsignar && vendedorForzado && (conv || asignAcrux)) {
        if (conv && String(conv.agente_id || '') !== String(vendedorForzado._id)) {
          conv.agente_id = vendedorForzado._id;
          conv.agente_nombre = vendedorForzado.nombre;
          conv.ultimaActividad = new Date();
          await conv.save();
          asignadoAhoraEnKai = true;
        }
        if (asignAcrux && String(asignAcrux.agente_id || '') !== String(vendedorForzado._id)) {
          asignAcrux.agente_id = vendedorForzado._id;
          asignAcrux.agente_nombre = vendedorForzado.nombre;
          asignAcrux.fecha_asignado = new Date();
          await asignAcrux.save();
          asignadoAhoraEnKai = true;
        }
        vendedorKai = vendedorForzado;
      }

      // Si quedó SIN vendedor en ninguna de las dos fuentes (pasa con las que se crearon
      // antes de que el sistema asignara desde el primer contacto), le damos uno ahora por
      // reparto 1 a 1 y lo guardamos donde corresponda, para que Odoo y el panel coincidan.
      if (debeAsignar && !vendedorKai && (conv || asignAcrux)) {
        const nuevo = await asignarAgenteLibre(req.user.tenant_id);
        if (nuevo) {
          // OJO: hay que actualizar la fecha (fecha_asignado / ultimaActividad) al MOMENTO
          // de asignar, no solo el agente. Si solo se cambia el agente en un registro que
          // YA existía, "fecha_asignado" se queda con su valor viejo (el default de Mongoose
          // solo aplica al CREAR el documento, no al editarlo) — y entonces el conteo de
          // "asignados hoy" nunca ve esta asignación nueva. Ese hueco fue lo que hizo que
          // los 7 leads de esta corrida cayeran todos en la misma persona: el reparto seguía
          // pensando que ella tenía cero, porque cada asignación anterior quedaba invisible
          // para el conteo del día.
          if (conv) { conv.agente_id = nuevo._id; conv.agente_nombre = nuevo.nombre; conv.ultimaActividad = new Date(); await conv.save(); }
          if (asignAcrux) { asignAcrux.agente_id = nuevo._id; asignAcrux.agente_nombre = nuevo.nombre; asignAcrux.fecha_asignado = new Date(); await asignAcrux.save(); }
          vendedorKai = nuevo;
          asignadoAhoraEnKai = true;
        }
      }

      let accion = null;
      if (debeAsignar && vendedorKai) {
        if (!vendedorKai.odoo_user_id) {
          accion = `NO se pudo: a ${vendedorKai.nombre} le falta el ID de Odoo en Usuarios y Sedes`;
        } else if (l.user_id && !vendedorForzado) {
          accion = `ya tenía vendedor en Odoo (${l.user_id[1]}), no se tocó`;
        } else if (l.user_id && vendedorForzado && l.user_id[0] === vendedorKai.odoo_user_id) {
          accion = `ya estaba con ${vendedorKai.nombre} en Odoo`;
        } else {
          await odooCallLocal('crm.lead', 'write', [[l.id], { user_id: vendedorKai.odoo_user_id }]).catch(() => {});
          await odooCallLocal('crm.lead', 'message_post', [[l.id]], {
            body: `👤 Asignado a ${vendedorKai.nombre} desde el panel de KAI.`
          }).catch(() => {});
          accion = l.user_id
            ? `reasignado de ${l.user_id[1]} a ${vendedorKai.nombre}`
            : `asignado a ${vendedorKai.nombre}`;
          asignados++;
        }
      }

      resultado.push({
        lead: l.id,
        nombre: l.partner_name || c.nombre,
        telefono: l.phone || c.numero,
        tipo: l.type,
        etapa: l.stage_id?.[1] || null,
        vendedor_en_odoo: l.user_id?.[1] || 'SIN ASIGNAR',
        vendedor_en_kai: vendedorKai?.nombre || 'ninguno',
        asignado_en_kai_ahora: asignadoAhoraEnKai,
        id_odoo_del_vendedor: vendedorKai?.odoo_user_id || 'NO CONFIGURADO',
        etiquetas: (l.tag_ids || []).map(t => nombresTag[t] || t),
        accion
      });
    }

    res.json({
      ok: true,
      total: resultado.length,
      sin_vendedor_en_odoo: resultado.filter(r => r.vendedor_en_odoo === 'SIN ASIGNAR').length,
      asignados_ahora: asignados,
      leads: resultado
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ¿Qué ve exactamente un usuario en su bandeja, y por qué? Simula los mismos filtros
// que aplica el panel para ese usuario, y explica el motivo de cada inclusión/exclusión.
// GET /api/debug/que-ve-usuario?email=vanessa.carreto@capouilliez.edu.gt
app.get('/api/debug/que-ve-usuario', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const email = (req.query.email || '').trim().toLowerCase();
    if (!email) return res.json({ ok: false, error: 'Falta ?email=' });

    const usuario = await UsuarioPanel.findOne({ tenant_id: req.user.tenant_id, email: new RegExp('^' + email + '$', 'i') });
    if (!usuario) return res.json({ ok: false, error: 'Usuario no encontrado con ese correo' });

    const esSupervisor = usuario.role === 'admin' || usuario.role === 'viewer';

    // Todas las conversaciones abiertas (sin filtrar por usuario)
    const todas = await Conversacion.find({
      tenant_id: req.user.tenant_id,
      estado: { $ne: 'cerrado' }
    }).sort({ ultimaActividad: -1 }).limit(100).select('numero nombre canal estado agente_id agente_nombre ultimaActividad');

    const detalle = todas.map(c => {
      const asignadaAEl = c.agente_id && c.agente_id.toString() === usuario._id.toString();
      const sinAsignar = !c.agente_id;
      let visible, motivo;

      if (esSupervisor) {
        visible = true; motivo = 'es supervisor: ve todo';
      } else if (asignadaAEl) {
        visible = true; motivo = 'asignada a él/ella';
      } else if (sinAsignar) {
        visible = true; motivo = 'sin asignar: cualquiera puede tomarla';
      } else {
        visible = false; motivo = `asignada a otra persona (${c.agente_nombre || 'desconocida'})`;
      }

      // Los chats en modo 'bot' solo salen si el interruptor "Ver los que atiende KAI"
      // está encendido — si está apagado, se ocultan aunque le pertenezcan.
      const requiereInterruptorKai = c.estado === 'bot';

      return {
        numero: c.numero,
        nombre: c.nombre || 'Sin nombre',
        canal: c.canal,
        estado: c.estado,
        asignada_a: c.agente_nombre || 'SIN ASIGNAR',
        visible_para_este_usuario: visible,
        motivo,
        solo_si_interruptor_kai_encendido: requiereInterruptorKai
      };
    });

    res.json({
      ok: true,
      usuario: { nombre: usuario.nombre, email: usuario.email, role: usuario.role, activo: usuario.activo, disponible: usuario.disponible, id: usuario._id },
      es_supervisor: esSupervisor,
      total_conversaciones_abiertas: detalle.length,
      ve_en_total: detalle.filter(d => d.visible_para_este_usuario).length,
      de_esas_requieren_interruptor_kai: detalle.filter(d => d.visible_para_este_usuario && d.solo_si_interruptor_kai_encendido).length,
      conversaciones: detalle
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Procesa los CALIENTES de Instagram/Messenger: crea el lead en Odoo con etiqueta,
// le asigna vendedora, y si dejaron teléfono, KAI los contacta por el número oficial.
// Sin ?ejecutar=1 solo muestra qué haría, sin tocar nada.
const TAG_KAI_REDES = 'KAI — Caliente (Redes)';
app.post('/api/motor/procesar-social-calientes', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const ejecutar = req.body?.ejecutar === true;
    const lista = req.body?.calientes; // se le pasa el resultado del escáner
    if (!Array.isArray(lista) || !lista.length) {
      return res.json({ ok: false, error: 'Manda el arreglo "calientes" con lo que devolvió el escáner' });
    }

    const tenant = await Tenant.findOne({ _id: req.user.tenant_id });
    const resultados = [];

    for (const item of lista) {
      let tel = item.telefono_detectado ? String(item.telefono_detectado).replace(/\D/g, '') : null;
      if (tel && tel.length === 8) tel = '502' + tel;

      // ===== INTERRUPTOR MAESTRO: KAI PAUSADO EN PRODUCCIÓN =====
      if (KAI_PAUSADO_PARA_PRODUCCION && !esNumeroDePrueba(tel)) {
        resultados.push({ nombre: item.nombre_detectado || item.nombre, ok: false, motivo: 'kai_pausado' });
        continue;
      }

      const nombre = item.nombre_detectado || item.nombre || 'Sin nombre';

      if (!ejecutar) {
        // En vista previa también revisamos duplicados, para que se vea de antemano
        // a quién se le crearía lead nuevo y a quién no.
        let yaExiste = null;
        if (tel) {
          const condicionesTel = condicionesTelefono(tel);
          const dominioTel = [['active', '=', true]];
          for (let i = 0; i < condicionesTel.length - 1; i++) dominioTel.push('|');
          condicionesTel.forEach(c => dominioTel.push(c));
          const encontrados = await odooCallLocal('crm.lead', 'search_read',
            [dominioTel],
            { fields: ['id', 'partner_name', 'name', 'user_id', 'create_date'], limit: 3, order: 'create_date desc' }
          ) || [];
          if (encontrados.length) yaExiste = encontrados[0];
        }
        resultados.push({
          nombre, canal: item.canal, telefono: tel,
          YA_EXISTE_EN_ODOO: yaExiste ? `lead #${yaExiste.id} (${yaExiste.partner_name || yaExiste.name}) — ${yaExiste.user_id?.[1] || 'sin vendedor'}` : 'no',
          accion_que_se_haria: yaExiste
            ? 'NO crear lead: solo etiquetar el existente y dejar nota'
            : (tel
              ? 'crear lead en Odoo con etiqueta, asignar vendedora y contactar por WhatsApp oficial'
              : 'crear lead en Odoo con etiqueta y asignar vendedora (sin teléfono: responder por la red social)')
        });
        continue;
      }

      try {
        // ===== REVISAR DUPLICADOS ANTES DE CREAR =====
        // Estos papás pudieron haber escrito antes por otro canal, o alguien pudo
        // haberlos metido a mano en Odoo. Crear otro lead ensuciaría el CRM.
        const leadExistente = await buscarLeadExistente({ telefono: tel, correo: item.correo_detectado });

        if (leadExistente) {
          // Ya existe: solo le agregamos la etiqueta y dejamos nota — NO creamos otro.
          const tagRedesExistente = await getOdooTagId(TAG_KAI_REDES);
          if (tagRedesExistente) {
            await odooCallLocal('crm.lead', 'write', [[leadExistente.id], { tag_ids: [[4, tagRedesExistente]] }]).catch(() => {});
          }
          await anotarOrigenEnLead(leadExistente.id, leadExistente.active === false,
            `📲 Volvió a escribir por <b>${item.canal === 'instagram' ? 'Instagram' : 'Messenger'}</b>: "${(item.mensaje || '').substring(0, 200)}"<br>KAI lo clasificó como CALIENTE.`);
          await asignarVendedorSiFalta(tenant, leadExistente);

          if (item.id) {
            await Conversacion.findOneAndUpdate(
              { _id: item.id, tenant_id: req.user.tenant_id },
              { $set: { estado: 'cerrado', motivo: `Ya existía el lead #${leadExistente.id} — se agregó la etiqueta y la nota` } }
            ).catch(() => {});
          }

          resultados.push({
            nombre, canal: item.canal, telefono: tel,
            YA_EXISTIA: true,
            lead_existente: leadExistente.id,
            nombre_en_odoo: leadExistente.partner_name || leadExistente.name,
            vendedor_en_odoo: leadExistente.user_id?.[1] || 'SIN ASIGNAR',
            creado_el: leadExistente.create_date?.substring(0, 16),
            accion: 'se etiquetó y se dejó nota, NO se creó lead nuevo'
          });
          await new Promise(x => setTimeout(x, 1500));
          continue;
        }

        const vendedor = await asignarAgenteLibre(tenant._id);
        const tagRedes = await getOdooTagId(TAG_KAI_REDES);

        // Crear el lead en Odoo con lo que se pudo rescatar del mensaje
        const leadId = await odooCallLocal('crm.lead', 'create', [{
          name: `Lead ${item.canal === 'instagram' ? 'Instagram' : 'Messenger'} — ${nombre}`,
          contact_name: nombre,
          partner_name: nombre,
          phone: tel || undefined,
          email_from: item.correo_detectado || undefined,
          description: `Origen: ${item.canal}\nMensaje recibido: ${item.mensaje || ''}\nClasificado por KAI como CALIENTE: ${item.motivo || ''}`,
          type: 'lead',
          tag_ids: tagRedes ? [[6, 0, [tagRedes]]] : undefined,
          user_id: vendedor?.odoo_user_id || false // explícito SIEMPRE, nunca undefined
        }]);

        let contactado = false;
        if (tel && leadId) {
          const r = await contactarLeadPorAcruxLab(tenant, {
            id: leadId, phone: tel, mobile: false,
            partner_name: nombre, contact_name: nombre,
            email_from: item.correo_detectado || false,
            x_studio_comentarios: item.nivel_detectado || false,
            x_studio_notas_1: false
          });
          contactado = !!r.ok;
        }

        // La conversación de la red social se cierra: ya quedó convertida en lead y
        // se sigue por WhatsApp, así no estorba en la bandeja.
        if (item.id) {
          await Conversacion.findOneAndUpdate(
            { _id: item.id, tenant_id: req.user.tenant_id },
            { $set: { estado: 'cerrado', motivo: `Convertido en lead #${leadId} y trasladado a WhatsApp` } }
          ).catch(() => {});
        }

        resultados.push({ nombre, canal: item.canal, telefono: tel, lead_creado: leadId, vendedor: vendedor?.nombre || null, contactado_por_whatsapp: contactado });
        await new Promise(x => setTimeout(x, 2000));
      } catch (e) {
        resultados.push({ nombre, canal: item.canal, error: e.message });
      }
    }

    res.json({
      ok: true,
      modo: ejecutar ? 'EJECUTADO' : 'vista previa (no se tocó nada)',
      total: resultados.length,
      detalle: resultados
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// "Soltar" una conversación: la saca de la bandeja sin borrar nada. Sirve para los
// mensajes que no requieren acción (felicitaciones, comentarios) y solo estorban.
app.post('/api/conversaciones/:id/soltar', authMiddleware, async (req, res) => {
  try {
    const conv = await Conversacion.findOneAndUpdate(
      { _id: req.params.id, tenant_id: req.user.tenant_id },
      { $set: { estado: 'cerrado', motivo: `Soltada por ${req.user.nombre || 'un usuario'} — no requiere atención` } },
      { new: true }
    );
    if (!conv) return res.status(404).json({ ok: false, error: 'No encontrada' });
    res.json({ ok: true, mensaje: 'Conversación soltada' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Limpia lo que se generó con los números de prueba: conversaciones del panel,
// asignaciones y el vínculo al lead de Odoo. Sin ?limpiar=1 solo muestra qué hay.
// NOTA: no borra el lead en Odoo (eso lo decide el equipo), solo desvincula.
app.get('/api/debug/limpiar-numeros-prueba', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const hacer = req.query.limpiar === '1';
    const resumen = [];

    for (const num of NUMEROS_DE_PRUEBA) {
      const limpio = String(num).replace(/\D/g, '');
      const contacto = await Contacto.findOne({ tenant_id: req.user.tenant_id, numero: limpio });
      const convs = await Conversacion.find({ tenant_id: req.user.tenant_id, numero: limpio }).select('_id estado agente_nombre');

      // Conversaciones de AcruxLab con ese número
      let convsAcrux = [];
      try {
        convsAcrux = await odooCallLocal('acrux.chat.conversation', 'search_read',
          [[['number', '=', limpio]]], { fields: ['id', 'name'], limit: 5 }) || [];
      } catch (e) { /* no bloqueante */ }
      const asigns = convsAcrux.length
        ? await AsignacionAcrux.find({ tenant_id: req.user.tenant_id, contacto_id: { $in: convsAcrux.map(c => c.id) } })
        : [];

      const item = {
        numero: limpio,
        lead_odoo_vinculado: contacto?.odoo_lead_id || null,
        conversaciones_en_panel: convs.length,
        asignaciones_acrux: asigns.map(a => ({ conversacion: a.contacto_id, modo: a.modo, agente: a.agente_nombre })),
        acciones: []
      };

      if (hacer) {
        // Desvincular el lead y limpiar la clasificación, para que no cuente como candidato
        if (contacto) {
          contacto.odoo_lead_id = null;
          contacto.nivel_calor_etiqueta = null;
          await contacto.save();
          item.acciones.push('contacto desvinculado del lead de Odoo');
        }
        // Devolver a KAI todas las asignaciones de AcruxLab
        for (const a of asigns) {
          await AsignacionAcrux.updateOne(
            { _id: a._id },
            { modo: 'bot', fecha_modo_humano: null, sin_auto_recuperacion: false, agente_id: null, agente_nombre: null }
          );
        }
        if (asigns.length) item.acciones.push(`${asigns.length} conversación(es) de AcruxLab devueltas a KAI`);
        // Cerrar las conversaciones del panel para que no estorben
        if (convs.length) {
          await Conversacion.updateMany(
            { tenant_id: req.user.tenant_id, numero: limpio },
            { $set: { estado: 'cerrado', motivo: 'Número de pruebas — limpiado' } }
          );
          item.acciones.push(`${convs.length} conversación(es) del panel cerradas`);
        }
      }

      resumen.push(item);
    }

    res.json({
      ok: true,
      modo: hacer ? 'LIMPIADO' : 'solo consulta — agrega ?limpiar=1 para ejecutar',
      numeros_de_prueba: NUMEROS_DE_PRUEBA,
      detalle: resumen
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Limpia las imágenes duplicadas que fue creando el seed en cada reinicio — las que
// tienen nombres tipo "(versión 2)", "(versión 3)", etc. Sin ?eliminar=1 solo las lista.
app.get('/api/debug/limpiar-imagenes-duplicadas', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const todas = await ImagenMarketing.find({ tenant_id: req.user.tenant_id })
      .select('nombre categoria nivel_educativo creado subida_por_nombre veces_enviada');

    // Las duplicadas son las que traen "(versión N)" o "(vN)" en el nombre
    const patronVersion = /\s*\((?:versi[oó]n\s*\d+|v\d+)\)\s*$/i;
    const duplicadas = todas.filter(i => patronVersion.test(i.nombre));
    const originales = todas.filter(i => !patronVersion.test(i.nombre));

    let eliminadas = 0;
    if (req.query.eliminar === '1') {
      // Solo se borra la copia si el original con el mismo nombre base sigue existiendo,
      // para no dejar al Banco sin esa imagen.
      for (const dup of duplicadas) {
        const nombreBase = dup.nombre.replace(patronVersion, '').trim();
        const existeOriginal = originales.some(o => o.nombre.trim() === nombreBase);
        if (existeOriginal) {
          await ImagenMarketing.deleteOne({ _id: dup._id, tenant_id: req.user.tenant_id });
          eliminadas++;
        }
      }
    }

    res.json({
      ok: true,
      total_en_banco: todas.length,
      duplicadas_detectadas: duplicadas.length,
      eliminadas,
      nota: req.query.eliminar === '1' ? 'Se eliminaron las copias que tenían original' : 'Solo lista — agrega ?eliminar=1 para borrarlas',
      duplicadas: duplicadas.map(d => ({
        nombre: d.nombre,
        original_existe: originales.some(o => o.nombre.trim() === d.nombre.replace(patronVersion, '').trim()),
        categoria: d.categoria,
        nivel: d.nivel_educativo,
        veces_enviada: d.veces_enviada || 0
      }))
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// SIMULADOR — muestra qué imágenes y textos enviaría KAI ante un mensaje, SIN enviar
// nada a nadie. Sirve para probar cambios sin arriesgar conversaciones reales.
// GET /api/debug/simular?mensaje=cuotas y horarios de primaria&nivel=Primaria
app.get('/api/debug/simular', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const mensaje = String(req.query.mensaje || '').trim();
    const nivelSesion = String(req.query.nivel || '').trim() || null;
    const nivelesMultiples = req.query.niveles_multiples ? String(req.query.niveles_multiples).split(',').map(n => n.trim()) : [];
    if (!mensaje) return res.json({ ok: false, error: 'Falta ?mensaje=' });

    const nivelDetectado = detectarNivelEnTexto(mensaje);
    const nivelUsado = nivelDetectado || nivelSesion;
    const match = buscarReglaImagenCoincidente(mensaje, nivelUsado);
    const todas = buscarTodasLasReglasCoincidentes(mensaje, nivelUsado, nivelesMultiples);

    // Buscar las imágenes reales que se enviarían
    const imagenes = [];
    for (const regla of (todas.length ? todas : (match?.regla ? [match.regla] : []))) {
      const filtro = { tenant_id: req.user.tenant_id, activo: true, categoria: regla.categoria };
      if (regla.nivel_educativo) filtro.nivel_educativo = { $in: [regla.nivel_educativo, 'Todos'] };
      if (regla.nombre_contiene) filtro.nombre = new RegExp(regla.nombre_contiene, 'i');
      const img = await ImagenMarketing.findOne(filtro).sort({ prioridad: -1, creado: -1 });
      imagenes.push({
        tema: regla.categoria,
        imagen: img ? img.nombre : '⚠️ NO HAY IMAGEN CARGADA para este tema y nivel',
        nivel_de_la_imagen: img?.nivel_educativo || null,
        texto_que_la_acompaña: img ? construirDescripcionImagen(img) : null
      });
    }

    res.json({
      ok: true,
      nota: 'SIMULACIÓN — no se envió ningún mensaje',
      mensaje_probado: mensaje,
      nivel_detectado_en_el_mensaje: nivelDetectado,
      nivel_usado: nivelUsado,
      pide_agente: detectaSolicitudAgente(mensaje),
      es_alta_intencion: esAltaIntencion(mensaje, ''),
      falta_preguntar_el_grado: !!match?.ambigua,
      total_imagenes_que_enviaria: imagenes.length,
      imagenes
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Deshace la reactivación anterior: vuelve a archivar los leads que se reactivaron por
// el endpoint "revertir-perdidos-por-error", usando la misma nota como rastro. Se usa
// si el equipo decide que, después de todo, prefiere dejarlos como estaban.
// GET /api/debug/reversar-reactivacion?confirmar=1
app.get('/api/debug/reversar-reactivacion', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const confirmar = req.query.confirmar === '1';

    const mensajes = await odooCallLocal('mail.message', 'search_read',
      [[
        ['model', '=', 'crm.lead'],
        ['body', 'ilike', 'fue marcado como perdido por error'],
      ]],
      { fields: ['res_id'], limit: 200, order: 'date desc' }
    ) || [];

    const idsAfectados = [...new Set(mensajes.map(m => m.res_id))];
    if (!idsAfectados.length) {
      return res.json({ ok: true, total: 0, mensaje: 'No se encontró ningún lead de esa reactivación' });
    }

    const leads = await odooCallLocal('crm.lead', 'read', [idsAfectados, ['id', 'name', 'partner_name', 'active']]) || [];

    let archivados = 0;
    const detalle = [];
    for (const l of leads) {
      const item = { lead: l.id, nombre: l.partner_name || l.name, ya_estaba_archivado: l.active === false, accion: null };
      if (confirmar && l.active !== false) {
        await odooCallLocal('crm.lead', 'write', [[l.id], { active: false, probability: 0 }]).catch(() => {});
        await odooCallLocal('crm.lead', 'message_post', [[l.id]], {
          body: `↩️ Se vuelve a archivar a solicitud del equipo — se decidió dejarlo como estaba antes de la reactivación.`
        }).catch(() => {});
        item.accion = 'archivado de nuevo';
        archivados++;
      } else if (l.active === false) {
        item.accion = 'ya estaba archivado';
      }
      detalle.push(item);
    }

    res.json({
      ok: true,
      modo: confirmar ? 'EJECUTADO' : 'VISTA PREVIA — agrega ?confirmar=1 para archivarlos de nuevo',
      total: leads.length,
      archivados,
      detalle
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Rastrea los leads que KAI marcó como PERDIDOS por error (por ser duplicados) antes de
// esta corrección — buscando la frase exacta que el sistema dejaba en el chatter. Con
// ?revertir=1 los reactiva (active:true) y los regresa a la primera etapa del pipeline,
// dejando nota de la corrección. NO toca los que el equipo haya marcado perdidos a mano.
// GET /api/debug/revertir-perdidos-por-error
app.get('/api/debug/revertir-perdidos-por-error', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const revertir = req.query.revertir === '1';

    // Buscamos en el chatter de crm.lead los mensajes con la frase exacta que dejaba
    // el sistema al marcar como perdido por duplicado (versión vieja, ya corregida).
    const mensajes = await odooCallLocal('mail.message', 'search_read',
      [[
        ['model', '=', 'crm.lead'],
        '|', ['body', 'ilike', 'Se marca como perdido por duplicado'], ['body', 'ilike', 'no se le vuelve a escribir'],
      ]],
      { fields: ['res_id', 'body', 'date'], limit: 200, order: 'date desc' }
    ) || [];

    const idsAfectados = [...new Set(mensajes.map(m => m.res_id))];
    if (!idsAfectados.length) {
      return res.json({ ok: true, total: 0, mensaje: 'No se encontró ningún lead marcado perdido por este error' });
    }

    const leads = await odooCallLocal('crm.lead', 'read',
      [idsAfectados, ['id', 'name', 'partner_name', 'phone', 'active', 'probability', 'stage_id', 'user_id']]
    ) || [];

    // Primera etapa del pipeline, para regresar ahí a los que se reactiven
    let primeraEtapa = null;
    if (revertir) {
      const etapas = await odooCallLocal('crm.stage', 'search_read', [[]], { fields: ['id', 'name'], order: 'sequence asc', limit: 1 }) || [];
      primeraEtapa = etapas[0] || null;
    }

    let revertidos = 0;
    const detalle = [];
    for (const l of leads) {
      const estabaMarcadoPerdido = l.active === false || l.probability === 0;
      const item = {
        lead: l.id,
        nombre: l.partner_name || l.name,
        telefono: l.phone,
        estaba_archivado: l.active === false,
        probabilidad_actual: l.probability,
        vendedor: l.user_id?.[1] || null,
        accion: null
      };

      if (revertir && estabaMarcadoPerdido) {
        const cambios = { active: true };
        if (primeraEtapa) cambios.stage_id = primeraEtapa.id;
        await odooCallLocal('crm.lead', 'write', [[l.id], cambios]).catch(() => {});
        await odooCallLocal('crm.lead', 'message_post', [[l.id]], {
          body: `✅ Este lead fue marcado como perdido por error (un bug del sistema clasificaba los duplicados como perdidos). Se reactivó${primeraEtapa ? ` y se regresó a la etapa "${primeraEtapa.name}"` : ''}. El equipo debe revisar y decidir qué hacer con él.`
        }).catch(() => {});
        item.accion = 'reactivado';
        revertidos++;
      } else if (!estabaMarcadoPerdido) {
        item.accion = 'no estaba marcado perdido (alguien ya lo corrigió, o el equipo lo cambió después)';
      }

      detalle.push(item);
    }

    res.json({
      ok: true,
      modo: revertir ? 'REVERTIDO' : 'VISTA PREVIA — agrega ?revertir=1 para reactivarlos',
      total_afectados: leads.length,
      revertidos,
      detalle
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Prueba poner la etiqueta "KAI — Contactado" a un lead SIN ocultar el error (el código
// real usa .catch(()=>{}) ahí, así que si algo falla, queda en silencio). Esto lo
// muestra tal cual, para saber por qué algunos leads se quedan sin la etiqueta.
// GET /api/debug/probar-etiqueta?lead=40310
// Etiqueta y asigna vendedor a un lead por ID directo — sirve para duplicados sueltos
// (mismo papá, otro registro de Odoo) que no están vinculados a nuestro Contacto y por
// eso ningún otro comando los alcanza. Deja nota explicando que es el mismo contacto de
// otro lead ya trabajado. Sin ?aplicar=1 solo muestra qué haría.
// GET /api/debug/sincronizar-lead-duplicado?lead=40332&vendedor=vanessa.carreto@capouilliez.edu.gt&lead_principal=40298
// Busca un lead por correo y muestra su estado + chatter completo — para rastrear
// EXACTAMENTE qué proceso hizo un cambio y cuándo, en vez de suponerlo.
// GET /api/debug/rastrear-lead-por-correo?correo=xxx@gmail.com
// Muestra el lead de Odoo al que NUESTRO propio Contacto está vinculado (usando
// odoo_lead_id directamente) — en vez de rebuscar por teléfono, que puede fallar si el
// número está guardado en Odoo con un formato que la búsqueda no reconoce.
// GET /api/debug/lead-vinculado-al-contacto?numero=502XXXXXXXX
// Busca VARIOS números directo en Odoo (todos los formatos, activos y archivados) —
// para los casos donde nuestro Contacto no tiene odoo_lead_id guardado, y hace falta
// confirmar con certeza si de verdad no existe ningún lead, o si existe pero nunca se
// enlazó desde nuestro lado.
// GET /api/debug/buscar-leads-por-numeros?numeros=502...,502...,502...
// Asigna un vendedor a un lead/oportunidad específico, por ID directo — rápido, sin
// vueltas, para cuando ya se confirmó con certeza quién es el vendedor correcto.
// GET /api/debug/asignar-vendedor-directo?lead=15185&email=sylvia@capouilliez.edu.gt
app.get('/api/debug/asignar-vendedor-directo', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const leadId = parseInt(req.query.lead);
    const email = String(req.query.email || '').trim();
    if (!leadId || !email) return res.json({ ok: false, error: 'Faltan ?lead= y ?email=' });

    const vendedor = await UsuarioPanel.findOne({ tenant_id: req.user.tenant_id, email: new RegExp('^' + email + '$', 'i') });
    if (!vendedor) return res.json({ ok: false, error: `No existe un usuario con el correo "${email}"` });
    if (!vendedor.odoo_user_id) return res.json({ ok: false, error: `${vendedor.nombre} no tiene odoo_user_id configurado` });

    const antes = await odooCallLocal('crm.lead', 'read', [[leadId], ['id', 'name', 'partner_name', 'user_id']]);
    if (!antes?.length) return res.json({ ok: false, error: `No existe el lead #${leadId}` });

    if (req.query.aplicar !== '1') {
      return res.json({
        ok: true, modo: 'VISTA PREVIA — agrega &aplicar=1 para escribir de verdad',
        lead: leadId, nombre: antes[0].partner_name || antes[0].name,
        vendedor_actual: antes[0].user_id?.[1] || 'Sin asignar',
        se_asignaria_a: vendedor.nombre
      });
    }

    await odooCallLocal('crm.lead', 'write', [[leadId], { user_id: vendedor.odoo_user_id }]);
    res.json({ ok: true, modo: 'EJECUTADO', lead: leadId, asignado_a: vendedor.nombre });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/debug/buscar-leads-por-numeros', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const numeros = String(req.query.numeros || '').split(',').map(n => n.trim()).filter(Boolean);
    if (!numeros.length) return res.json({ ok: false, error: 'Falta ?numeros=502...,502...' });

    const resultado = [];
    for (const numero of numeros) {
      const condiciones = condicionesTelefono(numero);
      if (!condiciones.length) { resultado.push({ numero, encontrados: 0, leads: [], error: 'Número inválido' }); continue; }

      const dominio = [];
      for (let i = 0; i < condiciones.length - 1; i++) dominio.push('|');
      condiciones.forEach(c => dominio.push(c));

      const leads = await odooCallLocal('crm.lead', 'search_read',
        [dominio],
        { fields: ['id', 'name', 'partner_name', 'contact_name', 'phone', 'mobile', 'user_id', 'type', 'stage_id', 'active', 'create_date'], limit: 10, order: 'create_date desc', context: { active_test: false } }
      ).catch(() => []);

      resultado.push({
        numero,
        encontrados: leads.length,
        leads: leads.map(l => ({
          id: l.id, nombre: l.partner_name || l.contact_name || l.name,
          vendedor: l.user_id?.[1] || 'Sin asignar',
          tipo: l.type === 'opportunity' ? 'Oportunidad' : 'Lead',
          etapa: l.stage_id?.[1] || '',
          activo: l.active,
          creado: l.create_date
        }))
      });
    }

    res.json({ ok: true, total_numeros_revisados: resultado.length, resultado });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/debug/lead-vinculado-al-contacto', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const numero = String(req.query.numero || '').replace(/\D/g, '');
    const contacto = await Contacto.findOne({ tenant_id: req.user.tenant_id, numero }).lean();
    if (!contacto) return res.json({ ok: false, error: 'No existe un Contacto con ese número en nuestro sistema' });
    if (!contacto.odoo_lead_id) return res.json({ ok: true, contacto, mensaje: 'Este contacto no tiene ningún odoo_lead_id vinculado todavía' });

    const lead = await odooCallLocal('crm.lead', 'read',
      [[contacto.odoo_lead_id], ['id', 'name', 'partner_name', 'phone', 'user_id', 'type', 'stage_id', 'active', 'create_date']],
      { context: { active_test: false } }
    );

    res.json({ ok: true, contacto_en_mongo: contacto, lead_vinculado: lead?.[0] || 'No se encontró (puede que se haya eliminado en Odoo)' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/debug/rastrear-lead-por-correo', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const correo = String(req.query.correo || '').trim();
    if (!correo) return res.json({ ok: false, error: 'Falta ?correo=' });

    const leads = await odooCallLocal('crm.lead', 'search_read',
      [[['email_from', 'ilike', correo]]],
      { fields: ['id', 'name', 'partner_name', 'tag_ids', 'user_id', 'create_date', 'active'], limit: 10 }
    ) || [];
    if (!leads.length) return res.json({ ok: true, encontrados: 0, mensaje: 'No hay ningún lead con ese correo' });

    const idsTags = [...new Set(leads.flatMap(l => l.tag_ids || []))];
    let nombresTag = {};
    if (idsTags.length) {
      const tags = await odooCallLocal('crm.tag', 'read', [idsTags, ['id', 'name']]).catch(() => []);
      (tags || []).forEach(t => { nombresTag[t.id] = t.name; });
    }

    const resultado = [];
    for (const l of leads) {
      const mensajes = await odooCallLocal('mail.message', 'search_read',
        [[['model', '=', 'crm.lead'], ['res_id', '=', l.id]]],
        { fields: ['body', 'date'], limit: 20, order: 'date asc' }
      ) || [];
      resultado.push({
        lead: l.id,
        nombre: l.partner_name || l.name,
        etiquetas: (l.tag_ids || []).map(t => nombresTag[t] || t),
        vendedor: l.user_id?.[1] || 'SIN ASIGNAR',
        activo: l.active,
        creado: l.create_date?.substring(0, 16),
        chatter: mensajes.map(m => ({ fecha: m.date, texto: (m.body || '').replace(/<[^>]+>/g, ' ').trim().substring(0, 300) }))
      });
    }

    res.json({ ok: true, encontrados: resultado.length, leads: resultado });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/debug/sincronizar-lead-duplicado', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const leadId = parseInt(req.query.lead);
    const leadPrincipal = req.query.lead_principal ? parseInt(req.query.lead_principal) : null;
    const vendedorEmail = req.query.vendedor;
    if (!leadId || !vendedorEmail) return res.json({ ok: false, error: 'Faltan ?lead= y ?vendedor=' });

    const vendedor = await UsuarioPanel.findOne({ tenant_id: req.user.tenant_id, email: new RegExp('^' + vendedorEmail + '$', 'i') });
    if (!vendedor) return res.json({ ok: false, error: `No existe un usuario con el correo "${vendedorEmail}"` });
    if (!vendedor.odoo_user_id) return res.json({ ok: false, error: `A ${vendedor.nombre} le falta el ID de Odoo en Usuarios y Sedes` });

    const antes = await odooCallLocal('crm.lead', 'read', [[leadId], ['id', 'name', 'partner_name', 'user_id', 'tag_ids']]);
    if (!antes || !antes.length) return res.json({ ok: false, error: `No existe el lead #${leadId}` });

    if (req.query.aplicar !== '1') {
      return res.json({
        ok: true, modo: 'VISTA PREVIA — agrega &aplicar=1 para escribir de verdad',
        lead: leadId, nombre: antes[0].partner_name || antes[0].name,
        vendedor_actual: antes[0].user_id?.[1] || 'SIN ASIGNAR',
        se_asignaria_a: vendedor.nombre
      });
    }

    const tagContactadoId = await getOdooTagId(TAG_KAI_CONTACTADO);
    await odooCallLocal('crm.lead', 'write', [[leadId], { user_id: vendedor.odoo_user_id, tag_ids: [[4, tagContactadoId]] }]);
    await odooCallLocal('crm.lead', 'message_post', [[leadId]], {
      body: `👤 Asignado a ${vendedor.nombre} — este registro es un duplicado del mismo contacto` +
        (leadPrincipal ? ` que el lead #${leadPrincipal}, donde ya se le está atendiendo.` : '.')
    }).catch(() => {});

    res.json({ ok: true, modo: 'EJECUTADO', lead: leadId, asignado_a: vendedor.nombre });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/debug/probar-etiqueta', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const leadId = parseInt(req.query.lead);
    if (!leadId) return res.json({ ok: false, error: 'Falta ?lead=' });

    const pasos = [];

    // 1) Resolver el ID de la etiqueta
    let tagId;
    try {
      const existentes = await odooCallLocal('crm.tag', 'search_read', [[['name', '=', 'KAI — Contactado']]], { fields: ['id'], limit: 5 });
      pasos.push({ paso: '1. Buscar la etiqueta', encontradas: existentes });
      if (existentes && existentes.length) {
        tagId = existentes[0].id;
      } else {
        tagId = await odooCallLocal('crm.tag', 'create', [{ name: 'KAI — Contactado' }]);
        pasos.push({ paso: '1b. Se creó porque no existía', id_creado: tagId });
      }
    } catch (e) {
      pasos.push({ paso: '1. Buscar/crear la etiqueta', error: e.message });
      return res.json({ ok: false, pasos });
    }

    // 2) Ver el estado actual del lead (qué etiquetas ya tiene)
    const antes = await odooCallLocal('crm.lead', 'read', [[leadId], ['id', 'name', 'tag_ids']]).catch(e => ({ error: e.message }));
    pasos.push({ paso: '2. Etiquetas actuales del lead', resultado: antes });

    // 3) Intentar escribir la etiqueta, SIN atrapar el error
    try {
      await odooCallLocal('crm.lead', 'write', [[leadId], { tag_ids: [[4, tagId]] }]);
      pasos.push({ paso: '3. Escribir la etiqueta', resultado: '✅ sin error' });
    } catch (e) {
      pasos.push({ paso: '3. Escribir la etiqueta', error: e.message });
    }

    // 4) Releer para confirmar si de verdad se guardó
    const despues = await odooCallLocal('crm.lead', 'read', [[leadId], ['id', 'tag_ids']]).catch(e => ({ error: e.message }));
    pasos.push({ paso: '4. Releer después de escribir', resultado: despues });

    res.json({ ok: true, lead: leadId, tag_id_usado: tagId, pasos });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Muestra las últimas asignaciones SIN filtrar por fecha (a diferencia de
// asignacion-de-hoy). Sirve para descartar un problema de zona horaria en el cálculo
// de "hoy": el servidor puede estar en UTC, 6 horas adelante de Guatemala.
// GET /api/debug/ultimas-asignaciones?n=15
app.get('/api/debug/ultimas-asignaciones', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const n = Math.min(parseInt(req.query.n) || 15, 50);
    const tenantId = req.user.tenant_id;

    const convsMeta = await Conversacion.find({ tenant_id: tenantId, agente_id: { $ne: null } })
      .select('agente_nombre nombre numero ultimaActividad').sort({ ultimaActividad: -1 }).limit(n);
    const asignsAcrux = await AsignacionAcrux.find({ tenant_id: tenantId, agente_id: { $ne: null } })
      .select('agente_nombre contacto_id fecha_asignado').sort({ fecha_asignado: -1 }).limit(n);

    res.json({
      ok: true,
      hora_actual_servidor: new Date().toISOString(),
      meta: convsMeta.map(c => ({ agente: c.agente_nombre, quien: c.nombre || c.numero, hora: c.ultimaActividad })),
      acrux: asignsAcrux.map(a => ({ agente: a.agente_nombre, conversacion: a.contacto_id, hora: a.fecha_asignado }))
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Muestra la asignación de HOY, en orden cronológico, para verificar si de verdad se
// repartió 1 a 1 entre las asesoras. Es la vista que responde "¿fue equitativo hoy?"
// con datos, no con impresión.
// GET /api/debug/asignacion-de-hoy
app.get('/api/debug/asignacion-de-hoy', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const tenantId = req.user.tenant_id;
    const inicioDeHoy = new Date();
    inicioDeHoy.setHours(0, 0, 0, 0);

    const vendedoras = await UsuarioPanel.find({ tenant_id: tenantId, role: 'vendedor' }).select('nombre _id');
    const nombrePorId = {}; vendedoras.forEach(v => { nombrePorId[v._id.toString()] = v.nombre; });

    const convsMeta = await Conversacion.find({
      tenant_id: tenantId, agente_id: { $ne: null }, ultimaActividad: { $gte: inicioDeHoy }
    }).select('agente_id agente_nombre nombre numero ultimaActividad').sort({ ultimaActividad: 1 });

    const asignsAcrux = await AsignacionAcrux.find({
      tenant_id: tenantId, agente_id: { $ne: null }, fecha_asignado: { $gte: inicioDeHoy }
    }).select('agente_id agente_nombre contacto_id fecha_asignado').sort({ fecha_asignado: 1 });

    const linea = [];
    convsMeta.forEach(c => linea.push({
      hora: c.ultimaActividad, agente_id: c.agente_id?.toString(),
      agente: c.agente_nombre || nombrePorId[c.agente_id?.toString()] || '?',
      nombre: c.nombre || c.numero, canal: 'meta'
    }));
    asignsAcrux.forEach(a => linea.push({
      hora: a.fecha_asignado, agente_id: a.agente_id?.toString(),
      agente: a.agente_nombre || nombrePorId[a.agente_id?.toString()] || '?',
      nombre: `Conversación AcruxLab #${a.contacto_id}`, canal: 'acrux'
    }));
    linea.sort((a, b) => new Date(a.hora) - new Date(b.hora));

    const conteo = {};
    linea.forEach(l => { conteo[l.agente] = (conteo[l.agente] || 0) + 1; });

    res.json({
      ok: true,
      fecha: inicioDeHoy.toISOString().substring(0, 10),
      total_asignados_hoy: linea.length,
      conteo_por_vendedora: conteo,
      orden_cronologico: linea.map(l => ({ hora: l.hora, agente: l.agente, quien: l.nombre, canal: l.canal }))
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Revisa TODOS los chats pendientes de respuesta y dice por qué está frenado cada uno.
// Con ?arreglar=1 corrige los que quedaron en "tierra de nadie" (modo humano sin agente).
// GET /api/debug/pendientes-y-por-que
app.get('/api/debug/pendientes-y-por-que', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const desde = new Date(Date.now() - VENTANA_MOTOR_ACRUX_HORAS * 3600 * 1000).toISOString().replace('T', ' ').substring(0, 19);
    const mensajes = await odooCallLocal('acrux.chat.message', 'search_read',
      [[['date_message', '>=', desde]]],
      { fields: ['id', 'text', 'date_message', 'contact_id', 'from_me'], limit: 2000, order: 'date_message asc' }
    ) || [];

    // Agrupar por conversación y quedarnos con quién habló de último
    const porConv = {};
    mensajes.forEach(m => {
      if (!m.contact_id) return;
      const cid = m.contact_id[0];
      if (!porConv[cid]) porConv[cid] = { id: cid, nombre: m.contact_id[1], ultimo: null };
      const c = porConv[cid];
      if (!c.ultimo || m.date_message > c.ultimo.date_message) c.ultimo = m;
    });

    // Solo los que esperan respuesta (habló el padre de último)
    const pendientes = Object.values(porConv).filter(c => c.ultimo && !c.ultimo.from_me);
    if (!pendientes.length) return res.json({ ok: true, total_pendientes: 0, mensaje: 'No hay chats esperando respuesta' });

    const ids = pendientes.map(c => c.id);
    const uidServicio = await getOdooUID();
    const convsOdoo = await odooCallLocal('acrux.chat.conversation', 'read', [ids, ['id', 'number', 'name', 'status', 'agent_id']]) || [];
    const odooPorId = {}; convsOdoo.forEach(c => { odooPorId[c.id] = c; });
    const asigns = await AsignacionAcrux.find({ tenant_id: req.user.tenant_id, contacto_id: { $in: ids } });
    const asignPorId = {}; asigns.forEach(a => { asignPorId[a.contacto_id] = a; });

    let arreglados = 0;
    const resultado = [];

    for (const p of pendientes) {
      const o = odooPorId[p.id] || {};
      const a = asignPorId[p.id];
      const agenteHumano = o.agent_id && o.agent_id[0] !== uidServicio ? o.agent_id[1] : null;

      let motivo, accion = null;
      if (agenteHumano) {
        motivo = `Lo tiene ${agenteHumano} en el ChatRoom — le toca a esa persona responder`;
      } else if (a?.modo === 'humano' && !a.agente_id && !a.agente_nombre) {
        motivo = '⚠️ TIERRA DE NADIE: marcado como humano pero sin agente asignado — nadie lo atiende';
        if (req.query.arreglar === '1') {
          await AsignacionAcrux.updateOne({ _id: a._id }, { modo: 'bot' });
          accion = 'corregido: devuelto a KAI';
          arreglados++;
        }
      } else if (a?.modo === 'humano') {
        motivo = `Asignado a ${a.agente_nombre || 'una vendedora'} — le toca a ella responder`;
      } else if (o.status === 'new' || o.status === 'done') {
        motivo = `⚠️ La conversación está en estado "${o.status}" — en ese estado Odoo NO permite escribir. KAI la activa en la próxima corrida (45 seg)`;
      } else {
        motivo = 'Sin bloqueo aparente — KAI debería responder en la próxima corrida (45 seg)';
      }

      resultado.push({
        numero: o.number || null,
        nombre: o.name || p.nombre,
        conversacion: p.id,
        ultimo_mensaje: String(p.ultimo.text || '').substring(0, 100),
        fecha: p.ultimo.date_message,
        horas_esperando: Math.round((Date.now() - new Date(p.ultimo.date_message + 'Z').getTime()) / 3600000),
        motivo,
        accion
      });
    }

    resultado.sort((a, b) => b.horas_esperando - a.horas_esperando);
    res.json({
      ok: true,
      total_pendientes: resultado.length,
      tierra_de_nadie: resultado.filter(r => r.motivo.includes('TIERRA DE NADIE')).length,
      arreglados,
      pendientes: resultado
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Corregir un envío equivocado: se le pide disculpas al padre y se le manda la imagen
// del grado que sí corresponde. Sin ?enviar=1 solo muestra qué se le diría.
// GET /api/motor/corregir-envio?numero=502XXXXXXXX&nivel=Primaria&categoria=admision
app.get('/api/motor/corregir-envio', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const numero = String(req.query.numero || '').replace(/\D/g, '');
    const nivel = String(req.query.nivel || '').trim();
    const categoria = String(req.query.categoria || 'admision').trim();
    if (!numero || !nivel) return res.json({ ok: false, error: 'Faltan ?numero= y ?nivel= (Preprimaria, Primaria o Secundaria)' });

    // Buscar la imagen correcta para ese nivel y tema
    const filtro = { tenant_id: req.user.tenant_id, activo: true, categoria };
    const regla = REGLAS_IMAGEN.find(r => r.categoria === categoria && r.nivel?.some(n => nivel.toLowerCase().includes(n)));
    if (regla?.nombre_contiene) filtro.nombre = new RegExp(regla.nombre_contiene, 'i');
    else filtro.nivel_educativo = { $in: [nivel, 'Todos'] };
    const imagen = await ImagenMarketing.findOne(filtro).sort({ prioridad: -1, creado: -1 });

    const texto = `Disculpe, le envié la información del grado equivocado 🙏\n\n` +
                  `Aquí tiene la que corresponde a *${nivel}*. Cualquier duda con gusto le ayudo.`;

    if (req.query.enviar !== '1') {
      return res.json({
        ok: true,
        modo: 'VISTA PREVIA — no se envió nada',
        numero,
        mensaje_que_se_enviaria: texto,
        imagen_que_se_enviaria: imagen ? imagen.nombre : '⚠️ NO SE ENCONTRÓ imagen para ese nivel y tema',
        para_enviarlo: 'agrega &enviar=1 a la dirección'
      });
    }

    if (!imagen) return res.json({ ok: false, error: `No hay imagen de "${categoria}" para ${nivel} — revisa el Banco de Imágenes` });

    // Enviar por AcruxLab (número oficial)
    const conversacion = await obtenerOCrearConversacionAcrux(numero, null);
    await enviarTextoAcruxLab(conversacion.id, texto);
    await new Promise(r => setTimeout(r, 1500));

    const adjunto = await subirImagenNuevaAcrux(imagen.imagen_base64, `${imagen.nombre}.jpg`, imagen.mime_type || 'image/jpeg', conversacion.id);
    await odooCallLocal('acrux.chat.conversation', 'send_message',
      [[conversacion.id], {
        text: construirDescripcionImagen(imagen), from_me: true, ttype: 'image',
        res_model: 'ir.attachment', res_id: adjunto.id, id: -2,
        date_message: new Date().toISOString().replace('T', ' ').substring(0, 19), button_ids: []
      }],
      { context: { lang: 'es_GT', tz: 'America/Guatemala', is_acrux_chat_room: true } }
    );

    // Dejar el nivel correcto guardado, para que KAI no vuelva a equivocarse
    await Contacto.findOneAndUpdate(
      { tenant_id: req.user.tenant_id, numero },
      { $set: { nivel_interes: nivel } }
    ).catch(() => {});

    console.log(`🔧 [Corrección] Se corrigió el envío a ${numero}: disculpa + imagen "${imagen.nombre}" (${nivel})`);
    res.json({ ok: true, enviado: true, numero, nivel, imagen: imagen.nombre, conversacion_acrux: conversacion.id });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ¿Por qué KAI no está atendiendo a este número? Recorre TODOS los filtros que aplica
// el motor y dice exactamente cuál lo está frenando.
// GET /api/debug/por-que-no-atiende?numero=50244109412
// Diagnóstico completo de un número: TODAS las conversaciones de AcruxLab que existan
// para ese teléfono (puede haber más de una), TODOS sus mensajes (no solo los últimos),
// y las actividades/citas del lead en Odoo — para confirmar si hubo interacción humana
// que no se vio en el diagnóstico rápido (ej. una cita de Open House agendada aparte).
// GET /api/debug/historial-completo?numero=502XXXXXXXX
// Busca leads por nombre parcial (no por teléfono) — útil cuando el número puede estar
// mal escrito o guardado en un formato que no calza con las búsquedas normales.
// GET /api/debug/buscar-lead-por-nombre?nombre=Nery Vasquez
app.get('/api/debug/buscar-lead-por-nombre', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const nombre = String(req.query.nombre || '').trim();
    if (!nombre) return res.json({ ok: false, error: 'Falta ?nombre=' });

    const leads = await odooCallLocal('crm.lead', 'search_read',
      [['|', ['partner_name', 'ilike', nombre], ['name', 'ilike', nombre]]],
      { fields: ['id', 'name', 'partner_name', 'phone', 'mobile', 'email_from', 'user_id', 'type', 'active', 'create_date', 'stage_id'], limit: 20, order: 'create_date desc', context: { active_test: false } }
    ) || [];

    res.json({ ok: true, encontrados: leads.length, leads });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/debug/historial-completo', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const numero = String(req.query.numero || '').replace(/\D/g, '');
    if (!numero) return res.json({ ok: false, error: 'Falta ?numero=' });
    const ultimos8 = numero.slice(-8);

    // TODAS las conversaciones de AcruxLab con este número (puede haber más de una) —
    // INCLUYENDO archivadas. Sin active_test:false, una conversación archivada se ve
    // exactamente igual que si nunca hubiera existido, y eso llevó a una conclusión
    // equivocada antes (se dijo "no existe" cuando en realidad podía estar archivada).
    const conversaciones = await odooCallLocal('acrux.chat.conversation', 'search_read',
      [[['number', 'like', ultimos8]]],
      { fields: ['id', 'name', 'number', 'status', 'agent_id', 'create_date'], limit: 10, context: { active_test: false } }
    ) || [];

    const detalle = [];
    for (const conv of conversaciones) {
      const mensajes = await odooCallLocal('acrux.chat.message', 'search_read',
        [[['contact_id', '=', conv.id]]],
        { fields: ['id', 'text', 'from_me', 'date_message'], limit: 200, order: 'date_message asc' }
      ) || [];
      detalle.push({
        conversacion: conv.id, status: conv.status, agente: conv.agent_id?.[1] || null,
        creada: conv.create_date, total_mensajes: mensajes.length,
        mensajes: mensajes.map(m => ({ de: m.from_me ? 'colegio' : 'padre', texto: (m.text || '').substring(0, 200), fecha: m.date_message }))
      });
    }

    // Leads de Odoo con este teléfono, y sus actividades/citas agendadas
    const condicionesTel = condicionesTelefono(numero);
    let leads = [];
    if (condicionesTel.length) {
      const dominioTel = [];
      for (let i = 0; i < condicionesTel.length - 1; i++) dominioTel.push('|');
      condicionesTel.forEach(c => dominioTel.push(c));
      leads = await odooCallLocal('crm.lead', 'search_read',
        [dominioTel],
        { fields: ['id', 'name', 'partner_name', 'user_id', 'type', 'active'], limit: 10, context: { active_test: false } }
      ) || [];
    }

    const leadsConActividades = [];
    for (const l of leads) {
      const actividades = await odooCallLocal('mail.activity', 'search_read',
        [[['res_model', '=', 'crm.lead'], ['res_id', '=', l.id]]],
        { fields: ['id', 'summary', 'date_deadline', 'user_id', 'activity_type_id'], limit: 20 }
      ).catch(() => []);
      leadsConActividades.push({
        lead: l.id, nombre: l.partner_name || l.name, vendedor: l.user_id?.[1] || 'SIN ASIGNAR',
        tipo: l.type, activo: l.active,
        citas_actividades: actividades.map(a => ({ resumen: a.summary, fecha_limite: a.date_deadline, asignado_a: a.user_id?.[1], tipo: a.activity_type_id?.[1] }))
      });
    }

    res.json({ ok: true, conversaciones_acrux: detalle, leads: leadsConActividades });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/debug/por-que-no-atiende', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const numero = String(req.query.numero || '').replace(/\D/g, '');
    if (!numero) return res.json({ ok: false, error: 'Falta ?numero=' });

    const revisiones = [];
    let bloqueo = null;

    // 1) ¿Existe la conversación en AcruxLab?
    const convs = await odooCallLocal('acrux.chat.conversation', 'search_read',
      [[['number', '=', numero]]],
      { fields: ['id', 'name', 'number', 'status', 'agent_id', 'last_received', 'last_sent'], limit: 1 }
    ) || [];
    if (!convs.length) {
      revisiones.push({ revision: 'Conversación en AcruxLab', resultado: '❌ NO EXISTE — este número nunca ha escrito al número oficial' });
      return res.json({ ok: true, numero, bloqueo: 'No hay conversación en AcruxLab', revisiones });
    }
    const conv = convs[0];
    const uidServicio = await getOdooUID();
    revisiones.push({ revision: 'Conversación en AcruxLab', resultado: `✅ existe (#${conv.id})`, status: conv.status, agente: conv.agent_id?.[1] || 'ninguno', ultimo_recibido: conv.last_received, ultimo_enviado: conv.last_sent });

    // 2) ¿Está tomada por una persona real?
    if (conv.agent_id && conv.agent_id[0] !== uidServicio) {
      bloqueo = bloqueo || `La conversación la tiene tomada ${conv.agent_id[1]} en el ChatRoom — KAI no interviene por diseño`;
      revisiones.push({ revision: 'Agente humano', resultado: `⛔ tomada por ${conv.agent_id[1]}` });
    } else {
      revisiones.push({ revision: 'Agente humano', resultado: '✅ libre (o es nuestro usuario de servicio)' });
    }

    // 3) ¿En qué modo la tenemos nosotros?
    const asign = await AsignacionAcrux.findOne({ tenant_id: req.user.tenant_id, contacto_id: conv.id });
    if (asign?.modo === 'humano') {
      bloqueo = bloqueo || `Está en modo humano en KAI, asignada a ${asign.agente_nombre || 'alguien'} — KAI no responde por diseño`;
      revisiones.push({ revision: 'Modo en KAI', resultado: `⛔ humano (${asign.agente_nombre || 'sin nombre'})` });
    } else {
      revisiones.push({ revision: 'Modo en KAI', resultado: asign ? '✅ bot (KAI atiende)' : 'ℹ️ sin registro todavía (KAI atiende)' });
    }

    // 4) ¿Hay mensajes recientes, y quién habló de último?
    const desde = new Date(Date.now() - VENTANA_MOTOR_ACRUX_HORAS * 3600 * 1000).toISOString().replace('T', ' ').substring(0, 19);
    const msgs = await odooCallLocal('acrux.chat.message', 'search_read',
      [[['contact_id', '=', conv.id], ['date_message', '>=', desde]]],
      { fields: ['id', 'text', 'from_me', 'date_message'], limit: 20, order: 'date_message desc' }
    ) || [];
    if (!msgs.length) {
      bloqueo = bloqueo || `No hay mensajes en las últimas ${VENTANA_MOTOR_ACRUX_HORAS} horas — el motor solo mira esa ventana`;
      revisiones.push({ revision: 'Mensajes recientes', resultado: `⛔ ninguno en ${VENTANA_MOTOR_ACRUX_HORAS} h` });
    } else {
      const ultimo = msgs[0];
      const ultimoDelPadre = msgs.find(m => !m.from_me);
      const yaRespondido = ultimoDelPadre ? msgs.some(m => m.from_me && m.date_message > ultimoDelPadre.date_message) : true;
      revisiones.push({
        revision: 'Mensajes recientes',
        resultado: `✅ ${msgs.length} mensaje(s)`,
        ultimo_de: ultimo.from_me ? 'colegio' : 'padre',
        ultimo_texto: String(ultimo.text || '').substring(0, 120),
        fecha: ultimo.date_message,
        ya_se_respondio_despues: yaRespondido
      });
      if (yaRespondido) bloqueo = bloqueo || 'El último mensaje del padre YA fue respondido — por eso el motor no vuelve a escribir';
    }

    // 5) ¿El motor está encendido?
    revisiones.push({ revision: 'Motor de AcruxLab', resultado: ACRUX_AUTO_RESPUESTA_ACTIVO ? '✅ encendido' : '⛔ APAGADO' });
    if (!ACRUX_AUTO_RESPUESTA_ACTIVO) bloqueo = bloqueo || 'El motor de auto-respuesta de AcruxLab está apagado';

    res.json({
      ok: true,
      numero,
      bloqueo: bloqueo || 'Ningún filtro lo está frenando — debería estar atendiéndolo',
      revisiones
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Prueba PASO A PASO el envío por AcruxLab a un número, mostrando el estado antes y
// después de cada intento y el error EXACTO de Odoo. Sirve para dejar de suponer por
// qué rechaza la escritura.
// GET /api/debug/probar-envio-acrux?numero=50254649218
app.get('/api/debug/probar-envio-acrux', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  const pasos = [];
  const registrar = (paso, detalle) => { pasos.push({ paso, ...detalle }); };
  try {
    const numero = String(req.query.numero || '').replace(/\D/g, '');
    if (!numero) return res.json({ ok: false, error: 'Falta ?numero=' });

    // 1) Estado actual
    const convs = await odooCallLocal('acrux.chat.conversation', 'search_read',
      [[['number', '=', numero]]],
      { fields: ['id', 'name', 'number', 'status', 'agent_id', 'valid_number', 'connector_id', 'chat_message_ids', 'is_waba_opt_in', 'sent_opt_in'], limit: 1 }
    ) || [];
    if (!convs.length) return res.json({ ok: false, error: 'No existe conversación para ese número' });
    const conv = convs[0];
    registrar('1. Estado inicial', { id: conv.id, status: conv.status, agente: conv.agent_id?.[1] || null, mensajes: (conv.chat_message_ids || []).length, valid_number: conv.valid_number });

    // 2) Intentar poner status en 'current' y verificar si se guardó de verdad
    try {
      await odooCallLocal('acrux.chat.conversation', 'write', [[conv.id], { status: 'current' }]);
      registrar('2. Escribir status=current', { resultado: 'la escritura no dio error' });
    } catch (e) {
      registrar('2. Escribir status=current', { error: e.message });
    }
    const relectura = await odooCallLocal('acrux.chat.conversation', 'read', [[conv.id], ['status', 'agent_id', 'valid_number']]).catch(() => null);
    registrar('3. Releer después de escribir', { status: relectura?.[0]?.status, se_guardo: relectura?.[0]?.status === 'current', agente: relectura?.[0]?.agent_id?.[1] || null });

    // 4) NO se envía nada. Solo inspeccionamos el modelo para entender qué condición
    // exige el módulo para permitir escribir — sin molestar a ninguna familia.
    try {
      const campos = await odooCallLocal('acrux.chat.conversation', 'fields_get', [['status', 'agent_id', 'valid_number', 'is_waba_opt_in', 'sent_opt_in', 'conv_type', 'chat_id']], { attributes: ['string', 'type', 'selection', 'readonly', 'store'] });
      registrar('4. Opciones válidas de cada campo', {
        status: campos?.status?.selection || null,
        status_es_de_solo_lectura: campos?.status?.readonly || false,
        valid_number: campos?.valid_number?.selection || null,
        conv_type: campos?.conv_type?.selection || null
      });
    } catch (e) {
      registrar('4. Opciones válidas de cada campo', { error: e.message });
    }

    // 5) Comparar contra una conversación que SÍ recibe mensajes de KAI hoy, para ver
    // qué tienen ellas que a esta le falta.
    try {
      const queFuncionan = await odooCallLocal('acrux.chat.conversation', 'search_read',
        [[['chat_message_ids', '!=', false], ['status', '=', 'current']]],
        { fields: ['id', 'number', 'status', 'agent_id', 'valid_number', 'chat_id', 'conv_type', 'is_waba_opt_in', 'sent_opt_in', 'last_sent'], limit: 3, order: 'last_sent desc' }
      ) || [];
      registrar('5. Conversaciones que sí funcionan', {
        ejemplos: queFuncionan.map(q => ({
          id: q.id, status: q.status, chat_id: q.chat_id, valid_number: q.valid_number,
          conv_type: q.conv_type, agente: q.agent_id?.[1] || null, ultimo_envio: q.last_sent
        }))
      });
    } catch (e) {
      registrar('5. Conversaciones que sí funcionan', { error: e.message });
    }

    res.json({ ok: true, numero, nota: 'Este diagnóstico NO envía ningún mensaje.', pasos });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, pasos });
  }
});

// Compara una conversación de AcruxLab que SÍ funciona contra la de un número que
// falla, para ver qué campo las diferencia y por qué Odoo rechaza el envío.
// GET /api/debug/comparar-conversacion-acrux?numero=50254649218
app.get('/api/debug/comparar-conversacion-acrux', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const numero = String(req.query.numero || '').replace(/\D/g, '');
    if (!numero) return res.json({ ok: false, error: 'Falta ?numero=' });

    const laQueFalla = await odooCallLocal('acrux.chat.conversation', 'search_read',
      [[['number', '=', numero]]], { limit: 1 }
    ) || [];

    // Una que sí funciona: la más reciente con mensajes de verdad
    const queSiFunciona = await odooCallLocal('acrux.chat.conversation', 'search_read',
      [[['number', '!=', numero], ['status', '=', 'current']]],
      { limit: 1, order: 'last_received desc' }
    ) || [];

    // Mostrar solo los campos donde se diferencian, para no llenar de ruido
    const a = laQueFalla[0] || {};
    const b = queSiFunciona[0] || {};
    const diferencias = {};
    const todasLasClaves = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of todasLasClaves) {
      const va = JSON.stringify(a[k]);
      const vb = JSON.stringify(b[k]);
      if (va !== vb) diferencias[k] = { la_que_falla: a[k], la_que_funciona: b[k] };
    }

    res.json({
      ok: true,
      numero_consultado: numero,
      encontrada: !!laQueFalla.length,
      resumen_la_que_falla: a.id ? { id: a.id, status: a.status, agent_id: a.agent_id, valid_number: a.valid_number, is_waba_opt_in: a.is_waba_opt_in, sent_opt_in: a.sent_opt_in, conv_type: a.conv_type, chat_id: a.chat_id } : null,
      resumen_la_que_funciona: b.id ? { id: b.id, status: b.status, agent_id: b.agent_id, valid_number: b.valid_number, is_waba_opt_in: b.is_waba_opt_in, sent_opt_in: b.sent_opt_in, conv_type: b.conv_type, chat_id: b.chat_id } : null,
      diferencias
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// REPORTE DE DUPLICADOS — agrupa los leads por teléfono para ver de un vistazo cuáles
// son de la misma persona. Incluye los archivados/perdidos, porque los repetidos suelen
// marcarse así y hay que poder verlos igual.
// GET /api/debug/leads-duplicados?dias=60
// Muestra los campos crudos de uno o varios leads por ID — para comparar formatos
// exactos (ej. el teléfono guardado con o sin guiones) entre registros que deberían
// haberse detectado como duplicados y no se detectaron.
// GET /api/debug/leer-lead-crudo?ids=40127,40128,40277
app.get('/api/debug/leer-lead-crudo', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const ids = String(req.query.ids || '').split(',').map(n => parseInt(n)).filter(Boolean);
    if (!ids.length) return res.json({ ok: false, error: 'Falta ?ids=40127,40128,...' });

    const leads = await odooCallLocal('crm.lead', 'read', [ids, ['id', 'name', 'partner_name', 'phone', 'mobile', 'email_from', 'type', 'active', 'create_date', 'user_id']]) || [];
    res.json({ ok: true, leads });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/debug/leads-duplicados', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const dias = Math.min(parseInt(req.query.dias) || 60, 365);
    const desde = new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString().replace('T', ' ').substring(0, 19);

    const leads = await odooCallLocal('crm.lead', 'search_read',
      [[['create_date', '>=', desde]]],
      { fields: ['id', 'name', 'partner_name', 'contact_name', 'phone', 'mobile', 'email_from', 'user_id', 'create_date', 'active', 'stage_id', 'probability'], limit: 500, order: 'create_date desc', context: { active_test: false } }
    ) || [];

    // Agrupar por los últimos 8 dígitos del teléfono (así no importa el formato)
    const grupos = {};
    leads.forEach(l => {
      const tel = String((l.mobile && String(l.mobile) !== 'false') ? l.mobile : (l.phone || '')).replace(/\D/g, '');
      if (tel.length < 8) return;
      const clave = tel.slice(-8);
      if (!grupos[clave]) grupos[clave] = [];
      grupos[clave].push({
        id: l.id,
        nombre: l.partner_name || l.contact_name || l.name,
        correo: l.email_from || null,
        vendedor: l.user_id?.[1] || 'SIN ASIGNAR',
        etapa: l.stage_id?.[1] || null,
        creado: l.create_date?.substring(0, 16),
        archivado_o_perdido: l.active === false || l.probability === 0
      });
    });

    const duplicados = Object.entries(grupos)
      .filter(([, arr]) => arr.length > 1)
      .map(([tel, arr]) => ({
        telefono: tel,
        nombre: arr[0].nombre,
        veces_repetido: arr.length,
        activos: arr.filter(a => !a.archivado_o_perdido).length,
        perdidos_o_archivados: arr.filter(a => a.archivado_o_perdido).length,
        // El más antiguo suele ser el "bueno"; los demás son los repetidos
        lead_principal: arr[arr.length - 1].id,
        leads: arr
      }))
      .sort((a, b) => b.veces_repetido - a.veces_repetido);

    res.json({
      ok: true,
      dias_revisados: dias,
      total_leads_revisados: leads.length,
      contactos_con_duplicados: duplicados.length,
      total_leads_repetidos: duplicados.reduce((s, d) => s + d.veces_repetido - 1, 0),
      duplicados
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// REPORTE DE DUPLICADOS termina aquí
// ===== ESCÁNER DE INSTAGRAM Y MESSENGER =====
// Por estos canales llega de todo: felicitaciones a alumnos, comentarios sueltos, gente
// bromeando... y en medio, padres que SÍ quieren inscribir. Esto lee cada conversación
// y la clasifica, para que el equipo sepa a cuáles vale la pena responder primero.
// GET /api/motor/escanear-social            → últimos 30 días
// GET /api/motor/escanear-social?dias=60
app.get('/api/motor/escanear-social', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const dias = Math.min(parseInt(req.query.dias) || 30, 180);
    const desde = new Date(Date.now() - dias * 24 * 3600 * 1000);

    const convs = await Conversacion.find({
      tenant_id: req.user.tenant_id,
      canal: { $in: ['instagram', 'messenger'] },
      ultimaActividad: { $gte: desde }
    }).sort({ ultimaActividad: -1 }).limit(80);

    if (!convs.length) return res.json({ ok: true, total: 0, mensaje: 'No hay conversaciones de Instagram/Messenger en ese rango', conversaciones: [] });

    // Armamos un resumen corto de cada conversación para que la IA las clasifique en lote
    const paraClasificar = convs.map((c, i) => {
      const textos = (c.mensajes || [])
        .filter(m => m.de === 'padre')
        .map(m => m.texto)
        .join(' | ')
        .substring(0, 500);
      return { indice: i, id: c._id.toString(), canal: c.canal, numero: c.numero, nombre: c.nombre || null, texto: textos || '(sin mensajes)' };
    });

    const systemPrompt = `Eres un asistente del Colegio Capouilliez (Guatemala) que revisa mensajes recibidos por Instagram y Facebook Messenger.

Clasifica CADA conversación en una de estas categorías:
- "CALIENTE": el mensaje muestra interés real en inscribir a un alumno (pregunta por cuotas, admisión, cupos, requisitos, edades, dice que quiere inscribir, o pide agendar una visita/recorrido por las instalaciones).
- "EXPLORATORIO": pregunta algo del colegio sin intención clara de inscribir todavía (horarios, ubicación, información general).
- "TRAMITE": es un padre/alumno actual pidiendo algo administrativo (constancias, notas, pagos, papelería de alumno inscrito). NO es admisión.
- "NO_RELEVANTE": felicitaciones, saludos, comentarios sobre publicaciones, bromas, spam, ofertas de proveedores, solicitudes de empleo, o cualquier cosa que no requiera acción de admisiones.

OJO CON EL TONO — muchos padres escriben de forma muy formal o protocolaria ("El motivo
de la presente es para manifestar nuestro interés...", "solicitar su valioso apoyo..."),
y eso NO los hace menos interesados: suelen ser de los más serios. Clasifica por el
CONTENIDO, no por el estilo. Si menciona a su hijo, su edad, un grado, pide información
de admisión o quiere agendar una visita → es CALIENTE, aunque parezca carta de oficina.
Solo va a NO_RELEVANTE si de verdad no tiene que ver con inscribir a un alumno.

Devuelve ÚNICAMENTE un arreglo JSON, sin explicaciones ni markdown, con este formato exacto:
[{"indice": 0, "categoria": "CALIENTE", "motivo": "explicación breve", "accion_sugerida": "qué debería hacer el equipo", "nombre_detectado": "nombre del padre si aparece, o null", "telefono": "solo dígitos si aparece un teléfono en el mensaje, o null", "nivel": "Preprimaria, Primaria, Secundaria o null", "correo": "correo si aparece, o null"}]

Para el nivel: "2do primaria" o "4to grado" → "Primaria"; "básico" o "bachillerato" → "Secundaria"; "kinder", "párvulos" o "preparatoria" → "Preprimaria".
Los teléfonos de Guatemala tienen 8 dígitos. NO inventes datos que no estén en el texto.

Incluye TODOS los índices que te den.`;

    const entrada = paraClasificar.map(c => `[${c.indice}] (${c.canal}) ${c.nombre || 'Sin nombre'}: ${c.texto}`).join('\n');
    const respuesta = await llamarClaude(systemPrompt, [{ role: 'user', content: entrada.substring(0, 12000) }], 3000);
    if (!respuesta) return res.json({ ok: false, error: 'La IA no respondió (revisar saldo de Anthropic)' });

    let clasificaciones;
    try {
      let limpio = respuesta.replace(/```json|```/g, '').trim();
      const inicio = limpio.indexOf('[');
      const fin = limpio.lastIndexOf(']');
      if (inicio === -1 || fin === -1 || fin < inicio) throw new Error('No se encontró un arreglo JSON en la respuesta');
      limpio = limpio.substring(inicio, fin + 1);
      clasificaciones = JSON.parse(limpio);
    } catch (e) {
      return res.json({ ok: false, error: 'La IA devolvió un formato inesperado', respuesta_cruda: respuesta.substring(0, 800) });
    }

    const porIndice = {};
    (clasificaciones || []).forEach(c => { porIndice[c.indice] = c; });

    const resultado = paraClasificar.map(c => {
      const cl = porIndice[c.indice] || {};
      const conv = convs[c.indice];
      return {
        id: c.id,
        canal: c.canal,
        identificador: c.numero,
        nombre: c.nombre || 'Sin nombre',
        estado: conv.estado,
        agente: conv.agente_nombre || 'SIN ASIGNAR',
        ultima_actividad: conv.ultimaActividad,
        categoria: cl.categoria || 'SIN_CLASIFICAR',
        motivo: cl.motivo || null,
        accion_sugerida: cl.accion_sugerida || null,
        nombre_detectado: cl.nombre_detectado || null,
        telefono_detectado: cl.telefono ? String(cl.telefono).replace(/\D/g, '') : null,
        nivel_detectado: cl.nivel || null,
        correo_detectado: cl.correo || null,
        mensaje: c.texto.substring(0, 200)
      };
    });

    // Los calientes primero — son los que no pueden esperar
    const orden = { CALIENTE: 0, EXPLORATORIO: 1, TRAMITE: 2, NO_RELEVANTE: 3, SIN_CLASIFICAR: 4 };
    resultado.sort((a, b) => (orden[a.categoria] ?? 9) - (orden[b.categoria] ?? 9));

    res.json({
      ok: true,
      dias_revisados: dias,
      total: resultado.length,
      resumen: {
        calientes: resultado.filter(r => r.categoria === 'CALIENTE').length,
        exploratorios: resultado.filter(r => r.categoria === 'EXPLORATORIO').length,
        tramites: resultado.filter(r => r.categoria === 'TRAMITE').length,
        no_relevantes: resultado.filter(r => r.categoria === 'NO_RELEVANTE').length
      },
      conversaciones: resultado
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Contactos del formulario que NO tienen conversación en el panel — pasa con los que
// se contactaron antes de que el sistema creara la conversación automáticamente, y por
// eso no aparecen en Chats en Vivo. Con ?reparar=1 se les crea la que falta.
app.get('/api/debug/contactos-sin-conversacion', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const contactos = await Contacto.find({
      tenant_id: req.user.tenant_id,
      canal_origen: 'formulario_admisiones'
    }).limit(100);

    const revisados = [];
    let reparados = 0;

    for (const c of contactos) {
      const conv = await Conversacion.findOne({ tenant_id: req.user.tenant_id, numero: c.numero });
      const tiene = !!conv;

      if (!tiene && req.query.reparar === '1') {
        const vendedor = await asignarAgenteLibre(req.user.tenant_id);
        const primerNombre = c.nombre ? c.nombre.split(' ')[0] : null;
        await Conversacion.create({
          tenant_id: req.user.tenant_id,
          numero: c.numero,
          nombre: c.nombre || null,
          canal: 'whatsapp',
          estado: 'bot',
          agente_id: vendedor?._id || null,
          agente_nombre: vendedor?.nombre || null,
          motivo: `Contacto proactivo de KAI — Formulario de Admisiones${c.nivel_interes ? ' (' + c.nivel_interes + ')' : ''}`,
          mensajes: [{ de: 'bot', texto: MENSAJE_PRIMER_CONTACTO(primerNombre, c.nivel_interes || null), fecha: c.ultimo_contacto || new Date() }],
          ultimaActividad: c.ultimo_contacto || new Date()
        });
        reparados++;
      }

      revisados.push({
        numero: c.numero,
        nombre: c.nombre,
        nivel: c.nivel_interes || null,
        lead: c.odoo_lead_id || null,
        tiene_conversacion: tiene,
        estado: conv?.estado || null
      });
    }

    res.json({
      ok: true,
      total_contactos: revisados.length,
      sin_conversacion: revisados.filter(r => !r.tiene_conversacion).length,
      reparados,
      contactos: revisados
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Conversaciones CERRADAS (invisibles en el panel) — para revisar si alguna se cerró
// sin querer y "desapareció". Con ?reabrir=1 las devuelve a modo KAI para que se vean.
app.get('/api/debug/conversaciones-cerradas', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const cerradas = await Conversacion.find({ tenant_id: req.user.tenant_id, estado: 'cerrado' })
      .sort({ ultimaActividad: -1 }).limit(50)
      .select('numero nombre canal agente_nombre ultimaActividad motivo mensajes');

    const lista = cerradas.map(c => ({
      id: c._id,
      numero: c.numero,
      nombre: c.nombre || 'Sin nombre',
      canal: c.canal,
      agente: c.agente_nombre || null,
      ultima_actividad: c.ultimaActividad,
      total_mensajes: (c.mensajes || []).length,
      ultimo_mensaje: c.mensajes?.length ? c.mensajes[c.mensajes.length - 1].texto?.substring(0, 100) : null
    }));

    let reabiertas = 0;
    if (req.query.reabrir === '1') {
      const r = await Conversacion.updateMany(
        { tenant_id: req.user.tenant_id, estado: 'cerrado' },
        { $set: { estado: 'bot', agente_id: null, agente_nombre: null } }
      );
      reabiertas = r.modifiedCount || 0;
    }

    res.json({ ok: true, total_cerradas: lista.length, reabiertas, conversaciones: lista });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ¿Se puede INICIAR una conversación en AcruxLab con alguien que nunca nos ha escrito?
// Necesario para saber si los contactos proactivos del formulario pueden salir por el
// número oficial (AcruxLab) en vez del número de Meta. Este endpoint solo INSPECCIONA
// el modelo, no crea ni envía nada.
app.get('/api/debug/acrux-puede-iniciar', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const resultado = {};

    // 1) Campos disponibles en la conversación (para saber si podemos crear una con un número)
    try {
      const campos = await odooCallLocal('acrux.chat.conversation', 'fields_get', [], { attributes: ['string', 'type', 'required', 'relation'] });
      const relevantes = {};
      for (const [k, v] of Object.entries(campos || {})) {
        if (/number|phone|mobile|name|agent|connector|res_partner|partner/i.test(k)) {
          relevantes[k] = { etiqueta: v.string, tipo: v.type, requerido: !!v.required, relacion: v.relation || null };
        }
      }
      resultado.campos_conversacion = relevantes;
    } catch (e) { resultado.campos_conversacion = { error: e.message }; }

    // 2) Conectores configurados (el "canal" por el que sale el mensaje)
    try {
      resultado.conectores = await odooCallLocal('acrux.chat.connector', 'search_read', [[]], { fields: ['id', 'name', 'connector_type'], limit: 10 });
    } catch (e) { resultado.conectores = { error: e.message }; }

    // 3) Una conversación real de ejemplo, para ver cómo está armada por dentro
    try {
      const ejemplo = await odooCallLocal('acrux.chat.conversation', 'search_read', [[]], { limit: 1, order: 'id desc' });
      resultado.ejemplo_conversacion = ejemplo?.[0] || null;
    } catch (e) { resultado.ejemplo_conversacion = { error: e.message }; }

    res.json({ ok: true, ...resultado });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// PRUEBA DE VENTANA DE 24 HORAS — manda un mensaje libre a un número y devuelve la
// respuesta EXACTA de Meta. Sirve para confirmar si de verdad se puede escribir primero
// a alguien que nunca nos ha escrito (o que escribió hace más de 24h), antes de construir
// el motor de contacto proactivo sobre una suposición.
// Uso: POST /api/debug/probar-envio-libre  { "numero": "50252060423" }
app.post('/api/debug/probar-envio-libre', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const { numero } = req.body;
    if (!numero) return res.json({ ok: false, error: 'Falta el número' });

    const contacto = await Contacto.findOne({ tenant_id: req.user.tenant_id, numero: numero.replace(/\D/g, '') });
    const horasDesdeUltimoContacto = contacto?.ultimo_contacto
      ? Math.round((Date.now() - new Date(contacto.ultimo_contacto).getTime()) / 3600000)
      : null;

    const respuestaMeta = await enviarWhatsAppMeta(numero, 'Mensaje de prueba del sistema KAI. Puede ignorarlo.');

    res.json({
      ok: true,
      horas_desde_que_el_padre_escribio: horasDesdeUltimoContacto,
      fuera_de_ventana_24h: horasDesdeUltimoContacto === null || horasDesdeUltimoContacto >= 24,
      meta_acepto: !!(respuestaMeta && respuestaMeta.messages),
      respuesta_cruda_de_meta: respuestaMeta
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DIAGNÓSTICO GLOBAL — todos los chats recientes de AMBOS canales, quién los atiende,
// y cuáles están PENDIENTES (último mensaje del padre sin respuesta). Uso:
// /api/debug/estado-chats            → últimas 48 horas
// /api/debug/estado-chats?horas=24   → rango personalizado
app.get('/api/debug/estado-chats', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const horas = Math.min(parseInt(req.query.horas) || 48, 168);
    const desde = new Date(Date.now() - horas * 3600 * 1000);

    // ---- Canal WhatsApp de pruebas / Meta — desde nuestra base (incluye los que KAI atiende solo) ----
    const contactosRecientes = await Contacto.find({
      tenant_id: req.user.tenant_id,
      ultimo_contacto: { $gte: desde }
    }).sort({ ultimo_contacto: -1 }).limit(60).select('numero nombre canal_origen ultimo_contacto nivel_interes nivel_calor_etiqueta odoo_lead_id');

    const numeros = contactosRecientes.map(c => c.numero);
    const convsTransferidas = await Conversacion.find({ tenant_id: req.user.tenant_id, numero: { $in: numeros } })
      .select('numero estado agente_nombre ultimaActividad');
    const convPorNumero = {};
    convsTransferidas.forEach(c => { convPorNumero[c.numero] = c; });

    const whatsapp = contactosRecientes.map(c => {
      const conv = convPorNumero[c.numero];
      return {
        numero: c.numero,
        nombre: c.nombre || 'Sin nombre',
        canal: c.canal_origen,
        ultimo_contacto: c.ultimo_contacto,
        nivel: c.nivel_interes || null,
        clasificacion: c.nivel_calor_etiqueta || null,
        lead_odoo: c.odoo_lead_id || null,
        atencion: conv ? `${conv.estado}${conv.agente_nombre ? ' — ' + conv.agente_nombre : ''}` : 'KAI (sin transferir)'
      };
    });

    // ---- Canal AcruxLab (número oficial) — desde Odoo ----
    const desdeOdoo = desde.toISOString().replace('T', ' ').substring(0, 19);
    const mensajes = await odooCallLocal('acrux.chat.message', 'search_read',
      [[['date_message', '>=', desdeOdoo]]],
      { fields: ['id', 'text', 'date_message', 'contact_id', 'from_me'], limit: 1000, order: 'date_message asc' }
    ) || [];
    const porContacto = {};
    mensajes.forEach(m => {
      if (!m.contact_id) return;
      const cid = m.contact_id[0];
      if (!porContacto[cid]) porContacto[cid] = { contacto_id: cid, nombre: m.contact_id[1], ultimo_de: null, ultima_fecha: null };
      const c = porContacto[cid];
      if (!c.ultima_fecha || m.date_message > c.ultima_fecha) {
        c.ultima_fecha = m.date_message;
        c.ultimo_de = m.from_me ? 'colegio' : 'padre';
      }
    });
    const idsAcrux = Object.keys(porContacto).map(Number);
    const asigns = idsAcrux.length ? await AsignacionAcrux.find({ tenant_id: req.user.tenant_id, contacto_id: { $in: idsAcrux } }) : [];
    const asignMap = {}; asigns.forEach(a => { asignMap[a.contacto_id] = a; });
    let agentIdMap = {};
    if (idsAcrux.length) {
      try {
        const convsOdoo = await odooCallLocal('acrux.chat.conversation', 'read', [idsAcrux, ['id', 'agent_id']]) || [];
        convsOdoo.forEach(c => { if (c.agent_id) agentIdMap[c.id] = c.agent_id[1]; });
      } catch (e) { /* no bloqueante */ }
    }
    const acrux = Object.values(porContacto)
      .sort((a, b) => (b.ultima_fecha || '').localeCompare(a.ultima_fecha || ''))
      .map(c => ({
        contacto_id: c.contacto_id,
        nombre: c.nombre,
        ultimo_mensaje_de: c.ultimo_de,
        ultima_fecha: c.ultima_fecha,
        PENDIENTE_DE_RESPUESTA: c.ultimo_de === 'padre',
        tomado_en_odoo_por: agentIdMap[c.contacto_id] || null,
        asignacion_kai: asignMap[c.contacto_id] ? `${asignMap[c.contacto_id].agente_nombre} (${asignMap[c.contacto_id].modo})` : 'sin registro'
      }));

    res.json({
      ok: true,
      rango_horas: horas,
      resumen: {
        acrux_PENDIENTES_de_respuesta: acrux.filter(c => c.PENDIENTE_DE_RESPUESTA).length,
        acrux_total_chats_recientes: acrux.length,
        whatsapp_contactos_recientes: whatsapp.length
      },
      whatsapp_y_meta: whatsapp,
      acruxlab: acrux
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Papás A LA ESPERA de atención humana, en ambos canales — para revisar de un vistazo
// si alguien quedó transferido sin que ningún vendedor lo haya atendido todavía.
app.get('/api/debug/pendientes-atencion', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    // Canal WhatsApp/IG/Messenger (Mongo): transferidas y aún abiertas
    const convsMeta = await Conversacion.find({
      tenant_id: req.user.tenant_id,
      estado: { $in: ['esperando_agente', 'humano'] }
    }).sort({ ultimaActividad: -1 }).limit(50).select('numero nombre canal estado agente_nombre ultimaActividad motivo');

    // Canal AcruxLab: asignaciones en modo humano (transferidas por KAI o atendidas por humano)
    const asignAcrux = await AsignacionAcrux.find({
      tenant_id: req.user.tenant_id,
      modo: 'humano'
    }).sort({ fecha_modo_humano: -1 }).limit(50).select('contacto_id agente_nombre fecha_modo_humano sin_auto_recuperacion');

    res.json({
      ok: true,
      whatsapp_ig_messenger: convsMeta.map(c => ({
        numero: c.numero, nombre: c.nombre, canal: c.canal, estado: c.estado,
        agente: c.agente_nombre || 'SIN ASIGNAR', ultima_actividad: c.ultimaActividad, motivo: c.motivo
      })),
      acruxlab_modo_humano: asignAcrux.map(a => ({
        contacto_id: a.contacto_id, agente: a.agente_nombre,
        transferido_desde: a.fecha_modo_humano, es_oportunidad_fija: !!a.sin_auto_recuperacion
      }))
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/debug/reconciliar-asignaciones-acrux', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const usuariosActivos = await UsuarioPanel.find({ tenant_id: req.user.tenant_id, activo: true, nombre: { $ne: 'Administrador' } });
    const normalizar = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/\s+/).filter(Boolean);
    const encontrarUsuarioPorNombre = (nombreOdoo) => {
      const palabrasOdoo = normalizar(nombreOdoo);
      if (!palabrasOdoo.length) return null;
      return usuariosActivos.find(v => {
        const palabrasV = normalizar(v.nombre);
        const coincidencias = palabrasV.filter(p => palabrasOdoo.includes(p)).length;
        return coincidencias >= Math.min(2, palabrasV.length);
      }) || null;
    };

    // Traer el agente REAL más reciente (derivado de Odoo) para cada contacto_id
    const mensajes = await odooCallLocal('acrux.chat.message', 'search_read',
      [[]],
      { fields: ['id', 'contact_id', 'from_me', 'user_id', 'date_message'], limit: 1000, order: 'date_message desc' }
    ) || [];
    const agenteOdooPorContacto = {};
    const fechaPorContacto = {};
    mensajes.forEach(m => {
      if (!m.from_me || !m.user_id || !m.contact_id) return;
      const cid = m.contact_id[0];
      if (!fechaPorContacto[cid] || m.date_message > fechaPorContacto[cid]) {
        fechaPorContacto[cid] = m.date_message;
        agenteOdooPorContacto[cid] = m.user_id[1];
      }
    });

    const asignaciones = await AsignacionAcrux.find({ tenant_id: req.user.tenant_id });
    let corregidas = 0;
    const detalle = [];

    for (const asign of asignaciones) {
      const agenteOdoo = agenteOdooPorContacto[asign.contacto_id];
      if (!agenteOdoo || agenteOdoo === 'Administrador') continue; // sin agente real detectable, no tocar

      const usuarioReal = encontrarUsuarioPorNombre(agenteOdoo);
      if (!usuarioReal) continue; // el agente de Odoo no corresponde a ningún usuario nuestro conocido

      if (usuarioReal.nombre !== asign.agente_nombre) {
        detalle.push({ contacto_id: asign.contacto_id, antes: asign.agente_nombre, ahora: usuarioReal.nombre });
        asign.agente_id = usuarioReal._id;
        asign.agente_nombre = usuarioReal.nombre;
        await asign.save();
        corregidas++;
      }
    }

    res.json({ ok: true, total_revisadas: asignaciones.length, total_corregidas: corregidas, detalle });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/debug/diagnostico-completo-acrux', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const usuarios = await UsuarioPanel.find({ tenant_id: req.user.tenant_id })
      .select('nombre email role activo disponible');

    const asignaciones = await AsignacionAcrux.find({ tenant_id: req.user.tenant_id })
      .sort({ fecha_asignado: -1 })
      .limit(30);

    // Traer conversaciones crudas de Odoo (mismo query que usa el endpoint real) para
    // ver el agente derivado de Odoo ANTES de que nuestro sistema lo toque.
    const mensajes = await odooCallLocal('acrux.chat.message', 'search_read',
      [[]],
      { fields: ['id', 'contact_id', 'from_me', 'user_id', 'date_message'], limit: 300, order: 'date_message desc' }
    ) || [];

    const porContacto = {};
    mensajes.forEach(m => {
      if (!m.contact_id) return;
      const cid = m.contact_id[0];
      if (!porContacto[cid]) porContacto[cid] = { contacto_id: cid, nombre: m.contact_id[1], agente_odoo: null };
      if (m.from_me && m.user_id) porContacto[cid].agente_odoo = m.user_id[1];
    });

    res.json({
      ok: true,
      usuarios: usuarios.map(u => ({ nombre: u.nombre, email: u.email, role: u.role, activo: u.activo, disponible: u.disponible })),
      total_asignaciones_guardadas: asignaciones.length,
      asignaciones: asignaciones.map(a => ({ contacto_id: a.contacto_id, agente_nombre: a.agente_nombre, modo: a.modo, fecha_asignado: a.fecha_asignado })),
      conversaciones_odoo_crudas: Object.values(porContacto).slice(0, 20)
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, stack: e.stack });
  }
});

app.get('/api/debug/asignaciones-por-agente', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const vendedores = await UsuarioPanel.find({ tenant_id: req.user.tenant_id, role: 'vendedor' }).select('nombre _id disponible');
    const resultado = [];
    for (const v of vendedores) {
      const enAcrux = await AsignacionAcrux.countDocuments({ tenant_id: req.user.tenant_id, agente_id: v._id });
      const enMeta = await Conversacion.countDocuments({ tenant_id: req.user.tenant_id, agente_id: v._id });
      resultado.push({ nombre: v.nombre, disponible: v.disponible, asignaciones_acrux: enAcrux, asignaciones_whatsapp_ig_messenger: enMeta, total: enAcrux + enMeta });
    }
    res.json({ ok: true, resultado });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/debug/rol-usuario', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const email = (req.query.email || '').toLowerCase().trim();
    if (!email) return res.json({ ok: false, error: 'Falta ?email=' });
    // Buscamos TODAS las cuentas con ese correo (no solo la primera) — si hay más de
    // una, esa sería la explicación real: la persona sigue logueada en una cuenta vieja
    // con otro rol, mientras la cuenta "correcta" es otra distinta.
    const usuarios = await UsuarioPanel.find({ email }).select('nombre email role activo disponible _id creado');
    res.json({
      ok: true,
      total_cuentas_con_este_correo: usuarios.length,
      cuentas: usuarios.map(u => ({
        id: u._id.toString(),
        nombre: u.nombre,
        role_crudo: JSON.stringify(u.role),
        activo: u.activo,
        disponible: u.disponible,
        creado: u.creado
      }))
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Diagnóstico: buscar usuarios de Odoo (res.users) por nombre, para encontrar el ID
// real que corresponde a cada vendedor y así poder vincularlo en KAI.
app.get('/api/debug/usuarios-odoo', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const busqueda = (req.query.buscar || '').trim();
    const domain = busqueda ? [['name', 'ilike', busqueda]] : [];
    const usuarios = await odooCallLocal('res.users', 'search_read', [domain], { fields: ['id', 'name', 'login'], limit: 30 });
    res.json({ ok: true, usuarios });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/debug/opciones-carrera', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const registros = await odooCallLocal('capouilliez.carrer', 'search_read', [[]], { fields: ['id', 'name'], limit: 50 });
    res.json({ ok: true, registros });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/debug/opciones-campo/:campo', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const campos = await odooCallLocal('crm.lead', 'fields_get', [[req.params.campo]], { attributes: ['string', 'type', 'selection'] });
    res.json({ ok: true, campo: campos?.[req.params.campo] || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/debug/campos-crm-lead', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const campos = await odooCallLocal('crm.lead', 'fields_get', [], { attributes: ['string', 'type'] });
    if (!campos) return res.json({ ok: false, error: 'No se pudo leer fields_get de crm.lead' });

    const personalizados = Object.entries(campos)
      .filter(([tecnico]) => tecnico.startsWith('x_studio_'))
      .map(([tecnico, def]) => ({ campo_tecnico: tecnico, etiqueta: def.string, tipo: def.type }));

    // También incluir los estándar más relevantes para nombre/contacto, para comparar
    const estandar = ['name', 'partner_name', 'contact_name', 'phone', 'mobile', 'email_from', 'priority', 'tag_ids']
      .filter(k => campos[k])
      .map(k => ({ campo_tecnico: k, etiqueta: campos[k].string, tipo: campos[k].type }));

    // Búsqueda amplia: cualquier campo (sin importar prefijo técnico) cuya etiqueta
    // contenga "nivel", por si no es un campo x_studio_* como se asumía.
    const todosLosCampos = Object.entries(campos).map(([tecnico, def]) => ({ campo_tecnico: tecnico, etiqueta: def.string, tipo: def.type }));
    const q = (req.query.buscar || 'nivel').toLowerCase();
    const coincidencias = todosLosCampos.filter(c => (c.etiqueta || '').toLowerCase().includes(q));

    res.json({ ok: true, campos_personalizados_studio: personalizados, campos_estandar_relevantes: estandar, busqueda: q, coincidencias_por_etiqueta: coincidencias, total_campos_en_el_modelo: todosLosCampos.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/debug/automatizaciones-crm-lead', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  const resultado = { ok: true };

  // 1) Automatizaciones (base.automation) ligadas al modelo crm.lead
  try {
    const modelos = await odooCallLocal('ir.model', 'search_read', [[['model', '=', 'crm.lead']]], { fields: ['id'], limit: 1 });
    const modeloId = modelos?.[0]?.id;
    const automatizaciones = await odooCallLocal('base.automation', 'search_read',
      [modeloId ? [['model_id', '=', modeloId]] : [['model_id.model', '=', 'crm.lead']]],
      { fields: ['id', 'name', 'active', 'trigger', 'action_server_ids', 'filter_domain'], limit: 50 }
    );
    resultado.automatizaciones = automatizaciones || [];

    // Traer el código/detalle de cada acción de servidor asociada
    const accionIds = [...new Set((automatizaciones || []).flatMap(a => a.action_server_ids || []))];
    if (accionIds.length) {
      const acciones = await odooCallLocal('ir.actions.server', 'search_read',
        [[['id', 'in', accionIds]]],
        { fields: ['id', 'name', 'state', 'code', 'update_field_id', 'update_path', 'value', 'evaluation_type'] }
      );
      resultado.acciones_servidor = acciones || [];
    }
  } catch (e) {
    resultado.automatizaciones_error = e.message;
  }

  // 2) Alias de correo (mail.alias) que apunten a crm.lead — ej. capouilliez@gmail.com / admisiones
  try {
    const alias = await odooCallLocal('mail.alias', 'search_read',
      [[['alias_model_id.model', '=', 'crm.lead']]],
      { fields: ['id', 'alias_name', 'alias_defaults', 'alias_force_thread_id', 'alias_domain'], limit: 20 }
    );
    resultado.alias_correo = alias || [];
  } catch (e) {
    resultado.alias_error = e.message;
  }

  res.json(resultado);
});

app.get('/api/logs/no-procesados', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
    const logs = await MessageLog.find({
      tenant_id: req.user.tenant_id,
      procesado: false
    }).sort({ fecha: -1 }).limit(50);
    res.json({ ok: true, total: logs.length, logs });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});


// ===== CHATS EN VIVO — handoff a humano =====

// Listar conversaciones (todas si admin, o asignadas a mí si vendedor)
app.get('/api/conversaciones', authMiddleware, async (req, res) => {
  try {
    // Verificamos el rol directo en la base de datos (no solo el del token) — evita que
    // un cambio de rol reciente quede "atorado" hasta que la persona cierre sesión.
    const usuarioActual = await UsuarioPanel.findById(req.user.id).select('role');
    const rolReal = usuarioActual?.role || req.user.role;

    // Por defecto la bandeja sigue mostrando SOLO lo que requiere atención humana —
    // igual que siempre, para no confundir a las vendedoras. Los chats que KAI atiende
    // solo (estado 'bot') aparecen únicamente si se piden con ?incluir_kai=1 desde el
    // interruptor del panel.
    const incluirKai = req.query.incluir_kai === '1' || req.query.incluir_kai === 'true';
    const filtro = { tenant_id: req.user.tenant_id, estado: { $ne: 'cerrado' } };
    if (!incluirKai) filtro.estado = { $nin: ['cerrado', 'bot'] };
    // El vendedor ve lo suyo + lo que nadie ha tomado todavía (para poder reclamarlo).
    // Antes solo filtraba por agente_id = su ID, lo que ocultaba por completo los chats
    // sin asignar — un vendedor nuevo o sin chats asignados veía la bandeja vacía.
    if (rolReal === 'vendedor') {
      filtro.$or = [{ agente_id: null }, { agente_id: req.user.id }];
    }
    const convs = await Conversacion.find(filtro).sort({ ultimaActividad: -1 }).limit(100);

    // Enriquecer con nombre del Contacto en MongoDB para mostrar en el panel
    const convsEnriquecidas = await Promise.all(convs.map(async (conv) => {
      const obj = conv.toObject();
      if (!obj.nombre) {
        const contacto = await Contacto.findOne({ tenant_id: req.user.tenant_id, numero: conv.numero }).select('nombre nombre_alumno nivel_interes');
        if (contacto?.nombre) {
          obj.nombre = contacto.nombre;
          obj.nombre_alumno = contacto.nombre_alumno;
          obj.nivel_interes = contacto.nivel_interes;
        }
      }
      return obj;
    }));

    res.json({ ok: true, conversaciones: convsEnriquecidas });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Mismo panel de "datos del padre + imágenes sugeridas" que ya existía para el chat de
// WhatsApp/Meta, pero para AcruxLab — ahí es donde vive casi todo el tráfico real hoy,
// y antes no tenía este contexto lateral que le da fluidez a la vendedora.
// GET /api/acrux/contacto-info?numero=502XXXXXXXX
app.get('/api/acrux/contacto-info', authMiddleware, async (req, res) => {
  try {
    const numero = String(req.query.numero || '').replace(/\D/g, '');
    if (!numero) return res.json({ ok: false, error: 'Falta ?numero=' });

    const contacto = await Contacto.findOne({ tenant_id: req.user.tenant_id, numero });

    let imagenesSugeridas = [];
    if (contacto?.nivel_interes) {
      // Se incluye el base64 (nombre, categoria, mime_type e imagen) para que el
      // panel muestre la miniatura REAL — antes se excluía "para carga rápida" y
      // el resultado era que nunca se veía ninguna imagen, solo un ícono genérico.
      // Son máximo 6 imágenes a la vez, así que el costo es aceptable.
      imagenesSugeridas = await ImagenMarketing.find({
        tenant_id: req.user.tenant_id, activo: true,
        $or: [{ nivel_educativo: contacto.nivel_interes }, { nivel_educativo: 'Todos' }]
      }).select('nombre categoria nivel_educativo mime_type imagen_base64').limit(6);
    } else {
      imagenesSugeridas = await ImagenMarketing.find({
        tenant_id: req.user.tenant_id, activo: true, nivel_educativo: 'Todos'
      }).select('nombre categoria nivel_educativo mime_type imagen_base64').limit(4);
    }

    res.json({ ok: true, contacto, imagenes_sugeridas: imagenesSugeridas });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Ver una conversación específica con su historial completo
app.get('/api/conversaciones/:id', authMiddleware, async (req, res) => {
  try {
    const conv = await Conversacion.findOne({ _id: req.params.id, tenant_id: req.user.tenant_id });
    if (!conv) return res.status(404).json({ ok: false, error: 'No encontrada' });

    // Buscar el contacto para obtener su nivel de interés
    const contacto = await Contacto.findOne({ tenant_id: req.user.tenant_id, numero: conv.numero });

    // Sugerir imágenes según el nivel del contacto
    let imagenesSugeridas = [];
    if (contacto?.nivel_interes) {
      const nivel = contacto.nivel_interes;
      // Buscar imágenes que coincidan con el nivel o sean para todos
      // Se incluye el base64 para que el panel muestre la miniatura real (antes
      // se excluía "para carga rápida" y nunca se veía ninguna imagen de verdad).
      imagenesSugeridas = await ImagenMarketing.find({
        tenant_id: req.user.tenant_id,
        activo: true,
        $or: [
          { nivel_educativo: nivel },
          { nivel_educativo: 'Todos' }
        ]
      }).select('nombre categoria nivel_educativo mime_type imagen_base64').limit(6);
    } else {
      // Sin nivel conocido — mostrar imágenes generales
      imagenesSugeridas = await ImagenMarketing.find({
        tenant_id: req.user.tenant_id,
        activo: true,
        nivel_educativo: 'Todos'
      }).select('nombre categoria nivel_educativo mime_type imagen_base64').limit(4);
    }

    res.json({ ok: true, conversacion: conv, contacto, imagenes_sugeridas: imagenesSugeridas });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Agente toma/responde manualmente una conversación
app.post('/api/conversaciones/:id/responder', authMiddleware, async (req, res) => {
  try {
    const { mensaje, imagen_id, imagen_base64, imagen_mime } = req.body;
    if (!mensaje && !imagen_id && !imagen_base64) return res.status(400).json({ ok: false, error: 'Mensaje o imagen requeridos' });

    const conv = await Conversacion.findOne({ _id: req.params.id, tenant_id: req.user.tenant_id });
    if (!conv) return res.status(404).json({ ok: false, error: 'No encontrada' });

    // Si nadie la había tomado, este agente la toma ahora
    if (!conv.agente_id) {
      conv.agente_id = req.user.id;
      conv.agente_nombre = req.user.nombre || req.user.email;
      conv.estado = 'humano';
    }

    let resultado;
    // Meta espera el PSID puro, sin el prefijo "ig_"/"fb_" que usamos internamente
    // para distinguir el canal en conv.numero — si se lo mandamos con prefijo, Meta
    // rechaza el envío silenciosamente (por eso no llegaba nada por IG/Messenger).
    const idExternoReal = conv.numero.replace(/^(ig_|fb_)/, '');

    if (imagen_id) {
      // Imagen del catálogo preclasificado — ahora enrutada por el canal real,
      // antes siempre intentaba mandarse por WhatsApp sin importar el canal.
      const img = await ImagenMarketing.findOne({ _id: imagen_id, tenant_id: req.user.tenant_id });
      if (!img) return res.status(404).json({ ok: false, error: 'Imagen no encontrada' });
      if (conv.canal === 'instagram' || conv.canal === 'messenger') {
        resultado = await enviarImagenInstagramOMessenger(conv.canal, img.imagen_base64, img.mime_type, idExternoReal, mensaje || '');
      } else {
        resultado = await enviarImagenDesdeDB(img, conv.numero, mensaje || '');
      }
      conv.mensajes.push({ de: 'agente', texto: mensaje ? `📷 ${img.nombre} — ${mensaje}` : `📷 ${img.nombre}` });
    } else if (imagen_base64) {
      // Imagen subida ad-hoc desde la computadora del agente (no viene del catálogo)
      if (conv.canal === 'instagram' || conv.canal === 'messenger') {
        resultado = await enviarImagenInstagramOMessenger(conv.canal, imagen_base64, imagen_mime || 'image/jpeg', idExternoReal, mensaje || '');
      } else {
        const mediaId = await subirImagenAMeta(imagen_base64, imagen_mime || 'image/jpeg');
        resultado = mediaId ? await enviarImagenWhatsAppMeta(conv.numero, mediaId, mensaje || '') : { error: { message: 'No se pudo subir la imagen a WhatsApp' } };
      }
      conv.mensajes.push({ de: 'agente', texto: mensaje ? `📷 [imagen adjunta] — ${mensaje}` : '📷 [imagen adjunta]' });
    } else {
      // Enviar por el canal real de la conversación — antes esto SIEMPRE mandaba por WhatsApp,
      // aunque la conversación fuera de Instagram o Messenger (el mensaje no llegaba a nadie).
      if (conv.canal === 'instagram') {
        resultado = await enviarMensajeInstagram(idExternoReal, mensaje);
      } else if (conv.canal === 'messenger') {
        resultado = await enviarMensajeMessenger(idExternoReal, mensaje);
      } else {
        resultado = await enviarWhatsAppMeta(conv.numero, mensaje);
      }
      conv.mensajes.push({ de: 'agente', texto: mensaje });
    }

    conv.ultimaActividad = new Date();
    await conv.save();

    // Si Meta devolvió un error (ej. falta INSTAGRAM_PAGE_TOKEN/MESSENGER_PAGE_TOKEN en Railway),
    // el mensaje quedó guardado en el historial pero NO llegó realmente al padre — avisamos.
    if (resultado && resultado.error) {
      return res.json({
        ok: false,
        error: `El mensaje se guardó pero no se pudo entregar por ${conv.canal}: ${resultado.error.message || 'error desconocido de Meta'}. Revisa que el token de página (${conv.canal === 'instagram' ? 'INSTAGRAM_PAGE_TOKEN' : conv.canal === 'messenger' ? 'MESSENGER_PAGE_TOKEN' : 'WHATSAPP_TOKEN'}) esté bien configurado en Railway.`,
        conversacion: conv
      });
    }

    res.json({ ok: true, conversacion: conv, whatsapp: resultado });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Devolver la conversación a KAI (el bot retoma el control)
app.post('/api/conversaciones/:id/devolver-a-kai', authMiddleware, async (req, res) => {
  try {
    const conv = await Conversacion.findOne({ _id: req.params.id, tenant_id: req.user.tenant_id });
    if (!conv) return res.status(404).json({ ok: false, error: 'No encontrada' });

    // Generar resumen del agente para que KAI tenga contexto al retomar
    const resumenAgente = await generarResumenParaKai(conv);
    conv.resumen_agente = resumenAgente;
    // Antes se marcaba como 'cerrado' y el chat DESAPARECÍA del panel de inmediato —
    // parecía que se había perdido. Ahora pasa a 'bot': KAI retoma la atención y la
    // conversación sigue visible, marcada como "🤖 KAI atendiendo".
    conv.estado = 'bot';
    conv.agente_id = null;
    conv.agente_nombre = null;
    conv.ultimaActividad = new Date();
    await conv.save();

    // Inyectar el resumen en el historial de KAI para esa conversación, para que no repita preguntas
    if (resumenAgente) {
      if (!conversaciones.has(conv.numero)) conversaciones.set(conv.numero, { historial: [], ultimaActividad: Date.now() });
      const ctx = conversaciones.get(conv.numero);
      ctx.historial.push({ role: 'assistant', content: `(Contexto interno — no mostrar tal cual: mientras hablaba con un asesor humano, esto ocurrió: ${resumenAgente}. Retoma la conversación con naturalidad, sin mencionar este resumen explícitamente, solo úsalo para no preguntar lo que ya se resolvió.)` });
      ctx.ultimaActividad = Date.now();
    }

    res.json({ ok: true, mensaje: 'KAI retoma esta conversación', conversacion: conv, resumen_agente: resumenAgente });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Marcar mi disponibilidad para recibir chats asignados
app.post('/api/mi-disponibilidad', authMiddleware, async (req, res) => {
  try {
    const { disponible } = req.body;
    // Si el agente lo apaga manualmente: queda marcado como apagado a propósito (no se reactiva solo).
    // Si lo prende manualmente: vuelve al control automático normal del sistema de inactividad.
    await UsuarioPanel.findByIdAndUpdate(req.user.id, {
      disponible: !!disponible,
      disponible_manual: !disponible, // true solo cuando se apaga manualmente
      ultima_actividad: new Date()
    });
    res.json({ ok: true, disponible: !!disponible });
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

// Endpoint de prueba — crea un lead de prueba directo en Odoo para confirmar permisos de escritura
app.post('/api/odoo/test-escritura', authMiddleware, async (req, res) => {
  try {
    const teamId = 1;
    const leadId = await odooCallLocal('crm.lead', 'create', [{
      name: `PRUEBA ESCRITURA KAI — ${new Date().toLocaleString('es-GT')}`,
      phone: '00000000',
      description: 'Lead de prueba para confirmar que el usuario de Odoo tiene permisos de escritura. Puede eliminarse.',
      team_id: teamId,
      type: 'opportunity'
    }]);
    if (leadId) {
      res.json({ ok: true, mensaje: 'Escritura exitosa en Odoo', lead_id: leadId });
    } else {
      res.json({ ok: false, error: 'odooCallLocal no devolvió un ID — revisa logs del servidor' });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Crea 3 leads de prueba — uno por cada nivel de calor — para verificar las etiquetas en Odoo
app.post('/api/odoo/test-niveles-calor', authMiddleware, async (req, res) => {
  try {
    const teamId = 1;
    const niveles = [
      { nivel: 1, etiqueta: 'KAI — Alta Intención', nombre: 'PRUEBA Nivel 1 — Familia Pérez', telefono: '50211111111' },
      { nivel: 2, etiqueta: 'KAI — Interesado', nombre: 'PRUEBA Nivel 2 — Familia Gómez', telefono: '50222222222' },
      { nivel: 3, etiqueta: 'KAI — Exploratorio', nombre: 'PRUEBA Nivel 3 — Familia López', telefono: '50233333333' },
    ];

    const resultados = [];
    for (const n of niveles) {
      const tagId = await getOdooTagId(n.etiqueta);
      const leadId = await odooCallLocal('crm.lead', 'create', [{
        name: `Lead KAI — ${n.nombre}`,
        phone: n.telefono,
        description: `PRUEBA — Lead de demostración del nivel de calor: ${n.etiqueta}. Puede eliminarse, fue creado para validar el sistema de etiquetas.`,
        team_id: teamId,
        type: 'opportunity',
        tag_ids: tagId ? [[6, 0, [tagId]]] : undefined
      }]);
      resultados.push({ nivel: n.nivel, etiqueta: n.etiqueta, lead_id: leadId, tag_id: tagId });
    }

    res.json({ ok: true, mensaje: '3 leads de prueba creados con sus etiquetas de nivel de calor', resultados });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/', (req, res) => res.sendFile('index.html', { root: 'public' }));

// ===== SEED DE IMÁGENES AL INICIAR =====
// Carga las imágenes del colegio en MongoDB si no existen todavía.
// Los admin/vendedores pueden agregar, modificar o eliminar imágenes desde el panel.
// ⚠️ SEED DE IMÁGENES — APAGADO A PROPÓSITO.
// Corría en CADA arranque del servidor y solo buscaba imágenes con activo:true. Cuando
// el equipo desactivaba o depuraba una imagen del Banco, el seed no la encontraba y la
// VOLVÍA A CREAR en el siguiente reinicio, deshaciendo el trabajo de depuración (de ahí
// los nombres "(versión 2)", "(versión 3)"...). El Banco de Imágenes ya está cargado y
// curado por el equipo, así que no debe volver a sembrarse solo.
// Si algún día hace falta recargarlo, se puede usar el endpoint /api/imagenes/reset,
// que es una acción manual y consciente.
const SEED_IMAGENES_ACTIVO = false;

async function seedImagenes() {
  // Envuelto en try/catch total — nunca debe crashear el servidor
  try {
    const tenant = await Tenant.findOne({ activo: true });
    if (!tenant) return;

    let IMAGENES_SEED;
    try { IMAGENES_SEED = require('./imagenes_seed.js'); }
    catch(e) { console.log('ℹ️ imagenes_seed.js no encontrado — omitiendo'); return; }

    if (!Array.isArray(IMAGENES_SEED) || !IMAGENES_SEED.length) return;

    let nuevas = 0;
    for (const img of IMAGENES_SEED) {
      try {
        const existe = await ImagenMarketing.findOne({ tenant_id: tenant._id, nombre: img.nombre, activo: true });
        if (existe) continue;
        await ImagenMarketing.create({
          tenant_id: tenant._id,
          nombre: img.nombre,
          categoria: img.categoria || 'general',
          nivel_educativo: img.nivel_educativo || 'Todos',
          imagen_base64: img.imagen_base64,
          mime_type: img.mime_type || 'image/jpeg',
          caption: img.caption || '',
          subida_por_nombre: 'Sistema — carga inicial'
        });
        nuevas++;
      } catch(imgErr) {
        console.error(`⚠️ No se pudo cargar imagen "${img.nombre}":`, imgErr.message);
      }
    }
    console.log(nuevas > 0
      ? `🖼️ ${nuevas} imágenes cargadas en el banco`
      : `🖼️ Banco OK — ${IMAGENES_SEED.length} imágenes ya estaban cargadas`);
  } catch(e) {
    console.error('⚠️ Seed imágenes (no crítico):', e.message);
  }
}

// Endpoint público (sin login) para verificar qué versión del código está corriendo
// en Railway ahora mismo — solo entra a esta URL desde el navegador:
// https://kai-capouilliez.up.railway.app/api/version
// Diagnóstico: probar la llamada a Claude directamente, mostrando la respuesta CRUDA
// completa (no solo null) para ver el error real sin depender de los logs de Railway.
app.get('/api/debug/probar-claude', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false });
  try {
    const postData = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 100, system: 'Eres un asistente de prueba. Responde brevemente.', messages: [{ role: 'user', content: 'Di solo "funciona correctamente"' }] });
    const resultado = await new Promise((resolve) => {
      const options = {
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(postData) }
      };
      const apiReq = https.request(options, (apiRes) => {
        const chunks = [];
        apiRes.on('data', c => chunks.push(c));
        apiRes.on('end', () => {
          const texto = Buffer.concat(chunks).toString('utf8');
          resolve({ status_code: apiRes.statusCode, respuesta_cruda: texto });
        });
      });
      apiReq.on('error', (e) => resolve({ error_red: e.message }));
      apiReq.write(postData); apiReq.end();
    });
    res.json({ ok: true, api_key_configurada: !!process.env.ANTHROPIC_API_KEY, api_key_primeros_caracteres: (process.env.ANTHROPIC_API_KEY || '').substring(0, 10), resultado });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/version', (req, res) => {
  const minutosActivo = Math.round((Date.now() - SERVIDOR_INICIADO) / 60000);
  res.json({
    version: VERSION_KAI,
    servidor_iniciado: new Date(SERVIDOR_INICIADO).toISOString(),
    minutos_activo: minutosActivo,
    // Si este número se reinicia solo cada pocos minutos, el servidor se está cayendo
    // y reiniciando — eso explicaría cualquier comportamiento intermitente.
    aviso: minutosActivo < 5 ? 'El servidor arrancó hace menos de 5 minutos' : null
  });
});

app.listen(PORT, () => {
  console.log(`✅ KAI — Colegio Capouilliez corriendo en puerto ${PORT} | ${VERSION_KAI}`);
  console.log(`📊 Planes: Básico(${PLANES.basico.mensajes_mes}msg/${PLANES.basico.max_usuarios}usr) | Profesional(${PLANES.profesional.mensajes_mes}msg/${PLANES.profesional.max_usuarios}usr) | Empresarial(${PLANES.empresarial.mensajes_mes}msg/${PLANES.empresarial.max_usuarios}usr)`);
  // Cargar imágenes del colegio en MongoDB al iniciar (si no existen)
  if (SEED_IMAGENES_ACTIVO) {
    setTimeout(seedImagenes, 5000); // esperar 5s a que MongoDB esté listo
  } else {
    console.log('🖼️ Seed de imágenes DESACTIVADO — el Banco de Imágenes lo administra el equipo desde el panel');
  }
});
