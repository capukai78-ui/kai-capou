const express = require('express');
const { procesarMensajeWhatsApp, testConexion, getLeads, getLeadsPerdidos, getStages, getTeams, getLostReasons, getTags, getUsuarios } = require('./odoo.service');
const mongoose = require('mongoose');
const https = require('https');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

dotenv.config();

const VERSION_KAI = 'v2026.07.20-proactivo-visible-en-chats'; // Cambia esta línea cada vez que subas un cambio importante, para verificar en /api/version
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
    fecha:  { type: Date, default: Date.now }
  }],
  ultimaActividad: { type: Date, default: Date.now },
  creado:        { type: Date, default: Date.now }
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
  const instruccionesColegio = `\nERES: Kai, asistente virtual de admisiones. Cálido, profesional, orientado a resultados.\nMISIÓN: Convertir cada conversación en una visita o inscripción.\n\nFLUJO INICIAL:\n1) Saluda con calidez y, si es la primera vez que escribe, pregúntale su nombre antes de continuar. Usa exactamente este formato: "¡Hola! Bienvenido al Colegio Capouilliez 👋 Soy Kai, tu asistente de admisiones.\n\n¿Con quién tengo el gusto de hablar?". Si ya sabes su nombre (por el contexto interno de memoria), NO se lo vuelvas a pedir — salúdalo por su nombre directamente y continúa con calidez, sin sonar frío ni ir directo al grano.\n2) Pregunta el nivel ofreciendo un menú numerado:\n   "¿En qué nivel está interesado? Marca el número:\n   1. Preprimaria\n   2. Primaria\n   3. Secundaria (Básico y Bachillerato en Ciencias y Letras)"\n3) Si elige Preprimaria (1): solicita la fecha de nacimiento del niño/a y, con esa fecha, comparte la tabla de edades para confirmar el grado exacto que le corresponde.\n4) Explica beneficios relevantes al nivel elegido.\n5) Captura: nombre del padre/madre, nombre del alumno, grado, zona, colegio actual, correo.\n6) Ofrece agendar una visita o invita al próximo Open House (sin mencionar que es "el primer sábado de cada mes" — la fecha puede variar, siempre confirma la fecha exacta vigente).\n7) Una sola vez por conversación, después de tener el correo o nombre del alumno, pregunta de forma natural y breve si desea recibir noticias del colegio (ej: "¿Te gustaría que te avisemos de nuestro próximo Open House y noticias del colegio? 📩"). Respeta la respuesta — si dice que no, no insistas ni lo vuelvas a preguntar en esta conversación.\n\nCONTACTO Y ASESORES — MUY IMPORTANTE:\n- Tu prioridad es avanzar la conversación hacia la visita/inscripción TÚ MISMO. NO ofrezcas pasar con un asesor como primera opción ni como salida fácil para dudas generales.\n- Solo sugiere hablar con un asesor humano DESPUÉS de haber intentado avanzar el proceso, o cuando el padre necesita algo que tú no puedes resolver (pregunta muy específica, quiere negociar, pide hablar con alguien directamente).\n- CUANDO EL PADRE MUESTRE INTERÉS REAL DE AGENDAR UNA VISITA, OPEN HOUSE, O INSCRIBIR (ej: "quiero agendar", "sí, quiero la visita", "cómo inscribo", "quiero inscribirlo"): NO le des el número de PBX/WhatsApp como si tuviera que llamar él mismo. En su lugar dile que con gusto lo conecta directamente AHORA con un asesor que le ayudará a coordinar todo, y pregúntale si desea que lo transfieras (ej: "¡Perfecto! Te conecto ahora mismo con un asesor que te ayudará a coordinar la visita y confirmar la fecha. ¿Te parece?"). El sistema detecta esto automáticamente y transfiere la conversación.\n- Los números de PBX 2429-1999 y 2429-1908 son SOLO para si el padre prefiere llamar por su cuenta fuera de WhatsApp, no los ofrezcas como la opción principal cuando ya estás conversando con él aquí mismo.\n- NUNCA uses la palabra "mientras tanto" — está prohibida, suena repetitiva. Usa alternativas naturales o reformula sin esa frase.\n\nSOBRE LAS IMÁGENES — MUY IMPORTANTE:\n- Tú NUNCA decides ni controlas si se manda una imagen — eso lo hace el sistema automáticamente, por fuera de ti, según la pregunta exacta del padre/madre en CADA mensaje (una imagen por mensaje, sobre UN tema específico: cuotas, horarios, requisitos, proceso de admisión, edades, ubicación, o papelería).\n- JAMÁS afirmes en tu respuesta que "ya mandaste una imagen", "aquí tienes las imágenes", o similar — a menos que veas una nota de sistema real confirmándolo para ESE turno exacto. No lo asumas ni lo inventes nunca.\n- Si el padre/madre pide VARIAS cosas o "todas las imágenes" a la vez (ej: "mándame todo", "las 4", "cuotas, horarios y requisitos"): explícale con calidez que puedes ayudarle mejor si pregunta un tema a la vez (ej: "¡Con gusto te ayudo con todo eso! Para que te llegue bien la información, empecemos con uno: ¿qué te gustaría ver primero, cuotas, horarios, requisitos o el proceso de admisión?"). NUNCA pretendas que ya se envió algo cuando el padre pidió varios temas juntos.\n- REGLA ABSOLUTA, SIN EXCEPCIÓN: NUNCA escribas precios, montos, cifras en quetzales, ni rangos de precios en tus respuestas de texto — bajo NINGUNA circunstancia, sin importar cómo esté formulada la pregunta. Todo lo relacionado a precios/cuotas/colegiaturas se resuelve SOLO con imagen. Si el padre pregunta por precios de una forma que no reconoces con claridad, NO inventes ni cites ningún número — en su lugar, pregúntale amablemente de qué nivel/grado necesita el precio, para poder ayudarle con la información exacta.\n\nFORMATO DE RESPUESTA:\n- NUNCA uses asteriscos (**texto**) para negritas ni ningún otro formato de markdown. WhatsApp no lo necesita y se ve mal. Escribe en texto plano natural.\n- No uses guiones para listas si la respuesta es corta — prefiere texto fluido y conversacional.\n\nINACTIVIDAD:\n- Si la conversación lleva más de 3 horas sin actividad ni respuesta del padre, antes de cerrar pregúntale si desea comunicarse con un asesor.\n- Si no responde, informa que se terminará la comunicación por inactividad pero que sigues a las órdenes y que pueden volver a escribir cuando quieran.\n\nLEDS (Liderazgo, Expresión, Deportes y Salud):\n- Alumnos de Primaria y Secundaria reciben 1 vez a la semana un período doble de actividades extracurriculares dentro del horario escolar, sin costo adicional.\n- Actividades disponibles: Fútbol, Baloncesto, Tenis de Mesa, Natación, Artes Visuales, Marimba, Teatro Musical.\n- Los alumnos son quienes eligen a qué actividad inscribirse, y participan en ella durante todo el ciclo escolar (la oferta puede variar cada año).\n\nREGLAS GENERALES:\nResponde de forma natural y cálida como WhatsApp, no como un correo. Nunca des listas largas ni tablas completas — si quieren más info ellos preguntan. Español guatemalteco. NUNCA inventes datos. NUNCA menciones Claude.`;
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
  return /asesor|agente|persona real|hablar con (alguien|un humano)|atenci[oó]n humana|hablar con alguien/.test(t);
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
    return 'En este momento estamos fuera de nuestro horario de atención (Lunes a Jueves 7:00 a 16:00, Viernes 7:00 a 15:00). Un asesor te contactará personalmente tan pronto reiniciemos labores. 🙏';
  }
  if (nombreAgente) {
    const primerNombre = nombreAgente.split(' ')[0];
    return mostroInteresReal
      ? `¡Perfecto! Te conecto con ${primerNombre}, quien te ayudará a coordinar todo 🙋`
      : `¡Claro! Te paso con ${primerNombre}, quien te atenderá enseguida 🙋`;
  }
  return 'En este momento todos nuestros asesores están ocupados. En breve uno te atenderá personalmente. 🙏';
}

