require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const MONGODB_URI = process.env.MONGODB_URI;
const SETUP_KEY = process.env.SETUP_KEY || 'capouilliez-setup-2026';

// Schemas
const userSchema = new mongoose.Schema({
  name: String,
  email: String,
  password: String,
  role: { type: String, enum: ['admin', 'admisiones', 'asesor'] },
  tenant_id: String,
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const tenantSchema = new mongoose.Schema({
  name: String,
  tenant_id: String,
  plan: String,
  whatsapp_number: String,
  createdAt: { type: Date, default: Date.now }
});

const faqSchema = new mongoose.Schema({
  question: String,
  answer: String,
  category: String,
  tenant_id: String,
  active: { type: Boolean, default: true }
});

const User = mongoose.model('User', userSchema);
const Tenant = mongoose.model('Tenant', tenantSchema);
const FAQ = mongoose.model('FAQ', faqSchema);

async function setup() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Conectado a MongoDB');

    const TENANT_ID = 'capouilliez';

    // Crear tenant
    await Tenant.findOneAndUpdate(
      { tenant_id: TENANT_ID },
      {
        name: 'Colegio Capouilliez',
        tenant_id: TENANT_ID,
        plan: 'profesional',
        whatsapp_number: ''
      },
      { upsert: true }
    );
    console.log('✅ Tenant creado');

    // Usuarios
    const usuarios = [
      { name: 'Administrador KAI', email: 'admin@capouilliez.edu.gt', password: 'Admin2026!', role: 'admin' },
      { name: 'Admisiones', email: 'admisiones@capouilliez.edu.gt', password: 'Admisiones2026!', role: 'admisiones' },
      { name: 'Asesor', email: 'asesor@capouilliez.edu.gt', password: 'Asesor2026!', role: 'asesor' }
    ];

    for (const u of usuarios) {
      const exists = await User.findOne({ email: u.email });
      if (!exists) {
        const hashed = await bcrypt.hash(u.password, 10);
        await User.create({ ...u, password: hashed, tenant_id: TENANT_ID });
        console.log(`✅ Usuario creado: ${u.email} / ${u.password}`);
      } else {
        console.log(`⚠️  Ya existe: ${u.email}`);
      }
    }

    // FAQs iniciales
    const faqs = [
      { question: '¿Cuáles son los niveles educativos?', answer: 'Ofrecemos Preprimaria, Primaria, Básicos (7mo a 9no) y Diversificado (10mo a 12vo) en las especialidades de Bachillerato en Ciencias y Letras, y Perito Contador.', category: 'niveles' },
      { question: '¿Cuál es el proceso de admisión?', answer: 'El proceso incluye: 1) Solicitud de información, 2) Visita al colegio o Open House, 3) Entrega de documentos, 4) Evaluación de ingreso, 5) Confirmación de inscripción.', category: 'admision' },
      { question: '¿Cuándo es el Open House?', answer: 'Las fechas de Open House se publican en nuestras redes sociales. Un asesor te contactará para darte la fecha más próxima.', category: 'openhouse' },
      { question: '¿Tienen becas?', answer: 'El colegio no cuenta con becas externas. Sin embargo, existen descuentos para: hermanos inscritos, pago anual anticipado, ex alumnos y colaboradores del colegio.', category: 'becas' },
      { question: '¿Qué documentos necesito?', answer: 'Para la inscripción necesitas: certificado de nacimiento, DPI del padre/madre, foto reciente del alumno, certificado de estudios anteriores y constancia médica.', category: 'documentos' },
      { question: '¿El colegio tiene convenio con la UVG?', answer: 'Sí, los graduados de Capouilliez tienen pase directo a la Universidad del Valle de Guatemala (UVG), lo cual es una gran ventaja para nuestros alumnos.', category: 'convenios' }
    ];

    for (const faq of faqs) {
      const exists = await FAQ.findOne({ question: faq.question, tenant_id: TENANT_ID });
      if (!exists) {
        await FAQ.create({ ...faq, tenant_id: TENANT_ID });
        console.log(`✅ FAQ creada: ${faq.question}`);
      }
    }

    console.log('\n🎉 Setup completado exitosamente');
    console.log('\nUsuarios creados:');
    console.log('  admin@capouilliez.edu.gt / Admin2026!');
    console.log('  admisiones@capouilliez.edu.gt / Admisiones2026!');
    console.log('  asesor@capouilliez.edu.gt / Asesor2026!');

    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
}

setup();
