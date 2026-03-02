const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const methodOverride = require('method-override');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;


const pool = new Pool({
  host: 'localhost',
  user: 'postgres',
  password: '123',      
  database: 'Hospital',
  port: 5432,
});

// Quick test: verify DB is reachable on startup
pool.query('SELECT NOW()', (err) => {
  if (err) console.error('❌  DB connection failed:', err.message);
  else     console.log('✅  PostgreSQL connected');
});

// ─── ID GENERATORS ───────────────────────────────────────────


async function generatePatientId() {
  const result = await pool.query(
    "SELECT patient_id FROM patients ORDER BY patient_id DESC LIMIT 1"
  );
  if (result.rows.length === 0) return 'P001';
  const last = result.rows[0].patient_id; // e.g. "P001"
  const num = parseInt(last.replace(/\D/g, ''), 10) + 1;
  return 'P' + String(num).padStart(3, '0');
}

async function generateDoctorId() {
  const result = await pool.query(
    "SELECT doctor_id FROM doctors ORDER BY doctor_id DESC LIMIT 1"
  );
  if (result.rows.length === 0) return 'D001';
  const last = result.rows[0].doctor_id; // e.g. "D0599"
  const num = parseInt(last.replace(/\D/g, ''), 10) + 1;
  // Preserve original padding length (D0599 → 4 digits)
  const digits = last.replace(/\D/g, '').length;
  return 'D' + String(num).padStart(digits, '0');
}

async function generateAppointmentId() {
  const result = await pool.query(
    "SELECT appointment_id FROM appointments ORDER BY appointment_id DESC LIMIT 1"
  );
  if (result.rows.length === 0) return 'A001';
  const last = result.rows[0].appointment_id; // e.g. "A001"
  const num = parseInt(last.replace(/\D/g, ''), 10) + 1;
  return 'A' + String(num).padStart(3, '0');
}

async function generateTreatmentId() {
  const result = await pool.query(
    "SELECT treatment_id FROM treatments ORDER BY treatment_id DESC LIMIT 1"
  );
  if (result.rows.length === 0) return 'T001';
  const last = result.rows[0].treatment_id; // e.g. "T001"
  const num = parseInt(last.replace(/\D/g, ''), 10) + 1;
  const digits = last.replace(/\D/g, '').length;
  return 'T' + String(num).padStart(digits, '0');
}

// ─── MIDDLEWARE ──────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(session({
  secret: 'hospital_secret_key_2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 3600000 }  // 1 hour
}));

// ─── AUTH MIDDLEWARE ─────────────────────────────────────────
// Protects any route — redirects to login if not authenticated
function requireAuth(role) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (role && req.session.user.role !== role) return res.redirect('/login');
    next();
  };
}

// ─── ROUTES ──────────────────────────────────────────────────

// GET /  →  redirect to login
app.get('/', (req, res) => res.redirect('/login'));

// GET /login  →  show login page
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect(`/${req.session.user.role}-dashboard`);
  res.render('login', { error: null });
});

// POST /login  →  authenticate user


// ─────────────────────────────────────────────────────────────
app.post('/login', async (req, res) => {
  const { email, password, role } = req.body;

  try {
    let user = null;

    if (role === 'patient') {
      const result = await pool.query(
        'SELECT * FROM patients WHERE email = $1',
        [email]
      );
      if (result.rows.length > 0) {
        user = {
          id:   result.rows[0].patient_id,
          name: `${result.rows[0].first_name} ${result.rows[0].last_name}`,
          role: 'patient',
          data: result.rows[0]
        };
      }
    }

    if (role === 'doctor') {
      const result = await pool.query(
        'SELECT * FROM doctors WHERE email = $1',
        [email]
      );
      if (result.rows.length > 0) {
        user = {
          id:   result.rows[0].doctor_id,
          name: `Dr. ${result.rows[0].first_name} ${result.rows[0].last_name}`,
          role: 'doctor',
          data: result.rows[0]
        };
      }
    }

    if (role === 'admin') {
      // Simple hardcoded admin for TP — replace with DB lookup later
      if (email === 'admin@hospital.com' && password === 'admin123') {
        user = { id: 0, name: 'Administrator', role: 'admin', data: {} };
      }
    }

    if (!user) {
      return res.render('login', { error: 'Invalid credentials. Please try again.' });
    }

    // ✅  Store user in session
    req.session.user = user;
    res.redirect(`/${role}-dashboard`);

  } catch (err) {
    console.error(err);
    res.render('login', { error: 'Server error. Please try again.' });
  }
});