// Busca un agente disponible (round-robin simple: el que tenga menos chats activos)
async function asignarAgenteLibre(tenantId) {
  const agentes = await UsuarioPanel.find({
    tenant_id: tenantId,
    role: 'vendedor', // el admin nunca debe recibir tickets asignados automáticamente
    activo: true,
    disponible: true
  }).sort({ _id: 1 }); // orden estable, para que el round-robin sea predecible
  if (!agentes.length) return null;

  // Reparto 1 a 1 real: contamos el TOTAL histórico de conversaciones ya asignadas a
  // cada agente en AMBOS canales (WhatsApp/IG/Messenger + AcruxLab combinados), para
  // que la carga quede pareja entre ellos sin importar por dónde entró el lead.
  const [countsMeta, countsAcrux] = await Promise.all([
    Conversacion.aggregate([
      { $match: { tenant_id: tenantId, agente_id: { $ne: null } } },
      { $group: { _id: '$agente_id', total: { $sum: 1 } } }
    ]),
    AsignacionAcrux.aggregate([
      { $match: { tenant_id: tenantId } },
      { $group: { _id: '$agente_id', total: { $sum: 1 } } }
    ])
  ]);
  const countMap = {};
  countsMeta.forEach(c => countMap[c._id.toString()] = (countMap[c._id.toString()] || 0) + c.total);
  countsAcrux.forEach(c => countMap[c._id.toString()] = (countMap[c._id.toString()] || 0) + c.total);

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
  // Usamos el número limpio (sin prefijo) como clave — así, si el mismo padre ya había
  // escrito antes por el WhatsApp normal, comparte la MISMA memoria y el MISMO lead de
  // Odoo, en vez de crear un contacto/lead duplicado solo por venir de otro canal.
  const esNuevaSesionEnMemoria = !conversaciones.has(numero);
  if (esNuevaSesionEnMemoria) conversaciones.set(numero, { historial: [], ultimaActividad: Date.now() });
  const conv = conversaciones.get(numero);
  conv.ultimaActividad = Date.now();
  const historial = conv.historial;

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

  // Si había una pregunta pendiente y este mensaje trae grado, completarla tiene
  // prioridad sobre cualquier coincidencia nueva no relacionada (ver misma lógica en WhatsApp).
  let matchImagen = null;
  if (nivelMencionadoAhora && conv.temaPendienteCategoria) {
    const reglaCompletada = completarTemaPendiente(conv.temaPendienteCategoria, nivelMencionadoAhora);
    if (reglaCompletada) matchImagen = { regla: reglaCompletada, ambigua: false };
  }
  if (!matchImagen) {
    matchImagen = buscarReglaImagenCoincidente(mensajeUsuario, conv.nivelSesion);
  }
  const PALABRAS_MODO_VISUAL = ['muéstrame', 'muestrame', 'quiero ver', 'envía imágenes', 'envia imagenes', 'fotografías', 'fotografias', 'necesito las imágenes', 'necesito las imagenes', 'mándame las imágenes', 'mandame las imagenes'];
  const esModoVisual = PALABRAS_MODO_VISUAL.some(p => mensajeUsuario.toLowerCase().includes(p));
  if (!matchImagen && esModoVisual && conv.temaPendienteCategoria && conv.nivelSesion) {
    const reglaCompletada = completarTemaPendiente(conv.temaPendienteCategoria, conv.nivelSesion);
    if (reglaCompletada) matchImagen = { regla: reglaCompletada, ambigua: false };
  }
  if (matchImagen && matchImagen.ambigua) conv.temaPendienteCategoria = matchImagen.categoria;

  // ===== IMAGEN DIRECTA — sin pasar por la IA, igual que en WhatsApp =====
  if (matchImagen && !matchImagen.ambigua && matchImagen.regla) {
    conv.temaPendienteCategoria = null;
    const regla = matchImagen.regla;
    const filtroImg = { tenant_id: tenant._id, activo: true, categoria: regla.categoria };
    if (regla.nivel_educativo) filtroImg.nivel_educativo = { $in: [regla.nivel_educativo, 'Todos'] };
    if (regla.nombre_contiene) filtroImg.nombre = new RegExp(regla.nombre_contiene, 'i');
    const imagenDirecta = await ImagenMarketing.findOne(filtroImg).sort({ prioridad: -1, creado: -1 });

    if (imagenDirecta) {
      let imagenEnviada = false;
      try {
        const adjunto = await subirImagenNuevaAcrux(imagenDirecta.imagen_base64, `${imagenDirecta.nombre}.jpg`, imagenDirecta.mime_type || 'image/jpeg', contactoId);
        await odooCallLocal(
          'acrux.chat.conversation',
          'send_message',
          [[contactoId], {
            text: construirDescripcionImagen(imagenDirecta), from_me: true, ttype: 'image', res_model: 'ir.attachment', res_id: adjunto.id,
            id: -2, date_message: new Date().toISOString().replace('T', ' ').substring(0, 19), button_ids: []
          }],
          { context: { lang: 'es_GT', tz: 'America/Guatemala', is_acrux_chat_room: true } }
        );
        console.log(`🖼️ [AcruxLab] Imagen directa enviada: "${imagenDirecta.nombre}" → contacto ${contactoId}`);
        imagenEnviada = true;
      } catch (e) {
        console.error(`❌ [AcruxLab] Error enviando imagen directa a contacto ${contactoId}:`, e.message);
      }
      historial.push({ role: 'user', content: mensajeUsuario });

      if (!imagenEnviada) {
        // Si la imagen falló (ej. sesión/CSRF vencida), no dejamos a la familia sin
        // respuesta — mandamos un texto breve avisando que en un momento le llega,
        // y transferimos a un vendedor para que lo resuelva manual si hace falta.
        historial.push({ role: 'assistant', content: '(La imagen automática falló al enviarse — se avisó al padre y se dejó pendiente para el vendedor.)' });
        conv.ultimaActividad = Date.now();
        return { texto: 'Con gusto te comparto esa información — dame un momento para enviártela correctamente. 🙏', handoff: false };
      }

      historial.push({ role: 'assistant', content: `[NOTA DE SISTEMA — esto NO es algo que tú dijiste ni debes imitar este formato de frase: el sistema envió automáticamente la imagen "${imagenDirecta.nombre}" con el detalle completo de ESTE tema específico. No repitas estos datos en texto. Jamás afirmes "te mandé la imagen" a menos que este mensaje de sistema aparezca de verdad para ESE turno.]` });
      conv.ultimaActividad = Date.now();
      return { texto: '', handoff: false };
    }
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
    } else {
      historial.push({ role: 'assistant', content: '(Se avisó el horario de atención — KAI sigue atendiendo mientras tanto, no se transfirió a nadie porque no hay agentes trabajando ahorita.)' });
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
      await AsignacionAcrux.findOneAndUpdate(
        { tenant_id: tenant._id, contacto_id: contactoId },
        { modo: 'humano', fecha_modo_humano: new Date(), resumen_kai: resumenConsistencia }
      );
      console.log(`🔧 [Consistencia] KAI prometió un asesor en texto — se forzó el traspaso real para contacto ${contactoId}`);
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
    return await odooCallLocal(
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
  } catch (e) {
    // Este error NO es transitorio: el módulo de AcruxLab lo lanza cuando un agente
    // humano tiene tomada la conversación en el ChatRoom. Reintentar no sirve de nada
    // (mientras la tenga tomada, siempre va a fallar) — hay que dejársela a esa persona.
    // Lo marcamos como tal para que el motor sincronice la conversación a modo humano.
    const esConversacionTomada = /refresque la pantalla|can't write in this conversation/i.test(e.message || '');
    if (esConversacionTomada) {
      const err = new Error('CONVERSACION_TOMADA_POR_AGENTE');
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
const VENTANA_MOTOR_ACRUX_HORAS = 48; // cuánto hacia atrás revisa el motor buscando mensajes sin responder

// Motor que revisa cada cierto tiempo si hay mensajes nuevos sin responder en AcruxLab,
// y hace que KAI conteste automáticamente (a menos que ya esté en modo "humano").
let _procesandoAcruxLab = false; // evita que se encimen dos corridas si una tarda mucho
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
    if (idsContactos.length) {
      try {
        const uidServicio = await getOdooUID(); // nuestro propio usuario de servicio (KAI escribe con este)
        const convsOdoo = await odooCallLocal('acrux.chat.conversation', 'read', [idsContactos, ['id', 'agent_id']]) || [];
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

      // ¿La conversación está TOMADA por un agente humano en el ChatRoom real de Odoo?
      // KAI no puede (ni debe) escribirle — la está atendiendo esa persona. Sincronizamos
      // nuestro registro a modo humano para reflejarlo en el panel y no reintentar.
      const agenteHumanoEnOdoo = agentePorContacto[contactoId];
      if (agenteHumanoEnOdoo) {
        await AsignacionAcrux.findOneAndUpdate(
          { tenant_id: tenant._id, contacto_id: contactoId },
          { modo: 'humano', fecha_modo_humano: new Date() },
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
      if (asign?.modo === 'humano') continue;

      const numero = extraerNumeroDeMsgid(ultimoInbound.msgid);
      if (!numero) continue; // sin número no podemos llevar memoria confiable — se deja para atención manual

      try {
        const resultado = await atenderAcruxConIA(tenant, ultimoInbound.text || '', numero, contactoId);
        if (resultado.texto) {
          await enviarTextoAcruxLab(contactoId, resultado.texto);
        }
        console.log(`🤖 KAI respondió por AcruxLab a contacto ${contactoId}${resultado.handoff ? ' (con traspaso a humano)' : ''}${!resultado.texto ? ' (solo imagen)' : ''}`);
      } catch (e) {
        if (e.conversacionTomada) {
          // Un agente tomó la conversación justo antes de que KAI escribiera. No es un
          // fallo del sistema: se la dejamos a esa persona y la marcamos como suya, para
          // no volver a intentarlo cada 45 segundos ni llenar los logs de errores rojos.
          await AsignacionAcrux.findOneAndUpdate(
            { tenant_id: tenant._id, contacto_id: contactoId },
            { modo: 'humano', fecha_modo_humano: new Date() },
            { upsert: true, setDefaultsOnInsert: true }
          ).catch(() => {});
          console.log(`👤 [AcruxLab] Contacto ${contactoId} lo tomó un agente — KAI se retira y se lo deja a esa persona`);
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
const MOTOR_PROACTIVO_ACTIVO = true;  // ACTIVADO — contacta leads sin asignar cada 10 min en horario laboral
const MAX_LEADS_POR_CORRIDA = 5;   // de cuántos en cuántos, para no mandar una avalancha
// Arma el primer mensaje. Si el lead YA trae el nivel (viene del formulario), no se lo
// volvemos a preguntar — se le confirma que recibimos su solicitud para ese nivel y se
// le abre la conversación. Preguntar algo que el padre ya escribió se siente como que
// no leímos su solicitud.
const MENSAJE_PRIMER_CONTACTO = (primerNombre, nivel) => {
  const saludo = primerNombre ? `Hola ${primerNombre}` : 'Hola';
  const cabecera = `${saludo} 👋 Te escribimos del *Colegio Capouilliez*.`;

  if (nivel) {
    return `${cabecera}\n\n` +
      `Recibimos tu solicitud de información para *${nivel}* 🏫\n\n` +
      `Con gusto te ayudo con todo lo del proceso de admisión: cuotas, requisitos, horarios o lo que necesites saber.\n\n` +
      `¿Con qué te puedo ayudar primero?`;
  }

  return `${cabecera}\n\n` +
    `Recibimos tu solicitud de información y con gusto te ayudamos con el proceso de admisiones 🏫\n\n` +
    `¿Para qué nivel educativo estás buscando información?\n\n` +
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

// Contacta un lead concreto. Devuelve { ok, motivo } — se reutiliza tanto por el motor
// automático como por el botón manual del panel, para que ambos hagan exactamente lo mismo.
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

  const nombre = lead.partner_name || lead.contact_name || null;
  const primerNombre = nombre ? nombre.split(' ')[0] : null;
  const nivel = normalizarNivelParaMensaje(lead.x_studio_comentarios);

  const resultado = await enviarWhatsAppMeta(tel, MENSAJE_PRIMER_CONTACTO(primerNombre, nivel));

  if (resultado?.messages?.length) {
    const tagContactadoId = await getOdooTagId(TAG_KAI_CONTACTADO);
    await odooCallLocal('crm.lead', 'write', [[lead.id], { tag_ids: [[4, tagContactadoId]] }]).catch(() => {});
    await odooCallLocal('crm.lead', 'message_post', [[lead.id]], {
      body: `📱 KAI contactó por WhatsApp (${tel}) automáticamente. Queda a la espera de respuesta del padre/madre.`
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
          estado: 'bot',
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
  // Solo dentro del horario laboral: escribirle a una familia a las 11 de la noche
  // se ve mal, aunque KAI pueda atender 24/7 cuando ellos escriben primero.
  if (!estaDentroDeHorarioLaboral()) return;

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

    console.log(`🎯 [Motor proactivo] ${conTelefono.length} con teléfono, ${sinTelefono.length} sin teléfono (se marcan para seguimiento manual)`);
    for (const lead of aProcesar) {
      await contactarLeadPorWhatsApp(tenant, lead);
      await new Promise(r => setTimeout(r, 3000)); // pausa entre envíos, para no saturar
    }
  } catch (e) {
    console.error('❌ Error en motorProactivoContactarLeads:', e.message);
  } finally {
    _procesandoMotorProactivo = false;
  }
}

setInterval(motorProactivoContactarLeads, 10 * 60000); // cada 10 minutos

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

  const agente = await asignarAgenteLibre(tenant._id);
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
function esAltaIntencion(texto, ultimoMensajeBot) {
  const t = (texto || '').toLowerCase().trim();
  const fraseAltaIntencion = /(quiero|quisiera|deseo|me gustar[ií]a|necesito|estoy interesad[oa] en|me interesa)\s+(inscribir|agendar|una visita|el open house|que mi hijo|que mi hija|que (mi|el|la)\s*\w+\s*(estudie|entre|vaya))|c[oó]mo (inscribo|agendo|hago para inscribir)|quiero inscribirlo|quiero inscribirla|aparta(me)? (un cupo|lugar)|inscribir(lo|la)?\s*(a mi hijo|a mi hija)?$/.test(t);
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

  // Verificación adicional — buscar directamente en Odoo por teléfono antes de crear
  // Esto evita duplicados cuando dos mensajes llegan casi simultáneamente
  try {
    const telefonoLimpio = numero.replace(/\D/g,'');
    const existentes = await odooCallLocal('crm.lead', 'search_read',
      [[['phone', 'like', telefonoLimpio.slice(-8)], ['active', '=', true]]],
      { fields: ['id', 'name', 'phone'], limit: 1 }
    );
    if (existentes && existentes.length) {
      // Ya existe un lead con ese teléfono — vincularlo al Contacto sin crear otro
      contacto.odoo_lead_id = existentes[0].id;
      await contacto.save();
      console.log(`🔗 Lead existente en Odoo vinculado — #${existentes[0].id} para ${numero}`);
      return existentes[0].id;
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
      user_id: agenteAsignado?.odoo_user_id || undefined
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
      const leadId = await odooCallLocal('crm.lead', 'create', [{
        name: `Lead KAI — ${nombre || 'Sin nombre'} (${etiquetaCanal})`,
        phone: numero.startsWith('ig_') || numero.startsWith('fb_') ? null : numero,
        partner_name: nombre || null,
        description: `Canal de origen: ${canal}\nCapturado automáticamente por KAI.`,
        team_id: teamId,
        type: 'lead', // entra como Lead, no directo como Oportunidad
        tag_ids: tagId ? [[6, 0, [tagId]]] : undefined
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
  { keywords: ['horario','hora','a qué hora','a que hora','cuándo entra','cuando entra','cuándo sale','cuando sale','qué hora'], nivel: [], categoria: 'info_general', nombre_contiene: 'Horario' },

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

function buscarReglaImagenCoincidente(mensajeUsuario, nivelSesion) {
  const t = (mensajeUsuario || '').toLowerCase();
  const nivelSesionLower = (nivelSesion || '').toLowerCase();

  // Agrupar TODAS las reglas cuya keyword coincide con el mensaje — puede haber varias
  // (una por nivel/grado: Preprimaria, Primaria, Secundaria, etc.) bajo el mismo tema,
  // y hasta de temas distintos si comparten alguna palabra (ej. "bachillerato" es nivel
  // de Cuotas pero también keyword propia de Programas).
  const candidatas = REGLAS_IMAGEN.filter(regla => regla.keywords.some(k => contieneKeyword(t, k)));
  if (!candidatas.length) return null; // no tiene nada que ver con ningún tema de imagen

  // PRIORIDAD 1: una candidata con grado específico que SÍ coincide con ESTE mensaje —
  // esto es lo más específico posible, va primero para que un grado (ej. "bachillerato")
  // no termine "secuestrando" la coincidencia hacia un tema distinto sin querer.
  const matchEnMensaje = candidatas.find(r => r.nivel && r.nivel.length > 0 && r.nivel.some(n => contieneKeyword(t, n)));
  if (matchEnMensaje) return { regla: matchEnMensaje, ambigua: false, categoria: matchEnMensaje.categoria };

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
function detectarNivelEnTexto(texto) {
  const t = (texto || '').toLowerCase();
  if (/preprimaria|jard[ií]n|infantil|k[ií]nder|p[aá]rvulos|preparatoria/.test(t)) return 'preprimaria';
  if (/secundaria|b[aá]sico|bachillerato|s[eé]ptimo|octavo|noveno|d[eé]cimo|7°|8°|9°|10°/.test(t)) return 'secundaria';
  if (/primaria|primero|segundo|tercero|cuarto|quinto|sexto|1°|2°|3°|4°|5°|6°/.test(t)) return 'primaria';
  return null;
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
      convActiva.estado = 'cerrado';
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

  // Si había una PREGUNTA PENDIENTE (ej: "¿cuotas de qué grado?") y este mensaje trae un
  // grado, completar esa pregunta pendiente tiene prioridad sobre cualquier otra cosa —
  // aunque el mensaje también toque, por casualidad, la palabra clave de un tema distinto
  // (ej. "bachillerato" es grado de Cuotas pero también palabra propia de Programas). El
  // padre está respondiendo la pregunta que le acabamos de hacer, no cambiando de tema.
  let matchImagen = null;
  if (nivelMencionadoAhora && ctxSesion.temaPendienteCategoria) {
    const reglaCompletada = completarTemaPendiente(ctxSesion.temaPendienteCategoria, nivelMencionadoAhora);
    if (reglaCompletada) matchImagen = { regla: reglaCompletada, ambigua: false };
  }
  if (!matchImagen) {
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
    const regla = matchImagen.regla;
    const filtroImg = { tenant_id: tenant._id, activo: true, categoria: regla.categoria };
    if (regla.nivel_educativo) filtroImg.nivel_educativo = { $in: [regla.nivel_educativo, 'Todos'] };
    if (regla.nombre_contiene) filtroImg.nombre = new RegExp(regla.nombre_contiene, 'i');
    const imagenDirecta = await ImagenMarketing.findOne(filtroImg).sort({ prioridad: -1, creado: -1 });

    if (imagenDirecta) {
      await enviarImagenDesdeDB(imagenDirecta, numeroOrigen, construirDescripcionImagen(imagenDirecta));
      console.log(`🖼️ Imagen directa enviada (sin texto): "${imagenDirecta.nombre}" → ${numeroOrigen}`);
      ctxSesion.historial.push({ role: 'user', content: mensajeUsuario });
      ctxSesion.historial.push({ role: 'assistant', content: `[NOTA DE SISTEMA — esto NO es algo que tú dijiste ni debes imitar este formato de frase: el sistema envió automáticamente la imagen "${imagenDirecta.nombre}" con el detalle completo de ESTE tema específico. No repitas estos datos en texto. Recuerda: tú NUNCA controlas ni sabes con certeza si se manda una imagen en otros mensajes — eso lo decide el sistema por separado según palabras clave. Jamás afirmes "te mandé la imagen" o "aquí tienes las imágenes" a menos que este mensaje de sistema aparezca de verdad para ESE turno.]` });
      ctxSesion.ultimaActividad = Date.now();
      return ''; // texto vacío = no se manda ningún mensaje de texto, solo la imagen
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
const MENSAJE_CIERRE_INACTIVIDAD = 'Gracias por escribirnos 😊 No tuvimos respuesta de tu parte, así que pausamos esta conversación, pero seguimos disponibles cuando quieras continuar — solo escríbenos de nuevo.\n\nMientras tanto, conoce más del Colegio Capouilliez en https://www.capouilliez.edu.gt y síguenos en Instagram y Facebook para no perderte nuestro próximo Open House.';
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
      const inactivoPor = ahora - (conv.ultimaActividad || ahora);
      if (inactivoPor < limiteMs) continue; // aún no pasa 1 hora

      // No cerrar si la conversación está en manos de un agente humano (eso lo maneja el agente, no KAI)
      const enHandoff = await Conversacion.findOne({ numero, estado: { $in: ['humano', 'esperando_agente'] } });
      if (enHandoff) { conv.ultimaActividad = ahora; continue; } // reiniciar el contador mientras esté con humano

      // Enviar mensaje de cierre y marcar como cerrada para no repetirlo
      try {
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
      nombreCliente = null;

    } else if (object === 'page') {
      const messaging = body.entry?.[0]?.messaging?.[0];
      if (!messaging?.message?.text) return;
      canal = 'messenger';
      idExterno = messaging.sender.id;
      mensajeUsuario = messaging.message.text;
      numeroOrigen = `fb_${idExterno}`;
      nombreCliente = null;

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

    // Crear/actualizar contacto con canal lead_ads
    const numero = telefono ? `502${telefono.slice(-8)}` : `fb_lead_${leadgen_id}`;
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
      const tagId = await getOdooTagId('Canal — Lead Ads Facebook');
      const leadId = await odooCallLocal('crm.lead', 'create', [{
        name: `Lead Ads — ${nombre}`,
        phone: telefono || null,
        email_from: correo || null,
        partner_name: nombre,
        description: `Formulario de Lead Ad completado.\nNivel de interés: ${nivel || 'No especificado'}\nCapturado automáticamente por KAI.`,
        team_id: tenant?.odoo_team_id || 1,
        type: 'lead', // entra como Lead, no directo como Oportunidad
        tag_ids: tagId ? [[6, 0, [tagId]]] : undefined
      }]);
      if (leadId) { contacto.odoo_lead_id = leadId; await contacto.save(); }
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
      const tagId = await getOdooTagId('Canal — Formulario Web');
      const leadId = await odooCallLocal('crm.lead', 'create', [{
        name: `Formulario Web — ${nombre || correo || telefono}`,
        phone: telefono || null,
        email_from: correo || null,
        partner_name: nombre || null,
        description: `Formulario web completado.\n${mensaje ? 'Mensaje: ' + mensaje : ''}\nNivel de interés: ${nivel_interes || 'No especificado'}\nCapturado automáticamente por KAI.`,
        team_id: tenant?.odoo_team_id || 1,
        type: 'lead', // entra como Lead, no directo como Oportunidad
        tag_ids: tagId ? [[6, 0, [tagId]]] : undefined
      }]);
      if (leadId) { contacto.odoo_lead_id = leadId; await contacto.save(); }
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
      return { l, duplicadoDe };
    });

    res.json({
      ok: true,
      resumen: {
        pendientes_de_contactar: pendientes.length,
        contactados_por_kai: contactados.length,
        ya_respondieron: contactados.filter(c => c.ya_respondio).length,
  
        sin_whatsapp_valido: sinWA.length
      },
      pendientes: pendientesConDuplicado.map(({ l, duplicadoDe }) => ({
        id: l.id,
        nombre: l.name,
        contacto: l.partner_name || l.contact_name || null,
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
          const tags = await odooCallLocal('acrux.chat.conversation.tag', 'read', [idsTagsUsados, ['id', 'name']]);
          (tags || []).forEach(t => { nombresTag[t.id] = t.name; });
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
        const tags = await odooCallLocal('acrux.chat.conversation.tag', 'read', [registroCompleto.tag_ids, ['id', 'name', 'color']]);
        etiquetasResueltas = tags || [];
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
app.post('/api/acrux/devolver-a-kai', authMiddleware, async (req, res) => {
  try {
    const { contacto_id } = req.body;
    if (!contacto_id) return res.status(400).json({ ok: false, error: 'contacto_id es requerido' });
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
    const { contacto_id, mensaje, plantilla_id, imagen_base64, imagen_mime, imagen_nombre } = req.body;
    if (!contacto_id) return res.status(400).json({ ok: false, error: 'contacto_id es requerido' });
    if (!mensaje && !plantilla_id && !imagen_base64) return res.status(400).json({ ok: false, error: 'mensaje, plantilla_id o imagen_base64 son requeridos' });

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
    if (imagen_base64) {
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

    const detalle = await odooCallLocal('acrux.chat.conversation', 'read',
      [[contactoId], ['id', 'name', 'number', 'number_format', 'priority', 'tag_ids', 'note', 'status', 'unanswered', 'last_activity', 'partner_info']]
    );
    const conv = detalle?.[0];
    if (!conv) return res.json({ ok: false, error: 'No se encontró la conversación en AcruxLab' });

    let etiquetas = [];
    if (conv.tag_ids && conv.tag_ids.length) {
      const tags = await odooCallLocal('acrux.chat.conversation.tag', 'read', [conv.tag_ids, ['id', 'name']]);
      etiquetas = (tags || []).map(t => t.name);
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
- Es cualquier consulta que no sea un padre/madre pidiendo información para inscribir a un hijo.

Solo pon TRUE cuando sea claramente un padre/madre interesado en inscribir a un alumno.

Otras reglas:
- Si un dato no aparece con claridad, pon null. NO inventes datos.
- Básico y Bachillerato cuentan como "Secundaria".
- El teléfono debe ser solo dígitos, sin espacios ni símbolos.`;

  const respuesta = await llamarClaude(systemPrompt, [{ role: 'user', content: cuerpo.substring(0, 6000) }], 700);
  if (!respuesta) return { ok: false, error: 'La IA no devolvió respuesta (puede ser saldo agotado o fallo de conexión con Anthropic)', texto_leido: cuerpo.substring(0, 600) };

  let datos;
  try {
    datos = JSON.parse(respuesta.replace(/```json|```/g, '').trim());
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
    for (const lead of leads) {
      const r = await contactarLeadPorWhatsApp(tenant, lead);
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
      imagenesSugeridas = await ImagenMarketing.find({
        tenant_id: req.user.tenant_id,
        activo: true,
        $or: [
          { nivel_educativo: nivel },
          { nivel_educativo: 'Todos' }
        ]
      }).select('-imagen_base64').limit(6); // Sin base64 para carga rápida
    } else {
      // Sin nivel conocido — mostrar imágenes generales
      imagenesSugeridas = await ImagenMarketing.find({
        tenant_id: req.user.tenant_id,
        activo: true,
        nivel_educativo: 'Todos'
      }).select('-imagen_base64').limit(4);
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
    conv.estado = 'cerrado';
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
  res.json({ version: VERSION_KAI, servidor_iniciado: new Date(SERVIDOR_INICIADO).toISOString() });
});

app.listen(PORT, () => {
  console.log(`✅ KAI — Colegio Capouilliez corriendo en puerto ${PORT} | ${VERSION_KAI}`);
  console.log(`📊 Planes: Básico(${PLANES.basico.mensajes_mes}msg/${PLANES.basico.max_usuarios}usr) | Profesional(${PLANES.profesional.mensajes_mes}msg/${PLANES.profesional.max_usuarios}usr) | Empresarial(${PLANES.empresarial.mensajes_mes}msg/${PLANES.empresarial.max_usuarios}usr)`);
  // Cargar imágenes del colegio en MongoDB al iniciar (si no existen)
  setTimeout(seedImagenes, 5000); // esperar 5s a que MongoDB esté listo
});