// GET /logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ─────────────────────────────────────────────────────────────
//  PATIENT DASHBOARD
// ─────────────────────────────────────────────────────────────
app.get('/patient-dashboard', requireAuth('patient'), async (req, res) => {
  const patientId = req.session.user.id;

  try {
    // Upcoming appointments
    const appointments = await pool.query(`
      SELECT a.*, d.first_name AS doc_first, d.last_name AS doc_last, d.specialization
      FROM appointments a
      JOIN doctors d ON a.doctor_id = d.doctor_id
      WHERE a.patient_id = $1
      ORDER BY a.appointment_date DESC
    `, [patientId]);

    // Billing summary
    const bills = await pool.query(`
      SELECT b.*, t.treatment_type, t.description
      FROM billing b
      LEFT JOIN treatments t ON b.treatment_id = t.treatment_id
      WHERE b.patient_id = $1
      ORDER BY b.bill_date DESC
    `, [patientId]);

    // Treatments history
    const treatments = await pool.query(`
      SELECT t.*, a.appointment_date
      FROM treatments t
      JOIN appointments a ON t.appointment_id = a.appointment_id
      WHERE a.patient_id = $1
      ORDER BY t.treatment_date DESC
    `, [patientId]);

    // All doctors for booking
    const doctors = await pool.query('SELECT * FROM doctors ORDER BY last_name');

    res.render('client-dashboard', {
      user:         req.session.user,
      appointments: appointments.rows,
      bills:        bills.rows,
      treatments:   treatments.rows,
      doctors:      doctors.rows,
      success:      req.query.success || null,
      error:        req.query.error   || null
    });

  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// POST /patient-dashboard/book  →  Book an appointment
app.post('/patient-dashboard/book', requireAuth('patient'), async (req, res) => {
  const { doctor_id, appointment_date, appointment_time, reason_for_visit } = req.body;
  const patient_id = req.session.user.id;

  if (!doctor_id || !appointment_date || !appointment_time || !reason_for_visit) {
    return res.redirect('/patient-dashboard?error=All fields are required to book an appointment.');
  }

  try {
    // Verify doctor exists
    const doc = await pool.query('SELECT doctor_id FROM doctors WHERE doctor_id = $1', [doctor_id]);
    if (doc.rows.length === 0) {
      return res.redirect('/patient-dashboard?error=Selected doctor not found.');
    }

    // Generate next appointment ID (e.g. A001, A002...)
    const appointment_id = await generateAppointmentId();

    await pool.query(`
      INSERT INTO appointments (appointment_id, patient_id, doctor_id, appointment_date, appointment_time, reason_for_visit, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'Scheduled')
    `, [appointment_id, patient_id, doctor_id, appointment_date, appointment_time, reason_for_visit]);

    res.redirect('/patient-dashboard?success=Appointment booked successfully!');
  } catch (err) {
    console.error('Book appointment error:', err);
    const msg = err.detail || err.message || 'Could not book appointment.';
    res.redirect(`/patient-dashboard?error=${encodeURIComponent(msg)}`);
  }
});

// ─────────────────────────────────────────────────────────────
//  DOCTOR DASHBOARD
// ─────────────────────────────────────────────────────────────
app.get('/doctor-dashboard', requireAuth('doctor'), async (req, res) => {
  const doctorId = req.session.user.id;

  try {
    // Today's appointments
    const todayAppts = await pool.query(`
      SELECT a.*, p.first_name AS pat_first, p.last_name AS pat_last,
             p.gender, p.date_of_birth, p.contact_number
      FROM appointments a
      JOIN patients p ON a.patient_id = p.patient_id
      WHERE a.doctor_id = $1 AND a.appointment_date = CURRENT_DATE
      ORDER BY a.appointment_time
    `, [doctorId]);

    // All appointments
    const allAppts = await pool.query(`
      SELECT a.*, p.first_name AS pat_first, p.last_name AS pat_last
      FROM appointments a
      JOIN patients p ON a.patient_id = p.patient_id
      WHERE a.doctor_id = $1
      ORDER BY a.appointment_date DESC
    `, [doctorId]);

    // My patients (unique)
    const myPatients = await pool.query(`
      SELECT DISTINCT p.*
      FROM patients p
      JOIN appointments a ON p.patient_id = a.patient_id
      WHERE a.doctor_id = $1
      ORDER BY p.last_name
    `, [doctorId]);

    // Stats
    const stats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'Scheduled') AS scheduled,
        COUNT(*) FILTER (WHERE status = 'Completed') AS completed,
        COUNT(*) FILTER (WHERE appointment_date = CURRENT_DATE) AS today
      FROM appointments WHERE doctor_id = $1
    `, [doctorId]);

    res.render('doctor-dashboard', {
      user:       req.session.user,
      todayAppts: todayAppts.rows,
      allAppts:   allAppts.rows,
      myPatients: myPatients.rows,
      stats:      stats.rows[0],
      success:    req.query.success || null,
      error:      req.query.error   || null
    });

  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// POST /doctor/update-appointment  →  Update appointment status
app.post('/doctor/update-appointment', requireAuth('doctor'), async (req, res) => {
  const { appointment_id, status } = req.body;

  try {
    await pool.query(
      'UPDATE appointments SET status = $1 WHERE appointment_id = $2',
      [status, appointment_id]
    );
    res.redirect('/doctor-dashboard?success=Status updated!');
  } catch (err) {
    console.error(err);
    res.redirect('/doctor-dashboard?error=Update failed.');
  }
});

// POST /doctor/add-treatment  →  Add treatment to an appointment
app.post('/doctor/add-treatment', requireAuth('doctor'), async (req, res) => {
  const { appointment_id, treatment_type, description, cost } = req.body;
  const doctorId = req.session.user.id;
  const treatment_date = new Date().toISOString().split('T')[0];

  if (!appointment_id || !treatment_type || !cost) {
    return res.redirect('/doctor-dashboard?error=Appointment ID, treatment type and cost are required.');
  }

  try {
    // Look up the appointment — check it exists first
    const appt = await pool.query(
      'SELECT appointment_id, doctor_id FROM appointments WHERE appointment_id = $1',
      [appointment_id.trim().toUpperCase()]
    );

    if (appt.rows.length === 0) {
      return res.redirect(`/doctor-dashboard?error=Appointment "${appointment_id}" does not exist. Check the ID and try again.`);
    }

    // Check it belongs to this doctor
    if (String(appt.rows[0].doctor_id).trim() !== String(doctorId).trim()) {
      return res.redirect(`/doctor-dashboard?error=Appointment "${appointment_id}" belongs to a different doctor.`);
    }

    await pool.query(`
      INSERT INTO treatments (treatment_id, appointment_id, treatment_type, description, cost, treatment_date)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [await generateTreatmentId(), appt.rows[0].appointment_id, treatment_type, description || null, parseFloat(cost), treatment_date]);

    res.redirect('/doctor-dashboard?success=Treatment added successfully!');
  } catch (err) {
    console.error('Add treatment error:', err);
    const msg = err.detail || err.message || 'Could not add treatment.';
    res.redirect(`/doctor-dashboard?error=${encodeURIComponent(msg)}`);
  }
});

// ─────────────────────────────────────────────────────────────
//  ADMIN DASHBOARD
// ─────────────────────────────────────────────────────────────
app.get('/admin-dashboard', requireAuth('admin'), async (req, res) => {
  try {
   
    const stats = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM patients)     AS total_patients,
        (SELECT COUNT(*) FROM doctors)      AS total_doctors,
        (SELECT COUNT(*) FROM appointments) AS total_appointments,
        (SELECT COALESCE(SUM(amount), 0) FROM billing WHERE payment_status = 'Paid') AS total_revenue
    `);

  
    const recentAppts = await pool.query(`
      SELECT a.*,
             p.first_name AS pat_first, p.last_name AS pat_last,
             d.first_name AS doc_first, d.last_name AS doc_last
      FROM appointments a
      JOIN patients p ON a.patient_id  = p.patient_id
      JOIN doctors  d ON a.doctor_id   = d.doctor_id
      ORDER BY a.appointment_date DESC
      LIMIT 10
    `);

    // All patients
    const patients = await pool.query('SELECT * FROM patients ORDER BY registration_date DESC');

    // All doctors
    const doctors = await pool.query('SELECT * FROM doctors ORDER BY last_name');

    // Billing overview
    const billing = await pool.query(`
      SELECT b.*, p.first_name || ' ' || p.last_name AS patient_name,
             t.treatment_type
      FROM billing b
      JOIN patients p ON b.patient_id = p.patient_id
      LEFT JOIN treatments t ON b.treatment_id = t.treatment_id
      ORDER BY b.bill_date DESC
      LIMIT 20
    `);

    // Appointments by status (for chart)
    const apptStats = await pool.query(`
      SELECT status, COUNT(*) AS count
      FROM appointments
      GROUP BY status
    `);

    res.render('admin-dashboard', {
      user:        req.session.user,
      stats:       stats.rows[0],
      recentAppts: recentAppts.rows,
      patients:    patients.rows,
      doctors:     doctors.rows,
      billing:     billing.rows,
      apptStats:   apptStats.rows,
      myPatients:  patients.rows,   // alias used in some EJS versions
      success:     req.query.success || null,
      error:       req.query.error   || null
    });

  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// POST /admin/add-doctor
app.post('/admin/add-doctor', requireAuth('admin'), async (req, res) => {
  const { first_name, last_name, specialization, phone_number, years_experience, hospital_branch, email } = req.body;

  // Basic validation
  if (!first_name || !last_name || !specialization || !email) {
    return res.redirect('/admin-dashboard?error=First name, last name, specialization and email are required.');
  }

  try {
    // Check for duplicate email first
    const existing = await pool.query('SELECT doctor_id FROM doctors WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.redirect('/admin-dashboard?error=A doctor with this email already exists.');
    }

    // Generate next doctor ID (e.g. D001, D002...)
    const doctor_id = await generateDoctorId();

    await pool.query(`
      INSERT INTO doctors (doctor_id, first_name, last_name, specialization, phone_number, years_experience, hospital_branch, email)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      doctor_id,
      first_name,
      last_name,
      specialization,
      phone_number   || null,
      years_experience ? parseInt(years_experience) : null,
      hospital_branch || null,
      email
    ]);

    res.redirect('/admin-dashboard?success=Doctor added successfully!');
  } catch (err) {
    console.error('Add doctor error:', err);
    const msg = err.detail || err.message || 'Could not add doctor.';
    res.redirect(`/admin-dashboard?error=${encodeURIComponent(msg)}`);
  }
});

// POST /admin/add-patient
app.post('/admin/add-patient', requireAuth('admin'), async (req, res) => {
  const { first_name, last_name, gender, date_of_birth, contact_number, address, insurance_provider, insurance_number, email } = req.body;

  if (!first_name || !last_name || !email) {
    return res.redirect('/admin-dashboard?error=First name, last name and email are required.');
  }

  const registration_date = new Date().toISOString().split('T')[0];

  try {
    // Check for duplicate email
    const existing = await pool.query('SELECT patient_id FROM patients WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.redirect('/admin-dashboard?error=A patient with this email already exists.');
    }

    // Generate next patient ID (e.g. P001, P002...)
    const patient_id = await generatePatientId();

    await pool.query(`
      INSERT INTO patients (patient_id, first_name, last_name, gender, date_of_birth, contact_number, address, registration_date, insurance_provider, insurance_number, email)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `, [
      patient_id,
      first_name,
      last_name,
      gender            || null,
      date_of_birth     || null,
      contact_number    || null,
      address           || null,
      registration_date,
      insurance_provider || null,
      insurance_number   || null,
      email
    ]);

    res.redirect('/admin-dashboard?success=Patient registered successfully!');
  } catch (err) {
    console.error('Add patient error:', err);
    const msg = err.detail || err.message || 'Could not add patient.';
    res.redirect(`/admin-dashboard?error=${encodeURIComponent(msg)}`);
  }
});

// POST /admin/update-billing
app.post('/admin/update-billing', requireAuth('admin'), async (req, res) => {
  const { bill_id, payment_status } = req.body;

  try {
    await pool.query(
      'UPDATE billing SET payment_status = $1 WHERE bill_id = $2',
      [payment_status, bill_id]
    );
    res.redirect('/admin-dashboard?success=Billing updated!');
  } catch (err) {
    console.error(err);
    res.redirect('/admin-dashboard?error=Update failed.');
  }
});

// DELETE /admin/delete-doctor/:id
app.delete('/admin/delete-doctor/:id', requireAuth('admin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM doctors WHERE doctor_id = $1', [req.params.id]);
    res.redirect('/admin-dashboard?success=Doctor removed.');
  } catch (err) {
    console.error(err);
    res.redirect('/admin-dashboard?error=Delete failed.');
  }
});

// ─── START SERVER ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🏥  Hospital App running at http://localhost:${PORT}\n`);
});